import type { ArtMode, PivotNorm } from '../domain/schemas';
import type { AnimPresetKind, PuppetPin } from '../processing/animPresets';
import { ANIM_PRESETS, generatePresetKeyframes } from '../processing/animPresets';
import { parseHexRgb } from '../processing/backgroundKey';
import { composeSpritesheetStrip } from '../processing/gif';
import { solveMlsMesh, type MlsMode, type Vec2 } from '../processing/mlsWarp';
import { cleanOrphanPixels } from '../processing/orphanCleaner';
import { applySelectiveOutline } from '../processing/selOut';
import { rasterizeDeformedMeshCpu, type SpriteMesh } from '../processing/spriteMesh';
import type { RgbaBuffer } from '../processing/types';
import {
  checkWebGlNoError,
  compileWebGlProgram,
  createWebGlTexture2D,
  forceReleaseWebGlContext,
  requestWebGl2Context,
  restoreReleasedWebGlContextIfNeeded,
  setWebGlTextureFilter,
  type WebGlLifecycleHooks,
} from './glUtils';
import puppetFragSrc from './shaders/puppet.frag.glsl?raw';
import puppetVertSrc from './shaders/puppet.vert.glsl?raw';

export interface PuppetStripExportOptions {
  readonly preset: AnimPresetKind;
  readonly mode: MlsMode;
  readonly pins: readonly PuppetPin[];
  readonly frameCount: number;
  readonly amplitudePx: number;
  readonly fps: number;
  readonly loop: boolean;
  readonly pingPong: boolean;
  readonly paddingPx: number;
  readonly reLockPolish: boolean;
  readonly artMode: ArtMode;
  readonly pivotNorm: PivotNorm;
  readonly paletteHex?: readonly string[];
  readonly normalMap?: RgbaBuffer;
  readonly normalInvertY?: number;
}

export interface PuppetStripExportResult {
  readonly stripBuffer: RgbaBuffer;
  readonly normalStripBuffer?: RgbaBuffer;
  readonly frames: readonly RgbaBuffer[];
  readonly atlasJson: string;
  readonly stripFilenameSuffix: string;
  readonly jsonFilenameSuffix: string;
}

interface CachedAssets {
  readonly sprite: RgbaBuffer;
  readonly mesh: SpriteMesh;
  readonly options: { artMode: ArtMode; paddingPx: number; normalMap?: RgbaBuffer };
}

interface CachedDrawPass {
  readonly positions: Float32Array;
  readonly rotations: Float32Array;
  readonly options: {
    targetFbo: boolean;
    tint?: readonly [number, number, number, number];
    isNormalMap?: boolean;
    normalInvertY?: number;
  };
}

/**
 * WebGL2 textured mesh controller for real-time 60 FPS MLS puppet deformation & strip baking.
 */
export class PuppetRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly hooks: WebGlLifecycleHooks;

  private prog: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private uvVbo: WebGLBuffer | null = null;
  private posVbo: WebGLBuffer | null = null;
  private rotVbo: WebGLBuffer | null = null;
  private ebo: WebGLBuffer | null = null;
  private albedoTex: WebGLTexture | null = null;
  private normalTex: WebGLTexture | null = null;
  private fboTex: WebGLTexture | null = null;
  private fbo: WebGLFramebuffer | null = null;

  private indexCount = 0;
  private frameWidth = 1;
  private frameHeight = 1;
  private padPx = 0;
  private hasNormalTex = false;
  private lastAssets: CachedAssets | null = null;
  private lastPreviewDraw: CachedDrawPass | null = null;
  private lastFboDraw: CachedDrawPass | null = null;
  private contextLost = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, hooks: WebGlLifecycleHooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;
    this.gl = requestWebGl2Context(canvas, 'PuppetRenderer');

    this.canvas.addEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored);

    if (this.gl.isContextLost()) {
      this.contextLost = true;
      restoreReleasedWebGlContextIfNeeded(this.gl);
      return;
    }

    this.initGpuResources();
  }

  public isContextLost(): boolean {
    return this.disposed || this.contextLost || this.gl.isContextLost();
  }

  public setAssets(
    sprite: RgbaBuffer,
    mesh: SpriteMesh,
    options: { artMode: ArtMode; paddingPx: number; normalMap?: RgbaBuffer },
  ): void {
    if (this.disposed) return;
    this.lastAssets = { sprite, mesh, options };
    this.padPx = Math.max(0, options.paddingPx);
    this.frameWidth = Math.max(1, sprite.width + this.padPx * 2);
    this.frameHeight = Math.max(1, sprite.height + this.padPx * 2);
    this.indexCount = mesh.indices.length;

    if (this.isContextLost()) return;
    this.uploadAssetsInternal(sprite, mesh, options);
  }

  public clearPreview(): void {
    if (this.isContextLost()) return;
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.frameWidth, this.frameHeight);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  public drawMeshPass(
    positions: Float32Array,
    rotations: Float32Array,
    options: {
      targetFbo: boolean;
      tint?: readonly [number, number, number, number];
      isNormalMap?: boolean;
      normalInvertY?: number;
    },
  ): void {
    if (this.disposed || this.indexCount === 0) return;

    const passRecord: CachedDrawPass = {
      positions: new Float32Array(positions),
      rotations: new Float32Array(rotations),
      options,
    };
    if (options.targetFbo) {
      this.lastFboDraw = passRecord;
    } else {
      this.lastPreviewDraw = passRecord;
    }

    if (this.isContextLost()) return;
    if (!this.prog || !this.vao || !this.posVbo || !this.rotVbo) return;
    const { gl } = this;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, positions);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rotVbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, rotations);

    gl.bindFramebuffer(gl.FRAMEBUFFER, options.targetFbo ? this.fbo : null);
    gl.viewport(0, 0, this.frameWidth, this.frameHeight);

    if (options.targetFbo) {
      gl.disable(gl.BLEND);
      if (options.isNormalMap) {
        gl.clearColor(128 / 255, 128 / 255, 1, 0);
      } else {
        gl.clearColor(0, 0, 0, 0);
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(
      gl.TEXTURE_2D,
      options.isNormalMap && this.hasNormalTex ? this.normalTex : this.albedoTex,
    );
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uTexture'), 0);
    gl.uniform2f(gl.getUniformLocation(this.prog, 'uFrameSize'), this.frameWidth, this.frameHeight);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uPadPx'), this.padPx);
    const tint = options.tint ?? [1, 1, 1, 1];
    gl.uniform4f(gl.getUniformLocation(this.prog, 'uTint'), tint[0], tint[1], tint[2], tint[3]);
    gl.uniform1i(gl.getUniformLocation(this.prog, 'uIsNormalMap'), options.isNormalMap ? 1 : 0);
    gl.uniform1f(gl.getUniformLocation(this.prog, 'uInvertY'), options.normalInvertY ?? 1);

    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (!checkWebGlNoError(gl, 'PuppetRenderer.drawMeshPass')) {
      this.contextLost = true;
    }
  }

  public readFboBuffer(): RgbaBuffer {
    const fallbackFromCache = (): RgbaBuffer => {
      if (this.lastAssets && this.lastFboDraw) {
        const isNormal = Boolean(this.lastFboDraw.options.isNormalMap);
        const sourceBuf =
          isNormal && this.lastAssets.options.normalMap
            ? this.lastAssets.options.normalMap
            : this.lastAssets.sprite;
        return rasterizeDeformedMeshCpu(
          sourceBuf,
          this.lastAssets.mesh,
          this.lastFboDraw.positions,
          this.lastFboDraw.rotations,
          {
            paddingPx: this.padPx,
            pixelArt: this.lastAssets.options.artMode === 'pixel-art',
            isNormalMap: isNormal,
          },
        );
      }
      return {
        width: this.frameWidth,
        height: this.frameHeight,
        data: new Uint8ClampedArray(this.frameWidth * this.frameHeight * 4),
      };
    };

    if (this.isContextLost() || !this.fbo) {
      return fallbackFromCache();
    }

    const { gl, frameWidth, frameHeight } = this;
    const raw = new Uint8Array(frameWidth * frameHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(0, 0, frameWidth, frameHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (!checkWebGlNoError(gl, 'PuppetRenderer.readFboBuffer')) {
      this.contextLost = true;
      return fallbackFromCache();
    }

    const flipped = new Uint8ClampedArray(frameWidth * frameHeight * 4);
    const rowBytes = frameWidth * 4;
    for (let y = 0; y < frameHeight; y++) {
      const srcOff = (frameHeight - 1 - y) * rowBytes;
      flipped.set(raw.subarray(srcOff, srcOff + rowBytes), y * rowBytes);
    }
    return { width: frameWidth, height: frameHeight, data: flipped };
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);

    if (!this.gl.isContextLost() && !this.contextLost) {
      this.deleteGpuResources();
      forceReleaseWebGlContext(this.gl);
    } else {
      this.resetResourceRefs();
    }
    this.lastAssets = null;
    this.lastPreviewDraw = null;
    this.lastFboDraw = null;
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.hooks.onContextLost?.();
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.resetResourceRefs();
    this.contextLost = false;
    this.initGpuResources();

    if (this.lastAssets) {
      this.uploadAssetsInternal(
        this.lastAssets.sprite,
        this.lastAssets.mesh,
        this.lastAssets.options,
      );
      if (this.lastPreviewDraw) {
        this.clearPreview();
        this.drawMeshPass(
          this.lastPreviewDraw.positions,
          this.lastPreviewDraw.rotations,
          this.lastPreviewDraw.options,
        );
      }
    }
    this.hooks.onContextRestored?.();
  };

  private initGpuResources(): void {
    const { gl } = this;
    this.prog = compileWebGlProgram(gl, puppetVertSrc, puppetFragSrc, 'Puppet');
    const vao = gl.createVertexArray();
    const uvVbo = gl.createBuffer();
    const posVbo = gl.createBuffer();
    const rotVbo = gl.createBuffer();
    const ebo = gl.createBuffer();
    const fbo = gl.createFramebuffer();
    if (!vao || !uvVbo || !posVbo || !rotVbo || !ebo || !fbo) {
      throw new Error('Failed to allocate WebGL2 puppet resources.');
    }

    this.vao = vao;
    this.uvVbo = uvVbo;
    this.posVbo = posVbo;
    this.rotVbo = rotVbo;
    this.ebo = ebo;
    this.fbo = fbo;
    this.albedoTex = createWebGlTexture2D(gl, gl.NEAREST);
    this.normalTex = createWebGlTexture2D(gl, gl.NEAREST);
    this.fboTex = createWebGlTexture2D(gl, gl.NEAREST);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvVbo);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVbo);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rotVbo);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bindVertexArray(null);
  }

  private deleteGpuResources(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);

    if (this.uvVbo) gl.deleteBuffer(this.uvVbo);
    if (this.posVbo) gl.deleteBuffer(this.posVbo);
    if (this.rotVbo) gl.deleteBuffer(this.rotVbo);
    if (this.ebo) gl.deleteBuffer(this.ebo);
    if (this.albedoTex) gl.deleteTexture(this.albedoTex);
    if (this.normalTex) gl.deleteTexture(this.normalTex);
    if (this.fboTex) gl.deleteTexture(this.fboTex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.prog) gl.deleteProgram(this.prog);
    this.resetResourceRefs();
  }

  private resetResourceRefs(): void {
    this.uvVbo = null;
    this.posVbo = null;
    this.rotVbo = null;
    this.ebo = null;
    this.albedoTex = null;
    this.normalTex = null;
    this.fboTex = null;
    this.fbo = null;
    this.vao = null;
    this.prog = null;
  }

  private uploadAssetsInternal(
    sprite: RgbaBuffer,
    mesh: SpriteMesh,
    options: { artMode: ArtMode; paddingPx: number; normalMap?: RgbaBuffer },
  ): void {
    if (!this.albedoTex || !this.normalTex || !this.fboTex || !this.fbo) return;
    if (!this.uvVbo || !this.posVbo || !this.rotVbo || !this.ebo) return;
    const { gl } = this;

    const maxTexSize = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096;
    if (
      sprite.width > maxTexSize ||
      sprite.height > maxTexSize ||
      this.frameWidth > maxTexSize ||
      this.frameHeight > maxTexSize
    ) {
      throw new Error(
        `Puppet frame (${this.frameWidth}x${this.frameHeight}) exceeds GPU MAX_TEXTURE_SIZE (${maxTexSize}).`,
      );
    }

    const filter = options.artMode === 'pixel-art' ? gl.NEAREST : gl.LINEAR;
    if (this.canvas.width !== this.frameWidth) this.canvas.width = this.frameWidth;
    if (this.canvas.height !== this.frameHeight) this.canvas.height = this.frameHeight;

    setWebGlTextureFilter(gl, this.albedoTex, filter);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      sprite.width,
      sprite.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      sprite.data,
    );

    if (options.normalMap) {
      this.hasNormalTex = true;
      setWebGlTextureFilter(gl, this.normalTex, filter);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        options.normalMap.width,
        options.normalMap.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        options.normalMap.data,
      );
    } else {
      this.hasNormalTex = false;
    }

    setWebGlTextureFilter(gl, this.fboTex, filter);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.frameWidth,
      this.frameHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fboTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.uvVbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.posVbo);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.vertices, gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rotVbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(mesh.vertices.length / 2), gl.DYNAMIC_DRAW);

    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ebo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    if (!checkWebGlNoError(gl, 'PuppetRenderer.setAssets')) {
      this.contextLost = true;
    }
  }
}

/**
 * Bakes all MLS puppet-warp animation frames (via WebGL2 FBO when available, or deterministic CPU
 * fallback) into a horizontal strip PNG + companion JSON manifest + optional normal-map strip.
 */
export function buildPuppetStripArtifacts(
  sprite: RgbaBuffer,
  mesh: SpriteMesh,
  slug: string,
  options: PuppetStripExportOptions,
  renderer?: PuppetRenderer | null,
): PuppetStripExportResult {
  const presetMeta = ANIM_PRESETS[options.preset];
  const keyframes = generatePresetKeyframes(
    options.pins,
    options.preset,
    options.frameCount,
    options.amplitudePx,
  );
  const restPins: Vec2[] = options.pins.map((p) => ({ x: p.x, y: p.y }));
  const paletteRgb = (options.paletteHex ?? []).map((h) => parseHexRgb(h));

  const useGpu = Boolean(renderer && !renderer.isContextLost());
  if (useGpu && renderer) {
    renderer.setAssets(sprite, mesh, {
      artMode: options.artMode,
      paddingPx: options.paddingPx,
      normalMap: options.normalMap,
    });
  }

  const albedoFrames: RgbaBuffer[] = [];
  const normalFrames: RgbaBuffer[] = [];

  for (const kf of keyframes) {
    const solved = solveMlsMesh(mesh.vertices, restPins, kf.pins, options.mode);

    let frameBuf: RgbaBuffer;
    if (renderer && !renderer.isContextLost()) {
      renderer.drawMeshPass(solved.positions, solved.rotations, {
        targetFbo: true,
        isNormalMap: false,
      });
      frameBuf = renderer.readFboBuffer();
    } else {
      frameBuf = rasterizeDeformedMeshCpu(sprite, mesh, solved.positions, solved.rotations, {
        paddingPx: options.paddingPx,
        pixelArt: options.artMode === 'pixel-art',
        isNormalMap: false,
      });
    }

    if (options.reLockPolish) {
      const cleaned = cleanOrphanPixels(frameBuf, { maxIslandPixels: 2 });
      frameBuf = applySelectiveOutline(cleaned.buffer, {
        mode: 'outer',
        expandCanvas: false,
        palette: paletteRgb.length > 0 ? paletteRgb : undefined,
      });
    }
    albedoFrames.push(frameBuf);

    if (options.normalMap) {
      let normBuf: RgbaBuffer;
      if (renderer && !renderer.isContextLost()) {
        renderer.drawMeshPass(solved.positions, solved.rotations, {
          targetFbo: true,
          isNormalMap: true,
          normalInvertY: options.normalInvertY ?? 1,
        });
        normBuf = renderer.readFboBuffer();
      } else {
        normBuf = rasterizeDeformedMeshCpu(
          options.normalMap,
          mesh,
          solved.positions,
          solved.rotations,
          {
            paddingPx: options.paddingPx,
            pixelArt: options.artMode === 'pixel-art',
            isNormalMap: true,
          },
        );
      }
      normalFrames.push(normBuf);
    }
  }

  const stripRaw = composeSpritesheetStrip(
    albedoFrames.map((f) => ({ rgba: f.data, width: f.width, height: f.height })),
  );
  const stripBuffer: RgbaBuffer = {
    width: stripRaw.width,
    height: stripRaw.height,
    data: stripRaw.rgba,
  };

  let normalStripBuffer: RgbaBuffer | undefined;
  if (normalFrames.length > 0) {
    const nStripRaw = composeSpritesheetStrip(
      normalFrames.map((f) => ({ rgba: f.data, width: f.width, height: f.height })),
    );
    normalStripBuffer = {
      width: nStripRaw.width,
      height: nStripRaw.height,
      data: nStripRaw.rgba,
    };
  }

  const frameW = albedoFrames[0]?.width ?? sprite.width + options.paddingPx * 2;
  const frameH = albedoFrames[0]?.height ?? sprite.height + options.paddingPx * 2;
  const animSuffix = presetMeta.exportSuffix;
  const stripFilenameSuffix = `${animSuffix}_strip.png`;
  const jsonFilenameSuffix = `${animSuffix}.json`;

  const atlasObj = {
    app: 'nibgrid',
    animation: animSuffix,
    preset: options.preset,
    mode: options.mode,
    fps: options.fps,
    loop: options.loop,
    pingPong: options.pingPong,
    image: `${slug}_${stripFilenameSuffix}`,
    ...(normalStripBuffer ? { normalMap: `${slug}_${animSuffix}_n_strip.png` } : {}),
    frameCount: albedoFrames.length,
    frameSize: { w: frameW, h: frameH },
    pivot: { x: options.pivotNorm.x, y: options.pivotNorm.y },
    frames: albedoFrames.map((_, idx) => ({
      filename: `${slug}_${animSuffix}_${idx}`,
      x: idx * frameW,
      y: 0,
      w: frameW,
      h: frameH,
      pivot: { x: options.pivotNorm.x, y: options.pivotNorm.y },
    })),
  };

  return {
    stripBuffer,
    normalStripBuffer,
    frames: albedoFrames,
    atlasJson: `${JSON.stringify(atlasObj, null, 2)}\n`,
    stripFilenameSuffix,
    jsonFilenameSuffix,
  };
}
