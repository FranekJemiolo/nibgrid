import { describe, expect, it } from 'vitest';
import {
  bakeNormalMapCpu,
  computeBevelHeightmap,
  computeExactAlphaEdt,
} from '../../src/processing/distanceField';
import type { RgbaBuffer } from '../../src/processing/types';

function makeCenteredSquare(canvasDim: number, squareDim: number): RgbaBuffer {
  const data = new Uint8ClampedArray(canvasDim * canvasDim * 4);
  const start = Math.floor((canvasDim - squareDim) / 2);
  const end = start + squareDim;

  for (let y = start; y < end; y++) {
    for (let x = start; x < end; x++) {
      const idx = (y * canvasDim + x) * 4;
      data[idx] = 200;
      data[idx + 1] = 140;
      data[idx + 2] = 90;
      data[idx + 3] = 255;
    }
  }
  return { width: canvasDim, height: canvasDim, data };
}

describe('M8 Exact Alpha EDT & Normal Map Baker', () => {
  it('computes exact distance 16 (128 linear height at maxBevelPx=32) at center of 32x32 square in 64x64 canvas', () => {
    const buf = makeCenteredSquare(64, 32);
    const distances = computeExactAlphaEdt(buf, 128);
    expect(distances[0]).toBe(0);
    expect(distances[15 * 64 + 15]).toBe(0);
    // Nearest transparent edge from center (32, 32) is x=48 / y=48 => distance 16
    expect(distances[32 * 64 + 32]).toBe(16);

    const linearHeight = computeBevelHeightmap(buf, {
      maxBevelPx: 32,
      profile: 'linear',
    });
    expect(linearHeight[0]).toBe(0);
    expect(linearHeight[32 * 64 + 32]).toBe(128);

    // Verify exact 4-way reflection symmetry of the 32x32 square [16..47]
    for (let y = 16; y < 48; y++) {
      for (let x = 16; x < 48; x++) {
        expect(linearHeight[y * 64 + x]).toBe(linearHeight[y * 64 + (63 - x)]);
        expect(linearHeight[y * 64 + x]).toBe(linearHeight[(63 - y) * 64 + x]);
      }
    }
  });

  it('handles 100% transparent and 1x1 opaque buffers with zero NaN or Infinity', () => {
    const emptyBuf: RgbaBuffer = {
      width: 16,
      height: 16,
      data: new Uint8ClampedArray(16 * 16 * 4),
    };
    const emptyEdt = computeExactAlphaEdt(emptyBuf);
    const emptyBevel = computeBevelHeightmap(emptyBuf);
    expect(emptyEdt.every((v) => v === 0)).toBe(true);
    expect(emptyBevel.every((v) => v === 0)).toBe(true);

    const oneByOne: RgbaBuffer = {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([255, 128, 64, 255]),
    };
    const oneEdt = computeExactAlphaEdt(oneByOne);
    const oneNormal = bakeNormalMapCpu(oneByOne, {
      bevelRadiusPx: 8,
      bevelProfile: 'spherical-dome',
      bevelStrength: 2,
      detailStrength: 1,
      convention: 'opengl',
    });
    expect(Number.isFinite(oneEdt[0])).toBe(true);
    expect(oneEdt[0]).toBe(1);
    expect(oneNormal.data[3]).toBe(255);
  });

  it('bakes neutral (128, 128, 255, 0) on transparent pixels and flips top-bevel Y between OpenGL and DirectX', () => {
    const buf = makeCenteredSquare(64, 32);
    const opengl = bakeNormalMapCpu(buf, {
      bevelRadiusPx: 16,
      bevelProfile: 'spherical-dome',
      bevelStrength: 2.5,
      detailStrength: 1,
      convention: 'opengl',
    });
    const directx = bakeNormalMapCpu(buf, {
      bevelRadiusPx: 16,
      bevelProfile: 'spherical-dome',
      bevelStrength: 2.5,
      detailStrength: 1,
      convention: 'directx',
    });

    // Transparent corner (0, 0) is strictly (128, 128, 255, 0)
    expect(Array.from(opengl.data.slice(0, 4))).toEqual([128, 128, 255, 0]);
    expect(Array.from(directx.data.slice(0, 4))).toEqual([128, 128, 255, 0]);

    // Top-center bevel pixel inside square: (32, 17)
    const topIdx = (17 * 64 + 32) * 4;
    expect(opengl.data[topIdx + 1]).toBeGreaterThan(128);
    expect(directx.data[topIdx + 1]).toBeLessThan(128);
  });
});
