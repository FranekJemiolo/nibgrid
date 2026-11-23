import {
  runNormalizationPipeline,
  type NormalizeWorkerRequest,
  type NormalizeWorkerResponse,
  type NormalizeWorkerSuccess,
} from './normalize.worker';

let workerInstance: Worker | null = null;
let nextRequestId = 1;

interface PendingRequest {
  resolve: (value: NormalizeWorkerSuccess) => void;
  reject: (reason: Error) => void;
}

const pending = new Map<number, PendingRequest>();

function getWorker(): Worker | null {
  if (typeof Worker === 'undefined') {
    return null;
  }
  if (!workerInstance) {
    workerInstance = new Worker(new URL('./normalize.worker.ts', import.meta.url), {
      type: 'module',
    });
    workerInstance.onmessage = (event: MessageEvent<NormalizeWorkerResponse>) => {
      const data = event.data;
      const entry = pending.get(data.id);
      if (!entry) return;
      pending.delete(data.id);
      if (data.ok) {
        entry.resolve(data);
      } else {
        entry.reject(new Error(data.error));
      }
    };
    workerInstance.onerror = (event) => {
      const err = new Error(event.message || 'Normalization Web Worker crashed');
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

export interface NormalizeSketchInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  targetWidth: number;
  targetHeight: number;
  marginRatio?: number;
}

export async function normalizeSketchInWorker(
  input: NormalizeSketchInput,
): Promise<NormalizeWorkerSuccess> {
  const id = nextRequestId++;
  const copy = new Uint8ClampedArray(input.rgba);
  const request: NormalizeWorkerRequest = {
    id,
    rgba: copy,
    width: input.width,
    height: input.height,
    targetWidth: input.targetWidth,
    targetHeight: input.targetHeight,
    marginRatio: input.marginRatio ?? 0.1,
  };

  const worker = getWorker();
  if (!worker) {
    return runNormalizationPipeline(request);
  }

  return new Promise<NormalizeWorkerSuccess>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage(request, [copy.buffer]);
  });
}

