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

/**
 * WebGL2 textured mesh controller for real-time 60 FPS MLS puppet deformation & strip baking.
 */
export class PuppetRenderer {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: WebGLProgram;
  private readonly vao: WebGLVertexArrayObject;
  private readonly uvVbo: WebGLBuffer;
  private readonly posVbo: WebGLBuffer;
  private readonly rotVbo: WebGLBuffer;
  private readonly ebo: WebGLBuffer;
  private readonly albedoTex: WebGLTexture;
  private readonly normalTex: WebGLTexture;
  private readonly fboTex: WebGLTexture;
  private readonly fbo: WebGLFramebuffer;

  private indexCount = 0;
  private frameWidth = 1;
  private frameHeight = 1;
  private padPx = 0;
  private hasNormalTex = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) throw new Error('WebGL2 unavailable for PuppetRenderer.');
    this.gl = gl;

    this.prog = this.createProgram(puppetVertSrc, puppetFragSrc);
    this.vao = gl.createVertexArray()!;
    this.uvVbo = gl.createBuffer()!;
    this.posVbo = gl.createBuffer()!;
    this.rotVbo = gl.createBuffer()!;
    this.ebo = gl.createBuffer()!;
    this.albedoTex = this.createTexture(gl.NEAREST);
    this.normalTex = this.createTexture(gl.NEAREST);
    this.fboTex = this.createTexture(gl.NEAREST);
    this.fbo = gl.createFramebuffer()!;

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

  public setAssets(
    sprite: RgbaBuffer,
    mesh: SpriteMesh,
    options: { artMode: ArtMode; paddingPx: number; normalMap?: RgbaBuffer },
  ): void {
    if (this.disposed) return;
    const { gl } = this;
    const filter = options.artMode === 'pixel-art' ? gl.NEAREST : gl.LINEAR;
    this.padPx = Math.max(0, options.paddingPx);
    this.frameWidth = sprite.width + this.padPx * 2;
    this.frameHeight = sprite.height + this.padPx * 2;
    this.indexCount = mesh.indices.length;

    gl.canvas.width = this.frameWidth;
    gl.canvas.height = this.frameHeight;

    gl.bindTexture(gl.TEXTURE_2D, this.albedoTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
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
      gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
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

    gl.bindTexture(gl.TEXTURE_2D, this.fboTex);
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
  }

  public clearPreview(): void {
    if (this.disposed) return;
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
  }

  public readFboBuffer(): RgbaBuffer {
    const { gl, frameWidth, frameHeight } = this;
    const raw = new Uint8Array(frameWidth * frameHeight * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.readPixels(0, 0, frameWidth, frameHeight, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

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
    const { gl } = this;
    gl.deleteBuffer(this.uvVbo);
    gl.deleteBuffer(this.posVbo);
    gl.deleteBuffer(this.rotVbo);
    gl.deleteBuffer(this.ebo);
    gl.deleteTexture(this.albedoTex);
    gl.deleteTexture(this.normalTex);
    gl.deleteTexture(this.fboTex);
    gl.deleteFramebuffer(this.fbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.prog);
  }

  private createTexture(filter: number): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    return tex;
  }

  private createProgram(vertSrc: string, fragSrc: string): WebGLProgram {
    const { gl } = this;
    const compile = (type: number, src: string): WebGLShader => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) ?? '';
        gl.deleteShader(sh);
        throw new Error(`Puppet shader compile failed: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? '';
      gl.deleteProgram(prog);
      throw new Error(`Puppet shader link failed: ${log}`);
    }
    return prog;
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

  if (renderer) {
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
    if (renderer) {
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
      if (renderer) {
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
