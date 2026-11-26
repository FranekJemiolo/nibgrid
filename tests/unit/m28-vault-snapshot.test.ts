import 'fake-indexeddb/auto';
import { unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import type { EntityDefinition } from '../../src/domain/entitySchema';
import {
  createDefaultArtBible,
  createDefaultAudioPostProcessConfig,
  createDefaultShaderConfig,
  type AudioAsset,
  type SpriteNode,
} from '../../src/domain/schemas';
import { sha256Bytes } from '../../src/processing/hash';
import {
  exportProjectSnapshotFromDb,
  importProjectSnapshotToDb,
  parseAndVerifyProjectSnapshot,
} from '../../src/sync/projectSnapshot';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m28-test-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return { db, repo: new NibgridRepository(db) };
}

afterEach(async () => {
  while (databasesToCleanup.length > 0) {
    const database = databasesToCleanup.pop();
    if (database) {
      database.close();
      await database.delete();
    }
  }
});

describe('M28 Global Asset Vault & Portable .nibgrid.zip Snapshots', () => {
  it('round-trips project snapshot preserving ArtBible, SpriteNodes, AudioAssets, Entities, and exact blob bytes, and rejects 1-byte corruption before touching Dexie', async () => {
    const { db: srcDb, repo: srcRepo } = createTestDb();
    const { db: dstDb, repo: dstRepo } = createTestDb();

    const customBible = {
      ...createDefaultArtBible(),
      stylePrompt: 'Crisp 32px pixel art dark dungeon palette',
      palette: ['#1A1C2C', '#B13E53', '#FFCD75', '#FFFFFF'],
    };
    const project = await srcRepo.createProject('Snapshot Knight', customBible);

    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
    const wavBytes = new Uint8Array([82, 73, 70, 70, 36, 0, 0, 0, 87, 65, 86, 69]);
    const pngBlob = await srcRepo.storeBlobDeduplicated(pngBytes, 'image/png');
    const wavBlob = await srcRepo.storeBlobDeduplicated(wavBytes, 'audio/wav');

    const shaderCfg = createDefaultShaderConfig('hit_flash');
    const spriteNode: SpriteNode = {
      id: 'node-knight-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'character',
      imageBlobId: pngBlob.id,
      shaderConfig: shaderCfg,
      sketchSha256: await sha256Bytes(pngBytes),
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-v1',
        seed: 77,
        adherence: 'strict',
        promptDelta: 'red cat knight',
        compiledPrompt: 'red cat knight pixel art',
        createdAt: '2026-11-26T00:00:00.000Z',
      },
    };
    await srcRepo.saveSpriteNode(spriteNode);

    const audioAsset: AudioAsset = {
      id: 'audio-slash-1',
      projectId: project.id,
      name: 'sword_slash',
      presetId: 'sword_slash',
      route: 'local-synth',
      modelId: 'nibgrid-procedural-v1',
      wavBlobId: wavBlob.id,
      variationBlobIds: [],
      postProcess: createDefaultAudioPostProcessConfig(),
      lufs: -14,
      durationSec: 0.2,
      createdAt: '2026-11-26T00:00:01.000Z',
    };
    await srcRepo.saveAudioAsset(audioAsset);

    const entity: EntityDefinition = {
      id: 'ent-knight-1',
      projectId: project.id,
      slug: 'red_cat_knight',
      displayName: 'Red Cat Knight',
      bodyType: 'CharacterBody2D',
      resSubpath: 'assets/nibgrid',
      clips: [{ name: 'idle', spriteNodeId: spriteNode.id, fps: 8, loop: true }],
      primarySpriteNodeId: spriteNode.id,
      audioAssetIds: [audioAsset.id],
      includeNormalMap: false,
      shaderConfig: shaderCfg,
      updatedAt: 1732579200000,
    };
    await srcRepo.saveEntity(entity);

    const { filename, bytes: zipBytes } = await exportProjectSnapshotFromDb(srcDb, project.id);
    expect(filename).toBe('snapshot-knight.nibgrid.zip');

    // Clean import into fresh destination DB
    const imported = await importProjectSnapshotToDb(dstDb, zipBytes);
    expect(imported.project.name).toBe('Snapshot Knight');
    expect(imported.project.artBible.stylePrompt).toBe(customBible.stylePrompt);
    expect(imported.spriteCount).toBe(1);
    expect(imported.audioCount).toBe(1);
    expect(imported.entityCount).toBe(1);

    const dstNodes = await dstRepo.listSpriteNodes(imported.project.id);
    const dstAudio = await dstRepo.listAudioAssets(imported.project.id);
    const dstEntities = await dstRepo.listEntities(imported.project.id);
    expect(dstNodes).toHaveLength(1);
    expect(dstNodes[0]?.shaderConfig?.presetId).toBe('hit_flash');
    expect(dstAudio).toHaveLength(1);
    expect(dstEntities).toHaveLength(1);
    expect(dstEntities[0]?.slug).toBe('red_cat_knight');

    const restoredPng = await dstRepo.getBlob(dstNodes[0]!.imageBlobId);
    expect(restoredPng).toBeDefined();
    expect(new Uint8Array(await restoredPng!.bytes.arrayBuffer())).toEqual(pngBytes);

    // Corrupt 1 byte in a blob file inside ZIP -> verify SHA-256 rejection without touching DB
    const unpacked = unzipSync(zipBytes);
    const blobKey = Object.keys(unpacked).find((k) => k.startsWith('blobs/'))!;
    const mutated = new Uint8Array(unpacked[blobKey]!);
    mutated[0] = (mutated[0]! ^ 0xff) & 0xff;
    unpacked[blobKey] = mutated;
    const corruptedZip = zipSync(unpacked);

    await expect(parseAndVerifyProjectSnapshot(corruptedZip)).rejects.toThrow(/SHA-256/i);

    const { db: cleanGuardDb, repo: cleanGuardRepo } = createTestDb();
    await expect(importProjectSnapshotToDb(cleanGuardDb, corruptedZip)).rejects.toThrow(/SHA-256/i);
    expect(await cleanGuardRepo.listProjectsWithCounts()).toHaveLength(0);
    expect(await findOrphanBlobIds(cleanGuardDb)).toEqual([]);
  });

  it('preserves promoted Global Vault blobs across source project deletion and leaves zero orphans when Vault item is deleted', async () => {
    const { db, repo } = createTestDb();
    const projectA = await repo.createProject('Source Project A');
    const spriteBytes = new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6]);
    const spriteBlob = await repo.storeBlobDeduplicated(spriteBytes, 'image/png');

    // Verify deduplication reuses same blob ID on identical bytes
    const duplicateBlob = await repo.storeBlobDeduplicated(spriteBytes, 'image/png');
    expect(duplicateBlob.id).toBe(spriteBlob.id);

    const node: SpriteNode = {
      id: 'node-vault-src',
      projectId: projectA.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'prop',
      imageBlobId: spriteBlob.id,
      sketchSha256: spriteBlob.sha256,
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-v1',
        seed: 12,
        adherence: 'balanced',
        promptDelta: 'crystal potion',
        compiledPrompt: 'crystal potion sprite',
        createdAt: '2026-11-26T00:00:00.000Z',
      },
    };
    await repo.saveSpriteNode(node);

    const vaultItem = await repo.promoteSpriteNodeToVault(node, {
      name: 'Crystal Potion',
      tags: ['alchemy'],
      sourceProjectName: projectA.name,
    });

    // Delete source project -> Vault item & its blob must remain intact!
    await repo.deleteProjectCascade(projectA.id);
    expect(await repo.listProjectsWithCounts()).toHaveLength(0);
    const persistedVault = await repo.listVaultItems();
    expect(persistedVault).toHaveLength(1);
    expect(persistedVault[0]?.name).toBe('Crystal Potion');

    const retainedBlob = await repo.getBlob(persistedVault[0]!.blobIds[0]!);
    expect(retainedBlob).toBeDefined();
    expect(new Uint8Array(await retainedBlob!.bytes.arrayBuffer())).toEqual(spriteBytes);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    // Now delete the Vault item -> blob must be garbage-collected with 0 orphans
    await repo.deleteVaultItem(vaultItem.id);
    expect(await repo.listVaultItems()).toHaveLength(0);
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });
});
