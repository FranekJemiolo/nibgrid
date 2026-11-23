import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { encodeWav16, measureApproxLufs, decodeWav16 } from '../../src/audio/pcmPostProcess';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import {
  createDefaultArtBible,
  createDefaultAudioPostProcessConfig,
  createDefaultPostProcessConfig,
  type AudioAsset,
  type CollisionLayerShape,
  type SpriteNode,
} from '../../src/domain/schemas';
import {
  buildBatchDryRunSummary,
  cleanupSupersededBatchBlobs,
  executeBatchRecipePlan,
  rollbackBatchRun,
} from '../../src/processing/batchRunner';
import { encodeRgbaToPngBytes, decodePngBytesToRgba } from '../../src/processing/png';
import { auditSpriteAsset, computeArtBibleHash } from '../../src/processing/projectAudit';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m17b-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return { db, repo: new NibgridRepository(db) };
}

afterEach(async () => {
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

function makeOffPaletteSpritePng(width = 16, height = 16): Uint8Array {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 3; y < height - 3; y++) {
    for (let x = 3; x < width - 3; x++) {
      const idx = (y * width + x) * 4;
      // Deliberate off-palette neon magenta
      rgba[idx] = 250;
      rgba[idx + 1] = 20;
      rgba[idx + 2] = 210;
      rgba[idx + 3] = 255;
    }
  }
  return encodeRgbaToPngBytes(rgba, width, height);
}

function makeQuietWavBytes(): { wavBytes: Uint8Array; lufs: number } {
  const sampleRate = 22050;
  const frameCount = Math.round(0.4 * sampleRate);
  const samples = new Float32Array(frameCount);
  for (let i = 0; i < frameCount; i++) {
    samples[i] = 0.045 * Math.sin((2 * Math.PI * 330 * i) / sampleRate);
  }
  const pcm = { sampleRate, channels: 1 as const, samples };
  return { wavBytes: encodeWav16(pcm), lufs: measureApproxLufs(pcm) };
}

describe('M17B Deterministic Batch Recipe Runner, Cancellation & Rollback', () => {
  it('runs atomic batch sync across 4 sprites + 1 quiet audio clip, preserves manual hitbox, and leaves 0 orphan blobs', async () => {
    const { db, repo } = createTestRepo();
    const artBible = createDefaultArtBible();
    const project = await repo.createProject('M17B Batch Project', artBible);
    const currentHash = computeArtBibleHash(project.artBible);

    const pngBytes = makeOffPaletteSpritePng();
    const manualHitbox: CollisionLayerShape = {
      id: 'manual-hitbox-1',
      name: 'sword_slash',
      layer: 'hitbox',
      kind: 'aabb',
      isSensor: true,
      visible: true,
      vertices: [
        { x: 4, y: -12 },
        { x: 14, y: -12 },
        { x: 14, y: -2 },
        { x: 4, y: -2 },
      ],
    };

    const sprites: SpriteNode[] = [];
    for (let i = 0; i < 4; i++) {
      const rawRec = await repo.storeBlob(
        new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }),
        'image/png',
      );
      const procRec = await repo.storeBlob(
        new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }),
        'image/png',
      );
      const node: SpriteNode = {
        id: `sprite-${i}`,
        projectId: project.id,
        parentId: null,
        kind: 'generation',
        imageBlobId: rawRec.id,
        processedBlobId: procRec.id,
        postProcessConfig: createDefaultPostProcessConfig(16, 16),
        ...(i === 0 ? { collisionShapes: [manualHitbox] } : {}),
        recipeArtBibleHash: 'stale_hash_000',
        sketchSha256: 'b'.repeat(64),
        generationMeta: {
          providerId: 'mock',
          modelId: 'mock-v1',
          seed: 100 + i,
          adherence: 'strict',
          promptDelta: `sprite-${i}`,
          compiledPrompt: `sprite-${i}`,
          createdAt: new Date(Date.now() + i * 100).toISOString(),
        },
      };
      await repo.saveSpriteNode(node);
      sprites.push(node);
    }

    const { wavBytes, lufs } = makeQuietWavBytes();
    const wavRec = await repo.storeBlob(
      new Blob([new Uint8Array(wavBytes)], { type: 'audio/wav' }),
      'audio/wav',
    );
    const audioAsset: AudioAsset = {
      id: 'audio-0',
      projectId: project.id,
      name: 'Quiet Hit',
      presetId: 'sfx-sprite-impact',
      route: 'local-synth',
      modelId: 'local',
      wavBlobId: wavRec.id,
      variationBlobIds: [],
      postProcess: {
        ...createDefaultAudioPostProcessConfig(),
        targetLufs: -14,
        normalizeLufs: false,
      },
      lufs,
      durationSec: 0.4,
      createdAt: new Date().toISOString(),
    };
    await repo.saveAudioAsset(audioAsset);

    const plan = {
      assetIds: [...sprites.map((s) => s.id), audioAsset.id],
      mode: 'in-place' as const,
      operations: {
        syncArtBiblePalette: true,
        rerunPixelFoundry: false,
        autoTraceMissingColliders: true,
        rebakePaletteLuts: true,
        normalizeAudioLufs: true,
      },
    };

    const dryRun = buildBatchDryRunSummary(
      [
        ...sprites.map((s) => ({
          assetId: s.id,
          assetKind: 'sprite' as const,
          name: s.id,
          checks: [],
          worstSeverity: 'fail' as const,
          isStale: true,
        })),
        {
          assetId: audioAsset.id,
          assetKind: 'audio' as const,
          name: audioAsset.name,
          checks: [],
          worstSeverity: 'fail' as const,
          isStale: false,
        },
      ],
      plan,
    );
    expect(dryRun.spriteCount).toBe(4);
    expect(dryRun.audioCount).toBe(1);
    expect(dryRun.summaryText).toContain('$0.00 local compute');

    const result = await executeBatchRecipePlan(db, project.id, plan);
    expect(result.status).toBe('completed');
    expect(result.processedCount).toBe(5);
    expect(result.failedAssets).toEqual([]);

    // Verify all sprites updated + manual hitbox preserved alongside new collider
    for (let i = 0; i < 4; i++) {
      const updated = await db.spriteNodes.get(`sprite-${i}`);
      expect(updated?.recipeArtBibleHash).toBe(currentHash);
      expect(updated?.collisionShapes?.some((s) => s.layer === 'collider')).toBe(true);
      if (i === 0) {
        const preserved = updated?.collisionShapes?.find((s) => s.layer === 'hitbox');
        expect(preserved?.vertices).toEqual(manualHitbox.vertices);
      }

      const blob = await db.blobs.get(updated!.processedBlobId!);
      const decoded = await decodePngBytesToRgba(new Uint8Array(await blob!.bytes.arrayBuffer()));
      const reAudit = auditSpriteAsset({
        nodeId: updated!.id,
        name: updated!.id,
        processedBuffer: { width: decoded.width, height: decoded.height, data: decoded.rgba },
        artMode: 'pixel-art',
        artBiblePaletteHex: artBible.palette,
        currentArtBibleHash: currentHash,
        nodeArtBibleHash: updated!.recipeArtBibleHash,
        hasCollider: true,
      });
      expect(reAudit.checks.find((c) => c.checkId === 'palette')?.severity).toBe('pass');
      expect(reAudit.isStale).toBe(false);
    }

    // Verify audio clip normalized to -14 LUFS target
    const updatedAudio = await db.audioAssets.get(audioAsset.id);
    const updatedWavRec = await db.blobs.get(updatedAudio!.wavBlobId);
    const decodedWav = decodeWav16(new Uint8Array(await updatedWavRec!.bytes.arrayBuffer()));
    expect(Math.abs(measureApproxLufs(decodedWav) - -14)).toBeLessThanOrEqual(1.0);

    // Clear rollback retention and verify zero orphan blobs
    await cleanupSupersededBatchBlobs(db);
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });

  it('halts cleanly on AbortSignal after asset 2 of 6 and restores exact prior blobs on rollback', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('M17B Cancel & Rollback');
    const pngBytes = makeOffPaletteSpritePng();

    const originalProcIds: string[] = [];
    const nodeIds: string[] = [];
    for (let i = 0; i < 6; i++) {
      const rawRec = await repo.storeBlob(
        new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }),
        'image/png',
      );
      const procRec = await repo.storeBlob(
        new Blob([new Uint8Array(pngBytes)], { type: 'image/png' }),
        'image/png',
      );
      originalProcIds.push(procRec.id);
      const node: SpriteNode = {
        id: `cancel-node-${i}`,
        projectId: project.id,
        parentId: null,
        kind: 'generation',
        imageBlobId: rawRec.id,
        processedBlobId: procRec.id,
        recipeArtBibleHash: 'old_hash',
        sketchSha256: 'c'.repeat(64),
        generationMeta: {
          providerId: 'mock',
          modelId: 'mock-v1',
          seed: 200 + i,
          adherence: 'strict',
          promptDelta: `node-${i}`,
          compiledPrompt: `node-${i}`,
          createdAt: new Date(Date.now() + i * 100).toISOString(),
        },
      };
      await repo.saveSpriteNode(node);
      nodeIds.push(node.id);
    }

    const controller = new AbortController();
    const res = await executeBatchRecipePlan(
      db,
      project.id,
      {
        assetIds: nodeIds,
        mode: 'in-place',
        operations: {
          syncArtBiblePalette: true,
          rerunPixelFoundry: false,
          autoTraceMissingColliders: true,
          rebakePaletteLuts: false,
          normalizeAudioLufs: false,
        },
      },
      {
        onProgress: ({ current }) => {
          if (current === 2) controller.abort();
        },
      },
      controller.signal,
    );

    expect(res.status).toBe('cancelled');
    expect(res.processedCount).toBe(2);
    expect(res.rollbackManifest).toHaveLength(2);

    // Assets 2..5 were untouched
    for (let i = 2; i < 6; i++) {
      const untouched = await db.spriteNodes.get(nodeIds[i]!);
      expect(untouched?.processedBlobId).toBe(originalProcIds[i]);
      expect(untouched?.recipeArtBibleHash).toBe('old_hash');
    }

    // Rollback restores assets 0..1 cleanly with zero orphan blobs left behind
    await rollbackBatchRun(db, res.rollbackManifest);
    for (let i = 0; i < 6; i++) {
      const restored = await db.spriteNodes.get(nodeIds[i]!);
      expect(restored?.processedBlobId).toBe(originalProcIds[i]);
      expect(restored?.recipeArtBibleHash).toBe('old_hash');
      expect(restored?.collisionShapes).toBeUndefined();
    }
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });
});
