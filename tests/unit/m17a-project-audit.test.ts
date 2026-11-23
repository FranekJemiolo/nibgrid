import { describe, expect, it } from 'vitest';
import { normalizeLufsPcm } from '../../src/audio/pcmPostProcess';
import type { PcmBuffer } from '../../src/audio/types';
import { createDefaultArtBible } from '../../src/domain/schemas';
import {
  auditAudioAsset,
  auditSpriteAsset,
  computeArtBibleHash,
  sha256HexSync,
  summarizeProjectAudit,
} from '../../src/processing/projectAudit';
import type { RgbaBuffer } from '../../src/processing/types';

function makeSolidSprite(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

function makeUpscaledCheckerboard2x(width = 32, height = 32): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bx = Math.floor(x / 2);
      const by = Math.floor(y / 2);
      const bright = (bx + by) % 2 === 0;
      const idx = (y * width + x) * 4;
      data[idx] = bright ? 244 : 26;
      data[idx + 1] = bright ? 244 : 28;
      data[idx + 2] = bright ? 244 : 44;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data };
}

function makeSinePcm(amplitude: number, durationSec = 0.5, sampleRate = 22050): PcmBuffer {
  const count = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * 330 * i) / sampleRate);
  }
  return { sampleRate, channels: 1, samples };
}

describe('M17A Pure-TS Project Audit Engine & Art Bible Sync Hashing', () => {
  it('computes deterministic SHA-256 and flags off-palette pixels vs clean 1x sprites', () => {
    expect(sha256HexSync('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );

    const artBible = createDefaultArtBible();
    const hash = computeArtBibleHash(artBible);

    // Clean 1x sprite using exact palette color '#F4F4F4' (244, 244, 244)
    const clean = makeSolidSprite(16, 16, 244, 244, 244);
    const cleanRow = auditSpriteAsset({
      nodeId: 'sprite-clean',
      name: 'Clean Hero',
      processedBuffer: clean,
      artMode: 'pixel-art',
      artBiblePaletteHex: artBible.palette,
      currentArtBibleHash: hash,
      nodeArtBibleHash: hash,
      hasCollider: true,
    });

    expect(cleanRow.checks.find((c) => c.checkId === 'palette')?.severity).toBe('pass');
    expect(cleanRow.checks.find((c) => c.checkId === 'mixel')?.severity).toBe('pass');
    expect(cleanRow.worstSeverity).toBe('pass');

    // Pollute 10% of opaque pixels with off-palette magenta (#12AB34)
    const polluted = makeSolidSprite(16, 16, 244, 244, 244);
    for (let i = 0; i < 26; i++) {
      polluted.data[i * 4] = 0x12;
      polluted.data[i * 4 + 1] = 0xab;
      polluted.data[i * 4 + 2] = 0x34;
    }
    const failRow = auditSpriteAsset({
      nodeId: 'sprite-drift',
      name: 'Off-Palette Knight',
      processedBuffer: polluted,
      artMode: 'pixel-art',
      artBiblePaletteHex: artBible.palette,
      currentArtBibleHash: hash,
      nodeArtBibleHash: hash,
      hasCollider: true,
    });
    const palCheck = failRow.checks.find((c) => c.checkId === 'palette');
    expect(palCheck?.severity).toBe('fail');
    expect(palCheck?.autoFixable).toBe(true);
  });

  it('flags 2x upscaled checkerboard sprites as mixel fail in pixel-art mode and skips in hd-2d', () => {
    const checker2x = makeUpscaledCheckerboard2x(32, 32);
    const artBible = createDefaultArtBible();
    const hash = computeArtBibleHash(artBible);

    const pixelRow = auditSpriteAsset({
      nodeId: 'sprite-mixel',
      name: 'Mixel Slime',
      processedBuffer: checker2x,
      artMode: 'pixel-art',
      artBiblePaletteHex: artBible.palette,
      currentArtBibleHash: hash,
      hasCollider: true,
    });
    expect(pixelRow.checks.find((c) => c.checkId === 'mixel')?.severity).toBe('fail');

    const hdRow = auditSpriteAsset({
      nodeId: 'sprite-hd',
      name: 'HD Boss',
      processedBuffer: checker2x,
      artMode: 'hd-2d',
      artBiblePaletteHex: artBible.palette,
      currentArtBibleHash: hash,
      hasCollider: true,
    });
    expect(hdRow.checks.find((c) => c.checkId === 'mixel')).toBeUndefined();
  });

  it('detects stale Art Bible hashes and summarizes readiness score accurately', () => {
    const bibleV1 = createDefaultArtBible();
    const hashV1 = computeArtBibleHash(bibleV1);
    const bibleV2 = {
      ...bibleV1,
      palette: ['#000000', ...bibleV1.palette.slice(1)],
    };
    const hashV2 = computeArtBibleHash(bibleV2);
    expect(hashV2).not.toBe(hashV1);

    const sprite = makeSolidSprite(16, 16, 244, 244, 244);
    const staleRow = auditSpriteAsset({
      nodeId: 'sprite-stale',
      name: 'Stale Cat',
      processedBuffer: sprite,
      artMode: 'pixel-art',
      artBiblePaletteHex: bibleV2.palette,
      currentArtBibleHash: hashV2,
      nodeArtBibleHash: hashV1,
      hasCollider: false,
    });

    expect(staleRow.isStale).toBe(true);
    expect(staleRow.checks.find((c) => c.checkId === 'recipeSync')?.severity).toBe('warn');
    expect(staleRow.checks.find((c) => c.checkId === 'collider')?.severity).toBe('warn');

    const report = summarizeProjectAudit([staleRow]);
    expect(report.staleCount).toBe(1);
    expect(report.warnCount).toBe(1);
    expect(report.readinessScore).toBeLessThan(100);
    expect(report.readinessScore).toBeGreaterThan(50);
  });

  it('audits quiet -24 LUFS vs normalized -14 LUFS audio clips accurately', () => {
    const quietRow = auditAudioAsset({
      assetId: 'sfx-quiet',
      name: 'Quiet Sword Swing',
      category: 'sfx',
      measuredLufs: -24.0,
    });
    expect(quietRow.checks[0]?.severity).toBe('fail');
    expect(quietRow.checks[0]?.autoFixable).toBe(true);

    const normalized = normalizeLufsPcm(makeSinePcm(0.05), -14, -1.0).buffer;
    const cleanRow = auditAudioAsset({
      assetId: 'sfx-clean',
      name: 'Clean Sword Swing',
      category: 'sfx',
      pcm: normalized,
    });
    expect(cleanRow.checks[0]?.severity).toBe('pass');
  });
});
