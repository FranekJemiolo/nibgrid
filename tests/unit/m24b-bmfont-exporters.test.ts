import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { OFFLINE_MOCK_PROVIDER_ID } from '../../src/db/database';
import {
  createDefaultArtBible,
  createDefaultBitmapFontConfig,
  createDefaultPostProcessConfig,
  type SpriteNode,
} from '../../src/domain/schemas';
import {
  exportBmFontText,
  exportBmFontXml,
  packageBmFontZip,
} from '../../src/export/bmfontExporter';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  CHARSET_PRESETS,
  bakeBitmapFontAtlas,
  buildBuiltInGlyphMasks,
  type BitmapFontStyleOptions,
} from '../../src/processing/bitmapFont';
import { bakeBitmapFontInWorker } from '../../src/workers/postprocessClient';

const SAMPLE_OPTS: BitmapFontStyleOptions = {
  fontName: 'nibgrid_damage',
  scale: 2,
  topRgb: [255, 205, 117],
  bottomRgb: [239, 125, 87],
  paletteHex: ['#1A1C2C', '#5D275D', '#B13E53', '#EF7D57', '#FFCD75', '#F4F4F4'],
  snapToPalette: true,
  outlineMode: 1,
  selOutDarken: 0.55,
  shadowOffsetX: 0,
  shadowOffsetY: 1,
  shadowRgb: [26, 28, 44],
  shadowAlpha: 180,
  letterSpacingPx: 1,
  paddingPx: 2,
};

describe('M24B: AngelCode BMFont Exporters, Worker Baking & ZIP Bundle', () => {
  it('serializes baked metrics into AngelCode BMFont text (.fnt) and XML (.xml)', () => {
    const masks = buildBuiltInGlyphMasks(CHARSET_PRESETS['damage-numerals']);
    const baked = bakeBitmapFontAtlas(masks, SAMPLE_OPTS);
    const glyph0 = baked.glyphs.find((g) => g.id === 48)!;
    expect(glyph0).toBeDefined();

    const fnt = exportBmFontText(baked, 'damage-font.png', { paddingPx: 2 });
    expect(fnt).toContain('info face="nibgrid_damage"');
    expect(fnt).toContain('page id=0 file="damage-font.png"');
    expect(fnt).toContain('chars count=23');
    expect(fnt).toContain(
      `char id=48 x=${glyph0.x} y=${glyph0.y} width=${glyph0.width} height=${glyph0.height} xoffset=${glyph0.xoffset} yoffset=${glyph0.yoffset} xadvance=${glyph0.xadvance} page=0 chnl=15`,
    );

    const xml = exportBmFontXml(baked, 'damage-font.png', { paddingPx: 2 });
    expect(xml).toContain('<?xml version="1.0"?>');
    expect(xml).toContain('<page id="0" file="damage-font.png"/>');
    expect(xml).toContain('<chars count="23">');
    expect(xml).toContain(
      `<char id="48" x="${glyph0.x}" y="${glyph0.y}" width="${glyph0.width}" height="${glyph0.height}" xoffset="${glyph0.xoffset}" yoffset="${glyph0.yoffset}" xadvance="${glyph0.xadvance}" page="0" chnl="15"/>`,
    );

    // Escapes XML special characters cleanly
    const quotedXml = exportBmFontXml({ ...baked, fontName: 'a&b"c<d>' }, 'font&sheet.png');
    expect(quotedXml).toContain('face="a&amp;b&quot;c&lt;d&gt;"');
    expect(quotedXml).toContain('file="font&amp;sheet.png"');
  });

  it('packages valid PNG (magic signature), .fnt, .xml, and Zod-validated recipe.json into ZIP', () => {
    const masks = buildBuiltInGlyphMasks(CHARSET_PRESETS['damage-numerals']);
    const baked = bakeBitmapFontAtlas(masks, SAMPLE_OPTS);
    const artBible = createDefaultArtBible();
    const project = {
      id: 'proj-bm',
      name: 'Combat Numerals',
      artBible,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const bmConfig = createDefaultBitmapFontConfig();
    const node: SpriteNode = {
      id: 'node-bm',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'ui-panel',
      bitmapFont: bmConfig,
      imageBlobId: 'blob-bm',
      sketchSha256: 'd'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'offline-mock-v1',
        seed: 9,
        adherence: 'balanced',
        promptDelta: 'damage font',
        compiledPrompt: 'damage font',
        createdAt: new Date().toISOString(),
      },
    };
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: createDefaultPostProcessConfig(128, 128),
      filename: 'damage-font.png',
      outputWidth: baked.atlas.width,
      outputHeight: baked.atlas.height,
    });

    const zipBytes = packageBmFontZip({
      slug: 'damage-font',
      font: baked,
      recipe,
      paddingPx: 2,
    });
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).sort()).toEqual([
      'damage-font.fnt',
      'damage-font.png',
      'damage-font.recipe.json',
      'damage-font.xml',
    ]);

    const pngHeader = Array.from(unzipped['damage-font.png']!.slice(0, 8));
    expect(pngHeader).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(strFromU8(unzipped['damage-font.fnt']!)).toContain('chars count=23');
    expect(strFromU8(unzipped['damage-font.xml']!)).toContain('<chars count="23">');

    const parsedRecipe = AssetRecipeSchema.parse(
      JSON.parse(strFromU8(unzipped['damage-font.recipe.json']!)),
    );
    expect(parsedRecipe.bitmapFont?.fontName).toBe('nibgrid_damage');
  });

  it('matches Worker fallback and direct bakeBitmapFontAtlas pixel-for-pixel', async () => {
    const masks = buildBuiltInGlyphMasks(CHARSET_PRESETS['hud-upper']);
    const direct = bakeBitmapFontAtlas(masks, SAMPLE_OPTS);
    const workerRes = await bakeBitmapFontInWorker({
      masks,
      options: SAMPLE_OPTS,
    });

    expect(workerRes.result.atlas.width).toBe(direct.atlas.width);
    expect(workerRes.result.atlas.height).toBe(direct.atlas.height);
    expect(workerRes.result.glyphs).toEqual(direct.glyphs);
    expect(Array.from(workerRes.result.atlas.data)).toEqual(Array.from(direct.atlas.data));
  });
});
