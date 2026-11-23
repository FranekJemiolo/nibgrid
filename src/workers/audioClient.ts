import type { AudioPostProcessConfig, PcmBuffer, ProceduralSfxParams } from '../audio/types';
import {
  executeAudioWorkerJob,
  type AudioWorkerMessage,
  type AudioWorkerRequest,
  type AudioWorkerSuccess,
} from './audio.worker';

let audioWorkerInstance: Worker | null = null;
let nextAudioRequestId = 1;

interface PendingAudioJob {
  resolve: (val: AudioWorkerSuccess) => void;
  reject: (err: Error) => void;
}

const pendingJobs = new Map<number, PendingAudioJob>();

function getAudioWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!audioWorkerInstance) {
    audioWorkerInstance = new Worker(new URL('./audio.worker.ts', import.meta.url), {
      type: 'module',
    });
    audioWorkerInstance.onmessage = (event: MessageEvent<AudioWorkerMessage>) => {
      const msg = event.data;
      const job = pendingJobs.get(msg.id);
      if (!job) return;
      pendingJobs.delete(msg.id);
      if (msg.ok) {
        job.resolve(msg);
      } else {
        job.reject(new Error(msg.error));
      }
    };
    audioWorkerInstance.onerror = (event) => {
      const err = new Error(event.message || 'Audio Web Worker crashed.');
      for (const job of pendingJobs.values()) {
        job.reject(err);
      }
      pendingJobs.clear();
      audioWorkerInstance?.terminate();
      audioWorkerInstance = null;
    };
  }
  return audioWorkerInstance;
}

export interface RunAudioWorkerInput {
  readonly sourceKind: 'procedural' | 'pcm';
  readonly synthParams?: ProceduralSfxParams;
  readonly rawPcm?: PcmBuffer;
  readonly postProcess: AudioPostProcessConfig;
  readonly variationCount: 1 | 4 | 6;
  readonly seed?: number;
}

export async function runAudioPipelineInWorker(
  input: RunAudioWorkerInput,
): Promise<AudioWorkerSuccess> {
  const id = nextAudioRequestId++;
  const rawCopy: PcmBuffer | undefined = input.rawPcm
    ? {
        sampleRate: input.rawPcm.sampleRate,
        channels: input.rawPcm.channels,
        samples: new Float32Array(input.rawPcm.samples),
      }
    : undefined;

  const req: AudioWorkerRequest = {
    id,
    sourceKind: input.sourceKind,
    synthParams: input.synthParams,
    rawPcm: rawCopy,
    postProcess: input.postProcess,
    variationCount: input.variationCount,
    seed: input.seed,
  };

  const worker = getAudioWorker();
  if (!worker) {
    return executeAudioWorkerJob(req);
  }

  return new Promise<AudioWorkerSuccess>((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject });
    const transfers: Transferable[] = rawCopy ? [rawCopy.samples.buffer as ArrayBuffer] : [];
    worker.postMessage(req, transfers);
  });
}
