import { describe, expect, it } from 'vitest';
import {
  detectTurnaroundSlots,
  sliceAndAlignTurnaround,
} from '../../src/processing/turnaroundSlicer';
import type { RgbaBuffer } from '../../src/processing/types';

function createBuffer(width: number, height: number): RgbaBuffer {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
}

function paintRect(
  buf: RgbaBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: readonly [number, number, number],
  alpha = 255,
): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      if (px < 0 || px >= buf.width || py < 0 || py >= buf.height) continue;
      const idx = (py * buf.width + px) * 4;
      buf.data[idx] = rgb[0];
      buf.data[idx + 1] = rgb[1];
      buf.data[idx + 2] = rgb[2];
      buf.data[idx + 3] = alpha;
    }
  }
}

function measureOpaqueVerticalBounds(buf: RgbaBuffer): { minY: number; maxY: number } {
  let minY = buf.height;
  let maxY = -1;
  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const a = buf.data[(y * buf.width + x) * 4 + 3] ?? 0;
      if (a >= 128) {
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minY, maxY };
}

describe('M18A Pure-TS Connected-Component Turnaround Auto-Slicer', () => {
  it('extracts 4 directional frames cleanly from both 2x2 (128x128) and 1x4 (256x64) sheets', () => {
    const sheet2x2 = createBuffer(128, 128);
    paintRect(sheet2x2, 18, 20, 20, 26, [220, 60, 60]); // slot 0: south
    paintRect(sheet2x2, 82, 19, 18, 26, [60, 200, 90]); // slot 1: east
    paintRect(sheet2x2, 20, 82, 20, 26, [70, 150, 240]); // slot 2: north
    paintRect(sheet2x2, 84, 83, 18, 26, [180, 90, 230]); // slot 3: west

    const res2x2 = sliceAndAlignTurnaround(sheet2x2, { layout: '2x2' });
    expect(res2x2.frames).toHaveLength(4);
    expect(res2x2.frames.map((f) => f.direction)).toEqual(['south', 'east', 'north', 'west']);
    expect(res2x2.frameWidth).toBeGreaterThan(0);
    expect(res2x2.frameHeight).toBeGreaterThan(0);
    for (const frame of res2x2.frames) {
      expect(frame.buffer.width).toBe(res2x2.frameWidth);
      expect(frame.buffer.height).toBe(res2x2.frameHeight);
    }

    const sheet1x4 = createBuffer(256, 64);
    paintRect(sheet1x4, 16, 18, 18, 26, [220, 60, 60]);
    paintRect(sheet1x4, 80, 18, 18, 26, [60, 200, 90]);
    paintRect(sheet1x4, 144, 18, 18, 26, [70, 150, 240]);
    paintRect(sheet1x4, 208, 18, 18, 26, [180, 90, 230]);

    const res1x4 = sliceAndAlignTurnaround(sheet1x4, { layout: '1x4' });
    expect(res1x4.frames).toHaveLength(4);
    expect(res1x4.frames.map((f) => f.direction)).toEqual(['south', 'east', 'north', 'west']);
    for (const frame of res1x4.frames) {
      expect(frame.buffer.width).toBe(res1x4.frameWidth);
      expect(frame.buffer.height).toBe(res1x4.frameHeight);
    }
  });

  it('merges floating crown accessory into parent slot and purges 2x2 corner speck', () => {
    const sheet = createBuffer(128, 128);
    // Slot 0 character body + 6x6 crown floating 3px above head (gap y=26..28)
    paintRect(sheet, 20, 29, 20, 26, [210, 80, 80]);
    paintRect(sheet, 27, 20, 6, 6, [250, 210, 60]);
    // 2x2 noise speck in far top-left corner (4 px < minComponentPixels: 16)
    paintRect(sheet, 1, 1, 2, 2, [255, 255, 255]);

    paintRect(sheet, 82, 20, 18, 26, [60, 200, 90]);
    paintRect(sheet, 20, 82, 20, 26, [70, 150, 240]);
    paintRect(sheet, 84, 82, 18, 26, [180, 90, 230]);

    const slots = detectTurnaroundSlots(sheet, {
      layout: '2x2',
      minComponentPixels: 16,
    });
    expect(slots).toHaveLength(4);
    const slot0 = slots[0]!;
    expect(slot0.minX).toBe(20);
    expect(slot0.minY).toBe(20); // Includes floating crown top, NOT corner speck (1, 1)
    expect(slot0.maxY).toBe(54);
    expect(slot0.pixelCount).toBe(20 * 26 + 6 * 6);
  });

  it('normalizes 12% taller slot to median height and locks lowest opaque row to sharedPivotPx.y - 1', () => {
    const sheet = createBuffer(128, 128);
    paintRect(sheet, 20, 20, 16, 25, [200, 50, 50]); // 25px tall
    paintRect(sheet, 84, 16, 16, 28, [50, 200, 80]); // 28px tall (+12%)
    paintRect(sheet, 20, 82, 16, 25, [60, 120, 240]); // 25px tall
    paintRect(sheet, 84, 84, 16, 25, [190, 90, 220]); // 25px tall

    const result = sliceAndAlignTurnaround(sheet, {
      layout: '2x2',
      normalizeHeight: true,
      paddingPx: 4,
    });
    expect(result.frames).toHaveLength(4);

    const measuredHeights = result.frames.map((frame) => {
      const bounds = measureOpaqueVerticalBounds(frame.buffer);
      expect(bounds.maxY).toBe(result.sharedPivotPx.y - 1);
      return bounds.maxY - bounds.minY + 1;
    });

    const minMeasuredH = Math.min(...measuredHeights);
    const maxMeasuredH = Math.max(...measuredHeights);
    expect(maxMeasuredH - minMeasuredH).toBeLessThanOrEqual(1);
    expect(minMeasuredH).toBe(25);
  });

  it('replaces west frame with exact pixel-for-pixel horizontal mirror of east when mirrorEastToWest=true', () => {
    const sheet = createBuffer(128, 128);
    paintRect(sheet, 20, 20, 16, 24, [200, 50, 50]);
    // Asymmetric east sprite (sword jutting right on top-right)
    paintRect(sheet, 80, 20, 12, 24, [50, 200, 90]);
    paintRect(sheet, 92, 24, 6, 4, [255, 220, 70]);
    paintRect(sheet, 20, 82, 16, 24, [60, 130, 240]);
    // Completely different west silhouette in sheet
    paintRect(sheet, 84, 82, 14, 24, [180, 60, 200]);

    const result = sliceAndAlignTurnaround(sheet, {
      layout: '2x2',
      mirrorEastToWest: true,
      normalizeHeight: true,
      paddingPx: 4,
    });

    const east = result.frames.find((f) => f.direction === 'east')!;
    const west = result.frames.find((f) => f.direction === 'west')!;
    expect(east).toBeDefined();
    expect(west).toBeDefined();
    expect(west.buffer.width).toBe(east.buffer.width);
    expect(west.buffer.height).toBe(east.buffer.height);

    const w = east.buffer.width;
    const h = east.buffer.height;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ei = (y * w + x) * 4;
        const wi = (y * w + (w - 1 - x)) * 4;
        expect(west.buffer.data[wi]).toBe(east.buffer.data[ei]);
        expect(west.buffer.data[wi + 1]).toBe(east.buffer.data[ei + 1]);
        expect(west.buffer.data[wi + 2]).toBe(east.buffer.data[ei + 2]);
        expect(west.buffer.data[wi + 3]).toBe(east.buffer.data[ei + 3]);
      }
    }
  });

  it('returns empty frames with zero dimensions and zero NaN on fully transparent or zero-sized buffers', () => {
    const empty = createBuffer(128, 128);
    const resEmpty = sliceAndAlignTurnaround(empty, { layout: '2x2' });
    expect(resEmpty.frames).toEqual([]);
    expect(resEmpty.frameWidth).toBe(0);
    expect(resEmpty.frameHeight).toBe(0);
    expect(resEmpty.sharedPivotPx).toEqual({ x: 0, y: 0 });

    const zero = createBuffer(0, 0);
    const resZero = sliceAndAlignTurnaround(zero, { layout: '1x4' });
    expect(resZero.frames).toEqual([]);
    expect(Number.isNaN(resZero.frameWidth)).toBe(false);
    expect(Number.isNaN(resZero.frameHeight)).toBe(false);
  });
});
