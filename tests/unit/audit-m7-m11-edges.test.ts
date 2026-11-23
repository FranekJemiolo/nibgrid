import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import { exportGodotTres, packageAtlasZip } from '../../src/export/atlasExporters';
import { buildAssetRecipe } from '../../src/export/recipeBuilder';
import { composeAtlasPages, type AtlasFrameInput } from '../../src/processing/atlasCompositor';
import { demixelBuffer } from '../../src/processing/demixel';
import { bakeNormalMapCpu } from '../../src/processing/distanceField';
import { solveMlsMesh } from '../../src/processing/mlsWarp';
import { cleanOrphanPixels } from '../../src/processing/orphanCleaner';
import { applySelectiveOutline } from '../../src/processing/selOut';
import { buildAlphaClippedMesh } from '../../src/processing/spriteMesh';
import type { RgbaBuffer } from '../../src/processing/types';
import { classifyProviderError, ProviderError, redactSecrets } from '../../src/providers/errors';
import { buildPuppetStripArtifacts } from '../../src/webgl/puppetRenderer';

function makeTestMixelSpriteWithOrphan(): RgbaBuffer {
  const width = 64;
  const height = 64;
  const data = new Uint8ClampedArray(width * height * 4);
  // 2x2 grid-aligned knight body (16..48, 12..52)
  for (let y = 12; y < 52; y++) {
    for (let x = 16; x < 48; x++) {
      const idx = (y * width + x) * 4;
      data[idx] = x < 32 ? 210 : 170;
      data[idx + 1] = 70;
      data[idx + 2] = 95;
      data[idx + 3] = 255;
    }
  }
  // 1px isolated orphan pixel at (2, 2)
  const orphanIdx = (2 * width + 2) * 4;
  data[orphanIdx] = 255;
  data[orphanIdx + 1] = 0;
  data[orphanIdx + 2] = 0;
  data[orphanIdx + 3] = 255;
  return { width, height, data };
}

describe('Post-M11 Audit Phase 2: Cross-Module Integrity & Edge Cases', () => {
  it('completes full M7 -> M8 -> M9 -> M11 pipeline with aligned albedo/normal sheets and Godot .tres', () => {
    // M7: De-Mixel + Orphan Clean + Outer Sel-Out
    const raw = makeTestMixelSpriteWithOrphan();
    const { buffer: demixed } = demixelBuffer(raw, { manualCellSize: 2 });
    const { buffer: cleaned } = cleanOrphanPixels(demixed, { maxIslandPixels: 2 });
    // Ensure orphan corner pixel removed
    expect(cleaned.data[(1 * cleaned.width + 1) * 4 + 3]).toBe(0);

    const outlined = applySelectiveOutline(cleaned, {
      mode: 'outer',
      expandCanvas: false,
    });

    // M8: Bake OpenGL (+Y) normal map
    const normalMap = bakeNormalMapCpu(outlined, {
      bevelRadiusPx: 8,
      bevelProfile: 'spherical-dome',
      bevelStrength: 2.4,
      detailStrength: 1.0,
      convention: 'opengl',
    });
    expect(normalMap.width).toBe(outlined.width);
    expect(normalMap.height).toBe(outlined.height);

    // M9: Puppet Warp strip + tangent-space rotated normals
    const mesh = buildAlphaClippedMesh(outlined, { artMode: 'pixel-art' });
    const stripRes = buildPuppetStripArtifacts(outlined, mesh, 'hero', {
      preset: 'idle-breathe',
      mode: 'rigid',
      pins: [
        { id: 'a', x: outlined.width * 0.5, y: outlined.height * 0.8, role: 'anchor' },
        { id: 'b', x: outlined.width * 0.5, y: outlined.height * 0.3, role: 'tip' },
      ],
      frameCount: 4,
      amplitudePx: 3,
      fps: 8,
      loop: true,
      pingPong: false,
      paddingPx: 2,
      reLockPolish: false,
      artMode: 'pixel-art',
      pivotNorm: { x: 0.5, y: 1 },
      normalMap,
      normalInvertY: 1,
    });

    expect(stripRes.frames).toHaveLength(4);
    expect(stripRes.normalStripBuffer).toBeDefined();

    // M11: Compose aligned atlas + export Godot 4 .tres
    const atlasInputs: AtlasFrameInput[] = stripRes.frames.map((frame, i) => {
      const fw = frame.width;
      const fh = frame.height;
      const normData = new Uint8ClampedArray(fw * fh * 4);
      for (let y = 0; y < fh; y++) {
        const srcOff = (y * stripRes.normalStripBuffer!.width + i * fw) * 4;
        normData.set(
          stripRes.normalStripBuffer!.data.subarray(srcOff, srcOff + fw * 4),
          y * fw * 4,
        );
      }
      return {
        id: `hero_idle_${i}`,
        sprite: frame,
        normalMap: { width: fw, height: fh, data: normData },
        pivotNorm: { x: 0.5, y: 1 },
        animationName: 'hero_idle',
      };
    });

    const atlas = composeAtlasPages(atlasInputs, {
      maxWidth: 512,
      maxHeight: 512,
      padding: 2,
      extrude: 1,
      powerOfTwo: true,
      allowRotation: false,
      disableRotationForEngine: true,
    });

    expect(atlas.pages.length).toBeGreaterThanOrEqual(1);
    expect(atlas.pages[0]!.normal).toBeDefined();
    expect(atlas.pages[0]!.normal!.width).toBe(atlas.pages[0]!.albedo.width);
    expect(atlas.pages[0]!.normal!.height).toBe(atlas.pages[0]!.albedo.height);

    const zipBytes = packageAtlasZip({
      atlas,
      baseSlug: 'hero_pack',
      engines: ['godot', 'pixi', 'phaser'],
      artMode: 'pixel-art',
      fps: 8,
    });
    const unzipped = unzipSync(zipBytes);
    expect(unzipped['hero_pack_0.png']).toBeDefined();
    expect(unzipped['hero_pack_0_n.png']).toBeDefined();

    const tresText = strFromU8(unzipped['hero_pack_frames.tres']!);
    expect(tresText).toContain('[sub_resource type="CanvasTexture"');
    expect(tresText).toContain('diffuse_texture = ExtResource(');
    expect(tresText).toContain('normal_texture = ExtResource(');
    expect(tresText).toContain('texture_filter = 1');
    expect(tresText).toContain('SpriteFrames');
    expect(tresText).toContain('"hero_idle"');
  });

  it('guarantees zero NaN/Infinity from solveMlsMesh with coincident, extreme, and invalid pins', () => {
    const restVertices = new Float32Array([0, 0, 16, 16, 32, 0, 32, 32, 16, 48]);

    // Case 1: Coincident pins pulling toward diverging extreme targets (-10000..+10000)
    const coincident = [
      { x: 16, y: 16 },
      { x: 16, y: 16 },
    ];
    const extremeTargets = [
      { x: -10000, y: 10000 },
      { x: 10000, y: -10000 },
    ];
    for (const mode of ['rigid', 'similarity'] as const) {
      const res = solveMlsMesh(restVertices, coincident, extremeTargets, mode);
      for (const v of res.positions) {
        expect(Number.isFinite(v)).toBe(true);
      }
      for (const r of res.rotations) {
        expect(Number.isFinite(r)).toBe(true);
      }
    }

    // Case 2: Float32-overflowing displacements & non-finite pins fall back safely
    const overflowRes = solveMlsMesh(
      restVertices,
      [
        { x: 4, y: 4 },
        { x: 28, y: 28 },
      ],
      [
        { x: 1e40, y: -1e40 },
        { x: Number.NaN, y: Number.POSITIVE_INFINITY },
      ],
      'similarity',
    );
    for (const v of overflowRes.positions) {
      expect(Number.isFinite(v)).toBe(true);
    }
    for (const r of overflowRes.rotations) {
      expect(Number.isFinite(r)).toBe(true);
    }
  });

  it('rejects oversized sprites cleanly and formats Godot .tres with forward slashes and integer Rect2s', () => {
    const bigData = new Uint8ClampedArray(600 * 600 * 4);
    bigData[3] = 255;
    bigData[(599 * 600 + 599) * 4 + 3] = 255;

    expect(() =>
      composeAtlasPages(
        [
          {
            id: 'too_big',
            sprite: { width: 600, height: 600, data: bigData },
          },
        ],
        {
          maxWidth: 512,
          maxHeight: 512,
          padding: 2,
          extrude: 1,
          powerOfTwo: true,
          allowRotation: false,
        },
      ),
    ).toThrow(/exceeds max atlas/i);

    const smallData = new Uint8ClampedArray(16 * 16 * 4);
    for (let i = 3; i < smallData.length; i += 4) smallData[i] = 255;
    const atlas = composeAtlasPages(
      [
        {
          id: 'sub\\hero_0',
          sprite: { width: 16, height: 16, data: smallData },
        },
      ],
      {
        maxWidth: 256,
        maxHeight: 256,
        padding: 2,
        extrude: 1,
        powerOfTwo: true,
        allowRotation: false,
      },
    );
    const tres = exportGodotTres(atlas, 'nested\\pack', 'pixel-art', 8);

    expect(tres.framesTresFilename).toBe('nested/pack_frames.tres');
    expect(tres.framesTresContent).not.toContain('\\');
    for (const [k, v] of Object.entries(tres.texturesTresFiles)) {
      expect(k).not.toContain('\\');
      expect(v).not.toContain('\\');
    }
    const rectMatches = [...tres.framesTresContent.matchAll(/Rect2\(([^)]+)\)/g)];
    expect(rectMatches.length).toBeGreaterThan(0);
    for (const match of rectMatches) {
      const nums = match[1]!.split(',').map((s) => s.trim());
      for (const n of nums) {
        expect(n).toMatch(/^-?\d+$/);
      }
    }
  });

  it('redacts Antigravity bridge tokens and Gemini keys from errors and blocks leakage in recipeBuilder', () => {
    const rawMsg =
      'Failed connecting to bridge with Bearer nbg_secret_1234567890abcd and AIzaSyDummyTestKey123456789';
    const cleaned = redactSecrets(rawMsg);
    expect(cleaned).not.toContain('nbg_secret_1234567890abcd');
    expect(cleaned).not.toContain('AIzaSyDummyTestKey123456789');

    const err = new ProviderError({
      code: 'UNAUTHORIZED',
      message: rawMsg,
      remediation: 'Reconnect using fresh nbg_remediation_secret99 token',
      providerId: 'antigravity-bridge',
      status: 401,
      retryable: false,
    });
    expect(err.message).not.toContain('nbg_secret_1234567890abcd');
    expect(err.message).not.toContain('AIzaSyDummyTestKey123456789');
    expect(err.remediation).not.toContain('nbg_remediation_secret99');

    const classified = classifyProviderError(err, {
      providerId: 'antigravity-bridge',
      providerKind: 'antigravity-bridge',
      secrets: ['customSecretXYZ123'],
    });
    expect(classified.code).toBe('UNAUTHORIZED');

    const sha = '0'.repeat(64);
    const project: Project = {
      id: 'p1',
      name: 'Bad Project nbg_leak_token_99999',
      artBible: createDefaultArtBible(),
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const node: SpriteNode = {
      id: 'n1',
      projectId: 'p1',
      parentId: null,
      kind: 'generation',
      imageBlobId: 'b1',
      sketchSha256: sha,
      generationMeta: {
        providerId: 'antigravity-bridge',
        modelId: 'gemini-2.5-flash-image',
        seed: 1,
        adherence: 'strict',
        promptDelta: '',
        compiledPrompt: 'hero',
        createdAt: '2026-01-01T00:00:00Z',
      },
    };
    expect(() =>
      buildAssetRecipe({
        project,
        node,
        postProcess: createDefaultPostProcessConfig(64, 64),
        filename: 'hero.png',
        outputWidth: 64,
        outputHeight: 64,
      }),
    ).toThrow(/sensitive/i);
  });
});
