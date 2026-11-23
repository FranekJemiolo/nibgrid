import {
  computeBevelHeightmap,
  type BevelProfile,
  type NormalConvention,
} from '../processing/distanceField';
import type { RgbaBuffer } from '../processing/types';
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
  private readonly gl: WebGL2RenderingContext;
  private readonly bakeProg: WebGLProgram;
  private readonly previewProg: WebGLProgram;
  private readonly diffuseTex: WebGLTexture;
  private readonly bevelTex: WebGLTexture;
  private readonly normalTex: WebGLTexture;
  private readonly normalFbo: WebGLFramebuffer;
  private readonly vao: WebGLVertexArrayObject;

  private width = 1;
  private height = 1;
  private lastSprite: RgbaBuffer | null = null;
  private lastBevelKey = '';
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
      antialias: false,
    });
    if (!gl) {
      throw new Error('WebGL2 context unavailable.');
    }
    this.gl = gl;

    const vao = gl.createVertexArray();
    if (!vao) throw new Error('Failed to create WebGL2 VertexArrayObject.');
    this.vao = vao;

    this.bakeProg = this.createProgram(fullscreenVertSrc, normalGenFragSrc);
    this.previewProg = this.createProgram(fullscreenVertSrc, lightPreviewFragSrc);
    this.diffuseTex = this.createTexture(gl.NEAREST);
    this.bevelTex = this.createTexture(gl.LINEAR);
    this.normalTex = this.createTexture(gl.NEAREST);

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error('Failed to allocate WebGL2 framebuffer.');
    this.normalFbo = fbo;
  }

  public setSprite(sprite: RgbaBuffer): void {
    if (this.disposed) return;
    const { gl } = this;
    this.lastSprite = sprite;
    this.lastBevelKey = '';
    this.width = Math.max(1, sprite.width);
    this.height = Math.max(1, sprite.height);

    gl.canvas.width = this.width;
    gl.canvas.height = this.height;

    gl.bindTexture(gl.TEXTURE_2D, this.diffuseTex);
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

    gl.bindTexture(gl.TEXTURE_2D, this.normalTex);
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
  }

  public bakeNormalMap(params: NormalBakeParams): void {
    if (this.disposed || !this.lastSprite) return;
    const { gl } = this;

    const bevelKey = `${params.bevelRadiusPx}:${params.bevelProfile}`;
    if (bevelKey !== this.lastBevelKey) {
      const bevelData = computeBevelHeightmap(this.lastSprite, {
        bevelRadiusPx: params.bevelRadiusPx,
        profile: params.bevelProfile,
      });
      gl.bindTexture(gl.TEXTURE_2D, this.bevelTex);
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
  }

  public renderPreview(light: PointLightParams, convention: NormalConvention): void {
    if (this.disposed) return;
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
  }

  /**
   * Reads back the baked tangent-space normal FBO into a top-down `RgbaBuffer` for `_n.png` export.
   */
  public readNormalMapBuffer(): RgbaBuffer {
    const { gl, width, height } = this;
    const raw = new Uint8Array(width * height * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.normalFbo);
    gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, raw);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

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
    const { gl } = this;
    gl.deleteTexture(this.diffuseTex);
    gl.deleteTexture(this.bevelTex);
    gl.deleteTexture(this.normalTex);
    gl.deleteFramebuffer(this.normalFbo);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.bakeProg);
    gl.deleteProgram(this.previewProg);
  }

  private createTexture(filter: number): WebGLTexture {
    const { gl } = this;
    const tex = gl.createTexture();
    if (!tex) throw new Error('Failed to create WebGL2 texture.');
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
      const sh = gl.createShader(type);
      if (!sh) throw new Error('Failed to allocate shader.');
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh) ?? '';
        gl.deleteShader(sh);
        throw new Error(`Shader compile failed: ${log}`);
      }
      return sh;
    };
    const vs = compile(gl.VERTEX_SHADER, vertSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram();
    if (!prog) throw new Error('Failed to allocate WebGL2 program.');
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog) ?? '';
      gl.deleteProgram(prog);
      throw new Error(`Program link failed: ${log}`);
    }
    return prog;
  }
}
