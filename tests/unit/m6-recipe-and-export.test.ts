import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { OFFLINE_MOCK_PROVIDER_ID } from '../../src/db/database';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import { packageSpriteZip, toAssetSlug } from '../../src/export/zipPackager';
import { encodeRgbaToPngBytes } from '../../src/processing/png';

describe('M6 Reproducible Recipe Builder & ZIP Packager', () => {
  it('validates AssetRecipeSchema and ensures zero API keys or secret strings appear in recipe JSON', () => {
    const project: Project = {
      id: 'proj-m6',
      name: 'Paladin Sprite Pack',
      artBible: {
        ...createDefaultArtBible(),
        projection: 'top-down',
        palette: ['#1A1C2C', '#B13E53', '#FFCD75', '#38B764'],
      },
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    };

    const node: SpriteNode = {
      id: 'node-gen-1',
      projectId: project.id,
      parentId: 'node-root-0',
      kind: 'generation',
      imageBlobId: 'blob-img',
      sketchSha256: 'e'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'nibgrid-procedural-v1',
        seed: 2048,
        adherence: 'strict',
        promptDelta: 'golden helm trim',
        compiledPrompt: 'pixel-art; top-down; golden helm trim',
        createdAt: '2026-11-23T10:04:00.000Z',
      },
    };

    const postProcess = {
      ...createDefaultPostProcessConfig(64, 64),
      bgRemoval: 'color-key' as const,
      paletteSnap: true,
      resampleEnabled: true,
      pivotNorm: { x: 0.5, y: 1.0 },
    };

    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess,
      filename: 'paladin-sprite-pack.png',
      outputWidth: 64,
      outputHeight: 64,
      normalizedWidth: 128,
      normalizedHeight: 128,
    });

    expect(AssetRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(recipe.output.pivotPx).toEqual({ x: 32, y: 64 });
    expect(recipe.output.pivotNorm).toEqual({ x: 0.5, y: 1.0 });
    expect(recipe.source.sketchSha256).toBe('e'.repeat(64));

    const json = JSON.stringify(recipe);
    expect(json).not.toMatch(/apiKey/i);
    expect(json).not.toMatch(/AIza/);
    expect(json).not.toMatch(/sk-[0-9A-Za-z]/);
  });

  it('packages valid PNG (8-byte magic header) and recipe.json via fflate zipSync', () => {
    const project: Project = {
      id: 'proj-zip',
      name: 'Slime Knight',
      artBible: createDefaultArtBible(),
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:00:00.000Z',
    };

    const node: SpriteNode = {
      id: 'node-zip',
      projectId: project.id,
      parentId: null,
      kind: 'inpaint',
      imageBlobId: 'blob-1',
      sketchSha256: 'f'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'nibgrid-procedural-v1',
        seed: 99,
        adherence: 'balanced',
        promptDelta: 'emerald visor',
        compiledPrompt: 'compiled prompt',
        createdAt: '2026-11-23T10:00:00.000Z',
      },
    };

    const slug = toAssetSlug(project.name);
    const pngBytes = encodeRgbaToPngBytes(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64);
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: {
        ...createDefaultPostProcessConfig(64, 64),
        pivotNorm: { x: 0.5, y: 1.0 },
      },
      filename: `${slug}.png`,
      outputWidth: 64,
      outputHeight: 64,
    });

    const zipBytes = packageSpriteZip({ slug, pngBytes, recipe });
    const unpacked = unzipSync(zipBytes);

    const extractedPng = unpacked[`${slug}.png`];
    const extractedRecipeBytes = unpacked[`${slug}.recipe.json`];

    expect(extractedPng).toBeDefined();
    expect(extractedRecipeBytes).toBeDefined();

    // Verify exact 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(extractedPng!.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(Array.from(extractedPng!)).toEqual(Array.from(pngBytes));

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(extractedRecipeBytes!)));
    expect(parsedRecipe.output.width).toBe(64);
    expect(parsedRecipe.output.height).toBe(64);
    expect(parsedRecipe.output.pivotNorm).toEqual({ x: 0.5, y: 1 });
    expect(parsedRecipe.output.pivotPx).toEqual({ x: 32, y: 64 });
  });
});
