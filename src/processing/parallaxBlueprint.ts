import { z } from 'zod';

export const ParallaxBandRoleSchema = z.enum([
  'sky-far',
  'far-mountains',
  'midground',
  'foreground-silhouette',
]);
export type ParallaxBandRole = z.infer<typeof ParallaxBandRoleSchema>;

export const ParallaxBandBlueprintSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  role: ParallaxBandRoleSchema,
  scrollRatioX: z.number().min(0.05).max(1.25),
  depthHaze: z.number().min(0).max(1),
  seamBlendPx: z.number().int().min(0).max(64),
  yOffsetPx: z.number().int().min(-256).max(256).default(0),
  subjectPrompt: z.string().min(1),
  silhouetteRule: z.string().min(1),
  edgeHeightHint: z.string().min(1),
});
export type ParallaxBandBlueprint = z.infer<typeof ParallaxBandBlueprintSchema>;

export const ParallaxSceneBlueprintSchema = z.object({
  sceneTitle: z.string().trim().min(1).max(120),
  themePrompt: z.string().min(1),
  skyTopHex: z.string().regex(/^#[0-9A-F]{6}$/),
  horizonHex: z.string().regex(/^#[0-9A-F]{6}$/),
  horizonLinePct: z.number().min(0.35).max(0.8),
  lightingDirection: z.string().min(1),
  bandCount: z.number().int().min(2).max(6),
  bands: z.array(ParallaxBandBlueprintSchema).min(2).max(6),
});
export type ParallaxSceneBlueprint = z.infer<typeof ParallaxSceneBlueprintSchema>;

/**
 * Gemini `generationConfig.responseSchema` contract matching `ParallaxSceneBlueprintSchema`.
 */
export const PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    sceneTitle: { type: 'STRING' },
    themePrompt: { type: 'STRING' },
    skyTopHex: { type: 'STRING' },
    horizonHex: { type: 'STRING' },
    horizonLinePct: { type: 'NUMBER' },
    lightingDirection: { type: 'STRING' },
    bandCount: { type: 'INTEGER' },
    bands: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING' },
          name: { type: 'STRING' },
          role: {
            type: 'STRING',
            enum: ['sky-far', 'far-mountains', 'midground', 'foreground-silhouette'],
          },
          scrollRatioX: { type: 'NUMBER' },
          depthHaze: { type: 'NUMBER' },
          seamBlendPx: { type: 'INTEGER' },
          yOffsetPx: { type: 'INTEGER' },
          subjectPrompt: { type: 'STRING' },
          silhouetteRule: { type: 'STRING' },
          edgeHeightHint: { type: 'STRING' },
        },
        required: [
          'id',
          'name',
          'role',
          'scrollRatioX',
          'depthHaze',
          'seamBlendPx',
          'yOffsetPx',
          'subjectPrompt',
          'silhouetteRule',
          'edgeHeightHint',
        ],
      },
    },
  },
  required: [
    'sceneTitle',
    'themePrompt',
    'skyTopHex',
    'horizonHex',
    'horizonLinePct',
    'lightingDirection',
    'bandCount',
    'bands',
  ],
} as const;

const ROLE_ORDER: Record<ParallaxBandRole, number> = {
  'sky-far': 0,
  'far-mountains': 1,
  midground: 2,
  'foreground-silhouette': 3,
};

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function clampRound(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
  decimals = 3,
): number {
  const clamped = clampNumber(value, min, max, fallback);
  const scale = Math.pow(10, decimals);
  return Math.round(clamped * scale) / scale;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Math.round(clampNumber(value, min, max, fallback));
}

/**
 * Normalizes `#RGB` or `#rrggbb` into uppercase `#RRGGBB`, falling back cleanly on malformed inputs.
 */
export function normalizeHexColor(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim().toUpperCase();
  const six = /^#?([0-9A-F]{6})$/.exec(trimmed);
  if (six?.[1]) return `#${six[1]}`;
  const three = /^#?([0-9A-F]{3})$/.exec(trimmed);
  if (three?.[1]) {
    const [a, b, c] = three[1].split('');
    return `#${a}${a}${b}${b}${c}${c}`;
  }
  return fallback;
}

function coerceBandRole(raw: unknown, index: number): ParallaxBandRole {
  if (
    raw === 'sky-far' ||
    raw === 'far-mountains' ||
    raw === 'midground' ||
    raw === 'foreground-silhouette'
  ) {
    return raw;
  }
  if (index === 0) return 'sky-far';
  if (index === 1) return 'far-mountains';
  if (index === 2) return 'midground';
  return 'foreground-silhouette';
}

function stripJsonCodeFence(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return fenced?.[1] ? fenced[1].trim() : trimmed;
}

function nonEmptyString(raw: unknown, fallback: string, maxLen?: number): string {
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (!trimmed) return fallback;
  return maxLen && trimmed.length > maxLen ? trimmed.slice(0, maxLen) : trimmed;
}

/**
 * Parses raw LLM JSON or object output, strictly clamps numeric fields to engine-safe bounds,
 * normalizes hex strings, deduplicates band IDs, and sorts bands back-to-front by `scrollRatioX`.
 */
export function parseAndClampParallaxBlueprint(raw: unknown): ParallaxSceneBlueprint {
  const parsedObj: unknown =
    typeof raw === 'string' ? (JSON.parse(stripJsonCodeFence(raw)) as unknown) : raw;

  if (!parsedObj || typeof parsedObj !== 'object' || Array.isArray(parsedObj)) {
    throw new Error('Parallax blueprint must be a JSON object.');
  }

  const obj = parsedObj as Record<string, unknown>;
  const rawBands = Array.isArray(obj.bands) ? obj.bands : [];
  if (rawBands.length < 2) {
    throw new Error('Parallax blueprint must define at least 2 background bands.');
  }

  const usedIds = new Set<string>();
  const clampedBands: ParallaxBandBlueprint[] = rawBands.slice(0, 6).map((item, idx) => {
    const band = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
    const role = coerceBandRole(band.role, idx);
    let id = nonEmptyString(band.id, `band-${idx + 1}`, 64).replace(/[^a-zA-Z0-9_-]+/g, '-');
    if (!id) id = `band-${idx + 1}`;
    if (usedIds.has(id)) {
      id = `${id}-${idx + 1}`;
    }
    usedIds.add(id);

    const defaultRatio =
      role === 'sky-far'
        ? 0.1
        : role === 'far-mountains'
          ? 0.25
          : role === 'midground'
            ? 0.55
            : 0.9;
    const defaultHaze =
      role === 'sky-far' ? 0.72 : role === 'far-mountains' ? 0.5 : role === 'midground' ? 0.22 : 0;

    return ParallaxBandBlueprintSchema.parse({
      id,
      name: nonEmptyString(band.name, `Layer ${idx + 1}`, 80),
      role,
      scrollRatioX: clampRound(band.scrollRatioX, 0.05, 1.25, defaultRatio, 3),
      depthHaze: clampRound(band.depthHaze, 0, 1, defaultHaze, 3),
      seamBlendPx: clampInt(band.seamBlendPx, 0, 64, 24),
      yOffsetPx: clampInt(band.yOffsetPx, -256, 256, 0),
      subjectPrompt: nonEmptyString(
        band.subjectPrompt,
        `Horizontal side-scrolling ${role.replace('-', ' ')} silhouettes`,
      ),
      silhouetteRule: nonEmptyString(
        band.silhouetteRule,
        'Clean cohesive silhouette isolated on flat magenta chroma key with no sky gradient',
      ),
      edgeHeightHint: nonEmptyString(
        band.edgeHeightHint,
        'Match terrain height along left and right edges at 60% horizon baseline',
      ),
    });
  });

  const sortedBands = [...clampedBands].sort((a, b) => {
    if (a.scrollRatioX !== b.scrollRatioX) {
      return a.scrollRatioX - b.scrollRatioX;
    }
    return ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
  });

  return ParallaxSceneBlueprintSchema.parse({
    sceneTitle: nonEmptyString(obj.sceneTitle, 'Parallax Vista', 120),
    themePrompt: nonEmptyString(obj.themePrompt, 'Atmospheric side-scrolling game vista'),
    skyTopHex: normalizeHexColor(obj.skyTopHex, '#1A1C2C'),
    horizonHex: normalizeHexColor(obj.horizonHex, '#5D275D'),
    horizonLinePct: clampRound(obj.horizonLinePct, 0.35, 0.8, 0.62, 3),
    lightingDirection: nonEmptyString(obj.lightingDirection, 'top-left dusk rim light'),
    bandCount: sortedBands.length,
    bands: sortedBands,
  });
}
