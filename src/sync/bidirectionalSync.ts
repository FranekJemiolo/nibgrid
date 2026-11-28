import { z } from 'zod';
import {
  EntityDefinitionSchema,
  sanitizeEntitySlug,
  type EntityDefinition,
} from '../domain/entitySchema';
import { applyPlaytestStatsToGdScript } from '../export/playtestStatSync';
import {
  StoredRoomRecordSchema,
  sanitizeRoomPlacements,
  sanitizeRoomSlug,
  type StoredRoomRecord,
} from '../processing/roomLayoutCore';

export const EntityStatOverrideSchema = z.object({
  slug: z.string().min(1),
  moveSpeedPx: z.number().min(10).max(2000).optional(),
  attackDamage: z.number().int().min(0).max(9999).optional(),
  maxHp: z.number().int().min(1).max(99999).optional(),
});

export const RoomSpawnOverrideSchema = z.object({
  roomSlug: z.string().min(1),
  playerSpawnX: z.number().int().min(0).max(63),
  playerSpawnY: z.number().int().min(0).max(31),
});

export const GodotBackSyncDeltaSchema = z.object({
  version: z.literal(1).default(1),
  updatedAt: z.number().int().nonnegative(),
  entityStatOverrides: z.array(EntityStatOverrideSchema).default([]),
  roomSpawnOverrides: z.array(RoomSpawnOverrideSchema).default([]),
});
export type GodotBackSyncDelta = z.infer<typeof GodotBackSyncDeltaSchema>;

/**
 * Parses and validates `.nibgrid_sync_delta.json` exported from the Godot EditorPlugin.
 */
export function parseGodotBackSyncDelta(rawJson: string): GodotBackSyncDelta {
  const parsed: unknown = JSON.parse(rawJson);
  return GodotBackSyncDeltaSchema.parse(parsed);
}

export interface ApplyBackSyncResult {
  readonly entities: readonly EntityDefinition[];
  readonly rooms: readonly StoredRoomRecord[];
  readonly updatedEntityCount: number;
  readonly updatedRoomCount: number;
}

/**
 * Deterministically merges in-editor Godot tweaks (`@export` speed/damage, room `PlayerSpawn`)
 * back into Nibgrid's `EntityDefinition` and `StoredRoomRecord` state without clobbering
 * unrelated entity logic or room tiles.
 */
export function applyGodotBackSyncDelta(params: {
  readonly entities: readonly EntityDefinition[];
  readonly rooms: readonly StoredRoomRecord[];
  readonly delta: GodotBackSyncDelta;
}): ApplyBackSyncResult {
  const entityOverrideBySlug = new Map(
    params.delta.entityStatOverrides.map((o) => [sanitizeEntitySlug(o.slug), o]),
  );
  const roomOverrideBySlug = new Map(
    params.delta.roomSpawnOverrides.map((o) => [sanitizeRoomSlug(o.roomSlug), o]),
  );

  let updatedEntityCount = 0;
  const nextEntities = params.entities.map((entity) => {
    const ov = entityOverrideBySlug.get(sanitizeEntitySlug(entity.slug));
    if (!ov) return entity;
    updatedEntityCount++;

    const nextPlaytest = {
      mode: entity.playtestConfig?.mode ?? 'side-platformer',
      moveSpeedPx: ov.moveSpeedPx ?? entity.playtestConfig?.moveSpeedPx ?? 140,
      jumpVelocityPx: entity.playtestConfig?.jumpVelocityPx ?? -310,
      gravityPx: entity.playtestConfig?.gravityPx ?? 980,
      hitstopMs: entity.playtestConfig?.hitstopMs ?? 45,
      screenShakePx: entity.playtestConfig?.screenShakePx ?? 4,
      knockbackPx: entity.playtestConfig?.knockbackPx ?? 18,
      flashDurationMs: entity.playtestConfig?.flashDurationMs ?? 120,
      attackDamage: ov.attackDamage ?? entity.playtestConfig?.attackDamage ?? 15,
    } as const;

    const nextScript = entity.scriptContent
      ? applyPlaytestStatsToGdScript(entity.scriptContent, {
          moveSpeedPx: nextPlaytest.moveSpeedPx,
          attackDamage: nextPlaytest.attackDamage,
        })
      : undefined;

    return EntityDefinitionSchema.parse({
      ...entity,
      playtestConfig: nextPlaytest,
      ...(nextScript ? { scriptContent: nextScript } : {}),
      updatedAt: Date.now(),
    });
  });

  let updatedRoomCount = 0;
  const nextRooms = params.rooms.map((room) => {
    const ov = roomOverrideBySlug.get(sanitizeRoomSlug(room.slug));
    if (!ov) return room;
    updatedRoomCount++;
    const nextBp = sanitizeRoomPlacements({
      ...room.blueprint,
      playerSpawn: {
        cellX: Math.max(1, Math.min(room.blueprint.cols - 2, ov.playerSpawnX)),
        cellY: Math.max(1, Math.min(room.blueprint.rows - 2, ov.playerSpawnY)),
      },
    });
    return StoredRoomRecordSchema.parse({
      ...room,
      blueprint: nextBp,
      updatedAt: Date.now(),
    });
  });

  return {
    entities: nextEntities,
    rooms: nextRooms,
    updatedEntityCount,
    updatedRoomCount,
  };
}
