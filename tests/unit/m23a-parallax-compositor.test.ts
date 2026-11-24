import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  OFFLINE_MOCK_PROVIDER_ID,
  findOrphanBlobIds,
} from '../../src/db/database';
import {
  createDefaultParallaxSceneConfig,
  createDefaultPostProcessConfig,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import { parseAndClampParallaxBlueprint } from '../../src/processing/parallaxBlueprint';
import {
  applyAtmosphericDepthTint,
  composeParallaxPreviewFrame,
  makeHorizontallySeamless,
  processSingleParallaxLayer,
} from '../../src/processing/parallaxCompositor';
import type { RgbaBuffer } from '../../src/processing/types';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m23a-${globalThis.crypto.randomUUID()}`);
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

function makeGradientStrip(width: number, height: number): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      const ratio = x / Math.max(1, width - 1);
      data[px] = Math.round(20 + 220 * ratio);
      data[px + 1] = Math.round(200 - 140 * ratio);
      data[px + 2] = 90;
      data[px + 3] = y < 4 ? 0 : 255;
    }
  }
  return { width, height, data };
}

describe('M23A: Pure-TS Parallax Compositor, Atmospheric Tinter & Blueprint Schema', () => {
  it('wraps horizontal seams without dark alpha fringes and reduces boundary delta', () => {
    const src = makeGradientStrip(64, 32);
    const seamBlendPx = 16;
    const rawWrapDelta = Math.abs(
      (src.data[(16 * src.width + 0) * 4] ?? 0) -
        (src.data[(16 * src.width + (src.width - 1)) * 4] ?? 0),
    );
    expect(rawWrapDelta).toBe(220);

    const wrapped = makeHorizontallySeamless(src, seamBlendPx);
    expect(wrapped.width).toBe(64 - 16);
    expect(wrapped.height).toBe(32);

    const wrappedRow = 16 * wrapped.width * 4;
    const seamlessWrapDelta = Math.abs(
      (wrapped.data[wrappedRow] ?? 0) - (wrapped.data[wrappedRow + (wrapped.width - 1) * 4] ?? 0),
    );
    expect(seamlessWrapDelta).toBeLessThan(12);

    // Top 4 transparent rows stay cleanly alpha=0
    for (let x = 0; x < wrapped.width; x++) {
      expect(wrapped.data[(1 * wrapped.width + x) * 4 + 3]).toBe(0);
    }

    // Premultiplied blend between opaque tail and transparent head must NOT darken toward 0
    const edgeData = new Uint8ClampedArray(40 * 4 * 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 40; x++) {
        const px = (y * 40 + x) * 4;
        if (x >= 20) {
          edgeData[px] = 240;
          edgeData[px + 1] = 200;
          edgeData[px + 2] = 180;
          edgeData[px + 3] = 255;
        }
      }
    }
    const edgeWrapped = makeHorizontallySeamless({ width: 40, height: 4, data: edgeData }, 10);
    expect(edgeWrapped.width).toBe(30);
    expect(edgeWrapped.data[2 * 30 * 4]).toBe(240);
  });

  it('applies aerial perspective haze cleanly while preserving alpha=0 gaps untouched', () => {
    const data = new Uint8ClampedArray(2 * 1 * 4);
    // Pixel 0: opaque dark foreground ridge (20, 30, 40, 255)
    data[0] = 20;
    data[1] = 30;
    data[2] = 40;
    data[3] = 255;
    // Pixel 1: sky gap (12, 34, 56, 0)
    data[4] = 12;
    data[5] = 34;
    data[6] = 56;
    data[7] = 0;

    const horizon: [number, number, number] = [210, 170, 220];
    const lightHaze = applyAtmosphericDepthTint({ width: 2, height: 1, data }, 0.2, horizon, 0.35);
    const heavyHaze = applyAtmosphericDepthTint({ width: 2, height: 1, data }, 0.8, horizon, 0.35);

    const dist = (buf: RgbaBuffer) =>
      Math.hypot(
        (buf.data[0] ?? 0) - horizon[0],
        (buf.data[1] ?? 0) - horizon[1],
        (buf.data[2] ?? 0) - horizon[2],
      );

    expect(dist(heavyHaze)).toBeLessThan(dist(lightHaze));
    expect(heavyHaze.data[3]).toBe(255);
    expect(heavyHaze.data[7]).toBe(0);
    expect(heavyHaze.data[4]).toBe(12);
  });

  it('scrolls horizontally with exact integer modulo periodicity and deterministic wrapping', () => {
    const raw = makeGradientStrip(64, 32);
    const layer = processSingleParallaxLayer(
      {
        id: 'far',
        name: 'Far Peaks',
        source: raw,
        scrollRatioX: 0.3,
        yOffsetPx: 0,
        seamBlendPx: 16,
        depthHaze: 0.45,
        visible: true,
      },
      {
        horizonRgb: [140, 110, 170],
        contrastDampening: 0.35,
      },
    );
    expect(layer.buffer.width).toBe(48);

    const sceneOpts = {
      viewportWidth: 96,
      viewportHeight: 32,
      skyTopRgb: [26, 28, 44] as const,
      horizonRgb: [140, 110, 170] as const,
      contrastDampening: 0.35,
    };

    const frame0 = composeParallaxPreviewFrame([layer], sceneOpts, 0);
    // layerWidth / scrollRatioX = 48 / 0.3 = 160 -> exact full period wrap
    const framePeriod = composeParallaxPreviewFrame([layer], sceneOpts, 160);
    expect(Array.from(framePeriod.data)).toEqual(Array.from(frame0.data));
  });

  it('clamps out-of-range AI blueprint outputs, normalizes hex, and sorts back-to-front', () => {
    const parsed = parseAndClampParallaxBlueprint(
      [
        '```json',
        JSON.stringify({
          sceneTitle: 'Clamped Cavern',
          themePrompt: 'Volcanic cavern parallax',
          skyTopHex: '#abc',
          horizonHex: 'invalid-hex',
          horizonLinePct: 0.1,
          lightingDirection: 'below lava glow',
          bandCount: 99,
          bands: [
            {
              id: 'fg',
              name: 'FG Rocks',
              role: 'foreground-silhouette',
              scrollRatioX: 9.5,
              depthHaze: -0.4,
              seamBlendPx: 999,
              yOffsetPx: -500,
              subjectPrompt: 'Dark basalt stalagmites',
              silhouetteRule: 'Flat #FF00FF chroma key',
              edgeHeightHint: 'Bottom corners flush',
            },
            {
              id: 'sky',
              name: 'Far Clouds',
              role: 'sky-far',
              scrollRatioX: -0.5,
              depthHaze: 2.2,
              seamBlendPx: -12,
              yOffsetPx: 900,
              subjectPrompt: 'Ash wisps',
              silhouetteRule: 'Flat #FF00FF chroma key',
              edgeHeightHint: 'Level at 45%',
            },
          ],
        }),
        '```',
      ].join('\n'),
    );

    expect(parsed.skyTopHex).toBe('#AABBCC');
    expect(parsed.horizonHex).toBe('#5D275D');
    expect(parsed.horizonLinePct).toBe(0.35);
    expect(parsed.bandCount).toBe(2);
    expect(parsed.bands.map((b) => b.id)).toEqual(['sky', 'fg']);
    expect(parsed.bands[0]!.scrollRatioX).toBe(0.05);
    expect(parsed.bands[0]!.depthHaze).toBe(1);
    expect(parsed.bands[0]!.seamBlendPx).toBe(0);
    expect(parsed.bands[0]!.yOffsetPx).toBe(256);
    expect(parsed.bands[1]!.scrollRatioX).toBe(1.25);
    expect(parsed.bands[1]!.depthHaze).toBe(0);
    expect(parsed.bands[1]!.seamBlendPx).toBe(64);
    expect(parsed.bands[1]!.yOffsetPx).toBe(-256);
  });

  it('tracks parallax band and master blobs in IndexedDB orphan GC and recipe serialization', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('Parallax GC Test');

    const baseBlob = await repo.storeBlob(
      new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    );
    const masterBlob = await repo.storeBlob(
      new Blob([new Uint8Array([4, 5, 6])], { type: 'image/png' }),
    );
    const bandBlob1 = await repo.storeBlob(
      new Blob([new Uint8Array([7, 8, 9])], { type: 'image/png' }),
    );
    const bandBlob2 = await repo.storeBlob(
      new Blob([new Uint8Array([10, 11, 12])], { type: 'image/png' }),
    );

    const scene = {
      ...createDefaultParallaxSceneConfig(),
      masterKeyframeBlobId: masterBlob.id,
      layers: [
        {
          id: 'b1',
          name: 'Far Mountains',
          role: 'far-mountains' as const,
          sourceKind: 'ai-band' as const,
          blobId: bandBlob1.id,
          scrollRatioX: 0.25,
          yOffsetPx: 0,
          seamBlendPx: 24,
          depthHaze: 0.5,
          visible: true,
          stripChromaKey: true,
        },
        {
          id: 'b2',
          name: 'Midground Trees',
          role: 'midground' as const,
          sourceKind: 'ai-band' as const,
          blobId: bandBlob2.id,
          scrollRatioX: 0.55,
          yOffsetPx: 0,
          seamBlendPx: 24,
          depthHaze: 0.2,
          visible: true,
          stripChromaKey: true,
        },
      ],
    };

    const node = {
      id: 'node-parallax-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation' as const,
      assetClass: 'tile' as const,
      imageBlobId: baseBlob.id,
      parallaxScene: scene,
      sketchSha256: 'a'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'offline-mock-v1',
        seed: 77,
        adherence: 'balanced' as const,
        promptDelta: 'parallax scene',
        compiledPrompt: 'parallax scene',
        createdAt: new Date().toISOString(),
      },
    };

    await repo.saveSpriteNode(node);
    expect(await findOrphanBlobIds(db)).toEqual([]);
    expect(await repo.cleanupOrphanedBlobs()).toBe(0);

    // Recipe round-trip includes parallaxScene cleanly
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: createDefaultPostProcessConfig(128, 128),
      filename: 'bg.png',
      outputWidth: 128,
      outputHeight: 128,
      parallaxScene: scene,
    });
    expect(AssetRecipeSchema.parse(recipe).parallaxScene?.layers).toHaveLength(2);

    // Replacing bandBlob1 orphans ONLY old bandBlob1 and sweeps it cleanly
    const replacementBlob = await repo.storeBlob(
      new Blob([new Uint8Array([13, 14, 15])], { type: 'image/png' }),
    );
    await repo.saveSpriteNode({
      ...node,
      parallaxScene: {
        ...scene,
        layers: [{ ...scene.layers[0]!, blobId: replacementBlob.id }, scene.layers[1]!],
      },
    });
    expect(await findOrphanBlobIds(db)).toEqual([]);
    expect(await repo.getBlob(bandBlob1.id)).toBeUndefined();
    expect(await repo.getBlob(replacementBlob.id)).toBeDefined();

    // Cascade delete leaves zero blobs and zero orphans
    await repo.deleteProjectCascade(project.id);
    expect(await findOrphanBlobIds(db)).toEqual([]);
    expect(await db.blobs.count()).toBe(0);
  });
});
