import type { ContourTimbrePatch } from './contourPatchSchema';
import { encodeWav16, runAudioPostProcessPipeline } from './pcmPostProcess';
import { createRng } from './proceduralSynth';
import type { AudioPostProcessConfig, OscShape, PcmBuffer } from './types';
import type { AudioVariationArtifact } from './variations';
import { quantizeFreqToScale, type VocalContour } from './vocalAnalyzer';

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

function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * Pure-TS Contour-Following Synth driven by extracted `A(t)` envelope, `f0(t)` pitch curve,
 * and voiced/unvoiced articulation from `analyzeVocalSketch()`.
 */
export function synthesizeFromContour(
  contour: VocalContour,
  patch: ContourTimbrePatch,
  seed = 1024,
  sampleRate = 44100,
): PcmBuffer {
  const sr = Math.max(8000, Math.min(96000, Math.round(sampleRate)));
  const frames = contour.frames;
  const totalSamples = Math.max(1, Math.round(Math.max(contour.durationSec, 0.05) * sr));
  const out = new Float32Array(totalSamples);

  if (frames.length === 0) {
    return { sampleRate: sr, channels: 1, samples: out };
  }

  const rng = createRng(seed);
  const octMult = Math.pow(2, patch.octaveShift);
  const smoothCoeff =
    patch.pitchSmoothMs > 0 ? 1 - Math.exp(-1 / ((patch.pitchSmoothMs / 1000) * sr)) : 1;
  const quantLevels = patch.bitDepth < 16 ? Math.pow(2, Math.max(4, patch.bitDepth) - 1) : 0;

  let mainPhase = 0;
  let fmPhase = 0;
  let subPhase = 0;
  let smoothedFreq = 0;
  let svfLow = 0;
  let svfBand = 0;

  const hopSec = Math.max(0.001, contour.hopSec);

  for (let i = 0; i < totalSamples; i++) {
    const t = i / sr;
    const fPos = t / hopSec;
    const f0 = Math.min(frames.length - 1, Math.floor(fPos));
    const f1 = Math.min(frames.length - 1, f0 + 1);
    const frac = Math.max(0, Math.min(1, fPos - f0));

    const a = frames[f0]!;
    const b = frames[f1]!;
    const rms = a.rms + (b.rms - a.rms) * frac;

    if (rms <= 1e-4) {
      svfLow *= 0.9;
      svfBand *= 0.9;
      out[i] = 0;
      continue;
    }

    const clarity = a.clarity + (b.clarity - a.clarity) * frac;
    const zcr = a.zcr + (b.zcr - a.zcr) * frac;

    // Avoid sweeping from 0 Hz when crossing silence/unvoiced transitions
    const rawFreq =
      a.freqHz > 0 && b.freqHz > 0
        ? a.freqHz + (b.freqHz - a.freqHz) * frac
        : a.freqHz > 0
          ? a.freqHz
          : b.freqHz;

    const voicedWeight = rawFreq > 0 ? clamp((clarity - 0.45) / 0.2, 0, 1) : 0;
    const unvoicedWeight = 1 - voicedWeight;

    let voicedSample = 0;
    if (voicedWeight > 0 && rawFreq > 0) {
      let targetFreq = rawFreq * octMult;
      if (patch.scaleQuantize !== 'none') {
        targetFreq = quantizeFreqToScale(targetFreq, patch.scaleQuantize);
      }
      targetFreq = clamp(targetFreq, 20, sr * 0.42);
      smoothedFreq =
        smoothedFreq > 0 ? smoothedFreq + (targetFreq - smoothedFreq) * smoothCoeff : targetFreq;

      let fmOffset = 0;
      if (patch.fmRatio > 0 && patch.fmDepth > 0) {
        fmPhase += (smoothedFreq * patch.fmRatio) / sr;
        fmOffset = Math.sin(fmPhase * Math.PI * 2) * patch.fmDepth;
      }

      mainPhase += Math.max(1, smoothedFreq + fmOffset) / sr;
      subPhase += Math.max(1, smoothedFreq * 0.5) / sr;

      const oscVal = sampleOsc(patch.oscShape, mainPhase);
      const subVal = Math.sin(subPhase * Math.PI * 2) * patch.subOscGain * 0.6;
      voicedSample = (oscVal + subVal) * voicedWeight;
    }

    let noiseSample = 0;
    if (patch.unvoicedNoiseGain > 0 && unvoicedWeight > 0.01) {
      const white = rng() * 2 - 1;
      // High zcr mouth foley ('shh'/'t') brightens filter slightly within safe Nyquist cap
      const cutoff = clamp(patch.noiseFilterHz * (0.85 + zcr * 0.6), 80, sr * 0.42);
      const f = Math.min(0.85, 2 * Math.sin((Math.PI * cutoff) / sr));
      const qInv = 1 / Math.max(0.5, patch.filterQ);
      svfLow += f * svfBand;
      const high = white - svfLow - qInv * svfBand;
      svfBand += f * high;
      noiseSample = svfBand * patch.unvoicedNoiseGain * unvoicedWeight;
    }

    let sample = (voicedSample + noiseSample) * rms;

    if (patch.drive > 1) {
      const norm = Math.tanh(patch.drive);
      sample = norm > 0 ? Math.tanh(sample * patch.drive) / norm : sample;
    }
    if (quantLevels > 0) {
      sample = Math.round(sample * quantLevels) / quantLevels;
    }

    out[i] = Number.isFinite(sample) ? clamp(sample, -1, 1) : 0;
  }

  return { sampleRate: sr, channels: 1, samples: out };
}

/**
 * Generates `1`, `4`, or `6` micro-variations from a VocalContour + ContourTimbrePatch
 * before running M14's DSP post-process chain and WAV16 encoding.
 */
export function generateContourVariations(
  contour: VocalContour,
  patch: ContourTimbrePatch,
  postProcess: AudioPostProcessConfig,
  count: 1 | 4 | 6,
  baseSeed = 1024,
): readonly AudioVariationArtifact[] {
  const results: AudioVariationArtifact[] = [];
  const total = Math.max(1, count);

  for (let i = 0; i < total; i++) {
    let variantPatch = patch;
    let variantSeed = baseSeed >>> 0;

    if (i > 0) {
      const rng = createRng((baseSeed + Math.imul(i, 7919)) >>> 0);
      variantSeed = (baseSeed + Math.imul(i, 2654435761)) >>> 0;
      const microDetune = (rng() * 2 - 1) * 0.04;
      const fmMult = 1 + (rng() * 2 - 1) * 0.1;
      const filterMult = 1 + (rng() * 2 - 1) * 0.12;

      variantPatch = {
        ...patch,
        octaveShift:
          patch.scaleQuantize === 'none'
            ? clamp(patch.octaveShift + microDetune, -3, 3)
            : patch.octaveShift,
        fmDepth: clamp(patch.fmDepth * fmMult, 0, 800),
        noiseFilterHz: clamp(patch.noiseFilterHz * filterMult, 200, 12000),
      };
    }

    const raw = synthesizeFromContour(contour, variantPatch, variantSeed);
    const processed = runAudioPostProcessPipeline(raw, postProcess);
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
