import { describe, expect, it } from 'vitest';
import { createDefaultUiKitConfig, UiKitStyleConfigSchema } from '../../src/domain/schemas';
import {
  ALL_UI_WIDGET_SLOTS,
  bakeProceduralUiKit,
  clampNineSliceMargins,
  renderNineSliceToBuffer,
  sliceUiStateSheet,
} from '../../src/processing/uiKitCore';
import type { RgbaBuffer } from '../../src/processing/types';

function meanInteriorLuminance(buf: RgbaBuffer, insetPx: number): number {
  let sum = 0;
  let count = 0;
  for (let y = insetPx; y < buf.height - insetPx; y++) {
    for (let x = insetPx; x < buf.width - insetPx; x++) {
      const idx = (y * buf.width + x) * 4;
      const a = buf.data[idx + 3] ?? 0;
      if (a === 0) continue;
      sum +=
        0.2126 * (buf.data[idx] ?? 0) +
        0.7152 * (buf.data[idx + 1] ?? 0) +
        0.0722 * (buf.data[idx + 2] ?? 0);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function meanInteriorSaturation(buf: RgbaBuffer, insetPx: number): number {
  let sum = 0;
  let count = 0;
  for (let y = insetPx; y < buf.height - insetPx; y++) {
    for (let x = insetPx; x < buf.width - insetPx; x++) {
      const idx = (y * buf.width + x) * 4;
      if ((buf.data[idx + 3] ?? 0) === 0) continue;
      const r = buf.data[idx] ?? 0;
      const g = buf.data[idx + 1] ?? 0;
      const b = buf.data[idx + 2] ?? 0;
      sum += Math.max(r, g, b) - Math.min(r, g, b);
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

describe('M33A Pure-TS Procedural UI Kit Core, Slicer & Margin Clamping', () => {
  it('bakes all 7 widget slots deterministically with strict hover > normal > pressed luminance and lower disabled saturation', () => {
    const cfg = UiKitStyleConfigSchema.parse({
      ...createDefaultUiKitConfig(['#1A1C2C', '#5D275D', '#B13E53', '#FFCD75']),
      slug: 'ui_rpg',
      tileSizePx: 32,
      borderPx: 2,
      cornerCutPx: 1,
      baseRgb: [72, 78, 128],
      accentRgb: [255, 205, 117],
      fillBarRgb: [177, 62, 83],
      outlineRgb: [26, 28, 44],
      margins: { left: 6, top: 6, right: 6, bottom: 6 },
      contentMarginPx: 6,
    });

    const kit1 = bakeProceduralUiKit(cfg);
    const kit2 = bakeProceduralUiKit(cfg);

    for (const slot of ALL_UI_WIDGET_SLOTS) {
      const buf = kit1.slots[slot];
      expect(buf.width).toBe(32);
      expect(buf.height).toBe(32);
      expect(buf.data).toEqual(kit2.slots[slot].data);
      for (let i = 0; i < buf.data.length; i++) {
        expect(Number.isFinite(buf.data[i])).toBe(true);
      }
    }

    const lumHover = meanInteriorLuminance(kit1.slots.button_hover, 4);
    const lumNormal = meanInteriorLuminance(kit1.slots.button_normal, 4);
    const lumPressed = meanInteriorLuminance(kit1.slots.button_pressed, 4);
    expect(lumHover).toBeGreaterThan(lumNormal);
    expect(lumNormal).toBeGreaterThan(lumPressed);

    const satNormal = meanInteriorSaturation(kit1.slots.button_normal, 4);
    const satDisabled = meanInteriorSaturation(kit1.slots.button_disabled, 4);
    expect(satDisabled).toBeLessThan(satNormal);
  });

  it('clamps out-of-range 9-slice margins so left + right < width and top + bottom < height', () => {
    const clamped = clampNineSliceMargins({ left: 20, top: 20, right: 20, bottom: 20 }, 32, 32);
    expect(clamped.left).toBeGreaterThanOrEqual(1);
    expect(clamped.right).toBeGreaterThanOrEqual(1);
    expect(clamped.left + clamped.right).toBeLessThan(32);
    expect(clamped.top + clamped.bottom).toBeLessThan(32);
  });

  it('slices a 4x2 GenAI state sheet, strips #FF00FF chroma, and stretches 9-slice buffers cleanly', () => {
    // Build synthetic 128x64 (4x2 of 32x32 tiles) sheet on #FF00FF with a gold box inside
    const sheetW = 128;
    const sheetH = 64;
    const data = new Uint8ClampedArray(sheetW * sheetH * 4);
    for (let i = 0; i < sheetW * sheetH; i++) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 0;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 255;
    }
    for (let cell = 0; cell < 7; cell++) {
      const cx = (cell % 4) * 32;
      const cy = Math.floor(cell / 4) * 32;
      for (let y = 4; y < 28; y++) {
        for (let x = 4; x < 28; x++) {
          const px = ((cy + y) * sheetW + (cx + x)) * 4;
          data[px] = 80 + cell * 20;
          data[px + 1] = 140;
          data[px + 2] = 200;
          data[px + 3] = 255;
        }
      }
    }

    const sliced = sliceUiStateSheet(
      { width: sheetW, height: sheetH, data },
      [255, 0, 255],
      'ai_ui',
    );
    expect(sliced.slots.button_normal.width).toBe(32);
    expect(sliced.slots.bar_fill.height).toBe(32);
    // Corner pixel of cell was #FF00FF chroma -> stripped transparent alpha 0
    expect(sliced.slots.button_normal.data[3]).toBe(0);
    // Interior widget pixel preserved opaque
    expect(sliced.slots.button_normal.data[(16 * 32 + 16) * 4 + 3]).toBe(255);

    const stretched = renderNineSliceToBuffer(sliced.slots.button_normal, sliced.margins, 96, 40);
    expect(stretched.width).toBe(96);
    expect(stretched.height).toBe(40);
    expect(stretched.data[(20 * 96 + 48) * 4 + 3]).toBe(255);
  });
});
