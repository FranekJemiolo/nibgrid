import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  OFFLINE_MOCK_PROVIDER_ID,
  findOrphanBlobIds,
} from '../../src/db/database';
import { compilePrompt } from '../../src/domain/promptCompiler';
import {
  createDefaultArtBible,
  type ProviderConfig,
  type SpriteNode,
} from '../../src/domain/schemas';
import {
  commitTurnaroundViews,
  deleteTurnaroundDirectionGroup,
} from '../../src/domain/turnaroundCommit';
import { computePivotPx } from '../../src/export/recipeBuilder';
import { sha256Bytes } from '../../src/processing/hash';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import { offlineMockProvider } from '../../src/providers/mockProvider';
import { executeSliceTurnaroundJob } from '../../src/workers/postprocess.worker';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m18b-${globalThis.crypto.randomUUID()}`);
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

function createMockConfig(): ProviderConfig {
  return {
    id: OFFLINE_MOCK_PROVIDER_ID,
    kind: 'mock',
    displayName: 'Offline Mock',
    modelId: 'procedural-mock-v1',
    endpointUrl: '',
    apiKey: '',
    enabled: true,
    capabilities: {
      supportsInpaint: true,
      supportsMultiRef: true,
      supportsSeed: true,
      isLocal: true,
    },
    updatedAt: new Date().toISOString(),
  };
}

describe('M18B Prompt Sheet Mode, Worker Slicing, Atomic Commit & Orphan GC', () => {
  it('compiles orthographic turnaround constraints in 2x2/1x4 mode and omits them in single mode', () => {
    const bible = createDefaultArtBible();
    const single = compilePrompt(bible, {
      adherence: 'balanced',
      promptDelta: 'red cat warrior',
      sheetLayout: 'single',
    });
    expect(single.positivePrompt).not.toContain('turnaround sheet');
    expect(single.positivePrompt).not.toContain('no grid lines');
    expect(single.positivePrompt).not.toContain('no text labels');

    const sheet2x2 = compilePrompt(bible, {
      adherence: 'balanced',
      promptDelta: 'red cat warrior',
      sheetLayout: '2x2',
    });
    expect(sheet2x2.positivePrompt).toContain('4-view orthographic turnaround sheet');
    expect(sheet2x2.positivePrompt).toContain('2x2 grid');
    expect(sheet2x2.positivePrompt).toContain('no grid lines');
    expect(sheet2x2.positivePrompt).toContain('no text labels');
    expect(sheet2x2.negativePrompt).toContain('grid lines');

    const sheet1x4 = compilePrompt(bible, {
      adherence: 'balanced',
      promptDelta: 'red cat warrior',
      sheetLayout: '1x4',
    });
    expect(sheet1x4.positivePrompt).toContain('1x4 horizontal strip');
    expect(sheet1x4.positivePrompt).toContain('no grid lines');
    expect(sheet1x4.positivePrompt).toContain('no text labels');
  });

  it('generates mock turnaround sheets, slices via worker handler, and commits 4 linked views with zero orphan blobs', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('Turnaround Knight');
    const bible = project.artBible;

    const blankSketch = new Uint8ClampedArray(bible.targetWidth * bible.targetHeight * 4).fill(255);
    const sketchPng = encodeRgbaToPngBytes(blankSketch, bible.targetWidth, bible.targetHeight);
    const sketchSha = await sha256Bytes(sketchPng);

    // 1. Offline Mock Provider produces 128x128 2x2 sheet when turnaroundLayout='2x2'
    const outputs2x2 = await offlineMockProvider.generate({
      config: createMockConfig(),
      artBible: bible,
      sketchRgba: blankSketch,
      sketchWidth: bible.targetWidth,
      sketchHeight: bible.targetHeight,
      sketchSha256: sketchSha,
      seed: 1024,
      adherence: 'balanced',
      promptDelta: 'knight turnaround',
      compiledPrompt: compilePrompt(bible, {
        adherence: 'balanced',
        promptDelta: 'knight turnaround',
        sheetLayout: '2x2',
      }).fullCompiledPrompt,
      variantCount: 1,
      turnaroundLayout: '2x2',
    });
    expect(outputs2x2).toHaveLength(1);
    const sheetOut = outputs2x2[0]!;
    expect(sheetOut.width).toBe(128);
    expect(sheetOut.height).toBe(128);

    // Also verify 1x4 sheet dimensions
    const outputs1x4 = await offlineMockProvider.generate({
      config: createMockConfig(),
      artBible: bible,
      sketchRgba: blankSketch,
      sketchWidth: bible.targetWidth,
      sketchHeight: bible.targetHeight,
      sketchSha256: sketchSha,
      seed: 2048,
      adherence: 'balanced',
      promptDelta: 'knight strip',
      compiledPrompt: 'strip',
      variantCount: 1,
      turnaroundLayout: '1x4',
    });
    expect(outputs1x4[0]!.width).toBe(256);
    expect(outputs1x4[0]!.height).toBe(64);

    // 2. Execute worker slicing job synchronously (simulating Node / Worker execution path)
    const sliceRes = executeSliceTurnaroundJob({
      type: 'SLICE_TURNAROUND_SHEET',
      id: 1,
      rgba: sheetOut.rgba,
      width: sheetOut.width,
      height: sheetOut.height,
      removeBackground: true,
      bgTolerance: 20,
      options: {
        layout: '2x2',
        normalizeHeight: true,
        paddingPx: 4,
      },
    });
    expect(sliceRes.result.frames).toHaveLength(4);
    expect(sliceRes.result.frames.map((f) => f.direction)).toEqual([
      'south',
      'east',
      'north',
      'west',
    ]);

    // 3. Persist sheet node and atomically commit 4 linked child SpriteNodes
    const sheetBlob = await repo.storeBlob(sheetOut.blob, 'image/png');
    const sheetNode: SpriteNode = {
      id: globalThis.crypto.randomUUID(),
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      imageBlobId: sheetBlob.id,
      sketchSha256: sketchSha,
      turnaroundMeta: {
        isTurnaroundSheet: true,
        turnaroundLayout: '2x2',
      },
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'procedural-mock-v1',
        seed: 1024,
        adherence: 'balanced',
        promptDelta: 'knight turnaround',
        compiledPrompt: 'turnaround',
        createdAt: new Date().toISOString(),
      },
    };
    await repo.saveSpriteNode(sheetNode);

    const committed = await commitTurnaroundViews(
      db,
      sheetNode,
      sliceRes.result,
      'turnaround-knight',
    );
    expect(committed.nodes).toHaveLength(4);

    const storedNodes = await repo.listSpriteNodes(project.id);
    const linked = storedNodes.filter(
      (n) => n.turnaroundMeta?.directionGroupId === committed.directionGroupId,
    );
    expect(linked).toHaveLength(4);
    expect(linked.map((n) => n.turnaroundMeta?.cardinalDirection)).toEqual([
      'south',
      'east',
      'north',
      'west',
    ]);

    for (const child of linked) {
      expect(child.parentId).toBe(sheetNode.id);
      expect(child.turnaroundMeta?.sharedPivotPx).toEqual(sliceRes.result.sharedPivotPx);
      const pxPivot = computePivotPx(
        child.postProcessConfig!.pivotNorm,
        sliceRes.result.frameWidth,
        sliceRes.result.frameHeight,
      );
      expect(pxPivot).toEqual(sliceRes.result.sharedPivotPx);
    }

    // 4. Delete direction group -> confirm zero orphan blobs
    const deletedCount = await deleteTurnaroundDirectionGroup(db, committed.directionGroupId);
    expect(deletedCount).toBe(4);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    // 5. Re-commit and delete entire project -> confirm zero orphan blobs
    await commitTurnaroundViews(db, sheetNode, sliceRes.result, 'turnaround-knight');
    await repo.deleteProjectCascade(project.id);
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });
});
