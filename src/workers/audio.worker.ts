import type { ContourTimbrePatch } from '../audio/contourPatchSchema';
import { generateContourVariations } from '../audio/contourSynth';
import { encodeWav16 } from '../audio/pcmPostProcess';
import { synthesizeProceduralSfx } from '../audio/proceduralSynth';
import type { AudioPostProcessConfig, PcmBuffer, ProceduralSfxParams } from '../audio/types';
import {
  generatePcmVariations,
  generateProceduralVariations,
  type AudioVariationArtifact,
} from '../audio/variations';
import {
  analyzeVocalSketch,
  extractMelodySummary,
  type MelodySummary,
  type VocalContour,
} from '../audio/vocalAnalyzer';

export type AudioWorkerRequest =
  | {
      readonly op?: 'synth';
      readonly id: number;
      readonly sourceKind: 'procedural' | 'pcm' | 'contour';
      readonly synthParams?: ProceduralSfxParams;
      readonly rawPcm?: PcmBuffer;
      readonly contour?: VocalContour;
      readonly contourPatch?: ContourTimbrePatch;
      readonly postProcess: AudioPostProcessConfig;
      readonly variationCount: 1 | 4 | 6;
      readonly seed?: number;
    }
  | {
      readonly op: 'analyze-vocal';
      readonly id: number;
      readonly rawPcm: PcmBuffer;
    };

export interface AudioWorkerSuccess {
  readonly id: number;
  readonly op?: 'synth';
  readonly ok: true;
  readonly rawPcm: PcmBuffer;
  readonly rawWavBytes: Uint8Array;
  readonly variations: readonly AudioVariationArtifact[];
}

export interface AudioAnalyzeSuccess {
  readonly id: number;
  readonly op: 'analyze-vocal';
  readonly ok: true;
  readonly contour: VocalContour;
  readonly melody: MelodySummary;
}

export interface AudioWorkerFailure {
  readonly id: number;
  readonly ok: false;
  readonly error: string;
}

export type AudioWorkerMessage = AudioWorkerSuccess | AudioAnalyzeSuccess | AudioWorkerFailure;

/**
 * Pure worker execution core shared by Web Worker and Node fallback.
 */
export function executeVocalAnalyzeJob(req: {
  readonly id: number;
  readonly rawPcm: PcmBuffer;
}): AudioAnalyzeSuccess {
  const contour = analyzeVocalSketch(req.rawPcm);
  const melody = extractMelodySummary(contour);
  return {
    id: req.id,
    op: 'analyze-vocal',
    ok: true,
    contour,
    melody,
  };
}

export function executeAudioWorkerJob(
  req: Extract<AudioWorkerRequest, { sourceKind: unknown }>,
): AudioWorkerSuccess {
  let rawPcm: PcmBuffer;
  let variations: readonly AudioVariationArtifact[];

  if (req.sourceKind === 'procedural') {
    if (!req.synthParams) {
      throw new Error('Missing synthParams for procedural audio job.');
    }
    rawPcm = synthesizeProceduralSfx(req.synthParams);
    variations = generateProceduralVariations(req.synthParams, req.postProcess, req.variationCount);
  } else if (req.sourceKind === 'contour') {
    if (!req.contour || !req.contourPatch) {
      throw new Error('Missing vocal contour or ContourTimbrePatch for contour synthesis job.');
    }
    variations = generateContourVariations(
      req.contour,
      req.contourPatch,
      req.postProcess,
      req.variationCount,
      req.seed ?? 1024,
    );
    rawPcm = req.rawPcm ?? variations[0]!.buffer;
  } else {
    if (!req.rawPcm) {
      throw new Error('Missing rawPcm buffer for PCM DSP job.');
    }
    rawPcm = req.rawPcm;
    variations = generatePcmVariations(
      req.rawPcm,
      req.postProcess,
      req.variationCount,
      req.seed ?? 1024,
    );
  }

  const rawWavBytes = encodeWav16(rawPcm);
  return {
    id: req.id,
    op: 'synth',
    ok: true,
    rawPcm,
    rawWavBytes,
    variations,
  };
}

interface WorkerPostScope {
  onmessage: ((event: MessageEvent<AudioWorkerRequest>) => void) | null;
  postMessage: (message: AudioWorkerMessage, transfer?: Transferable[]) => void;
}

if (
  typeof self !== 'undefined' &&
  typeof WorkerGlobalScope !== 'undefined' &&
  self instanceof WorkerGlobalScope
) {
  const workerSelf = self as unknown as WorkerPostScope;
  workerSelf.onmessage = (event: MessageEvent<AudioWorkerRequest>) => {
    const req = event.data;
    try {
      if (req.op === 'analyze-vocal') {
        const res = executeVocalAnalyzeJob(req);
        workerSelf.postMessage(res);
        return;
      }
      const result = executeAudioWorkerJob(req);
      const buffers = new Set<ArrayBuffer>();
      buffers.add(result.rawPcm.samples.buffer as ArrayBuffer);
      buffers.add(result.rawWavBytes.buffer as ArrayBuffer);
      for (const v of result.variations) {
        buffers.add(v.buffer.samples.buffer as ArrayBuffer);
        buffers.add(v.wavBytes.buffer as ArrayBuffer);
      }
      workerSelf.postMessage(result, [...buffers]);
    } catch (error) {
      workerSelf.postMessage({
        id: req.id,
        ok: false,
        error: error instanceof Error ? error.message : 'Audio Worker job failed.',
      });
    }
  };
}
