import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Check, Lightbulb, Sparkles, Sun, X } from 'lucide-react';
import { repository } from '../../db/database';
import type { ArtMode, SpriteNode } from '../../domain/schemas';
import { extractLightOccluderVertices } from '../../export/godotLightingExporter';
import {
  bakeEmissionMaskFromRgba,
  bakeNormalMapFromRgba,
  createDefaultEmissionBakeConfig,
  createDefaultNormalBakeConfig,
  type EmissionBakeConfig,
  type EmissionBakeMode,
  type NormalBakeConfig,
  type NormalBakeHeightSource,
} from '../../processing/normalEmissionBaker';
import { rgbaToPngBlob } from '../../processing/png';
import type { RgbaBuffer } from '../../processing/types';
import { ScrubInput } from '../primitives/ScrubInput';

export type LightingChannel = 'lit' | 'diffuse' | 'normal' | 'emission' | 'occluder';

export interface LightingBakerPanelProps {
  readonly sprite: RgbaBuffer;
  readonly spriteNode: SpriteNode;
  readonly artMode: ArtMode;
  readonly paletteHex: readonly string[];
  readonly slug: string;
  readonly onBaked?: (updatedNode: SpriteNode) => void;
  readonly onClose?: () => void;
}

const VS_SOURCE = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FS_SOURCE = `#version 300 es
precision mediump float;
uniform sampler2D u_diffuse;
uniform sampler2D u_normal;
uniform sampler2D u_emission;
uniform vec3 u_lightPos;
uniform vec3 u_lightColor;
uniform float u_ambient;
uniform float u_emissiveGlow;
uniform int u_channel;
in vec2 v_uv;
out vec4 outColor;
void main() {
  vec4 diff = texture(u_diffuse, v_uv);
  vec4 normTex = texture(u_normal, v_uv);
  vec4 emiss = texture(u_emission, v_uv);
  if (u_channel == 1) {
    outColor = diff;
    return;
  }
  if (u_channel == 2) {
    outColor = normTex;
    return;
  }
  if (u_channel == 3) {
    outColor = emiss;
    return;
  }
  if (diff.a <= 0.01) {
    outColor = vec4(0.0);
    return;
  }
  vec3 N = normalize(normTex.xyz * 2.0 - 1.0);
  vec3 delta = u_lightPos - vec3(v_uv, 0.0);
  float dist = length(delta.xy);
  float atten = 1.0 / (1.0 + 3.2 * dist * dist);
  vec3 L = normalize(delta);
  float ndotl = max(dot(N, L), 0.0);
  vec3 lit = diff.rgb * (u_ambient + u_lightColor * ndotl * atten * 1.45);
  lit += emiss.rgb * emiss.a * u_emissiveGlow;
  outColor = vec4(clamp(lit, 0.0, 1.0), diff.a);
}`;

function parseHexToUnitRgb(hex: string): readonly [number, number, number] {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return [1, 0.94, 0.78];
  return [
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255,
  ];
}

function renderCpuFallbackToCanvas(
  canvas: HTMLCanvasElement,
  sprite: RgbaBuffer,
  normalRgba: Uint8ClampedArray,
  emissionRgba: Uint8ClampedArray,
  channel: LightingChannel,
  light: {
    x: number;
    y: number;
    z: number;
    color: readonly [number, number, number];
    ambient: number;
  },
): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height, data } = sprite;
  canvas.width = width;
  canvas.height = height;

  if (channel === 'diffuse' || channel === 'occluder') {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(data), width, height), 0, 0);
    return;
  }
  if (channel === 'normal') {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(normalRgba), width, height), 0, 0);
    return;
  }
  if (channel === 'emission') {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(emissionRgba), width, height), 0, 0);
    return;
  }

  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const v = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const u = (x + 0.5) / width;
      const idx = (y * width + x) * 4;
      const a = data[idx + 3] ?? 0;
      if (a === 0) continue;

      const nx = ((normalRgba[idx] ?? 128) - 128) / 127;
      const ny = ((normalRgba[idx + 1] ?? 128) - 128) / 127;
      const nz = ((normalRgba[idx + 2] ?? 255) - 128) / 127;
      const dx = light.x - u;
      const dy = 1 - light.y - (1 - v);
      const dz = light.z;
      const distSq = dx * dx + dy * dy;
      const len = Math.hypot(dx, dy, dz) || 1;
      const ndotl = Math.max(0, (nx * dx + ny * dy + nz * dz) / len);
      const atten = 1 / (1 + 3.2 * distSq);
      const gain = light.ambient + ndotl * atten * 1.45;
      const ea = (emissionRgba[idx + 3] ?? 0) / 255;

      out[idx] = Math.min(
        255,
        Math.round((data[idx] ?? 0) * gain * light.color[0] + (emissionRgba[idx] ?? 0) * ea * 1.4),
      );
      out[idx + 1] = Math.min(
        255,
        Math.round(
          (data[idx + 1] ?? 0) * gain * light.color[1] + (emissionRgba[idx + 1] ?? 0) * ea * 1.4,
        ),
      );
      out[idx + 2] = Math.min(
        255,
        Math.round(
          (data[idx + 2] ?? 0) * gain * light.color[2] + (emissionRgba[idx + 2] ?? 0) * ea * 1.4,
        ),
      );
      out[idx + 3] = a;
    }
  }
  ctx.putImageData(new ImageData(out, width, height), 0, 0);
}

interface WebGlResources {
  readonly gl: WebGL2RenderingContext;
  readonly program: WebGLProgram;
  readonly vs: WebGLShader;
  readonly fs: WebGLShader;
  readonly buffer: WebGLBuffer;
  readonly texDiffuse: WebGLTexture;
  readonly texNormal: WebGLTexture;
  readonly texEmission: WebGLTexture;
}

function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  data: Uint8ClampedArray,
  pixelArt: boolean,
): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const filter = pixelArt ? gl.NEAREST : gl.LINEAR;
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return tex;
}

function disposeGlResources(res: WebGlResources | null): void {
  if (!res) return;
  const { gl } = res;
  gl.deleteTexture(res.texDiffuse);
  gl.deleteTexture(res.texNormal);
  gl.deleteTexture(res.texEmission);
  gl.deleteBuffer(res.buffer);
  gl.deleteProgram(res.program);
  gl.deleteShader(res.vs);
  gl.deleteShader(res.fs);
}

export function LightingBakerPanel({
  sprite,
  spriteNode,
  artMode,
  paletteHex,
  slug,
  onBaked,
  onClose,
}: LightingBakerPanelProps) {
  const isPixelArt = artMode === 'pixel-art';
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const glResRef = useRef<WebGlResources | null>(null);
  const draggingRef = useRef(false);

  const [channel, setChannel] = useState<LightingChannel>('lit');
  const [normalConfig, setNormalConfig] = useState<NormalBakeConfig>(
    () => spriteNode.lightingBake?.normalConfig ?? createDefaultNormalBakeConfig(),
  );
  const [emissionConfig, setEmissionConfig] = useState<EmissionBakeConfig>(
    () => spriteNode.lightingBake?.emissionConfig ?? createDefaultEmissionBakeConfig(),
  );
  const [lightX, setLightX] = useState(0.32);
  const [lightY, setLightY] = useState(0.28);
  const [lightZ, setLightZ] = useState(0.32);
  const [lightColorHex, setLightColorHex] = useState('#FFF1C7');
  const [ambient, setAmbient] = useState(0.28);
  const [persistedBake, setPersistedBake] = useState(() => spriteNode.lightingBake ?? null);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [usingCpuFallback, setUsingCpuFallback] = useState(false);

  useEffect(() => {
    setPersistedBake(spriteNode.lightingBake ?? null);
  }, [spriteNode]);

  const normalRgba = useMemo(
    () => bakeNormalMapFromRgba(sprite.data, sprite.width, sprite.height, normalConfig),
    [sprite, normalConfig],
  );

  const emissionResult = useMemo(
    () => bakeEmissionMaskFromRgba(sprite.data, sprite.width, sprite.height, emissionConfig),
    [sprite, emissionConfig],
  );

  const occluderVertices = useMemo(
    () =>
      extractLightOccluderVertices({
        rgba: sprite.data,
        width: sprite.width,
        height: sprite.height,
        epsilon: 1.5,
        pivotPx: { x: 0, y: 0 },
      }),
    [sprite],
  );

  // Initialize / dispose WebGL2 resources once per canvas mount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || channel === 'occluder') {
      disposeGlResources(glResRef.current);
      glResRef.current = null;
      return;
    }

    const gl = canvas.getContext('webgl2', {
      premultipliedAlpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      setUsingCpuFallback(true);
      return;
    }

    const compile = (type: number, source: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, source);
      gl.compileShader(sh);
      return sh;
    };

    const vs = compile(gl.VERTEX_SHADER, VS_SOURCE);
    const fs = compile(gl.FRAGMENT_SHADER, FS_SOURCE);
    const program = gl.createProgram()!;
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      setUsingCpuFallback(true);
      return;
    }

    const buffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 0, 0, 1, -1, 1, 0, -1, 1, 0, 1, 1, 1, 1, 1]),
      gl.STATIC_DRAW,
    );

    const empty = new Uint8ClampedArray(sprite.width * sprite.height * 4);
    const texDiffuse = createTexture(gl, sprite.width, sprite.height, sprite.data, isPixelArt);
    const texNormal = createTexture(gl, sprite.width, sprite.height, empty, isPixelArt);
    const texEmission = createTexture(gl, sprite.width, sprite.height, empty, isPixelArt);

    glResRef.current = {
      gl,
      program,
      vs,
      fs,
      buffer,
      texDiffuse,
      texNormal,
      texEmission,
    };
    setUsingCpuFallback(false);

    return () => {
      disposeGlResources(glResRef.current);
      glResRef.current = null;
    };
  }, [sprite, isPixelArt, channel]);

  // Draw frame whenever light, channel, or baked maps change
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = sprite.width;
    canvas.height = sprite.height;

    const lightRgb = parseHexToUnitRgb(lightColorHex);
    const res = glResRef.current;
    if (!res || usingCpuFallback || channel === 'occluder') {
      renderCpuFallbackToCanvas(canvas, sprite, normalRgba, emissionResult.rgba, channel, {
        x: lightX,
        y: lightY,
        z: lightZ,
        color: lightRgb,
        ambient,
      });
      return;
    }

    const { gl, program, buffer, texDiffuse, texNormal, texEmission } = res;
    const filter = isPixelArt ? gl.NEAREST : gl.LINEAR;

    const upload = (tex: WebGLTexture, unit: number, pixels: Uint8ClampedArray) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA,
        sprite.width,
        sprite.height,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    };

    upload(texDiffuse, 0, sprite.data);
    upload(texNormal, 1, normalRgba);
    upload(texEmission, 2, emissionResult.rgba);

    gl.viewport(0, 0, sprite.width, sprite.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const aPos = gl.getAttribLocation(program, 'a_pos');
    const aUv = gl.getAttribLocation(program, 'a_uv');
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);

    gl.uniform1i(gl.getUniformLocation(program, 'u_diffuse'), 0);
    gl.uniform1i(gl.getUniformLocation(program, 'u_normal'), 1);
    gl.uniform1i(gl.getUniformLocation(program, 'u_emission'), 2);
    gl.uniform3f(gl.getUniformLocation(program, 'u_lightPos'), lightX, 1 - lightY, lightZ);
    gl.uniform3f(
      gl.getUniformLocation(program, 'u_lightColor'),
      lightRgb[0],
      lightRgb[1],
      lightRgb[2],
    );
    gl.uniform1f(gl.getUniformLocation(program, 'u_ambient'), ambient);
    gl.uniform1f(gl.getUniformLocation(program, 'u_emissiveGlow'), 1.35);

    const channelIndex =
      channel === 'diffuse' ? 1 : channel === 'normal' ? 2 : channel === 'emission' ? 3 : 0;
    gl.uniform1i(gl.getUniformLocation(program, 'u_channel'), channelIndex);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }, [
    sprite,
    normalRgba,
    emissionResult,
    channel,
    lightX,
    lightY,
    lightZ,
    lightColorHex,
    ambient,
    isPixelArt,
    usingCpuFallback,
  ]);

  const updateLightFromClient = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / rect.width));
    const ny = Math.max(0.02, Math.min(0.98, (clientY - rect.top) / rect.height));
    setLightX(Number(nx.toFixed(3)));
    setLightY(Number(ny.toFixed(3)));
  }, []);

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = true;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    updateLightFromClient(e.clientX, e.clientY);
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    updateLightFromClient(e.clientX, e.clientY);
  };

  const handleStagePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    draggingRef.current = false;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const toggleEmissiveHex = (hex: string) => {
    const upper = hex.toUpperCase();
    setEmissionConfig((prev) => {
      const exists = prev.emissiveHexColors.some((c) => c.toUpperCase() === upper);
      return {
        ...prev,
        emissiveHexColors: exists
          ? prev.emissiveHexColors.filter((c) => c.toUpperCase() !== upper)
          : [...prev.emissiveHexColors, upper],
      };
    });
  };

  const handleBakeAndAttach = async () => {
    setSaving(true);
    setStatusMessage(null);
    try {
      const normalBlob = await rgbaToPngBlob(normalRgba, sprite.width, sprite.height);
      const emissionBlob =
        emissionResult.emissivePixelCount > 0
          ? await rgbaToPngBlob(emissionResult.rgba, sprite.width, sprite.height)
          : null;

      const updated = await repository.commitSpriteLightingBake(spriteNode.id, {
        normalPngBlob: normalBlob,
        emissionPngBlob: emissionBlob,
        normalConfig,
        emissionConfig,
        emissivePixelCount: emissionResult.emissivePixelCount,
        occluderVertexCount: occluderVertices.length,
      });

      setPersistedBake(updated.lightingBake ?? null);
      setStatusMessage(
        `Saved ${slug}_n.png${emissionBlob ? `, ${slug}_e.png` : ''}, and ${slug}_canvas.tres metadata (${occluderVertices.length} occluder vertices).`,
      );
      onBaked?.(updated);
    } catch (err) {
      setStatusMessage(
        err instanceof Error ? err.message : 'Failed to persist baked lighting maps.',
      );
    } finally {
      setSaving(false);
    }
  };

  const channels: readonly { id: LightingChannel; label: string }[] = [
    { id: 'lit', label: 'Lit Preview' },
    { id: 'diffuse', label: 'Diffuse' },
    { id: 'normal', label: 'Normal Map (_n)' },
    { id: 'emission', label: 'Emission (_e)' },
    { id: 'occluder', label: 'Occluder Hull' },
  ];

  return (
    <div
      data-testid="lighting-baker-panel"
      className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] text-slate-100 shadow-2xl"
    >
      <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Sun className="h-4 w-4 text-[#F5B82E]" />
          <div>
            <h2 className="text-sm font-semibold">
              2D Normal &amp; Emission Baker —{' '}
              <span className="font-mono text-[#F5B82E]">{slug}</span>
            </h2>
            <p className="text-[11px] text-slate-400">
              Pure-TS Sobel tangent normals + emission mask + Godot 4 CanvasTexture &amp;
              LightOccluder2D
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {persistedBake && (
            <span
              data-testid="lighting-persisted-badge"
              className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[11px] font-medium text-emerald-200"
            >
              <Check className="h-3 w-3" />
              Lighting Baked
            </span>
          )}
          {onClose && (
            <button
              type="button"
              data-testid="lighting-baker-close-btn"
              onClick={onClose}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              aria-label="Close Lighting Baker"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto md:grid-cols-[1.15fr_1fr]">
        {/* Left: Stage + Channel Switcher */}
        <div className="flex flex-col gap-3 border-b border-[var(--border-hairline)] p-4 md:border-r md:border-b-0">
          <div className="flex flex-wrap gap-1.5">
            {channels.map((ch) => (
              <button
                key={ch.id}
                type="button"
                data-testid={`lighting-channel-${ch.id}`}
                onClick={() => setChannel(ch.id)}
                className={`rounded px-2.5 py-1 text-[11px] font-medium transition-colors ${
                  channel === ch.id
                    ? 'bg-[#F5B82E] text-slate-950'
                    : 'border border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:bg-slate-800'
                }`}
              >
                {ch.label}
              </button>
            ))}
          </div>

          <div
            ref={stageRef}
            data-testid="lighting-baker-stage"
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            className="bg-checkerboard relative flex aspect-square w-full max-w-[380px] cursor-crosshair select-none items-center justify-center self-center overflow-hidden rounded-lg border border-[var(--border-hairline)]"
          >
            <canvas
              ref={canvasRef}
              data-testid="lighting-baker-canvas"
              className="h-full w-full object-contain"
              style={{ imageRendering: isPixelArt ? 'pixelated' : 'auto' }}
            />

            {channel === 'occluder' && (
              <svg
                viewBox={`0 0 ${sprite.width} ${sprite.height}`}
                className="pointer-events-none absolute inset-0 h-full w-full"
                preserveAspectRatio="none"
              >
                <polygon
                  points={occluderVertices.map((v) => `${v.x},${v.y}`).join(' ')}
                  fill="rgba(245, 184, 46, 0.22)"
                  stroke="#F5B82E"
                  strokeWidth={Math.max(0.5, sprite.width / 64)}
                />
              </svg>
            )}

            <div
              data-testid="lighting-point-handle"
              style={{ left: `${lightX * 100}%`, top: `${lightY * 100}%` }}
              className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-amber-300 bg-amber-300/35 p-1.5 shadow-lg"
              title="Drag to move PointLight2D"
            >
              <Lightbulb className="h-3.5 w-3.5 text-amber-200" />
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
            <span>
              Light UV: ({lightX.toFixed(2)}, {lightY.toFixed(2)}, Z {lightZ.toFixed(2)})
            </span>
            <span>
              Emissive px: {emissionResult.emissivePixelCount} · Occluder verts:{' '}
              {occluderVertices.length}
            </span>
          </div>
        </div>

        {/* Right: Parameters & Bake CTA */}
        <div className="flex flex-col gap-3 p-4 text-xs">
          <div className="grid grid-cols-2 gap-3">
            <ScrubInput
              label="Normal Strength"
              testId="lighting-strength-input"
              value={normalConfig.strength}
              min={0.1}
              max={5.0}
              step={0.1}
              onChange={(val) => setNormalConfig((p) => ({ ...p, strength: val }))}
            />
            <ScrubInput
              label="Bevel Radius (px)"
              testId="lighting-bevel-input"
              value={normalConfig.bevelRadiusPx}
              min={0}
              max={4}
              step={1}
              onChange={(val) => setNormalConfig((p) => ({ ...p, bevelRadiusPx: Math.round(val) }))}
            />
            <ScrubInput
              label="Light Z-Height"
              testId="lighting-z-input"
              value={lightZ}
              min={0.05}
              max={1.5}
              step={0.05}
              onChange={setLightZ}
            />
            <ScrubInput
              label="Ambient Dimming"
              testId="lighting-ambient-input"
              value={ambient}
              min={0}
              max={1}
              step={0.05}
              onChange={setAmbient}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-slate-400">Height Source</span>
              <select
                data-testid="lighting-height-source"
                value={normalConfig.heightSource}
                onChange={(e) =>
                  setNormalConfig((p) => ({
                    ...p,
                    heightSource: e.target.value as NormalBakeHeightSource,
                  }))
                }
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1.5 text-xs text-slate-200"
              >
                <option value="hybrid">Hybrid (Bevel + Luma)</option>
                <option value="alpha-bevel">Alpha Bevel Only</option>
                <option value="luminance">Luminance Only</option>
              </select>
            </label>

            <label className="flex flex-col gap-1">
              <span className="text-[11px] text-slate-400">Light Color</span>
              <input
                type="color"
                data-testid="lighting-color-input"
                value={lightColorHex}
                onChange={(e) => setLightColorHex(e.target.value)}
                className="h-8 w-full cursor-pointer rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1"
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-4">
            <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={normalConfig.invertY}
                onChange={(e) => setNormalConfig((p) => ({ ...p, invertY: e.target.checked }))}
              />
              Invert Y (DirectX -Y)
            </label>
            <label className="inline-flex items-center gap-1.5 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={normalConfig.sharpenPixelArt}
                onChange={(e) =>
                  setNormalConfig((p) => ({ ...p, sharpenPixelArt: e.target.checked }))
                }
              />
              Sharpen Pixel Art
            </label>
          </div>

          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-200">
                <Sparkles className="h-3.5 w-3.5 text-[#F5B82E]" />
                Emission Mask (`_e.png`)
              </span>
              <select
                data-testid="lighting-emission-mode"
                value={emissionConfig.mode}
                onChange={(e) =>
                  setEmissionConfig((p) => ({ ...p, mode: e.target.value as EmissionBakeMode }))
                }
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200"
              >
                <option value="palette-swatches">ArtBible Swatches</option>
                <option value="luminance-threshold">Luminance Threshold</option>
              </select>
            </div>

            {emissionConfig.mode === 'palette-swatches' ? (
              <div className="flex flex-wrap gap-1.5">
                {paletteHex.map((hex) => {
                  const selected = emissionConfig.emissiveHexColors.some(
                    (c) => c.toUpperCase() === hex.toUpperCase(),
                  );
                  return (
                    <button
                      key={hex}
                      type="button"
                      data-testid={`lighting-swatch-${hex.replace('#', '')}`}
                      onClick={() => toggleEmissiveHex(hex)}
                      className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 font-mono text-[10px] ${
                        selected
                          ? 'border-[#F5B82E] bg-[#F5B82E]/20 text-amber-200'
                          : 'border-[var(--border-hairline)] bg-[var(--bg-panel)] text-slate-400'
                      }`}
                    >
                      <span
                        className="h-2.5 w-2.5 rounded-xs border border-white/20"
                        style={{ backgroundColor: hex }}
                      />
                      {hex}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <ScrubInput
                  label="Min Luminance"
                  testId="lighting-min-lum"
                  value={emissionConfig.minLuminance}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(val) => setEmissionConfig((p) => ({ ...p, minLuminance: val }))}
                />
                <ScrubInput
                  label="Min Saturation"
                  testId="lighting-min-sat"
                  value={emissionConfig.minSaturation}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(val) => setEmissionConfig((p) => ({ ...p, minSaturation: val }))}
                />
              </div>
            )}
          </div>

          {statusMessage && (
            <div
              data-testid="lighting-bake-status"
              className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-[11px] text-emerald-200"
            >
              {statusMessage}
            </div>
          )}

          <div className="mt-auto flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              data-testid="lighting-bake-attach-btn"
              disabled={saving}
              onClick={() => void handleBakeAndAttach()}
              className="inline-flex items-center gap-1.5 rounded bg-[#F5B82E] px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              {saving ? 'Baking...' : 'Bake & Attach to Asset'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
