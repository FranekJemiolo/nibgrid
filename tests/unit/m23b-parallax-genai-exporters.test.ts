import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OFFLINE_MOCK_PROVIDER_ID } from '../../src/db/database';
import {
  createDefaultArtBible,
  createDefaultParallaxSceneConfig,
  createDefaultPostProcessConfig,
  type ProviderConfig,
  type SpriteNode,
} from '../../src/domain/schemas';
import {
  exportGodotParallaxTscn,
  exportParallaxManifestJson,
  packageParallaxZip,
} from '../../src/export/parallaxExporters';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import { processSingleParallaxLayer } from '../../src/processing/parallaxCompositor';
import { PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA } from '../../src/processing/parallaxBlueprint';
import { encodeRgbaToPngBytes, uint8ToBase64 } from '../../src/processing/png';
import type { RgbaBuffer } from '../../src/processing/types';
import { redactSecrets } from '../../src/providers/errors';
import {
  buildGeminiParallaxBandPayload,
  buildGeminiParallaxBlueprintPayload,
  buildLocalParallaxBlueprint,
  generateMatchedParallaxStack,
  generateParallaxBlueprint,
  regenerateParallaxBand,
} from '../../src/providers/parallaxGenerator';
import { processParallaxLayerInWorker } from '../../src/workers/postprocessClient';

const GEMINI_DUMMY_KEY = 'AIzaSyPARALLAX999';
const BRIDGE_DUMMY_TOKEN = 'nbg_parallax_secret_999';

function makeGeminiConfig(): ProviderConfig {
  return {
    id: 'gemini-parallax-test',
    kind: 'gemini',
    displayName: 'Gemini BYOK Test',
    modelId: 'gemini-2.5-flash-image',
    endpointUrl: '',
    apiKey: GEMINI_DUMMY_KEY,
    enabled: true,
    capabilities: {
      supportsInpaint: true,
      supportsMultiRef: true,
      supportsSeed: false,
      isLocal: false,
    },
    updatedAt: new Date().toISOString(),
  };
}

function makeMockConfig(): ProviderConfig {
  return {
    id: OFFLINE_MOCK_PROVIDER_ID,
    kind: 'mock',
    displayName: 'Offline Mock',
    modelId: 'offline-mock-v1',
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

function makeBridgeConfig(): ProviderConfig {
  return {
    id: 'antigravity-bridge-test',
    kind: 'antigravity-bridge',
    displayName: 'Antigravity Bridge',
    modelId: 'antigravity-local',
    endpointUrl: 'http://127.0.0.1:4188',
    apiKey: BRIDGE_DUMMY_TOKEN,
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

function makeSolidChromaBand(
  width: number,
  height: number,
  ridgeColor: [number, number, number],
): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      if (y < Math.floor(height / 2)) {
        data[px] = 255;
        data[px + 1] = 0;
        data[px + 2] = 255;
        data[px + 3] = 255;
      } else {
        data[px] = ridgeColor[0];
        data[px + 1] = ridgeColor[1];
        data[px + 2] = ridgeColor[2];
        data[px + 3] = 255;
      }
    }
  }
  return { width, height, data };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('M23B: GenAI/Bridge Parallax Generator, Engine Exporters & Worker Parity', () => {
  it('builds Gemini Stage 1 blueprint payload with responseSchema and Stage 2b band payload with Master Keyframe + #FF00FF isolation', () => {
    const artBible = createDefaultArtBible();
    const bpPayload = buildGeminiParallaxBlueprintPayload({
      themePrompt: 'Masovian Dusk Forest',
      bandCount: 4,
      artBible,
    });
    expect(bpPayload.generationConfig.responseMimeType).toBe('application/json');
    expect(bpPayload.generationConfig.responseSchema).toBe(
      PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA,
    );

    const blueprint = buildLocalParallaxBlueprint('Masovian Dusk Forest', artBible, 3);
    const masterPng = encodeRgbaToPngBytes(makeSolidChromaBand(8, 8, [60, 80, 110]).data, 8, 8);
    const bandPayload = buildGeminiParallaxBandPayload({
      blueprint,
      band: blueprint.bands[0]!,
      artBible,
      masterKeyframePngBytes: masterPng,
    });

    const parts = bandPayload.contents[0].parts;
    const textPart = parts.find((p): p is { text: string } => 'text' in p);
    const inlineParts = parts.filter(
      (p): p is { inlineData: { mimeType: string; data: string } } => 'inlineData' in p,
    );

    expect(textPart?.text).toContain('#FF00FF');
    expect(textPart?.text).toContain('Horizon baseline at');
    expect(inlineParts).toHaveLength(1);
    expect(inlineParts[0]!.inlineData.mimeType).toBe('image/png');
    expect(inlineParts[0]!.inlineData.data).toBe(uint8ToBase64(masterPng));
  });

  it('strictly redacts Gemini API keys and bridge tokens across 401, 429, and 500 error responses', async () => {
    const artBible = createDefaultArtBible();
    const geminiCfg = makeGeminiConfig();
    const blueprint = buildLocalParallaxBlueprint('Cyberpunk Rooftops', artBible, 3);

    for (const status of [401, 429, 500]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: { message: `Rejected request using key ${GEMINI_DUMMY_KEY} status=${status}` },
            }),
            { status, headers: { 'Content-Type': 'application/json' } },
          ),
        ),
      );

      let caught: Error | null = null;
      try {
        await generateParallaxBlueprint({
          providerConfig: geminiCfg,
          themePrompt: 'Cyberpunk Rooftops',
          bandCount: 3,
          artBible,
        });
      } catch (err) {
        caught = err as Error;
      }
      expect(caught).not.toBeNull();
      expect(caught!.message).not.toContain(GEMINI_DUMMY_KEY);
      expect(JSON.stringify(caught)).not.toContain(GEMINI_DUMMY_KEY);

      let caughtBand: Error | null = null;
      try {
        await regenerateParallaxBand({
          providerConfig: geminiCfg,
          blueprint,
          band: blueprint.bands[1]!,
          artBible,
          viewportWidth: 320,
          viewportHeight: 180,
        });
      } catch (err) {
        caughtBand = err as Error;
      }
      expect(caughtBand).not.toBeNull();
      expect(caughtBand!.message).not.toContain(GEMINI_DUMMY_KEY);
      expect(JSON.stringify(caughtBand)).not.toContain(GEMINI_DUMMY_KEY);
    }

    // Bridge secret redaction
    const bridgeCfg = makeBridgeConfig();
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(`Unauthorized token=${BRIDGE_DUMMY_TOKEN}`, { status: 401 }),
        ),
    );
    let caughtBridge: Error | null = null;
    try {
      await regenerateParallaxBand({
        providerConfig: bridgeCfg,
        blueprint,
        band: blueprint.bands[0]!,
        artBible,
        viewportWidth: 320,
        viewportHeight: 180,
      });
    } catch (err) {
      caughtBridge = err as Error;
    }
    expect(caughtBridge).not.toBeNull();
    expect(caughtBridge!.message).not.toContain(BRIDGE_DUMMY_TOKEN);
    expect(JSON.stringify(caughtBridge)).not.toContain(BRIDGE_DUMMY_TOKEN);
  });

  it('generates a deterministic 3-band offline mock stack and supports single-band reroll', async () => {
    const artBible = createDefaultArtBible();
    const mockCfg = makeMockConfig();
    const streamedIndices: number[] = [];

    const result = await generateMatchedParallaxStack({
      providerConfig: mockCfg,
      artBible,
      themePrompt: 'Volcanic Cavern',
      bandCount: 3,
      viewportWidth: 160,
      viewportHeight: 90,
      includeMasterKeyframe: false,
      onBandReady: (_artifact, index) => streamedIndices.push(index),
    });

    expect(streamedIndices).toEqual([0, 1, 2]);
    expect(result.bands).toHaveLength(3);
    for (const band of result.bands) {
      expect(band.stripChromaKey).toBe(false);
      let opaqueCount = 0;
      for (let i = 3; i < band.rawBuffer.data.length; i += 4) {
        if ((band.rawBuffer.data[i] ?? 0) > 0) opaqueCount++;
      }
      expect(opaqueCount).toBeGreaterThan(0);
    }

    const rerolled = await regenerateParallaxBand({
      providerConfig: mockCfg,
      blueprint: result.blueprint,
      band: result.blueprint.bands[1]!,
      artBible,
      viewportWidth: 160,
      viewportHeight: 90,
      variationSeed: 55555,
    });
    expect(Array.from(rerolled.rawBuffer.data)).not.toEqual(
      Array.from(result.bands[1]!.rawBuffer.data),
    );
  });

  it('exports Godot 4 Parallax2D .tscn, Phaser/PixiJS JSON, and ZIP packages validated by AssetRecipeSchema', () => {
    const artBible = createDefaultArtBible();
    const blueprint = buildLocalParallaxBlueprint('Pixel Meadow', artBible, 3);
    const layer0 = makeSolidChromaBand(48, 32, [70, 90, 140]);
    const layer1 = makeSolidChromaBand(48, 32, [45, 75, 65]);

    const exportLayers = [
      {
        id: 'far',
        name: 'Far Ridges',
        role: 'far-mountains' as const,
        scrollRatioX: 0.25,
        yOffsetPx: 0,
        seamBlendPx: 16,
        depthHaze: 0.5,
        buffer: layer0,
      },
      {
        id: 'mid',
        name: 'Oak Hills',
        role: 'midground' as const,
        scrollRatioX: 0.6,
        yOffsetPx: -4,
        seamBlendPx: 16,
        depthHaze: 0.15,
        buffer: layer1,
      },
    ];

    const opts = {
      viewportWidth: 320,
      viewportHeight: 180,
      skyTopHex: blueprint.skyTopHex,
      horizonHex: blueprint.horizonHex,
      contrastDampening: 0.35,
      cameraSpeedPxPerSec: 72,
      artMode: artBible.artMode,
      blueprint,
    };

    const tscn = exportGodotParallaxTscn('meadow-vista', exportLayers, opts);
    expect(tscn).toContain('type="Parallax2D"');
    expect(tscn).toContain('scroll_scale = Vector2(0.25, 1)');
    expect(tscn).toContain('scroll_scale = Vector2(0.6, 1)');
    expect(tscn).toContain('repeat_size = Vector2(48, 0)');
    expect(tscn).toContain('texture_filter = 1');

    const manifestJson = exportParallaxManifestJson('meadow-vista', exportLayers, opts);
    const parsedManifest = JSON.parse(manifestJson) as {
      schema: string;
      layers: Array<{
        filename: string;
        phaser: { type: string; scrollFactorX: number };
        pixi: { type: string; scrollRatioX: number };
      }>;
    };
    expect(parsedManifest.schema).toBe('nibgrid.parallax.v1');
    expect(parsedManifest.layers).toHaveLength(2);
    expect(parsedManifest.layers[0]!.phaser).toEqual({
      type: 'TileSprite',
      scrollFactorX: 0.25,
      tilePositionScaleX: 0.25,
    });
    expect(parsedManifest.layers[1]!.pixi).toEqual({
      type: 'TilingSprite',
      scrollRatioX: 0.6,
    });

    const project = {
      id: 'proj-p',
      name: 'Meadow Quest',
      artBible,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const node: SpriteNode = {
      id: 'node-p',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'tile',
      imageBlobId: 'blob-base',
      sketchSha256: 'b'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'offline-mock-v1',
        seed: 12,
        adherence: 'balanced',
        promptDelta: 'meadow bg',
        compiledPrompt: 'meadow bg',
        createdAt: new Date().toISOString(),
      },
    };
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: createDefaultPostProcessConfig(128, 128),
      filename: 'm23b-dusk-mask-generation-1024.png',
      outputWidth: 320,
      outputHeight: 180,
      parallaxScene: {
        ...createDefaultParallaxSceneConfig(),
        blueprint,
      },
    });

    const zipBytes = packageParallaxZip({
      slug: 'meadow-vista',
      layers: exportLayers,
      opts,
      recipe,
    });
    const unzipped = unzipSync(zipBytes);
    const keys = Object.keys(unzipped);
    expect(keys).toContain('meadow-vista_layer_0_far-ridges.png');
    expect(keys).toContain('meadow-vista_layer_1_oak-hills.png');
    expect(keys).toContain('meadow-vista_parallax.tscn');
    expect(keys).toContain('meadow-vista_parallax.json');
    expect(keys).toContain('meadow-vista.recipe.json');

    const pngHeader = Array.from(unzipped['meadow-vista_layer_0_far-ridges.png']!.slice(0, 8));
    expect(pngHeader).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    const parsedRecipe = AssetRecipeSchema.parse(
      JSON.parse(strFromU8(unzipped['meadow-vista.recipe.json']!)),
    );
    expect(parsedRecipe.parallaxScene?.blueprint?.sceneTitle).toBe(blueprint.sceneTitle);

    const redacted = redactSecrets('Bearer sk-live1234567890abcd in dusk-vista-generation-1024');
    expect(redacted).toContain('[REDACTED_KEY]');
    expect(redacted).toContain('dusk-vista-generation-1024');
    expect(redacted).not.toContain('sk-live1234567890abcd');
  });

  it('matches Worker fallback and direct pure-TS chroma strip + seam wrap + depth tint pixel-for-pixel', async () => {
    const raw = makeSolidChromaBand(64, 24, [40, 70, 120]);
    const direct = processSingleParallaxLayer(
      {
        id: 'band-0',
        name: 'Band 0',
        source: raw,
        scrollRatioX: 0.3,
        yOffsetPx: 0,
        seamBlendPx: 12,
        depthHaze: 0.55,
        visible: true,
        stripChromaKey: true,
        chromaTolerance: 28,
      },
      {
        horizonRgb: [200, 130, 100],
        contrastDampening: 0.35,
      },
    );

    const workerRes = await processParallaxLayerInWorker({
      layerId: 'band-0',
      layerName: 'Band 0',
      rgba: raw.data,
      width: raw.width,
      height: raw.height,
      scrollRatioX: 0.3,
      yOffsetPx: 0,
      seamBlendPx: 12,
      depthHaze: 0.55,
      visible: true,
      horizonRgb: [200, 130, 100],
      contrastDampening: 0.35,
      stripChromaKey: true,
      chromaTolerance: 28,
    });

    expect(workerRes.width).toBe(direct.buffer.width);
    expect(workerRes.height).toBe(direct.buffer.height);
    expect(Array.from(workerRes.rgba)).toEqual(Array.from(direct.buffer.data));
    // Upper sky half stripped cleanly by #FF00FF chroma key
    expect(workerRes.rgba[3]).toBe(0);
    // Lower ridge row stays opaque
    expect(workerRes.rgba[16 * workerRes.width * 4 + 3]).toBe(255);
  });
});
