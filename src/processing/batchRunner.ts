import {
  decodeWav16,
  encodeWav16,
  normalizeLufsPcm,
  trimSilencePcm,
} from '../audio/pcmPostProcess';
import { findOrphanBlobIds, type NibgridDatabase } from '../db/database';
import {
  AudioAssetSchema,
  BlobRecordSchema,
  SpriteNodeSchema,
  createDefaultPostProcessConfig,
  type AudioAsset,
  type CollisionLayerShape,
  type PostProcessConfig,
  type SpriteNode,
} from '../domain/schemas';
import { computePivotPx } from '../export/recipeBuilder';
import { runPostProcessInWorker } from '../workers/postprocessClient';
import { extractCollisionHull } from './collisionHull';
import { sha256Bytes } from './hash';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from './png';
import { computeArtBibleHash, type AssetAuditRow } from './projectAudit';

export interface BatchRecipeOperations {
  readonly syncArtBiblePalette: boolean;
  readonly rerunPixelFoundry: boolean;
  readonly autoTraceMissingColliders: boolean;
  readonly rebakePaletteLuts: boolean;
  readonly normalizeAudioLufs: boolean;
}

export interface BatchRecipePlan {
  readonly assetIds: readonly string[];
  readonly mode: 'in-place' | 'fork-children';
  readonly operations: BatchRecipeOperations;
  readonly overwriteExistingColliders?: boolean;
}

export interface BatchAssetSnapshot {
  readonly assetId: string;
  readonly assetKind: 'sprite' | 'audio';
  readonly forkedChildId?: string;
  readonly previousProcessedBlobId?: string;
  readonly previousRecipeHash?: string;
  readonly previousCollisionShapesJson?: string;
  readonly previousPostProcessConfigJson?: string;
  readonly previousAudioLufs?: number;
  readonly previousAudioDurationSec?: number;
  readonly previousAudioNormalizeLufs?: boolean;
  readonly previousAudioTrimSilence?: boolean;
}

export interface BatchDryRunSummary {
  readonly totalSelected: number;
  readonly spriteCount: number;
  readonly audioCount: number;
  readonly operationLabels: readonly string[];
  readonly summaryText: string;
}

export interface BatchProgressEvent {
  readonly current: number;
  readonly total: number;
  readonly assetId: string;
  readonly assetName: string;
  readonly assetKind: 'sprite' | 'audio';
}

export interface BatchProgressCallbacks {
  readonly onProgress?: (event: BatchProgressEvent) => void;
}

export interface BatchRunResult {
  readonly status: 'completed' | 'cancelled' | 'partial-error';
  readonly processedCount: number;
  readonly skippedCount: number;
  readonly failedAssets: readonly { readonly assetId: string; readonly reason: string }[];
  readonly rollbackManifest: readonly BatchAssetSnapshot[];
  readonly elapsedMs: number;
}

/**
 * Computes a dry-run preview manifest of how many sprites and audio clips will be processed
 * and which local $0.00 deterministic steps will run without mutating IndexedDB.
 */
export function buildBatchDryRunSummary(
  rows: readonly AssetAuditRow[],
  plan: BatchRecipePlan,
): BatchDryRunSummary {
  const selectedSet = new Set(plan.assetIds);
  let spriteCount = 0;
  let audioCount = 0;
  for (const row of rows) {
    if (!selectedSet.has(row.assetId)) continue;
    if (row.assetKind === 'sprite') spriteCount++;
    else audioCount++;
  }

  const operationLabels: string[] = [];
  if (plan.operations.syncArtBiblePalette) operationLabels.push('Sync Art Bible Palette');
  if (plan.operations.rerunPixelFoundry) operationLabels.push('Re-run Pixel Foundry');
  if (plan.operations.autoTraceMissingColliders)
    operationLabels.push('Auto-Trace Missing Colliders');
  if (plan.operations.rebakePaletteLuts) operationLabels.push('Re-bake Palette LUTs');
  if (plan.operations.normalizeAudioLufs) operationLabels.push('Normalize Audio LUFS');

  return {
    totalSelected: spriteCount + audioCount,
    spriteCount,
    audioCount,
    operationLabels,
    summaryText: `${spriteCount} sprite(s) + ${audioCount} audio clip(s) • $0.00 local compute`,
  };
}

async function decodeImageBlobToRgba(blob: Blob): Promise<{
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return await decodePngBytesToRgba(bytes);
  } catch (err) {
    if (typeof createImageBitmap === 'undefined' || typeof document === 'undefined') {
      throw err;
    }
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable for batch image decode.');
      ctx.drawImage(bitmap, 0, 0);
      const imgData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        rgba: new Uint8ClampedArray(imgData.data),
        width: bitmap.width,
        height: bitmap.height,
      };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

async function buildBlobRecord(bytes: Uint8Array, mimeType: string) {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const sha256 = await sha256Bytes(copy);
  return BlobRecordSchema.parse({
    id: globalThis.crypto.randomUUID(),
    mimeType,
    bytes: new Blob([copy.buffer], { type: mimeType }),
    sha256,
    createdAt: new Date().toISOString(),
  });
}

/**
 * Executes a deterministic batch recipe plan sequentially over selected project assets,
 * committing each asset in an atomic Dexie rw transaction with AbortSignal cancellation
 * and complete session rollback metadata.
 */
export async function executeBatchRecipePlan(
  database: NibgridDatabase,
  projectId: string,
  plan: BatchRecipePlan,
  callbacks?: BatchProgressCallbacks,
  signal?: AbortSignal,
): Promise<BatchRunResult> {
  const t0 = Date.now();
  const project = await database.projects.get(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const currentArtBibleHash = computeArtBibleHash(project.artBible);
  const rollbackManifest: BatchAssetSnapshot[] = [];
  const failedAssets: Array<{ readonly assetId: string; readonly reason: string }> = [];
  let processedCount = 0;
  let skippedCount = 0;
  const total = plan.assetIds.length;

  for (let idx = 0; idx < total; idx++) {
    if (signal?.aborted) {
      return {
        status: 'cancelled',
        processedCount,
        skippedCount: total - processedCount - failedAssets.length,
        failedAssets,
        rollbackManifest,
        elapsedMs: Date.now() - t0,
      };
    }

    const assetId = plan.assetIds[idx]!;
    const spriteNode = await database.spriteNodes.get(assetId);

    if (spriteNode && spriteNode.projectId === projectId) {
      try {
        const anySpriteOp =
          plan.operations.syncArtBiblePalette ||
          plan.operations.rerunPixelFoundry ||
          plan.operations.autoTraceMissingColliders ||
          plan.operations.rebakePaletteLuts;

        if (!anySpriteOp) {
          skippedCount++;
          callbacks?.onProgress?.({
            current: idx + 1,
            total,
            assetId,
            assetName: `${spriteNode.kind} #${spriteNode.generationMeta.seed}`,
            assetKind: 'sprite',
          });
          continue;
        }

        const sourceBlobId = spriteNode.imageBlobId;
        const sourceBlob =
          (await database.blobs.get(sourceBlobId)) ??
          (spriteNode.processedBlobId
            ? await database.blobs.get(spriteNode.processedBlobId)
            : undefined);
        if (!sourceBlob) {
          throw new Error(`Missing source blob for sprite node "${spriteNode.id}".`);
        }

        const decoded = await decodeImageBlobToRgba(sourceBlob.bytes);
        const prevConfig: PostProcessConfig =
          spriteNode.postProcessConfig ??
          createDefaultPostProcessConfig(
            project.artBible.targetWidth,
            project.artBible.targetHeight,
          );

        const nextConfig: PostProcessConfig = {
          ...prevConfig,
          ...(plan.operations.syncArtBiblePalette ? { paletteSnap: true } : {}),
          ...(plan.operations.rerunPixelFoundry
            ? {
                demixelEnabled: true,
                orphanCleanEnabled: true,
                paletteSnap: true,
                selOutMode: prevConfig.selOutMode === 'off' ? 'outer' : prevConfig.selOutMode,
              }
            : {}),
        };

        const workerInputConfig: PostProcessConfig =
          nextConfig.bgRemoval === 'ai-rembg' ? { ...nextConfig, bgRemoval: 'none' } : nextConfig;

        const ppRes = await runPostProcessInWorker({
          rgba: decoded.rgba,
          width: decoded.width,
          height: decoded.height,
          config: workerInputConfig,
          paletteHex: project.artBible.palette,
        });

        let nextCollisionShapes: CollisionLayerShape[] | undefined = spriteNode.collisionShapes
          ? [...spriteNode.collisionShapes]
          : undefined;

        if (plan.operations.autoTraceMissingColliders) {
          const existing = nextCollisionShapes ?? [];
          const hasColliderLayer = existing.some((s) => s.layer === 'collider');
          if (!hasColliderLayer || plan.overwriteExistingColliders) {
            const pivotPx = computePivotPx(nextConfig.pivotNorm, ppRes.width, ppRes.height);
            const extracted = extractCollisionHull(
              { width: ppRes.width, height: ppRes.height, data: ppRes.rgba },
              {
                kind: 'convex-hull',
                epsilonPx: 1.5,
                maxVertices: 8,
                pivotPx,
              },
            );
            const nonColliderLayers = plan.overwriteExistingColliders
              ? existing.filter((s) => s.layer !== 'collider')
              : existing;
            if (extracted.vertices.length >= 3) {
              const newCollider: CollisionLayerShape = {
                id: globalThis.crypto.randomUUID(),
                name: 'collider',
                layer: 'collider',
                kind: 'convex-hull',
                isSensor: false,
                visible: true,
                vertices: [...extracted.vertices],
                autoTraceMeta: { epsilonPx: 1.5, maxVertices: 8 },
              };
              nextCollisionShapes = [newCollider, ...nonColliderLayers];
            }
          }
        }

        const outPng = encodeRgbaToPngBytes(ppRes.rgba, ppRes.width, ppRes.height);
        const newBlobRec = await buildBlobRecord(outPng, 'image/png');

        if (signal?.aborted) {
          return {
            status: 'cancelled',
            processedCount,
            skippedCount: total - processedCount - failedAssets.length,
            failedAssets,
            rollbackManifest,
            elapsedMs: Date.now() - t0,
          };
        }

        const now = new Date().toISOString();
        const isFork = plan.mode === 'fork-children';
        const forkedChildId = isFork ? globalThis.crypto.randomUUID() : undefined;

        const snapshot: BatchAssetSnapshot = {
          assetId: spriteNode.id,
          assetKind: 'sprite',
          ...(forkedChildId ? { forkedChildId } : {}),
          ...(spriteNode.processedBlobId
            ? { previousProcessedBlobId: spriteNode.processedBlobId }
            : {}),
          ...(spriteNode.recipeArtBibleHash
            ? { previousRecipeHash: spriteNode.recipeArtBibleHash }
            : {}),
          ...(spriteNode.collisionShapes
            ? { previousCollisionShapesJson: JSON.stringify(spriteNode.collisionShapes) }
            : {}),
          ...(spriteNode.postProcessConfig
            ? { previousPostProcessConfigJson: JSON.stringify(spriteNode.postProcessConfig) }
            : {}),
        };

        const targetNode: SpriteNode = SpriteNodeSchema.parse(
          isFork && forkedChildId
            ? {
                ...spriteNode,
                id: forkedChildId,
                parentId: spriteNode.id,
                processedBlobId: newBlobRec.id,
                postProcessConfig: nextConfig,
                ...(nextCollisionShapes && nextCollisionShapes.length > 0
                  ? { collisionShapes: nextCollisionShapes }
                  : {}),
                recipeArtBibleHash: currentArtBibleHash,
                generationMeta: {
                  ...spriteNode.generationMeta,
                  promptDelta: `${spriteNode.generationMeta.promptDelta} [batch-sync]`,
                  createdAt: now,
                },
              }
            : {
                ...spriteNode,
                processedBlobId: newBlobRec.id,
                postProcessConfig: nextConfig,
                ...(nextCollisionShapes && nextCollisionShapes.length > 0
                  ? { collisionShapes: nextCollisionShapes }
                  : {}),
                recipeArtBibleHash: currentArtBibleHash,
              },
        );

        await database.transaction(
          'rw',
          [database.blobs, database.spriteNodes, database.projects],
          async () => {
            await database.blobs.put(newBlobRec);
            await database.spriteNodes.put(targetNode);
            await database.projects.where('id').equals(projectId).modify({ updatedAt: now });
          },
        );

        rollbackManifest.push(snapshot);
        processedCount++;
        callbacks?.onProgress?.({
          current: idx + 1,
          total,
          assetId,
          assetName: `${spriteNode.kind} #${spriteNode.generationMeta.seed}`,
          assetKind: 'sprite',
        });
      } catch (err) {
        failedAssets.push({
          assetId,
          reason: err instanceof Error ? err.message : 'Batch sprite processing failed.',
        });
      }
      continue;
    }

    const audioAsset = await database.audioAssets.get(assetId);
    if (audioAsset && audioAsset.projectId === projectId) {
      try {
        if (!plan.operations.normalizeAudioLufs) {
          skippedCount++;
          callbacks?.onProgress?.({
            current: idx + 1,
            total,
            assetId,
            assetName: audioAsset.name,
            assetKind: 'audio',
          });
          continue;
        }

        const wavRec = await database.blobs.get(audioAsset.wavBlobId);
        if (!wavRec) {
          throw new Error(`Missing WAV blob "${audioAsset.wavBlobId}" for audio asset.`);
        }

        const wavBytes = new Uint8Array(await wavRec.bytes.arrayBuffer());
        const rawPcm = decodeWav16(wavBytes);
        const trimmed = trimSilencePcm(rawPcm, audioAsset.postProcess.silenceThresholdDb ?? -48);
        const normRes = normalizeLufsPcm(
          trimmed,
          audioAsset.postProcess.targetLufs,
          audioAsset.postProcess.ceilingDb,
        );
        const nextWavBytes = encodeWav16(normRes.buffer);
        const newWavBlob = await buildBlobRecord(nextWavBytes, 'audio/wav');
        const nextFrames = Math.floor(normRes.buffer.samples.length / normRes.buffer.channels);
        const nextDurationSec = Number(
          (nextFrames / Math.max(1, normRes.buffer.sampleRate)).toFixed(4),
        );
        const nextLufs = Number.isFinite(normRes.outputLufs)
          ? Number(normRes.outputLufs.toFixed(2))
          : audioAsset.lufs;

        if (signal?.aborted) {
          return {
            status: 'cancelled',
            processedCount,
            skippedCount: total - processedCount - failedAssets.length,
            failedAssets,
            rollbackManifest,
            elapsedMs: Date.now() - t0,
          };
        }

        const snapshot: BatchAssetSnapshot = {
          assetId: audioAsset.id,
          assetKind: 'audio',
          previousProcessedBlobId: audioAsset.wavBlobId,
          previousAudioLufs: audioAsset.lufs,
          previousAudioDurationSec: audioAsset.durationSec,
          previousAudioNormalizeLufs: audioAsset.postProcess.normalizeLufs,
          previousAudioTrimSilence: audioAsset.postProcess.trimSilence,
        };

        const updatedAudio: AudioAsset = AudioAssetSchema.parse({
          ...audioAsset,
          wavBlobId: newWavBlob.id,
          lufs: nextLufs,
          durationSec: nextDurationSec,
          postProcess: {
            ...audioAsset.postProcess,
            trimSilence: true,
            normalizeLufs: true,
          },
        });

        const now = new Date().toISOString();
        await database.transaction(
          'rw',
          [database.blobs, database.audioAssets, database.projects],
          async () => {
            await database.blobs.put(newWavBlob);
            await database.audioAssets.put(updatedAudio);
            await database.projects.where('id').equals(projectId).modify({ updatedAt: now });
          },
        );

        rollbackManifest.push(snapshot);
        processedCount++;
        callbacks?.onProgress?.({
          current: idx + 1,
          total,
          assetId,
          assetName: audioAsset.name,
          assetKind: 'audio',
        });
      } catch (err) {
        failedAssets.push({
          assetId,
          reason: err instanceof Error ? err.message : 'Batch audio normalization failed.',
        });
      }
      continue;
    }

    skippedCount++;
  }

  return {
    status: failedAssets.length > 0 ? 'partial-error' : 'completed',
    processedCount,
    skippedCount,
    failedAssets,
    rollbackManifest,
    elapsedMs: Date.now() - t0,
  };
}

/**
 * Atomically reverts all sprites and audio assets modified by a batch run using its session
 * rollback manifest and removes any unreferenced batch blobs cleanly.
 */
export async function rollbackBatchRun(
  database: NibgridDatabase,
  rollbackManifest: readonly BatchAssetSnapshot[],
): Promise<number> {
  if (rollbackManifest.length === 0) return 0;

  return database.transaction(
    'rw',
    [database.spriteNodes, database.audioAssets, database.projects, database.blobs],
    async () => {
      for (let i = rollbackManifest.length - 1; i >= 0; i--) {
        const snap = rollbackManifest[i]!;
        if (snap.forkedChildId) {
          await database.spriteNodes.delete(snap.forkedChildId);
          continue;
        }

        if (snap.assetKind === 'sprite') {
          const cur = await database.spriteNodes.get(snap.assetId);
          if (!cur) continue;
          const reverted: SpriteNode = { ...cur };
          if (snap.previousProcessedBlobId) {
            reverted.processedBlobId = snap.previousProcessedBlobId;
          } else {
            delete reverted.processedBlobId;
          }
          if (snap.previousRecipeHash) {
            reverted.recipeArtBibleHash = snap.previousRecipeHash;
          } else {
            delete reverted.recipeArtBibleHash;
          }
          if (snap.previousCollisionShapesJson) {
            reverted.collisionShapes = JSON.parse(
              snap.previousCollisionShapesJson,
            ) as CollisionLayerShape[];
          } else {
            delete reverted.collisionShapes;
          }
          if (snap.previousPostProcessConfigJson) {
            reverted.postProcessConfig = JSON.parse(
              snap.previousPostProcessConfigJson,
            ) as PostProcessConfig;
          } else {
            delete reverted.postProcessConfig;
          }
          await database.spriteNodes.put(SpriteNodeSchema.parse(reverted));
        } else {
          const cur = await database.audioAssets.get(snap.assetId);
          if (!cur || !snap.previousProcessedBlobId) continue;
          const revertedAudio = AudioAssetSchema.parse({
            ...cur,
            wavBlobId: snap.previousProcessedBlobId,
            lufs: snap.previousAudioLufs ?? cur.lufs,
            durationSec: snap.previousAudioDurationSec ?? cur.durationSec,
            postProcess: {
              ...cur.postProcess,
              normalizeLufs: snap.previousAudioNormalizeLufs ?? cur.postProcess.normalizeLufs,
              trimSilence: snap.previousAudioTrimSilence ?? cur.postProcess.trimSilence,
            },
          });
          await database.audioAssets.put(revertedAudio);
        }
      }

      const orphans = await findOrphanBlobIds(database);
      if (orphans.length > 0) {
        await database.blobs.bulkDelete(orphans);
      }
      return orphans.length;
    },
  );
}

/**
 * Releases old superseded blobs retained for an active rollback session once discarded or superseded.
 */
export async function cleanupSupersededBatchBlobs(database: NibgridDatabase): Promise<number> {
  return database.transaction(
    'rw',
    [database.projects, database.spriteNodes, database.audioAssets, database.blobs],
    async () => {
      const orphans = await findOrphanBlobIds(database);
      if (orphans.length > 0) {
        await database.blobs.bulkDelete(orphans);
      }
      return orphans.length;
    },
  );
}
