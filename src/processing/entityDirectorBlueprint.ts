import { z } from 'zod';
import { SocketDefinitionSchema, type SocketDefinition } from '../domain/schemas';

export const EntityGenrePresetSchema = z.enum([
  'top-down',
  'side-platformer',
  'twin-stick',
  'prop-interactive',
]);
export type EntityGenrePreset = z.infer<typeof EntityGenrePresetSchema>;

export const DirectorSocketHintSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9_]+$/),
  normX: z.number().min(0).max(1),
  normY: z.number().min(0).max(1),
  baseAngleDeg: z.number().min(-360).max(360).default(0),
});
export type DirectorSocketHint = z.infer<typeof DirectorSocketHintSchema>;

export const DirectorSfxPresetSchema = z.enum(['hit', 'footstep', 'laser', 'pickup', 'jump']);
export type DirectorSfxPreset = z.infer<typeof DirectorSfxPresetSchema>;

export const DirectorSfxSpecSchema = z.object({
  cueName: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9_]+$/),
  category: z.enum(['sfx', 'ui']).default('sfx'),
  prompt: z.string().trim().min(1).max(240),
  engine: z.enum(['procedural', 'google-ai']).default('procedural'),
  proceduralPreset: DirectorSfxPresetSchema.optional(),
});
export type DirectorSfxSpec = z.infer<typeof DirectorSfxSpecSchema>;

export const DirectorArchetypeSchema = z.enum([
  'player',
  'melee-enemy',
  'ranged-enemy',
  'pickup',
  'hazard',
]);
export type DirectorArchetype = z.infer<typeof DirectorArchetypeSchema>;

export const DirectorBehaviorSpecSchema = z.object({
  archetype: DirectorArchetypeSchema.default('melee-enemy'),
  moveSpeed: z.number().min(0).max(2000).default(110),
  maxHealth: z.number().int().min(1).max(99999).default(40),
  attackDamage: z.number().int().min(0).max(9999).default(10),
  states: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .regex(/^[A-Z][A-Z0-9_]*$/),
    )
    .min(1)
    .max(12),
});
export type DirectorBehaviorSpec = z.infer<typeof DirectorBehaviorSpecSchema>;

export const DirectorBodyTypeSchema = z.enum([
  'CharacterBody2D',
  'StaticBody2D',
  'Area2D',
  'RigidBody2D',
]);
export type DirectorBodyType = z.infer<typeof DirectorBodyTypeSchema>;

export const DirectorColliderModeSchema = z.enum(['convex-hull', 'capsule', 'rect']);
export type DirectorColliderMode = z.infer<typeof DirectorColliderModeSchema>;

export const EntityDirectorBlueprintSchema = z.object({
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9_]*$/),
  displayName: z.string().trim().min(1).max(80),
  bodyType: DirectorBodyTypeSchema.default('CharacterBody2D'),
  spritePrompt: z.string().trim().min(1).max(400),
  turnaroundLayout: z.enum(['single', '2x2']).default('single'),
  generateNormalMap: z.boolean().default(false),
  colliderMode: DirectorColliderModeSchema.default('convex-hull'),
  includeHitbox: z.boolean().default(true),
  includeHurtbox: z.boolean().default(true),
  sockets: z.array(DirectorSocketHintSchema).max(8).default([]),
  sfxSpecs: z.array(DirectorSfxSpecSchema).max(6).default([]),
  behavior: DirectorBehaviorSpecSchema,
});
export type EntityDirectorBlueprint = z.infer<typeof EntityDirectorBlueprintSchema>;

/**
 * Gemini JSON responseSchema enforcing structured Stage 1 Entity Blueprint output.
 */
export const ENTITY_BLUEPRINT_GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  required: [
    'slug',
    'displayName',
    'bodyType',
    'spritePrompt',
    'turnaroundLayout',
    'generateNormalMap',
    'colliderMode',
    'includeHitbox',
    'includeHurtbox',
    'sockets',
    'sfxSpecs',
    'behavior',
  ],
  properties: {
    slug: { type: 'STRING' },
    displayName: { type: 'STRING' },
    bodyType: {
      type: 'STRING',
      enum: ['CharacterBody2D', 'StaticBody2D', 'Area2D', 'RigidBody2D'],
    },
    spritePrompt: { type: 'STRING' },
    turnaroundLayout: { type: 'STRING', enum: ['single', '2x2'] },
    generateNormalMap: { type: 'BOOLEAN' },
    colliderMode: { type: 'STRING', enum: ['convex-hull', 'capsule', 'rect'] },
    includeHitbox: { type: 'BOOLEAN' },
    includeHurtbox: { type: 'BOOLEAN' },
    sockets: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['name', 'normX', 'normY', 'baseAngleDeg'],
        properties: {
          name: { type: 'STRING' },
          normX: { type: 'NUMBER' },
          normY: { type: 'NUMBER' },
          baseAngleDeg: { type: 'NUMBER' },
        },
      },
    },
    sfxSpecs: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        required: ['cueName', 'category', 'prompt', 'engine'],
        properties: {
          cueName: { type: 'STRING' },
          category: { type: 'STRING', enum: ['sfx', 'ui'] },
          prompt: { type: 'STRING' },
          engine: { type: 'STRING', enum: ['procedural', 'google-ai'] },
          proceduralPreset: {
            type: 'STRING',
            enum: ['hit', 'footstep', 'laser', 'pickup', 'jump'],
          },
        },
      },
    },
    behavior: {
      type: 'OBJECT',
      required: ['archetype', 'moveSpeed', 'maxHealth', 'attackDamage', 'states'],
      properties: {
        archetype: {
          type: 'STRING',
          enum: ['player', 'melee-enemy', 'ranged-enemy', 'pickup', 'hazard'],
        },
        moveSpeed: { type: 'NUMBER' },
        maxHealth: { type: 'INTEGER' },
        attackDamage: { type: 'INTEGER' },
        states: { type: 'ARRAY', items: { type: 'STRING' } },
      },
    },
  },
} as const;

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function sanitizeSnakeIdentifier(raw: unknown, fallback: string, requireAlphaLead = false): string {
  const str = typeof raw === 'string' ? raw : '';
  let cleaned = str
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  if (cleaned.length === 0) {
    cleaned = fallback;
  }
  if (requireAlphaLead && /^[0-9]/.test(cleaned)) {
    cleaned = `entity_${cleaned}`.slice(0, 64);
  }
  return cleaned;
}

function sanitizeEnumState(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  if (!cleaned) return null;
  if (/^[0-9]/.test(cleaned)) {
    cleaned = `STATE_${cleaned}`.slice(0, 32);
  }
  return cleaned;
}

function defaultBodyForGenre(genre: EntityGenrePreset): DirectorBodyType {
  if (genre === 'prop-interactive') return 'Area2D';
  return 'CharacterBody2D';
}

/**
 * Normalizes, sanitizes, and strictly clamps arbitrary LLM JSON output into a valid
 * `EntityDirectorBlueprint` so malformed model responses never crash downstream workers
 * or produce invalid Godot identifiers.
 */
export function parseAndClampDirectorBlueprint(
  raw: unknown,
  fallbackPrompt = 'pixel art 2D game entity',
  genre: EntityGenrePreset = 'side-platformer',
): EntityDirectorBlueprint {
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const displayNameRaw = typeof obj.displayName === 'string' ? obj.displayName.trim() : '';
  const displayName = (displayNameRaw || fallbackPrompt).slice(0, 80);

  const slug = sanitizeSnakeIdentifier(
    obj.slug ?? displayName,
    sanitizeSnakeIdentifier(displayName, 'nibgrid_entity', true),
    true,
  );

  const bodyCandidate = DirectorBodyTypeSchema.safeParse(obj.bodyType);
  const bodyType = bodyCandidate.success ? bodyCandidate.data : defaultBodyForGenre(genre);

  const spritePromptRaw = typeof obj.spritePrompt === 'string' ? obj.spritePrompt.trim() : '';
  const spritePrompt = (spritePromptRaw || fallbackPrompt).slice(0, 400);

  const turnaroundLayout = obj.turnaroundLayout === '2x2' ? '2x2' : 'single';
  const generateNormalMap = Boolean(obj.generateNormalMap);

  const colliderCandidate = DirectorColliderModeSchema.safeParse(obj.colliderMode);
  const colliderMode = colliderCandidate.success ? colliderCandidate.data : 'convex-hull';
  const includeHitbox =
    typeof obj.includeHitbox === 'boolean' ? obj.includeHitbox : bodyType !== 'StaticBody2D';
  const includeHurtbox =
    typeof obj.includeHurtbox === 'boolean' ? obj.includeHurtbox : bodyType !== 'StaticBody2D';

  const rawSockets = Array.isArray(obj.sockets) ? obj.sockets : [];
  const seenSocketNames = new Set<string>();
  const sockets: DirectorSocketHint[] = [];
  for (let i = 0; i < rawSockets.length && sockets.length < 8; i++) {
    const s =
      typeof rawSockets[i] === 'object' && rawSockets[i] !== null
        ? (rawSockets[i] as Record<string, unknown>)
        : {};
    const name = sanitizeSnakeIdentifier(s.name, `socket_${i + 1}`, false).slice(0, 48);
    if (seenSocketNames.has(name)) continue;
    seenSocketNames.add(name);
    sockets.push({
      name,
      normX: Number(clamp(Number(s.normX), 0, 1, 0.5).toFixed(4)),
      normY: Number(clamp(Number(s.normY), 0, 1, 0.5).toFixed(4)),
      baseAngleDeg: Number(clamp(Number(s.baseAngleDeg), -360, 360, 0).toFixed(2)),
    });
  }

  const rawSfx = Array.isArray(obj.sfxSpecs) ? obj.sfxSpecs : [];
  const seenCues = new Set<string>();
  const sfxSpecs: DirectorSfxSpec[] = [];
  for (let i = 0; i < rawSfx.length && sfxSpecs.length < 6; i++) {
    const entry =
      typeof rawSfx[i] === 'object' && rawSfx[i] !== null
        ? (rawSfx[i] as Record<string, unknown>)
        : {};
    const cueName = sanitizeSnakeIdentifier(entry.cueName, `sfx_${i + 1}`, false).slice(0, 48);
    if (seenCues.has(cueName)) continue;
    seenCues.add(cueName);
    const presetCheck = DirectorSfxPresetSchema.safeParse(entry.proceduralPreset);
    sfxSpecs.push({
      cueName,
      category: entry.category === 'ui' ? 'ui' : 'sfx',
      prompt:
        typeof entry.prompt === 'string' && entry.prompt.trim().length > 0
          ? entry.prompt.trim().slice(0, 240)
          : `${cueName.replace(/_/g, ' ')} game sound effect`,
      engine: entry.engine === 'google-ai' ? 'google-ai' : 'procedural',
      ...(presetCheck.success ? { proceduralPreset: presetCheck.data } : {}),
    });
  }

  const rawBehav =
    typeof obj.behavior === 'object' && obj.behavior !== null
      ? (obj.behavior as Record<string, unknown>)
      : {};
  const archCandidate = DirectorArchetypeSchema.safeParse(rawBehav.archetype);
  const rawStates = Array.isArray(rawBehav.states) ? rawBehav.states : [];
  const states: string[] = [];
  const seenStates = new Set<string>();
  for (let i = 0; i < rawStates.length && states.length < 12; i++) {
    const clean = sanitizeEnumState(rawStates[i]);
    if (clean && !seenStates.has(clean)) {
      seenStates.add(clean);
      states.push(clean);
    }
  }
  if (states.length === 0) {
    states.push('IDLE', 'PATROL', 'ATTACK', 'HURT');
  }

  return EntityDirectorBlueprintSchema.parse({
    slug,
    displayName,
    bodyType,
    spritePrompt,
    turnaroundLayout,
    generateNormalMap,
    colliderMode,
    includeHitbox,
    includeHurtbox,
    sockets,
    sfxSpecs,
    behavior: {
      archetype: archCandidate.success ? archCandidate.data : 'melee-enemy',
      moveSpeed: Number(clamp(Number(rawBehav.moveSpeed), 0, 2000, 95).toFixed(2)),
      maxHealth: Math.round(clamp(Number(rawBehav.maxHealth), 1, 99999, 40)),
      attackDamage: Math.round(clamp(Number(rawBehav.attackDamage), 0, 9999, 10)),
      states,
    },
  });
}

export interface OpaquePixelBounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Finds the tight bounding box of non-transparent pixels in an RGBA sprite buffer.
 */
export function computeOpaqueBounds(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  alphaThreshold = 16,
): OpaquePixelBounds {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3] ?? 0;
      if (alpha >= alphaThreshold) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    return {
      minX: 0,
      minY: 0,
      maxX: Math.max(0, width - 1),
      maxY: Math.max(0, height - 1),
      width: Math.max(1, width),
      height: Math.max(1, height),
    };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: Math.max(1, maxX - minX + 1),
    height: Math.max(1, maxY - minY + 1),
  };
}

const SOCKET_COLORS = ['#F5B82E', '#38BDF8', '#FB7185', '#34D399', '#A78BFA'] as const;

/**
 * Deterministically maps normalized [0..1] blueprint socket hints onto exact pixel
 * coordinates strictly inside the sprite's opaque bounding box.
 */
export function resolveSocketHintsToPixels(
  opaqueBounds: OpaquePixelBounds,
  hints: readonly DirectorSocketHint[],
): SocketDefinition[] {
  const spanX = Math.max(0, opaqueBounds.maxX - opaqueBounds.minX);
  const spanY = Math.max(0, opaqueBounds.maxY - opaqueBounds.minY);

  return hints.map((hint, idx) => {
    const nx = clamp(hint.normX, 0, 1, 0.5);
    const ny = clamp(hint.normY, 0, 1, 0.5);
    const x = Math.round(
      clamp(
        opaqueBounds.minX + nx * spanX,
        opaqueBounds.minX,
        opaqueBounds.maxX,
        opaqueBounds.minX,
      ),
    );
    const y = Math.round(
      clamp(
        opaqueBounds.minY + ny * spanY,
        opaqueBounds.minY,
        opaqueBounds.maxY,
        opaqueBounds.minY,
      ),
    );

    return SocketDefinitionSchema.parse({
      id: `sock_${sanitizeSnakeIdentifier(hint.name, `socket_${idx + 1}`, false)}`,
      name: sanitizeSnakeIdentifier(hint.name, `socket_${idx + 1}`, false),
      restPosPx: { x, y },
      baseAngleDeg: clamp(hint.baseAngleDeg, -360, 360, 0),
      colorHex: SOCKET_COLORS[idx % SOCKET_COLORS.length],
    });
  });
}
