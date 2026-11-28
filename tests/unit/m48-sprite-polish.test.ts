import { describe, expect, it } from 'vitest';
import {
  evaluateSpriteQuality,
  runWithSilentQualityGate,
  selectStyleLockAnchors,
} from '../../src/ai/styleLockGate';
import { createDefaultPostProcessConfig, type SpriteNode } from '../../src/domain/schemas';
import {
  measureFrameAnchor,
  stabilizeAnimationStrip,
  type RgbaFrame,
} from '../../src/processing/frameStabilizer';
import {
  detectPixelGridScale,
  quantizeToArtBibleOklab,
  runAutoPixelPolishPipeline,
  stripOrphanPixels,
} from '../../src/processing/pixelPolish';

function makeRgba(w: number, h: number): Uint8ClampedArray {
  return new Uint8ClampedArray(w * h * 4);
}

function setPx(
  buf: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): void {
  const i = (y * w + x) * 4;
  buf[i] = r;
  buf[i + 1] = g;
  buf[i + 2] = b;
  buf[i + 3] = a;
}

function fillRect(
  buf: Uint8ClampedArray,
  w: number,
  rx: number,
  ry: number,
  rw: number,
  rh: number,
  r: number,
  g: number,
  b: number,
): void {
  for (let y = ry; y < ry + rh; y++) {
    for (let x = rx; x < rx + rw; x++) {
      setPx(buf, w, x, y, r, g, b, 255);
    }
  }
}

describe('M48: Pure-TS Sprite Polish, Frame Stabilizer & Silent Quality Gate', () => {
  it('detects exact 4x pixel-grid scale on a synthetic 4x upscaled pixel sprite', () => {
    const baseW = 8;
    const baseH = 8;
    const baseColors = [
      [0, 0, 0, 0],
      [26, 28, 44, 255],
      [177, 62, 83, 255],
      [255, 205, 117, 255],
    ] as const;

    const scale = 4;
    const w = baseW * scale;
    const h = baseH * scale;
    const buf = makeRgba(w, h);

    for (let by = 1; by < baseH - 1; by++) {
      for (let bx = 1; bx < baseW - 1; bx++) {
        const c = baseColors[((bx * 3 + by * 5) % 3) + 1]!;
        fillRect(buf, w, bx * scale, by * scale, scale, scale, c[0], c[1], c[2]);
      }
    }

    expect(detectPixelGridScale(buf, w, h)).toBe(4);
  });

  it('quantizes opaque pixels strictly to ArtBible swatches in OKLab while keeping alpha=0 intact', () => {
    const w = 6;
    const h = 6;
    const palette = ['#1A1C2C', '#B13E53', '#FFCD75'] as const;
    const allowedHex = new Set<string>(palette);
    const buf = makeRgba(w, h);
    fillRect(buf, w, 1, 1, 4, 4, 182, 66, 80); // noisy reddish pixel

    const quantized = quantizeToArtBibleOklab(buf, w, h, palette, { dither: 'none' });

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const a = quantized[i + 3]!;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
          expect(a).toBe(0);
          expect(quantized[i]).toBe(0);
        } else {
          expect(a).toBe(255);
          const hex = `#${quantized[i]!.toString(16).padStart(2, '0').toUpperCase()}${quantized[i + 1]!.toString(16).padStart(2, '0').toUpperCase()}${quantized[i + 2]!.toString(16).padStart(2, '0').toUpperCase()}`;
          expect(allowedHex.has(hex)).toBe(true);
        }
      }
    }
  });

  it('strips isolated 1px orphan noise speckles without eroding 2x2 features', () => {
    const w = 10;
    const h = 10;
    const buf = makeRgba(w, h);
    fillRect(buf, w, 2, 2, 2, 2, 255, 205, 117); // solid 2x2 eye/feature
    setPx(buf, w, 7, 7, 255, 0, 255); // isolated 1px speckle

    const cleaned = stripOrphanPixels(buf, w, h, 2);
    expect(cleaned[(7 * w + 7) * 4 + 3]).toBe(0);
    expect(cleaned[(2 * w + 2) * 4 + 3]).toBe(255);
    expect(cleaned[(3 * w + 3) * 4 + 3]).toBe(255);

    const pipelineRes = runAutoPixelPolishPipeline(buf, w, h, ['#1A1C2C', '#FFCD75']);
    expect(pipelineRes.strippedPixels).toBeGreaterThanOrEqual(1);
    expect(pipelineRes.data[(7 * w + 7) * 4 + 3]).toBe(0);
  });

  it('stabilizes misaligned animation frames to identical bottomY baseline (delta === 0)', () => {
    const w = 24;
    const h = 24;
    const placements = [
      { x: 4, y: 8 },
      { x: 10, y: 12 },
      { x: 14, y: 5 },
      { x: 7, y: 15 },
    ] as const;

    const frames: RgbaFrame[] = placements.map((pos) => {
      const data = makeRgba(w, h);
      fillRect(data, w, pos.x, pos.y, 4, 6, 177, 62, 83);
      return { width: w, height: h, data };
    });

    const aligned = stabilizeAnimationStrip(frames, 'bottom-center');
    const bottoms = aligned.map((f) => measureFrameAnchor(f, 'bottom-center').maxY);
    const baseline = bottoms[0]!;
    for (const b of bottoms) {
      expect(b - baseline).toBe(0);
    }
  });

  it('auto-attaches Golden Reference + up to 2 approved sprites and silently re-rolls once on quality drift', async () => {
    const fakeNode = (id: string, blobId: string): SpriteNode => ({
      id,
      projectId: 'p1',
      parentId: 'root',
      kind: 'generation',
      imageBlobId: blobId,
      sketchSha256: 'a'.repeat(64),
      postProcessConfig: createDefaultPostProcessConfig(32, 32),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'mock',
        seed: 1,
        adherence: 'balanced',
        promptDelta: 'hero',
        compiledPrompt: 'hero',
        createdAt: new Date().toISOString(),
      },
    });

    const anchors = selectStyleLockAnchors(
      ['gold-1'],
      [fakeNode('n1', 'blob-a'), fakeNode('n2', 'blob-b'), fakeNode('n3', 'blob-c')],
      2,
    );
    expect(anchors).toEqual(['gold-1', 'blob-c', 'blob-b']);

    const bad = makeRgba(8, 8);
    fillRect(bad, 8, 2, 2, 4, 4, 0, 255, 0); // green drift
    const good = makeRgba(8, 8);
    fillRect(good, 8, 2, 2, 4, 4, 26, 28, 44); // exact #1A1C2C

    let calls = 0;
    const gated = await runWithSilentQualityGate(
      async (attempt) => {
        calls++;
        return attempt === 0 ? bad : good;
      },
      (buf) => evaluateSpriteQuality(buf, 8, 8, ['#1A1C2C', '#FFCD75']),
      1,
    );

    expect(calls).toBe(2);
    expect(gated.rerolled).toBe(true);
    expect(gated.metrics.passed).toBe(true);
  });
});
