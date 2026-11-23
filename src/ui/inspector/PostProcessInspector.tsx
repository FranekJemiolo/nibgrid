import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  Eraser,
  Grid3X3,
  Layers,
  Palette,
  Sliders,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { repository } from '../../db/database';
import {
  createDefaultPostProcessConfig,
  type BackgroundRemovalMode,
  type ErosionConnectivity,
  type PostProcessConfig,
  type ResampleMode,
  type SpriteNode,
} from '../../domain/schemas';
import { decodePngBytesToRgba, rgbaToPngBlob } from '../../processing/png';
import { useAppStore } from '../../store/useAppStore';
import { runPostProcessInWorker } from '../../workers/postprocessClient';

export type InspectorBackdrop = 'checkerboard' | 'dark' | 'light' | 'game-green';

interface DecodedImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

async function decodeBlobFlexible(blob: Blob): Promise<DecodedImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return await decodePngBytesToRgba(bytes);
  } catch {
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        rgba: new Uint8ClampedArray(data.data),
        width: bitmap.width,
        height: bitmap.height,
      };
    } finally {
      bitmap.close();
    }
  }
}

export function PostProcessInspector({ nodeId }: { nodeId: string }) {
  const { activeProject, spriteNodes, refreshSpriteNodes, navigate } = useAppStore();

  const targetNode: SpriteNode | undefined =
    spriteNodes.find((n) => n.id === nodeId) ?? spriteNodes[spriteNodes.length - 1];

  const [config, setConfig] = useState<PostProcessConfig>(
    () =>
      targetNode?.postProcessConfig ??
      createDefaultPostProcessConfig(
        activeProject?.artBible.targetWidth ?? 64,
        activeProject?.artBible.targetHeight ?? 64,
      ),
  );
  const [rawSize, setRawSize] = useState({ width: 128, height: 128 });
  const [processedSize, setProcessedSize] = useState({ width: 128, height: 128 });
  const [splitPercent, setSplitPercent] = useState(50);
  const [zoomPercent, setZoomPercent] = useState(300);
  const [showPixelGrid, setShowPixelGrid] = useState(true);
  const [backdrop, setBackdrop] = useState<InspectorBackdrop>('checkerboard');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ phase: string; progress: number } | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);

  const rawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const processedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const comparatorRef = useRef<HTMLDivElement | null>(null);
  const draggingSplitRef = useRef(false);

  const rawImageRef = useRef<DecodedImage | null>(null);
  const latestNodeRef = useRef<SpriteNode | undefined>(targetNode);
  latestNodeRef.current = targetNode;
  const targetNodeId = targetNode?.id;
  const targetImageBlobId = targetNode?.imageBlobId;

  // Sync initial config when node changes
  useEffect(() => {
    const node = latestNodeRef.current;
    if (!targetNodeId || !node || !activeProject) return;
    setConfig(
      node.postProcessConfig ??
        createDefaultPostProcessConfig(
          activeProject.artBible.targetWidth,
          activeProject.artBible.targetHeight,
        ),
    );
  }, [targetNodeId, activeProject]);

  const drawCanvasBuffer = useCallback(
    (canvas: HTMLCanvasElement | null, rgba: Uint8ClampedArray, width: number, height: number) => {
      if (!canvas) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    },
    [],
  );

  // Load raw source image from Dexie when targetNode changes
  useEffect(() => {
    if (!targetNodeId || !targetImageBlobId) return;
    let cancelled = false;

    void repository.getBlob(targetImageBlobId).then(async (blobRecord) => {
      if (cancelled || !blobRecord) return;
      const decoded = await decodeBlobFlexible(blobRecord.bytes);
      if (cancelled) return;
      rawImageRef.current = decoded;
      setRawSize({ width: decoded.width, height: decoded.height });
      drawCanvasBuffer(rawCanvasRef.current, decoded.rgba, decoded.width, decoded.height);
    });

    return () => {
      cancelled = true;
    };
  }, [targetNodeId, targetImageBlobId, drawCanvasBuffer]);

  // Execute post-processing pipeline in Dedicated Worker whenever config or raw image changes
  useEffect(() => {
    if (!activeProject || !targetNodeId) return;
    let cancelled = false;

    const timer = window.setTimeout(() => {
      const raw = rawImageRef.current;
      if (!raw) return;

      setIsProcessing(true);
      setWorkerError(null);
      if (config.bgRemoval !== 'ai-rembg') {
        setAiProgress(null);
      }

      void runPostProcessInWorker({
        rgba: raw.rgba,
        width: raw.width,
        height: raw.height,
        config,
        paletteHex: activeProject.artBible.palette,
        onProgress: (phase, progress) => {
          if (!cancelled) {
            setAiProgress({ phase, progress });
          }
        },
      })
        .then(async (result) => {
          if (cancelled) return;
          setProcessedSize({ width: result.width, height: result.height });
          drawCanvasBuffer(processedCanvasRef.current, result.rgba, result.width, result.height);
          setAiProgress(null);
          setIsProcessing(false);

          const nodeSnapshot = latestNodeRef.current;
          if (!nodeSnapshot) return;
          const processedBlob = rgbaToPngBlob(result.rgba, result.width, result.height);
          const stored = await repository.storeBlob(processedBlob, 'image/png');
          await repository.saveSpriteNode({
            ...nodeSnapshot,
            processedBlobId: stored.id,
            postProcessConfig: config,
          });
          await repository.cleanupOrphanedBlobs();
          if (!cancelled) {
            await refreshSpriteNodes(activeProject.id);
          }
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setWorkerError(
            error instanceof Error ? error.message : 'Post-processing pipeline failed.',
          );
          setAiProgress(null);
          setIsProcessing(false);
        });
    }, 60);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [
    config,
    rawSize.width,
    rawSize.height,
    activeProject,
    targetNodeId,
    drawCanvasBuffer,
    refreshSpriteNodes,
  ]);

  const updateSplitFromClientX = (clientX: number) => {
    const el = comparatorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / Math.max(1, rect.width)) * 100;
    setSplitPercent(Math.max(0, Math.min(100, Math.round(pct))));
  };

  const handleSplitPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingSplitRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateSplitFromClientX(e.clientX);
  };

  const handleSplitPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingSplitRef.current) return;
    updateSplitFromClientX(e.clientX);
  };

  const handleSplitPointerUp = () => {
    draggingSplitRef.current = false;
  };

  if (!activeProject || !targetNode) {
    return (
      <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-6 text-center">
        <p className="text-sm text-slate-300">No sprite node selected for post-processing.</p>
        {activeProject && (
          <button
            type="button"
            onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
            className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white"
          >
            Back to Sprite Studio
          </button>
        )}
      </div>
    );
  }

  const stageW = Math.round(Math.max(rawSize.width, processedSize.width) * (zoomPercent / 100));
  const stageH = Math.round(Math.max(rawSize.height, processedSize.height) * (zoomPercent / 100));

  const backdropStyle = backdrop === 'game-green' ? { backgroundColor: '#2D5A27' } : undefined;
  const backdropClass =
    backdrop === 'checkerboard'
      ? 'bg-checkerboard'
      : backdrop === 'dark'
        ? 'bg-slate-950'
        : backdrop === 'light'
          ? 'bg-slate-100'
          : '';

  return (
    <div data-testid="postprocess-inspector" className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/80 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="back-to-studio-btn"
            onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Sprite Studio
          </button>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Post-Process & Export Inspector
            </h2>
            <p className="text-[11px] text-slate-400">
              Node {targetNode.kind} · seed #{targetNode.generationMeta.seed}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span
            data-testid="processed-dimensions-badge"
            className="rounded border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1 font-mono text-xs font-semibold text-indigo-200"
          >
            {processedSize.width}×{processedSize.height}
          </span>
          {isProcessing && <span className="text-xs text-amber-300">Processing in Worker...</span>}
        </div>
      </div>

      {workerError && (
        <div className="border-b border-rose-500/40 bg-rose-950/70 px-4 py-2 text-xs text-rose-200">
          {workerError}
        </div>
      )}

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[1fr_360px]">
        {/* Left: Split-Screen Comparator */}
        <section className="flex flex-col overflow-hidden bg-slate-950">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setZoomPercent((z) => Math.max(50, z - 50))}
                className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
                aria-label="Zoom out"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-12 text-center font-mono text-xs text-slate-200">
                {zoomPercent}%
              </span>
              <button
                type="button"
                onClick={() => setZoomPercent((z) => Math.min(800, z + 50))}
                className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
                aria-label="Zoom in"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-pressed={showPixelGrid}
                onClick={() => setShowPixelGrid(!showPixelGrid)}
                className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                  showPixelGrid
                    ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                <Grid3X3 className="h-3.5 w-3.5" />
                Grid
              </button>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <span>Split</span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={splitPercent}
                  onChange={(e) => setSplitPercent(Number.parseInt(e.target.value, 10))}
                  className="w-24 accent-indigo-500"
                  aria-label="Split comparison position"
                />
              </label>

              <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
                {(
                  [
                    ['checkerboard', 'Checker'],
                    ['dark', 'Dark'],
                    ['light', 'Light'],
                    ['game-green', 'Game Green'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    data-testid={`inspector-backdrop-${key}`}
                    onClick={() => setBackdrop(key)}
                    className={`px-2 py-1 ${
                      backdrop === key
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div
            className={`relative flex flex-1 items-center justify-center overflow-auto p-8 ${backdropClass}`}
            style={backdropStyle}
          >
            <div
              ref={comparatorRef}
              data-testid="split-comparator"
              onPointerDown={handleSplitPointerDown}
              onPointerMove={handleSplitPointerMove}
              onPointerUp={handleSplitPointerUp}
              onPointerCancel={handleSplitPointerUp}
              className="relative cursor-ew-resize shadow-2xl ring-1 ring-slate-600/80 select-none"
              style={{
                width: `${stageW}px`,
                height: `${stageH}px`,
                touchAction: 'none',
              }}
            >
              {/* Left Layer: Raw AI Render */}
              <canvas
                ref={rawCanvasRef}
                data-testid="raw-preview-canvas"
                className="absolute inset-0 h-full w-full"
                style={{
                  imageRendering: 'pixelated',
                  clipPath: `inset(0 ${100 - splitPercent}% 0 0)`,
                }}
              />

              {/* Right Layer: Processed Sprite */}
              <canvas
                ref={processedCanvasRef}
                data-testid="processed-preview-canvas"
                className="absolute inset-0 h-full w-full"
                style={{
                  imageRendering: 'pixelated',
                  clipPath: `inset(0 0 0 ${splitPercent}%)`,
                }}
              />

              {showPixelGrid && zoomPercent >= 200 && (
                <div
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundSize: `${stageW / Math.max(1, processedSize.width)}px ${stageH / Math.max(1, processedSize.height)}px`,
                    backgroundImage:
                      'linear-gradient(to right, rgba(148, 163, 184, 0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.16) 1px, transparent 1px)',
                  }}
                />
              )}

              {/* Split Handle */}
              <div
                data-testid="split-handle"
                className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.9)]"
                style={{ left: `${splitPercent}%` }}
              >
                <span className="absolute top-2 -left-12 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200">
                  Raw
                </span>
                <span className="absolute top-2 left-2 rounded bg-indigo-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                  Processed
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Right: Toggleable Post-Process Pipeline Cards */}
        <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
          {/* Card 1: Background Removal */}
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Eraser className="h-3.5 w-3.5 text-indigo-400" />
              <span>1. Background Removal</span>
            </div>

            <select
              data-testid="pp-bg-mode"
              value={config.bgRemoval}
              onChange={(e) =>
                setConfig((prev) => ({
                  ...prev,
                  bgRemoval: e.target.value as BackgroundRemovalMode,
                }))
              }
              className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
            >
              <option value="none">None (Keep Original)</option>
              <option value="color-key">Fast Color-Key (Flood Fill)</option>
              <option value="ai-rembg">Local AI Cutout (WebGPU / Single-Thread WASM)</option>
            </select>

            {config.bgRemoval === 'color-key' && (
              <div className="space-y-2 pt-1">
                <label className="block space-y-1 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>Color Tolerance</span>
                    <span className="font-mono">{config.bgTolerance}</span>
                  </div>
                  <input
                    type="range"
                    data-testid="pp-bg-tolerance"
                    min={0}
                    max={100}
                    value={config.bgTolerance}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        bgTolerance: Number.parseInt(e.target.value, 10),
                      }))
                    }
                    className="w-full accent-indigo-500"
                  />
                </label>

                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    data-testid="pp-bg-contiguous"
                    checked={config.bgContiguous}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, bgContiguous: e.target.checked }))
                    }
                    className="accent-indigo-500"
                  />
                  Contiguous border flood-fill
                </label>
              </div>
            )}

            {aiProgress && (
              <div data-testid="pp-ai-progress" className="space-y-1">
                <div className="flex justify-between text-[11px] text-indigo-300">
                  <span>{aiProgress.phase}</span>
                  <span>{Math.round(aiProgress.progress * 100)}%</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded bg-slate-800">
                  <div
                    className="h-full bg-indigo-500 transition-all"
                    style={{ width: `${Math.round(aiProgress.progress * 100)}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Card 2: Alpha Cleanup & Defringing */}
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
              <span>2. Alpha Cleanup & Defringe</span>
            </div>

            <label className="block space-y-1 text-xs">
              <div className="flex justify-between text-slate-400">
                <span>Alpha Cutoff Threshold</span>
                <span className="font-mono">{config.alphaThreshold}</span>
              </div>
              <input
                type="range"
                data-testid="pp-alpha-threshold"
                min={0}
                max={255}
                value={config.alphaThreshold}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    alphaThreshold: Number.parseInt(e.target.value, 10),
                  }))
                }
                className="w-full accent-indigo-500"
              />
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1 text-xs">
                <span className="text-slate-400">Erosion</span>
                <select
                  data-testid="pp-erosion-radius"
                  value={config.erosionRadius}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      erosionRadius: Number.parseInt(e.target.value, 10),
                    }))
                  }
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                >
                  <option value={0}>0 px</option>
                  <option value={1}>1 px</option>
                  <option value={2}>2 px</option>
                </select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-slate-400">Connectivity</span>
                <select
                  value={config.erosionConnectivity}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      erosionConnectivity: e.target.value as ErosionConnectivity,
                    }))
                  }
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                >
                  <option value="4-connected">4-Connected</option>
                  <option value="8-connected">8-Connected</option>
                </select>
              </label>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                data-testid="pp-defringe-toggle"
                checked={config.defringe}
                onChange={(e) => setConfig((prev) => ({ ...prev, defringe: e.target.checked }))}
                className="accent-indigo-500"
              />
              Interior-RGB Color Decontamination (Defringe)
            </label>
          </div>

          {/* Card 3: Palette Snap & Bayer Dither */}
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Palette className="h-3.5 w-3.5 text-indigo-400" />
              <span>3. OKLab Palette Snap</span>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                data-testid="pp-palette-snap-toggle"
                checked={config.paletteSnap}
                onChange={(e) => setConfig((prev) => ({ ...prev, paletteSnap: e.target.checked }))}
                className="accent-indigo-500"
              />
              Snap to Art Bible Palette ({activeProject.artBible.palette.length} colors)
            </label>

            <div className="flex flex-wrap gap-1">
              {activeProject.artBible.palette.map((hex) => (
                <span
                  key={hex}
                  title={hex}
                  className="h-3.5 w-3.5 rounded-sm border border-slate-700"
                  style={{ backgroundColor: hex }}
                />
              ))}
            </div>

            {config.paletteSnap && (
              <div className="space-y-2 border-t border-slate-800 pt-2">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <input
                    type="checkbox"
                    data-testid="pp-bayer-toggle"
                    checked={config.bayerDither}
                    onChange={(e) =>
                      setConfig((prev) => ({ ...prev, bayerDither: e.target.checked }))
                    }
                    className="accent-indigo-500"
                  />
                  4×4 Ordered Bayer Dithering
                </label>
                {config.bayerDither && (
                  <label className="block space-y-1 text-xs">
                    <div className="flex justify-between text-slate-400">
                      <span>Dither Strength</span>
                      <span className="font-mono">{config.ditherStrength.toFixed(2)}</span>
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={config.ditherStrength}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          ditherStrength: Number.parseFloat(e.target.value),
                        }))
                      }
                      className="w-full accent-indigo-500"
                    />
                  </label>
                )}
              </div>
            )}
          </div>

          {/* Card 4: Resample, Auto-Trim & PoT */}
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Sliders className="h-3.5 w-3.5 text-indigo-400" />
              <span>4. Resample, Auto-Trim & PoT</span>
            </div>

            <label className="flex items-center gap-2 text-xs text-slate-200">
              <input
                type="checkbox"
                data-testid="pp-resample-toggle"
                checked={config.resampleEnabled}
                onChange={(e) =>
                  setConfig((prev) => ({ ...prev, resampleEnabled: e.target.checked }))
                }
                className="accent-indigo-500"
              />
              Resize / Resample Output
            </label>

            {config.resampleEnabled && (
              <div className="space-y-2.5 pl-1">
                <select
                  data-testid="pp-resample-mode"
                  value={config.resampleMode}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      resampleMode: e.target.value as ResampleMode,
                    }))
                  }
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                >
                  <option value="nearest">Nearest-Neighbor (Pixel Art)</option>
                  <option value="area">Area-Average Box (HD-2D)</option>
                </select>

                <div className="flex gap-1.5">
                  {[64, 128, 256].map((dim) => (
                    <button
                      key={dim}
                      type="button"
                      data-testid={`pp-preset-${dim}`}
                      onClick={() =>
                        setConfig((prev) => ({
                          ...prev,
                          targetWidth: dim,
                          targetHeight: dim,
                        }))
                      }
                      className={`flex-1 rounded border px-2 py-1 font-mono text-[11px] ${
                        config.targetWidth === dim && config.targetHeight === dim
                          ? 'border-indigo-500 bg-indigo-600 text-white'
                          : 'border-slate-700 bg-slate-900 text-slate-300'
                      }`}
                    >
                      {dim}×{dim}
                    </button>
                  ))}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-0.5 text-[11px] text-slate-400">
                    <span>Width</span>
                    <input
                      type="number"
                      data-testid="pp-target-width"
                      min={16}
                      max={2048}
                      value={config.targetWidth}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        if (!Number.isNaN(v) && v >= 16 && v <= 2048) {
                          setConfig((prev) => ({ ...prev, targetWidth: v }));
                        }
                      }}
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                    />
                  </label>
                  <label className="space-y-0.5 text-[11px] text-slate-400">
                    <span>Height</span>
                    <input
                      type="number"
                      data-testid="pp-target-height"
                      min={16}
                      max={2048}
                      value={config.targetHeight}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        if (!Number.isNaN(v) && v >= 16 && v <= 2048) {
                          setConfig((prev) => ({ ...prev, targetHeight: v }));
                        }
                      }}
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                    />
                  </label>
                </div>
              </div>
            )}

            <div className="space-y-2 border-t border-slate-800 pt-2">
              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="pp-autotrim-toggle"
                  checked={config.autoTrim}
                  onChange={(e) => setConfig((prev) => ({ ...prev, autoTrim: e.target.checked }))}
                  className="accent-indigo-500"
                />
                Auto-Trim Transparent Border
              </label>

              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="pp-pot-toggle"
                  checked={config.padToPot}
                  onChange={(e) => setConfig((prev) => ({ ...prev, padToPot: e.target.checked }))}
                  className="accent-indigo-500"
                />
                Pad to Power-of-Two (PoT)
              </label>
            </div>
          </div>

          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/40 p-3 text-[11px] text-slate-400">
            <Layers className="h-3.5 w-3.5 shrink-0 text-indigo-400" />
            <span>
              Pivot placement and reproducible PNG + recipe ZIP export unlock in Milestone 6.
            </span>
          </div>
        </aside>
      </div>
    </div>
  );
}
