import { describe, expect, it } from 'vitest';
import { bakeNormalMapCpu } from '../../src/processing/distanceField';
import {
  computeSeamContinuity,
  flattenMacroLighting,
  generateCrossSeamMask,
  wrapOffsetBuffer,
} from '../../src/processing/seamlessTile';
import type { RgbaBuffer } from '../../src/processing/types';

function makePatternBuffer(width: number, height: number): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      data[i] = (x * 13 + y * 7) % 256;
      data[i + 1] = (x * 5 + y * 19) % 256;
      data[i + 2] = (x * 29 + y * 3) % 256;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('M12A Seamless Tile 50% Wrap-Offset, Auto-Mask & Continuity', () => {
  it('inverts forward + inverse wrapOffsetBuffer byte-for-byte on even (64x64) and odd (63x65) buffers', () => {
    for (const [w, h] of [
      [64, 64],
      [63, 65],
    ] as const) {
      const src = makePatternBuffer(w, h);
      const wrapped = wrapOffsetBuffer(src);
      expect(wrapped.width).toBe(w);
      expect(wrapped.height).toBe(h);
      // Forward wrap visibly shifts coordinates
      expect(Array.from(wrapped.data)).not.toEqual(Array.from(src.data));

      const restored = wrapOffsetBuffer(wrapped, Math.floor(w / 2), Math.floor(h / 2), true);
      expect(Array.from(restored.data)).toEqual(Array.from(src.data));
    }
  });

  it('locks 100% of outer 2px border, masks center cross, and honors tileY=false', () => {
    const w = 64;
    const h = 64;
    const maskBoth = generateCrossSeamMask(w, h, {
      seamWidthPx: 20,
      jitterPx: 6,
      tileX: true,
      tileY: true,
      seed: 42,
    });

    // Outer 2px perimeter must contain zero masked pixels (0)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < 2 || x >= w - 2 || y < 2 || y >= h - 2) {
          const v = maskBoth.data[(y * w + x) * 4];
          expect(v).toBe(0);
        }
      }
    }

    // Center pixel must be masked (255)
    const centerIdx = (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
    expect(maskBoth.data[centerIdx]).toBe(255);

    // Disabling tileY leaves horizontal wing outside vertical seam band unmasked
    const maskXOnly = generateCrossSeamMask(w, h, {
      seamWidthPx: 16,
      jitterPx: 0,
      tileX: true,
      tileY: false,
      seed: 42,
    });
    const farLeftCenterIdx = (Math.floor(h / 2) * w + 6) * 4;
    expect(maskBoth.data[farLeftCenterIdx]).toBe(255);
    expect(maskXOnly.data[farLeftCenterIdx]).toBe(0);
  });

  it('scores toroidal periodic buffers 100 and scores hard-seamed gradients strictly lower', () => {
    const w = 64;
    const h = 64;

    // Periodic cosine pattern wrapping seamlessly across borders
    const periodic = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const val = Math.round(
          128 + 80 * Math.cos((x / (w - 1)) * Math.PI * 2) * Math.cos((y / (h - 1)) * Math.PI * 2),
        );
        const i = (y * w + x) * 4;
        periodic[i] = val;
        periodic[i + 1] = val;
        periodic[i + 2] = val;
        periodic[i + 3] = 255;
      }
    }
    const cleanReport = computeSeamContinuity({ width: w, height: h, data: periodic });
    expect(cleanReport.score).toBe(100);

    // Hard left-to-right & top-to-bottom illumination ramp -> heavy border seam
    const ramp = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const val = Math.round(((x + y) / (w + h - 2)) * 255);
        const i = (y * w + x) * 4;
        ramp[i] = val;
        ramp[i + 1] = val;
        ramp[i + 2] = val;
        ramp[i + 3] = 255;
      }
    }
    const seamedReport = computeSeamContinuity({ width: w, height: h, data: ramp });
    expect(seamedReport.score).toBeLessThan(30);

    // High-pass macro lighting flatten suppresses the low-frequency gradient across opposite edges
    const flattened = flattenMacroLighting({ width: w, height: h, data: ramp }, 16);
    const flattenedReport = computeSeamContinuity(flattened);
    expect(flattenedReport.score).toBeGreaterThan(seamedReport.score);
  });

  it('bakes seamless-wrap CPU normal maps without boundary bevel discontinuity', () => {
    const w = 32;
    const h = 32;
    const periodic = makePatternBuffer(w, h);
    const wrappedNorm = bakeNormalMapCpu(periodic, {
      bevelRadiusPx: 8,
      bevelProfile: 'spherical-dome',
      bevelStrength: 2.5,
      detailStrength: 1.5,
      convention: 'opengl',
      seamlessWrap: true,
    });
    // Leftmost/rightmost column derivatives wrap cleanly without clamp spike; pixel (0,16) stays valid normal
    const leftZ = wrappedNorm.data[(16 * w + 0) * 4 + 2] ?? 0;
    expect(leftZ).toBeGreaterThan(128);
  });
});
