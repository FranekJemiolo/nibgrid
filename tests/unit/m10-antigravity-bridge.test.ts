import { describe, expect, it } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type Project,
  type ProviderConfig,
  type SpriteNode,
} from '../../src/domain/schemas';
import { buildAssetRecipe } from '../../src/export/recipeBuilder';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import {
  AntigravityBridgeProvider,
  selectStatefulInteractionChain,
} from '../../src/providers/antigravityBridgeProvider';
import { classifyProviderError } from '../../src/providers/errors';

function makeBridgeConfig(apiKey = 'nbg_secret_123'): ProviderConfig {
  return {
    id: 'bridge-1',
    kind: 'antigravity-bridge',
    displayName: 'Antigravity Loopback Bridge',
    modelId: 'gemini-2.5-flash-image',
    endpointUrl: 'http://127.0.0.1:4188',
    apiKey,
    enabled: true,
    capabilities: {
      supportsInpaint: true,
      supportsMultiRef: true,
      supportsSeed: true,
      isLocal: true,
    },
    updatedAt: '2026-11-23T00:00:00.000Z',
  };
}

function makeParentNode(overrides: Partial<SpriteNode['generationMeta']> = {}): SpriteNode {
  return {
    id: 'node-parent-1',
    projectId: 'proj-1',
    parentId: null,
    kind: 'generation',
    imageBlobId: 'blob-1',
    sketchSha256: 'a'.repeat(64),
    generationMeta: {
      providerId: 'bridge-1',
      modelId: 'gemini-2.5-flash-image',
      seed: 42,
      adherence: 'balanced',
      promptDelta: 'hero knight',
      compiledPrompt: 'pixel-art hero knight',
      createdAt: '2026-11-23T10:00:00.000Z',
      interactionId: 'int_root_1',
      interactionExpiresAt: '2026-11-23T12:30:00.000Z',
      ...overrides,
    },
  };
}

describe('M10 Antigravity Loopback Bridge & Stateful Chaining', () => {
  it('selects stateful previousInteractionId when valid vs stateless re-anchoring when expired', () => {
    const config = makeBridgeConfig();
    const adapter = new AntigravityBridgeProvider(config);
    const artBible = createDefaultArtBible();
    const validParent = makeParentNode();
    const expiredParent = makeParentNode({
      interactionExpiresAt: '2026-11-23T12:00:30.000Z', // Only 30s TTL remaining (< 60s threshold)
    });
    const nowMs = Date.parse('2026-11-23T12:00:00.000Z');
    const dummyRef = encodeRgbaToPngBytes(new Uint8ClampedArray([255, 0, 0, 255]), 1, 1);

    const validDecision = selectStatefulInteractionChain(validParent, 'bridge-1', nowMs);
    expect(validDecision.usedStatefulChain).toBe(true);
    expect(validDecision.previousInteractionId).toBe('int_root_1');

    const { payload: validPayload } = adapter.buildRequestPayload(
      {
        config,
        artBible,
        sketchRgba: new Uint8ClampedArray(16),
        sketchWidth: 2,
        sketchHeight: 2,
        sketchSha256: 'a'.repeat(64),
        seed: 7,
        adherence: 'balanced',
        promptDelta: 'glowing sword',
        compiledPrompt: 'full compiled prompt',
        variantCount: 1,
        goldenReferenceImages: [{ mimeType: 'image/png', bytes: dummyRef }],
        parentNode: validParent,
      },
      undefined,
      nowMs,
    );
    expect(validPayload.previousInteractionId).toBe('int_root_1');
    expect(validPayload.sketchPngBase64).toBeUndefined();
    expect(validPayload.goldenRefsPngBase64).toBeUndefined();

    const expiredDecision = selectStatefulInteractionChain(expiredParent, 'bridge-1', nowMs);
    expect(expiredDecision.usedStatefulChain).toBe(false);
    expect(expiredDecision.previousInteractionId).toBeUndefined();

    const { payload: expiredPayload } = adapter.buildRequestPayload(
      {
        config,
        artBible,
        sketchRgba: new Uint8ClampedArray(16),
        sketchWidth: 2,
        sketchHeight: 2,
        sketchSha256: 'a'.repeat(64),
        seed: 7,
        adherence: 'balanced',
        promptDelta: 'glowing sword',
        compiledPrompt: 'full compiled prompt',
        variantCount: 1,
        goldenReferenceImages: [{ mimeType: 'image/png', bytes: dummyRef }],
        parentNode: expiredParent,
      },
      undefined,
      nowMs,
    );
    expect(expiredPayload.previousInteractionId).toBeUndefined();
    expect(expiredPayload.sketchPngBase64).toBeTruthy();
    expect(expiredPayload.goldenRefsPngBase64).toHaveLength(1);
  });

  it('redacts bridge session tokens nbg_secret_123 from ProviderErrors and rejects recipe leaks', () => {
    const err401 = classifyProviderError(
      {
        status: 401,
        responseText: 'Rejected token nbg_secret_123 in Authorization header',
      },
      {
        providerId: 'bridge-1',
        providerKind: 'antigravity-bridge',
        endpointUrl: 'http://127.0.0.1:4188',
        secrets: ['nbg_secret_123'],
      },
    );
    expect(err401.message).not.toContain('nbg_secret_123');
    expect(err401.message).toContain('[REDACTED_KEY]');

    const err500 = classifyProviderError(
      {
        status: 500,
        responseText: 'Upstream crashed with bearer nbg_secret_123',
      },
      {
        providerId: 'bridge-1',
        providerKind: 'antigravity-bridge',
        secrets: ['nbg_secret_123'],
      },
    );
    expect(err500.message).not.toContain('nbg_secret_123');

    const project: Project = {
      id: 'proj-1',
      name: 'Leak Guard',
      artBible: createDefaultArtBible(),
      createdAt: '2026-11-23T00:00:00.000Z',
      updatedAt: '2026-11-23T00:00:00.000Z',
    };
    const leakyNode = makeParentNode({ promptDelta: 'secret leak nbg_secret_123' });
    expect(() =>
      buildAssetRecipe({
        project,
        node: leakyNode,
        postProcess: createDefaultPostProcessConfig(),
        filename: 'sprite.png',
        outputWidth: 64,
        outputHeight: 64,
      }),
    ).toThrow(/sensitive key/i);
  });
});
