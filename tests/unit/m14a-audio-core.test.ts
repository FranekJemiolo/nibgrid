import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  GOOGLE_AUDIO_PRESETS,
  GoogleAudioPresetSchema,
  getGoogleAudioPreset,
} from '../../src/audio/googlePresets';
import {
  cropRegionPcm,
  dbToLinear,
  decodeWav16,
  encodeWav16,
  makeSeamlessLoopPcm,
  measureApproxLufs,
  normalizeLufsPcm,
  trimSilencePcm,
} from '../../src/audio/pcmPostProcess';
import { synthesizeProceduralSfx } from '../../src/audio/proceduralSynth';
import type { AudioPostProcessConfig, PcmBuffer } from '../../src/audio/types';
import { generatePcmVariations, generateProceduralVariations } from '../../src/audio/variations';
import { AudioRecipeSchema, buildAudioRecipe, packageAudioZip } from '../../src/export/audioExport';

function makeSineBurstPadded(
  sampleRate = 44100,
  padSec = 0.5,
  toneSec = 0.25,
  freqHz = 440,
  amplitude = 0.4,
): PcmBuffer {
  const padSamples = Math.round(padSec * sampleRate);
  const toneSamples = Math.round(toneSec * sampleRate);
  const samples = new Float32Array(padSamples * 2 + toneSamples);

  for (let i = 0; i < toneSamples; i++) {
    samples[padSamples + i] = amplitude * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return { sampleRate, channels: 1, samples };
}

function makeScaledSineForTargetLufs(
  targetLufs: number,
  sampleRate = 44100,
  durationSec = 0.5,
): PcmBuffer {
  const len = Math.round(sampleRate * durationSec);
  const unit = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    unit[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate);
  }
  const curLufs = measureApproxLufs({ sampleRate, channels: 1, samples: unit });
  const scale = dbToLinear(targetLufs - curLufs);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = (unit[i] ?? 0) * scale;
  }
  return { sampleRate, channels: 1, samples: out };
}

const DEFAULT_POST: AudioPostProcessConfig = {
  trimSilence: true,
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

describe('M14A Pure-TS Audio Synth, PCM DSP, Google Presets & WAV/ZIP Core', () => {
  it('synthesizes byte-identical 44.1 kHz Float32Array PCM buffers with samples strictly in [-1, 1]', () => {
    const preset = getGoogleAudioPreset('sfx-sprite-impact');
    const a = synthesizeProceduralSfx(preset.fallbackSynthParams);
    const b = synthesizeProceduralSfx(preset.fallbackSynthParams);

    expect(a.sampleRate).toBe(44100);
    expect(a.channels).toBe(1);
    expect(a.samples).toEqual(b.samples);

    for (let i = 0; i < a.samples.length; i++) {
      const s = a.samples[i]!;
      expect(Number.isNaN(s)).toBe(false);
      expect(s).toBeGreaterThanOrEqual(-1);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('round-trips encodeWav16 -> decodeWav16 cleanly with valid RIFF/WAVE/data chunks', () => {
    const preset = getGoogleAudioPreset('sfx-ui-tactile');
    const raw = synthesizeProceduralSfx(preset.fallbackSynthParams);
    const wavBytes = encodeWav16(raw);

    expect(String.fromCharCode(...wavBytes.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wavBytes.slice(8, 12))).toBe('WAVE');
    expect(String.fromCharCode(...wavBytes.slice(36, 40))).toBe('data');
    expect(wavBytes.byteLength).toBe(44 + raw.samples.length * 2);

    const decoded = decodeWav16(wavBytes);
    expect(decoded.sampleRate).toBe(raw.sampleRate);
    expect(decoded.channels).toBe(1);
    expect(decoded.samples.length).toBe(raw.samples.length);

    let maxErr = 0;
    for (let i = 0; i < raw.samples.length; i++) {
      const err = Math.abs((decoded.samples[i] ?? 0) - (raw.samples[i] ?? 0));
      if (err > maxErr) maxErr = err;
    }
    expect(maxErr).toBeLessThanOrEqual(1 / 32767 + 1e-6);
  });

  it('crops exact [startSec, endSec] slices and trims >98% of dead padding onto zero-crossings', () => {
    const padded = makeSineBurstPadded(44100, 0.5, 0.25, 440, 0.5);
    expect(padded.samples.length).toBe(Math.round(1.25 * 44100));

    const cropped = cropRegionPcm(padded, 0.5, 0.75);
    expect(cropped.samples.length).toBe(Math.round(0.25 * 44100));

    const trimmed = trimSilencePcm(padded, -48, 2, 8);
    const deadSamplesRemoved = padded.samples.length - trimmed.samples.length;
    const expectedDeadSamples = Math.round(1.0 * 44100);
    expect(deadSamplesRemoved / expectedDeadSamples).toBeGreaterThan(0.98);
    expect(Math.abs(trimmed.samples[0] ?? 1)).toBeLessThan(0.01);
    expect(Math.abs(trimmed.samples[trimmed.samples.length - 1] ?? 1)).toBeLessThan(0.01);
  });

  it('normalizes -34 LUFS input to -14 LUFS within +-1.0 LU and enforces -1.0 dBFS peak ceiling', () => {
    const quiet = makeScaledSineForTargetLufs(-34);
    expect(measureApproxLufs(quiet)).toBeCloseTo(-34, 0.5);

    const { buffer, outputLufs } = normalizeLufsPcm(quiet, -14, -1.0);
    expect(Math.abs(outputLufs - -14)).toBeLessThanOrEqual(1.0);

    const maxAllowed = dbToLinear(-1.0) + 1e-4;
    for (let i = 0; i < buffer.samples.length; i++) {
      expect(Math.abs(buffer.samples[i] ?? 0)).toBeLessThanOrEqual(maxAllowed);
    }

    // Extreme impulsive signal should also remain strictly bounded by ceilingDb
    const loud = makeScaledSineForTargetLufs(-3);
    const capped = normalizeLufsPcm(loud, -2, -1.0);
    for (let i = 0; i < capped.buffer.samples.length; i++) {
      expect(Math.abs(capped.buffer.samples[i] ?? 0)).toBeLessThanOrEqual(maxAllowed);
    }
  });

  it('crossfades seamless loops to exact (inLen - fadeSamples) and passes Zod validation for all 12 Google presets', () => {
    const src = makeScaledSineForTargetLufs(-16, 44100, 1.0);
    const fadeSamples = Math.round(0.12 * 44100);
    const looped = makeSeamlessLoopPcm(src, 120);
    expect(looped.samples.length).toBe(src.samples.length - fadeSamples);

    expect(GOOGLE_AUDIO_PRESETS).toHaveLength(12);
    for (const preset of GOOGLE_AUDIO_PRESETS) {
      expect(() => GoogleAudioPresetSchema.parse(preset)).not.toThrow();
    }
  });

  it('generates 4 micro-variations, validates audio.recipe.json, packages ZIP, and blocks key leaks', () => {
    const preset = getGoogleAudioPreset('sfx-sprite-impact');
    const variations = generateProceduralVariations(preset.fallbackSynthParams, DEFAULT_POST, 4);
    expect(variations).toHaveLength(4);

    // Distinct waveforms across variations
    expect(variations[0]!.wavBytes).not.toEqual(variations[1]!.wavBytes);

    // Resampled PCM variations also succeed cleanly
    const pcmVars = generatePcmVariations(variations[0]!.buffer, DEFAULT_POST, 4, 777);
    expect(pcmVars).toHaveLength(4);

    const recipe = buildAudioRecipe({
      slug: 'cat-hit',
      assetName: 'Cat Impact',
      presetId: preset.id,
      route: 'local-synth',
      modelId: 'nibgrid-synth-v1',
      promptOrScript: 'impact sfx with dummy AIzaSySECRET123456789',
      synthParams: preset.fallbackSynthParams,
      postProcess: DEFAULT_POST,
      variations,
      secretsToRedact: ['AIzaSySECRET123456789'],
    });
    expect(recipe.promptOrScript).not.toContain('AIzaSySECRET123456789');

    const zipBytes = packageAudioZip({ slug: 'cat-hit', variations, recipe });
    const entries = unzipSync(zipBytes);
    expect(Object.keys(entries).sort()).toEqual([
      'cat-hit.audio.recipe.json',
      'cat-hit_01.wav',
      'cat-hit_02.wav',
      'cat-hit_03.wav',
      'cat-hit_04.wav',
    ]);

    for (const i of ['01', '02', '03', '04']) {
      const wav = entries[`cat-hit_${i}.wav`]!;
      expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
      expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    }

    const parsedRecipe = AudioRecipeSchema.parse(
      JSON.parse(strFromU8(entries['cat-hit.audio.recipe.json']!)),
    );
    expect(parsedRecipe.variationCount).toBe(4);
    expect(parsedRecipe.schemaVersion).toBe('1.0.0');
  });
});
