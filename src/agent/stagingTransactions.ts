import { z } from 'zod';
import { GameDataRegistrySchema, type GameDataRegistry } from '../data/gameDataSchemas';
import { db, findOrphanBlobIds, type NibgridDatabase } from '../db/database';
import { EntityDefinitionSchema, type EntityDefinition } from '../domain/entitySchema';
import {
  AudioAssetSchema,
  SpriteNodeSchema,
  type AudioAsset,
  type SpriteNode,
} from '../domain/schemas';
import {
  ProjectNarrativeBundleSchema,
  type ProjectNarrativeBundle,
} from '../narrative/dialogueSchemas';
import { StoredRoomRecordSchema, type StoredRoomRecord } from '../processing/roomLayoutCore';
import { WorldGraphSchema, type WorldGraph } from '../world/worldGraphCore';
import type { StagedAssetChange } from './studioToolRegistry';

export const AgentCheckpointSnapshotsSchema = z.object({
  spriteNodes: z.array(SpriteNodeSchema),
  entities: z.array(EntityDefinitionSchema),
  audioAssets: z.array(AudioAssetSchema),
  rooms: z.array(StoredRoomRecordSchema),
  worldGraphs: z.array(WorldGraphSchema).optional(),
  gameDataRegistries: z.array(GameDataRegistrySchema).optional(),
  narrativeBundles: z.array(ProjectNarrativeBundleSchema).optional(),
});

export const AgentCheckpointSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  turnSummary: z.string().min(1).max(240),
  createdAt: z.number().int().nonnegative(),
  snapshots: AgentCheckpointSnapshotsSchema,
  createdIds: z.object({
    audioAssetIds: z.array(z.string()),
    spriteNodeIds: z.array(z.string()).optional(),
    entityIds: z.array(z.string()).optional(),
    roomIds: z.array(z.string()).optional(),
    worldGraphIds: z.array(z.string()).optional(),
    gameDataProjectIds: z.array(z.string()).optional(),
    narrativeProjectIds: z.array(z.string()).optional(),
  }),
  referencedBlobIds: z.array(z.string()),
});
export type AgentCheckpoint = z.infer<typeof AgentCheckpointSchema>;

function collectBlobsFromSpriteNode(node: SpriteNode, into: Set<string>): void {
  into.add(node.imageBlobId);
  if (node.maskBlobId) into.add(node.maskBlobId);
  if (node.processedBlobId) into.add(node.processedBlobId);
  if (node.lightingBake?.normalBlobId) into.add(node.lightingBake.normalBlobId);
  if (node.lightingBake?.emissionBlobId) into.add(node.lightingBake.emissionBlobId);
  if (node.parallaxScene?.masterKeyframeBlobId) {
    into.add(node.parallaxScene.masterKeyframeBlobId);
  }
  for (const layer of node.parallaxScene?.layers ?? []) {
    if (layer.blobId) into.add(layer.blobId);
  }
  if (node.poseClip?.generatedStripBlobId) {
    into.add(node.poseClip.generatedStripBlobId);
  }
  for (const frameBlobId of node.poseClip?.generatedFrameBlobIds ?? []) {
    into.add(frameBlobId);
  }
}

function collectBlobsFromAudioAsset(asset: AudioAsset, into: Set<string>): void {
  into.add(asset.wavBlobId);
  for (const vid of asset.variationBlobIds) {
    into.add(vid);
  }
}

export interface CommitStagedTurnResult {
  readonly checkpoint: AgentCheckpoint | null;
  readonly acceptedCount: number;
  readonly rejectedCount: number;
  readonly purgedBlobCount: number;
}

/**
 * Atomically commits strictly `status === 'accepted'` changes in one Dexie `'rw'` transaction,
 * snapshots pre-turn records into `agentCheckpoints`, and purges all rejected/unreferenced blobs.
 */
export async function commitStagedTurn(
  database: NibgridDatabase = db,
  projectId: string,
  turnSummary: string,
  changes: readonly StagedAssetChange[],
): Promise<CommitStagedTurnResult> {
  const accepted = changes.filter((c) => c.status === 'accepted');
  const rejectedCount = changes.length - accepted.length;

  let savedCheckpoint: AgentCheckpoint | null = null;
  let purgedBlobCount = 0;

  await database.transaction(
    'rw',
    [
      database.projects,
      database.spriteNodes,
      database.entities,
      database.audioAssets,
      database.rooms,
      database.agentCheckpoints,
      database.vaultItems,
      database.blobs,
      database.worldGraphs,
      database.gameDataRegistries,
      database.narrativeBundles,
    ],
    async () => {
      const spriteSnaps = new Map<string, SpriteNode>();
      const entitySnaps = new Map<string, EntityDefinition>();
      const audioSnaps = new Map<string, AudioAsset>();
      const roomSnaps = new Map<string, StoredRoomRecord>();
      const worldSnaps = new Map<string, WorldGraph>();
      const gameDataSnaps = new Map<string, GameDataRegistry>();
      const narrativeSnaps = new Map<string, ProjectNarrativeBundle>();

      const createdAudioIds = new Set<string>();
      const createdSpriteIds = new Set<string>();
      const createdEntityIds = new Set<string>();
      const createdRoomIds = new Set<string>();
      const createdWorldIds = new Set<string>();
      const createdGameDataProjectIds = new Set<string>();
      const createdNarrativeProjectIds = new Set<string>();
      const referencedBlobIds = new Set<string>();

      const snapshotAndPutSprite = async (sp: SpriteNode) => {
        const prev = await database.spriteNodes.get(sp.id);
        if (prev && !spriteSnaps.has(prev.id)) {
          const parsedPrev = SpriteNodeSchema.parse(prev);
          spriteSnaps.set(prev.id, parsedPrev);
          collectBlobsFromSpriteNode(parsedPrev, referencedBlobIds);
        } else if (!prev) {
          createdSpriteIds.add(sp.id);
        }
        await database.spriteNodes.put(SpriteNodeSchema.parse(sp));
      };

      const snapshotAndPutEntity = async (ent: EntityDefinition) => {
        const prev = await database.entities.get(ent.id);
        if (prev && !entitySnaps.has(prev.id)) {
          entitySnaps.set(prev.id, EntityDefinitionSchema.parse(prev));
        } else if (!prev) {
          createdEntityIds.add(ent.id);
        }
        await database.entities.put(EntityDefinitionSchema.parse(ent));
      };

      const snapshotAndPutAudio = async (aud: AudioAsset) => {
        const prev = await database.audioAssets.get(aud.id);
        if (prev && !audioSnaps.has(prev.id)) {
          const parsedPrev = AudioAssetSchema.parse(prev);
          audioSnaps.set(prev.id, parsedPrev);
          collectBlobsFromAudioAsset(parsedPrev, referencedBlobIds);
        } else if (!prev) {
          createdAudioIds.add(aud.id);
        }
        await database.audioAssets.put(AudioAssetSchema.parse(aud));
      };

      const snapshotAndPutRoom = async (rm: StoredRoomRecord) => {
        const prev = await database.rooms.get(rm.id);
        if (prev && !roomSnaps.has(prev.id)) {
          roomSnaps.set(prev.id, StoredRoomRecordSchema.parse(prev));
        } else if (!prev) {
          createdRoomIds.add(rm.id);
        }
        await database.rooms.put(StoredRoomRecordSchema.parse(rm));
      };

      const snapshotAndPutWorld = async (wg: WorldGraph) => {
        const prev = await database.worldGraphs.get(wg.id);
        if (prev && !worldSnaps.has(prev.id)) {
          const parsed = WorldGraphSchema.parse(prev);
          worldSnaps.set(prev.id, parsed);
          if (parsed.minimapBlobId) referencedBlobIds.add(parsed.minimapBlobId);
        } else if (!prev) {
          createdWorldIds.add(wg.id);
        }
        await database.worldGraphs.put(WorldGraphSchema.parse(wg));
      };

      const snapshotAndPutGameData = async (reg: GameDataRegistry) => {
        const prev = await database.gameDataRegistries.get(reg.projectId);
        if (prev && !gameDataSnaps.has(prev.projectId)) {
          gameDataSnaps.set(prev.projectId, GameDataRegistrySchema.parse(prev));
        } else if (!prev) {
          createdGameDataProjectIds.add(reg.projectId);
        }
        await database.gameDataRegistries.put(GameDataRegistrySchema.parse(reg));
      };

      const snapshotAndPutNarrative = async (bun: ProjectNarrativeBundle) => {
        const prev = await database.narrativeBundles.get(bun.projectId);
        if (prev && !narrativeSnaps.has(prev.projectId)) {
          narrativeSnaps.set(prev.projectId, ProjectNarrativeBundleSchema.parse(prev));
        } else if (!prev) {
          createdNarrativeProjectIds.add(bun.projectId);
        }
        await database.narrativeBundles.put(ProjectNarrativeBundleSchema.parse(bun));
      };

      for (const ch of accepted) {
        if (ch.patch.patchKind === 'sprite-node') {
          await snapshotAndPutSprite(ch.patch.spriteNode);
        } else if (ch.patch.patchKind === 'entity-def') {
          await snapshotAndPutEntity(ch.patch.entity);
        } else if (ch.patch.patchKind === 'audio-asset') {
          await snapshotAndPutAudio(ch.patch.audioAsset);
          if (ch.patch.updatedEntity) {
            await snapshotAndPutEntity(ch.patch.updatedEntity);
          }
        } else if (ch.patch.patchKind === 'room-record') {
          await snapshotAndPutRoom(ch.patch.room);
        } else if (ch.patch.patchKind === 'entity-bundle') {
          await snapshotAndPutSprite(ch.patch.spriteNode);
          await snapshotAndPutEntity(ch.patch.entity);
          if (ch.patch.audioAsset) {
            await snapshotAndPutAudio(ch.patch.audioAsset);
          }
        } else if (ch.patch.patchKind === 'world-graph') {
          if (ch.patch.room) {
            await snapshotAndPutRoom(ch.patch.room);
          }
          await snapshotAndPutWorld(ch.patch.worldGraph);
        } else if (ch.patch.patchKind === 'game-data') {
          await snapshotAndPutGameData(ch.patch.registry);
        } else if (ch.patch.patchKind === 'narrative-bundle') {
          await snapshotAndPutNarrative(ch.patch.bundle);
        } else if (ch.patch.patchKind === 'self-heal-batch') {
          for (const sp of ch.patch.spriteNodes) {
            await snapshotAndPutSprite(sp);
          }
          if (ch.patch.worldGraph) {
            await snapshotAndPutWorld(ch.patch.worldGraph);
          }
          if (ch.patch.gameData) {
            await snapshotAndPutGameData(ch.patch.gameData);
          }
          if (ch.patch.narrativeBundle) {
            await snapshotAndPutNarrative(ch.patch.narrativeBundle);
          }
        }
      }

      const mutatesState =
        spriteSnaps.size > 0 ||
        entitySnaps.size > 0 ||
        audioSnaps.size > 0 ||
        roomSnaps.size > 0 ||
        worldSnaps.size > 0 ||
        gameDataSnaps.size > 0 ||
        narrativeSnaps.size > 0 ||
        createdAudioIds.size > 0 ||
        createdSpriteIds.size > 0 ||
        createdEntityIds.size > 0 ||
        createdRoomIds.size > 0 ||
        createdWorldIds.size > 0 ||
        createdGameDataProjectIds.size > 0 ||
        createdNarrativeProjectIds.size > 0;

      if (mutatesState) {
        savedCheckpoint = AgentCheckpointSchema.parse({
          id: globalThis.crypto.randomUUID(),
          projectId,
          turnSummary: turnSummary.trim().slice(0, 240) || 'Agent staged edit',
          createdAt: Date.now(),
          snapshots: {
            spriteNodes: Array.from(spriteSnaps.values()),
            entities: Array.from(entitySnaps.values()),
            audioAssets: Array.from(audioSnaps.values()),
            rooms: Array.from(roomSnaps.values()),
            worldGraphs: Array.from(worldSnaps.values()),
            gameDataRegistries: Array.from(gameDataSnaps.values()),
            narrativeBundles: Array.from(narrativeSnaps.values()),
          },
          createdIds: {
            audioAssetIds: Array.from(createdAudioIds),
            spriteNodeIds: Array.from(createdSpriteIds),
            entityIds: Array.from(createdEntityIds),
            roomIds: Array.from(createdRoomIds),
            worldGraphIds: Array.from(createdWorldIds),
            gameDataProjectIds: Array.from(createdGameDataProjectIds),
            narrativeProjectIds: Array.from(createdNarrativeProjectIds),
          },
          referencedBlobIds: Array.from(referencedBlobIds),
        });
        await database.agentCheckpoints.put(savedCheckpoint);
      }

      const orphans = await findOrphanBlobIds(database);
      if (orphans.length > 0) {
        await database.blobs.bulkDelete(orphans);
      }
      purgedBlobCount = orphans.length;
    },
  );

  return {
    checkpoint: savedCheckpoint,
    acceptedCount: accepted.length,
    rejectedCount,
    purgedBlobCount,
  };
}

/**
 * Purges all unreferenced temporary staging blobs created during a rejected agent turn.
 */
export async function rejectStagedTurn(
  database: NibgridDatabase = db,
  _changes: readonly StagedAssetChange[] = [],
): Promise<number> {
  let purged = 0;
  await database.transaction(
    'rw',
    [
      database.projects,
      database.spriteNodes,
      database.audioAssets,
      database.agentCheckpoints,
      database.vaultItems,
      database.blobs,
      database.worldGraphs,
    ],
    async () => {
      const orphans = await findOrphanBlobIds(database);
      if (orphans.length > 0) {
        await database.blobs.bulkDelete(orphans);
      }
      purged = orphans.length;
    },
  );
  return purged;
}

export interface RestoreCheckpointResult {
  readonly restoredRecordCount: number;
  readonly purgedBlobCount: number;
}

/**
 * Atomically restores all snapshotted pre-turn asset records from `checkpointId`, deletes
 * any audio assets created by that turn, and purges newly unreferenced superseded blobs.
 */
export async function restoreCheckpoint(
  database: NibgridDatabase = db,
  checkpointId: string,
): Promise<RestoreCheckpointResult> {
  let restoredRecordCount = 0;
  let purgedBlobCount = 0;

  await database.transaction(
    'rw',
    [
      database.projects,
      database.spriteNodes,
      database.entities,
      database.audioAssets,
      database.rooms,
      database.agentCheckpoints,
      database.vaultItems,
      database.blobs,
      database.worldGraphs,
      database.gameDataRegistries,
      database.narrativeBundles,
    ],
    async () => {
      const raw = await database.agentCheckpoints.get(checkpointId);
      if (!raw) {
        throw new Error(`Checkpoint "${checkpointId}" not found.`);
      }
      const checkpoint = AgentCheckpointSchema.parse(raw);

      for (const sp of checkpoint.snapshots.spriteNodes) {
        await database.spriteNodes.put(sp);
        restoredRecordCount++;
      }
      for (const ent of checkpoint.snapshots.entities) {
        await database.entities.put(ent);
        restoredRecordCount++;
      }
      for (const aud of checkpoint.snapshots.audioAssets) {
        await database.audioAssets.put(aud);
        restoredRecordCount++;
      }
      for (const rm of checkpoint.snapshots.rooms) {
        await database.rooms.put(rm);
        restoredRecordCount++;
      }
      for (const wg of checkpoint.snapshots.worldGraphs ?? []) {
        await database.worldGraphs.put(wg);
        restoredRecordCount++;
      }
      for (const gd of checkpoint.snapshots.gameDataRegistries ?? []) {
        await database.gameDataRegistries.put(gd);
        restoredRecordCount++;
      }
      for (const nb of checkpoint.snapshots.narrativeBundles ?? []) {
        await database.narrativeBundles.put(nb);
        restoredRecordCount++;
      }

      if (checkpoint.createdIds.audioAssetIds.length > 0) {
        await database.audioAssets.bulkDelete(checkpoint.createdIds.audioAssetIds);
        restoredRecordCount += checkpoint.createdIds.audioAssetIds.length;
      }
      if (checkpoint.createdIds.spriteNodeIds && checkpoint.createdIds.spriteNodeIds.length > 0) {
        await database.spriteNodes.bulkDelete(checkpoint.createdIds.spriteNodeIds);
        restoredRecordCount += checkpoint.createdIds.spriteNodeIds.length;
      }
      if (checkpoint.createdIds.entityIds && checkpoint.createdIds.entityIds.length > 0) {
        await database.entities.bulkDelete(checkpoint.createdIds.entityIds);
        restoredRecordCount += checkpoint.createdIds.entityIds.length;
      }
      if (checkpoint.createdIds.roomIds && checkpoint.createdIds.roomIds.length > 0) {
        await database.rooms.bulkDelete(checkpoint.createdIds.roomIds);
        restoredRecordCount += checkpoint.createdIds.roomIds.length;
      }
      if (checkpoint.createdIds.worldGraphIds && checkpoint.createdIds.worldGraphIds.length > 0) {
        await database.worldGraphs.bulkDelete(checkpoint.createdIds.worldGraphIds);
        restoredRecordCount += checkpoint.createdIds.worldGraphIds.length;
      }
      if (
        checkpoint.createdIds.gameDataProjectIds &&
        checkpoint.createdIds.gameDataProjectIds.length > 0
      ) {
        await database.gameDataRegistries.bulkDelete(checkpoint.createdIds.gameDataProjectIds);
        restoredRecordCount += checkpoint.createdIds.gameDataProjectIds.length;
      }
      if (
        checkpoint.createdIds.narrativeProjectIds &&
        checkpoint.createdIds.narrativeProjectIds.length > 0
      ) {
        await database.narrativeBundles.bulkDelete(checkpoint.createdIds.narrativeProjectIds);
        restoredRecordCount += checkpoint.createdIds.narrativeProjectIds.length;
      }

      await database.agentCheckpoints.delete(checkpointId);

      const orphans = await findOrphanBlobIds(database);
      if (orphans.length > 0) {
        await database.blobs.bulkDelete(orphans);
      }
      purgedBlobCount = orphans.length;
    },
  );

  return { restoredRecordCount, purgedBlobCount };
}
