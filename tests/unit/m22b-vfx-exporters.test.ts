import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  createDefaultVfxFlipbookConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  exportGodotVfxBundle,
  exportPixiVfxJson,
  packageVfxFlipbookZip,
} from '../../src/export/vfxExporters';
import { packageSpriteZip } from '../../src/export/zipPackager';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import { bakeVfxFlipbook } from '../../src/processing/vfxFlipbook';
import { executeBakeVfxFlipbookJob } from '../../src/workers/postprocess.worker';
import { bakeVfxFlipbookInWorker } from '../../src/workers/postprocessClient';

function createTestVfxRecipe() {
  const vfxConfig = {
    ...createDefaultVfxFlipbookConfig(),
    archetype: 'hit-ring' as const,
    frameSizePx: 32,
    cols: 4,
    rows: 4,
    fps: 16,
  };
  const project: Project = {
    id: 'proj-m22b',
    name: 'Spark Burst',
    artBible: createDefaultArtBible(),
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
  const node: SpriteNode = {
    id: 'node-m22b',
    projectId: project.id,
    parentId: null,
    kind: 'generation',
    assetClass: 'vfx',
    vfxFlipbook: vfxConfig,
    imageBlobId: 'blob-m22b',
    sketchSha256: 'd'.repeat(64),
    generationMeta: {
      providerId: 'offline-mock',
      modelId: 'nibgrid-procedural-v1',
      seed: 101,
      adherence: 'balanced',
      promptDelta: 'shockwave ring',
      compiledPrompt: 'shockwave ring',
      createdAt: '2026-11-24T00:00:00.000Z',
    },
  };
  return buildAssetRecipe({
    project,
    node,
    postProcess: createDefaultPostProcessConfig(64, 64),
    filename: 'spark-burst_vfx_sheet.png',
    outputWidth: 128,
    outputHeight: 128,
    assetClass: 'vfx',
    vfxFlipbook: vfxConfig,
  });
}

describe('M22B: Godot 4 GPUParticles2D & PixiJS VFX Exporters + Worker/ZIP Integration', () => {
  it('emits Godot 4 CanvasItemMaterial .tres and GPUParticles2D .tscn resources', () => {
    const sparksBundle = exportGodotVfxBundle(
      'spark-burst',
      { archetype: 'sparks', frameSizePx: 32, cols: 4, rows: 4 },
      16,
    );
    expect(sparksBundle.materialTres).toContain('[gd_resource type="CanvasItemMaterial" format=3]');
    expect(sparksBundle.materialTres).toContain('particles_animation = true');
    expect(sparksBundle.materialTres).toContain('particles_anim_h_frames = 4');
    expect(sparksBundle.materialTres).toContain('particles_anim_v_frames = 4');
    expect(sparksBundle.materialTres).toContain('particles_anim_loop = false');
    expect(sparksBundle.materialTres).toContain('blend_mode = 1');

    expect(sparksBundle.sceneTscn).toContain('type="GPUParticles2D"');
    expect(sparksBundle.sceneTscn).toContain('anim_speed_min = 1.0');
    expect(sparksBundle.sceneTscn).toContain('anim_speed_max = 1.0');
    expect(sparksBundle.sceneTscn).toContain('res://spark-burst_vfx_sheet.png');
    expect(sparksBundle.sceneTscn).toContain('res://spark-burst_vfx_godot.tres');

    const smokeBundle = exportGodotVfxBundle(
      'smoke-plume',
      { archetype: 'smoke', frameSizePx: 32, cols: 8, rows: 2 },
      12,
    );
    expect(smokeBundle.materialTres).not.toContain('blend_mode = 1');
    expect(smokeBundle.materialTres).toContain('particles_anim_h_frames = 8');
    expect(smokeBundle.materialTres).toContain('particles_anim_v_frames = 2');
  });

  it('emits PixiJS JSON spec with exact frame cells and archetype-aware blendMode', () => {
    const hitRingJson = JSON.parse(
      exportPixiVfxJson(
        'hit-ring',
        { archetype: 'hit-ring', frameSizePx: 32, cols: 4, rows: 4 },
        16,
      ),
    );
    expect(hitRingJson.app).toBe('nibgrid');
    expect(hitRingJson.engine).toBe('pixijs');
    expect(hitRingJson.frameCount).toBe(16);
    expect(hitRingJson.sheetWidth).toBe(128);
    expect(hitRingJson.sheetHeight).toBe(128);
    expect(hitRingJson.blendMode).toBe('add');
    expect(hitRingJson.frames).toHaveLength(16);
    expect(hitRingJson.frames[0]).toEqual({ frame: 0, x: 0, y: 0, w: 32, h: 32 });
    expect(hitRingJson.frames[5]).toEqual({ frame: 5, x: 32, y: 32, w: 32, h: 32 });
    expect(hitRingJson.frames[15]).toEqual({ frame: 15, x: 96, y: 96, w: 32, h: 32 });

    const smokeJson = JSON.parse(
      exportPixiVfxJson(
        'smoke-cloud',
        { archetype: 'smoke', frameSizePx: 64, cols: 4, rows: 2 },
        10,
      ),
    );
    expect(smokeJson.blendMode).toBe('normal');
    expect(smokeJson.frameCount).toBe(8);
  });

  it('round-trips VFX ZIP bundles and executes identically in worker fallback', async () => {
    const opts = {
      archetype: 'hit-ring' as const,
      frameSizePx: 32,
      cols: 4,
      rows: 4,
      seed: 101,
      spread: 0.42,
      turbulence: 0.35,
      coreRgb: [255, 243, 176] as const,
      outerRgb: [249, 115, 22] as const,
    };
    const direct = bakeVfxFlipbook(opts);
    const workerJob = executeBakeVfxFlipbookJob({
      type: 'BAKE_VFX_FLIPBOOK',
      id: 1,
      options: opts,
      sourceSprite: null,
    });
    const viaClient = await bakeVfxFlipbookInWorker({
      options: opts,
      sourceSprite: null,
    });

    expect(
      Buffer.compare(Buffer.from(direct.sheet.data), Buffer.from(workerJob.result.sheet.data)),
    ).toBe(0);
    expect(
      Buffer.compare(Buffer.from(direct.sheet.data), Buffer.from(viaClient.result.sheet.data)),
    ).toBe(0);

    const sheetPngBytes = encodeRgbaToPngBytes(
      direct.sheet.data,
      direct.sheet.width,
      direct.sheet.height,
    );
    const recipe = createTestVfxRecipe();

    const zipBytes = packageVfxFlipbookZip({
      slug: 'spark-burst',
      sheetPngBytes,
      opts,
      fps: 16,
      recipe,
    });
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).sort()).toEqual([
      'spark-burst.recipe.json',
      'spark-burst_vfx_godot.tres',
      'spark-burst_vfx_godot.tscn',
      'spark-burst_vfx_pixi.json',
      'spark-burst_vfx_sheet.png',
    ]);

    const pngEntry = unzipped['spark-burst_vfx_sheet.png'];
    expect(pngEntry).toBeDefined();
    expect(Array.from(pngEntry!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const tresText = strFromU8(unzipped['spark-burst_vfx_godot.tres']!);
    expect(tresText).toContain('particles_anim_h_frames = 4');
    expect(tresText).toContain('particles_anim_v_frames = 4');

    const tscnText = strFromU8(unzipped['spark-burst_vfx_godot.tscn']!);
    expect(tscnText).toContain('GPUParticles2D');

    const pixiParsed = JSON.parse(strFromU8(unzipped['spark-burst_vfx_pixi.json']!));
    expect(pixiParsed.frames).toHaveLength(16);

    const parsedRecipe = AssetRecipeSchema.parse(
      JSON.parse(strFromU8(unzipped['spark-burst.recipe.json']!)),
    );
    expect(parsedRecipe.vfxFlipbook?.archetype).toBe('hit-ring');

    // Also verify packageSpriteZip accepts vfxFlipbookBundle seamlessly
    const combinedZip = unzipSync(
      packageSpriteZip({
        slug: 'spark-burst',
        pngBytes: sheetPngBytes,
        recipe,
        vfxFlipbookBundle: { sheetPngBytes, opts, fps: 16 },
      }),
    );
    expect(Object.keys(combinedZip)).toContain('spark-burst_vfx_godot.tres');
    expect(Object.keys(combinedZip)).toContain('spark-burst_vfx_pixi.json');
  });
});
