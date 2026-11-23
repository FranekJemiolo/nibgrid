import type { OscShape, PcmBuffer, ProceduralSfxParams } from './types';

/** Deterministic Mulberry32 PRNG returning values in [0, 1). */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleOsc(shape: OscShape, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (shape) {
    case 'sine':
      return Math.sin(p * Math.PI * 2);
    case 'triangle':
      return 1 - 4 * Math.abs(Math.round(p - 0.25) - (p - 0.25));
    case 'sawtooth':
      return 2 * p - 1;
    case 'square':
      return p < 0.5 ? 1 : -1;
  }
}

/**
 * Pure-TS deterministic 3-layer procedural SFX synthesizer (Transient + FM Body + SVF Noise Tail).
 * Produces byte-identical 44.1 kHz mono Float32Array PCM buffers for identical params & seed.
 */
export function synthesizeProceduralSfx(params: ProceduralSfxParams): PcmBuffer {
  const sr = Math.max(8000, Math.min(96000, Math.round(params.sampleRate ?? 44100)));
  const duration = Math.max(0.05, Math.min(4.0, params.durationSec));
  const totalSamples = Math.max(1, Math.round(duration * sr));
  const out = new Float32Array(totalSamples);
  const rng = createRng(params.seed);

  let bodyPhase = 0;
  let fmPhase = 0;
  let transientPhase = 0;
  // 2-pole Chamberlin state-variable filter state for noise layer
  let svfLow = 0;
  let svfBand = 0;

  const attackSamples = Math.max(1, (Math.max(0, params.bodyAttackMs) / 1000) * sr);
  const bodyDecaySec = Math.max(0.005, params.bodyDecayMs / 1000);
  const transDecaySec = Math.max(0.001, params.transientDecayMs / 1000);
  const noiseDecaySec = Math.max(0.005, params.noiseDecayMs / 1000);
  const quantLevels = params.bitDepth < 16 ? Math.pow(2, Math.max(4, params.bitDepth) - 1) : 0;

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sr;
    const progress = i / totalSamples;

    // 1. Transient Attack (exponentially decaying pitched punch/click)
    let transient = 0;
    if (params.transientGain > 0) {
      const envT = Math.exp(-t / transDecaySec);
      const tFreq = params.transientFreqHz * (0.4 + 0.6 * envT);
      transientPhase += tFreq / sr;
      transient = Math.sin(transientPhase * Math.PI * 2) * envT * params.transientGain;
    }

    // 2. Tonal Body (exponential pitch sweep + optional 2-op FM)
    let body = 0;
    if (params.bodyGain > 0) {
      const attackEnv = i < attackSamples ? i / attackSamples : 1;
      const decayEnv = Math.exp(-t / bodyDecaySec);
      const startHz = Math.max(1, params.bodyStartHz);
      const endHz = Math.max(1, params.bodyEndHz);
      const freq = startHz * Math.pow(endHz / startHz, Math.min(1, t / bodyDecaySec));

      let fmOffset = 0;
      if (params.fmRatio > 0 && params.fmDepth > 0) {
        fmPhase += (freq * params.fmRatio) / sr;
        fmOffset = Math.sin(fmPhase * Math.PI * 2) * params.fmDepth * decayEnv;
      }

      bodyPhase += Math.max(1, freq + fmOffset) / sr;
      body = sampleOsc(params.bodyShape, bodyPhase) * attackEnv * decayEnv * params.bodyGain;
    }

    // 3. Filtered Noise Tail (2-pole Chamberlin SVF low-pass with swept cutoff)
    let noise = 0;
    if (params.noiseGain > 0) {
      const rawWhite = rng() * 2 - 1;
      const cutoff = params.filterStartHz + (params.filterEndHz - params.filterStartHz) * progress;
      const cappedCutoff = Math.max(40, Math.min(sr * 0.42, cutoff));
      const f = Math.min(0.85, 2 * Math.sin((Math.PI * cappedCutoff) / sr));
      const qInv = 1 / Math.max(0.5, params.filterQ);
      svfLow += f * svfBand;
      const high = rawWhite - svfLow - qInv * svfBand;
      svfBand += f * high;
      noise = svfLow * Math.exp(-t / noiseDecaySec) * params.noiseGain;
    }

    let sample = transient + body + noise;

    if (params.drive > 1) {
      const norm = Math.tanh(params.drive);
      sample = norm > 0 ? Math.tanh(sample * params.drive) / norm : sample;
    }
    if (quantLevels > 0) {
      sample = Math.round(sample * quantLevels) / quantLevels;
    }

    out[i] = Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0;
  }

  return { sampleRate: sr, channels: 1, samples: out };
}
