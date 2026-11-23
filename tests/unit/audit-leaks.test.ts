import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  OFFLINE_MOCK_PROVIDER_ID,
  findOrphanBlobIds,
} from '../../src/db/database';
import type { SpriteNode } from '../../src/domain/schemas';
import {
  acquireBlobUrl,
  clearBlobUrlCacheForTests,
  getActiveBlobUrlCount,
  releaseBlobUrl,
} from '../../src/ui/components/blobUrlCache';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-leak-test-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return { db, repo: new NibgridRepository(db) };
}

afterEach(async () => {
  clearBlobUrlCacheForTests();
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

describe('Phase 1 Audit: IndexedDB Orphan Blob Sweep & URL Ref-Counting', () => {
  it('leaves zero orphan blobs after deleting leaves, Golden Refs, replacing nodes, and cascade-deleting project', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('Leak Audit Knight');

    // Attach 3 Golden References
    for (let i = 0; i < 3; i++) {
      await repo.addGoldenReference(
        project.id,
        new Blob([new Uint8Array([1, 2, 3, i])], { type: 'image/png' }),
      );
    }

    // Store blobs for 5 DAG nodes (1 sketch, 2 generation, 2 inpaint with 2 mask blobs)
    const makePngBlob = (tag: number) =>
      new Blob([new Uint8Array([137, 80, 78, 71, tag])], { type: 'image/png' });

    const sketchBlob = await repo.storeBlob(makePngBlob(10));
    const gen1Blob = await repo.storeBlob(makePngBlob(20));
    const gen2Blob = await repo.storeBlob(makePngBlob(30));
    const inpaint1Blob = await repo.storeBlob(makePngBlob(40));
    const mask1Blob = await repo.storeBlob(makePngBlob(41));
    const inpaint2Blob = await repo.storeBlob(makePngBlob(50));
    const mask2Blob = await repo.storeBlob(makePngBlob(51));

    const makeMeta = (seed: number): SpriteNode['generationMeta'] => ({
      providerId: OFFLINE_MOCK_PROVIDER_ID,
      modelId: 'nibgrid-procedural-v1',
      seed,
      adherence: 'balanced',
      promptDelta: 'audit',
      compiledPrompt: 'audit prompt',
      createdAt: new Date(1700000000000 + seed).toISOString(),
    });

    await repo.saveSpriteNode({
      id: 'n-sketch',
      projectId: project.id,
      parentId: null,
      kind: 'sketch',
      imageBlobId: sketchBlob.id,
      sketchSha256: sketchBlob.sha256,
      generationMeta: makeMeta(0),
    });
    await repo.saveSpriteNode({
      id: 'n-gen-1',
      projectId: project.id,
      parentId: 'n-sketch',
      kind: 'generation',
      imageBlobId: gen1Blob.id,
      sketchSha256: sketchBlob.sha256,
      generationMeta: makeMeta(1),
    });
    await repo.saveSpriteNode({
      id: 'n-gen-2',
      projectId: project.id,
      parentId: 'n-sketch',
      kind: 'generation',
      imageBlobId: gen2Blob.id,
      sketchSha256: sketchBlob.sha256,
      generationMeta: makeMeta(2),
    });
    await repo.saveSpriteNode({
      id: 'n-inpaint-1',
      projectId: project.id,
      parentId: 'n-gen-1',
      kind: 'inpaint',
      imageBlobId: inpaint1Blob.id,
      maskBlobId: mask1Blob.id,
      sketchSha256: sketchBlob.sha256,
      generationMeta: makeMeta(3),
    });
    await repo.saveSpriteNode({
      id: 'n-inpaint-2',
      projectId: project.id,
      parentId: 'n-gen-2',
      kind: 'inpaint',
      imageBlobId: inpaint2Blob.id,
      maskBlobId: mask2Blob.id,
      sketchSha256: sketchBlob.sha256,
      generationMeta: makeMeta(4),
    });

    // Initially 3 refs + 5 node images + 2 masks = 10 blobs
    expect(await db.blobs.count()).toBe(10);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    // Delete 2 leaf nodes (inpaint-1 and inpaint-2) and 1 Golden Ref
    await repo.deleteSpriteNode('n-inpaint-1');
    await repo.deleteSpriteNode('n-inpaint-2');
    const updatedProj = await repo.getProject(project.id);
    await repo.removeGoldenReference(project.id, updatedProj!.artBible.goldenReferenceBlobIds[0]!);

    expect(await findOrphanBlobIds(db)).toEqual([]);
    expect(await db.blobs.count()).toBe(5);

    // Replace root sketch image blob -> old sketchBlob must be swept immediately
    const replacementBlob = await repo.storeBlob(makePngBlob(99));
    await repo.saveSpriteNode({
      id: 'n-sketch',
      projectId: project.id,
      parentId: null,
      kind: 'sketch',
      imageBlobId: replacementBlob.id,
      sketchSha256: replacementBlob.sha256,
      generationMeta: makeMeta(0),
    });
    expect(await findOrphanBlobIds(db)).toEqual([]);
    expect(await db.blobs.count()).toBe(5);

    // Delete entire project -> blobs table must drop to 0
    await repo.deleteProjectCascade(project.id);
    expect(await db.blobs.count()).toBe(0);
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });

  it('reference-counts shared blob object URLs and revokes cleanly when refCount drops to 0', async () => {
    let createdCount = 0;
    let revokedCount = 0;
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;

    URL.createObjectURL = () => {
      createdCount += 1;
      return `blob:mock-${createdCount}`;
    };
    URL.revokeObjectURL = () => {
      revokedCount += 1;
    };

    try {
      const dummyBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
      const fetcher = async () => dummyBlob;

      const [url1, url2] = await Promise.all([
        acquireBlobUrl('shared-blob', fetcher),
        acquireBlobUrl('shared-blob', fetcher),
      ]);

      expect(url1).toBe('blob:mock-1');
      expect(url2).toBe('blob:mock-1');
      expect(createdCount).toBe(1);
      expect(getActiveBlobUrlCount()).toBe(1);

      releaseBlobUrl('shared-blob');
      expect(revokedCount).toBe(0);
      expect(getActiveBlobUrlCount()).toBe(1);

      releaseBlobUrl('shared-blob');
      expect(revokedCount).toBe(1);
      expect(getActiveBlobUrlCount()).toBe(0);

      // Releasing an in-flight acquisition before resolution must never leak an object URL
      let resolveDelayed!: (b: Blob) => void;
      const delayedPromise = acquireBlobUrl(
        'cancelled-inflight',
        () =>
          new Promise<Blob>((resolve) => {
            resolveDelayed = resolve;
          }),
      );
      releaseBlobUrl('cancelled-inflight');
      resolveDelayed(dummyBlob);
      const lateResult = await delayedPromise;
      expect(lateResult).toBeNull();
      expect(createdCount).toBe(1);
      expect(getActiveBlobUrlCount()).toBe(0);
    } finally {
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
