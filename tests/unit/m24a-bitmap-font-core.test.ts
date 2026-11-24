import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  OFFLINE_MOCK_PROVIDER_ID,
  findOrphanBlobIds,
} from '../../src/db/database';
import {
  createDefaultBitmapFontConfig,
  createDefaultPostProcessConfig,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  CHARSET_PRESETS,
  bakeBitmapFontAtlas,
  buildBuiltInGlyphMasks,
  getBuiltInGlyphMask,
  measureBitmapFontText,
  styleGlyphMask,
  type BitmapFontStyleOptions,
} from '../../src/processing/bitmapFont';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m24a-${globalThis.crypto.randomUUID()}`);
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

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

const DEFAULT_OPTS: BitmapFontStyleOptions = {
  fontName: 'nibgrid_damage',
  scale: 2,
  topRgb: [255, 205, 117],
  bottomRgb: [239, 125, 87],
  outlineMode: 1,
  selOutDarken: 0.55,
  shadowOffsetX: 0,
  shadowOffsetY: 1,
  shadowRgb: [26, 28, 44],
  shadowAlpha: 180,
  letterSpacingPx: 1,
  paddingPx: 2,
};

describe('M24A: Pure-TS Bitmap Font Styler, OKLab Sel-Out & PoT Shelf Packer', () => {
  it('styles 5x7 digit 8 at scale 2 with 4-way OKLab Sel-Out and bottom drop shadow into exact 12x17 dimensions', () => {
    const mask8 = getBuiltInGlyphMask('8');
    expect(mask8.width).toBe(5);
    expect(mask8.height).toBe(7);

    const styled = styleGlyphMask(mask8, DEFAULT_OPTS);
    expect(styled.buffer.width).toBe(12); // 5*2 + 2 outline
    expect(styled.buffer.height).toBe(17); // 7*2 + 2 outline + 1 bottom shadow

    const w = styled.buffer.width;
    const h = styled.buffer.height;
    const d = styled.buffer.data;

    // Inspect interior pixel vs adjacent outline pixel in OKLab Sel-Out mode
    // Row 1 inside mask8 (top bar '.###.'): fill sits at (x=4, y=2) and outline at (x=4, y=0)
    const outlineTopIdx = (0 * w + 4) * 4;
    const fillTopIdx = (1 * w + 4) * 4;
    expect(d[outlineTopIdx + 3]).toBe(255);
    expect(d[fillTopIdx + 3]).toBe(255);
    expect(luma(d[outlineTopIdx]!, d[outlineTopIdx + 1]!, d[outlineTopIdx + 2]!)).toBeLessThan(
      luma(d[fillTopIdx]!, d[fillTopIdx + 1]!, d[fillTopIdx + 2]!),
    );

    // Bottom interior bar ('y = 13..14' before outline at 15 and shadow at 16) shifts toward bottomRgb
    const fillBottomIdx = (13 * w + 4) * 4;
    expect(d[fillBottomIdx + 3]).toBe(255);
    expect(d[fillBottomIdx + 1]).toBeLessThan(d[fillTopIdx + 1]!); // Gold->Orange lowers G channel

    // Bottom shadow row (y = h - 1 = 16) contains semi-transparent drop-shadow pixels
    let shadowCount = 0;
    for (let x = 0; x < w; x++) {
      const a = d[((h - 1) * w + x) * 4 + 3] ?? 0;
      if (a > 0) {
        expect(a).toBe(180);
        shadowCount++;
      }
    }
    expect(shadowCount).toBeGreaterThan(0);
  });

  it('packs 23 damage-numerals into a PoT atlas with zero overlapping boxes and byte-identical determinism', () => {
    const masks = buildBuiltInGlyphMasks(CHARSET_PRESETS['damage-numerals']);
    expect(masks).toHaveLength(23);

    const fontA = bakeBitmapFontAtlas(masks, {
      ...DEFAULT_OPTS,
      paletteHex: ['#1A1C2C', '#5D275D', '#B13E53', '#EF7D57', '#FFCD75', '#F4F4F4'],
      snapToPalette: true,
    });
    const fontB = bakeBitmapFontAtlas(masks, {
      ...DEFAULT_OPTS,
      paletteHex: ['#1A1C2C', '#5D275D', '#B13E53', '#EF7D57', '#FFCD75', '#F4F4F4'],
      snapToPalette: true,
    });

    expect(isPowerOfTwo(fontA.atlas.width)).toBe(true);
    expect(isPowerOfTwo(fontA.atlas.height)).toBe(true);
    expect(fontA.glyphs).toHaveLength(23);
    expect(Array.from(fontA.atlas.data)).toEqual(Array.from(fontB.atlas.data));

    for (let i = 0; i < fontA.glyphs.length; i++) {
      const a = fontA.glyphs[i]!;
      expect(a.x).toBeGreaterThanOrEqual(0);
      expect(a.y).toBeGreaterThanOrEqual(0);
      expect(a.x + a.width).toBeLessThanOrEqual(fontA.atlas.width);
      expect(a.y + a.height).toBeLessThanOrEqual(fontA.atlas.height);

      for (let j = i + 1; j < fontA.glyphs.length; j++) {
        const b = fontA.glyphs[j]!;
        const overlapsX = a.x < b.x + b.width && a.x + a.width > b.x;
        const overlapsY = a.y < b.y + b.height && a.y + a.height > b.y;
        expect(overlapsX && overlapsY).toBe(false);
      }
    }

    const measured = measureBitmapFontText(fontA, '-42 CRIT 128!');
    expect(measured.width).toBeGreaterThan(80);
    expect(measured.height).toBe(fontA.lineHeight);

    const noSpace = measureBitmapFontText(fontA, '12');
    const withSpace = measureBitmapFontText(fontA, '1 2');
    const withZero = measureBitmapFontText(fontA, '102');
    const withUnknown = measureBitmapFontText(fontA, '1H2');
    expect(withSpace.width).toBeGreaterThan(noSpace.width);
    expect(withSpace.width).toBeLessThan(withZero.width);
    expect(withUnknown.width).toBe(noSpace.width);
  });

  it('persists bitmapFont metadata cleanly in SpriteNode, AssetRecipe, and Dexie with zero orphan blobs', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('BMFont Foundry');
    const blob = await repo.storeBlob(new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }));
    const bmConfig = {
      ...createDefaultBitmapFontConfig(),
      scale: 3,
      outlineMode: 2 as const,
      previewText: 'CRIT 999!',
    };

    const node = {
      id: 'node-bm-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation' as const,
      assetClass: 'ui-panel' as const,
      bitmapFont: bmConfig,
      imageBlobId: blob.id,
      sketchSha256: 'c'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'offline-mock-v1',
        seed: 42,
        adherence: 'balanced' as const,
        promptDelta: 'ui font',
        compiledPrompt: 'ui font',
        createdAt: new Date().toISOString(),
      },
    };

    await repo.saveSpriteNode(node);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: createDefaultPostProcessConfig(64, 64),
      filename: 'nibgrid_damage.png',
      outputWidth: 128,
      outputHeight: 64,
    });
    const parsed = AssetRecipeSchema.parse(recipe);
    expect(parsed.bitmapFont?.scale).toBe(3);
    expect(parsed.bitmapFont?.outlineMode).toBe(2);

    await repo.deleteProjectCascade(project.id);
    expect(await findOrphanBlobIds(db)).toEqual([]);
    expect(await db.blobs.count()).toBe(0);
  });
});
