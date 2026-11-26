import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultArtBible, ProviderConfigSchema } from '../../src/domain/schemas';
import { paintMaskLine } from '../../src/processing/inpaintMask';
import { samplePixelRgba } from '../../src/processing/pixelEditorCore';
import { encodeRgbaToPngBytes, uint8ToBase64 } from '../../src/processing/png';
import type { RgbaBuffer } from '../../src/processing/types';
import { ProviderError } from '../../src/providers/errors';
import {
  buildGeminiInpaintRequest,
  estimateInpaintCost,
  runRegionInpaint,
} from '../../src/providers/inpaintAdapter';

function makeSprite(width: number, height: number): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      data[px] = (x * 19 + 11) % 256;
      data[px + 1] = (y * 23 + 7) % 256;
      data[px + 2] = 60;
      data[px + 3] = 255;
    }
  }
  return { width, height, data };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M31B Region-Masked AI Inpainting Adapter', () => {
  it('builds Gemini multimodal inpaint payload containing original, mask PNGs & ArtBible tokens', () => {
    const bible = {
      ...createDefaultArtBible(),
      palette: ['#1A1C2C', '#FFCD75', '#B13E53'],
      stylePrompt: 'crisp 16-bit dark fantasy knight',
    };
    const payload = buildGeminiInpaintRequest(
      'ORIG_B64',
      'MASK_B64',
      'add glowing golden visor',
      bible,
    );

    const parts = payload.contents[0].parts;
    expect(parts.length).toBe(3);
    const textPart = parts[0] as { text: string };
    expect(textPart.text).toContain('add glowing golden visor');
    expect(textPart.text).toContain('#FFCD75');
    expect(textPart.text).toContain('crisp 16-bit dark fantasy knight');
    expect((parts[1] as { inlineData: { data: string } }).inlineData.data).toBe('ORIG_B64');
    expect((parts[2] as { inlineData: { data: string } }).inlineData.data).toBe('MASK_B64');
  });

  it('runs Offline Mock Mode preserving 100% of unmasked pixels byte-for-byte', async () => {
    const original = makeSprite(8, 8);
    const mask = new Uint8Array(64);
    paintMaskLine(mask, 8, 8, 3, 3, 4, 4, 1);

    const mockProvider = ProviderConfigSchema.parse({
      id: 'offline-mock',
      kind: 'mock',
      displayName: 'Offline Mock',
      modelId: 'nibgrid-procedural-v1',
      endpointUrl: 'local://mock',
      apiKey: '',
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: true,
        isLocal: true,
      },
      updatedAt: new Date().toISOString(),
    });

    expect(estimateInpaintCost('mock').estimatedUsd).toBe(0);
    const res = await runRegionInpaint(
      original,
      mask,
      'glowing visor',
      createDefaultArtBible(),
      mockProvider,
    );
    expect(res.maskedPixels).toBe(2);
    expect(res.costEstimate.estimatedUsd).toBe(0);
    expect(samplePixelRgba(res.buffer, 0, 0)).toEqual(samplePixelRgba(original, 0, 0));
    expect(samplePixelRgba(res.buffer, 7, 7)).toEqual(samplePixelRgba(original, 7, 7));
    expect(samplePixelRgba(res.buffer, 3, 3)).not.toEqual(samplePixelRgba(original, 3, 3));
  });

  it('strips dummy key AIzaSyINPAINT999 completely on HTTP 401 and 429 errors', async () => {
    const dummyKey = 'AIzaSyINPAINT999';
    const original = makeSprite(8, 8);
    const mask = new Uint8Array(64);
    mask[0] = 1;

    const geminiCfg = ProviderConfigSchema.parse({
      id: 'gemini-byok',
      kind: 'gemini',
      displayName: 'Gemini Image',
      modelId: 'gemini-2.5-flash-image',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: dummyKey,
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    });

    for (const status of [401, 429]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(`API key not valid: ${dummyKey}`, { status }),
      );

      let caught: unknown;
      try {
        await runRegionInpaint(original, mask, 'fix blade', createDefaultArtBible(), geminiCfg);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      const err = caught as ProviderError;
      expect(err.message).not.toContain(dummyKey);
      expect(err.remediation).not.toContain(dummyKey);
      expect(err.code).toBe(status === 401 ? 'UNAUTHORIZED' : 'RATE_LIMITED');
    }
  });

  it('composites mocked Gemini PNG response onto strictly masked region only', async () => {
    const original = makeSprite(8, 8);
    const mask = new Uint8Array(64);
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        mask[y * 8 + x] = 1;
      }
    }

    // Returned AI image fills entire 8x8 with bright gold #FFCD75
    const aiRgba = new Uint8ClampedArray(8 * 8 * 4);
    for (let i = 0; i < 64; i++) {
      aiRgba[i * 4] = 255;
      aiRgba[i * 4 + 1] = 205;
      aiRgba[i * 4 + 2] = 117;
      aiRgba[i * 4 + 3] = 255;
    }
    const aiPng = encodeRgbaToPngBytes(aiRgba, 8, 8);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: uint8ToBase64(aiPng),
                    },
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const geminiCfg = ProviderConfigSchema.parse({
      id: 'gemini-byok',
      kind: 'gemini',
      displayName: 'Gemini Image',
      modelId: 'gemini-2.5-flash-image',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaSyINPAINT999',
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    });

    const out = await runRegionInpaint(
      original,
      mask,
      'add glowing visor',
      createDefaultArtBible(),
      geminiCfg,
    );

    // Center replaced with Gemini gold; all corners strictly untouched from original
    expect(samplePixelRgba(out.buffer, 3, 3)).toEqual([255, 205, 117, 255]);
    expect(samplePixelRgba(out.buffer, 0, 0)).toEqual(samplePixelRgba(original, 0, 0));
    expect(samplePixelRgba(out.buffer, 7, 7)).toEqual(samplePixelRgba(original, 7, 7));
  });
});
