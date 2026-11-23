import { describe, expect, it } from 'vitest';
import { demixelBuffer, detectPixelGrid } from '../../src/processing/demixel';
import { cleanOrphanPixels } from '../../src/processing/orphanCleaner';
import { applySelectiveOutline, rgbToOklab } from '../../src/processing/selOut';
import type { Rgb, RgbaBuffer } from '../../src/processing/types';

function makeCheckerboardWithShiftAndSeam(
  width: number,
  height: number,
  blockSize: number,
  offsetX: number,
  offsetY: number,
): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const gx = Math.floor((x - offsetX) / blockSize);
      const gy = Math.floor((y - offsetY) / blockSize);
      const onXSeam = (x - offsetX + blockSize * 100) % blockSize === 0;
      const onYSeam = (y - offsetY + blockSize * 100) % blockSize === 0;
      const isWhite = ((gx + gy) & 1) === 0;
      // Inject 1px mid-gray blurred seam right along cell boundaries
      const val = onXSeam || onYSeam ? 128 : isWhite ? 240 : 20;
      const idx = (y * width + x) * 4;
      data[idx] = val;
      data[idx + 1] = val;
      data[idx + 2] = val;
      data[idx + 3] = 255;
    }
  }
  return { width, height, data };
}

describe('M7 Pixel-Art Foundry Pure-TS Algorithms', () => {
  it('demixelBuffer detects 8x8 grid with (3, 2) shift and strips 1px blurred seams', () => {
    const src = makeCheckerboardWithShiftAndSeam(128, 128, 8, 3, 2);
    const grid = detectPixelGrid(src);
    expect(grid.cellWidth).toBe(8);
    expect(grid.cellHeight).toBe(8);
    expect(grid.offsetX).toBe(3);
    expect(grid.offsetY).toBe(2);
    expect(grid.confidence).toBeGreaterThan(0.3);

    const { buffer } = demixelBuffer(src);
    expect(buffer.width).toBe(15);
    expect(buffer.height).toBe(15);

    // Every re-rasterized cell must be crisp pure light (240) or dark (20), zero mid-gray (128) bleed
    for (let i = 0; i < buffer.width * buffer.height; i++) {
      const r = buffer.data[i * 4] ?? -1;
      expect(r === 240 || r === 20).toBe(true);
    }
  });

  it('cleanOrphanPixels purges detached 1x1 alpha islands and interior 1px pepper specks', () => {
    const width = 16;
    const height = 16;
    const data = new Uint8ClampedArray(width * height * 4);

    // 8x8 solid red square at [4..11] x [4..11]
    for (let y = 4; y <= 11; y++) {
      for (let x = 4; x <= 11; x++) {
        const idx = (y * width + x) * 4;
        data[idx] = 200;
        data[idx + 1] = 32;
        data[idx + 2] = 32;
        data[idx + 3] = 255;
      }
    }

    // Detached 1x1 speck at (0, 0)
    data[0] = 255;
    data[1] = 255;
    data[2] = 255;
    data[3] = 255;

    // Interior bright-green pepper speck at (8, 8)
    const speckIdx = (8 * width + 8) * 4;
    data[speckIdx] = 20;
    data[speckIdx + 1] = 240;
    data[speckIdx + 2] = 40;
    data[speckIdx + 3] = 255;

    const result = cleanOrphanPixels({ width, height, data });
    expect(result.removedIslands).toBe(1);
    expect(result.cleanedSpecks).toBe(1);
    expect(result.buffer.data[3]).toBe(0);
    expect(result.buffer.data[speckIdx]).toBe(200);
    expect(result.buffer.data[speckIdx + 1]).toBe(32);
    expect(result.buffer.data[speckIdx + 2]).toBe(32);
  });

  it('applySelectiveOutline creates directional top-left lit vs bottom-right shadow OKLab borders', () => {
    const width = 16;
    const height = 16;
    const data = new Uint8ClampedArray(width * height * 4);
    const fill: Rgb = { r: 240, g: 128, b: 32 }; // #F08020
    const cx = 7.5;
    const cy = 7.5;

    // Centered circular disk radius ~5
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (Math.hypot(x - cx, y - cy) <= 4.6) {
          const idx = (y * width + x) * 4;
          data[idx] = fill.r;
          data[idx + 1] = fill.g;
          data[idx + 2] = fill.b;
          data[idx + 3] = 255;
        }
      }
    }

    const outlined = applySelectiveOutline(
      { width, height, data },
      {
        mode: 'outer',
        lighting: 'top-left',
        expandCanvas: true,
      },
    );
    expect(outlined.width).toBe(18);
    expect(outlined.height).toBe(18);

    const fillLab = rgbToOklab(fill);
    // Find top-most left border pixel and bottom-most right border pixel
    const borderPixels: { x: number; y: number; L: number }[] = [];
    for (let y = 0; y < outlined.height; y++) {
      for (let x = 0; x < outlined.width; x++) {
        const idx = (y * outlined.width + x) * 4;
        const r = outlined.data[idx] ?? 0;
        const g = outlined.data[idx + 1] ?? 0;
        const b = outlined.data[idx + 2] ?? 0;
        const a = outlined.data[idx + 3] ?? 0;
        if (a === 255 && (r !== fill.r || g !== fill.g || b !== fill.b)) {
          borderPixels.push({ x, y, L: rgbToOklab({ r, g, b }).L });
        }
      }
    }

    expect(borderPixels.length).toBeGreaterThan(12);
    borderPixels.sort((p1, p2) => p1.x + p1.y - (p2.x + p2.y));
    const topLeftBorder = borderPixels[0]!;
    const bottomRightBorder = borderPixels[borderPixels.length - 1]!;

    expect(topLeftBorder.L).toBeGreaterThan(bottomRightBorder.L);
    expect(topLeftBorder.L).toBeLessThan(fillLab.L);
    expect(bottomRightBorder.L).toBeLessThan(fillLab.L);

    // With locked Art Bible palette: 100% of outline pixels must match an exact palette entry
    const palette: Rgb[] = [
      { r: 24, g: 16, b: 36 },
      { r: 112, g: 48, b: 24 },
      fill,
      { r: 255, g: 224, b: 144 },
    ];
    const paletteSet = new Set(palette.map((c) => `${c.r},${c.g},${c.b}`));
    const paletteOutlined = applySelectiveOutline(
      { width, height, data },
      {
        mode: 'outer',
        lighting: 'top-left',
        palette,
        expandCanvas: true,
      },
    );

    let outlineCount = 0;
    for (let i = 0; i < paletteOutlined.width * paletteOutlined.height; i++) {
      const idx = i * 4;
      if ((paletteOutlined.data[idx + 3] ?? 0) === 0) continue;
      const key = `${paletteOutlined.data[idx]},${paletteOutlined.data[idx + 1]},${paletteOutlined.data[idx + 2]}`;
      if (key !== `${fill.r},${fill.g},${fill.b}`) {
        outlineCount++;
        expect(paletteSet.has(key)).toBe(true);
      }
    }
    expect(outlineCount).toBeGreaterThan(12);
  });
});
