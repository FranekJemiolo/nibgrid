import { z } from 'zod';
import { db, findOrphanBlobIds, type NibgridDatabase } from '../db/database';
import { EntityDefinitionSchema, type EntityDefinition } from '../domain/entitySchema';
import {
  AudioAssetSchema,
  SpriteNodeSchema,
  type AudioAsset,
  type SpriteNode,
} from '../domain/schemas';
import { StoredRoomRecordSchema, type StoredRoomRecord } from '../processing/roomLayoutCore';
import type { StagedAssetChange } from './studioToolRegistry';

export const AgentCheckpointSnapshotsSchema = z.object({
  spriteNodes: z.array(SpriteNodeSchema),
  entities: z.array(EntityDefinitionSchema),
  audioAssets: z.array(AudioAssetSchema),
  rooms: z.array(StoredRoomRecordSchema),
});

export const AgentCheckpointSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  turnSummary: z.string().min(1).max(240),
  createdAt: z.number().int().nonnegative(),
  snapshots: AgentCheckpointSnapshotsSchema,
  createdIds: z.object({
    audioAssetIds: z.array(z.string()),
  }),
  referencedBlobIds: z.array(z.string()),
});
export type AgentCheckpoint = z.infer<typeof AgentCheckpointSchema>;

function collectBlobsFromSpriteNode(node: SpriteNode, into: Set<string>): void {
  into.add(node.imageBlobId);
  if (node.maskBlobId) into.add(node.maskBlobId);
  if (node.processedBlobId) into.add(node.processedBlobId);
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
    ],
    async () => {
      const spriteSnaps = new Map<string, SpriteNode>();
      const entitySnaps = new Map<string, EntityDefinition>();
      const audioSnaps = new Map<string, AudioAsset>();
      const roomSnaps = new Map<string, StoredRoomRecord>();
      const createdAudioIds = new Set<string>();
      const referencedBlobIds = new Set<string>();

      for (const ch of accepted) {
        if (ch.patch.patchKind === 'sprite-node') {
          const prev = await database.spriteNodes.get(ch.patch.spriteNode.id);
          if (prev && !spriteSnaps.has(prev.id)) {
            const parsedPrev = SpriteNodeSchema.parse(prev);
            spriteSnaps.set(prev.id, parsedPrev);
            collectBlobsFromSpriteNode(parsedPrev, referencedBlobIds);
          }
          await database.spriteNodes.put(SpriteNodeSchema.parse(ch.patch.spriteNode));
        } else if (ch.patch.patchKind === 'entity-def') {
          const prev = await database.entities.get(ch.patch.entity.id);
          if (prev && !entitySnaps.has(prev.id)) {
            entitySnaps.set(prev.id, EntityDefinitionSchema.parse(prev));
          }
          await database.entities.put(EntityDefinitionSchema.parse(ch.patch.entity));
        } else if (ch.patch.patchKind === 'audio-asset') {
          const prevAudio = await database.audioAssets.get(ch.patch.audioAsset.id);
          if (prevAudio && !audioSnaps.has(prevAudio.id)) {
            const parsedPrev = AudioAssetSchema.parse(prevAudio);
            audioSnaps.set(prevAudio.id, parsedPrev);
            collectBlobsFromAudioAsset(parsedPrev, referencedBlobIds);
          } else if (!prevAudio) {
            createdAudioIds.add(ch.patch.audioAsset.id);
          }
          await database.audioAssets.put(AudioAssetSchema.parse(ch.patch.audioAsset));

          if (ch.patch.updatedEntity) {
            const prevEnt = await database.entities.get(ch.patch.updatedEntity.id);
            if (prevEnt && !entitySnaps.has(prevEnt.id)) {
              entitySnaps.set(prevEnt.id, EntityDefinitionSchema.parse(prevEnt));
            }
            await database.entities.put(EntityDefinitionSchema.parse(ch.patch.updatedEntity));
          }
        } else if (ch.patch.patchKind === 'room-record') {
          const prevRoom = await database.rooms.get(ch.patch.room.id);
          if (prevRoom && !roomSnaps.has(prevRoom.id)) {
            roomSnaps.set(prevRoom.id, StoredRoomRecordSchema.parse(prevRoom));
          }
          await database.rooms.put(StoredRoomRecordSchema.parse(ch.patch.room));
        }
      }

      const mutatesState =
        spriteSnaps.size > 0 ||
        entitySnaps.size > 0 ||
        audioSnaps.size > 0 ||
        roomSnaps.size > 0 ||
        createdAudioIds.size > 0;

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
          },
          createdIds: {
            audioAssetIds: Array.from(createdAudioIds),
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

      if (checkpoint.createdIds.audioAssetIds.length > 0) {
        await database.audioAssets.bulkDelete(checkpoint.createdIds.audioAssetIds);
        restoredRecordCount += checkpoint.createdIds.audioAssetIds.length;
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
