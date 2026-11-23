import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import { Download, Pause, Play, Sparkles, Trash2 } from 'lucide-react';
import type {
  AnimPresetOption,
  ArtMode,
  MlsModeOption,
  PinRoleOption,
  PuppetAnimConfig,
  PuppetPinConfig,
} from '../../domain/schemas';
import { ANIM_PRESETS, generatePresetKeyframes } from '../../processing/animPresets';
import { solveMlsMesh, type Vec2 } from '../../processing/mlsWarp';
import { buildAlphaClippedMesh, rasterizeDeformedMeshCpu } from '../../processing/spriteMesh';
import type { RgbaBuffer } from '../../processing/types';
import { PuppetRenderer } from '../../webgl/puppetRenderer';

interface PuppetWarpEditorProps {
  sprite: RgbaBuffer;
  artMode: ArtMode;
  puppetConfig: PuppetAnimConfig;
  onChangeConfig: (updater: (prev: PuppetAnimConfig) => PuppetAnimConfig) => void;
  onExportStripZip: () => void;
  exportSlot?: ReactNode;
}

const ROLE_ORDER: readonly PinRoleOption[] = ['anchor', 'driver', 'tip'];

const ROLE_STYLE: Record<PinRoleOption, { bg: string; label: string }> = {
  anchor: { bg: 'border-sky-200 bg-sky-500', label: 'Anchor' },
  driver: { bg: 'border-amber-200 bg-amber-500', label: 'Driver' },
  tip: { bg: 'border-cyan-100 bg-cyan-400', label: 'Tip' },
};

export function PuppetWarpEditor({
  sprite,
  artMode,
  puppetConfig,
  onChangeConfig,
  onExportStripZip,
  exportSlot,
}: PuppetWarpEditorProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<PuppetRenderer | null>(null);

  const [placementRole, setPlacementRole] = useState<PinRoleOption>('anchor');
  const [onionSkin, setOnionSkin] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [frameIdx, setFrameIdx] = useState(0);
  const [draggedPins, setDraggedPins] = useState<Vec2[] | null>(null);
  const [usingCpuFallback, setUsingCpuFallback] = useState(false);

  const dragPinIndexRef = useRef<number | null>(null);

  const mesh = useMemo(() => buildAlphaClippedMesh(sprite, { artMode }), [sprite, artMode]);

  const keyframes = useMemo(
    () =>
      generatePresetKeyframes(
        puppetConfig.pins,
        puppetConfig.preset,
        puppetConfig.frameCount,
        puppetConfig.amplitudePx,
      ),
    [puppetConfig.pins, puppetConfig.preset, puppetConfig.frameCount, puppetConfig.amplitudePx],
  );

  const playbackIndices = useMemo(() => {
    const n = keyframes.length;
    if (n <= 1 || !puppetConfig.pingPong) {
      return Array.from({ length: n }, (_, i) => i);
    }
    const seq: number[] = [];
    for (let i = 0; i < n; i++) seq.push(i);
    for (let i = n - 2; i >= 1; i--) seq.push(i);
    return seq;
  }, [keyframes.length, puppetConfig.pingPong]);

  // Playback timer loop
  useEffect(() => {
    if (!isPlaying || puppetConfig.pins.length === 0 || draggedPins !== null) {
      return;
    }
    const intervalMs = Math.max(30, Math.round(1000 / Math.max(1, puppetConfig.fps)));
    const id = window.setInterval(() => {
      setFrameIdx((prev) => (prev + 1) % Math.max(1, playbackIndices.length));
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [isPlaying, puppetConfig.fps, puppetConfig.pins.length, playbackIndices.length, draggedPins]);

  // Initialize disposable WebGL2 renderer once
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    try {
      const renderer = new PuppetRenderer(canvas);
      rendererRef.current = renderer;
      setUsingCpuFallback(false);
      const onLost = (e: Event) => {
        e.preventDefault();
        setUsingCpuFallback(true);
      };
      canvas.addEventListener('webglcontextlost', onLost);
      return () => {
        canvas.removeEventListener('webglcontextlost', onLost);
        renderer.dispose();
        rendererRef.current = null;
      };
    } catch {
      setUsingCpuFallback(true);
      return undefined;
    }
  }, []);

  // Upload assets whenever sprite, mesh, artMode, or padding changes
  useEffect(() => {
    const renderer = rendererRef.current;
    if (!renderer || usingCpuFallback) return;
    renderer.setAssets(sprite, mesh, {
      artMode,
      paddingPx: puppetConfig.paddingPx,
    });
  }, [sprite, mesh, artMode, puppetConfig.paddingPx, usingCpuFallback]);

  // Render active deformed pose (or live drag pose + optional onion skins)
  useEffect(() => {
    const restPins: Vec2[] = puppetConfig.pins.map((p) => ({ x: p.x, y: p.y }));
    const activeKfIdx = playbackIndices[frameIdx % Math.max(1, playbackIndices.length)] ?? 0;
    const targetPins = draggedPins ?? keyframes[activeKfIdx]?.pins ?? restPins;

    const currentSolve = solveMlsMesh(mesh.vertices, restPins, targetPins, puppetConfig.mode);

    const renderer = rendererRef.current;
    if (renderer && !usingCpuFallback) {
      renderer.clearPreview();
      if (onionSkin && draggedPins === null && keyframes.length > 1) {
        const prevIdx = (activeKfIdx - 1 + keyframes.length) % keyframes.length;
        const nextIdx = (activeKfIdx + 1) % keyframes.length;
        const prevPins = keyframes[prevIdx]?.pins ?? restPins;
        const nextPins = keyframes[nextIdx]?.pins ?? restPins;

        const prevSolve = solveMlsMesh(mesh.vertices, restPins, prevPins, puppetConfig.mode);
        renderer.drawMeshPass(prevSolve.positions, prevSolve.rotations, {
          targetFbo: false,
          tint: [1.0, 0.35, 0.35, 0.28],
        });

        const nextSolve = solveMlsMesh(mesh.vertices, restPins, nextPins, puppetConfig.mode);
        renderer.drawMeshPass(nextSolve.positions, nextSolve.rotations, {
          targetFbo: false,
          tint: [0.35, 0.6, 1.0, 0.28],
        });
      }
      renderer.drawMeshPass(currentSolve.positions, currentSolve.rotations, {
        targetFbo: false,
        tint: [1, 1, 1, 1],
      });
      return;
    }

    // Deterministic 2D Canvas CPU fallback
    const canvas = canvasRef.current;
    if (!canvas) return;
    const frameBuf = rasterizeDeformedMeshCpu(
      sprite,
      mesh,
      currentSolve.positions,
      currentSolve.rotations,
      { paddingPx: puppetConfig.paddingPx, pixelArt: artMode === 'pixel-art' },
    );
    canvas.width = frameBuf.width;
    canvas.height = frameBuf.height;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(frameBuf.data), frameBuf.width, frameBuf.height),
        0,
        0,
      );
    }
  }, [
    sprite,
    mesh,
    artMode,
    puppetConfig.pins,
    puppetConfig.mode,
    puppetConfig.paddingPx,
    keyframes,
    playbackIndices,
    frameIdx,
    draggedPins,
    onionSkin,
    usingCpuFallback,
  ]);

  const frameW = sprite.width + puppetConfig.paddingPx * 2;
  const frameH = sprite.height + puppetConfig.paddingPx * 2;

  const clientToSpriteCoords = (clientX: number, clientY: number): Vec2 | null => {
    const el = stageRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const fx = ((clientX - rect.left) / Math.max(1, rect.width)) * frameW;
    const fy = ((clientY - rect.top) / Math.max(1, rect.height)) * frameH;
    return {
      x: Number(Math.max(0, Math.min(sprite.width, fx - puppetConfig.paddingPx)).toFixed(2)),
      y: Number(Math.max(0, Math.min(sprite.height, fy - puppetConfig.paddingPx)).toFixed(2)),
    };
  };

  const findNearestPinIndex = (spritePt: Vec2): number => {
    const threshold = Math.max(4, sprite.width * 0.08);
    let bestIdx = -1;
    let bestDist = threshold;
    for (let i = 0; i < puppetConfig.pins.length; i++) {
      const p = puppetConfig.pins[i]!;
      const d = Math.hypot(p.x - spritePt.x, p.y - spritePt.y);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  const handleStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button === 2) return;
    const pt = clientToSpriteCoords(e.clientX, e.clientY);
    if (!pt) return;

    const hitIdx = findNearestPinIndex(pt);
    if (hitIdx >= 0) {
      dragPinIndexRef.current = hitIdx;
      e.currentTarget.setPointerCapture(e.pointerId);
      setDraggedPins(puppetConfig.pins.map((p, idx) => (idx === hitIdx ? pt : { x: p.x, y: p.y })));
      return;
    }

    const newPin: PuppetPinConfig = {
      id: globalThis.crypto.randomUUID(),
      x: pt.x,
      y: pt.y,
      role: placementRole,
    };
    onChangeConfig((prev) => ({ ...prev, pins: [...prev.pins, newPin] }));
  };

  const handleStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const hitIdx = dragPinIndexRef.current;
    if (hitIdx === null) return;
    const pt = clientToSpriteCoords(e.clientX, e.clientY);
    if (!pt) return;
    setDraggedPins(puppetConfig.pins.map((p, idx) => (idx === hitIdx ? pt : { x: p.x, y: p.y })));
  };

  const handleStagePointerUp = () => {
    dragPinIndexRef.current = null;
    setDraggedPins(null);
  };

  const handleStageContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    const pt = clientToSpriteCoords(e.clientX, e.clientY);
    if (!pt) return;
    const hitIdx = findNearestPinIndex(pt);
    if (hitIdx < 0) return;
    onChangeConfig((prev) => ({
      ...prev,
      pins: prev.pins.map((p, idx) => {
        if (idx !== hitIdx) return p;
        const nextRole = ROLE_ORDER[(ROLE_ORDER.indexOf(p.role) + 1) % ROLE_ORDER.length]!;
        return { ...p, role: nextRole };
      }),
    }));
  };

  const activeKfIdx = playbackIndices[frameIdx % Math.max(1, playbackIndices.length)] ?? 0;
  const displayPins = draggedPins ?? keyframes[activeKfIdx]?.pins ?? puppetConfig.pins;

  return (
    <div
      data-testid="puppet-warp-panel"
      className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]"
    >
      {/* Left Stage: Interactive Rigging & Live MLS Animation Canvas */}
      <section className="flex min-w-0 flex-col bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
          <div className="flex items-center gap-1.5 text-xs">
            <span className="mr-1 text-slate-400">Pin Role:</span>
            {ROLE_ORDER.map((role) => (
              <button
                key={role}
                type="button"
                data-testid={`puppet-role-${role}`}
                onClick={() => setPlacementRole(role)}
                className={`rounded border px-2.5 py-1 text-xs font-medium ${
                  placementRole === role
                    ? 'border-indigo-400 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {ROLE_STYLE[role].label}
              </button>
            ))}
          </div>
          <span className="text-[11px] text-slate-400">
            Click canvas to place pin · Drag pin to test warp · Right-click pin to cycle role
          </span>
        </div>

        <div className="flex flex-1 items-center justify-center overflow-auto bg-checkerboard p-8">
          <div
            ref={stageRef}
            data-testid="puppet-stage"
            onPointerDown={handleStagePointerDown}
            onPointerMove={handleStagePointerMove}
            onPointerUp={handleStagePointerUp}
            onPointerCancel={handleStagePointerUp}
            onContextMenu={handleStageContextMenu}
            className="relative aspect-square w-full max-w-[440px] cursor-crosshair overflow-hidden rounded-lg border border-slate-700 bg-slate-950/60 shadow-2xl select-none"
            style={{ touchAction: 'none' }}
          >
            <canvas
              ref={canvasRef}
              data-testid="puppet-pin-canvas"
              className="h-full w-full object-contain"
              style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
            />

            {/* Padding Bounds Frame */}
            {puppetConfig.paddingPx > 0 && (
              <div
                className="pointer-events-none absolute border border-dashed border-slate-500/40"
                style={{
                  left: `${(puppetConfig.paddingPx / frameW) * 100}%`,
                  top: `${(puppetConfig.paddingPx / frameH) * 100}%`,
                  width: `${(sprite.width / frameW) * 100}%`,
                  height: `${(sprite.height / frameH) * 100}%`,
                }}
              />
            )}

            {/* Placed Control Pins Overlay */}
            {puppetConfig.pins.map((pin, idx) => {
              const pos = displayPins[idx] ?? pin;
              const style = ROLE_STYLE[pin.role];
              return (
                <div
                  key={pin.id}
                  data-testid={`puppet-pin-marker-${idx}`}
                  title={`${style.label} #${idx + 1} (${Math.round(pin.x)}, ${Math.round(pin.y)})`}
                  className={`pointer-events-none absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 border-2 shadow-md ${style.bg} ${
                    pin.role === 'anchor'
                      ? 'rounded-xs'
                      : pin.role === 'driver'
                        ? 'rotate-45 rounded-xs'
                        : 'rounded-full'
                  }`}
                  style={{
                    left: `${((pos.x + puppetConfig.paddingPx) / frameW) * 100}%`,
                    top: `${((pos.y + puppetConfig.paddingPx) / frameH) * 100}%`,
                  }}
                />
              );
            })}
          </div>
        </div>
      </section>

      {/* Right Pane: Procedural Presets, Playback & Strip Export */}
      <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
          <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
              <span>MLS Rig &amp; Animation Loop</span>
            </div>
            <span className="font-mono text-[11px] text-slate-400">
              {puppetConfig.pins.length} pins
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs">
              <span className="text-slate-400">Loop Preset</span>
              <select
                data-testid="puppet-preset-select"
                value={puppetConfig.preset}
                onChange={(e) => {
                  const preset = e.target.value as AnimPresetOption;
                  const meta = ANIM_PRESETS[preset];
                  onChangeConfig((prev) => ({
                    ...prev,
                    preset,
                    mode: meta.mlsMode,
                    frameCount: meta.defaultFrames,
                    amplitudePx: meta.defaultAmplitudePx,
                  }));
                }}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
              >
                <option value="idle-breathe">Idle Breathe</option>
                <option value="wind-sway">Wind / Ambient Sway</option>
                <option value="hit-recoil">Hit Recoil</option>
                <option value="squash-stretch">Squash &amp; Stretch</option>
              </select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-slate-400">Solver Mode</span>
              <select
                data-testid="puppet-mls-mode"
                value={puppetConfig.mode}
                onChange={(e) =>
                  onChangeConfig((prev) => ({
                    ...prev,
                    mode: e.target.value as MlsModeOption,
                  }))
                }
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
              >
                <option value="rigid">Rigid (Area-Lock)</option>
                <option value="similarity">Similarity (Scale)</option>
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs">
              <span className="text-slate-400">Frames</span>
              <input
                type="number"
                data-testid="puppet-frame-count"
                min={2}
                max={24}
                value={puppetConfig.frameCount}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10);
                  if (!Number.isNaN(v) && v >= 2 && v <= 24) {
                    onChangeConfig((prev) => ({ ...prev, frameCount: v }));
                  }
                }}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
              />
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-slate-400">Edge Pad (px)</span>
              <input
                type="number"
                data-testid="puppet-padding-input"
                min={0}
                max={32}
                value={puppetConfig.paddingPx}
                onChange={(e) => {
                  const v = Number.parseInt(e.target.value, 10);
                  if (!Number.isNaN(v) && v >= 0 && v <= 32) {
                    onChangeConfig((prev) => ({ ...prev, paddingPx: v }));
                  }
                }}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
              />
            </label>
          </div>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Amplitude</span>
              <span className="font-mono">{puppetConfig.amplitudePx.toFixed(1)} px</span>
            </div>
            <input
              type="range"
              data-testid="puppet-amplitude-slider"
              min={1}
              max={16}
              step={0.5}
              value={puppetConfig.amplitudePx}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  amplitudePx: Number.parseFloat(e.target.value),
                }))
              }
              className="w-full accent-indigo-500"
            />
          </label>

          <label className="block space-y-1 text-xs">
            <div className="flex justify-between text-slate-400">
              <span>Playback Speed</span>
              <span className="font-mono">{puppetConfig.fps} FPS</span>
            </div>
            <input
              type="range"
              data-testid="puppet-fps-slider"
              min={4}
              max={24}
              value={puppetConfig.fps}
              onChange={(e) =>
                onChangeConfig((prev) => ({
                  ...prev,
                  fps: Number.parseInt(e.target.value, 10),
                }))
              }
              className="w-full accent-indigo-500"
            />
          </label>

          <div className="space-y-1.5 border-t border-slate-800 pt-2 text-xs text-slate-300">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="puppet-pingpong-toggle"
                checked={puppetConfig.pingPong}
                onChange={(e) =>
                  onChangeConfig((prev) => ({ ...prev, pingPong: e.target.checked }))
                }
                className="accent-indigo-500"
              />
              Ping-Pong Timeline Sequence
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="puppet-onion-skin-toggle"
                checked={onionSkin}
                onChange={(e) => setOnionSkin(e.target.checked)}
                className="accent-indigo-500"
              />
              Onion Skin Ghosts (Prev/Next)
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                data-testid="puppet-relock-polish-toggle"
                checked={puppetConfig.reLockPolish}
                onChange={(e) =>
                  onChangeConfig((prev) => ({ ...prev, reLockPolish: e.target.checked }))
                }
                className="accent-indigo-500"
              />
              Re-Lock Pixel Polish (Sel-Out + Cleanup per Frame)
            </label>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="puppet-play-toggle"
              onClick={() => setIsPlaying((p) => !p)}
              className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
              {isPlaying ? 'Pause' : 'Play'}
            </button>
            <button
              type="button"
              data-testid="puppet-clear-pins-btn"
              disabled={puppetConfig.pins.length === 0}
              onClick={() => onChangeConfig((prev) => ({ ...prev, pins: [] }))}
              className="inline-flex items-center gap-1 rounded border border-rose-500/35 bg-rose-500/10 px-2.5 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/20 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Clear
            </button>
          </div>

          <button
            type="button"
            data-testid="puppet-export-zip-btn"
            disabled={puppetConfig.pins.length === 0}
            onClick={onExportStripZip}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Export Strip ZIP ({frameW * puppetConfig.frameCount}×{frameH})
          </button>
        </div>

        {exportSlot}
      </aside>
    </div>
  );
}
