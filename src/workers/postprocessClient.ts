import type { PostProcessConfig } from '../domain/schemas';
import type { AutoTileOptions } from '../processing/autoTile';
import type { BitmapFontStyleOptions, GlyphMask } from '../processing/bitmapFont';
import type { RgbTuple } from '../processing/parallaxCompositor';
import type { TurnaroundSliceOptions } from '../processing/turnaroundSlicer';
import type { VfxFlipbookOptions } from '../processing/vfxFlipbook';
import {
  executeBakeBitmapFontJob,
  executeBakeVfxFlipbookJob,
  executeComposeAutoTileJob,
  executePostProcessJob,
  executeProcessParallaxLayerJob,
  executeSliceTurnaroundJob,
  type BakeBitmapFontWorkerRequest,
  type BakeBitmapFontWorkerSuccess,
  type BakeVfxFlipbookWorkerRequest,
  type BakeVfxFlipbookWorkerSuccess,
  type ComposeAutoTileWorkerRequest,
  type ComposeAutoTileWorkerSuccess,
  type PostProcessWorkerMessage,
  type PostProcessWorkerRequest,
  type PostProcessWorkerSuccess,
  type ProcessParallaxLayerWorkerRequest,
  type ProcessParallaxLayerWorkerSuccess,
  type SliceTurnaroundWorkerRequest,
  type SliceTurnaroundWorkerSuccess,
} from './postprocess.worker';

let workerInstance: Worker | null = null;
let nextRequestId = 1;

interface PendingJob {
  resolve: (
    value:
      | PostProcessWorkerSuccess
      | SliceTurnaroundWorkerSuccess
      | ComposeAutoTileWorkerSuccess
      | BakeVfxFlipbookWorkerSuccess
      | ProcessParallaxLayerWorkerSuccess
      | BakeBitmapFontWorkerSuccess,
  ) => void;
  reject: (reason: Error) => void;
  onProgress?: (phase: string, progress: number) => void;
}

const pending = new Map<number, PendingJob>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') {
    return null;
  }
  if (!workerInstance) {
    workerInstance = new Worker(new URL('./postprocess.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerInstance.onmessage = (event: MessageEvent<PostProcessWorkerMessage>) => {
      const msg = event.data;
      const entry = pending.get(msg.id);
      if (!entry) return;

      if (msg.type === 'progress') {
        entry.onProgress?.(msg.phase, msg.progress);
        return;
      }

      pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg);
      } else {
        entry.reject(new Error(msg.error));
      }
    };
    workerInstance.onerror = (event) => {
      const err = new Error(event.message || 'Post-processing Web Worker crashed');
      for (const entry of pending.values()) {
        entry.reject(err);
      }
      pending.clear();
      workerInstance?.terminate();
      workerInstance = null;
    };
  }
  return workerInstance;
}

export interface RunPostProcessInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  config: PostProcessConfig;
  paletteHex: readonly string[];
  onProgress?: (phase: string, progress: number) => void;
}

export async function runPostProcessInWorker(
  input: RunPostProcessInput,
): Promise<PostProcessWorkerSuccess> {
  const id = nextRequestId++;
  const copy = new Uint8ClampedArray(input.rgba);
  const request: PostProcessWorkerRequest = {
    id,
    rgba: copy,
    width: input.width,
    height: input.height,
    config: input.config,
    paletteHex: [...input.paletteHex],
  };

  const worker = getWorker();
  if (!worker) {
    return executePostProcessJob(request, input.onProgress);
  }

  return new Promise<PostProcessWorkerSuccess>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as PostProcessWorkerSuccess),
      reject,
      onProgress: input.onProgress,
    });
    worker.postMessage(request, [copy.buffer]);
  });
}

export interface RunSliceTurnaroundInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  removeBackground?: boolean;
  bgTolerance?: number;
  options: TurnaroundSliceOptions;
}

export async function sliceTurnaroundInWorker(
  input: RunSliceTurnaroundInput,
): Promise<SliceTurnaroundWorkerSuccess> {
  const id = nextRequestId++;
  const copy = new Uint8ClampedArray(input.rgba);
  const request: SliceTurnaroundWorkerRequest = {
    type: 'SLICE_TURNAROUND_SHEET',
    id,
    rgba: copy,
    width: input.width,
    height: input.height,
    removeBackground: input.removeBackground,
    bgTolerance: input.bgTolerance,
    options: input.options,
  };

  const worker = getWorker();
  if (!worker) {
    return executeSliceTurnaroundJob(request);
  }

  return new Promise<SliceTurnaroundWorkerSuccess>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as SliceTurnaroundWorkerSuccess),
      reject,
    });
    worker.postMessage(request, [copy.buffer]);
  });
}

export interface RunComposeAutoTileInput {
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

export async function composeAutoTileInWorker(
  input: RunComposeAutoTileInput,
): Promise<ComposeAutoTileWorkerSuccess> {
  const id = nextRequestId++;
  const fillCopy = new Uint8ClampedArray(input.fill.rgba);
  const underlayCopy = input.underlay ? new Uint8ClampedArray(input.underlay.rgba) : null;

  const request: ComposeAutoTileWorkerRequest = {
    type: 'COMPOSE_AUTO_TILE_SHEET',
    id,
    fill: {
      rgba: fillCopy,
      width: input.fill.width,
      height: input.fill.height,
    },
    underlay: underlayCopy
      ? {
          rgba: underlayCopy,
          width: input.underlay!.width,
          height: input.underlay!.height,
        }
      : null,
    options: input.options,
  };

  const worker = getWorker();
  if (!worker) {
    return executeComposeAutoTileJob(request);
  }

  return new Promise<ComposeAutoTileWorkerSuccess>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as ComposeAutoTileWorkerSuccess),
      reject,
    });
    const transfers: Transferable[] = [fillCopy.buffer];
    if (underlayCopy) transfers.push(underlayCopy.buffer);
    worker.postMessage(request, transfers);
  });
}

export interface RunBakeVfxFlipbookInput {
  readonly options: Omit<VfxFlipbookOptions, 'sourceSprite'>;
  readonly sourceSprite: {
    readonly rgba: Uint8ClampedArray;
    readonly width: number;
    readonly height: number;
  } | null;
}

export async function bakeVfxFlipbookInWorker(
  input: RunBakeVfxFlipbookInput,
): Promise<BakeVfxFlipbookWorkerSuccess> {
  const id = nextRequestId++;
  const sourceCopy = input.sourceSprite ? new Uint8ClampedArray(input.sourceSprite.rgba) : null;

  const request: BakeVfxFlipbookWorkerRequest = {
    type: 'BAKE_VFX_FLIPBOOK',
    id,
    options: {
      ...input.options,
      coreRgb: [...input.options.coreRgb],
      outerRgb: [...input.options.outerRgb],
      ...(input.options.paletteHex ? { paletteHex: [...input.options.paletteHex] } : {}),
    },
    sourceSprite: sourceCopy
      ? {
          rgba: sourceCopy,
          width: input.sourceSprite!.width,
          height: input.sourceSprite!.height,
        }
      : null,
  };

  const worker = getWorker();
  if (!worker) {
    return executeBakeVfxFlipbookJob(request);
  }

  return new Promise<BakeVfxFlipbookWorkerSuccess>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as BakeVfxFlipbookWorkerSuccess),
      reject,
    });
    const transfers: Transferable[] = [];
    if (sourceCopy) transfers.push(sourceCopy.buffer);
    worker.postMessage(request, transfers);
  });
}

export interface RunProcessParallaxLayerInput {
  readonly layerId: string;
  readonly layerName: string;
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly scrollRatioX: number;
  readonly yOffsetPx: number;
  readonly seamBlendPx: number;
  readonly depthHaze: number;
  readonly visible: boolean;
  readonly horizonRgb: RgbTuple;
  readonly contrastDampening: number;
  readonly stripChromaKey?: boolean;
  readonly chromaTolerance?: number;
  readonly paletteHex?: readonly string[];
  readonly snapToPalette?: boolean;
}

export async function processParallaxLayerInWorker(
  input: RunProcessParallaxLayerInput,
): Promise<ProcessParallaxLayerWorkerSuccess> {
  const id = nextRequestId++;
  const copy = new Uint8ClampedArray(input.rgba);

  const request: ProcessParallaxLayerWorkerRequest = {
    type: 'PROCESS_PARALLAX_LAYER',
    id,
    layerId: input.layerId,
    layerName: input.layerName,
    rgba: copy,
    width: input.width,
    height: input.height,
    scrollRatioX: input.scrollRatioX,
    yOffsetPx: input.yOffsetPx,
    seamBlendPx: input.seamBlendPx,
    depthHaze: input.depthHaze,
    visible: input.visible,
    horizonRgb: [input.horizonRgb[0], input.horizonRgb[1], input.horizonRgb[2]],
    contrastDampening: input.contrastDampening,
    stripChromaKey: input.stripChromaKey,
    chromaTolerance: input.chromaTolerance,
    ...(input.paletteHex ? { paletteHex: [...input.paletteHex] } : {}),
    snapToPalette: input.snapToPalette,
  };

  const worker = getWorker();
  if (!worker) {
    return executeProcessParallaxLayerJob(request);
  }

  return new Promise<ProcessParallaxLayerWorkerSuccess>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as ProcessParallaxLayerWorkerSuccess),
      reject,
    });
    worker.postMessage(request, [copy.buffer]);
  });
}

export interface RunBakeBitmapFontInput {
  readonly masks: readonly GlyphMask[];
  readonly options: BitmapFontStyleOptions;
}

export async function bakeBitmapFontInWorker(
  input: RunBakeBitmapFontInput,
): Promise<BakeBitmapFontWorkerSuccess> {
  const id = nextRequestId++;
  const clonedMasks: GlyphMask[] = input.masks.map((m) => ({
    ...m,
    alpha: new Uint8Array(m.alpha),
  }));

  const request: BakeBitmapFontWorkerRequest = {
    type: 'BAKE_BITMAP_FONT',
    id,
    masks: clonedMasks,
    options: {
      ...input.options,
      topRgb: [input.options.topRgb[0], input.options.topRgb[1], input.options.topRgb[2]],
      bottomRgb: [
        input.options.bottomRgb[0],
        input.options.bottomRgb[1],
        input.options.bottomRgb[2],
      ],
      shadowRgb: [
        input.options.shadowRgb[0],
        input.options.shadowRgb[1],
        input.options.shadowRgb[2],
      ],
      ...(input.options.outlineRgb
        ? {
            outlineRgb: [
              input.options.outlineRgb[0],
              input.options.outlineRgb[1],
              input.options.outlineRgb[2],
            ],
          }
        : {}),
      ...(input.options.paletteHex ? { paletteHex: [...input.options.paletteHex] } : {}),
    },
  };

  const worker = getWorker();
  if (!worker) {
    return executeBakeBitmapFontJob(request);
  }

  return new Promise<BakeBitmapFontWorkerSuccess>((resolve, reject) => {
    pending.set(id, {
      resolve: (value) => resolve(value as BakeBitmapFontWorkerSuccess),
      reject,
    });
    const transfers = new Set<Transferable>();
    for (const m of clonedMasks) {
      if (m.alpha.buffer instanceof ArrayBuffer) {
        transfers.add(m.alpha.buffer);
      }
    }
    worker.postMessage(request, [...transfers]);
  });
}

export interface MonotonicRequestGuard {
  next: () => number;
  isCurrent: (token: number) => boolean;
  invalidate: () => void;
}

/**
 * Tracks a monotonically increasing request token so rapid UI adjustments or
 * unmounts deterministically discard stale out-of-order worker completions.
 */
export function createMonotonicRequestGuard(): MonotonicRequestGuard {
  let latestToken = 0;
  return {
    next: () => {
      latestToken += 1;
      return latestToken;
    },
    isCurrent: (token: number) => token === latestToken,
    invalidate: () => {
      latestToken += 1;
    },
  };
}
