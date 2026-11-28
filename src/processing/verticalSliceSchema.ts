import { z } from 'zod';

export const SliceExecutionTierSchema = z.enum(['instant-draft', 'hybrid-prod', 'full-genai']);
export type SliceExecutionTier = z.infer<typeof SliceExecutionTierSchema>;

export const SliceGenreSchema = z.enum(['side-platformer', 'top-down', 'twin-stick']);
export type SliceGenre = z.infer<typeof SliceGenreSchema>;

export const SliceScopeSchema = z.enum(['single-arena', 'multi-room-dungeon', 'town-and-boss']);
export type SliceScope = z.infer<typeof SliceScopeSchema>;

export const SlicePosePresetSchema = z.enum(['run_6f', 'melee_slash_5f', 'idle_4f']);
export type SlicePosePreset = z.infer<typeof SlicePosePresetSchema>;

export const SliceBodyTypeSchema = z.enum(['CharacterBody2D', 'Area2D', 'StaticBody2D']);
export type SliceBodyType = z.infer<typeof SliceBodyTypeSchema>;

export const SliceCastMemberSpecSchema = z.object({
  slug: z.string().regex(/^[a-z][a-z0-9_]*$/),
  role: z.enum(['hero', 'enemy', 'prop']),
  prompt: z.string().min(1),
  bodyType: SliceBodyTypeSchema,
  posePreset: SlicePosePresetSchema.optional(),
});
export type SliceCastMemberSpec = z.infer<typeof SliceCastMemberSpecSchema>;

export const VerticalSliceBlueprintSchema = z.object({
  projectSlug: z.string().regex(/^[a-z][a-z0-9_]*$/),
  genre: SliceGenreSchema,
  artBiblePrompt: z.string().min(1),
  artMode: z.enum(['pixel-art', 'hd-handdrawn']),
  tileSizePx: z.union([z.literal(16), z.literal(32), z.literal(64)]),
  paletteHex: z
    .array(z.string().regex(/^#[0-9A-Fa-f]{6}$/))
    .min(4)
    .max(16)
    .optional(),
  cast: z.array(SliceCastMemberSpecSchema).min(1).max(6),
  terrainPrompt: z.string().min(1),
  parallaxPrompt: z.string().min(1),
  uiThemePrompt: z.string().min(1),
  roomPrompt: z.string().min(1),
  roomCols: z.number().int().min(16).max(48),
  roomRows: z.number().int().min(10).max(24),
  scope: SliceScopeSchema.optional(),
  includeFullGameKit: z.boolean().optional(),
});
export type VerticalSliceBlueprint = z.infer<typeof VerticalSliceBlueprintSchema>;

export const VERTICAL_SLICE_GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    projectSlug: { type: 'STRING' },
    genre: { type: 'STRING', enum: ['side-platformer', 'top-down', 'twin-stick'] },
    artBiblePrompt: { type: 'STRING' },
    artMode: { type: 'STRING', enum: ['pixel-art', 'hd-handdrawn'] },
    tileSizePx: { type: 'INTEGER' },
    paletteHex: { type: 'ARRAY', items: { type: 'STRING' } },
    cast: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          slug: { type: 'STRING' },
          role: { type: 'STRING', enum: ['hero', 'enemy', 'prop'] },
          prompt: { type: 'STRING' },
          bodyType: { type: 'STRING', enum: ['CharacterBody2D', 'Area2D', 'StaticBody2D'] },
          posePreset: { type: 'STRING', enum: ['run_6f', 'melee_slash_5f', 'idle_4f'] },
        },
        required: ['slug', 'role', 'prompt', 'bodyType'],
      },
    },
    terrainPrompt: { type: 'STRING' },
    parallaxPrompt: { type: 'STRING' },
    uiThemePrompt: { type: 'STRING' },
    roomPrompt: { type: 'STRING' },
    roomCols: { type: 'INTEGER' },
    roomRows: { type: 'INTEGER' },
  },
  required: [
    'projectSlug',
    'genre',
    'artBiblePrompt',
    'artMode',
    'tileSizePx',
    'cast',
    'terrainPrompt',
    'parallaxPrompt',
    'uiThemePrompt',
    'roomPrompt',
    'roomCols',
    'roomRows',
  ],
} as const;

/**
 * Sanitizes an identifier into strict `^[a-z][a-z0-9_]*$` snake_case required by Nibgrid & Godot 4.
 */
export function sanitizeSliceSlug(raw: string, fallback = 'nibgrid_slice'): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const withAlphaHead =
    cleaned.length === 0 ? fallback : /^[a-z]/.test(cleaned) ? cleaned : `s_${cleaned}`;
  return withAlphaHead.slice(0, 48);
}

function snapTileSize(raw: unknown): 16 | 32 | 64 {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : 32;
  if (n <= 24) return 16;
  if (n >= 48) return 64;
  return 32;
}

function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.max(min, Math.min(max, Math.round(raw)));
}

/**
 * Parses and clamps an arbitrary JSON blueprint into a strict `VerticalSliceBlueprint`:
 * - enforces `^[a-z][a-z0-9_]*$` slugs (deduplicated)
 * - clamps `roomCols` in `[16, 48]` and `roomRows` in `[10, 24]`
 * - ensures `cast[0]` is always `'hero'` and caps `cast` length at `6`
 */
export function parseAndClampVerticalSliceBlueprint(
  raw: unknown,
  opts: { readonly fallbackPrompt?: string; readonly fallbackGenre?: SliceGenre } = {},
): VerticalSliceBlueprint {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const fallbackPrompt =
    opts.fallbackPrompt?.trim() ||
    '16-bit gothic platformer vertical slice with hero and skeletons';
  const fallbackGenre = opts.fallbackGenre ?? 'side-platformer';

  const genre: SliceGenre =
    obj.genre === 'top-down' || obj.genre === 'twin-stick' || obj.genre === 'side-platformer'
      ? obj.genre
      : fallbackGenre;

  const artMode = obj.artMode === 'hd-handdrawn' ? 'hd-handdrawn' : 'pixel-art';
  const tileSizePx = snapTileSize(obj.tileSizePx);

  const rawPalette = Array.isArray(obj.paletteHex)
    ? obj.paletteHex
        .filter((c): c is string => typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c.trim()))
        .map((c) => c.trim().toUpperCase())
        .slice(0, 16)
    : [];
  const paletteHex =
    rawPalette.length >= 4
      ? rawPalette
      : ['#14101C', '#2E2640', '#6E5A82', '#C89F65', '#E8D5B7', '#A63A48'];

  const rawCast = Array.isArray(obj.cast) ? obj.cast : [];
  const parsedCast: SliceCastMemberSpec[] = [];
  const seenSlugs = new Set<string>();

  for (let i = 0; i < Math.min(6, rawCast.length); i++) {
    const entry =
      typeof rawCast[i] === 'object' && rawCast[i] !== null
        ? (rawCast[i] as Record<string, unknown>)
        : {};
    let slug = sanitizeSliceSlug(
      typeof entry.slug === 'string' ? entry.slug : `actor_${i + 1}`,
      `actor_${i + 1}`,
    );
    let suffix = 2;
    while (seenSlugs.has(slug)) {
      slug = `${slug.slice(0, 42)}_${suffix++}`;
    }
    seenSlugs.add(slug);

    const role: SliceCastMemberSpec['role'] =
      i === 0
        ? 'hero'
        : entry.role === 'prop' || entry.role === 'enemy' || entry.role === 'hero'
          ? entry.role
          : 'enemy';
    const bodyType: SliceBodyType =
      entry.bodyType === 'Area2D' ||
      entry.bodyType === 'StaticBody2D' ||
      entry.bodyType === 'CharacterBody2D'
        ? entry.bodyType
        : role === 'prop'
          ? 'Area2D'
          : 'CharacterBody2D';
    const posePreset: SlicePosePreset | undefined =
      entry.posePreset === 'run_6f' ||
      entry.posePreset === 'melee_slash_5f' ||
      entry.posePreset === 'idle_4f'
        ? entry.posePreset
        : role === 'prop'
          ? undefined
          : role === 'hero'
            ? 'run_6f'
            : 'idle_4f';

    parsedCast.push({
      slug,
      role,
      prompt:
        typeof entry.prompt === 'string' && entry.prompt.trim().length > 0
          ? entry.prompt.trim()
          : `${slug.replace(/_/g, ' ')} game sprite`,
      bodyType,
      ...(posePreset ? { posePreset } : {}),
    });
  }

  if (parsedCast.length === 0) {
    parsedCast.push({
      slug: 'armored_hero',
      role: 'hero',
      prompt: 'Armored fantasy knight hero, side-view sprite, crisp silhouette',
      bodyType: 'CharacterBody2D',
      posePreset: 'run_6f',
    });
  } else if (parsedCast[0]!.role !== 'hero') {
    parsedCast[0] = { ...parsedCast[0]!, role: 'hero', bodyType: 'CharacterBody2D' };
  }

  return VerticalSliceBlueprintSchema.parse({
    projectSlug: sanitizeSliceSlug(
      typeof obj.projectSlug === 'string' ? obj.projectSlug : fallbackPrompt.slice(0, 24),
      'vertical_slice',
    ),
    genre,
    artBiblePrompt:
      typeof obj.artBiblePrompt === 'string' && obj.artBiblePrompt.trim().length > 0
        ? obj.artBiblePrompt.trim()
        : fallbackPrompt,
    artMode,
    tileSizePx,
    paletteHex,
    cast: parsedCast,
    terrainPrompt:
      typeof obj.terrainPrompt === 'string' && obj.terrainPrompt.trim().length > 0
        ? obj.terrainPrompt.trim()
        : 'Chiseled stone brick auto-tile terrain',
    parallaxPrompt:
      typeof obj.parallaxPrompt === 'string' && obj.parallaxPrompt.trim().length > 0
        ? obj.parallaxPrompt.trim()
        : 'Moody atmospheric twilight skyline parallax layers',
    uiThemePrompt:
      typeof obj.uiThemePrompt === 'string' && obj.uiThemePrompt.trim().length > 0
        ? obj.uiThemePrompt.trim()
        : 'Beveled 9-slice RPG HUD frame and health bar',
    roomPrompt:
      typeof obj.roomPrompt === 'string' && obj.roomPrompt.trim().length > 0
        ? obj.roomPrompt.trim()
        : 'Boss encounter arena with two stone pillars and raised platforms',
    roomCols: clampInt(obj.roomCols, 16, 48, 24),
    roomRows: clampInt(obj.roomRows, 10, 24, 14),
    ...(obj.scope === 'single-arena' ||
    obj.scope === 'multi-room-dungeon' ||
    obj.scope === 'town-and-boss'
      ? { scope: obj.scope }
      : {}),
    ...(typeof obj.includeFullGameKit === 'boolean'
      ? { includeFullGameKit: obj.includeFullGameKit }
      : {}),
  });
}

export interface SliceCostEstimate {
  readonly totalUsd: number;
  readonly label: string;
  readonly breakdown: {
    readonly planningUsd: number;
    readonly spritesUsd: number;
    readonly parallaxUsd: number;
    readonly uiAndAudioUsd: number;
  };
}

/**
 * Computes transparent pre-execution cost breakdown per `SliceExecutionTier`.
 */
export function estimateSliceCostUsd(
  blueprint: VerticalSliceBlueprint,
  tier: SliceExecutionTier,
): SliceCostEstimate {
  if (tier === 'instant-draft') {
    return {
      totalUsd: 0,
      label: 'Instant Draft · $0.00',
      breakdown: { planningUsd: 0, spritesUsd: 0, parallaxUsd: 0, uiAndAudioUsd: 0 },
    };
  }

  const planningUsd = 0.002;
  const castCount = blueprint.cast.length;
  if (tier === 'hybrid-prod') {
    const spritesUsd = Number(((1 + castCount) * 0.025).toFixed(3));
    const parallaxUsd = 0.06;
    const totalUsd = Number((planningUsd + spritesUsd + parallaxUsd).toFixed(2));
    return {
      totalUsd,
      label: `Hybrid Production · ~$${totalUsd.toFixed(2)}`,
      breakdown: { planningUsd, spritesUsd, parallaxUsd, uiAndAudioUsd: 0 },
    };
  }

  // full-genai: GenAI hero + cast sprites + pose sheets + parallax + UI state sheet + AI audio
  const spritesUsd = Number(((1 + castCount * 2) * 0.03).toFixed(3));
  const parallaxUsd = 0.09;
  const uiAndAudioUsd = 0.14;
  const totalUsd = Number((planningUsd + spritesUsd + parallaxUsd + uiAndAudioUsd).toFixed(2));
  return {
    totalUsd,
    label: `Full GenAI · ~$${totalUsd.toFixed(2)}`,
    breakdown: { planningUsd, spritesUsd, parallaxUsd, uiAndAudioUsd },
  };
}
