import type { ArtMode } from '../domain/schemas';
import {
  bakeNormalMapCpu,
  computeBevelHeightmap,
  type BevelProfile,
  type NormalConvention,
} from '../processing/distanceField';
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
import fullscreenVertSrc from './shaders/fullscreen.vert.glsl?raw';
import lightPreviewFragSrc from './shaders/lightPreview.frag.glsl?raw';
import normalGenFragSrc from './shaders/normalGen.frag.glsl?raw';

export interface NormalBakeParams {
  readonly bevelRadiusPx: number;
  readonly bevelProfile: BevelProfile;
  readonly bevelStrength: number;
  readonly detailStrength: number;
  readonly convention: NormalConvention;
}

export type NormalViewMode = 'lit' | 'normal' | 'height' | 'split';

export interface PointLightParams {
  readonly x: number; // 0..1
  readonly y: number; // 0..1 (WebGL bottom-up)
  readonly z: number; // 0.08..0.8
  readonly color: readonly [number, number, number];
  readonly intensity: number;
  readonly roughness: number;
  readonly viewMode: NormalViewMode;
  readonly splitX: number;
}

export interface NormalMapRendererOptions extends WebGlLifecycleHooks {
  readonly artMode?: ArtMode;
}

const VIEW_MODE_INT: Record<NormalViewMode, number> = {
  lit: 0,
  normal: 1,
  height: 2,
  split: 3,
};

/**
 * 2-pass WebGL2 controller baking EDT bevel + Sobel tangent-space normal maps
 * into an offscreen FBO and rendering live Blinn-Phong point-light previews.
 */
export class NormalMapRenderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly gl: WebGL2RenderingContext;
  private readonly options: NormalMapRendererOptions;

  private bakeProg: WebGLProgram | null = null;
  private previewProg: WebGLProgram | null = null;
  private diffuseTex: WebGLTexture | null = null;
  private bevelTex: WebGLTexture | null = null;
  private normalTex: WebGLTexture | null = null;
  private normalFbo: WebGLFramebuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;

  private artMode: ArtMode;
  private width = 1;
  private height = 1;
  private lastSprite: RgbaBuffer | null = null;
  private lastBevelData: Uint8Array | null = null;
  private lastBevelKey = '';
  private lastBakeParams: NormalBakeParams | null = null;
  private lastLightParams: PointLightParams | null = null;
  private lastConvention: NormalConvention = 'opengl';
  private contextLost = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, options: NormalMapRendererOptions = {}) {
    this.canvas = canvas;
    this.options = options;
    this.artMode = options.artMode ?? 'pixel-art';
    this.gl = requestWebGl2Context(canvas, 'NormalMapRenderer');

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

  public setArtMode(artMode: ArtMode): void {
    this.artMode = artMode;
    if (this.isContextLost()) return;
    const filter = this.getTextureFilter();
    setWebGlTextureFilter(this.gl, this.diffuseTex, filter);
    setWebGlTextureFilter(this.gl, this.bevelTex, filter);
    setWebGlTextureFilter(this.gl, this.normalTex, filter);
  }

  public setSprite(sprite: RgbaBuffer): void {
    if (this.disposed) return;
    this.lastSprite = sprite;
    this.lastBevelData = null;
    this.lastBevelKey = '';
    this.width = Math.max(1, sprite.width);
    this.height = Math.max(1, sprite.height);

    if (this.isContextLost()) return;
    this.uploadSpriteInternal(sprite);
  }

  public bakeNormalMap(params: NormalBakeParams): void {
    if (this.disposed) return;
    this.lastBakeParams = params;
    this.lastConvention = params.convention;
    if (!this.lastSprite || this.isContextLost()) return;
    if (!this.bakeProg || !this.vao || !this.normalFbo || !this.diffuseTex || !this.bevelTex) {
      return;
    }

    const { gl } = this;
    const bevelKey = `${params.bevelRadiusPx}:${params.bevelProfile}`;
    if (bevelKey !== this.lastBevelKey || !this.lastBevelData) {
      const bevelData = computeBevelHeightmap(this.lastSprite, {
        bevelRadiusPx: params.bevelRadiusPx,
        profile: params.bevelProfile,
      });
      this.lastBevelData = bevelData;
      this.uploadBevelTexture(bevelData);
      this.lastBevelKey = bevelKey;
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalFbo);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clearColor(128 / 255, 128 / 255, 1, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.bakeProg);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTex);
    gl.uniform1i(gl.getUniformLocation(this.bakeProg, 'uDiffuse'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.bevelTex);
    gl.uniform1i(gl.getUniformLocation(this.bakeProg, 'uBevel'), 1);

    gl.uniform2f(
      gl.getUniformLocation(this.bakeProg, 'uTexelSize'),
      1 / this.width,
      1 / this.height,
    );
    gl.uniform1f(gl.getUniformLocation(this.bakeProg, 'uBevelStrength'), params.bevelStrength);
    gl.uniform1f(gl.getUniformLocation(this.bakeProg, 'uDetailStrength'), params.detailStrength);
    gl.uniform1f(
      gl.getUniformLocation(this.bakeProg, 'uInvertY'),
      params.convention === 'opengl' ? 1.0 : -1.0,
    );

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (!checkWebGlNoError(gl, 'NormalMapRenderer.bakeNormalMap')) {
      this.contextLost = true;
    }
  }

  public renderPreview(light: PointLightParams, convention: NormalConvention): void {
    if (this.disposed) return;
    this.lastLightParams = light;
    this.lastConvention = convention;
    if (this.isContextLost()) return;
    if (!this.previewProg || !this.vao || !this.diffuseTex || !this.normalTex || !this.bevelTex) {
      return;
    }

    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.previewProg);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTex);
    gl.uniform1i(gl.getUniformLocation(this.previewProg, 'uDiffuse'), 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
    gl.uniform1i(gl.getUniformLocation(this.previewProg, 'uNormal'), 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.bevelTex);
    gl.uniform1i(gl.getUniformLocation(this.previewProg, 'uBevel'), 2);

    gl.uniform3f(gl.getUniformLocation(this.previewProg, 'uLightPos'), light.x, light.y, light.z);
    gl.uniform3f(gl.getUniformLocation(this.previewProg, 'uLightColor'), ...light.color);
    gl.uniform1f(gl.getUniformLocation(this.previewProg, 'uLightIntensity'), light.intensity);
    gl.uniform3f(gl.getUniformLocation(this.previewProg, 'uAmbientColor'), 0.22, 0.24, 0.3);
    gl.uniform1f(gl.getUniformLocation(this.previewProg, 'uRoughness'), light.roughness);
    gl.uniform1f(
      gl.getUniformLocation(this.previewProg, 'uInvertY'),
      convention === 'opengl' ? 1.0 : -1.0,
    );
    gl.uniform1i(
      gl.getUniformLocation(this.previewProg, 'uViewMode'),
      VIEW_MODE_INT[light.viewMode],
    );
    gl.uniform1f(gl.getUniformLocation(this.previewProg, 'uSplitX'), light.splitX);

    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);

    if (!checkWebGlNoError(gl, 'NormalMapRenderer.renderPreview')) {
      this.contextLost = true;
    }
  }

  /**
   * Reads back the baked tangent-space normal FBO into a top-down `RgbaBuffer` for `_n.png` export.
   * Falls back cleanly to CPU Sobel baking if the WebGL2 context is currently lost.
   */
  public readNormalMapBuffer(): RgbaBuffer {
    if (this.isContextLost() || !this.normalFbo) {
      if (this.lastSprite && this.lastBakeParams) {
        return bakeNormalMapCpu(this.lastSprite, this.lastBakeParams);
      }
      return {
        width: this.width,
        height: this.height,
        data: new Uint8ClampedArray(this.width * this.height * 4),
      };
    }

    const { gl, width, height } = this;
    const raw = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalFbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (!checkWebGlNoError(gl, 'NormalMapRenderer.readNormalMapBuffer')) {
      this.contextLost = true;
      if (this.lastSprite && this.lastBakeParams) {
        return bakeNormalMapCpu(this.lastSprite, this.lastBakeParams);
      }
    }

    const flipped = new Uint8ClampedArray(width * height * 4);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const srcOff = (height - 1 - y) * rowBytes;
      flipped.set(raw.subarray(srcOff, srcOff + rowBytes), y * rowBytes);
    }
    return { width, height, data: flipped };
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
    this.lastSprite = null;
    this.lastBevelData = null;
  }

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.contextLost = true;
    this.options.onContextLost?.();
  };

  private readonly handleContextRestored = (): void => {
    if (this.disposed) return;
    this.resetResourceRefs();
    this.contextLost = false;
    this.initGpuResources();

    if (this.lastSprite) {
      this.uploadSpriteInternal(this.lastSprite);
      if (this.lastBevelData) {
        this.uploadBevelTexture(this.lastBevelData);
      } else {
        this.lastBevelKey = '';
      }
      if (this.lastBakeParams) {
        this.bakeNormalMap(this.lastBakeParams);
      }
      if (this.lastLightParams) {
        this.renderPreview(this.lastLightParams, this.lastConvention);
      }
    }
    this.options.onContextRestored?.();
  };

  private getTextureFilter(): number {
    return this.artMode === 'pixel-art' ? this.gl.NEAREST : this.gl.LINEAR;
  }

  private initGpuResources(): void {
    const { gl } = this;
    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create WebGL2 VertexArrayObject.');
    this.vao = vao;

    this.bakeProg = compileWebGlProgram(gl, fullscreenVertSrc, normalGenFragSrc, 'NormalGen');
    this.previewProg = compileWebGlProgram(
      gl,
      fullscreenVertSrc,
      lightPreviewFragSrc,
      'LightPreview',
    );
    const filter = this.getTextureFilter();
    this.diffuseTex = createWebGlTexture2D(gl, filter);
    this.bevelTex = createWebGlTexture2D(gl, filter);
    this.normalTex = createWebGlTexture2D(gl, filter);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Failed to allocate WebGL2 framebuffer.');
    this.normalFbo = fbo;
  }

  private deleteGpuResources(): void {
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.useProgram(null);

    if (this.diffuseTex) gl.deleteTexture(this.diffuseTex);
    if (this.bevelTex) gl.deleteTexture(this.bevelTex);
    if (this.normalTex) gl.deleteTexture(this.normalTex);
    if (this.normalFbo) gl.deleteFramebuffer(this.normalFbo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.bakeProg) gl.deleteProgram(this.bakeProg);
    if (this.previewProg) gl.deleteProgram(this.previewProg);
    this.resetResourceRefs();
  }

  private resetResourceRefs(): void {
    this.diffuseTex = null;
    this.bevelTex = null;
    this.normalTex = null;
    this.normalFbo = null;
    this.vao = null;
    this.bakeProg = null;
    this.previewProg = null;
  }

  private uploadSpriteInternal(sprite: RgbaBuffer): void {
    if (!this.diffuseTex || !this.normalTex || !this.normalFbo) return;
    const { gl } = this;
    const maxTexSize = (gl.getParameter(gl.MAX_TEXTURE_SIZE) as number) || 4096;
    if (this.width > maxTexSize || this.height > maxTexSize) {
      throw new Error(
        `Sprite dimensions (${this.width}x${this.height}) exceed GPU MAX_TEXTURE_SIZE (${maxTexSize}).`,
      );
    }

    if (this.canvas.width !== this.width) this.canvas.width = this.width;
    if (this.canvas.height !== this.height) this.canvas.height = this.height;

    const filter = this.getTextureFilter();
    setWebGlTextureFilter(gl, this.diffuseTex, filter);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.width,
      this.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      sprite.data,
    );

    setWebGlTextureFilter(gl, this.normalTex, filter);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      this.width,
      this.height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.normalTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    if (!checkWebGlNoError(gl, 'NormalMapRenderer.setSprite')) {
      this.contextLost = true;
    }
  }

  private uploadBevelTexture(bevelData: Uint8Array): void {
    if (!this.bevelTex) return;
    const { gl } = this;
    setWebGlTextureFilter(gl, this.bevelTex, this.getTextureFilter());
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.R8,
      this.width,
      this.height,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      bevelData,
    );
  }
}
