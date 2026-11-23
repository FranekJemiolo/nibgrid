interface LoseContextExt {
  loseContext(): void;
  restoreContext(): void;
}

const RELEASED_CONTEXTS = new WeakMap<WebGL2RenderingContext, LoseContextExt>();

export interface WebGlLifecycleHooks {
  readonly onContextLost?: () => void;
  readonly onContextRestored?: () => void;
}

export function requestWebGl2Context(
  canvas: HTMLCanvasElement,
  label: string,
): WebGL2RenderingContext {
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    antialias: false,
  });
  if (!gl) {
    throw new Error(`WebGL2 context unavailable for ${label}.`);
  }
  return gl;
}

export function createWebGlTexture2D(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) {
    throw new Error('Failed to create WebGL2 texture.');
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  return tex;
}

export function setWebGlTextureFilter(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture | null,
  filter: number,
): void {
  if (!tex) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
}

export function setWebGlTextureWrap(
  gl: WebGL2RenderingContext,
  tex: WebGLTexture | null,
  wrap: number,
): void {
  if (!tex) return;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
}

export function compileWebGlProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
  label: string,
): WebGLProgram {
  const compile = (type: number, src: string): WebGLShader => {
    const sh = gl.createShader(type);
    if (!sh) {
      throw new Error(`${label} shader allocation failed.`);
    }
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) ?? '';
      gl.deleteShader(sh);
      throw new Error(`${label} shader compile failed: ${log}`);
    }
    return sh;
  };

  const vs = compile(gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl.FRAGMENT_SHADER, fragSrc);
  const prog = gl.createProgram();
  if (!prog) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`${label} program allocation failed.`);
  }

  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  gl.detachShader(prog, vs);
  gl.detachShader(prog, fs);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '';
    gl.deleteProgram(prog);
    throw new Error(`${label} program link failed: ${log}`);
  }
  return prog;
}

/**
 * Checks `gl.getError()` after a pipeline stage.
 * Returns `false` if context loss is active, `true` when `NO_ERROR`, and throws on unexpected GL errors.
 */
export function checkWebGlNoError(gl: WebGL2RenderingContext, stage: string): boolean {
  const err = gl.getError();
  if (err === gl.NO_ERROR) {
    return true;
  }
  if (err === gl.CONTEXT_LOST_WEBGL || gl.isContextLost()) {
    return false;
  }
  // Drain queued error flags before throwing so diagnostics remain clean
  while (gl.getError() !== gl.NO_ERROR) {
    // intentional drain
  }
  throw new Error(`WebGL2 error at ${stage}: 0x${err.toString(16)}`);
}

export function forceReleaseWebGlContext(gl: WebGL2RenderingContext): void {
  if (gl.isContextLost()) return;
  const ext = gl.getExtension('WEBGL_lose_context') as LoseContextExt | null;
  if (!ext) return;
  RELEASED_CONTEXTS.set(gl, ext);
  ext.loseContext();
}

export function restoreReleasedWebGlContextIfNeeded(gl: WebGL2RenderingContext): boolean {
  const ext = RELEASED_CONTEXTS.get(gl);
  if (!ext) return false;
  RELEASED_CONTEXTS.delete(gl);
  ext.restoreContext();
  return true;
}
