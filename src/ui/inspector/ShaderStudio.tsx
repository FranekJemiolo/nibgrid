import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Code2,
  Download,
  FileArchive,
  Link2,
  Pause,
  Play,
  RotateCcw,
  Save,
  Sparkles,
  Vault,
} from 'lucide-react';
import { strToU8 } from 'fflate';
import type {
  PostProcessConfig,
  Project,
  ProviderConfig,
  ShaderConfig,
  ShaderUniformValue,
  SpriteNode,
} from '../../domain/schemas';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { exportGodotShaderMaterialTres, packageShaderZip } from '../../export/shaderExporters';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { GDSHADER_PRESETS, getGdShaderPreset } from '../../processing/gdshaderPresets';
import {
  transpileGdShaderToWebGL2,
  type GdShaderUniform,
} from '../../processing/gdshaderTranspiler';
import { encodeRgbaToPngBytes } from '../../processing/png';
import { computeArtBibleHash } from '../../processing/projectAudit';
import type { RgbaBuffer } from '../../processing/types';
import { estimateShaderGenerationCost, generateGdShader } from '../../providers/shaderGenerator';
import { useAppStore } from '../../store/useAppStore';
import {
  compileWebGlProgram,
  createWebGlTexture2D,
  forceReleaseWebGlContext,
  requestWebGl2Context,
  setWebGlTextureFilter,
} from '../../webgl/glUtils';
import { ScrubInput } from '../primitives/ScrubInput';

interface ShaderStudioProps {
  readonly sprite: RgbaBuffer;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly providers: readonly ProviderConfig[];
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly shaderConfig: ShaderConfig;
  readonly onChangeConfig: (next: ShaderConfig) => void;
  readonly onSaveToProject: (saved: ShaderConfig) => Promise<void>;
}

function rgbArrayToHex(rgb: readonly number[]): string {
  const clampByte = (v: number) => Math.max(0, Math.min(255, Math.round((v ?? 0) * 255)));
  const hex = (v: number) => clampByte(v).toString(16).padStart(2, '0');
  return `#${hex(rgb[0] ?? 1)}${hex(rgb[1] ?? 1)}${hex(rgb[2] ?? 1)}`;
}

function hexToRgbNorm(hex: string): [number, number, number] {
  const clean = hex.replace('#', '').trim();
  if (clean.length !== 6) return [1, 1, 1];
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return [1, 1, 1];
  return [Number((r / 255).toFixed(3)), Number((g / 255).toFixed(3)), Number((b / 255).toFixed(3))];
}

function mergeUniformDefaults(
  uniforms: readonly GdShaderUniform[],
  existing: Record<string, ShaderUniformValue>,
): Record<string, ShaderUniformValue> {
  const next: Record<string, ShaderUniformValue> = {};
  for (const uniform of uniforms) {
    const prev = existing[uniform.name];
    if (prev !== undefined) {
      if (uniform.type === 'bool' && typeof prev === 'boolean') {
        next[uniform.name] = prev;
        continue;
      }
      if ((uniform.type === 'float' || uniform.type === 'int') && typeof prev === 'number') {
        next[uniform.name] = prev;
        continue;
      }
      if (
        (uniform.type === 'vec2' || uniform.type === 'vec3' || uniform.type === 'vec4') &&
        Array.isArray(prev)
      ) {
        next[uniform.name] = prev;
        continue;
      }
    }
    next[uniform.name] = Array.isArray(uniform.defaultValue)
      ? [...uniform.defaultValue]
      : uniform.defaultValue;
  }
  return next;
}

export function ShaderStudio({
  sprite,
  project,
  targetNode,
  providers,
  postProcessConfig,
  rawWidth,
  rawHeight,
  shaderConfig,
  onChangeConfig,
  onSaveToProject,
}: ShaderStudioProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glStateRef = useRef<{
    gl: WebGL2RenderingContext;
    program: WebGLProgram | null;
    vao: WebGLVertexArrayObject | null;
    vbo: WebGLBuffer | null;
    texture: WebGLTexture | null;
  } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const enabledProviders = useMemo(() => {
    const enabled = providers.filter((p) => p.enabled);
    if (enabled.length > 0) return enabled;
    return providers;
  }, [providers]);

  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const gemini = enabledProviders.find((p) => p.kind === 'gemini' && p.apiKey.trim().length > 0);
    if (gemini) return gemini.id;
    const bridge = enabledProviders.find((p) => p.kind === 'antigravity-bridge');
    if (bridge) return bridge.id;
    return enabledProviders[0]?.id ?? 'mock';
  });

  const activeProvider = useMemo(
    () =>
      enabledProviders.find((p) => p.id === selectedProviderId) ??
      enabledProviders[0] ?? {
        id: 'mock',
        kind: 'mock' as const,
        displayName: 'Offline Mock',
        modelId: 'mock-v1',
        endpointUrl: 'mock://local',
        apiKey: '',
        enabled: true,
        capabilities: {
          supportsInpaint: false,
          supportsMultiRef: false,
          supportsSeed: true,
          isLocal: true,
        },
        updatedAt: new Date().toISOString(),
      },
    [enabledProviders, selectedProviderId],
  );

  const [codeTab, setCodeTab] = useState<'gdshader' | 'tres'>('gdshader');
  const [backdrop, setBackdrop] = useState<'checker' | 'dark' | 'light'>('checker');
  const [zoomScale, setZoomScale] = useState<number>(4);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [glCompileError, setGlCompileError] = useState<string | null>(null);
  const [webglUnavailable, setWebglUnavailable] = useState(false);
  const promoteShaderToVault = useAppStore((s) => s.promoteShaderToVault);
  const openShareModal = useAppStore((s) => s.openShareModal);

  const elapsedTimeRef = useRef(0);
  const lastFrameTsRef = useRef<number | null>(null);
  const liveUniformsRef = useRef<{
    config: ShaderConfig;
    uniformDefs: readonly GdShaderUniform[];
  }>({
    config: shaderConfig,
    uniformDefs: [],
  });

  const transpiled = useMemo(
    () => transpileGdShaderToWebGL2(shaderConfig.gdshaderSource),
    [shaderConfig.gdshaderSource],
  );

  liveUniformsRef.current = {
    config: shaderConfig,
    uniformDefs: transpiled.uniforms,
  };

  const slug = useMemo(
    () => toAssetSlug(`${project.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`),
    [project.name, targetNode.generationMeta.seed, targetNode.kind],
  );

  const tresPreviewText = useMemo(
    () =>
      exportGodotShaderMaterialTres(
        `res://assets/nibgrid/${slug}/${slug}.gdshader`,
        shaderConfig.gdshaderSource,
        shaderConfig.uniformValues,
      ),
    [shaderConfig.gdshaderSource, shaderConfig.uniformValues, slug],
  );

  const costEstimate = estimateShaderGenerationCost(activeProvider.kind);

  // Initialize WebGL2 context once per mount and dispose cleanly on unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let gl: WebGL2RenderingContext;
    try {
      gl = requestWebGl2Context(canvas, 'ShaderStudio');
    } catch {
      setWebglUnavailable(true);
      return undefined;
    }

    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    const quadVerts = new Float32Array([-1, -1, 0, 1, 1, -1, 1, 1, -1, 1, 0, 0, 1, 1, 1, 0]);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    const texture = createWebGlTexture2D(
      gl,
      project.artBible.artMode === 'pixel-art' ? gl.NEAREST : gl.LINEAR,
    );

    glStateRef.current = {
      gl,
      program: null,
      vao,
      vbo,
      texture,
    };
    setWebglUnavailable(false);

    return () => {
      const state = glStateRef.current;
      if (state) {
        if (state.program) state.gl.deleteProgram(state.program);
        if (state.texture) state.gl.deleteTexture(state.texture);
        if (state.vbo) state.gl.deleteBuffer(state.vbo);
        if (state.vao) state.gl.deleteVertexArray(state.vao);
        forceReleaseWebGlContext(state.gl);
        glStateRef.current = null;
      }
      abortRef.current?.abort();
    };
    // Single WebGL2 context per mount; texture filter updates in sprite effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Upload active sprite texture whenever buffer or artMode changes
  useEffect(() => {
    const state = glStateRef.current;
    const canvas = canvasRef.current;
    if (!state || !canvas) return;
    const { gl, texture } = state;
    if (!texture || gl.isContextLost()) return;

    canvas.width = Math.max(1, sprite.width);
    canvas.height = Math.max(1, sprite.height);

    setWebGlTextureFilter(
      gl,
      texture,
      project.artBible.artMode === 'pixel-art' ? gl.NEAREST : gl.LINEAR,
    );
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 0);
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
  }, [sprite, project.artBible.artMode]);

  // Recompile WebGL2 program when transpiled GLSL changes cleanly (preserve last valid program on error)
  useEffect(() => {
    const state = glStateRef.current;
    if (!state || state.gl.isContextLost()) return;
    if (!transpiled.ok) {
      setGlCompileError(null);
      return;
    }

    try {
      const nextProg = compileWebGlProgram(
        state.gl,
        transpiled.vertexGlsl,
        transpiled.fragmentGlsl,
        'ShaderStudioProgram',
      );
      if (state.program) {
        state.gl.deleteProgram(state.program);
      }
      state.program = nextProg;
      setGlCompileError(null);
    } catch (err) {
      setGlCompileError(err instanceof Error ? err.message : 'WebGL2 shader compile error.');
    }
  }, [transpiled]);

  // 60 FPS uniform & draw loop
  useEffect(() => {
    let rafId = 0;
    const drawFrame = (nowMs: number) => {
      const state = glStateRef.current;
      const canvas = canvasRef.current;
      if (
        state &&
        canvas &&
        state.program &&
        state.vao &&
        state.texture &&
        !state.gl.isContextLost()
      ) {
        const { gl, program, vao, texture } = state;
        const { config, uniformDefs } = liveUniformsRef.current;
        if (lastFrameTsRef.current !== null && !config.paused) {
          const dtSec = Math.min(0.1, (nowMs - lastFrameTsRef.current) / 1000);
          elapsedTimeRef.current += dtSec * config.timeScale;
        }
        lastFrameTsRef.current = nowMs;

        gl.viewport(0, 0, canvas.width, canvas.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(program);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);

        const texLoc = gl.getUniformLocation(program, 'u_texture');
        if (texLoc) gl.uniform1i(texLoc, 0);

        const timeLoc = gl.getUniformLocation(program, 'TIME');
        if (timeLoc) gl.uniform1f(timeLoc, elapsedTimeRef.current);

        const sizeLoc = gl.getUniformLocation(program, 'u_tex_size');
        if (sizeLoc) gl.uniform2f(sizeLoc, canvas.width, canvas.height);

        for (const u of uniformDefs) {
          const loc = gl.getUniformLocation(program, u.name);
          if (!loc) continue;
          const val = config.uniformValues[u.name] ?? u.defaultValue;
          if (u.type === 'float') {
            gl.uniform1f(loc, typeof val === 'number' ? val : Number(val) || 0);
          } else if (u.type === 'int') {
            gl.uniform1i(loc, typeof val === 'number' ? Math.round(val) : 0);
          } else if (u.type === 'bool') {
            gl.uniform1i(loc, val ? 1 : 0);
          } else if (u.type === 'vec2') {
            const arr = Array.isArray(val) ? val : [0, 0];
            gl.uniform2f(loc, arr[0] ?? 0, arr[1] ?? 0);
          } else if (u.type === 'vec3') {
            const arr = Array.isArray(val) ? val : [1, 1, 1];
            gl.uniform3f(loc, arr[0] ?? 0, arr[1] ?? 0, arr[2] ?? 0);
          } else if (u.type === 'vec4') {
            const arr = Array.isArray(val) ? val : [1, 1, 1, 1];
            gl.uniform4f(loc, arr[0] ?? 1, arr[1] ?? 1, arr[2] ?? 1, arr[3] ?? 1);
          }
        }

        gl.bindVertexArray(vao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        gl.bindVertexArray(null);
      } else {
        lastFrameTsRef.current = nowMs;
      }
      rafId = requestAnimationFrame(drawFrame);
    };
    rafId = requestAnimationFrame(drawFrame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  const handleApplyPreset = useCallback(
    (presetId: string) => {
      const preset = getGdShaderPreset(presetId);
      const parsed = transpileGdShaderToWebGL2(preset.source);
      const next: ShaderConfig = {
        ...shaderConfig,
        presetId: preset.id,
        gdshaderSource: preset.source,
        uniformValues: mergeUniformDefaults(parsed.uniforms, {}),
      };
      onChangeConfig(next);
      setGenError(null);
      setStatusNotice(`Loaded "${preset.label}" preset.`);
    },
    [onChangeConfig, shaderConfig],
  );

  const handleSourceChange = useCallback(
    (nextSource: string) => {
      const parsed = transpileGdShaderToWebGL2(nextSource);
      onChangeConfig({
        ...shaderConfig,
        presetId: 'custom',
        gdshaderSource: nextSource,
        uniformValues: mergeUniformDefaults(parsed.uniforms, shaderConfig.uniformValues),
      });
    },
    [onChangeConfig, shaderConfig],
  );

  const handleUniformChange = useCallback(
    (name: string, nextVal: ShaderUniformValue) => {
      onChangeConfig({
        ...shaderConfig,
        uniformValues: {
          ...shaderConfig.uniformValues,
          [name]: nextVal,
        },
      });
    },
    [onChangeConfig, shaderConfig],
  );

  const handleGenerateShader = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsGenerating(true);
    setGenError(null);
    setStatusNotice(null);

    try {
      const outcome = await generateGdShader({
        prompt: shaderConfig.prompt,
        artBible: project.artBible,
        providerConfig: activeProvider,
        signal: controller.signal,
      });

      const next: ShaderConfig = {
        ...shaderConfig,
        presetId: outcome.presetId ?? 'ai-custom',
        gdshaderSource: outcome.gdshaderSource,
        uniformValues: mergeUniformDefaults(outcome.transpiled.uniforms, {}),
      };
      onChangeConfig(next);
      setStatusNotice(
        `Generated shader via ${outcome.providerLabel} (${outcome.transpiled.uniforms.length} uniforms).`,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatusNotice('Shader generation cancelled.');
      } else {
        setGenError(err instanceof Error ? err.message : 'Shader generation failed.');
      }
    } finally {
      setIsGenerating(false);
    }
  }, [activeProvider, onChangeConfig, project.artBible, shaderConfig]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await onSaveToProject(shaderConfig);
      setStatusNotice('Saved shader & uniform parameters to sprite node.');
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Failed to save shader configuration.');
    } finally {
      setIsSaving(false);
    }
  }, [onSaveToProject, shaderConfig]);

  const handlePromoteShaderToVault = useCallback(async () => {
    try {
      const label = shaderConfig.prompt.trim()
        ? shaderConfig.prompt.trim().slice(0, 48)
        : `${slug} (${shaderConfig.presetId})`;
      await promoteShaderToVault(label, shaderConfig, {
        sourceProjectName: project.name,
      });
      setStatusNotice(`Promoted "${label}" to Global Asset Vault.`);
    } catch (err) {
      setGenError(err instanceof Error ? err.message : 'Failed to promote shader to Vault.');
    }
  }, [project.name, promoteShaderToVault, shaderConfig, slug]);

  const handleDownloadShaderFile = useCallback(() => {
    const content = shaderConfig.gdshaderSource.endsWith('\n')
      ? shaderConfig.gdshaderSource
      : `${shaderConfig.gdshaderSource}\n`;
    const bytes = strToU8(content);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'text/plain;charset=utf-8' }),
      `${slug}.gdshader`,
    );
    setStatusNotice(`Downloaded ${slug}.gdshader`);
  }, [shaderConfig.gdshaderSource, slug]);

  const handleDownloadMatTres = useCallback(() => {
    const bytes = strToU8(tresPreviewText);
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'text/plain;charset=utf-8' }),
      `${slug}_mat.tres`,
    );
    setStatusNotice(`Downloaded ${slug}_mat.tres`);
  }, [slug, tresPreviewText]);

  const handleDownloadBundleZip = useCallback(() => {
    const pngBytes = encodeRgbaToPngBytes(sprite.data, sprite.width, sprite.height);
    const recipe = buildAssetRecipe({
      project,
      node: targetNode,
      postProcess: postProcessConfig,
      filename: `${slug}.png`,
      outputWidth: sprite.width,
      outputHeight: sprite.height,
      normalizedWidth: rawWidth,
      normalizedHeight: rawHeight,
      recipeArtBibleHash: computeArtBibleHash(project.artBible),
      shaderConfig,
    });
    const zipBytes = packageShaderZip({
      slug,
      shaderConfig,
      recipe,
      spritePngBytes: pngBytes,
    });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    triggerBlobDownload(new Blob([copy.buffer], { type: 'application/zip' }), `${slug}_shader.zip`);
    setStatusNotice(`Exported ${slug}_shader.zip (.gdshader + _mat.tres + recipe)`);
  }, [postProcessConfig, project, rawHeight, rawWidth, shaderConfig, slug, sprite, targetNode]);

  const allErrors = [...transpiled.errors, ...(glCompileError ? [glCompileError] : [])];

  const backdropStyle =
    backdrop === 'checker'
      ? {
          backgroundImage:
            'linear-gradient(45deg, #1b1b1f 25%, transparent 25%), linear-gradient(-45deg, #1b1b1f 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #1b1b1f 75%), linear-gradient(-45deg, transparent 75%, #1b1b1f 75%)',
          backgroundSize: '16px 16px',
          backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
          backgroundColor: '#121214',
        }
      : backdrop === 'light'
        ? { backgroundColor: '#d4d4d8' }
        : { backgroundColor: '#121214' };

  return (
    <div
      data-testid="shader-studio"
      className="grid h-full min-h-0 grid-cols-1 gap-4 p-4 lg:grid-cols-[310px_minmax(0,1fr)_360px]"
    >
      {/* Left Dock: Presets, GenAI Prompt & Dynamic Uniforms */}
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded border border-[#2A2A2E] bg-[#1A1A1D] p-3">
        <div className="flex items-center justify-between border-b border-[#2A2A2E] pb-2">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Screen 4N · Godot 4 Shaders
            </p>
            <h2 className="text-sm font-semibold text-zinc-100">CanvasItem Shader Studio</h2>
          </div>
          <span
            data-testid="shader-cost-badge"
            className="rounded border border-[#2A2A2E] bg-[#121214] px-2 py-0.5 font-mono text-[10px] text-amber-300"
          >
            {costEstimate.label}
          </span>
        </div>

        {/* Presets */}
        <div>
          <p className="mb-1.5 text-[11px] font-medium text-zinc-400">Curated Offline Presets</p>
          <div className="flex flex-wrap gap-1.5">
            {GDSHADER_PRESETS.map((preset) => {
              const active = shaderConfig.presetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`shader-preset-${preset.id}`}
                  onClick={() => handleApplyPreset(preset.id)}
                  className={`rounded border px-2 py-1 text-[11px] font-medium transition ${
                    active
                      ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                      : 'border-[#2A2A2E] bg-[#121214] text-zinc-300 hover:border-zinc-600'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* AI Prompt Composer */}
        <div className="space-y-2 rounded border border-[#2A2A2E] bg-[#121214] p-2.5">
          <div className="flex items-center justify-between">
            <label htmlFor="shader-prompt-input" className="text-[11px] font-medium text-zinc-300">
              GenAI Shader Prompt
            </label>
            <select
              aria-label="Shader generator provider"
              data-testid="shader-provider-select"
              value={activeProvider.id}
              onChange={(e) => setSelectedProviderId(e.target.value)}
              className="max-w-[140px] truncate rounded border border-[#2A2A2E] bg-[#1A1A1D] px-1.5 py-0.5 text-[11px] text-zinc-200"
            >
              {enabledProviders.map((prov) => (
                <option key={prov.id} value={prov.id}>
                  {prov.displayName}
                </option>
              ))}
            </select>
          </div>
          <textarea
            id="shader-prompt-input"
            data-testid="shader-prompt-input"
            rows={2}
            value={shaderConfig.prompt}
            onChange={(e) => onChangeConfig({ ...shaderConfig, prompt: e.target.value })}
            placeholder='e.g. "wind sway for pixel foliage" or "golden metallic sheen"'
            className="w-full resize-none rounded border border-[#2A2A2E] bg-[#1A1A1D] px-2 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-400 focus:outline-none"
          />
          <button
            type="button"
            data-testid="shader-generate-btn"
            disabled={isGenerating}
            onClick={() => void handleGenerateShader()}
            className="flex w-full items-center justify-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {isGenerating ? 'Generating…' : 'Generate .gdshader'}
          </button>
          {genError && (
            <p
              data-testid="shader-gen-error"
              className="rounded border border-rose-500/40 bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200"
            >
              {genError}
            </p>
          )}
        </div>

        {/* Dynamic Uniform Controls */}
        <div className="flex-1 space-y-2.5 border-t border-[#2A2A2E] pt-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
              Shader Uniforms ({transpiled.uniforms.length})
            </span>
          </div>

          {transpiled.uniforms.length === 0 ? (
            <p className="text-xs text-zinc-500">
              No `uniform` parameters detected in shader source.
            </p>
          ) : (
            transpiled.uniforms.map((uniform) => {
              const rawVal = shaderConfig.uniformValues[uniform.name] ?? uniform.defaultValue;
              if (uniform.isColor && (uniform.type === 'vec4' || uniform.type === 'vec3')) {
                const arr = Array.isArray(rawVal) ? rawVal : [1, 1, 1, 1];
                const hex = rgbArrayToHex(arr);
                const alpha = arr[3] ?? 1;
                return (
                  <div
                    key={uniform.name}
                    className="space-y-1.5 rounded border border-[#2A2A2E] bg-[#121214] p-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px] text-zinc-200">{uniform.name}</span>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-[10px] text-zinc-400">{hex}</span>
                        <input
                          type="color"
                          aria-label={`${uniform.name} color`}
                          data-testid={`shader-uniform-color-${uniform.name}`}
                          value={hex}
                          onChange={(e) => {
                            const [r, g, b] = hexToRgbNorm(e.target.value);
                            if (uniform.type === 'vec3') {
                              handleUniformChange(uniform.name, [r, g, b]);
                            } else {
                              handleUniformChange(uniform.name, [r, g, b, alpha]);
                            }
                          }}
                          className="h-6 w-8 cursor-pointer rounded border border-[#2A2A2E] bg-transparent"
                        />
                      </div>
                    </div>
                    {uniform.type === 'vec4' && (
                      <ScrubInput
                        label={`${uniform.name} alpha`}
                        value={alpha}
                        min={0}
                        max={1}
                        step={0.01}
                        decimals={2}
                        testId={`shader-uniform-alpha-${uniform.name}`}
                        onChange={(nextAlpha) =>
                          handleUniformChange(uniform.name, [
                            arr[0] ?? 1,
                            arr[1] ?? 1,
                            arr[2] ?? 1,
                            nextAlpha,
                          ])
                        }
                      />
                    )}
                  </div>
                );
              }

              if (uniform.type === 'bool') {
                return (
                  <label
                    key={uniform.name}
                    className="flex cursor-pointer items-center justify-between rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1.5 text-xs text-zinc-200"
                  >
                    <span className="font-mono text-[11px]">{uniform.name}</span>
                    <input
                      type="checkbox"
                      data-testid={`shader-uniform-bool-${uniform.name}`}
                      checked={Boolean(rawVal)}
                      onChange={(e) => handleUniformChange(uniform.name, e.target.checked)}
                      className="accent-amber-400"
                    />
                  </label>
                );
              }

              if (uniform.type === 'float' || uniform.type === 'int') {
                const numVal = typeof rawVal === 'number' ? rawVal : Number(rawVal) || 0;
                const step =
                  uniform.type === 'int' ? Math.max(1, uniform.step ?? 1) : (uniform.step ?? 0.01);
                return (
                  <ScrubInput
                    key={uniform.name}
                    label={uniform.name}
                    value={numVal}
                    min={uniform.min ?? 0}
                    max={uniform.max ?? 2}
                    step={step}
                    decimals={uniform.type === 'int' ? 0 : 2}
                    testId={`shader-uniform-${uniform.name}`}
                    onChange={(v) => handleUniformChange(uniform.name, v)}
                  />
                );
              }

              const arr = Array.isArray(rawVal) ? rawVal : [0, 0, 0, 0];
              const axes =
                uniform.type === 'vec2'
                  ? ['x', 'y']
                  : uniform.type === 'vec3'
                    ? ['x', 'y', 'z']
                    : ['x', 'y', 'z', 'w'];
              return (
                <div
                  key={uniform.name}
                  className="space-y-1 rounded border border-[#2A2A2E] bg-[#121214] p-2"
                >
                  <span className="block font-mono text-[11px] text-zinc-300">{uniform.name}</span>
                  <div className="grid grid-cols-2 gap-1.5">
                    {axes.map((axis, idx) => (
                      <ScrubInput
                        key={axis}
                        label={axis}
                        value={arr[idx] ?? 0}
                        min={-16}
                        max={16}
                        step={0.05}
                        decimals={2}
                        testId={`shader-uniform-${uniform.name}-${axis}`}
                        onChange={(v) => {
                          const nextArr = [...arr];
                          nextArr[idx] = v;
                          handleUniformChange(uniform.name, nextArr);
                        }}
                      />
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </aside>

      {/* Center Stage: Live WebGL2 Uniform Preview */}
      <section className="flex min-h-0 flex-col rounded border border-[#2A2A2E] bg-[#121214]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#2A2A2E] bg-[#1A1A1D] px-3 py-2">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="shader-pause-btn"
              onClick={() => onChangeConfig({ ...shaderConfig, paused: !shaderConfig.paused })}
              className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] bg-[#121214] px-2 py-1 text-xs text-zinc-200 hover:border-zinc-500"
            >
              {shaderConfig.paused ? (
                <Play className="h-3.5 w-3.5" />
              ) : (
                <Pause className="h-3.5 w-3.5" />
              )}
              {shaderConfig.paused ? 'Play TIME' : 'Pause'}
            </button>
            <button
              type="button"
              data-testid="shader-reset-time-btn"
              onClick={() => {
                elapsedTimeRef.current = 0;
              }}
              className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] bg-[#121214] px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              t=0
            </button>
            <div className="w-28">
              <ScrubInput
                label="Speed"
                value={shaderConfig.timeScale}
                min={0}
                max={4}
                step={0.1}
                unit="×"
                decimals={1}
                testId="shader-timescale"
                onChange={(v) => onChangeConfig({ ...shaderConfig, timeScale: v })}
              />
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            {(['checker', 'dark', 'light'] as const).map((bg) => (
              <button
                key={bg}
                type="button"
                onClick={() => setBackdrop(bg)}
                className={`rounded border px-2 py-0.5 text-[11px] capitalize ${
                  backdrop === bg
                    ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                    : 'border-[#2A2A2E] bg-[#121214] text-zinc-400'
                }`}
              >
                {bg}
              </button>
            ))}
            {[2, 4, 6].map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoomScale(z)}
                className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                  zoomScale === z
                    ? 'border-amber-400 bg-amber-500/15 text-amber-200'
                    : 'border-[#2A2A2E] bg-[#121214] text-zinc-400'
                }`}
              >
                {z}×
              </button>
            ))}
          </div>
        </div>

        <div
          className="relative flex flex-1 items-center justify-center overflow-auto p-6"
          style={backdropStyle}
        >
          {webglUnavailable ? (
            <div
              data-testid="shader-webgl-fallback"
              className="rounded border border-amber-500/40 bg-[#1A1A1D] p-4 text-xs text-amber-200"
            >
              WebGL2 context unavailable in this environment; shader validation & .tres/.gdshader
              export remain active.
            </div>
          ) : (
            <canvas
              ref={canvasRef}
              data-testid="shader-webgl-canvas"
              style={{
                width: `${sprite.width * zoomScale}px`,
                height: `${sprite.height * zoomScale}px`,
                imageRendering: project.artBible.artMode === 'pixel-art' ? 'pixelated' : 'auto',
              }}
              className="rounded border border-[#2A2A2E]/80 shadow-lg"
            />
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#2A2A2E] bg-[#1A1A1D] px-3 py-2">
          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              data-testid="shader-save-btn"
              disabled={isSaving}
              onClick={() => void handleSave()}
              className="inline-flex items-center gap-1.5 rounded border border-emerald-500/50 bg-emerald-500/15 px-3 py-1.5 font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {isSaving ? 'Saving…' : 'Save Shader to Node'}
            </button>
            <button
              type="button"
              data-testid="shader-promote-vault-btn"
              onClick={() => void handlePromoteShaderToVault()}
              className="inline-flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/15 px-2.5 py-1.5 font-medium text-amber-200 hover:bg-amber-500/25"
              title="Promote this .gdshader preset & uniforms to Global Asset Vault"
            >
              <Vault className="h-3.5 w-3.5" />
              Promote to Vault
            </button>
            <button
              type="button"
              data-testid="shader-share-link-btn"
              onClick={() =>
                openShareModal({
                  kind: 'shader',
                  name: shaderConfig.prompt.trim()
                    ? shaderConfig.prompt.trim().slice(0, 48)
                    : `${slug} (${shaderConfig.presetId})`,
                  shaderConfig,
                })
              }
              className="inline-flex items-center gap-1.5 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1.5 font-medium text-zinc-200 hover:border-zinc-500"
              title="Generate compressed #share=v1. URL link"
            >
              <Link2 className="h-3.5 w-3.5 text-amber-400" />
              Copy #share= Link
            </button>
            {statusNotice && (
              <span data-testid="shader-status-notice" className="text-[11px] text-zinc-300">
                {statusNotice}
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="shader-download-gdshader-btn"
              onClick={handleDownloadShaderFile}
              className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1 text-[11px] text-zinc-200 hover:border-zinc-500"
            >
              <Download className="h-3 w-3" />
              .gdshader
            </button>
            <button
              type="button"
              data-testid="shader-download-tres-btn"
              onClick={handleDownloadMatTres}
              className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1 text-[11px] text-zinc-200 hover:border-zinc-500"
            >
              <Download className="h-3 w-3" />
              _mat.tres
            </button>
            <button
              type="button"
              data-testid="shader-download-zip-btn"
              onClick={handleDownloadBundleZip}
              className="inline-flex items-center gap-1.5 rounded bg-zinc-100 px-3 py-1 text-[11px] font-semibold text-zinc-900 hover:bg-white"
            >
              <FileArchive className="h-3.5 w-3.5" />
              Download Shader Bundle (.zip)
            </button>
          </div>
        </div>
      </section>

      {/* Right Dock: Source Editor, .tres Preview & Diagnostics */}
      <aside className="flex min-h-0 flex-col rounded border border-[#2A2A2E] bg-[#1A1A1D]">
        <div className="flex items-center justify-between border-b border-[#2A2A2E] px-3 py-2">
          <div className="flex items-center gap-1">
            <button
              type="button"
              data-testid="shader-code-tab-gdshader"
              onClick={() => setCodeTab('gdshader')}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium ${
                codeTab === 'gdshader'
                  ? 'bg-[#2A2A2E] text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              .gdshader Source
            </button>
            <button
              type="button"
              data-testid="shader-code-tab-tres"
              onClick={() => setCodeTab('tres')}
              className={`rounded px-2.5 py-1 text-xs font-medium ${
                codeTab === 'tres'
                  ? 'bg-[#2A2A2E] text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              ShaderMaterial .tres
            </button>
          </div>

          <span className="inline-flex items-center gap-1 text-[11px]">
            {allErrors.length === 0 ? (
              <span
                data-testid="shader-compile-ok"
                className="inline-flex items-center gap-1 text-emerald-400"
              >
                <CheckCircle2 className="h-3.5 w-3.5" />
                Valid
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-rose-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {allErrors.length} error{allErrors.length > 1 ? 's' : ''}
              </span>
            )}
          </span>
        </div>

        {/* Inline Diagnostics Banner */}
        {(allErrors.length > 0 || transpiled.warnings.length > 0) && (
          <div
            data-testid="shader-diagnostics"
            className={`space-y-1 border-b px-3 py-2 text-[11px] ${
              allErrors.length > 0
                ? 'border-rose-500/40 bg-rose-950/35 text-rose-200'
                : 'border-amber-500/40 bg-amber-950/35 text-amber-200'
            }`}
          >
            {allErrors.map((err, i) => (
              <p key={`err-${i}`} className="font-mono">
                Error: {err}
              </p>
            ))}
            {transpiled.warnings.map((warn, i) => (
              <p key={`warn-${i}`} className="font-mono text-amber-200">
                Warning: {warn}
              </p>
            ))}
          </div>
        )}

        <div className="min-h-0 flex-1 p-2.5">
          {codeTab === 'gdshader' ? (
            <textarea
              data-testid="shader-code-editor"
              spellCheck={false}
              value={shaderConfig.gdshaderSource}
              onChange={(e) => handleSourceChange(e.target.value)}
              className="h-full min-h-[260px] w-full resize-none rounded border border-[#2A2A2E] bg-[#121214] p-2.5 font-mono text-[11px] leading-relaxed text-zinc-100 focus:border-amber-400 focus:outline-none"
            />
          ) : (
            <pre
              data-testid="shader-tres-preview"
              className="h-full min-h-[260px] overflow-auto rounded border border-[#2A2A2E] bg-[#121214] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words text-zinc-200"
            >
              {tresPreviewText}
            </pre>
          )}
        </div>
      </aside>
    </div>
  );
}
