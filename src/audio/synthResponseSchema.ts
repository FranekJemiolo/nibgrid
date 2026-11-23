import { ProceduralSfxParamsSchema } from '../domain/schemas';
import type { OscShape, ProceduralSfxParams } from './types';

export const PROCEDURAL_SFX_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    durationSec: { type: 'NUMBER' },
    transientGain: { type: 'NUMBER' },
    transientDecayMs: { type: 'NUMBER' },
    transientFreqHz: { type: 'NUMBER' },
    bodyGain: { type: 'NUMBER' },
    bodyShape: { type: 'STRING', enum: ['sine', 'triangle', 'sawtooth', 'square'] },
    bodyStartHz: { type: 'NUMBER' },
    bodyEndHz: { type: 'NUMBER' },
    bodyAttackMs: { type: 'NUMBER' },
    bodyDecayMs: { type: 'NUMBER' },
    fmRatio: { type: 'NUMBER' },
    fmDepth: { type: 'NUMBER' },
    noiseGain: { type: 'NUMBER' },
    noiseDecayMs: { type: 'NUMBER' },
    filterStartHz: { type: 'NUMBER' },
    filterEndHz: { type: 'NUMBER' },
    filterQ: { type: 'NUMBER' },
    bitDepth: { type: 'INTEGER' },
    drive: { type: 'NUMBER' },
  },
  required: [
    'durationSec',
    'transientGain',
    'transientDecayMs',
    'transientFreqHz',
    'bodyGain',
    'bodyShape',
    'bodyStartHz',
    'bodyEndHz',
    'bodyAttackMs',
    'bodyDecayMs',
    'fmRatio',
    'fmDepth',
    'noiseGain',
    'noiseDecayMs',
    'filterStartHz',
    'filterEndHz',
    'filterQ',
    'bitDepth',
    'drive',
  ],
} as const;

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(min, Math.min(max, num));
}

function normalizeShape(value: unknown): OscShape {
  if (value === 'sine' || value === 'triangle' || value === 'sawtooth' || value === 'square') {
    return value;
  }
  return 'triangle';
}

/**
 * Parses Gemini JSON output and strictly clamps every ProceduralSfxParams field within safe bounds.
 */
export function parseAndClampSynthParams(rawJson: unknown, seed = 1024): ProceduralSfxParams {
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
    throw new Error('Invalid synth JSON payload returned by model.');
  }

  return ProceduralSfxParamsSchema.parse({
    seed: Math.max(0, Math.min(0xffffffff, Math.floor(seed))) >>> 0,
    durationSec: clamp(obj.durationSec, 0.05, 4.0, 0.25),
    sampleRate: 44100,
    transientGain: clamp(obj.transientGain, 0, 1, 0.7),
    transientDecayMs: clamp(obj.transientDecayMs, 2, 40, 12),
    transientFreqHz: clamp(obj.transientFreqHz, 80, 4000, 1200),
    bodyGain: clamp(obj.bodyGain, 0, 1, 0.75),
    bodyShape: normalizeShape(obj.bodyShape),
    bodyStartHz: clamp(obj.bodyStartHz, 20, 2400, 260),
    bodyEndHz: clamp(obj.bodyEndHz, 20, 2400, 75),
    bodyAttackMs: clamp(obj.bodyAttackMs, 0, 50, 2),
    bodyDecayMs: clamp(obj.bodyDecayMs, 15, 2000, 120),
    fmRatio: clamp(obj.fmRatio, 0, 8, 1),
    fmDepth: clamp(obj.fmDepth, 0, 600, 40),
    noiseGain: clamp(obj.noiseGain, 0, 1, 0.45),
    noiseDecayMs: clamp(obj.noiseDecayMs, 15, 2500, 120),
    filterStartHz: clamp(obj.filterStartHz, 100, 14000, 3200),
    filterEndHz: clamp(obj.filterEndHz, 80, 12000, 600),
    filterQ: clamp(obj.filterQ, 0.5, 8.0, 1.4),
    bitDepth: Math.round(clamp(obj.bitDepth, 4, 16, 16)),
    drive: clamp(obj.drive, 1.0, 6.0, 1.6),
  });
}

const ALLOWED_VOCAL_TAGS = new Set([
  'grunt',
  'chuckle',
  'gasp',
  'sigh',
  'pause',
  'laugh',
  'cough',
  'yawn',
  'groan',
]);

/**
 * Flags non-vocal SFX tags (e.g. `<thud>`, `[explosion]`, `<applause>`) that Gemini TTS advises against.
 */
export function detectNonVocalSfxTags(script: string): readonly string[] {
  const warnings = new Set<string>();
  const matches = script.match(/<[a-zA-Z0-9_-]+>|\[[a-zA-Z0-9_\s-]+\]/g) ?? [];
  for (const raw of matches) {
    const token = raw.slice(1, -1).trim().toLowerCase();
    if (!ALLOWED_VOCAL_TAGS.has(token)) {
      warnings.add(raw);
    }
  }
  return [...warnings];
}
