import { alignToSafeMargin, extractLinesAndContrast, sha256Bytes } from '../processing/normalize';
import { encodeRgbaToPngBytes } from '../processing/png';

export interface NormalizeWorkerRequest {
  id: number;
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  marginRatio: number;
}

export interface NormalizeWorkerSuccess {
  id: number;
  ok: true;
  normalizedRgba: Uint8ClampedArray;
  width: number;
  height: number;
  pngBytes: Uint8Array;
  sha256: string;
}

export interface NormalizeWorkerFailure {
  id: number;
  ok: false;
  error: string;
}

export type NormalizeWorkerResponse = NormalizeWorkerSuccess | NormalizeWorkerFailure;

export async function runNormalizationPipeline(
  req: NormalizeWorkerRequest,
): Promise<NormalizeWorkerSuccess> {
  const highContrast = extractLinesAndContrast(req.rgba, req.width, req.height);
  const aligned = alignToSafeMargin(
    highContrast,
    req.width,
    req.height,
    req.targetWidth,
    req.marginRatio,
    req.targetHeight,
  );
  const pngBytes = encodeRgbaToPngBytes(aligned, req.targetWidth, req.targetHeight);
  const sha256 = await sha256Bytes(pngBytes);

  return {
    id: req.id,
    ok: true,
    normalizedRgba: aligned,
    width: req.targetWidth,
    height: req.targetHeight,
    pngBytes,
    sha256,
  };
}

interface WorkerPostScope {
  onmessage: ((event: MessageEvent<NormalizeWorkerRequest>) => void) | null;
  postMessage: (message: NormalizeWorkerResponse, transfer?: Transferable[]) => void;
}

if (
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  const workerSelf = self as unknown as WorkerPostScope;
  workerSelf.onmessage = async (event: MessageEvent<NormalizeWorkerRequest>) => {
    const req = event.data;
    try {
      const result = await runNormalizationPipeline(req);
      workerSelf.postMessage(result, [result.normalizedRgba.buffer, result.pngBytes.buffer]);
    } catch (error) {
      const failure: NormalizeWorkerFailure = {
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Normalization failed',
      };
      workerSelf.postMessage(failure);
    }
  };
}
