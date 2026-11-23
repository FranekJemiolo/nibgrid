import { describe, expect, it } from 'vitest';
import { defringeInteriorRgb } from '../../src/processing/alphaCleanup';
import { parseHexRgb, removeBackgroundColorKey } from '../../src/processing/backgroundKey';
import { quantizeToPaletteOklab } from '../../src/processing/paletteQuantize';
import {
  autoTrimTransparent,
  padToPowerOfTwo,
  resampleRgba,
} from '../../src/processing/resampleAndTrim';

describe('M5 Deterministic Post-Processing Invariants', () => {
  it('Flood-Fill Cutout removes #00FF00 background corners while preserving centered solid red square', () => {
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = (y * w + x) * 4;
        const isInterior = x >= 8 && x < 24 && y >= 8 && y < 24;
        if (isInterior) {
          rgba[px] = 255;
          rgba[px + 1] = 0;
          rgba[px + 2] = 0;
          rgba[px + 3] = 255;
        } else {
          rgba[px] = 0;
          rgba[px + 1] = 255;
          rgba[px + 2] = 0;
          rgba[px + 3] = 255;
        }
      }
    }

    const out = removeBackgroundColorKey(rgba, w, h, {
      tolerance: 5,
      contiguous: true,
    });

    const corners = [0, (w - 1) * 4, (h - 1) * w * 4, ((h - 1) * w + (w - 1)) * 4];
    for (const c of corners) {
      expect(out[c + 3]).toBe(0);
    }

    const centerPx = (16 * w + 16) * 4;
    expect(out[centerPx]).toBe(255);
    expect(out[centerPx + 1]).toBe(0);
    expect(out[centerPx + 2]).toBe(0);
    expect(out[centerPx + 3]).toBe(255);
  });

  it('Defringing decontaminates 1px semi-transparent white halo toward #102040 interior', () => {
    const w = 16;
    const h = 16;
    const rgba = new Uint8ClampedArray(w * h * 4);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = (y * w + x) * 4;
        const inCore = x >= 4 && x <= 11 && y >= 4 && y <= 11;
        const inHalo = !inCore && x >= 3 && x <= 12 && y >= 3 && y <= 12;

        if (inCore) {
          rgba[px] = 16;
          rgba[px + 1] = 32;
          rgba[px + 2] = 64;
          rgba[px + 3] = 255;
        } else if (inHalo) {
          rgba[px] = 255;
          rgba[px + 1] = 255;
          rgba[px + 2] = 255;
          rgba[px + 3] = 128;
        }
      }
    }

    const defringed = defringeInteriorRgb(rgba, w, h, 2);

    // Check top halo pixel (7, 3): previously white (255,255,255,128)
    const haloPx = (3 * w + 7) * 4;
    expect(defringed[haloPx]).toBe(16);
    expect(defringed[haloPx + 1]).toBe(32);
    expect(defringed[haloPx + 2]).toBe(64);
    expect(defringed[haloPx + 3]).toBe(128);
  });

  it('OKLab Palette Quantization maps 100% of opaque pixels to exact Art Bible swatches', () => {
    const palette = ['#1A1C2C', '#B13E53', '#FFCD75', '#38B764'];
    const allowedSet = new Set(
      palette.map((hex) => {
        const rgb = parseHexRgb(hex);
        return `${rgb.r},${rgb.g},${rgb.b}`;
      }),
    );

    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const px = (y * w + x) * 4;
        if (x === 0 || y === 0) {
          rgba[px + 3] = 0;
        } else {
          rgba[px] = Math.round((x / w) * 255);
          rgba[px + 1] = Math.round((y / h) * 255);
          rgba[px + 2] = 140;
          rgba[px + 3] = 255;
        }
      }
    }

    for (const dither of [false, true]) {
      const quantized = quantizeToPaletteOklab(rgba, w, h, palette, {
        dither,
        ditherStrength: 0.4,
      });

      for (let i = 0; i < w * h; i++) {
        const px = i * 4;
        const alpha = quantized[px + 3] ?? 0;
        if (alpha === 0) {
          expect(quantized[px]).toBe(0);
        } else {
          const triplet = `${quantized[px]},${quantized[px + 1]},${quantized[px + 2]}`;
          expect(allowedSet.has(triplet)).toBe(true);
        }
      }
    }
  });

  it('Auto-trim strips transparent outer margins, resample hits 64x64, and PoT rounds 50x70 to 64x128', () => {
    // 1. Auto-trim 64x64 with opaque block of 10x14 inside
    const trimSrc = new Uint8ClampedArray(64 * 64 * 4);
    for (let y = 25; y < 39; y++) {
      for (let x = 20; x < 30; x++) {
        const px = (y * 64 + x) * 4;
        trimSrc[px] = 200;
        trimSrc[px + 1] = 100;
        trimSrc[px + 2] = 50;
        trimSrc[px + 3] = 255;
      }
    }
    const trimmed = autoTrimTransparent(trimSrc, 64, 64, 0);
    expect(trimmed.width).toBe(10);
    expect(trimmed.height).toBe(14);
    expect(trimmed.rgba[3]).toBe(255);

    // 2. Resampling 128x128 -> 64x64
    const large = new Uint8ClampedArray(128 * 128 * 4).fill(255);
    const nearest = resampleRgba(large, 128, 128, 64, 64, 'nearest');
    expect(nearest.width).toBe(64);
    expect(nearest.height).toBe(64);
    expect(nearest.rgba.length).toBe(64 * 64 * 4);

    const area = resampleRgba(large, 128, 128, 64, 64, 'area');
    expect(area.width).toBe(64);
    expect(area.height).toBe(64);

    // 3. PoT padding: 50x70 -> 64x128
    const rect50x70 = new Uint8ClampedArray(50 * 70 * 4).fill(255);
    const padded = padToPowerOfTwo(rect50x70, 50, 70, 'center');
    expect(padded.width).toBe(64);
    expect(padded.height).toBe(128);
    expect(padded.rgba.length).toBe(64 * 128 * 4);
    // Corner (0,0) of padded PoT buffer is transparent padding
    expect(padded.rgba[3]).toBe(0);
    // Center pixel is opaque sprite content
    const midPx = (64 * 64 + 32) * 4;
    expect(padded.rgba[midPx + 3]).toBe(255);
  });
});
