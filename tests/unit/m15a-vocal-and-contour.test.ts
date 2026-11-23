import { describe, expect, it } from 'vitest';
import {
  ContourTimbrePatchSchema,
  STARTER_CONTOUR_PATCHES,
  parseAndClampContourPatch,
} from '../../src/audio/contourPatchSchema';
import { generateContourVariations, synthesizeFromContour } from '../../src/audio/contourSynth';
import { createRng } from '../../src/audio/proceduralSynth';
import type { AudioPostProcessConfig, PcmBuffer } from '../../src/audio/types';
import { analyzeVocalSketch, extractMelodySummary } from '../../src/audio/vocalAnalyzer';

function makeLinearChirp(startHz: number, endHz: number, durationSec = 0.6, sr = 44100): PcmBuffer {
  const n = Math.round(durationSec * sr);
  const samples = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const instFreq = startHz + (endHz - startHz) * t;
    phase += (2 * Math.PI * instFreq) / sr;
    samples[i] = 0.55 * Math.sin(phase);
  }
  return { sampleRate: sr, channels: 1, samples };
}

function makeVoicedThenNoise(sr = 44100): PcmBuffer {
  const voicedN = Math.round(0.2 * sr);
  const noiseN = Math.round(0.2 * sr);
  const samples = new Float32Array(voicedN + noiseN);
  const rng = createRng(9988);

  for (let i = 0; i < voicedN; i++) {
    samples[i] = 0.55 * Math.sin((2 * Math.PI * 300 * i) / sr);
  }
  for (let i = 0; i < noiseN; i++) {
    samples[voicedN + i] = (rng() * 2 - 1) * 0.35;
  }
  return { sampleRate: sr, channels: 1, samples };
}

function makePaddedTone(sr = 44100): PcmBuffer {
  const silN = Math.round(0.12 * sr);
  const toneN = Math.round(0.16 * sr);
  const samples = new Float32Array(silN * 2 + toneN);
  for (let i = 0; i < toneN; i++) {
    samples[silN + i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / sr);
  }
  return { sampleRate: sr, channels: 1, samples };
}

const DEFAULT_POST: AudioPostProcessConfig = {
  trimSilence: false,
  silenceThresholdDb: -48,
  fadeInMs: 2,
  fadeOutMs: 8,
  normalizeLufs: true,
  targetLufs: -14,
  ceilingDb: -1.0,
  seamlessLoop: false,
  loopCrossfadeMs: 120,
  cropStartSec: 0,
  cropEndSec: 0,
};

describe('M15A Pure-TS Vocal Sketch Analyzer, Contour Synth & Patch Schema', () => {
  it('tracks a 220 Hz -> 440 Hz linear sine chirp within +-4% and clarity > 0.90', () => {
    const chirp = makeLinearChirp(220, 440, 0.6, 44100);
    const contour = analyzeVocalSketch(chirp);

    expect(contour.frames.length).toBeGreaterThan(40);
    const firstActive = contour.frames[2]!; // ~20-45ms centered near start
    const lastActive = contour.frames[contour.frames.length - 3]!; // ~555-580ms centered near end

    expect(firstActive.freqHz).toBeGreaterThan(220 * 0.96);
    expect(firstActive.freqHz).toBeLessThan(245); // within early ramp
    expect(lastActive.freqHz).toBeGreaterThan(440 * 0.92);
    expect(lastActive.freqHz).toBeLessThan(440 * 1.04);

    const interior = contour.frames.slice(2, -2);
    for (const f of interior) {
      expect(f.clarity).toBeGreaterThan(0.9);
      expect(f.freqHz).toBeGreaterThan(200);
    }
  });

  it('separates 200ms voiced 300 Hz tone cleanly from 200ms white noise & extracts melody summary', () => {
    const signal = makeVoicedThenNoise(44100);
    const contour = analyzeVocalSketch(signal);

    const voicedFrames = contour.frames.filter((f) => f.timeSec >= 0.03 && f.timeSec <= 0.15);
    const noiseFrames = contour.frames.filter((f) => f.timeSec >= 0.24 && f.timeSec <= 0.36);

    expect(voicedFrames.length).toBeGreaterThan(5);
    expect(noiseFrames.length).toBeGreaterThan(5);

    for (const vf of voicedFrames) {
      expect(vf.freqHz).toBeGreaterThan(285);
      expect(vf.freqHz).toBeLessThan(315);
      expect(vf.clarity).toBeGreaterThan(0.85);
    }

    for (const nf of noiseFrames) {
      expect(nf.freqHz).toBe(0);
      expect(nf.clarity).toBeLessThan(0.45);
    }

    // Verify melody note segmentation
    const sr = 44100;
    const noteLen = Math.round(0.15 * sr);
    const melSamples = new Float32Array(noteLen * 3);
    const freqs = [261.63, 329.63, 392.0];
    for (let n = 0; n < freqs.length; n++) {
      for (let i = 0; i < noteLen; i++) {
        melSamples[n * noteLen + i] = 0.5 * Math.sin((2 * Math.PI * freqs[n]! * i) / sr);
      }
    }
    const melContour = analyzeVocalSketch({ sampleRate: sr, channels: 1, samples: melSamples });
    const summary = extractMelodySummary(melContour);
    expect(summary.notes.length).toBeGreaterThanOrEqual(3);
  });

  it('renders byte-identical contour output on identical seed/patch and keeps silent frames strictly silent', () => {
    const padded = makePaddedTone(44100);
    const contour = analyzeVocalSketch(padded);
    const patch = {
      ...STARTER_CONTOUR_PATCHES[1]!.patch,
      octaveShift: -1,
    };

    const a = synthesizeFromContour(contour, patch, 2048);
    const b = synthesizeFromContour(contour, patch, 2048);

    expect(a.samples).toEqual(b.samples);
    for (let i = 0; i < a.samples.length; i++) {
      const s = a.samples[i]!;
      expect(Number.isNaN(s)).toBe(false);
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }

    // Silent input region [0 .. 0.08s] must stay < 1e-4
    const earlyCheckCount = Math.round(0.08 * a.sampleRate);
    for (let i = 0; i < earlyCheckCount; i++) {
      expect(Math.abs(a.samples[i] ?? 1)).toBeLessThan(1e-4);
    }

    // Also test variation batcher produces 4 distinct WAV16 files
    const vars = generateContourVariations(contour, patch, DEFAULT_POST, 4, 2048);
    expect(vars).toHaveLength(4);
    expect(vars[0]!.wavBytes).not.toEqual(vars[1]!.wavBytes);
  });

  it('validates starter patches and safely clamps out-of-range Gemini ContourTimbrePatch outputs', () => {
    for (const starter of STARTER_CONTOUR_PATCHES) {
      expect(() => ContourTimbrePatchSchema.parse(starter.patch)).not.toThrow();
    }

    expect(() =>
      ContourTimbrePatchSchema.parse({ ...STARTER_CONTOUR_PATCHES[0]!.patch, octaveShift: 9 }),
    ).toThrow();

    const clamped = parseAndClampContourPatch({
      oscShape: 'unknown_wave',
      octaveShift: 12,
      pitchSmoothMs: -50,
      scaleQuantize: 'bad_scale',
      fmRatio: 99,
      fmDepth: 5000,
      unvoicedNoiseGain: 2,
      noiseFilterHz: 20,
      filterQ: 0.1,
      subOscGain: -1,
      drive: 12,
      bitDepth: 32,
    });

    expect(clamped.oscShape).toBe('sawtooth');
    expect(clamped.octaveShift).toBe(3);
    expect(clamped.pitchSmoothMs).toBe(0);
    expect(clamped.scaleQuantize).toBe('none');
    expect(clamped.fmRatio).toBe(8);
    expect(clamped.fmDepth).toBe(800);
    expect(clamped.unvoicedNoiseGain).toBe(1);
    expect(clamped.noiseFilterHz).toBe(200);
    expect(clamped.filterQ).toBe(0.5);
    expect(clamped.subOscGain).toBe(0);
    expect(clamped.drive).toBe(6);
    expect(clamped.bitDepth).toBe(16);
  });
});
