import { z } from 'zod';
import type { OscShape } from './types';
import type { ScaleQuantizeMode } from './vocalAnalyzer';

export const ScaleQuantizeSchema = z.enum(['none', 'chromatic', 'pentatonic', 'minor']);

export const ContourTimbrePatchSchema = z.object({
  oscShape: z.enum(['sine', 'triangle', 'sawtooth', 'square']),
  octaveShift: z.number().min(-3).max(3),
  pitchSmoothMs: z.number().min(0).max(80),
  scaleQuantize: ScaleQuantizeSchema,
  fmRatio: z.number().min(0).max(8),
  fmDepth: z.number().min(0).max(800),
  unvoicedNoiseGain: z.number().min(0).max(1),
  noiseFilterHz: z.number().min(200).max(12000),
  filterQ: z.number().min(0.5).max(8.0),
  subOscGain: z.number().min(0).max(1),
  drive: z.number().min(1.0).max(6.0),
  bitDepth: z.number().int().min(4).max(16),
});

export type ContourTimbrePatch = z.infer<typeof ContourTimbrePatchSchema>;

export const CONTOUR_TIMBRE_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    oscShape: { type: 'STRING', enum: ['sine', 'triangle', 'sawtooth', 'square'] },
    octaveShift: { type: 'NUMBER' },
    pitchSmoothMs: { type: 'NUMBER' },
    scaleQuantize: { type: 'STRING', enum: ['none', 'chromatic', 'pentatonic', 'minor'] },
    fmRatio: { type: 'NUMBER' },
    fmDepth: { type: 'NUMBER' },
    unvoicedNoiseGain: { type: 'NUMBER' },
    noiseFilterHz: { type: 'NUMBER' },
    filterQ: { type: 'NUMBER' },
    subOscGain: { type: 'NUMBER' },
    drive: { type: 'NUMBER' },
    bitDepth: { type: 'INTEGER' },
  },
  required: [
    'oscShape',
    'octaveShift',
    'pitchSmoothMs',
    'scaleQuantize',
    'fmRatio',
    'fmDepth',
    'unvoicedNoiseGain',
    'noiseFilterHz',
    'filterQ',
    'subOscGain',
    'drive',
    'bitDepth',
  ],
} as const;

function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const num = typeof v === 'number' && Number.isFinite(v) ? v : fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeOsc(v: unknown): OscShape {
  return v === 'sine' || v === 'triangle' || v === 'sawtooth' || v === 'square' ? v : 'sawtooth';
}

function normalizeScale(v: unknown): ScaleQuantizeMode {
  return v === 'none' || v === 'chromatic' || v === 'pentatonic' || v === 'minor' ? v : 'none';
}

/**
 * Parses Gemini JSON response and clamps every ContourTimbrePatch field safely into bounds.
 */
export function parseAndClampContourPatch(rawJson: unknown): ContourTimbrePatch {
  let obj: Record<string, unknown>;
  if (typeof rawJson === 'string') {
    const cleaned = rawJson
      .replace(/^```json\s*/i, '')
      .replace(/```\s*$/i, '')
      .trim();
    obj = JSON.parse(cleaned) as Record<string, unknown>;
  } else if (rawJson && typeof rawJson === 'object') {
    obj = rawJson as Record<string, unknown>;
  } else {
    throw new Error('Invalid ContourTimbrePatch JSON payload returned by model.');
  }

  return ContourTimbrePatchSchema.parse({
    oscShape: normalizeOsc(obj.oscShape),
    octaveShift: clampNum(obj.octaveShift, -3, 3, 0),
    pitchSmoothMs: clampNum(obj.pitchSmoothMs, 0, 80, 18),
    scaleQuantize: normalizeScale(obj.scaleQuantize),
    fmRatio: clampNum(obj.fmRatio, 0, 8, 2),
    fmDepth: clampNum(obj.fmDepth, 0, 800, 140),
    unvoicedNoiseGain: clampNum(obj.unvoicedNoiseGain, 0, 1, 0.65),
    noiseFilterHz: clampNum(obj.noiseFilterHz, 200, 12000, 2400),
    filterQ: clampNum(obj.filterQ, 0.5, 8.0, 1.8),
    subOscGain: clampNum(obj.subOscGain, 0, 1, 0.4),
    drive: clampNum(obj.drive, 1.0, 6.0, 1.8),
    bitDepth: Math.round(clampNum(obj.bitDepth, 4, 16, 16)),
  });
}

export interface StarterContourPreset {
  readonly id: string;
  readonly label: string;
  readonly promptHint: string;
  readonly patch: ContourTimbrePatch;
}

export const STARTER_CONTOUR_PATCHES: readonly StarterContourPreset[] = [
  {
    id: 'scifi-weapon',
    label: 'Sci-Fi Weapon',
    promptHint: 'Crunchy 16-bit plasma blaster with bright FM shimmer and laser noise tail',
    patch: {
      oscShape: 'sawtooth',
      octaveShift: 1,
      pitchSmoothMs: 12,
      scaleQuantize: 'none',
      fmRatio: 2.5,
      fmDepth: 260,
      unvoicedNoiseGain: 0.75,
      noiseFilterHz: 4200,
      filterQ: 2.4,
      subOscGain: 0.35,
      drive: 2.2,
      bitDepth: 12,
    },
  },
  {
    id: 'engine-rev',
    label: 'Engine / Rev',
    promptHint: 'Low mechanical turbine and sportbike engine growl following vocal rev',
    patch: {
      oscShape: 'sawtooth',
      octaveShift: -1,
      pitchSmoothMs: 36,
      scaleQuantize: 'none',
      fmRatio: 1.5,
      fmDepth: 190,
      unvoicedNoiseGain: 0.55,
      noiseFilterHz: 1800,
      filterQ: 2.0,
      subOscGain: 0.75,
      drive: 3.1,
      bitDepth: 14,
    },
  },
  {
    id: 'heavy-impact',
    label: 'Heavy Impact',
    promptHint: 'Sub-heavy metallic shield shatter with gritty unvoiced burst transients',
    patch: {
      oscShape: 'triangle',
      octaveShift: -2,
      pitchSmoothMs: 10,
      scaleQuantize: 'none',
      fmRatio: 1.4,
      fmDepth: 310,
      unvoicedNoiseGain: 0.9,
      noiseFilterHz: 2600,
      filterQ: 1.6,
      subOscGain: 0.85,
      drive: 2.8,
      bitDepth: 16,
    },
  },
  {
    id: 'chiptune-melody',
    label: '8-Bit Melody',
    promptHint: 'Crisp retro NES square lead quantized tightly to pentatonic scale notes',
    patch: {
      oscShape: 'square',
      octaveShift: 1,
      pitchSmoothMs: 45,
      scaleQuantize: 'pentatonic',
      fmRatio: 0,
      fmDepth: 0,
      unvoicedNoiseGain: 0.25,
      noiseFilterHz: 5200,
      filterQ: 1.2,
      subOscGain: 0.2,
      drive: 1.4,
      bitDepth: 8,
    },
  },
];
