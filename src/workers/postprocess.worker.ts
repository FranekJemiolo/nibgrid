import type { PostProcessConfig } from '../domain/schemas';
import type { DetectedGrid } from '../processing/demixel';
import { sha256Bytes } from '../processing/hash';
import { runPostProcessPipeline } from '../processing/pipeline';
import { encodeRgbaToPngBytes } from '../processing/png';

export interface PostProcessWorkerRequest {
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  config: PostProcessConfig;
  paletteHex: readonly string[];
}

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

export interface PostProcessWorkerFailure {
  id: number;
  type: 'result';
  ok: false;
  error: string;
}

export type PostProcessWorkerMessage =
  PostProcessWorkerProgress | PostProcessWorkerSuccess | PostProcessWorkerFailure;

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

interface WorkerPostScope {
  onmessage: ((event: MessageEvent<PostProcessWorkerRequest>) => void) | null;
  postMessage: (message: PostProcessWorkerMessage, transfer?: Transferable[]) => void;
}

if (
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  const workerSelf = self as unknown as WorkerPostScope;
  workerSelf.onmessage = async (event: MessageEvent<PostProcessWorkerRequest>) => {
    const req = event.data;
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
