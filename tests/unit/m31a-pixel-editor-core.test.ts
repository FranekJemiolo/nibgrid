import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import {
  SpriteNodeSchema,
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type SpriteNode,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  compositeInpaintResult,
  countMaskedPixels,
  maskToOverlayRgba,
  maskToRgbaBuffer,
  paintMaskLine,
  snapMaskedPixelsToPalette,
} from '../../src/processing/inpaintMask';
import {
  PixelUndoStack,
  floodFillRgba,
  hexToRgbaColor,
  mapClientToTexel,
  plotBresenhamLine,
  rgbaColorToHex,
  samplePixelRgba,
} from '../../src/processing/pixelEditorCore';
import type { RgbaBuffer } from '../../src/processing/types';

function makeBuffer(
  width: number,
  height: number,
  fill: readonly [number, number, number, number] = [0, 0, 0, 0],
): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const px = i * 4;
    data[px] = fill[0];
    data[px + 1] = fill[1];
    data[px + 2] = fill[2];
    data[px + 3] = fill[3];
  }
  return { width, height, data };
}

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): { db: NibgridDatabase; repo: NibgridRepository } {
  const database = new NibgridDatabase(`nibgrid-m31a-test-${globalThis.crypto.randomUUID()}`);
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

describe('M31A Pure-TS Surgical Pixel Editor Core & Mask Composite', () => {
  it('draws continuous Bresenham diagonal (0,0)->(7,7) with mirrorX on 16x16 with zero gaps', () => {
    const buf = makeBuffer(16, 16);
    const gold = hexToRgbaColor('#FFCD75');
    expect(rgbaColorToHex(gold)).toBe('#FFCD75');

    plotBresenhamLine(buf, 0, 0, 7, 7, { color: gold, mirrorX: true, brushSize: 1 });

    for (let k = 0; k <= 7; k++) {
      expect(samplePixelRgba(buf, k, k)).toEqual(gold);
      expect(samplePixelRgba(buf, 15 - k, k)).toEqual(gold);
    }
    expect(samplePixelRgba(buf, 3, 4)).toEqual([0, 0, 0, 0]);
  });

  it('performs iterative 4-connected flood fill strictly within enclosed boundaries', () => {
    const buf = makeBuffer(10, 10, [0, 0, 0, 0]);
    const border: readonly [number, number, number, number] = [26, 28, 44, 255];
    const fill: readonly [number, number, number, number] = [177, 62, 83, 255];

    // Enclosed 6x6 hollow box from (2,2) to (7,7) -> interior is 4x4 (3..6, 3..6) = 16 px
    plotBresenhamLine(buf, 2, 2, 7, 2, { color: border, mirrorX: false });
    plotBresenhamLine(buf, 2, 7, 7, 7, { color: border, mirrorX: false });
    plotBresenhamLine(buf, 2, 2, 2, 7, { color: border, mirrorX: false });
    plotBresenhamLine(buf, 7, 2, 7, 7, { color: border, mirrorX: false });

    const count = floodFillRgba(buf, 4, 4, fill);
    expect(count).toBe(16);
    expect(samplePixelRgba(buf, 3, 3)).toEqual(fill);
    expect(samplePixelRgba(buf, 6, 6)).toEqual(fill);
    // Border & outside remain intact
    expect(samplePixelRgba(buf, 2, 2)).toEqual(border);
    expect(samplePixelRgba(buf, 0, 0)).toEqual([0, 0, 0, 0]);
    // Repeated fill on already-filled color is a zero-count no-op
    expect(floodFillRgba(buf, 4, 4, fill)).toBe(0);
  });

  it('restores byte-identical snapshots across 3 pushes -> 2 undos -> 1 redo and enforces maxDepth', () => {
    const stack = new PixelUndoStack(3);
    const s0 = makeBuffer(4, 4, [1, 1, 1, 255]).data;
    const s1 = makeBuffer(4, 4, [2, 2, 2, 255]).data;
    const s2 = makeBuffer(4, 4, [3, 3, 3, 255]).data;
    const s3 = makeBuffer(4, 4, [4, 4, 4, 255]).data;

    stack.pushBeforeEdit(s0);
    stack.pushBeforeEdit(s1);
    stack.pushBeforeEdit(s2);
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);

    const afterUndo1 = stack.undo(s3);
    expect(afterUndo1).toEqual(s2);
    const afterUndo2 = stack.undo(afterUndo1!);
    expect(afterUndo2).toEqual(s1);
    expect(stack.canRedo).toBe(true);

    const afterRedo = stack.redo(afterUndo2!);
    expect(afterRedo).toEqual(s2);

    // Enforces maxDepth = 3
    stack.pushBeforeEdit(s0);
    stack.pushBeforeEdit(s1);
    stack.pushBeforeEdit(s2);
    expect(stack.undoCount).toBe(3);
  });

  it('compositeInpaintResult preserves 100% of unmasked pixels byte-for-byte and throws on mismatch', () => {
    const original = makeBuffer(8, 8);
    for (let i = 0; i < original.data.length; i++) {
      original.data[i] = (i * 17 + 5) % 256;
    }
    const generated = makeBuffer(8, 8, [99, 188, 222, 255]);
    const mask = new Uint8Array(64);
    for (let y = 2; y <= 5; y++) {
      paintMaskLine(mask, 8, 8, 2, y, 5, y, 1);
    }
    expect(countMaskedPixels(mask)).toBe(16);

    const maskRgba = maskToRgbaBuffer(mask, 8, 8);
    expect(samplePixelRgba(maskRgba, 0, 0)).toEqual([0, 0, 0, 255]);
    expect(samplePixelRgba(maskRgba, 3, 3)).toEqual([255, 255, 255, 255]);
    const overlayRgba = maskToOverlayRgba(mask, 8, 8);
    expect(samplePixelRgba(overlayRgba, 0, 0)).toEqual([0, 0, 0, 0]);
    expect(samplePixelRgba(overlayRgba, 3, 3)?.[3]).toBe(115);

    const merged = compositeInpaintResult(original, generated, mask);
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const masked = x >= 2 && x <= 5 && y >= 2 && y <= 5;
        if (masked) {
          expect(samplePixelRgba(merged, x, y)).toEqual([99, 188, 222, 255]);
        } else {
          expect(samplePixelRgba(merged, x, y)).toEqual(samplePixelRgba(original, x, y));
        }
      }
    }

    const snapped = snapMaskedPixelsToPalette(merged, mask, ['#FFCD75', '#1A1C2C']);
    expect(samplePixelRgba(snapped, 0, 0)).toEqual(samplePixelRgba(original, 0, 0));

    expect(() => compositeInpaintResult(original, makeBuffer(4, 4), mask)).toThrow(
      /dimensions must match/i,
    );
  });

  it('maps CSS pointer coordinates accurately to clamped texels and commits atomically without orphan blobs', async () => {
    expect(
      mapClientToTexel(
        100 + 256 - 0.1,
        50 + 256 - 0.1,
        { left: 100, top: 50, width: 256, height: 256 },
        64,
        64,
      ),
    ).toEqual({ x: 63, y: 63 });
    expect(
      mapClientToTexel(90, 40, { left: 100, top: 50, width: 256, height: 256 }, 64, 64),
    ).toEqual({ x: 0, y: 0 });

    const { db, repo } = createTestDb();
    const project = await repo.createProject('M31 Atomic Commit', createDefaultArtBible());
    const rawBlob = await repo.storeBlobDeduplicated(new Uint8Array([1, 2, 3, 4]), 'image/png');
    const oldProcBlob = await repo.storeBlobDeduplicated(new Uint8Array([5, 6, 7, 8]), 'image/png');

    const baseNode: SpriteNode = SpriteNodeSchema.parse({
      id: 'node-m31a-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      imageBlobId: rawBlob.id,
      processedBlobId: oldProcBlob.id,
      postProcessConfig: createDefaultPostProcessConfig(64, 64),
      sketchSha256: 'a'.repeat(64),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'nibgrid-procedural-v1',
        seed: 7,
        adherence: 'strict',
        promptDelta: 'knight',
        compiledPrompt: 'knight',
        createdAt: new Date().toISOString(),
      },
    });
    await repo.saveSpriteNode(baseNode);

    const updated = await repo.commitProcessedSpritePixels(
      baseNode.id,
      new Blob([new Uint8Array([9, 10, 11, 12])], { type: 'image/png' }),
      {
        manualPixelEditCount: 4,
        inpaintHistory: [{ prompt: 'glowing visor', maskedPixels: 12, timestamp: 1700000000000 }],
      },
    );

    expect(updated.processedBlobId).not.toBe(oldProcBlob.id);
    expect(updated.manualPixelEditCount).toBe(4);
    expect(updated.inpaintHistory).toEqual([
      { prompt: 'glowing visor', maskedPixels: 12, timestamp: 1700000000000 },
    ]);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    const recipe = buildAssetRecipe({
      project,
      node: updated,
      postProcess: createDefaultPostProcessConfig(64, 64),
      filename: 'knight.png',
      outputWidth: 64,
      outputHeight: 64,
    });
    expect(AssetRecipeSchema.parse(recipe).manualPixelEditCount).toBe(4);
    expect(recipe.inpaintHistory?.length).toBe(1);
  });
});
