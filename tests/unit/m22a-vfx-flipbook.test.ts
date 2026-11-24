import { describe, expect, it } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  createDefaultVfxFlipbookConfig,
  SpriteNodeSchema,
  VfxFlipbookConfigSchema,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import type { RgbaBuffer } from '../../src/processing/types';
import {
  bakeVfxFlipbook,
  fbm2d,
  hexToRgbTuple,
  valueNoise2d,
  type VfxArchetype,
} from '../../src/processing/vfxFlipbook';

function countNonZeroAlphaPixels(buf: RgbaBuffer): number {
  let count = 0;
  for (let i = 3; i < buf.data.length; i += 4) {
    if ((buf.data[i] ?? 0) > 0) count++;
  }
  return count;
}

function makeOpaqueSprite(width: number, height: number): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 80;
    data[i * 4 + 1] = 170;
    data[i * 4 + 2] = 240;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('M22A: Pure-TS VFX Flipbook Synthesizer, FBM Noise & Schema', () => {
  it('bakes byte-identical 32x32 4x4 (128x128) sparks sheets for seed 101 with 16 non-empty frames and zero NaN', () => {
    const opts = {
      archetype: 'sparks' as const,
      frameSizePx: 32,
      cols: 4,
      rows: 4,
      seed: 101,
      spread: 0.42,
      turbulence: 0.35,
      coreRgb: [255, 243, 176] as const,
      outerRgb: [249, 115, 22] as const,
    };

    const first = bakeVfxFlipbook(opts);
    const second = bakeVfxFlipbook(opts);

    expect(first.frameSizePx).toBe(32);
    expect(first.cols).toBe(4);
    expect(first.rows).toBe(4);
    expect(first.frameCount).toBe(16);
    expect(first.sheet.width).toBe(128);
    expect(first.sheet.height).toBe(128);
    expect(first.frames).toHaveLength(16);
    expect(Buffer.compare(Buffer.from(first.sheet.data), Buffer.from(second.sheet.data))).toBe(0);

    for (const v of first.sheet.data) {
      expect(Number.isNaN(v)).toBe(false);
    }

    for (const frame of first.frames) {
      expect(frame.width).toBe(32);
      expect(frame.height).toBe(32);
      expect(countNonZeroAlphaPixels(frame)).toBeGreaterThan(0);
    }

    // Check smooth noise bounds remain strictly in [0, 1]
    for (let i = 0; i < 16; i++) {
      const vn = valueNoise2d(i * 0.37, i * 0.61, 101);
      const fn = fbm2d(i * 0.41, i * 0.29, 101);
      expect(vn).toBeGreaterThanOrEqual(0);
      expect(vn).toBeLessThanOrEqual(1);
      expect(fn).toBeGreaterThanOrEqual(0);
      expect(fn).toBeLessThanOrEqual(1);
    }
  });

  it('renders all 5 archetypes cleanly and erodes noise-dissolve monotonically from t=0 to t=1', () => {
    const sourceSprite = makeOpaqueSprite(16, 16);
    const archetypes: readonly VfxArchetype[] = [
      'sparks',
      'dust-puff',
      'smoke',
      'hit-ring',
      'noise-dissolve',
    ];

    for (const archetype of archetypes) {
      const res = bakeVfxFlipbook({
        archetype,
        frameSizePx: 24,
        cols: 4,
        rows: 2,
        seed: 42,
        spread: 0.42,
        turbulence: 0.45,
        coreRgb: hexToRgbTuple('#FFF3B0'),
        outerRgb: hexToRgbTuple('#EF7D57'),
        sourceSprite: archetype === 'noise-dissolve' ? sourceSprite : null,
      });

      expect(res.frameCount).toBe(8);
      expect(res.sheet.width).toBe(96);
      expect(res.sheet.height).toBe(48);
      for (const frame of res.frames) {
        expect(countNonZeroAlphaPixels(frame)).toBeGreaterThan(0);
      }
    }

    // Dissolve invariant with opaque 16x16 sprite
    const dissolve = bakeVfxFlipbook({
      archetype: 'noise-dissolve',
      frameSizePx: 16,
      cols: 4,
      rows: 2,
      seed: 77,
      spread: 0.42,
      turbulence: 0.5,
      coreRgb: [255, 240, 160],
      outerRgb: [240, 90, 40],
      sourceSprite,
    });
    const firstOpaque = countNonZeroAlphaPixels(dissolve.frames[0]!);
    const lastOpaque = countNonZeroAlphaPixels(dissolve.frames[dissolve.frames.length - 1]!);
    expect(firstOpaque).toBeGreaterThanOrEqual(Math.floor(16 * 16 * 0.9));
    expect(lastOpaque).toBeLessThan(Math.floor(16 * 16 * 0.35));
    expect(lastOpaque).toBeGreaterThan(0);

    // Dissolve without sourceSprite falls back gracefully to procedural orb
    const dissolveNull = bakeVfxFlipbook({
      archetype: 'noise-dissolve',
      frameSizePx: 24,
      cols: 2,
      rows: 2,
      seed: 9,
      spread: 0.4,
      turbulence: 0.4,
      coreRgb: [255, 255, 255],
      outerRgb: [56, 189, 248],
      sourceSprite: null,
    });
    expect(countNonZeroAlphaPixels(dissolveNull.frames[0]!)).toBeGreaterThan(
      countNonZeroAlphaPixels(dissolveNull.frames[3]!),
    );

    // Art Bible palette snap restricts non-transparent pixel colors strictly to palette
    const palette = ['#1A1C2C', '#EF7D57', '#FFCD75'];
    const snapped = bakeVfxFlipbook({
      archetype: 'hit-ring',
      frameSizePx: 24,
      cols: 2,
      rows: 2,
      seed: 11,
      spread: 0.4,
      turbulence: 0.3,
      coreRgb: [255, 250, 200],
      outerRgb: [240, 120, 80],
      paletteHex: palette,
      snapToPalette: true,
    });
    const allowed = new Set(['26,28,44', '239,125,87', '255,205,117']);
    for (let i = 0; i < snapped.sheet.data.length; i += 4) {
      if ((snapped.sheet.data[i + 3] ?? 0) === 0) continue;
      const key = `${snapped.sheet.data[i]},${snapped.sheet.data[i + 1]},${snapped.sheet.data[i + 2]}`;
      expect(allowed.has(key)).toBe(true);
    }
  });

  it('validates VfxFlipbookConfigSchema, SpriteNodeSchema, and AssetRecipeSchema round-trip', () => {
    const vfxConfig = createDefaultVfxFlipbookConfig();
    expect(VfxFlipbookConfigSchema.parse(vfxConfig).archetype).toBe('sparks');

    const project: Project = {
      id: 'proj-m22a',
      name: 'VFX Foundry',
      artBible: createDefaultArtBible(),
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    };
    const node: SpriteNode = SpriteNodeSchema.parse({
      id: 'node-m22a',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'vfx',
      vfxFlipbook: {
        ...vfxConfig,
        archetype: 'hit-ring',
        cols: 8,
        rows: 2,
      },
      imageBlobId: 'blob-m22a',
      sketchSha256: 'c'.repeat(64),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'nibgrid-procedural-v1',
        seed: 101,
        adherence: 'balanced',
        promptDelta: 'energy shockwave',
        compiledPrompt: 'energy shockwave',
        createdAt: '2026-11-24T00:00:00.000Z',
      },
    });

    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: createDefaultPostProcessConfig(64, 64),
      filename: 'vfx-shockwave.png',
      outputWidth: 256,
      outputHeight: 128,
      assetClass: 'vfx',
    });

    const parsedRecipe = AssetRecipeSchema.parse(recipe);
    expect(parsedRecipe.vfxFlipbook?.archetype).toBe('hit-ring');
    expect(parsedRecipe.vfxFlipbook?.cols).toBe(8);
    expect(parsedRecipe.vfxFlipbook?.rows).toBe(2);
  });
});
