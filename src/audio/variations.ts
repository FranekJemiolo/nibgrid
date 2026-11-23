import { encodeWav16, runAudioPostProcessPipeline } from './pcmPostProcess';
import { createRng, synthesizeProceduralSfx } from './proceduralSynth';
import type { AudioPostProcessConfig, PcmBuffer, ProceduralSfxParams } from './types';

export interface AudioVariationArtifact {
  readonly index: number;
  readonly filenameSuffix: string;
  readonly buffer: PcmBuffer;
  readonly wavBytes: Uint8Array;
  readonly synthParams?: ProceduralSfxParams;
  readonly inputLufs: number;
  readonly outputLufs: number;
  readonly peakDb: number;
}

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Generates `1`, `4`, or `6` deterministic micro-variations from procedural SFX parameters
 * using seeded pitch (±8%), filter cutoff (±12%), and transient decay (±15%) jitter.
 */
export function generateProceduralVariations(
  baseParams: ProceduralSfxParams,
  postProcess: AudioPostProcessConfig,
  count: 1 | 4 | 6,
): readonly AudioVariationArtifact[] {
  const results: AudioVariationArtifact[] = [];
  const total = Math.max(1, count);

  for (let i = 0; i < total; i++) {
    let variantParams: ProceduralSfxParams = baseParams;
    if (i > 0) {
      const rng = createRng((baseParams.seed + Math.imul(i, 7919)) >>> 0);
      const pitchMult = 1 + (rng() * 2 - 1) * 0.08;
      const filterMult = 1 + (rng() * 2 - 1) * 0.12;
      const transientMult = 1 + (rng() * 2 - 1) * 0.15;

      variantParams = {
        ...baseParams,
        seed: (baseParams.seed + Math.imul(i, 2654435761)) >>> 0,
        bodyStartHz: clamp(baseParams.bodyStartHz * pitchMult, 20, 2400),
        bodyEndHz: clamp(baseParams.bodyEndHz * pitchMult, 20, 2400),
        filterStartHz: clamp(baseParams.filterStartHz * filterMult, 100, 14000),
        filterEndHz: clamp(baseParams.filterEndHz * filterMult, 80, 12000),
        transientDecayMs: clamp(baseParams.transientDecayMs * transientMult, 2, 40),
      };
    }

    const raw = synthesizeProceduralSfx(variantParams);
    const processed = runAudioPostProcessPipeline(raw, postProcess);
    const wavBytes = encodeWav16(processed.buffer);
    const suffix = total === 1 ? '.wav' : `_${String(i + 1).padStart(2, '0')}.wav`;

    results.push({
      index: i,
      filenameSuffix: suffix,
      buffer: processed.buffer,
      wavBytes,
      synthParams: variantParams,
      inputLufs: processed.inputLufs,
      outputLufs: processed.outputLufs,
      peakDb: processed.peakDb,
    });
  }

  return results;
}

/**
 * Pure-TS linear resampling pitch-shifter + 1-pole tonal tilt for AI/WAV variations.
 */
function pitchShiftAndTiltPcm(buf: PcmBuffer, rateRatio: number, tiltAmount: number): PcmBuffer {
  const { samples, sampleRate, channels } = buf;
  const inFrames = Math.floor(samples.length / channels);
  if (inFrames <= 2 || Math.abs(rateRatio - 1) < 1e-4) {
    return { sampleRate, channels, samples: new Float32Array(samples) };
  }

  const outFrames = Math.max(2, Math.round(inFrames / rateRatio));
  const out = new Float32Array(outFrames * channels);
  let prev = 0;

  for (let f = 0; f < outFrames; f++) {
    const srcPos = f * rateRatio;
    const f0 = Math.min(inFrames - 1, Math.floor(srcPos));
    const f1 = Math.min(inFrames - 1, f0 + 1);
    const frac = srcPos - Math.floor(srcPos);

    for (let c = 0; c < channels; c++) {
      const s0 = samples[f0 * channels + c] ?? 0;
      const s1 = samples[f1 * channels + c] ?? 0;
      let val = s0 + (s1 - s0) * frac;
      if (c === 0 && Math.abs(tiltAmount) > 1e-4) {
        const diff = val - prev;
        prev = val;
        val = Math.max(-1, Math.min(1, val + diff * tiltAmount));
      }
      out[f * channels + c] = val;
    }
  }

  return { sampleRate, channels, samples: out };
}

/**
 * Generates `1`, `4`, or `6` micro-variations from an already-decoded PCM source (Lyria / Gemini TTS)
 * via linear pitch resampling (±6% jitter + optional base transpose) and 1-pole tonal tilt.
 */
export function generatePcmVariations(
  basePcm: PcmBuffer,
  postProcess: AudioPostProcessConfig,
  count: 1 | 4 | 6,
  seed = 1024,
): readonly AudioVariationArtifact[] {
  const results: AudioVariationArtifact[] = [];
  const total = Math.max(1, count);
  const baseTransposeRatio = clamp(1 + (postProcess.pitchShiftPercent ?? 0) / 100, 0.5, 1.8);

  for (let i = 0; i < total; i++) {
    const rng = createRng((seed + Math.imul(i + 1, 7919)) >>> 0);
    const jitter = i === 0 ? 1 : 1 + (rng() * 2 - 1) * 0.06;
    const tilt = i === 0 ? 0 : (rng() * 2 - 1) * 0.14;
    const shifted = pitchShiftAndTiltPcm(basePcm, baseTransposeRatio * jitter, tilt);
    const processed = runAudioPostProcessPipeline(shifted, postProcess);
    const wavBytes = encodeWav16(processed.buffer);
    const suffix = total === 1 ? '.wav' : `_${String(i + 1).padStart(2, '0')}.wav`;

    results.push({
      index: i,
      filenameSuffix: suffix,
      buffer: processed.buffer,
      wavBytes,
      inputLufs: processed.inputLufs,
      outputLufs: processed.outputLufs,
      peakDb: processed.peakDb,
    });
  }

  return results;
}
