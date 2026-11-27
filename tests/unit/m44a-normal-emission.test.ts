import { describe, expect, it } from 'vitest';
import {
  bakeEmissionMaskFromRgba,
  bakeNormalMapFromRgba,
  createDefaultEmissionBakeConfig,
  createDefaultNormalBakeConfig,
} from '../../src/processing/normalEmissionBaker';

function makeSolidSquare(
  size: number,
  r: number,
  g: number,
  b: number,
  a = 255,
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  return buf;
}

describe('M44A: Pure-TS Normal Map & Emission Mask Baker', () => {
  it('encodes exact neutral normal (128, 128, 255, 255) across interior of solid 16x16 square', () => {
    const size = 16;
    const square = makeSolidSquare(size, 120, 140, 160, 255);
    const baked = bakeNormalMapFromRgba(square, size, size, {
      ...createDefaultNormalBakeConfig(),
      bevelRadiusPx: 2,
      heightSource: 'hybrid',
    });

    for (let y = 4; y <= 11; y++) {
      for (let x = 4; x <= 11; x++) {
        const idx = (y * size + x) * 4;
        expect(Array.from(baked.slice(idx, idx + 4))).toEqual([128, 128, 255, 255]);
      }
    }
  });

  it('maintains unit normal length (0.98 <= ||N|| <= 1.02), writes neutral (128, 128, 255, 0) on transparent pixels, and respects invertY', () => {
    const size = 16;
    const buf = new Uint8ClampedArray(size * size * 4);

    // 10x10 beveled/lit block inside transparent 3px border
    for (let y = 3; y <= 12; y++) {
      for (let x = 3; x <= 12; x++) {
        const idx = (y * size + x) * 4;
        const shade = Math.min(255, 60 + x * 10 + y * 12);
        buf[idx] = shade;
        buf[idx + 1] = shade;
        buf[idx + 2] = shade;
        buf[idx + 3] = 255;
      }
    }

    const opengl = bakeNormalMapFromRgba(buf, size, size, {
      strength: 2.0,
      bevelRadiusPx: 3,
      invertY: false,
      heightSource: 'hybrid',
      sharpenPixelArt: true,
    });
    const directx = bakeNormalMapFromRgba(buf, size, size, {
      strength: 2.0,
      bevelRadiusPx: 3,
      invertY: true,
      heightSource: 'hybrid',
      sharpenPixelArt: true,
    });

    let yFlippedCount = 0;

    for (let i = 0; i < size * size; i++) {
      const idx = i * 4;
      const srcAlpha = buf[idx + 3]!;
      if (srcAlpha === 0) {
        expect(Array.from(opengl.slice(idx, idx + 4))).toEqual([128, 128, 255, 0]);
        expect(Array.from(directx.slice(idx, idx + 4))).toEqual([128, 128, 255, 0]);
      } else {
        const nx = (opengl[idx]! - 128) / 127;
        const ny = (opengl[idx + 1]! - 128) / 127;
        const nz = (opengl[idx + 2]! - 128) / 127;
        const mag = Math.hypot(nx, ny, nz);
        expect(mag).toBeGreaterThanOrEqual(0.98);
        expect(mag).toBeLessThanOrEqual(1.02);
        expect(opengl[idx + 3]).toBe(255);

        if (opengl[idx + 1]! > 132 && directx[idx + 1]! < 124) {
          yFlippedCount++;
        }
      }
    }

    expect(yFlippedCount).toBeGreaterThan(5);
  });

  it('isolates #00ffcc eye pixels with zero false positives and supports luminance-threshold mode', () => {
    const size = 8;
    const sprite = new Uint8ClampedArray(size * size * 4);

    // Paint dark armor body on [2..5, 2..5] (#1a1c2c)
    for (let y = 2; y <= 5; y++) {
      for (let x = 2; x <= 5; x++) {
        const idx = (y * size + x) * 4;
        sprite[idx] = 0x1a;
        sprite[idx + 1] = 0x1c;
        sprite[idx + 2] = 0x2c;
        sprite[idx + 3] = 255;
      }
    }

    // Paint 2 glowing #00ffcc eyes at (3,3) and (4,3)
    for (const ex of [3, 4]) {
      const idx = (3 * size + ex) * 4;
      sprite[idx] = 0x00;
      sprite[idx + 1] = 0xff;
      sprite[idx + 2] = 0xcc;
      sprite[idx + 3] = 255;
    }

    const swatchResult = bakeEmissionMaskFromRgba(sprite, size, size, {
      ...createDefaultEmissionBakeConfig(),
      mode: 'palette-swatches',
      emissiveHexColors: ['#00ffcc'],
      colorTolerance: 4,
    });

    expect(swatchResult.emissivePixelCount).toBe(2);
    const eyeIdx = (3 * size + 3) * 4;
    const bodyIdx = (2 * size + 2) * 4;
    const bgIdx = 0;

    expect(Array.from(swatchResult.rgba.slice(eyeIdx, eyeIdx + 4))).toEqual([
      0x00, 0xff, 0xcc, 255,
    ]);
    expect(Array.from(swatchResult.rgba.slice(bodyIdx, bodyIdx + 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(swatchResult.rgba.slice(bgIdx, bgIdx + 4))).toEqual([0, 0, 0, 0]);

    const lumResult = bakeEmissionMaskFromRgba(sprite, size, size, {
      ...createDefaultEmissionBakeConfig(),
      mode: 'luminance-threshold',
      minLuminance: 0.7,
      minSaturation: 0.5,
    });
    expect(lumResult.emissivePixelCount).toBe(2);
  });
});
