import type { PostProcessConfig } from '../domain/schemas';
import {
  composeAutoTileSheet,
  type AutoTileOptions,
  type AutoTileSheetResult,
} from '../processing/autoTile';
import { removeBackgroundColorKey } from '../processing/backgroundKey';
import {
  bakeBitmapFontAtlas,
  type BakedBitmapFont,
  type BitmapFontStyleOptions,
  type GlyphMask,
} from '../processing/bitmapFont';
import type { DetectedGrid } from '../processing/demixel';
import { sha256Bytes } from '../processing/hash';
import { processSingleParallaxLayer, type RgbTuple } from '../processing/parallaxCompositor';
import { runPostProcessPipeline } from '../processing/pipeline';
import { encodeRgbaToPngBytes } from '../processing/png';
import {
  sliceAndAlignTurnaround,
  type TurnaroundSliceOptions,
  type TurnaroundSliceResult,
} from '../processing/turnaroundSlicer';
import {
  bakeVfxFlipbook,
  type VfxFlipbookOptions,
  type VfxFlipbookResult,
} from '../processing/vfxFlipbook';

export interface PostProcessWorkerRequest {
  type?: 'POST_PROCESS';
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  config: PostProcessConfig;
  paletteHex: readonly string[];
}

export interface SliceTurnaroundWorkerRequest {
  type: 'SLICE_TURNAROUND_SHEET';
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  removeBackground?: boolean;
  bgTolerance?: number;
  options: TurnaroundSliceOptions;
}

export interface ComposeAutoTileWorkerRequest {
  type: 'COMPOSE_AUTO_TILE_SHEET';
  id: number;
  fill: {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
  };
  underlay: {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
  } | null;
  options: AutoTileOptions;
}

export interface BakeVfxFlipbookWorkerRequest {
  type: 'BAKE_VFX_FLIPBOOK';
  id: number;
  options: Omit<VfxFlipbookOptions, 'sourceSprite'>;
  sourceSprite: {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
  } | null;
}

export interface ProcessParallaxLayerWorkerRequest {
  type: 'PROCESS_PARALLAX_LAYER';
  id: number;
  layerId: string;
  layerName: string;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  scrollRatioX: number;
  yOffsetPx: number;
  seamBlendPx: number;
  depthHaze: number;
  visible: boolean;
  horizonRgb: RgbTuple;
  contrastDampening: number;
  stripChromaKey?: boolean;
  chromaTolerance?: number;
  paletteHex?: readonly string[];
  snapToPalette?: boolean;
}

export interface BakeBitmapFontWorkerRequest {
  type: 'BAKE_BITMAP_FONT';
  id: number;
  masks: GlyphMask[];
  options: BitmapFontStyleOptions;
}

export type AnyPostProcessWorkerRequest =
  | PostProcessWorkerRequest
  | SliceTurnaroundWorkerRequest
  | ComposeAutoTileWorkerRequest
  | BakeVfxFlipbookWorkerRequest
  | ProcessParallaxLayerWorkerRequest
  | BakeBitmapFontWorkerRequest;

export interface PostProcessWorkerProgress {
  id: number;
  type: 'progress';
  phase: string;
  progress: number;
}

export interface PostProcessWorkerSuccess {
  id: number;
  type: 'result';
  ok: true;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  pngBytes: Uint8Array;
  sha256: string;
  detectedGrid?: DetectedGrid;
  orphanStats?: {
    removedIslands: number;
    cleanedSpecks: number;
  };
}

export interface SliceTurnaroundWorkerSuccess {
  id: number;
  type: 'slice-result';
  ok: true;
  cleanedSheetRgba: Uint8ClampedArray;
  sheetWidth: number;
  sheetHeight: number;
  result: TurnaroundSliceResult;
}

export interface ComposeAutoTileWorkerSuccess {
  id: number;
  type: 'autotile-result';
  ok: true;
  result: AutoTileSheetResult;
}

export interface BakeVfxFlipbookWorkerSuccess {
  id: number;
  type: 'vfx-result';
  ok: true;
  result: VfxFlipbookResult;
}

export interface ProcessParallaxLayerWorkerSuccess {
  id: number;
  type: 'parallax-result';
  ok: true;
  layerId: string;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface BakeBitmapFontWorkerSuccess {
  id: number;
  type: 'bmfont-result';
  ok: true;
  result: BakedBitmapFont;
}

export interface PostProcessWorkerFailure {
  id: number;
  type:
    | 'result'
    | 'slice-result'
    | 'autotile-result'
    | 'vfx-result'
    | 'parallax-result'
    | 'bmfont-result';
  ok: false;
  error: string;
}

export type PostProcessWorkerMessage =
  | PostProcessWorkerProgress
  | PostProcessWorkerSuccess
  | SliceTurnaroundWorkerSuccess
  | ComposeAutoTileWorkerSuccess
  | BakeVfxFlipbookWorkerSuccess
  | ProcessParallaxLayerWorkerSuccess
  | BakeBitmapFontWorkerSuccess
  | PostProcessWorkerFailure;

type ProgressReporter = (phase: string, progress: number) => void;

interface TransformersSegmentationOutput {
  mask?: {
    data: Uint8Array | Uint8ClampedArray | Float32Array;
    width: number;
    height: number;
  };
}

let cachedSegmenterPromise: Promise<
  (image: unknown) => Promise<TransformersSegmentationOutput[]>
> | null = null;

async function detectWebGpuSupport(): Promise<boolean> {
  try {
    const nav = navigator as Navigator & {
      gpu?: { requestAdapter?: () => Promise<unknown> };
    };
    if (!nav.gpu?.requestAdapter) return false;
    const adapter = await nav.gpu.requestAdapter();
    return adapter !== null && adapter !== undefined;
  } catch {
    return false;
  }
}

async function runLocalAiBackgroundRemoval(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  reportProgress?: ProgressReporter,
): Promise<Uint8ClampedArray> {
  reportProgress?.('Initializing local ONNX runtime...', 0.05);
  const transformers = await import('@huggingface/transformers');
  const { env, pipeline, RawImage } = transformers;

  env.allowLocalModels = false;
  env.useBrowserCache = true;
  if (env.backends?.onnx?.wasm) {
    // Strictly single-threaded WASM fallback so COEP headers are never required
    env.backends.onnx.wasm.numThreads = 1;
  }

  if (!cachedSegmenterPromise) {
    const hasWebGpu = await detectWebGpuSupport();
    const device = hasWebGpu ? 'webgpu' : 'wasm';
    reportProgress?.(`Loading cutout model (${device})...`, 0.15);

    cachedSegmenterPromise = (
      pipeline as unknown as (
        task: string,
        model: string,
        opts: Record<string, unknown>,
      ) => Promise<(image: unknown) => Promise<TransformersSegmentationOutput[]>>
    )('image-segmentation', 'briaai/RMBG-1.4', {
      device,
      progress_callback: (info: { status?: string; progress?: number }) => {
        if (typeof info.progress === 'number') {
          reportProgress?.(
            info.status || 'Downloading cutout model...',
            Math.max(0.15, Math.min(0.85, info.progress / 100)),
          );
        }
      },
    });
  }

  const segmenter = await cachedSegmenterPromise;
  reportProgress?.('Running local foreground segmentation...', 0.9);
  const inputImage = new RawImage(new Uint8ClampedArray(rgba), width, height, 4);
  const results = await segmenter(inputImage);
  const mask = results[0]?.mask;
  if (!mask) {
    throw new Error('Local AI segmentation returned no foreground mask.');
  }

  const out = new Uint8ClampedArray(rgba);
  const maskData = mask.data;
  const maskW = mask.width;
  const maskH = mask.height;

  for (let y = 0; y < height; y++) {
    const my = Math.min(maskH - 1, Math.floor((y * maskH) / height));
    for (let x = 0; x < width; x++) {
      const mx = Math.min(maskW - 1, Math.floor((x * maskW) / width));
      const rawVal = maskData[my * maskW + mx] ?? 0;
      const alphaFactor = rawVal > 1 ? rawVal / 255 : rawVal;
      const px = (y * width + x) * 4;
      out[px + 3] = Math.round((out[px + 3] ?? 255) * Math.max(0, Math.min(1, alphaFactor)));
    }
  }

  reportProgress?.('Cutout complete', 1);
  return out;
}

export async function executePostProcessJob(
  req: PostProcessWorkerRequest,
  reportProgress?: ProgressReporter,
): Promise<PostProcessWorkerSuccess> {
  let baseRgba = req.rgba;
  let effectiveConfig = req.config;

  if (req.config.bgRemoval === 'ai-rembg') {
    baseRgba = await runLocalAiBackgroundRemoval(req.rgba, req.width, req.height, reportProgress);
    effectiveConfig = { ...req.config, bgRemoval: 'none' };
  }

  const processed = runPostProcessPipeline(
    baseRgba,
    req.width,
    req.height,
    effectiveConfig,
    req.paletteHex,
  );
  const pngBytes = encodeRgbaToPngBytes(processed.rgba, processed.width, processed.height);
  const sha256 = await sha256Bytes(pngBytes);

  return {
    id: req.id,
    type: 'result',
    ok: true,
    rgba: processed.rgba,
    width: processed.width,
    height: processed.height,
    pngBytes,
    sha256,
    detectedGrid: processed.detectedGrid,
    orphanStats: processed.orphanStats,
  };
}

export function executeSliceTurnaroundJob(
  req: SliceTurnaroundWorkerRequest,
): SliceTurnaroundWorkerSuccess {
  const cornerAlpha = req.rgba[3] ?? 0;
  const shouldKeyBg = req.removeBackground !== false && cornerAlpha >= 128;
  const cleanedSheetRgba = shouldKeyBg
    ? removeBackgroundColorKey(req.rgba, req.width, req.height, {
        tolerance: req.bgTolerance ?? 20,
        contiguous: true,
      })
    : new Uint8ClampedArray(req.rgba);

  const result = sliceAndAlignTurnaround(
    { width: req.width, height: req.height, data: cleanedSheetRgba },
    req.options,
  );

  return {
    id: req.id,
    type: 'slice-result',
    ok: true,
    cleanedSheetRgba,
    sheetWidth: req.width,
    sheetHeight: req.height,
    result,
  };
}

export function executeComposeAutoTileJob(
  req: ComposeAutoTileWorkerRequest,
): ComposeAutoTileWorkerSuccess {
  const result = composeAutoTileSheet(
    { width: req.fill.width, height: req.fill.height, data: req.fill.rgba },
    req.underlay
      ? { width: req.underlay.width, height: req.underlay.height, data: req.underlay.rgba }
      : null,
    req.options,
  );
  return {
    id: req.id,
    type: 'autotile-result',
    ok: true,
    result,
  };
}

export function executeBakeVfxFlipbookJob(
  req: BakeVfxFlipbookWorkerRequest,
): BakeVfxFlipbookWorkerSuccess {
  const result = bakeVfxFlipbook({
    ...req.options,
    sourceSprite: req.sourceSprite
      ? {
          width: req.sourceSprite.width,
          height: req.sourceSprite.height,
          data: req.sourceSprite.rgba,
        }
      : null,
  });
  return {
    id: req.id,
    type: 'vfx-result',
    ok: true,
    result,
  };
}

export function executeProcessParallaxLayerJob(
  req: ProcessParallaxLayerWorkerRequest,
): ProcessParallaxLayerWorkerSuccess {
  const processed = processSingleParallaxLayer(
    {
      id: req.layerId,
      name: req.layerName,
      source: { width: req.width, height: req.height, data: req.rgba },
      scrollRatioX: req.scrollRatioX,
      yOffsetPx: req.yOffsetPx,
      seamBlendPx: req.seamBlendPx,
      depthHaze: req.depthHaze,
      visible: req.visible,
      stripChromaKey: req.stripChromaKey,
      chromaTolerance: req.chromaTolerance,
    },
    {
      horizonRgb: req.horizonRgb,
      contrastDampening: req.contrastDampening,
      paletteHex: req.paletteHex,
      snapToPalette: req.snapToPalette,
    },
  );
  return {
    id: req.id,
    type: 'parallax-result',
    ok: true,
    layerId: req.layerId,
    rgba: processed.buffer.data,
    width: processed.buffer.width,
    height: processed.buffer.height,
  };
}

export function executeBakeBitmapFontJob(
  req: BakeBitmapFontWorkerRequest,
): BakeBitmapFontWorkerSuccess {
  const result = bakeBitmapFontAtlas(req.masks, req.options);
  return {
    id: req.id,
    type: 'bmfont-result',
    ok: true,
    result,
  };
}

interface WorkerPostScope {
  onmessage: ((event: MessageEvent<AnyPostProcessWorkerRequest>) => void) | null;
  postMessage: (message: PostProcessWorkerMessage, transfer?: Transferable[]) => void;
}

if (
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  const workerSelf = self as unknown as WorkerPostScope;
  workerSelf.onmessage = async (event: MessageEvent<AnyPostProcessWorkerRequest>) => {
    const req = event.data;
    if (req.type === 'BAKE_BITMAP_FONT') {
      try {
        const res = executeBakeBitmapFontJob(req);
        const transfers = new Set<Transferable>();
        if (res.result.atlas.data.buffer instanceof ArrayBuffer) {
          transfers.add(res.result.atlas.data.buffer);
        }
        workerSelf.postMessage(res, [...transfers]);
      } catch (error) {
        workerSelf.postMessage({
          id: req.id,
          type: 'bmfont-result',
          ok: false,
          error: error instanceof Error ? error.message : 'Bitmap font bake failed',
        });
      }
      return;
    }

    if (req.type === 'PROCESS_PARALLAX_LAYER') {
      try {
        const res = executeProcessParallaxLayerJob(req);
        const transfers = new Set<Transferable>();
        if (res.rgba.buffer instanceof ArrayBuffer) {
          transfers.add(res.rgba.buffer);
        }
        workerSelf.postMessage(res, [...transfers]);
      } catch (error) {
        workerSelf.postMessage({
          id: req.id,
          type: 'parallax-result',
          ok: false,
          error: error instanceof Error ? error.message : 'Parallax layer processing failed',
        });
      }
      return;
    }

    if (req.type === 'BAKE_VFX_FLIPBOOK') {
      try {
        const res = executeBakeVfxFlipbookJob(req);
        const transfers = new Set<Transferable>();
        if (res.result.sheet.data.buffer instanceof ArrayBuffer) {
          transfers.add(res.result.sheet.data.buffer);
        }
        for (const frame of res.result.frames) {
          if (frame.data.buffer instanceof ArrayBuffer) {
            transfers.add(frame.data.buffer);
          }
        }
        workerSelf.postMessage(res, [...transfers]);
      } catch (error) {
        workerSelf.postMessage({
          id: req.id,
          type: 'vfx-result',
          ok: false,
          error: error instanceof Error ? error.message : 'VFX flipbook bake failed',
        });
      }
      return;
    }

    if (req.type === 'COMPOSE_AUTO_TILE_SHEET') {
      try {
        const res = executeComposeAutoTileJob(req);
        const transfers = new Set<Transferable>();
        if (res.result.sheet.data.buffer instanceof ArrayBuffer) {
          transfers.add(res.result.sheet.data.buffer);
        }
        workerSelf.postMessage(res, [...transfers]);
      } catch (error) {
        workerSelf.postMessage({
          id: req.id,
          type: 'autotile-result',
          ok: false,
          error: error instanceof Error ? error.message : 'Auto-tile composition failed',
        });
      }
      return;
    }

    if (req.type === 'SLICE_TURNAROUND_SHEET') {
      try {
        const res = executeSliceTurnaroundJob(req);
        const transfers = new Set<Transferable>();
        if (res.cleanedSheetRgba.buffer instanceof ArrayBuffer) {
          transfers.add(res.cleanedSheetRgba.buffer);
        }
        for (const frame of res.result.frames) {
          if (frame.buffer.data.buffer instanceof ArrayBuffer) {
            transfers.add(frame.buffer.data.buffer);
          }
        }
        workerSelf.postMessage(res, [...transfers]);
      } catch (error) {
        workerSelf.postMessage({
          id: req.id,
          type: 'slice-result',
          ok: false,
          error: error instanceof Error ? error.message : 'Turnaround slicing failed',
        });
      }
      return;
    }

    try {
      const result = await executePostProcessJob(req, (phase, progress) => {
        workerSelf.postMessage({
          id: req.id,
          type: 'progress',
          phase,
          progress,
        });
      });
      workerSelf.postMessage(result, [result.rgba.buffer, result.pngBytes.buffer]);
    } catch (error) {
      workerSelf.postMessage({
        id: req.id,
        type: 'result',
        ok: false,
        error: error instanceof Error ? error.message : 'Post-processing failed',
      });
    }
  };
}
