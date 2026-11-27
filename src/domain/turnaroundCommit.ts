import { findOrphanBlobIds, type NibgridDatabase } from '../db/database';
import { encodeRgbaToPngBytes } from '../processing/png';
import { sha256Bytes } from '../processing/hash';
import type { TurnaroundSliceResult } from '../processing/turnaroundSlicer';
import {
  BlobRecordSchema,
  createDefaultPostProcessConfig,
  SpriteNodeSchema,
  type BlobRecord,
  type SpriteNode,
} from './schemas';

function newUuid(): string {
  return globalThis.crypto.randomUUID();
}

function makeBlobFromBytes(pngBytes: Uint8Array): Blob {
  const copy = new Uint8Array(pngBytes.byteLength);
  copy.set(pngBytes);
  return new Blob([copy.buffer], { type: 'image/png' });
}

export interface CommitTurnaroundResult {
  readonly directionGroupId: string;
  readonly nodes: readonly SpriteNode[];
}

/**
 * Atomically commits sliced directional views (up to 4 linked SpriteNodes sharing one
 * `directionGroupId` and identical `pivotPx`) inside a single Dexie `rw` transaction.
 * Heavy PNG encoding & SHA-256 digests are precomputed outside the transaction.
 */
export async function commitTurnaroundViews(
  database: NibgridDatabase,
  sheetNode: SpriteNode,
  sliceResult: TurnaroundSliceResult,
  baseSlug: string,
): Promise<CommitTurnaroundResult> {
  if (sliceResult.frames.length === 0) {
    throw new Error('Cannot commit turnaround views: no frames detected in slice result.');
  }
  if (sliceResult.frameWidth <= 0 || sliceResult.frameHeight <= 0) {
    throw new Error('Cannot commit turnaround views: sliced dimensions must be positive.');
  }

  const directionGroupId = newUuid();
  const baseMs = Date.now();
  const pivotNorm = {
    x: Number((sliceResult.sharedPivotPx.x / sliceResult.frameWidth).toFixed(4)),
    y: Number((sliceResult.sharedPivotPx.y / sliceResult.frameHeight).toFixed(4)),
  };

  const basePostProcess = createDefaultPostProcessConfig(
    sliceResult.frameWidth,
    sliceResult.frameHeight,
  );

  // Pre-encode PNGs and hashes strictly outside Dexie transaction
  const blobRecords: BlobRecord[] = [];
  const childNodes: SpriteNode[] = [];

  for (let i = 0; i < sliceResult.frames.length; i++) {
    const frame = sliceResult.frames[i]!;
    const pngBytes = encodeRgbaToPngBytes(
      frame.buffer.data,
      frame.buffer.width,
      frame.buffer.height,
    );
    const sha256 = await sha256Bytes(pngBytes);
    const blobId = newUuid();
    const createdAt = new Date(baseMs + i + 1).toISOString();

    blobRecords.push(
      BlobRecordSchema.parse({
        id: blobId,
        mimeType: 'image/png',
        bytes: makeBlobFromBytes(pngBytes),
        sha256,
        createdAt,
      }),
    );

    const slugLabel = `${baseSlug}_${frame.direction}`;
    childNodes.push(
      SpriteNodeSchema.parse({
        id: newUuid(),
        projectId: sheetNode.projectId,
        parentId: sheetNode.id,
        kind: 'generation',
        imageBlobId: blobId,
        processedBlobId: blobId,
        sketchSha256: sheetNode.sketchSha256,
        recipeArtBibleHash: sheetNode.recipeArtBibleHash,
        postProcessConfig: {
          ...basePostProcess,
          bgRemoval: 'none',
          resampleEnabled: false,
          targetWidth: sliceResult.frameWidth,
          targetHeight: sliceResult.frameHeight,
          pivotNorm,
        },
        turnaroundMeta: {
          isTurnaroundSheet: false,
          turnaroundLayout: sheetNode.turnaroundMeta?.turnaroundLayout,
          directionGroupId,
          cardinalDirection: frame.direction,
          scaleApplied: frame.scaleApplied,
          sharedPivotPx: {
            x: sliceResult.sharedPivotPx.x,
            y: sliceResult.sharedPivotPx.y,
          },
        },
        generationMeta: {
          providerId: sheetNode.generationMeta.providerId,
          modelId: sheetNode.generationMeta.modelId,
          seed: sheetNode.generationMeta.seed + i + 1,
          adherence: sheetNode.generationMeta.adherence,
          promptDelta: slugLabel,
          compiledPrompt: sheetNode.generationMeta.compiledPrompt,
          createdAt,
        },
      }),
    );
  }

  await database.transaction(
    'rw',
    [database.blobs, database.spriteNodes, database.projects],
    async () => {
      await database.blobs.bulkPut(blobRecords);
      await database.spriteNodes.bulkPut(childNodes);
      await database.projects
        .where('id')
        .equals(sheetNode.projectId)
        .modify({ updatedAt: new Date(baseMs + sliceResult.frames.length + 2).toISOString() });
    },
  );

  return {
    directionGroupId,
    nodes: childNodes,
  };
}

/**
 * Deletes every SpriteNode belonging to a `directionGroupId` inside one atomic transaction
 * and purges any unreferenced blobs so zero orphans remain in IndexedDB.
 */
export async function deleteTurnaroundDirectionGroup(
  database: NibgridDatabase,
  directionGroupId: string,
): Promise<number> {
  return database.transaction(
    'rw',
    [
      database.projects,
      database.spriteNodes,
      database.audioAssets,
      database.blobs,
      database.vaultItems,
      database.agentCheckpoints,
      database.worldGraphs,
    ],
    async () => {
      const allNodes = await database.spriteNodes.toArray();
      const victimIds = allNodes
        .filter((n) => n.turnaroundMeta?.directionGroupId === directionGroupId)
        .map((n) => n.id);
      if (victimIds.length === 0) return 0;

      await database.spriteNodes.bulkDelete(victimIds);
      const orphanIds = await findOrphanBlobIds(database);
      if (orphanIds.length > 0) {
        await database.blobs.bulkDelete(orphanIds);
      }
      return victimIds.length;
    },
  );
}
