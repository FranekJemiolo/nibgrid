import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Eye, Gamepad2, Grid2X2, Layers, Pause, Play, Scissors } from 'lucide-react';
import { db } from '../../db/database';
import type { ArtMode, Project, SpriteNode, TurnaroundLayout } from '../../domain/schemas';
import { commitTurnaroundViews } from '../../domain/turnaroundCommit';
import { toAssetSlug } from '../../export/zipPackager';
import {
  detectTurnaroundSlots,
  type CardinalDirection,
  type RawSliceBounds,
  type TurnaroundSliceResult,
} from '../../processing/turnaroundSlicer';
import type { RgbaBuffer } from '../../processing/types';
import {
  createMonotonicRequestGuard,
  sliceTurnaroundInWorker,
} from '../../workers/postprocessClient';

interface TurnaroundSlicerProps {
  sheetBuffer: RgbaBuffer;
  artMode: ArtMode;
  project: Project;
  targetNode: SpriteNode;
  onCommitted: (result: { directionGroupId: string; firstNodeId: string }) => Promise<void> | void;
  onOpenAtlas: () => void;
  onOpenSandbox: (nodeId: string) => void;
  onOpenStudio: () => void;
}

const DIRECTION_COLORS: Record<CardinalDirection, string> = {
  south: '#22C55E',
  east: '#F59E0B',
  north: '#38BDF8',
  west: '#A855F7',
};

const ALL_DIRECTIONS: readonly CardinalDirection[] = ['south', 'east', 'north', 'west'];

function inferInitialLayout(node: SpriteNode, sheet: RgbaBuffer): TurnaroundLayout {
  if (node.turnaroundMeta?.turnaroundLayout) {
    return node.turnaroundMeta.turnaroundLayout;
  }
  return sheet.width >= sheet.height * 2 ? '1x4' : '2x2';
}

export function TurnaroundSlicer({
  sheetBuffer,
  artMode,
  project,
  targetNode,
  onCommitted,
  onOpenAtlas,
  onOpenSandbox,
  onOpenStudio,
}: TurnaroundSlicerProps) {
  const [layout, setLayout] = useState<TurnaroundLayout>(() =>
    inferInitialLayout(targetNode, sheetBuffer),
  );
  const [normalizeHeight, setNormalizeHeight] = useState(true);
  const [mirrorEastToWest, setMirrorEastToWest] = useState(false);
  const [paddingPx, setPaddingPx] = useState(4);
  const [minComponentPixels, setMinComponentPixels] = useState(16);
  const [slotDirections, setSlotDirections] = useState<
    readonly [CardinalDirection, CardinalDirection, CardinalDirection, CardinalDirection]
  >(['south', 'east', 'north', 'west']);

  const [cleanedSheet, setCleanedSheet] = useState<RgbaBuffer | null>(null);
  const [sliceResult, setSliceResult] = useState<TurnaroundSliceResult | null>(null);
  const [isSlicing, setIsSlicing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [previewMode, setPreviewMode] = useState<'onion-skin' | 'turntable'>('onion-skin');
  const [visibleDirs, setVisibleDirs] = useState<Record<CardinalDirection, boolean>>({
    south: true,
    east: true,
    north: true,
    west: true,
  });
  const [turntableFps, setTurntableFps] = useState(2);
  const [turntablePlaying, setTurntablePlaying] = useState(false);
  const [turntableIdx, setTurntableIdx] = useState(0);

  const [isCommitting, setIsCommitting] = useState(false);
  const [commitResult, setCommitResult] = useState<{
    directionGroupId: string;
    count: number;
    firstNodeId: string;
  } | null>(null);

  const sheetCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const guardRef = useRef(createMonotonicRequestGuard());
  const rafIdRef = useRef<number | null>(null);

  const targetNodeId = targetNode.id;
  const targetTurnaroundLayout = targetNode.turnaroundMeta?.turnaroundLayout;
  const initialLayout: TurnaroundLayout =
    targetTurnaroundLayout ?? (sheetBuffer.width >= sheetBuffer.height * 2 ? '1x4' : '2x2');

  useEffect(() => {
    setLayout(initialLayout);
    setCommitResult(null);
    setErrorMessage(null);
  }, [targetNodeId, initialLayout]);

  useEffect(() => {
    const guard = guardRef.current;
    return () => {
      guard.invalidate();
      if (scratchCanvasRef.current) {
        scratchCanvasRef.current.width = 0;
        scratchCanvasRef.current.height = 0;
        scratchCanvasRef.current = null;
      }
    };
  }, []);

  // Run worker background removal + connected-component turnaround slicing off main thread
  useEffect(() => {
    let cancelled = false;
    const guard = guardRef.current;
    const token = guard.next();
    setIsSlicing(true);
    setErrorMessage(null);

    void sliceTurnaroundInWorker({
      rgba: sheetBuffer.data,
      width: sheetBuffer.width,
      height: sheetBuffer.height,
      removeBackground: true,
      bgTolerance: 20,
      options: {
        layout,
        slotDirections,
        minComponentPixels,
        normalizeHeight,
        paddingPx,
        mirrorEastToWest,
      },
    })
      .then((res) => {
        if (cancelled || !guard.isCurrent(token)) return;
        setCleanedSheet({
          width: res.sheetWidth,
          height: res.sheetHeight,
          data: res.cleanedSheetRgba,
        });
        setSliceResult(res.result);
        setIsSlicing(false);
      })
      .catch((err: unknown) => {
        if (cancelled || !guard.isCurrent(token)) return;
        setErrorMessage(err instanceof Error ? err.message : 'Turnaround slicing failed.');
        setIsSlicing(false);
      });

    return () => {
      cancelled = true;
      guard.invalidate();
    };
  }, [
    sheetBuffer,
    layout,
    slotDirections,
    minComponentPixels,
    normalizeHeight,
    paddingPx,
    mirrorEastToWest,
  ]);

  const detectedSlots: readonly RawSliceBounds[] = useMemo(() => {
    if (sliceResult && !mirrorEastToWest) {
      return sliceResult.frames.map((frame) => frame.sourceBounds);
    }
    if (!cleanedSheet) return [];
    return detectTurnaroundSlots(cleanedSheet, {
      layout,
      slotDirections,
      minComponentPixels,
    });
  }, [sliceResult, mirrorEastToWest, cleanedSheet, layout, slotDirections, minComponentPixels]);

  // Paint Left Pane: Cleaned Sheet onto Canvas2D
  useEffect(() => {
    const canvas = sheetCanvasRef.current;
    const src = cleanedSheet ?? sheetBuffer;
    if (!canvas || src.width <= 0 || src.height <= 0) return;
    canvas.width = src.width;
    canvas.height = src.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = artMode === 'hd-2d';
    ctx.putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0);
  }, [cleanedSheet, sheetBuffer, artMode]);

  // Strict rAF Turntable Timer + Document Visibility / Unmount Guard
  useEffect(() => {
    if (rafIdRef.current !== null) {
      window.cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }

    const frameCount = sliceResult?.frames.length ?? 0;
    if (previewMode !== 'turntable' || !turntablePlaying || frameCount <= 1) {
      return;
    }

    let cancelled = false;
    let lastTick = performance.now();
    const intervalMs = 1000 / Math.max(1, turntableFps);

    const step = (now: number) => {
      if (cancelled || document.hidden) {
        rafIdRef.current = null;
        return;
      }
      if (now - lastTick >= intervalMs) {
        lastTick = now;
        setTurntableIdx((prev) => (prev + 1) % frameCount);
      }
      rafIdRef.current = window.requestAnimationFrame(step);
    };

    const handleVisibilityChange = () => {
      if (document.hidden && rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
        setTurntablePlaying(false);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    rafIdRef.current = window.requestAnimationFrame(step);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (rafIdRef.current !== null) {
        window.cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
    };
  }, [previewMode, turntablePlaying, turntableFps, sliceResult?.frames.length]);

  // Paint Right Pane: Onion-Skin Stack or Turntable Active Frame over Shared Pivot Crosshair
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !sliceResult || sliceResult.frameWidth <= 0 || sliceResult.frameHeight <= 0) {
      return;
    }

    const { frameWidth, frameHeight, sharedPivotPx, frames } = sliceResult;
    canvas.width = frameWidth;
    canvas.height = frameHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = artMode === 'hd-2d';
    ctx.clearRect(0, 0, frameWidth, frameHeight);

    // Subtle pixel checkerboard backing
    const cell = 4;
    for (let y = 0; y < frameHeight; y += cell) {
      for (let x = 0; x < frameWidth; x += cell) {
        const dark = ((x / cell + y / cell) & 1) === 0;
        ctx.fillStyle = dark ? '#0f172a' : '#1e293b';
        ctx.fillRect(x, y, Math.min(cell, frameWidth - x), Math.min(cell, frameHeight - y));
      }
    }

    if (!scratchCanvasRef.current) {
      scratchCanvasRef.current = document.createElement('canvas');
    }
    const scratch = scratchCanvasRef.current;
    if (scratch.width !== frameWidth || scratch.height !== frameHeight) {
      scratch.width = frameWidth;
      scratch.height = frameHeight;
    }
    const sCtx = scratch.getContext('2d');
    if (!sCtx) return;

    const framesToRender =
      previewMode === 'onion-skin'
        ? frames.filter((f) => visibleDirs[f.direction])
        : frames.length > 0
          ? [frames[turntableIdx % frames.length]!]
          : [];

    ctx.save();
    ctx.globalAlpha = previewMode === 'onion-skin' ? 0.35 : 1.0;
    for (const frame of framesToRender) {
      sCtx.putImageData(
        new ImageData(
          new Uint8ClampedArray(frame.buffer.data),
          frame.buffer.width,
          frame.buffer.height,
        ),
        0,
        0,
      );
      ctx.drawImage(scratch, 0, 0);
    }
    ctx.restore();

    // Draw shared pivotPx crosshair
    ctx.save();
    ctx.strokeStyle = '#f43f5e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(sharedPivotPx.x + 0.5, 0);
    ctx.lineTo(sharedPivotPx.x + 0.5, frameHeight);
    ctx.moveTo(0, sharedPivotPx.y - 0.5);
    ctx.lineTo(frameWidth, sharedPivotPx.y - 0.5);
    ctx.stroke();

    ctx.fillStyle = '#38bdf8';
    ctx.fillRect(sharedPivotPx.x - 1, sharedPivotPx.y - 2, 3, 3);
    ctx.restore();
  }, [sliceResult, previewMode, visibleDirs, turntableIdx, artMode]);

  const handleCommitViews = async () => {
    if (!sliceResult || sliceResult.frames.length === 0 || isCommitting) return;
    setIsCommitting(true);
    setErrorMessage(null);
    try {
      const slug = toAssetSlug(
        `${project.name}-${targetNode.generationMeta.promptDelta || targetNode.kind}`,
      );
      const committed = await commitTurnaroundViews(db, targetNode, sliceResult, slug);
      const firstNodeId = committed.nodes[0]?.id ?? targetNode.id;
      setCommitResult({
        directionGroupId: committed.directionGroupId,
        count: committed.nodes.length,
        firstNodeId,
      });
      await onCommitted({ directionGroupId: committed.directionGroupId, firstNodeId });
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to commit directional views.');
    } finally {
      setIsCommitting(false);
    }
  };

  const handleSlotDirectionChange = (slotIdx: number, nextDir: CardinalDirection) => {
    setSlotDirections((prev) => {
      const next = [...prev] as [
        CardinalDirection,
        CardinalDirection,
        CardinalDirection,
        CardinalDirection,
      ];
      next[slotIdx] = nextDir;
      return next;
    });
  };

  const sheetW = cleanedSheet?.width ?? sheetBuffer.width;
  const sheetH = cleanedSheet?.height ?? sheetBuffer.height;
  const imageRenderingStyle = artMode === 'pixel-art' ? 'pixelated' : 'auto';
  const activeTurntableFrame =
    sliceResult && sliceResult.frames.length > 0
      ? sliceResult.frames[turntableIdx % sliceResult.frames.length]
      : undefined;

  return (
    <div
      data-testid="turnaround-slicer-panel"
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_340px]"
    >
      {/* Left Pane: Detected Sheet Canvas + Color-Coded Slot Bounding Boxes */}
      <section className="flex min-w-0 flex-col border-b border-slate-800 bg-slate-950 p-4 lg:border-r lg:border-b-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Scissors className="h-4 w-4 text-cyan-400" />
            <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
              Detected Sheet ({sheetW}×{sheetH})
            </h3>
          </div>
          <div className="flex flex-wrap gap-1.5 text-[10px] font-semibold uppercase">
            {ALL_DIRECTIONS.map((dir) => (
              <span
                key={dir}
                className="inline-flex items-center gap-1 rounded border border-slate-800 bg-slate-900 px-1.5 py-0.5 text-slate-200"
              >
                <span
                  className="h-2 w-2 rounded-full"
                  style={{ backgroundColor: DIRECTION_COLORS[dir] }}
                />
                {dir}
              </span>
            ))}
          </div>
        </div>

        <div className="bg-checkerboard relative flex flex-1 items-center justify-center overflow-auto rounded-xl border border-slate-800 p-4">
          <div
            className="relative inline-block shadow-xl ring-1 ring-slate-700"
            style={{
              aspectRatio: `${Math.max(1, sheetW)} / ${Math.max(1, sheetH)}`,
              width: sheetW > sheetH ? '100%' : 'min(100%, 380px)',
              maxHeight: '100%',
            }}
          >
            <canvas
              ref={sheetCanvasRef}
              data-testid="turnaround-sheet-canvas"
              className="block h-full w-full"
              style={{ imageRendering: imageRenderingStyle }}
            />
            {sheetW > 0 && sheetH > 0 && (
              <svg
                viewBox={`0 0 ${sheetW} ${sheetH}`}
                className="pointer-events-none absolute inset-0 h-full w-full"
                preserveAspectRatio="none"
              >
                {detectedSlots.map((slot) => {
                  const color = DIRECTION_COLORS[slot.direction];
                  return (
                    <g key={slot.slotIndex} data-testid={`turnaround-slot-box-${slot.slotIndex}`}>
                      <rect
                        x={slot.minX + 0.5}
                        y={slot.minY + 0.5}
                        width={Math.max(1, slot.maxX - slot.minX + 1)}
                        height={Math.max(1, slot.maxY - slot.minY + 1)}
                        fill="none"
                        stroke={color}
                        strokeWidth={Math.max(1, sheetW / 128)}
                      />
                    </g>
                  );
                })}
              </svg>
            )}
          </div>
        </div>
      </section>

      {/* Center/Right Preview Pane: Onion-Skin Stack & Turntable over Shared Pivot Crosshair */}
      <section className="flex min-w-0 flex-col border-b border-slate-800 bg-slate-950 p-4 lg:border-r lg:border-b-0">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex overflow-hidden rounded-md border border-slate-700 bg-slate-900 p-0.5 text-xs">
            <button
              type="button"
              data-testid="turnaround-mode-onionskin"
              onClick={() => {
                setPreviewMode('onion-skin');
                setTurntablePlaying(false);
              }}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium ${
                previewMode === 'onion-skin'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              Onion-Skin Stack
            </button>
            <button
              type="button"
              data-testid="turnaround-mode-turntable"
              onClick={() => setPreviewMode('turntable')}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium ${
                previewMode === 'turntable'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Play className="h-3.5 w-3.5" />
              Turntable
            </button>
          </div>

          {sliceResult && (
            <span
              data-testid="turnaround-metrics-badge"
              className="rounded border border-cyan-500/35 bg-cyan-950/40 px-2.5 py-1 font-mono text-[11px] font-semibold text-cyan-200"
            >
              {sliceResult.frameWidth}×{sliceResult.frameHeight} · Pivot (
              {sliceResult.sharedPivotPx.x}, {sliceResult.sharedPivotPx.y}) ·{' '}
              {sliceResult.frames.length}/4 views
            </span>
          )}
        </div>

        <div className="relative flex flex-1 items-center justify-center overflow-auto rounded-xl border border-slate-800 bg-slate-900/40 p-6">
          {sliceResult && sliceResult.frameWidth > 0 ? (
            <canvas
              ref={previewCanvasRef}
              data-testid="turnaround-preview-canvas"
              className="h-64 w-64 rounded-lg shadow-2xl ring-1 ring-slate-700"
              style={{
                imageRendering: imageRenderingStyle,
                width: `${Math.min(320, Math.max(192, sliceResult.frameWidth * 4))}px`,
                height: `${Math.min(320, Math.max(192, sliceResult.frameHeight * 4))}px`,
              }}
            />
          ) : (
            <p className="text-xs text-slate-400">
              {isSlicing ? 'Slicing turnaround sheet in Worker...' : 'No sprite views detected.'}
            </p>
          )}
        </div>

        {previewMode === 'onion-skin' ? (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="inline-flex items-center gap-1 text-slate-400">
              <Eye className="h-3.5 w-3.5" /> Visible Layers (35% Onion-Skin):
            </span>
            <div className="flex flex-wrap gap-1.5">
              {ALL_DIRECTIONS.map((dir) => {
                const active = visibleDirs[dir];
                return (
                  <button
                    key={dir}
                    type="button"
                    data-testid={`turnaround-vis-${dir}`}
                    onClick={() => setVisibleDirs((prev) => ({ ...prev, [dir]: !prev[dir] }))}
                    className={`rounded border px-2 py-0.5 text-[11px] font-medium uppercase ${
                      active
                        ? 'border-indigo-500/60 bg-indigo-500/20 text-indigo-100'
                        : 'border-slate-800 bg-slate-900 text-slate-500'
                    }`}
                  >
                    {dir}
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-2 text-xs">
            <button
              type="button"
              data-testid="turnaround-turntable-play"
              onClick={() => setTurntablePlaying((p) => !p)}
              className="inline-flex items-center gap-1.5 rounded bg-indigo-600 px-3 py-1 font-semibold text-white hover:bg-indigo-500"
            >
              {turntablePlaying ? (
                <>
                  <Pause className="h-3.5 w-3.5" />
                  Pause
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" />
                  Play Turntable
                </>
              )}
            </button>
            <span className="font-mono text-[11px] text-cyan-200 uppercase">
              View: {activeTurntableFrame?.direction ?? '—'}
            </span>
            <label className="flex items-center gap-2 text-[11px] text-slate-300">
              <span>{turntableFps} FPS</span>
              <input
                type="range"
                data-testid="turnaround-turntable-fps"
                min={1}
                max={6}
                step={1}
                value={turntableFps}
                onChange={(e) => setTurntableFps(Number.parseInt(e.target.value, 10))}
                className="w-20 accent-indigo-500"
              />
            </label>
          </div>
        )}
      </section>

      {/* Right Control Sidebar */}
      <aside className="flex flex-col gap-3 overflow-y-auto bg-slate-900/60 p-4 text-xs">
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
          <div className="font-semibold text-slate-200">Auto-Slicer Controls</div>

          <div className="space-y-1">
            <span className="text-[11px] text-slate-400">Sheet Layout</span>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                data-testid="turnaround-layout-2x2"
                onClick={() => setLayout('2x2')}
                className={`rounded border px-2.5 py-1.5 font-medium ${
                  layout === '2x2'
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                2×2 Grid
              </button>
              <button
                type="button"
                data-testid="turnaround-layout-1x4"
                onClick={() => setLayout('1x4')}
                className={`rounded border px-2.5 py-1.5 font-medium ${
                  layout === '1x4'
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                1×4 Strip
              </button>
            </div>
          </div>

          <label className="flex items-center justify-between gap-2 text-slate-200">
            <span>Normalize Height (Median Lock)</span>
            <input
              type="checkbox"
              data-testid="turnaround-normalize-height"
              checked={normalizeHeight}
              onChange={(e) => setNormalizeHeight(e.target.checked)}
              className="accent-indigo-500"
            />
          </label>

          <label className="flex items-center justify-between gap-2 text-slate-200">
            <span>Mirror East → West</span>
            <input
              type="checkbox"
              data-testid="turnaround-mirror-ew"
              checked={mirrorEastToWest}
              onChange={(e) => setMirrorEastToWest(e.target.checked)}
              className="accent-cyan-500"
            />
          </label>

          <label className="block space-y-1">
            <div className="flex justify-between text-slate-400">
              <span>Uniform Padding</span>
              <span className="font-mono text-slate-200">{paddingPx} px</span>
            </div>
            <input
              type="range"
              data-testid="turnaround-padding"
              min={0}
              max={16}
              step={1}
              value={paddingPx}
              onChange={(e) => setPaddingPx(Number.parseInt(e.target.value, 10))}
              className="w-full accent-indigo-500"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-slate-400">Min Speck Pixels (BFS Threshold)</span>
            <input
              type="number"
              data-testid="turnaround-min-speck"
              min={1}
              max={500}
              value={minComponentPixels}
              onChange={(e) => {
                const v = Number.parseInt(e.target.value, 10);
                if (!Number.isNaN(v) && v >= 1 && v <= 500) {
                  setMinComponentPixels(v);
                }
              }}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 font-mono text-xs text-slate-100"
            />
          </label>
        </div>

        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
          <div className="font-semibold text-slate-200">Slot Direction Mapping</div>
          <div className="grid grid-cols-2 gap-2">
            {[0, 1, 2, 3].map((slotIdx) => (
              <label key={slotIdx} className="space-y-1">
                <span className="text-[11px] text-slate-400">Slot #{slotIdx + 1}</span>
                <select
                  data-testid={`turnaround-slot-dir-${slotIdx}`}
                  value={slotDirections[slotIdx]}
                  onChange={(e) =>
                    handleSlotDirectionChange(slotIdx, e.target.value as CardinalDirection)
                  }
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 uppercase"
                >
                  {ALL_DIRECTIONS.map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>

        {errorMessage && (
          <div
            data-testid="turnaround-error-banner"
            className="rounded border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-xs text-rose-200"
          >
            {errorMessage}
          </div>
        )}

        <button
          type="button"
          data-testid="turnaround-commit-btn"
          disabled={!sliceResult || sliceResult.frames.length === 0 || isSlicing || isCommitting}
          onClick={() => void handleCommitViews()}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <CheckCircle2 className="h-4 w-4" />
          {isCommitting
            ? 'Committing Linked Views...'
            : `Commit ${sliceResult?.frames.length ?? 4} Linked Views`}
        </button>

        {commitResult && (
          <div
            data-testid="turnaround-commit-banner"
            className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3"
          >
            <p className="font-medium text-emerald-200">
              Committed {commitResult.count} linked views under group{' '}
              <span className="font-mono">{commitResult.directionGroupId.slice(0, 8)}</span>.
            </p>
            <div className="flex flex-col gap-1.5">
              <button
                type="button"
                data-testid="turnaround-open-atlas-btn"
                onClick={onOpenAtlas}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-indigo-500/40 bg-indigo-600/25 px-2.5 py-1.5 font-medium text-indigo-100 hover:bg-indigo-600/40"
              >
                <Grid2X2 className="h-3.5 w-3.5" />
                Open Atlas Packer
              </button>
              <button
                type="button"
                data-testid="turnaround-open-sandbox-btn"
                onClick={() => onOpenSandbox(commitResult.firstNodeId)}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-600/20 px-2.5 py-1.5 font-medium text-emerald-100 hover:bg-emerald-600/35"
              >
                <Gamepad2 className="h-3.5 w-3.5" />
                Preview at 1× Sandbox
              </button>
              <button
                type="button"
                data-testid="turnaround-open-studio-btn"
                onClick={onOpenStudio}
                className="inline-flex items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 font-medium text-slate-200 hover:bg-slate-700"
              >
                View 4 Linked Nodes in DAG
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>
  );
}
