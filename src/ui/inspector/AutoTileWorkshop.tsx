import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { Dices, Download, Eraser, Grid, Paintbrush, RotateCcw, Save, Sparkles } from 'lucide-react';
import { repository } from '../../db/database';
import type {
  ArtMode,
  AutoTileConfig,
  AutoTileEdgeStyle,
  AutoTileMode,
  PostProcessConfig,
  Project,
  SpriteNode,
} from '../../domain/schemas';
import { packageAutoTileZip } from '../../export/autoTileExporters';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { computeAutoTileGridMask, type AutoTileSheetResult } from '../../processing/autoTile';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../../processing/png';
import { computeArtBibleHash } from '../../processing/projectAudit';
import type { RgbaBuffer } from '../../processing/types';
import {
  composeAutoTileInWorker,
  createMonotonicRequestGuard,
} from '../../workers/postprocessClient';
import { ScrubInput } from '../primitives/ScrubInput';

export interface AutoTileWorkshopProps {
  readonly sprite: RgbaBuffer;
  readonly artMode: ArtMode;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly spriteNodes: readonly SpriteNode[];
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly autoTileConfig: AutoTileConfig;
  readonly onChangeConfig: (next: AutoTileConfig) => void;
  readonly onSaveToProject: (config: AutoTileConfig) => Promise<void>;
}

const MAP_COLS = 12;
const MAP_ROWS = 8;

const SAMPLE_MAP_PATTERN = [
  '000000000000',
  '011111001100',
  '011111101100',
  '011011111100',
  '011111101000',
  '011111000000',
  '001110001110',
  '000000000000',
].join('');

function decodeMapBits(bits?: string): boolean[] {
  if (bits && bits.length === MAP_COLS * MAP_ROWS) {
    return Array.from(bits, (ch) => ch === '1');
  }
  return Array.from(SAMPLE_MAP_PATTERN, (ch) => ch === '1');
}

function encodeMapBits(grid: readonly boolean[]): string {
  return grid.map((cell) => (cell ? '1' : '0')).join('');
}

function toSquareTileBuffer(src: RgbaBuffer): RgbaBuffer {
  if (src.width === src.height) return src;
  const side = Math.max(1, Math.min(src.width, src.height));
  const ox = Math.floor((src.width - side) / 2);
  const oy = Math.floor((src.height - side) / 2);
  const data = new Uint8ClampedArray(side * side * 4);
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      const si = ((oy + y) * src.width + (ox + x)) * 4;
      const di = (y * side + x) * 4;
      data[di] = src.data[si] ?? 0;
      data[di + 1] = src.data[si + 1] ?? 0;
      data[di + 2] = src.data[si + 2] ?? 0;
      data[di + 3] = src.data[si + 3] ?? 255;
    }
  }
  return { width: side, height: side, data };
}

async function decodeBlobToRgba(blob: Blob): Promise<RgbaBuffer> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    const decoded = await decodePngBytesToRgba(bytes);
    return { width: decoded.width, height: decoded.height, data: decoded.rgba };
  } catch {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        width: bitmap.width,
        height: bitmap.height,
        data: new Uint8ClampedArray(data.data),
      };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

export function AutoTileWorkshop({
  sprite,
  artMode,
  project,
  targetNode,
  spriteNodes,
  postProcessConfig,
  rawWidth,
  rawHeight,
  autoTileConfig,
  onChangeConfig,
  onSaveToProject,
}: AutoTileWorkshopProps) {
  const [viewMode, setViewMode] = useState<'paint' | 'sheet'>('paint');
  const [brushMode, setBrushMode] = useState<'paint' | 'erase'>('paint');
  const [mapGrid, setMapGrid] = useState<boolean[]>(() =>
    decodeMapBits(autoTileConfig.sampleMapBits),
  );
  const [underlayBuffer, setUnderlayBuffer] = useState<RgbaBuffer | null>(null);
  const [sheetResult, setSheetResult] = useState<AutoTileSheetResult | null>(null);
  const [isComposing, setIsComposing] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const paintCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const sheetCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenSheetRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenUnderlayRef = useRef<HTMLCanvasElement | null>(null);
  const strokeModeRef = useRef<'paint' | 'erase' | null>(null);
  const requestGuardRef = useRef(createMonotonicRequestGuard());
  const syncedNodeIdRef = useRef<string | null>(null);

  const latestConfigRef = useRef(autoTileConfig);
  latestConfigRef.current = autoTileConfig;

  const squareFill = useMemo(() => toSquareTileBuffer(sprite), [sprite]);

  const underlayBlobId = useMemo(() => {
    if (!autoTileConfig.underlayNodeId) return undefined;
    const underlayNode = spriteNodes.find((n) => n.id === autoTileConfig.underlayNodeId);
    return underlayNode?.processedBlobId ?? underlayNode?.imageBlobId;
  }, [autoTileConfig.underlayNodeId, spriteNodes]);

  useEffect(() => {
    const guard = requestGuardRef.current;
    return () => {
      guard.invalidate();
      if (offscreenSheetRef.current) {
        offscreenSheetRef.current.width = 0;
        offscreenSheetRef.current.height = 0;
        offscreenSheetRef.current = null;
      }
      if (offscreenUnderlayRef.current) {
        offscreenUnderlayRef.current.width = 0;
        offscreenUnderlayRef.current.height = 0;
        offscreenUnderlayRef.current = null;
      }
    };
  }, []);

  // Re-sync paint map only when switching sprite nodes (never clobber user strokes on refresh)
  useEffect(() => {
    if (syncedNodeIdRef.current === targetNode.id) return;
    syncedNodeIdRef.current = targetNode.id;
    setMapGrid(decodeMapBits(targetNode.autoTile?.sampleMapBits));
    setStatusNotice(null);
  }, [targetNode.id, targetNode.autoTile?.sampleMapBits]);

  // Load selected underlay sprite buffer ONLY when resolved blob ID changes
  useEffect(() => {
    if (!underlayBlobId) {
      setUnderlayBuffer(null);
      return;
    }
    let cancelled = false;
    void repository.getBlob(underlayBlobId).then(async (rec) => {
      if (cancelled || !rec) return;
      try {
        const buf = await decodeBlobToRgba(rec.bytes);
        if (!cancelled) setUnderlayBuffer(buf);
      } catch {
        if (!cancelled) setUnderlayBuffer(null);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [underlayBlobId]);

  // Compose packed auto-tile sheet off-thread in Worker
  useEffect(() => {
    const guard = requestGuardRef.current;
    const token = guard.next();
    let cancelled = false;
    setIsComposing(true);
    setErrorMsg(null);

    void composeAutoTileInWorker({
      fill: {
        rgba: squareFill.data,
        width: squareFill.width,
        height: squareFill.height,
      },
      underlay: underlayBuffer
        ? {
            rgba: underlayBuffer.data,
            width: underlayBuffer.width,
            height: underlayBuffer.height,
          }
        : null,
      options: {
        mode: autoTileConfig.mode,
        edgeStyle: autoTileConfig.edgeStyle,
        borderWidthPx: autoTileConfig.borderWidthPx,
        cornerRadiusPx: autoTileConfig.cornerRadiusPx,
        jitterPx: autoTileConfig.jitterPx,
        edgeTintHex: autoTileConfig.edgeTintHex,
        seed: autoTileConfig.seed,
      },
    })
      .then((res) => {
        if (cancelled || !guard.isCurrent(token)) return;
        setSheetResult(res.result);
        setIsComposing(false);
      })
      .catch((err: unknown) => {
        if (cancelled || !guard.isCurrent(token)) return;
        setErrorMsg(err instanceof Error ? err.message : 'Auto-tile compose failed');
        setIsComposing(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    squareFill,
    underlayBuffer,
    autoTileConfig.mode,
    autoTileConfig.edgeStyle,
    autoTileConfig.borderWidthPx,
    autoTileConfig.cornerRadiusPx,
    autoTileConfig.jitterPx,
    autoTileConfig.edgeTintHex,
    autoTileConfig.seed,
  ]);

  // Cache offscreen Canvas2D sources whenever composed sheet or underlay changes
  useEffect(() => {
    if (!sheetResult) return;
    let offSheet = offscreenSheetRef.current;
    if (!offSheet) {
      offSheet = document.createElement('canvas');
      offscreenSheetRef.current = offSheet;
    }
    offSheet.width = sheetResult.sheet.width;
    offSheet.height = sheetResult.sheet.height;
    const octx = offSheet.getContext('2d');
    if (octx) {
      octx.putImageData(
        new ImageData(
          new Uint8ClampedArray(sheetResult.sheet.data),
          sheetResult.sheet.width,
          sheetResult.sheet.height,
        ),
        0,
        0,
      );
    }

    if (underlayBuffer) {
      let offUnder = offscreenUnderlayRef.current;
      if (!offUnder) {
        offUnder = document.createElement('canvas');
        offscreenUnderlayRef.current = offUnder;
      }
      offUnder.width = underlayBuffer.width;
      offUnder.height = underlayBuffer.height;
      const uctx = offUnder.getContext('2d');
      if (uctx) {
        uctx.putImageData(
          new ImageData(
            new Uint8ClampedArray(underlayBuffer.data),
            underlayBuffer.width,
            underlayBuffer.height,
          ),
          0,
          0,
        );
      }
    }
  }, [sheetResult, underlayBuffer]);

  // Render Live 12x8 Paint Map canvas
  useEffect(() => {
    if (viewMode !== 'paint' || !sheetResult) return;
    const canvas = paintCanvasRef.current;
    const offSheet = offscreenSheetRef.current;
    if (!canvas || !offSheet || offSheet.width === 0) return;

    const tileDisplay = Math.min(48, Math.max(24, sheetResult.tileSize));
    const widthPx = MAP_COLS * tileDisplay;
    const heightPx = MAP_ROWS * tileDisplay;
    if (canvas.width !== widthPx) canvas.width = widthPx;
    if (canvas.height !== heightPx) canvas.height = heightPx;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = artMode !== 'pixel-art';
    ctx.clearRect(0, 0, widthPx, heightPx);

    const tileSize = sheetResult.tileSize;
    for (let cy = 0; cy < MAP_ROWS; cy++) {
      for (let cx = 0; cx < MAP_COLS; cx++) {
        const idx = cy * MAP_COLS + cx;
        const dx = cx * tileDisplay;
        const dy = cy * tileDisplay;

        if (
          underlayBuffer &&
          offscreenUnderlayRef.current &&
          offscreenUnderlayRef.current.width > 0
        ) {
          ctx.drawImage(
            offscreenUnderlayRef.current,
            0,
            0,
            underlayBuffer.width,
            underlayBuffer.height,
            dx,
            dy,
            tileDisplay,
            tileDisplay,
          );
        }

        const isActive = mapGrid[idx] ?? false;
        const mask =
          autoTileConfig.mode === 'wang-16'
            ? computeAutoTileGridMask(mapGrid, MAP_COLS, MAP_ROWS, cx, cy, 'wang-16')
            : isActive
              ? computeAutoTileGridMask(mapGrid, MAP_COLS, MAP_ROWS, cx, cy, 'blob-47')
              : -1;

        if (mask >= 0) {
          const cellIdx = sheetResult.maskToCellIndex[mask];
          if (cellIdx !== undefined) {
            const cell = sheetResult.cells[cellIdx];
            if (cell) {
              ctx.drawImage(
                offSheet,
                cell.col * tileSize,
                cell.row * tileSize,
                tileSize,
                tileSize,
                dx,
                dy,
                tileDisplay,
                tileDisplay,
              );
            }
          }
        }
      }
    }
  }, [viewMode, sheetResult, mapGrid, autoTileConfig.mode, underlayBuffer, artMode]);

  // Render Full Packed Sheet canvas
  useEffect(() => {
    if (viewMode !== 'sheet' || !sheetResult) return;
    const canvas = sheetCanvasRef.current;
    if (!canvas) return;
    canvas.width = sheetResult.sheet.width;
    canvas.height = sheetResult.sheet.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(
      new ImageData(
        new Uint8ClampedArray(sheetResult.sheet.data),
        sheetResult.sheet.width,
        sheetResult.sheet.height,
      ),
      0,
      0,
    );
  }, [viewMode, sheetResult]);

  const applyCellPaint = useCallback(
    (clientX: number, clientY: number, mode: 'paint' | 'erase') => {
      const canvas = paintCanvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return;
      const cx = Math.max(
        0,
        Math.min(MAP_COLS - 1, Math.floor(((clientX - rect.left) / rect.width) * MAP_COLS)),
      );
      const cy = Math.max(
        0,
        Math.min(MAP_ROWS - 1, Math.floor(((clientY - rect.top) / rect.height) * MAP_ROWS)),
      );
      const val = mode === 'paint';
      setMapGrid((prev) => {
        const idx = cy * MAP_COLS + cx;
        if (prev[idx] === val) return prev;
        const next = [...prev];
        next[idx] = val;
        onChangeConfig({
          ...latestConfigRef.current,
          sampleMapBits: encodeMapBits(next),
        });
        return next;
      });
    },
    [onChangeConfig],
  );

  const handlePaintPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const eraseIntent = e.button === 2 || e.shiftKey || brushMode === 'erase';
    const strokeMode = eraseIntent ? 'erase' : 'paint';
    strokeModeRef.current = strokeMode;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Ignore synthetic events without active pointer
    }
    applyCellPaint(e.clientX, e.clientY, strokeMode);
  };

  const handlePaintPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    const strokeMode = strokeModeRef.current;
    if (!strokeMode) return;
    applyCellPaint(e.clientX, e.clientY, strokeMode);
  };

  const handlePaintPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!strokeModeRef.current) return;
    strokeModeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handleLoadSampleMap = () => {
    const next = decodeMapBits(SAMPLE_MAP_PATTERN);
    setMapGrid(next);
    onChangeConfig({
      ...autoTileConfig,
      sampleMapBits: encodeMapBits(next),
    });
    setStatusNotice('Loaded 12×8 sample terrain map with inner/outer corners.');
  };

  const handleClearMap = () => {
    const next = Array.from({ length: MAP_COLS * MAP_ROWS }, () => false);
    setMapGrid(next);
    onChangeConfig({
      ...autoTileConfig,
      sampleMapBits: encodeMapBits(next),
    });
    setStatusNotice('Cleared terrain map.');
  };

  const handleSave = async () => {
    const updated: AutoTileConfig = {
      ...autoTileConfig,
      sampleMapBits: encodeMapBits(mapGrid),
    };
    onChangeConfig(updated);
    await onSaveToProject(updated);
    setStatusNotice(`Saved ${updated.mode.toUpperCase()} auto-tile recipe & 12×8 map to project.`);
  };

  const handleDownloadBundle = () => {
    if (!sheetResult) return;
    const updatedConfig: AutoTileConfig = {
      ...autoTileConfig,
      sampleMapBits: encodeMapBits(mapGrid),
    };
    const slug = toAssetSlug(
      `${project.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`,
    );
    const pngBytes = encodeRgbaToPngBytes(
      sheetResult.sheet.data,
      sheetResult.sheet.width,
      sheetResult.sheet.height,
    );
    const recipe = buildAssetRecipe({
      project,
      node: targetNode,
      postProcess: postProcessConfig,
      filename: `${slug}.png`,
      outputWidth: sprite.width,
      outputHeight: sprite.height,
      normalizedWidth: rawWidth,
      normalizedHeight: rawHeight,
      assetClass: 'tile',
      autoTile: updatedConfig,
      recipeArtBibleHash: computeArtBibleHash(project.artBible),
    });
    const zipBytes = packageAutoTileZip({
      assetSlug: slug,
      sheetPngBytes: pngBytes,
      tileSize: sheetResult.tileSize,
      columns: sheetResult.columns,
      rows: sheetResult.rows,
      mode: updatedConfig.mode,
      cells: sheetResult.cells,
      recipe,
    });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'application/zip' }),
      `${slug}_autotile_${updatedConfig.mode}.zip`,
    );
    setStatusNotice(
      `Downloaded ${slug}_autotile_${updatedConfig.mode}.zip (PNG + Godot .tres + Tiled .tsx + recipe.json)`,
    );
  };

  const otherNodes = spriteNodes.filter((n) => n.id !== targetNode.id);

  return (
    <div
      data-testid="autotile-workshop-panel"
      className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_288px]"
    >
      {/* Left: Interactive 12x8 Paint-Test Sandbox & Packed Sheet Preview */}
      <section className="flex min-w-0 flex-col bg-[var(--bg-well)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="autotile-view-paint"
              onClick={() => setViewMode('paint')}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                viewMode === 'paint'
                  ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                  : 'border border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-slate-300 hover:text-white'
              }`}
            >
              <Paintbrush className="h-3.5 w-3.5" />
              Live 12×8 Paint Map
            </button>
            <button
              type="button"
              data-testid="autotile-view-sheet"
              onClick={() => setViewMode('sheet')}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                viewMode === 'sheet'
                  ? 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]'
                  : 'border border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-slate-300 hover:text-white'
              }`}
            >
              <Grid className="h-3.5 w-3.5" />
              Full Packed Sheet
            </button>
          </div>

          <div className="flex items-center gap-2">
            {viewMode === 'paint' && (
              <div className="flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-0.5">
                <button
                  type="button"
                  data-testid="autotile-brush-paint"
                  onClick={() => setBrushMode('paint')}
                  className={`rounded px-2 py-0.5 text-[11px] font-medium ${
                    brushMode === 'paint'
                      ? 'bg-emerald-600 text-white'
                      : 'text-[var(--text-muted)] hover:text-white'
                  }`}
                >
                  Paint
                </button>
                <button
                  type="button"
                  data-testid="autotile-brush-erase"
                  onClick={() => setBrushMode('erase')}
                  className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-medium ${
                    brushMode === 'erase'
                      ? 'bg-rose-600 text-white'
                      : 'text-[var(--text-muted)] hover:text-white'
                  }`}
                >
                  <Eraser className="h-3 w-3" />
                  Erase
                </button>
              </div>
            )}

            {sheetResult && (
              <span
                data-testid="autotile-meta-badge"
                className="tabular-nums rounded border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-[#F5B82E]"
              >
                {autoTileConfig.mode === 'blob-47' ? 'Blob-47' : 'Wang-16'} · {sheetResult.columns}×
                {sheetResult.rows} · {sheetResult.sheet.width}×{sheetResult.sheet.height}
              </span>
            )}
          </div>
        </div>

        <div className="bg-checkerboard flex flex-1 flex-col items-center justify-center overflow-auto p-6">
          {errorMsg && (
            <div className="mb-3 rounded border border-rose-500/40 bg-rose-950/70 px-3 py-1.5 text-xs text-rose-200">
              {errorMsg}
            </div>
          )}

          {viewMode === 'paint' ? (
            <div className="space-y-2 text-center">
              <div className="relative inline-block w-full max-w-[640px]">
                <canvas
                  ref={paintCanvasRef}
                  data-testid="autotile-paint-canvas"
                  onContextMenu={(e) => e.preventDefault()}
                  onPointerDown={handlePaintPointerDown}
                  onPointerMove={handlePaintPointerMove}
                  onPointerUp={handlePaintPointerUp}
                  onPointerCancel={handlePaintPointerUp}
                  className={`pixelated block w-full touch-none rounded border border-[var(--border-hairline)] bg-black/25 shadow-2xl ${
                    brushMode === 'erase' ? 'cursor-not-allowed' : 'cursor-crosshair'
                  }`}
                  style={{ aspectRatio: `${MAP_COLS} / ${MAP_ROWS}` }}
                />
                <div
                  className="pointer-events-none absolute inset-0 rounded"
                  style={{
                    backgroundSize: `calc(100% / ${MAP_COLS}) calc(100% / ${MAP_ROWS})`,
                    backgroundImage:
                      'linear-gradient(to right, rgba(228, 228, 231, 0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(228, 228, 231, 0.14) 1px, transparent 1px)',
                  }}
                />
              </div>
              <p className="text-[11px] text-[var(--text-muted)]">
                Left-click / drag to paint terrain · Right-click or Shift+drag to erase ({MAP_COLS}×
                {MAP_ROWS} live bitmask resolver · {isComposing ? 'Composing...' : 'Ready'})
              </p>
            </div>
          ) : (
            <div className="space-y-2 text-center">
              <canvas
                ref={sheetCanvasRef}
                data-testid="autotile-sheet-canvas"
                className="pixelated max-h-[480px] max-w-full rounded border border-[var(--border-hairline)] bg-black/25 shadow-2xl"
                style={
                  sheetResult
                    ? { aspectRatio: `${sheetResult.columns} / ${sheetResult.rows}` }
                    : undefined
                }
              />
              {sheetResult && (
                <p className="font-mono text-[11px] text-[var(--text-muted)]">
                  {sheetResult.cells.length} packed tiles ({sheetResult.tileSize}×
                  {sheetResult.tileSize} each)
                </p>
              )}
            </div>
          )}
        </div>

        {statusNotice && (
          <div
            data-testid="autotile-save-notice"
            className="border-t border-[var(--accent-primary)]/30 bg-[var(--bg-panel)] px-4 py-1.5 text-[11px] text-[#F5B82E]"
          >
            {statusNotice}
          </div>
        )}
      </section>

      {/* Right: 288px Auto-Tile Parameters & Engine Bundle Export */}
      <aside className="space-y-3 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3 text-xs lg:border-t-0 lg:border-l">
        <div className="space-y-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3">
          <div className="flex items-center gap-1.5 font-semibold text-slate-200">
            <Sparkles className="h-3.5 w-3.5 text-[var(--accent-primary)]" />
            <span>Auto-Tile Rule Set</span>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            {(
              [
                ['blob-47', 'Blob-47 (8×6)'],
                ['wang-16', 'Wang-16 (4×4)'],
              ] as const
            ).map(([modeKey, label]) => (
              <button
                key={modeKey}
                type="button"
                data-testid={`autotile-mode-${modeKey}`}
                onClick={() => onChangeConfig({ ...autoTileConfig, mode: modeKey as AutoTileMode })}
                className={`rounded border px-2 py-1.5 text-[11px] font-medium transition-colors ${
                  autoTileConfig.mode === modeKey
                    ? 'border-[var(--accent-primary)] bg-[var(--accent-primary)]/20 text-[#F5B82E]'
                    : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-slate-300 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] text-[var(--text-muted)]">Edge Treatment Style</span>
            <select
              data-testid="autotile-edge-style"
              value={autoTileConfig.edgeStyle}
              onChange={(e) =>
                onChangeConfig({
                  ...autoTileConfig,
                  edgeStyle: e.target.value as AutoTileEdgeStyle,
                })
              }
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs text-slate-100"
            >
              <option value="organic-overhang">Organic Overhang (Deterministic Jitter)</option>
              <option value="crisp-bevel">Crisp Bevel (Lit / Shadow Rim)</option>
              <option value="pixel-outline">Pixel Outline (1px Contour)</option>
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] text-[var(--text-muted)]">Underlay Terrain Sprite</span>
            <select
              data-testid="autotile-underlay-select"
              value={autoTileConfig.underlayNodeId ?? ''}
              onChange={(e) =>
                onChangeConfig({
                  ...autoTileConfig,
                  underlayNodeId: e.target.value || undefined,
                })
              }
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1.5 text-xs text-slate-100"
            >
              <option value="">Transparent (Alpha Cutout)</option>
              {otherNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.kind} #{n.generationMeta.seed} ({n.generationMeta.promptDelta.slice(0, 18)})
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3">
          <div className="font-semibold text-slate-200">SDF Transition Geometry</div>

          <ScrubInput
            label="Border Inset"
            value={autoTileConfig.borderWidthPx}
            min={0}
            max={16}
            step={0.5}
            decimals={1}
            unit="px"
            testId="autotile-scrub-border"
            onChange={(next) => onChangeConfig({ ...autoTileConfig, borderWidthPx: next })}
          />
          <ScrubInput
            label="Corner Radius"
            value={autoTileConfig.cornerRadiusPx}
            min={0}
            max={16}
            step={0.5}
            decimals={1}
            unit="px"
            testId="autotile-scrub-radius"
            onChange={(next) => onChangeConfig({ ...autoTileConfig, cornerRadiusPx: next })}
          />
          <ScrubInput
            label="Organic Jitter"
            value={autoTileConfig.jitterPx}
            min={0}
            max={8}
            step={0.25}
            decimals={2}
            unit="px"
            testId="autotile-scrub-jitter"
            onChange={(next) => onChangeConfig({ ...autoTileConfig, jitterPx: next })}
          />

          <div className="grid grid-cols-2 gap-2 pt-1">
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">Edge Tint</span>
              <input
                type="color"
                data-testid="autotile-tint-picker"
                value={autoTileConfig.edgeTintHex}
                onChange={(e) =>
                  onChangeConfig({
                    ...autoTileConfig,
                    edgeTintHex: e.target.value.toUpperCase(),
                  })
                }
                className="h-7 w-full cursor-pointer rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)]"
              />
            </label>
            <label className="space-y-1">
              <span className="text-[11px] text-[var(--text-muted)]">Seed</span>
              <div className="flex gap-1">
                <input
                  type="number"
                  min={0}
                  value={autoTileConfig.seed}
                  onChange={(e) => {
                    const s = Number.parseInt(e.target.value, 10);
                    if (Number.isFinite(s) && s >= 0) {
                      onChangeConfig({ ...autoTileConfig, seed: s });
                    }
                  }}
                  className="tabular-nums w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-xs text-slate-100"
                />
                <button
                  type="button"
                  onClick={() =>
                    onChangeConfig({
                      ...autoTileConfig,
                      seed: (autoTileConfig.seed + 137) % 100000,
                    })
                  }
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 text-slate-300 hover:text-white"
                  title="Shuffle deterministic jitter seed"
                >
                  <Dices className="h-3.5 w-3.5" />
                </button>
              </div>
            </label>
          </div>
        </div>

        <div className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3">
          <div className="font-semibold text-slate-200">Sandbox &amp; Export</div>
          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="autotile-load-sample-btn"
              onClick={handleLoadSampleMap}
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
            >
              Load Sample Map
            </button>
            <button
              type="button"
              data-testid="autotile-clear-map-btn"
              onClick={handleClearMap}
              className="inline-flex items-center justify-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1.5 text-[11px] font-medium text-slate-300 hover:bg-slate-700"
            >
              <RotateCcw className="h-3 w-3" />
              Clear Map
            </button>
          </div>

          <button
            type="button"
            data-testid="autotile-save-btn"
            onClick={() => void handleSave()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
          >
            <Save className="h-3.5 w-3.5" />
            Save to Project
          </button>

          <button
            type="button"
            data-testid="autotile-download-zip-btn"
            disabled={!sheetResult}
            onClick={handleDownloadBundle}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[var(--accent-primary)] px-3 py-2 text-xs font-semibold text-[var(--accent-primary-fg)] hover:bg-[var(--accent-primary-hover)] disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Download Terrain Bundle (.zip)
          </button>
        </div>
      </aside>
    </div>
  );
}
