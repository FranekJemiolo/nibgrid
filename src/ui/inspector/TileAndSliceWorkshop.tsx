import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, Frame, Grid3X3, Layers, Sparkles, Wand2 } from 'lucide-react';
import { repository } from '../../db/database';
import type {
  ArtMode,
  NineSliceCenterMode,
  NineSliceConfig,
  NineSliceFillMode,
  Project,
  SeamlessTileConfig,
  SpriteNode,
} from '../../domain/schemas';
import { compilePrompt } from '../../domain/promptCompiler';
import { decodeBlobToNativeRgba } from '../../export/animationExporter';
import { autoDetectNineSliceMargins, renderNineSlice } from '../../processing/nineSlice';
import { resampleRgba } from '../../processing/resampleAndTrim';
import { rgbaToPngBlob } from '../../processing/png';
import {
  computeSeamContinuity,
  flattenMacroLighting,
  generateCrossSeamMask,
  wrapOffsetBuffer,
} from '../../processing/seamlessTile';
import type { RgbaBuffer } from '../../processing/types';
import { classifyProviderError } from '../../providers/errors';
import { offlineMockProvider } from '../../providers/mockProvider';
import { resolveProviderAdapter } from '../../providers/registry';
import { useAppStore } from '../../store/useAppStore';

export type TileSliceWorkshopMode = 'tile' | 'nineslice';

export interface TileAndSliceWorkshopProps {
  sprite: RgbaBuffer;
  artMode: ArtMode;
  project: Project;
  targetNode: SpriteNode;
  seamlessConfig: SeamlessTileConfig;
  nineSliceConfig: NineSliceConfig;
  onChangeSeamlessConfig: (updater: (prev: SeamlessTileConfig) => SeamlessTileConfig) => void;
  onChangeNineSliceConfig: (updater: (prev: NineSliceConfig) => NineSliceConfig) => void;
  onExportNineSliceZip: () => void;
  onSeamlessNodeCommitted: (
    newNode: SpriteNode,
    unwrappedBuffer: RgbaBuffer,
    updatedConfig: SeamlessTileConfig,
  ) => Promise<void>;
  exportSlot?: ReactNode;
}

type SeamWorkflowState =
  | { stage: 'idle' }
  | {
      stage: 'wrapped';
      wrapped: RgbaBuffer;
      maskRgba: RgbaBuffer;
      binaryMask: Uint8Array;
    }
  | {
      stage: 'inpainted';
      wrapped: RgbaBuffer;
      inpainted: RgbaBuffer;
      maskRgba: RgbaBuffer;
      binaryMask: Uint8Array;
    };

function putRgbaToCanvas(
  canvas: HTMLCanvasElement | null,
  buf: RgbaBuffer,
  pixelArt: boolean,
  overlayMask?: RgbaBuffer,
  overlayColor: readonly [number, number, number, number] = [244, 63, 94, 110],
): void {
  if (!canvas) return;
  if (canvas.width !== buf.width) canvas.width = buf.width;
  if (canvas.height !== buf.height) canvas.height = buf.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = !pixelArt;

  const out = new Uint8ClampedArray(buf.data);
  if (overlayMask && overlayMask.width === buf.width && overlayMask.height === buf.height) {
    const [or, og, ob, oa] = overlayColor;
    const alpha = oa / 255;
    for (let i = 0; i < buf.width * buf.height; i++) {
      if ((overlayMask.data[i * 4] ?? 0) > 127) {
        const p = i * 4;
        out[p] = Math.round((out[p] ?? 0) * (1 - alpha) + or * alpha);
        out[p + 1] = Math.round((out[p + 1] ?? 0) * (1 - alpha) + og * alpha);
        out[p + 2] = Math.round((out[p + 2] ?? 0) * (1 - alpha) + ob * alpha);
        out[p + 3] = 255;
      }
    }
  }

  ctx.putImageData(new ImageData(out, buf.width, buf.height), 0, 0);
}

export function TileAndSliceWorkshop({
  sprite,
  artMode,
  project,
  targetNode,
  seamlessConfig,
  nineSliceConfig,
  onChangeSeamlessConfig,
  onChangeNineSliceConfig,
  onExportNineSliceZip,
  onSeamlessNodeCommitted,
  exportSlot,
}: TileAndSliceWorkshopProps) {
  const { providers, selectedProviderId } = useAppStore();

  const [mode, setMode] = useState<TileSliceWorkshopMode>('tile');
  const [showGridlines, setShowGridlines] = useState(true);
  const [workflow, setWorkflow] = useState<SeamWorkflowState>({ stage: 'idle' });
  const [isInpainting, setIsInpainting] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [customBoxSize, setCustomBoxSize] = useState({ width: 160, height: 96 });

  const singleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tiledCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const nineSourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const widePreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tallPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const squarePreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const customPreviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const activeGuideDragRef = useRef<'left' | 'right' | 'top' | 'bottom' | null>(null);
  const resizeDragStartRef = useRef<{
    clientX: number;
    clientY: number;
    width: number;
    height: number;
  } | null>(null);

  // Reset pending wrap stage only if active sprite dimensions change externally
  useEffect(() => {
    setWorkflow((prev) => {
      if (prev.stage === 'idle') return prev;
      if (prev.wrapped.width !== sprite.width || prev.wrapped.height !== sprite.height) {
        return { stage: 'idle' };
      }
      return prev;
    });
  }, [sprite.width, sprite.height]);

  const previewTileBuffer = useMemo<RgbaBuffer>(() => {
    if (workflow.stage === 'inpainted') {
      return wrapOffsetBuffer(
        workflow.inpainted,
        Math.floor(sprite.width / 2),
        Math.floor(sprite.height / 2),
        true,
      );
    }
    if (workflow.stage === 'wrapped') {
      return wrapOffsetBuffer(
        workflow.wrapped,
        Math.floor(sprite.width / 2),
        Math.floor(sprite.height / 2),
        true,
      );
    }
    return seamlessConfig.flattenEnabled
      ? flattenMacroLighting(sprite, seamlessConfig.flattenRadiusPx)
      : sprite;
  }, [sprite, workflow, seamlessConfig.flattenEnabled, seamlessConfig.flattenRadiusPx]);

  const continuity = useMemo(() => computeSeamContinuity(previewTileBuffer), [previewTileBuffer]);
  const isPixelArt = artMode === 'pixel-art';

  // Render 1x1 source/wrapped+mask canvas
  useEffect(() => {
    if (mode !== 'tile') return;
    if (workflow.stage === 'wrapped') {
      putRgbaToCanvas(
        singleCanvasRef.current,
        workflow.wrapped,
        isPixelArt,
        workflow.maskRgba,
        [244, 63, 94, 120],
      );
    } else if (workflow.stage === 'inpainted') {
      putRgbaToCanvas(
        singleCanvasRef.current,
        workflow.inpainted,
        isPixelArt,
        workflow.maskRgba,
        [16, 185, 129, 75],
      );
    } else {
      putRgbaToCanvas(singleCanvasRef.current, previewTileBuffer, isPixelArt);
    }
  }, [mode, workflow, previewTileBuffer, isPixelArt]);

  // Render live 3x3 tiled preview wall
  useEffect(() => {
    if (mode !== 'tile') return;
    const canvas = tiledCanvasRef.current;
    if (!canvas) return;
    const w = previewTileBuffer.width;
    const h = previewTileBuffer.height;
    const wallW = w * 3;
    const wallH = h * 3;
    if (canvas.width !== wallW) canvas.width = wallW;
    if (canvas.height !== wallH) canvas.height = wallH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = !isPixelArt;

    const wall = new Uint8ClampedArray(wallW * wallH * 4);
    for (let ty = 0; ty < 3; ty++) {
      for (let tx = 0; tx < 3; tx++) {
        for (let y = 0; y < h; y++) {
          const dstY = ty * h + y;
          const srcStart = y * w * 4;
          const dstStart = (dstY * wallW + tx * w) * 4;
          wall.set(previewTileBuffer.data.subarray(srcStart, srcStart + w * 4), dstStart);
        }
      }
    }
    ctx.putImageData(new ImageData(wall, wallW, wallH), 0, 0);

    if (showGridlines) {
      ctx.strokeStyle = 'rgba(129, 140, 248, 0.55)';
      ctx.lineWidth = 1;
      for (let i = 1; i < 3; i++) {
        ctx.beginPath();
        ctx.moveTo(i * w + 0.5, 0);
        ctx.lineTo(i * w + 0.5, wallH);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(0, i * h + 0.5);
        ctx.lineTo(wallW, i * h + 0.5);
        ctx.stroke();
      }
    }
  }, [mode, previewTileBuffer, showGridlines, isPixelArt]);

  const handleWrapAndAutoMask = () => {
    setErrorMessage(null);
    const prepared = seamlessConfig.flattenEnabled
      ? flattenMacroLighting(sprite, seamlessConfig.flattenRadiusPx)
      : sprite;
    const wrapped = wrapOffsetBuffer(
      prepared,
      Math.floor(prepared.width / 2),
      Math.floor(prepared.height / 2),
      false,
    );
    const maskRgba = generateCrossSeamMask(wrapped.width, wrapped.height, {
      seamWidthPx: seamlessConfig.seamWidthPx,
      jitterPx: seamlessConfig.jitterPx,
      tileX: seamlessConfig.tileX,
      tileY: seamlessConfig.tileY,
      seed: targetNode.generationMeta.seed,
    });
    const binaryMask = new Uint8Array(wrapped.width * wrapped.height);
    let maskedCount = 0;
    for (let i = 0; i < binaryMask.length; i++) {
      if ((maskRgba.data[i * 4] ?? 0) > 127) {
        binaryMask[i] = 1;
        maskedCount += 1;
      }
    }

    onChangeSeamlessConfig((prev) => ({ ...prev, wrappedPendingUnwrap: true }));
    setWorkflow({ stage: 'wrapped', wrapped, maskRgba, binaryMask });
    setStatusMessage(
      `Wrapped 50% (+${Math.floor(wrapped.width / 2)}, +${Math.floor(wrapped.height / 2)}) and auto-masked ${maskedCount} center-cross pixels (outer 2px perimeter locked).`,
    );
  };

  const handleRunSeamInpaint = async () => {
    if (workflow.stage === 'idle' || isInpainting) return;
    setErrorMessage(null);
    setIsInpainting(true);
    setStatusMessage('Running seamless cross-seam inpaint...');

    const selected = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
    const resolved = selected ? resolveProviderAdapter(selected) : offlineMockProvider;
    const useMockFallback = !selected || !resolved.capabilities.supportsInpaint;
    const adapter = useMockFallback ? offlineMockProvider : resolved;
    const activeProviderConfig = selected!;

    try {
      const compiled = compilePrompt(project.artBible, {
        adherence: 'strict',
        promptDelta:
          'seamlessly blend only the center cross-seam texture with surrounding pixels; keep corners and outer perimeter identical',
      });

      const outputs = await adapter.inpaint({
        config: activeProviderConfig,
        artBible: project.artBible,
        sketchRgba: workflow.wrapped.data,
        baseImageRgba: workflow.wrapped.data,
        mask: workflow.binaryMask,
        sketchWidth: workflow.wrapped.width,
        sketchHeight: workflow.wrapped.height,
        sketchSha256: targetNode.sketchSha256,
        seed: targetNode.generationMeta.seed + 17,
        adherence: 'strict',
        promptDelta: 'heal center cross-seam seamlessly',
        compiledPrompt: compiled.fullCompiledPrompt,
        variantCount: 1,
        parentNode: targetNode,
      });

      const first = outputs[0];
      if (!first) {
        throw new Error('Inpaint provider returned zero images.');
      }

      let inpaintedRgba = first.rgba;
      if (first.width !== workflow.wrapped.width || first.height !== workflow.wrapped.height) {
        const decoded = await decodeBlobToNativeRgba(first.blob);
        inpaintedRgba =
          decoded.width === workflow.wrapped.width && decoded.height === workflow.wrapped.height
            ? decoded.rgba
            : resampleRgba(
                decoded.rgba,
                decoded.width,
                decoded.height,
                workflow.wrapped.width,
                workflow.wrapped.height,
                isPixelArt ? 'nearest' : 'area',
              ).rgba;
      }

      // Enforce hard outer 2px + unmasked pixel preservation on wrapped buffer
      const merged = new Uint8ClampedArray(workflow.wrapped.data);
      for (let i = 0; i < workflow.binaryMask.length; i++) {
        if (workflow.binaryMask[i] === 1) {
          const p = i * 4;
          merged[p] = inpaintedRgba[p] ?? merged[p] ?? 0;
          merged[p + 1] = inpaintedRgba[p + 1] ?? merged[p + 1] ?? 0;
          merged[p + 2] = inpaintedRgba[p + 2] ?? merged[p + 2] ?? 0;
          merged[p + 3] = inpaintedRgba[p + 3] ?? merged[p + 3] ?? 255;
        }
      }

      setWorkflow({
        stage: 'inpainted',
        wrapped: workflow.wrapped,
        inpainted: {
          width: workflow.wrapped.width,
          height: workflow.wrapped.height,
          data: merged,
        },
        maskRgba: workflow.maskRgba,
        binaryMask: workflow.binaryMask,
      });
      setStatusMessage(
        useMockFallback
          ? 'Healed cross-seam via Offline Mock inpaint fallback. Click Un-Wrap & Commit.'
          : `Healed cross-seam via ${adapter.displayName}. Click Un-Wrap & Commit.`,
      );
    } catch (error) {
      const classified =
        selected && !(error instanceof Error && error.message.includes('zero images'))
          ? classifyProviderError(error, {
              providerId: selected.id,
              providerKind: selected.kind,
              endpointUrl: selected.endpointUrl,
            })
          : error;
      setErrorMessage(classified instanceof Error ? classified.message : 'Seam inpaint failed.');
    } finally {
      setIsInpainting(false);
    }
  };

  const handleUnwrapAndCommit = async () => {
    if (workflow.stage === 'idle') return;
    setErrorMessage(null);
    const sourceWrapped = workflow.stage === 'inpainted' ? workflow.inpainted : workflow.wrapped;
    const unwrapped = wrapOffsetBuffer(
      sourceWrapped,
      Math.floor(sourceWrapped.width / 2),
      Math.floor(sourceWrapped.height / 2),
      true,
    );
    const finalReport = computeSeamContinuity(unwrapped);

    const pngBlob = rgbaToPngBlob(unwrapped.data, unwrapped.width, unwrapped.height);
    const imageBlobRecord = await repository.storeBlob(pngBlob, 'image/png');
    const maskBlob = rgbaToPngBlob(
      workflow.maskRgba.data,
      workflow.maskRgba.width,
      workflow.maskRgba.height,
    );
    const maskBlobRecord = await repository.storeBlob(maskBlob, 'image/png');

    const updatedSeamlessConfig: SeamlessTileConfig = {
      ...seamlessConfig,
      isSeamlessTile: true,
      wrappedPendingUnwrap: false,
      continuityScore: finalReport.score,
    };

    const newNode: SpriteNode = {
      id: globalThis.crypto.randomUUID(),
      projectId: project.id,
      parentId: targetNode.id,
      kind: 'inpaint',
      imageBlobId: imageBlobRecord.id,
      maskBlobId: maskBlobRecord.id,
      sketchSha256: targetNode.sketchSha256,
      seamlessTile: updatedSeamlessConfig,
      generationMeta: {
        providerId: selectedProviderId || targetNode.generationMeta.providerId,
        modelId: targetNode.generationMeta.modelId,
        seed: targetNode.generationMeta.seed + 17,
        adherence: 'strict',
        promptDelta: 'seamless 50% wrap-offset cross-seam heal',
        compiledPrompt: targetNode.generationMeta.compiledPrompt,
        createdAt: new Date().toISOString(),
      },
    };

    await repository.saveSpriteNode(newNode);
    await onSeamlessNodeCommitted(newNode, unwrapped, updatedSeamlessConfig);
    setWorkflow({ stage: 'idle' });
    setStatusMessage(
      `Committed seamless tile node to DAG (Continuity Score: ${finalReport.score}/100).`,
    );
  };

  const intZoom = isPixelArt
    ? Math.max(1, Math.min(4, Math.floor(240 / Math.max(sprite.width, sprite.height))))
    : 1;

  const updateMargin = (side: 'left' | 'right' | 'top' | 'bottom', rawValue: number) => {
    const clean = Math.max(0, Math.round(rawValue));
    onChangeNineSliceConfig((prev) => {
      const next = { ...prev, enabled: true };
      const maxX = Math.max(1, sprite.width - 1);
      const maxY = Math.max(1, sprite.height - 1);

      if (side === 'left') {
        const clampedL = Math.min(
          clean,
          next.lockHorizontal ? Math.floor(maxX / 2) : maxX - next.right,
        );
        return {
          ...next,
          left: Math.max(0, clampedL),
          ...(next.lockHorizontal ? { right: Math.max(0, clampedL) } : {}),
        };
      }
      if (side === 'right') {
        const clampedR = Math.min(
          clean,
          next.lockHorizontal ? Math.floor(maxX / 2) : maxX - next.left,
        );
        return {
          ...next,
          right: Math.max(0, clampedR),
          ...(next.lockHorizontal ? { left: Math.max(0, clampedR) } : {}),
        };
      }
      if (side === 'top') {
        const clampedT = Math.min(
          clean,
          next.lockVertical ? Math.floor(maxY / 2) : maxY - next.bottom,
        );
        return {
          ...next,
          top: Math.max(0, clampedT),
          ...(next.lockVertical ? { bottom: Math.max(0, clampedT) } : {}),
        };
      }
      const clampedB = Math.min(clean, next.lockVertical ? Math.floor(maxY / 2) : maxY - next.top);
      return {
        ...next,
        bottom: Math.max(0, clampedB),
        ...(next.lockVertical ? { top: Math.max(0, clampedB) } : {}),
      };
    });
  };

  const handleAutoDetectNineSlice = () => {
    const detected = autoDetectNineSliceMargins(sprite);
    onChangeNineSliceConfig((prev) => ({
      ...prev,
      enabled: true,
      left: detected.left,
      right: prev.lockHorizontal ? detected.left : detected.right,
      top: detected.top,
      bottom: prev.lockVertical ? detected.top : detected.bottom,
    }));
    setStatusMessage(
      `Auto-detected 9-slice margins (L:${detected.left} R:${detected.right} T:${detected.top} B:${detected.bottom}).`,
    );
  };

  const handleGuidePointerMove = (clientX: number, clientY: number) => {
    const active = activeGuideDragRef.current;
    const canvas = nineSourceCanvasRef.current;
    if (!active || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = Math.round(((clientX - rect.left) / Math.max(1, rect.width)) * sprite.width);
    const py = Math.round(((clientY - rect.top) / Math.max(1, rect.height)) * sprite.height);

    if (active === 'left') updateMargin('left', px);
    else if (active === 'right') updateMargin('right', sprite.width - px);
    else if (active === 'top') updateMargin('top', py);
    else updateMargin('bottom', sprite.height - py);
  };

  // Render 9-Slice guide canvas + Live Stress-Test Matrix
  useEffect(() => {
    if (mode !== 'nineslice') return;
    putRgbaToCanvas(nineSourceCanvasRef.current, sprite, isPixelArt);

    const targets: readonly [HTMLCanvasElement | null, number, number][] = [
      [widePreviewCanvasRef.current, 240, 48],
      [tallPreviewCanvasRef.current, 72, 220],
      [squarePreviewCanvasRef.current, 180, 180],
      [customPreviewCanvasRef.current, customBoxSize.width, customBoxSize.height],
    ];
    for (const [canvasEl, tw, th] of targets) {
      if (!canvasEl) continue;
      const sliced = renderNineSlice(sprite, tw, th, {
        left: nineSliceConfig.left,
        right: nineSliceConfig.right,
        top: nineSliceConfig.top,
        bottom: nineSliceConfig.bottom,
        edgeMode: nineSliceConfig.edgeMode,
        centerMode: nineSliceConfig.centerMode,
      });
      putRgbaToCanvas(canvasEl, sliced, isPixelArt);
    }
  }, [
    mode,
    sprite,
    isPixelArt,
    nineSliceConfig.left,
    nineSliceConfig.right,
    nineSliceConfig.top,
    nineSliceConfig.bottom,
    nineSliceConfig.edgeMode,
    nineSliceConfig.centerMode,
    customBoxSize.width,
    customBoxSize.height,
  ]);

  return (
    <div
      data-testid="tile-slice-workshop-panel"
      className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]"
    >
      {/* Left/Center Stage */}
      <section className="flex min-w-0 flex-col bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
          <div className="flex items-center gap-1.5 text-xs">
            <button
              type="button"
              data-testid="workshop-mode-tile"
              onClick={() => setMode('tile')}
              className={`rounded border px-2.5 py-1 text-xs font-medium ${
                mode === 'tile'
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
            >
              Seamless Tile (50% Wrap)
            </button>
            <button
              type="button"
              data-testid="workshop-mode-nineslice"
              onClick={() => {
                setMode('nineslice');
                onChangeNineSliceConfig((prev) => ({ ...prev, enabled: true }));
              }}
              className={`rounded border px-2.5 py-1 text-xs font-medium ${
                mode === 'nineslice'
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
            >
              9-Slice UI Panel
            </button>
          </div>

          {mode === 'tile' ? (
            <div className="flex items-center gap-3 text-xs">
              <label className="flex items-center gap-1.5 text-slate-300">
                <input
                  type="checkbox"
                  data-testid="seamless-gridlines-toggle"
                  checked={showGridlines}
                  onChange={(e) => setShowGridlines(e.target.checked)}
                  className="accent-indigo-500"
                />
                1×1 Gridlines
              </label>
              <span
                data-testid="seamless-score-badge"
                className="rounded border border-emerald-500/40 bg-emerald-950/40 px-2.5 py-0.5 font-mono text-[11px] text-emerald-200"
              >
                Score: {continuity.score}/100 · ΔH {continuity.horizontalDelta.toFixed(1)} · ΔV{' '}
                {continuity.verticalDelta.toFixed(1)}
              </span>
            </div>
          ) : (
            <span className="font-mono text-[11px] text-cyan-300">
              Drag guides (1px snap) · L:{nineSliceConfig.left} R:{nineSliceConfig.right} T:
              {nineSliceConfig.top} B:{nineSliceConfig.bottom}
            </span>
          )}
        </div>

        {mode === 'tile' ? (
          <div className="grid flex-1 grid-cols-1 gap-6 overflow-auto bg-checkerboard p-6 xl:grid-cols-2">
            <div className="flex flex-col items-center justify-center gap-2">
              <span className="text-[11px] font-medium text-slate-300">
                {workflow.stage === 'wrapped'
                  ? 'Wrapped 50% + Cross-Seam Mask (Outer 2px Locked)'
                  : workflow.stage === 'inpainted'
                    ? 'Wrapped Result After Cross-Seam Inpaint'
                    : '1×1 Tile Texture'}
              </span>
              <canvas
                ref={singleCanvasRef}
                data-testid="seamless-single-canvas"
                className="max-h-[360px] max-w-full rounded border border-slate-700 shadow-xl"
                style={{
                  width: `${sprite.width * intZoom}px`,
                  height: `${sprite.height * intZoom}px`,
                  imageRendering: isPixelArt ? 'pixelated' : 'auto',
                }}
              />
            </div>

            <div className="flex flex-col items-center justify-center gap-2">
              <span className="text-[11px] font-medium text-slate-300">
                Live 3×3 Tiled Preview (Macro-Lighting &amp; Seam Check)
              </span>
              <canvas
                ref={tiledCanvasRef}
                data-testid="seamless-tiled-canvas"
                className="max-h-[380px] max-w-full rounded border border-slate-700 shadow-2xl"
                style={{
                  width: `${Math.min(420, sprite.width * 3 * Math.max(1, Math.floor(intZoom / 2)))}px`,
                  imageRendering: isPixelArt ? 'pixelated' : 'auto',
                }}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col gap-5 overflow-auto bg-checkerboard p-5">
            {/* Top: 9-Slice Draggable Guide Editor */}
            <div className="flex flex-col items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/75 p-4">
              <span className="text-[11px] font-medium text-slate-300">
                9-Slice Margin Guides ({sprite.width}×{sprite.height})
              </span>
              <div
                data-testid="nineslice-guide-stage"
                onPointerMove={(e) => handleGuidePointerMove(e.clientX, e.clientY)}
                onPointerUp={() => {
                  activeGuideDragRef.current = null;
                }}
                onPointerCancel={() => {
                  activeGuideDragRef.current = null;
                }}
                className="relative inline-block overflow-hidden rounded border border-slate-700 select-none"
                style={{ touchAction: 'none' }}
              >
                <canvas
                  ref={nineSourceCanvasRef}
                  data-testid="nineslice-source-canvas"
                  className="block max-h-[240px] max-w-full"
                  style={{
                    width: `${sprite.width * intZoom}px`,
                    height: `${sprite.height * intZoom}px`,
                    imageRendering: isPixelArt ? 'pixelated' : 'auto',
                  }}
                />
                {/* Vertical Left Guide (Cyan) */}
                <div
                  data-testid="nineslice-guide-left"
                  onPointerDown={(e) => {
                    activeGuideDragRef.current = 'left';
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  className="absolute inset-y-0 z-10 w-2 -translate-x-1/2 cursor-ew-resize"
                  style={{ left: `${(nineSliceConfig.left / Math.max(1, sprite.width)) * 100}%` }}
                >
                  <div className="mx-auto h-full w-0.5 bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]" />
                </div>
                {/* Vertical Right Guide (Cyan) */}
                <div
                  data-testid="nineslice-guide-right"
                  onPointerDown={(e) => {
                    activeGuideDragRef.current = 'right';
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  className="absolute inset-y-0 z-10 w-2 -translate-x-1/2 cursor-ew-resize"
                  style={{
                    left: `${((sprite.width - nineSliceConfig.right) / Math.max(1, sprite.width)) * 100}%`,
                  }}
                >
                  <div className="mx-auto h-full w-0.5 bg-cyan-400 shadow-[0_0_6px_rgba(34,211,238,0.9)]" />
                </div>
                {/* Horizontal Top Guide (Magenta) */}
                <div
                  data-testid="nineslice-guide-top"
                  onPointerDown={(e) => {
                    activeGuideDragRef.current = 'top';
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  className="absolute inset-x-0 z-10 h-2 -translate-y-1/2 cursor-ns-resize"
                  style={{ top: `${(nineSliceConfig.top / Math.max(1, sprite.height)) * 100}%` }}
                >
                  <div className="my-auto h-0.5 w-full bg-fuchsia-400 shadow-[0_0_6px_rgba(232,121,249,0.9)]" />
                </div>
                {/* Horizontal Bottom Guide (Magenta) */}
                <div
                  data-testid="nineslice-guide-bottom"
                  onPointerDown={(e) => {
                    activeGuideDragRef.current = 'bottom';
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  className="absolute inset-x-0 z-10 h-2 -translate-y-1/2 cursor-ns-resize"
                  style={{
                    top: `${((sprite.height - nineSliceConfig.bottom) / Math.max(1, sprite.height)) * 100}%`,
                  }}
                >
                  <div className="my-auto h-0.5 w-full bg-fuchsia-400 shadow-[0_0_6px_rgba(232,121,249,0.9)]" />
                </div>
              </div>
            </div>

            {/* Bottom: Live Stress-Test Matrix */}
            <div className="rounded-lg border border-slate-800 bg-slate-950/75 p-4">
              <div className="mb-3 text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
                Live Stress-Test Matrix (Corners Stay Locked)
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
                <div className="flex flex-col items-center gap-1.5 rounded border border-slate-800 bg-slate-900/50 p-3">
                  <span className="font-mono text-[10px] text-slate-400">Wide Button (240×48)</span>
                  <canvas
                    ref={widePreviewCanvasRef}
                    data-testid="nineslice-preview-wide"
                    className="max-w-full border border-slate-700"
                    style={{ imageRendering: isPixelArt ? 'pixelated' : 'auto' }}
                  />
                </div>
                <div className="flex flex-col items-center gap-1.5 rounded border border-slate-800 bg-slate-900/50 p-3">
                  <span className="font-mono text-[10px] text-slate-400">
                    Tall Sidebar (72×220)
                  </span>
                  <canvas
                    ref={tallPreviewCanvasRef}
                    data-testid="nineslice-preview-tall"
                    className="max-h-[220px] max-w-full border border-slate-700"
                    style={{ imageRendering: isPixelArt ? 'pixelated' : 'auto' }}
                  />
                </div>
                <div className="flex flex-col items-center gap-1.5 rounded border border-slate-800 bg-slate-900/50 p-3">
                  <span className="font-mono text-[10px] text-slate-400">
                    Square Dialog (180×180)
                  </span>
                  <canvas
                    ref={squarePreviewCanvasRef}
                    data-testid="nineslice-preview-square"
                    className="max-h-[180px] max-w-full border border-slate-700"
                    style={{ imageRendering: isPixelArt ? 'pixelated' : 'auto' }}
                  />
                </div>
                <div className="flex flex-col items-center gap-1.5 rounded border border-slate-800 bg-slate-900/50 p-3">
                  <span className="font-mono text-[10px] text-slate-400">
                    Resizable ({customBoxSize.width}×{customBoxSize.height})
                  </span>
                  <div
                    onPointerMove={(e) => {
                      const drag = resizeDragStartRef.current;
                      if (!drag) return;
                      setCustomBoxSize({
                        width: Math.max(
                          40,
                          Math.min(280, Math.round(drag.width + (e.clientX - drag.clientX))),
                        ),
                        height: Math.max(
                          40,
                          Math.min(220, Math.round(drag.height + (e.clientY - drag.clientY))),
                        ),
                      });
                    }}
                    onPointerUp={() => {
                      resizeDragStartRef.current = null;
                    }}
                    className="relative inline-block"
                  >
                    <canvas
                      ref={customPreviewCanvasRef}
                      data-testid="nineslice-preview-custom"
                      className="max-w-full border border-slate-700"
                      style={{ imageRendering: isPixelArt ? 'pixelated' : 'auto' }}
                    />
                    <div
                      data-testid="nineslice-resize-handle"
                      onPointerDown={(e) => {
                        resizeDragStartRef.current = {
                          clientX: e.clientX,
                          clientY: e.clientY,
                          width: customBoxSize.width,
                          height: customBoxSize.height,
                        };
                        e.currentTarget.setPointerCapture(e.pointerId);
                      }}
                      title="Drag to resize stress test preview"
                      className="absolute -right-1.5 -bottom-1.5 h-3.5 w-3.5 cursor-nwse-resize rounded-xs border border-cyan-200 bg-cyan-500 shadow"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {errorMessage && (
          <div
            data-testid="seamless-error-banner"
            className="border-t border-rose-500/40 bg-rose-950/60 px-4 py-2 text-xs text-rose-200"
          >
            {errorMessage}
          </div>
        )}
        {statusMessage && !errorMessage && (
          <div
            data-testid="seamless-status-banner"
            className="border-t border-indigo-500/30 bg-indigo-950/30 px-4 py-1.5 text-[11px] text-indigo-200"
          >
            {statusMessage}
          </div>
        )}
      </section>

      {/* Right Pane */}
      <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
        {mode === 'tile' ? (
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs">
            <div className="flex items-center gap-2 font-semibold text-slate-200">
              <Grid3X3 className="h-3.5 w-3.5 text-indigo-400" />
              <span>Toroidal Seam Controls</span>
            </div>

            <div className="grid grid-cols-2 gap-2 text-slate-300">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="seamless-tile-x"
                  checked={seamlessConfig.tileX}
                  onChange={(e) =>
                    onChangeSeamlessConfig((prev) => ({ ...prev, tileX: e.target.checked }))
                  }
                  className="accent-indigo-500"
                />
                Tile X
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  data-testid="seamless-tile-y"
                  checked={seamlessConfig.tileY}
                  onChange={(e) =>
                    onChangeSeamlessConfig((prev) => ({ ...prev, tileY: e.target.checked }))
                  }
                  className="accent-indigo-500"
                />
                Tile Y
              </label>
            </div>

            <label className="block space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Seam Band Width</span>
                <span className="font-mono">{seamlessConfig.seamWidthPx} px</span>
              </div>
              <input
                type="range"
                data-testid="seamless-seam-width"
                min={16}
                max={96}
                step={2}
                value={seamlessConfig.seamWidthPx}
                onChange={(e) =>
                  onChangeSeamlessConfig((prev) => ({
                    ...prev,
                    seamWidthPx: Number.parseInt(e.target.value, 10),
                  }))
                }
                className="w-full accent-indigo-500"
              />
            </label>

            <label className="block space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Edge Jitter</span>
                <span className="font-mono">{seamlessConfig.jitterPx} px</span>
              </div>
              <input
                type="range"
                data-testid="seamless-jitter"
                min={0}
                max={12}
                step={1}
                value={seamlessConfig.jitterPx}
                onChange={(e) =>
                  onChangeSeamlessConfig((prev) => ({
                    ...prev,
                    jitterPx: Number.parseInt(e.target.value, 10),
                  }))
                }
                className="w-full accent-indigo-500"
              />
            </label>

            <label className="flex items-center gap-2 text-slate-300">
              <input
                type="checkbox"
                data-testid="seamless-flatten-toggle"
                checked={seamlessConfig.flattenEnabled}
                onChange={(e) =>
                  onChangeSeamlessConfig((prev) => ({
                    ...prev,
                    flattenEnabled: e.target.checked,
                  }))
                }
                className="accent-indigo-500"
              />
              High-Pass Macro-Lighting Flatten
            </label>

            <div className="space-y-2 border-t border-slate-800 pt-3">
              <button
                type="button"
                data-testid="seamless-wrap-mask-btn"
                onClick={handleWrapAndAutoMask}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-indigo-500/40 bg-indigo-600 px-3 py-2 font-semibold text-white hover:bg-indigo-500"
              >
                <Layers className="h-3.5 w-3.5" />
                1. Wrap 50% &amp; Auto-Mask for Inpaint
              </button>

              <button
                type="button"
                data-testid="seamless-inpaint-btn"
                disabled={workflow.stage === 'idle' || isInpainting}
                onClick={() => void handleRunSeamInpaint()}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-amber-500/40 bg-amber-600/90 px-3 py-2 font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Wand2 className="h-3.5 w-3.5" />
                {isInpainting ? 'Inpainting Center Cross...' : '2. Run Seam Inpaint'}
              </button>

              <button
                type="button"
                data-testid="seamless-unwrap-btn"
                disabled={workflow.stage === 'idle' || isInpainting}
                onClick={() => void handleUnwrapAndCommit()}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Sparkles className="h-3.5 w-3.5" />
                3. Un-Wrap Result &amp; Commit Node
              </button>
            </div>
          </div>
        ) : (
          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs">
            <div className="flex items-center gap-2 font-semibold text-slate-200">
              <Frame className="h-3.5 w-3.5 text-cyan-400" />
              <span>9-Slice UI Panel Controls</span>
            </div>

            <button
              type="button"
              data-testid="nineslice-autodetect-btn"
              onClick={handleAutoDetectNineSlice}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-950/40 px-3 py-1.5 font-medium text-cyan-200 hover:bg-cyan-900/50"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Auto-Detect Margins
            </button>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-slate-400">Left (px)</span>
                <input
                  type="number"
                  data-testid="nineslice-left"
                  min={0}
                  max={Math.max(0, sprite.width - 1)}
                  value={nineSliceConfig.left}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) updateMargin('left', v);
                  }}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-slate-100"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-400">Right (px)</span>
                <input
                  type="number"
                  data-testid="nineslice-right"
                  min={0}
                  max={Math.max(0, sprite.width - 1)}
                  value={nineSliceConfig.right}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) updateMargin('right', v);
                  }}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-slate-100"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-400">Top (px)</span>
                <input
                  type="number"
                  data-testid="nineslice-top"
                  min={0}
                  max={Math.max(0, sprite.height - 1)}
                  value={nineSliceConfig.top}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) updateMargin('top', v);
                  }}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-slate-100"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-400">Bottom (px)</span>
                <input
                  type="number"
                  data-testid="nineslice-bottom"
                  min={0}
                  max={Math.max(0, sprite.height - 1)}
                  value={nineSliceConfig.bottom}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) updateMargin('bottom', v);
                  }}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-slate-100"
                />
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2 text-slate-300">
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="nineslice-lock-lr"
                  checked={nineSliceConfig.lockHorizontal}
                  onChange={(e) =>
                    onChangeNineSliceConfig((prev) => ({
                      ...prev,
                      enabled: true,
                      lockHorizontal: e.target.checked,
                      ...(e.target.checked
                        ? { right: Math.min(prev.left, Math.floor((sprite.width - 1) / 2)) }
                        : {}),
                    }))
                  }
                  className="accent-cyan-500"
                />
                Lock L = R
              </label>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="nineslice-lock-tb"
                  checked={nineSliceConfig.lockVertical}
                  onChange={(e) =>
                    onChangeNineSliceConfig((prev) => ({
                      ...prev,
                      enabled: true,
                      lockVertical: e.target.checked,
                      ...(e.target.checked
                        ? { bottom: Math.min(prev.top, Math.floor((sprite.height - 1) / 2)) }
                        : {}),
                    }))
                  }
                  className="accent-fuchsia-500"
                />
                Lock T = B
              </label>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-slate-400">Edge Mode</span>
                <select
                  data-testid="nineslice-edge-mode"
                  value={nineSliceConfig.edgeMode}
                  onChange={(e) =>
                    onChangeNineSliceConfig((prev) => ({
                      ...prev,
                      enabled: true,
                      edgeMode: e.target.value as NineSliceFillMode,
                    }))
                  }
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                >
                  <option value="stretch">Stretch</option>
                  <option value="tile">Tile Repeat</option>
                </select>
              </label>

              <label className="space-y-1">
                <span className="text-slate-400">Center Mode</span>
                <select
                  data-testid="nineslice-center-mode"
                  value={nineSliceConfig.centerMode}
                  onChange={(e) =>
                    onChangeNineSliceConfig((prev) => ({
                      ...prev,
                      enabled: true,
                      centerMode: e.target.value as NineSliceCenterMode,
                    }))
                  }
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-100"
                >
                  <option value="stretch">Stretch</option>
                  <option value="tile">Tile Repeat</option>
                  <option value="transparent">Transparent Cutout</option>
                </select>
              </label>
            </div>

            <button
              type="button"
              data-testid="nineslice-export-zip-btn"
              onClick={onExportNineSliceZip}
              className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-500"
            >
              <Download className="h-3.5 w-3.5" />
              Export 9-Slice ZIP (.tres + JSON)
            </button>
          </div>
        )}

        {exportSlot}
      </aside>
    </div>
  );
}
