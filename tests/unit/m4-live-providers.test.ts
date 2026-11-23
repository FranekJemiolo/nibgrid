import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compilePrompt } from '../../src/domain/promptCompiler';
import { createDefaultArtBible, type ProviderConfig } from '../../src/domain/schemas';
import {
  base64ToUint8,
  decodePngBytesToRgba,
  encodeRgbaToPngBytes,
} from '../../src/processing/png';
import {
  ADHERENCE_DENOISE_WEIGHTS,
  DEFAULT_COMFYUI_WORKFLOW_TEMPLATE,
  injectComfyUiWorkflow,
} from '../../src/providers/comfyuiWorkflows';
import { classifyProviderError, redactSecrets } from '../../src/providers/errors';
import {
  buildGeminiGeneratePayload,
  buildGeminiInpaintPayload,
} from '../../src/providers/geminiProvider';

function makeGeminiConfig(): ProviderConfig {
  return {
    id: 'gem-1',
    kind: 'gemini',
    displayName: 'Gemini BYOK',
    modelId: 'gemini-2.5-flash-image',
    endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'AIzaSyTESTKEY123',
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

describe('M4 PNG Round-Trip & Live Provider Payload Builders', () => {
  it('decodes both uncompressed and zlib-compressed PNG fixtures accurately', async () => {
    const rawFixture = new Uint8Array(
      readFileSync(resolve(process.cwd(), 'tests/e2e/fixtures/golden-ref.png')),
    );
    const decoded = await decodePngBytesToRgba(rawFixture);
    expect(decoded.width).toBe(32);
    expect(decoded.height).toBe(32);
    expect(decoded.rgba.length).toBe(32 * 32 * 4);
    expect(decoded.rgba[3]).toBe(255);
  });

  it('serializes sketch + Golden References into Gemini inlineData parts with compiled Art Bible rules', async () => {
    const bible = {
      ...createDefaultArtBible(),
      projection: 'top-down' as const,
      palette: ['#1A1C2C', '#B13E53', '#FFCD75'],
    };
    const compiled = compilePrompt(bible, {
      adherence: 'strict',
      promptDelta: 'crimson cape',
    });

    const sketchRgba = new Uint8ClampedArray(16 * 16 * 4).fill(255);
    sketchRgba[0] = 0;
    sketchRgba[1] = 0;
    sketchRgba[2] = 0;

    const ref1 = encodeRgbaToPngBytes(new Uint8ClampedArray(8 * 8 * 4).fill(120), 8, 8);
    const ref2 = encodeRgbaToPngBytes(new Uint8ClampedArray(8 * 8 * 4).fill(200), 8, 8);

    const payload = buildGeminiGeneratePayload({
      config: makeGeminiConfig(),
      artBible: bible,
      sketchRgba,
      sketchWidth: 16,
      sketchHeight: 16,
      sketchSha256: 'a'.repeat(64),
      seed: 101,
      adherence: 'strict',
      promptDelta: 'crimson cape',
      compiledPrompt: compiled.fullCompiledPrompt,
      variantCount: 1,
      goldenReferenceImages: [
        { mimeType: 'image/png', bytes: ref1 },
        { mimeType: 'image/png', bytes: ref2 },
      ],
    });

    expect(payload.generationConfig.responseModalities).toEqual(['IMAGE']);
    const parts = payload.contents[0].parts;
    // 1 text prompt + 1 sketch PNG + 2 Golden References = 4 parts
    expect(parts).toHaveLength(4);
    expect('text' in parts[0]!).toBe(true);
    if ('text' in parts[0]!) {
      expect(parts[0]!.text).toContain('top-down');
      expect(parts[0]!.text).toContain('crimson cape');
    }

    const sketchPart = parts[1]!;
    expect('inlineData' in sketchPart).toBe(true);
    if ('inlineData' in sketchPart) {
      const decodedSketch = await decodePngBytesToRgba(base64ToUint8(sketchPart.inlineData.data));
      expect(decodedSketch.width).toBe(16);
      expect(decodedSketch.height).toBe(16);
    }

    // Inpaint builder includes base image + mask + Golden Refs
    const mask = new Uint8Array(16 * 16);
    mask[0] = 1;
    const inpaintPayload = buildGeminiInpaintPayload({
      config: makeGeminiConfig(),
      artBible: bible,
      sketchRgba,
      baseImageRgba: sketchRgba,
      mask,
      sketchWidth: 16,
      sketchHeight: 16,
      sketchSha256: 'a'.repeat(64),
      seed: 101,
      adherence: 'strict',
      promptDelta: 'golden visor',
      compiledPrompt: compiled.fullCompiledPrompt,
      variantCount: 1,
      goldenReferenceImages: [{ mimeType: 'image/png', bytes: ref1 }],
    });
    expect(inpaintPayload.contents[0].parts).toHaveLength(4);
  });

  it('injects ComfyUI workflow tokens and denoise weights without mutating base template', () => {
    const beforeSnapshot = JSON.stringify(DEFAULT_COMFYUI_WORKFLOW_TEMPLATE);

    const injectedStrict = injectComfyUiWorkflow({
      prompt: 'pixel-art knight',
      negativePrompt: 'drop shadow',
      seed: 4242,
      adherence: 'strict',
      sketchFilename: 'sketch_01.png',
    });

    expect(injectedStrict.denoise).toBe(ADHERENCE_DENOISE_WEIGHTS.strict);
    expect(injectedStrict.denoise).toBe(0.55);
    expect(injectedStrict.prompt['2']?.inputs.image).toBe('sketch_01.png');
    expect(injectedStrict.prompt['4']?.inputs.text).toBe('pixel-art knight');
    expect(injectedStrict.prompt['5']?.inputs.text).toBe('drop shadow');
    expect(injectedStrict.prompt['6']?.inputs.seed).toBe(4242);
    expect(injectedStrict.prompt['6']?.inputs.denoise).toBe(0.55);

    const injectedBalanced = injectComfyUiWorkflow({
      prompt: 'balanced sprite',
      negativePrompt: 'watermark',
      seed: 99,
      adherence: 'balanced',
      sketchFilename: 'sketch_02.png',
    });
    expect(injectedBalanced.prompt['6']?.inputs.denoise).toBe(0.72);

    const injectedLoose = injectComfyUiWorkflow({
      prompt: 'loose sprite',
      negativePrompt: 'text',
      seed: 12,
      adherence: 'loose',
      sketchFilename: 'sketch_03.png',
    });
    expect(injectedLoose.prompt['6']?.inputs.denoise).toBe(0.88);

    // Base template must remain completely untouched
    expect(JSON.stringify(DEFAULT_COMFYUI_WORKFLOW_TEMPLATE)).toBe(beforeSnapshot);
  });

  it('classifies 401, 429, 500, and ComfyUI CORS failures while redacting API keys', () => {
    const secret = 'AIzaSyTESTKEY123';
    expect(redactSecrets(`Bad key ${secret} in URL ?key=${secret}`, [secret])).not.toContain(
      secret,
    );

    const err401 = classifyProviderError(
      { status: 401, responseText: `Rejected token ${secret}` },
      { providerId: 'gem-1', providerKind: 'gemini', secrets: [secret] },
    );
    expect(err401.code).toBe('UNAUTHORIZED');
    expect(err401.message).not.toContain(secret);
    expect(err401.remediation).not.toContain(secret);

    const err429 = classifyProviderError(
      { status: 429, responseText: 'Quota exceeded' },
      { providerId: 'gem-1', providerKind: 'gemini', secrets: [secret] },
    );
    expect(err429.code).toBe('RATE_LIMITED');
    expect(err429.retryable).toBe(true);

    const err500 = classifyProviderError(
      { status: 500, responseText: 'Internal Server Error' },
      { providerId: 'gem-1', providerKind: 'gemini', secrets: [secret] },
    );
    expect(err500.code).toBe('SERVER_ERROR');

    const errCors = classifyProviderError(new TypeError('Failed to fetch'), {
      providerId: 'comfy-1',
      providerKind: 'comfyui',
      endpointUrl: 'http://127.0.0.1:8188',
    });
    expect(errCors.code).toBe('CORS_OR_OFFLINE');
    expect(errCors.remediation).toContain('--enable-cors-header');
    expect(errCors.message).toContain('--enable-cors-header');
  });
});
