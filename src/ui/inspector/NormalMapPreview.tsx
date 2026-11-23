import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lightbulb, SunMedium } from 'lucide-react';
import type { ArtMode, NormalMapConfig } from '../../domain/schemas';
import {
  bakeNormalMapCpu,
  computeBevelHeightmap,
  type BevelProfile,
} from '../../processing/distanceField';
import type { RgbaBuffer } from '../../processing/types';
import {
  NormalMapRenderer,
  type NormalViewMode,
  type PointLightParams,
} from '../../webgl/normalMapRenderer';

interface NormalMapPreviewProps {
  sprite: RgbaBuffer;
  artMode: ArtMode;
  normalConfig: NormalMapConfig;
  isSeamlessTile?: boolean;
  onChangeConfig: (updater: (prev: NormalMapConfig) => NormalMapConfig) => void;
  onNormalBufferBaked?: (normalBuf: RgbaBuffer) => void;
  exportSlot?: ReactNode;
}

export function NormalMapPreview({
  sprite,
  artMode,
  normalConfig,
  isSeamlessTile = false,
  onChangeConfig,
  onNormalBufferBaked,
  exportSlot,
}: NormalMapPreviewProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<NormalMapRenderer | null>(null);
  const orbRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number>(0);

  const [viewMode, setViewMode] = useState<NormalViewMode>('lit');
  const [lightZ, setLightZ] = useState(0.28);
  const [intensity, setIntensity] = useState(1.6);
  const [roughness, setRoughness] = useState(0.45);
  const [pinned, setPinned] = useState(false);
  const [usingCpuFallback, setUsingCpuFallback] = useState(false);
  const [isContextLost, setIsContextLost] = useState(false);
  const [restoreTick, setRestoreTick] = useState(0);
  const [webglError, setWebglError] = useState<string | null>(null);
  const lastBakedNormalRef = useRef<RgbaBuffer | null>(null);

  const pinnedRef = useRef(false);
  pinnedRef.current = pinned;
  const isContextLostRef = useRef(false);
  isContextLostRef.current = isContextLost;

  const lightRef = useRef<PointLightParams>({
    x: 0.3,
    y: 0.72,
    z: 0.28,
    color: [1.0, 0.96, 0.88],
    intensity: 1.6,
    roughness: 0.45,
    viewMode: 'lit',
    splitX: 0.5,
  });

  useEffect(() => {
    lightRef.current = {
      ...lightRef.current,
      z: lightZ,
      intensity,
      roughness,
      viewMode,
    };
    const renderer = rendererRef.current;
    if (renderer && !usingCpuFallback && !isContextLost && !renderer.isContextLost()) {
      renderer.renderPreview(lightRef.current, normalConfig.convention);
    }
  }, [
    lightZ,
    intensity,
    roughness,
    viewMode,
    normalConfig.convention,
    usingCpuFallback,
    isContextLost,
    restoreTick,
  ]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      e.stopPropagation();
      setLightZ((prev) =>
        Math.max(0.08, Math.min(0.8, Number((prev - e.deltaY * 0.0008).toFixed(2)))),
      );
    };
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => stage.removeEventListener('wheel', onWheel);
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        return;
      }
      const renderer = rendererRef.current;
      if (renderer && !isContextLostRef.current && !renderer.isContextLost()) {
        renderer.renderPreview(lightRef.current, normalConfig.convention);
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [normalConfig.convention]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const renderer = new NormalMapRenderer(canvas, {
        artMode,
        seamlessTile: isSeamlessTile,
        onContextLost: () => {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
          setIsContextLost(true);
          setWebglError('WebGL2 context lost; awaiting GPU restore…');
        },
        onContextRestored: () => {
          setIsContextLost(false);
          setWebglError(null);
          setRestoreTick((t) => t + 1);
        },
      });
      rendererRef.current = renderer;
      setUsingCpuFallback(false);
      setIsContextLost(renderer.isContextLost());
      setWebglError(null);

      return () => {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
        renderer.dispose();
        rendererRef.current = null;
      };
    } catch (error) {
      setUsingCpuFallback(true);
      setWebglError(
        error instanceof Error ? error.message : 'WebGL2 unavailable; using CPU fallback.',
      );
      return undefined;
    }
    // Initialize a single WebGL2 context per mount; artMode updates run through setArtMode().
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    rendererRef.current?.setArtMode(artMode);
    rendererRef.current?.setSeamlessTile(isSeamlessTile);
    if (rendererRef.current && !usingCpuFallback && !isContextLost) {
      rendererRef.current.renderPreview(lightRef.current, normalConfig.convention);
    }
  }, [artMode, isSeamlessTile, normalConfig.convention, usingCpuFallback, isContextLost]);

  // Re-bake normal map whenever sprite or bake params change (or after context restore)
  useEffect(() => {
    const renderer = rendererRef.current;
    const params = {
      bevelRadiusPx: normalConfig.bevelRadiusPx,
      bevelProfile: normalConfig.bevelProfile,
      bevelStrength: isSeamlessTile ? 0 : normalConfig.bevelStrength,
      detailStrength: normalConfig.detailStrength,
      convention: normalConfig.convention,
    };

    if (renderer && !usingCpuFallback) {
      renderer.setArtMode(artMode);
      renderer.setSeamlessTile(isSeamlessTile);
      renderer.setSprite(sprite);
      renderer.bakeNormalMap(params);
      if (!isContextLost && !renderer.isContextLost()) {
        renderer.renderPreview(lightRef.current, normalConfig.convention);
      }
      const baked = renderer.readNormalMapBuffer();
      lastBakedNormalRef.current = baked;
      onNormalBufferBaked?.(baked);
      return;
    }

    const normalBuf = bakeNormalMapCpu(sprite, {
      ...params,
      seamlessWrap: isSeamlessTile,
    });
    lastBakedNormalRef.current = normalBuf;
    onNormalBufferBaked?.(normalBuf);
  }, [
    sprite,
    artMode,
    isSeamlessTile,
    normalConfig.bevelRadiusPx,
    normalConfig.bevelProfile,
    normalConfig.bevelStrength,
    normalConfig.detailStrength,
    normalConfig.convention,
    usingCpuFallback,
    isContextLost,
    restoreTick,
    onNormalBufferBaked,
  ]);

  // CPU 2D Canvas preview draw when WebGL2 is unavailable at startup
  useEffect(() => {
    if (!usingCpuFallback) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const normalBuf =
      lastBakedNormalRef.current ??
      bakeNormalMapCpu(sprite, {
        bevelRadiusPx: normalConfig.bevelRadiusPx,
        bevelProfile: normalConfig.bevelProfile,
        bevelStrength: normalConfig.bevelStrength,
        detailStrength: normalConfig.detailStrength,
        convention: normalConfig.convention,
      });

    if (canvas.width !== sprite.width) canvas.width = sprite.width;
    if (canvas.height !== sprite.height) canvas.height = sprite.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    if (viewMode === 'height') {
      const bevel = computeBevelHeightmap(sprite, {
        bevelRadiusPx: normalConfig.bevelRadiusPx,
        profile: normalConfig.bevelProfile,
      });
      const out = new Uint8ClampedArray(sprite.width * sprite.height * 4);
      for (let i = 0; i < bevel.length; i++) {
        const v = bevel[i] ?? 0;
        out[i * 4] = v;
        out[i * 4 + 1] = v;
        out[i * 4 + 2] = v;
        out[i * 4 + 3] = sprite.data[i * 4 + 3] ?? 0;
      }
      ctx.putImageData(new ImageData(out, sprite.width, sprite.height), 0, 0);
    } else {
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(normalBuf.data), sprite.width, sprite.height),
        0,
        0,
      );
    }
  }, [
    usingCpuFallback,
    sprite,
    normalConfig.bevelRadiusPx,
    normalConfig.bevelProfile,
    normalConfig.bevelStrength,
    normalConfig.detailStrength,
    normalConfig.convention,
    viewMode,
  ]);

  const updateLightPosition = (clientX: number, clientY: number) => {
    const rectEl = canvasRef.current ?? stageRef.current;
    if (!rectEl) return;
    const rect = rectEl.getBoundingClientRect();
    const nx = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const nyTopDown = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    const nyWebGL = 1 - nyTopDown;

    lightRef.current = {
      ...lightRef.current,
      x: nx,
      y: nyWebGL,
      splitX: viewMode === 'split' ? nx : lightRef.current.splitX,
    };

    if (orbRef.current) {
      orbRef.current.style.left = `${nx * 100}%`;
      orbRef.current.style.top = `${nyTopDown * 100}%`;
    }

    if (isContextLostRef.current) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      const renderer = rendererRef.current;
      if (renderer && !isContextLostRef.current && !renderer.isContextLost()) {
        renderer.renderPreview(lightRef.current, normalConfig.convention);
      }
    });
  };

  return (
    <div
      data-testid="normal-map-preview-panel"
      className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]"
    >
      {/* Left Stage: Interactive WebGL2 Blinn-Phong Point Light */}
      <section className="flex min-w-0 flex-col bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
          <div className="flex items-center gap-1.5 text-xs">
            {(
              [
                ['lit', 'Lit'],
                ['normal', 'Normal Map'],
                ['height', 'Bevel Height'],
                ['split', 'Split Lit | Normal'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                data-testid={`normal-view-${key}`}
                onClick={() => setViewMode(key)}
                className={`rounded border px-2.5 py-1 text-xs ${
                  viewMode === key
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-400">
            Move cursor to relight · Click to {pinned ? 'unpin' : 'pin'} · Alt+Wheel for Z height
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center overflow-auto bg-checkerboard p-8">
          <div
            ref={stageRef}
            data-testid="normal-light-stage"
            onPointerMove={(e) => {
              if (pinnedRef.current) return;
              updateLightPosition(e.clientX, e.clientY);
            }}
            onClick={(e) => {
              const nextPinned = !pinnedRef.current;
              setPinned(nextPinned);
              if (nextPinned) {
                updateLightPosition(e.clientX, e.clientY);
              }
            }}
            className="relative max-h-[440px] max-w-[440px] cursor-crosshair overflow-hidden rounded-lg border border-slate-700 bg-slate-950/90 shadow-2xl select-none"
            style={{
              aspectRatio: `${sprite.width} / ${sprite.height}`,
              width: sprite.width >= sprite.height ? 'min(100%, 440px)' : 'auto',
              height: sprite.height > sprite.width ? '440px' : 'auto',
            }}
          >
            <canvas
              ref={canvasRef}
              data-testid="normal-preview-canvas"
              className="block h-full w-full"
              style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
            />
            {viewMode === 'lit' && !usingCpuFallback && !isContextLost && (
              <div
                ref={orbRef}
                className={`pointer-events-none absolute h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border shadow-[0_0_16px_rgba(251,191,36,0.9)] ${
                  pinned ? 'border-rose-200 bg-rose-400/90' : 'border-amber-200 bg-amber-300/80'
                }`}
                style={{ left: '30%', top: '28%' }}
              />
            )}
          </div>
        </div>
        {webglError && (
          <div
            data-testid="normal-context-status"
            className="border-t border-amber-500/30 bg-amber-950/40 px-4 py-1.5 text-[11px] text-amber-200"
          >
            {webglError}
          </div>
        )}
      </section>

      {/* Right Pane: Normal Bake & Point-Light Parameters */}
      <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <SunMedium className="h-3.5 w-3.5 text-amber-400" />
            <span>Bevel &amp; Sobel Normal Bake</span>
          </div>

          {isSeamlessTile && (
            <div
              data-testid="normal-seamless-badge"
              className="rounded border border-emerald-500/40 bg-emerald-950/30 px-2.5 py-1.5 text-[11px] text-emerald-200"
            >
              Toroidal <code>gl.REPEAT</code> Active · Bevel Weight = 0 for Seamless Borders
            </div>
          )}

          <div className="space-y-1 text-xs">
            <span className="text-slate-400">Engine Y Convention</span>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                data-testid="normal-convention-opengl"
                onClick={() => onChangeConfig((prev) => ({ ...prev, convention: 'opengl' }))}
                className={`rounded border px-2 py-1.5 text-[11px] font-medium ${
                  normalConfig.convention === 'opengl'
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                Godot / OpenGL (+Y)
              </button>
              <button
                type="button"
                data-testid="normal-convention-directx"
                onClick={() => onChangeConfig((prev) => ({ ...prev, convention: 'directx' }))}
                className={`rounded border px-2 py-1.5 text-[11px] font-medium ${
                  normalConfig.convention === 'directx'
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                DirectX (-Y)
              </button>
            </div>
          </div>

          <label className="block space-y-1 text-xs">
            <span className="text-slate-400">Bevel Profile</span>
            <select
              data-testid="normal-bevel-profile"
              value={normalConfig.bevelProfile}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  bevelProfile: e.target.value as Exclude<BevelProfile, 'dome' | 'smooth'>,
                }))
              }
              className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
            >
              <option value="spherical-dome">Spherical Dome</option>
              <option value="smoothstep">Smoothstep</option>
              <option value="linear">Linear Chamfer</option>
            </select>
          </label>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Bevel Radius (EDT px)</span>
              <span className="font-mono">{normalConfig.bevelRadiusPx} px</span>
            </div>
            <input
              type="range"
              data-testid="normal-bevel-radius"
              min={2}
              max={48}
              value={normalConfig.bevelRadiusPx}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  bevelRadiusPx: Number.parseInt(e.target.value, 10),
                }))
              }
              className="w-full accent-indigo-500"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Bevel Weight</span>
              <span className="font-mono">{normalConfig.bevelStrength.toFixed(1)}</span>
            </div>
            <input
              type="range"
              data-testid="normal-bevel-strength"
              min={0}
              max={8}
              step={0.2}
              value={normalConfig.bevelStrength}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  bevelStrength: Number.parseFloat(e.target.value),
                }))
              }
              className="w-full accent-indigo-500"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Surface Detail Weight</span>
              <span className="font-mono">{normalConfig.detailStrength.toFixed(1)}</span>
            </div>
            <input
              type="range"
              data-testid="normal-detail-strength"
              min={0}
              max={8}
              step={0.2}
              value={normalConfig.detailStrength}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  detailStrength: Number.parseFloat(e.target.value),
                }))
              }
              className="w-full accent-indigo-500"
            />
          </label>
        </div>

        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
          <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
            <Lightbulb className="h-3.5 w-3.5 text-amber-300" />
            <span>Preview Point Light</span>
          </div>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Light Height (Z)</span>
              <span data-testid="normal-light-z-readout" className="font-mono">
                {lightZ.toFixed(2)}
              </span>
            </div>
            <input
              type="range"
              data-testid="normal-light-z"
              min={0.08}
              max={0.8}
              step={0.02}
              value={lightZ}
              onChange={(e) => setLightZ(Number.parseFloat(e.target.value))}
              className="w-full accent-amber-500"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Intensity</span>
              <span className="font-mono">{intensity.toFixed(1)}</span>
            </div>
            <input
              type="range"
              min={0.2}
              max={3.0}
              step={0.1}
              value={intensity}
              onChange={(e) => setIntensity(Number.parseFloat(e.target.value))}
              className="w-full accent-amber-500"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Roughness</span>
              <span className="font-mono">{roughness.toFixed(2)}</span>
            </div>
            <input
              type="range"
              min={0.05}
              max={1.0}
              step={0.05}
              value={roughness}
              onChange={(e) => setRoughness(Number.parseFloat(e.target.value))}
              className="w-full accent-amber-500"
            />
          </label>
        </div>

        <label className="flex items-center gap-2 rounded-lg border border-emerald-500/35 bg-emerald-950/20 px-3 py-2.5 text-xs font-medium text-emerald-200">
          <input
            type="checkbox"
            data-testid="normal-include-export-toggle"
            checked={normalConfig.enabled}
            onChange={(e) => onChangeConfig((prev) => ({ ...prev, enabled: e.target.checked }))}
            className="accent-emerald-500"
          />
          Bundle `_n.png` Normal Map in ZIP / Folder Export
        </label>

        {exportSlot}
      </aside>
    </div>
  );
}
