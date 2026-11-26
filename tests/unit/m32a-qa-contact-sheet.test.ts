import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import { createDefaultArtBible, type SpriteNode } from '../../src/domain/schemas';
import { parseAndResolveQaReport } from '../../src/processing/artDirectorQaSchema';
import {
  computeQaSheetHash,
  packQaContactSheets,
  type QaSpriteEntry,
} from '../../src/processing/qaContactSheet';
import type { RgbaBuffer } from '../../src/processing/types';

function makeSpriteBox(width: number, height: number, r: number, g: number, b: number): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 4; y < height - 4; y++) {
    for (let x = 4; x < width - 4; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = r;
      data[idx + 1] = g;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data };
}

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): { db: NibgridDatabase; repo: NibgridRepository } {
  const database = new NibgridDatabase(`nibgrid-m32a-test-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(database);
  return { db: database, repo: new NibgridRepository(database) };
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

describe('M32A Pure-TS Contact Sheet Packer, QA Schema & Dexie Cache', () => {
  it('paginates 1 Golden Reference + 17 sprites into 2 deterministic sheets pinning REF on every page', async () => {
    const entries: QaSpriteEntry[] = [
      {
        spriteId: 'ref-hero',
        slug: 'zz-golden-ref',
        isGoldenRef: true,
        buffer: makeSpriteBox(32, 32, 255, 205, 117),
      },
      ...Array.from({ length: 17 }, (_, i) => ({
        spriteId: `sprite-${String(i + 1).padStart(2, '0')}`,
        slug: `unit-${String(i + 1).padStart(2, '0')}`,
        buffer: makeSpriteBox(32, 32, 100 + i * 7, 120, 180),
      })),
    ];

    const pages1 = packQaContactSheets(entries, { cellSizePx: 64, cols: 4 });
    const pages2 = packQaContactSheets(entries, { cellSizePx: 64, cols: 4 });

    expect(pages1.length).toBe(2);
    expect(pages1[0]!.cells[0]!.indexLabel).toBe('REF');
    expect(pages1[0]!.cells[0]!.spriteId).toBe('ref-hero');
    expect(pages1[1]!.cells[0]!.indexLabel).toBe('REF');
    expect(pages1[1]!.cells[0]!.spriteId).toBe('ref-hero');

    // Page 1: REF + 15 sprites = 16 cells; Page 2: REF + 2 sprites = 3 cells
    expect(pages1[0]!.cells.length).toBe(16);
    expect(pages1[1]!.cells.length).toBe(3);
    expect(pages1[0]!.indexToSpriteId['01']).toBe('sprite-01');
    expect(pages1[0]!.indexToSpriteId['15']).toBe('sprite-15');
    expect(pages1[1]!.indexToSpriteId['01']).toBe('sprite-16');
    expect(pages1[1]!.indexToSpriteId['02']).toBe('sprite-17');

    // Exact byte determinism & zero NaN
    expect(pages1[0]!.sheet.data.length).toBe(pages2[0]!.sheet.data.length);
    expect(pages1[0]!.sheet.data.every((v, idx) => v === pages2[0]!.sheet.data[idx])).toBe(true);
    for (let i = 0; i < pages1[0]!.sheet.data.length; i++) {
      expect(Number.isFinite(pages1[0]!.sheet.data[i])).toBe(true);
    }

    const h1 = await computeQaSheetHash(pages1, 'bible-hash-1');
    const h2 = await computeQaSheetHash(pages2, 'bible-hash-1');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  }, 15_000);

  it('clamps out-of-range overallScore, drops unknown "99" index labels, and resolves valid findings', () => {
    const indexToSpriteId = {
      REF: 'ref-id',
      '01': 'node-a',
      '02': 'node-b',
    };
    const report = parseAndResolveQaReport(
      {
        overallScore: 140,
        globalNotes: 'Strong cohesion overall.',
        findings: [
          {
            indexLabel: '99',
            severity: 'fail',
            category: 'style-drift',
            summary: 'Hallucinated sprite',
            suggestedFix: 'regenerate',
          },
          {
            indexLabel: '2',
            severity: 'warn',
            category: 'light-angle',
            summary: 'Top-right highlight conflicts with top-left key light.',
            suggestedFix: 'micro-editor',
          },
          {
            indexLabel: '01',
            severity: 'pass',
            category: 'silhouette-readability',
            summary: 'Clean 1x silhouette separation.',
            suggestedFix: 'sandbox-1x',
          },
        ],
      },
      indexToSpriteId,
      'sheet-hash-abc',
      1700000000000,
    );

    expect(report.overallScore).toBe(100);
    expect(report.findings.length).toBe(2);
    expect(report.findings[0]).toMatchObject({
      indexLabel: '02',
      spriteId: 'node-b',
      severity: 'warn',
      category: 'light-angle',
      suggestedFix: 'micro-editor',
    });
    expect(report.findings[1]?.spriteId).toBe('node-a');
  });

  it('caches QA reports in Dexie v5 and cleans up on sprite delete & project cascade with zero orphans', async () => {
    const { db, repo } = createTestDb();
    const project = await repo.createProject('M32 Cache Test', createDefaultArtBible());
    const blob = await repo.storeBlobDeduplicated(new Uint8Array([1, 2, 3, 4]), 'image/png');

    const sprite: SpriteNode = {
      id: 'node-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      imageBlobId: blob.id,
      sketchSha256: 'b'.repeat(64),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'nibgrid-procedural-v1',
        seed: 1,
        adherence: 'strict',
        promptDelta: 'hero',
        compiledPrompt: 'hero',
        createdAt: new Date().toISOString(),
      },
    };
    await repo.saveSpriteNode(sprite);

    await repo.saveQaReport({
      projectId: project.id,
      sheetHash: 'hash-1',
      overallScore: 92,
      globalNotes: 'Consistent shading.',
      findings: [
        {
          indexLabel: '01',
          spriteId: sprite.id,
          severity: 'pass',
          category: 'style-drift',
          summary: 'Clean.',
          suggestedFix: 'post-process',
        },
      ],
      createdAt: Date.now(),
    });
    expect((await repo.getQaReport(project.id))?.overallScore).toBe(92);

    // Deleting a sprite invalidates stale QA cache while leaving zero orphan blobs
    await repo.deleteSpriteNode(sprite.id);
    expect(await repo.getQaReport(project.id)).toBeUndefined();
    expect(await findOrphanBlobIds(db)).toEqual([]);

    // Project cascade delete also purges qaReports cleanly
    await repo.saveQaReport({
      projectId: project.id,
      sheetHash: 'hash-2',
      overallScore: 80,
      globalNotes: 'Cached note.',
      findings: [],
      createdAt: Date.now(),
    });
    await repo.deleteProjectCascade(project.id);
    expect(await repo.getQaReport(project.id)).toBeUndefined();
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });
});
