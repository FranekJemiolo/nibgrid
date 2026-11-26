import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultArtBible, type ProviderConfig } from '../../src/domain/schemas';

const MOCK_PROVIDER: ProviderConfig = {
  id: 'mock-1',
  kind: 'mock',
  displayName: 'Offline Mock',
  modelId: 'mock-pixel-v1',
  endpointUrl: '',
  apiKey: '',
  enabled: true,
  capabilities: {
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: true,
    isLocal: true,
  },
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const GEMINI_BASE_PROVIDER: ProviderConfig = {
  id: 'gemini-1',
  kind: 'gemini',
  displayName: 'Google Gemini Image',
  modelId: 'gemini-2.5-flash-image',
  endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
  apiKey: '',
  enabled: true,
  capabilities: {
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: false,
    isLocal: false,
  },
  updatedAt: '2026-01-01T00:00:00.000Z',
};
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import { createPoseClipFromPreset } from '../../src/processing/posePresets';
import type { RgbaBuffer } from '../../src/processing/types';
import { ProviderError } from '../../src/providers/errors';
import {
  buildGeminiPoseStripRequest,
  buildGeminiSingleFrameRerollRequest,
  generatePoseSpriteCycle,
  regenerateSinglePoseFrame,
} from '../../src/providers/poseAnimationAdapter';

function makeGoldenRefSprite(w = 64, h = 64): RgbaBuffer {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 16; y < 56; y++) {
    for (let x = 20; x < 44; x++) {
      const idx = (y * w + x) * 4;
      data[idx] = 177;
      data[idx + 1] = 62;
      data[idx + 2] = 83;
      data[idx + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

describe('M34B Pose-to-Sprite Adapter, Offline Mock & Key Redaction', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buildGeminiPoseStripRequest attaches both Golden Reference & OpenPose strip inlineData and ArtBible tokens', () => {
    const bible = createDefaultArtBible();
    const clip = createPoseClipFromPreset('run_6f', 64, 64);
    const payload = buildGeminiPoseStripRequest('REF_B64', 'OPENPOSE_B64', clip, bible);

    const parts = payload.contents[0]!.parts as Array<{
      inlineData?: { mimeType: string; data: string };
      text?: string;
    }>;
    expect(parts.length).toBe(3);
    expect(parts[0]!.inlineData?.data).toBe('REF_B64');
    expect(parts[1]!.inlineData?.data).toBe('OPENPOSE_B64');
    expect(parts[2]!.text).toContain('1x6');
    expect(parts[2]!.text).toContain(bible.artMode);
    expect(parts[2]!.text).toContain('#FF00FF');

    const reroll = buildGeminiSingleFrameRerollRequest('REF_B64', 'PREV_B64', 'POSE_B64', bible);
    const rerollParts = reroll.contents[0]!.parts as Array<{
      inlineData?: { mimeType: string; data: string };
      text?: string;
    }>;
    expect(rerollParts.length).toBe(4);
    expect(rerollParts[1]!.inlineData?.data).toBe('PREV_B64');
    expect(rerollParts[2]!.inlineData?.data).toBe('POSE_B64');
  });

  it('generates 6 aligned non-empty 64x64 frames in Offline Mock Mode ($0.00) and supports single-frame re-roll', async () => {
    const bible = createDefaultArtBible();
    const clip = createPoseClipFromPreset('run_6f', 64, 64);
    const refSprite = makeGoldenRefSprite(64, 64);

    const res = await generatePoseSpriteCycle(refSprite, clip, bible, MOCK_PROVIDER, {
      lockPalette: true,
    });
    expect(res.costEstimate.estimatedUsd).toBe(0);
    expect(res.frames.length).toBe(6);
    expect(res.openPoseStrip.width).toBe(384);
    expect(res.generatedStrip.width).toBe(384);

    for (const frame of res.frames) {
      expect(frame.width).toBe(64);
      expect(frame.height).toBe(64);
      let opaque = 0;
      for (let i = 3; i < frame.data.length; i += 4) {
        if ((frame.data[i] ?? 0) > 0) opaque++;
      }
      expect(opaque).toBeGreaterThan(20);
    }

    const rerolled = await regenerateSinglePoseFrame(
      refSprite,
      res.frames[2]!,
      clip.frames[3]!,
      64,
      64,
      bible,
      MOCK_PROVIDER,
    );
    expect(rerolled.width).toBe(64);
    expect(rerolled.height).toBe(64);
  });

  it('strips API key AIzaSyPOSE999 completely from thrown ProviderError on HTTP 401 and 429', async () => {
    const secret = 'AIzaSyPOSE999';
    const bible = createDefaultArtBible();
    const clip = createPoseClipFromPreset('run_6f', 64, 64);
    const gemini = { ...GEMINI_BASE_PROVIDER, apiKey: secret, enabled: true };
    const refSprite = makeGoldenRefSprite(64, 64);

    for (const status of [401, 429]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: { message: `Invalid key ${secret} at ?key=${secret}` },
          }),
          { status, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      let caught: unknown;
      try {
        await generatePoseSpriteCycle(refSprite, clip, bible, gemini);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      const pe = caught as ProviderError;
      expect(pe.message).not.toContain(secret);
      expect(JSON.stringify(pe)).not.toContain(secret);
    }

    // Verify happy Gemini path slices returned strip PNG cleanly
    const mockStripPng = encodeRgbaToPngBytes(
      (await generatePoseSpriteCycle(refSprite, clip, bible, MOCK_PROVIDER)).generatedStrip.data,
      384,
      64,
    );
    let binary = '';
    for (const b of mockStripPng) binary += String.fromCharCode(b);
    const b64 = btoa(binary);

    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const liveRes = await generatePoseSpriteCycle(refSprite, clip, bible, gemini);
    expect(liveRes.frames.length).toBe(6);
  });
});
