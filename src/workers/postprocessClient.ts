import type { PostProcessConfig } from '../domain/schemas';
import {
  executePostProcessJob,
  type PostProcessWorkerMessage,
  type PostProcessWorkerRequest,
  type PostProcessWorkerSuccess,
} from './postprocess.worker';

let workerInstance: Worker | null = null;
let nextRequestId = 1;

interface PendingJob {
  resolve: (value: PostProcessWorkerSuccess) => void;
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
      resolve,
      reject,
      onProgress: input.onProgress,
    });
    worker.postMessage(request, [copy.buffer]);
  });
}
