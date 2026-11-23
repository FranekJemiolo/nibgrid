import { describe, expect, it } from 'vitest';
import {
  buildNineSliceExportFiles,
  exportGodotStyleBoxTres,
  exportPhaserNineSliceJson,
  exportPixiNineSliceJson,
} from '../../src/export/nineSliceExporters';
import { autoDetectNineSliceMargins, renderNineSlice } from '../../src/processing/nineSlice';
import type { RgbaBuffer } from '../../src/processing/types';

function makeFramedPanel(width = 32, height = 32, margin = 8, gradientBevel = false): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const inLeft = x < margin;
      const inRight = x >= width - margin;
      const inTop = y < margin;
      const inBottom = y >= height - margin;

      if (inTop && inLeft) {
        // TL corner (red + unique per-pixel shade so any stretch/shift fails)
        data[i] = 200 + (gradientBevel ? x * 6 : x + y);
        data[i + 1] = 20 + y * 5;
        data[i + 2] = 40;
      } else if (inTop && inRight) {
        // TR corner (green + unique per-pixel signature)
        data[i] = 30;
        data[i + 1] = 190 + (gradientBevel ? (width - 1 - x) * 6 : y * 4);
        data[i + 2] = 40 + (x - (width - margin)) * 5;
      } else if (inBottom && inLeft) {
        // BL corner (blue + unique per-pixel signature)
        data[i] = 40 + x * 4;
        data[i + 1] = 60;
        data[i + 2] = 200 + (height - 1 - y) * 5;
      } else if (inBottom && inRight) {
        // BR corner (gold + unique per-pixel signature)
        data[i] = 210 + (x - (width - margin)) * 4;
        data[i + 1] = 170 + (y - (height - margin)) * 4;
        data[i + 2] = 30;
      } else if (inTop || inBottom || inLeft || inRight) {
        // Solid repeatable side edges
        data[i] = 90;
        data[i + 1] = 95;
        data[i + 2] = 120;
      } else {
        // Patterned center interior
        const checker = ((x + y) & 1) === 0;
        data[i] = checker ? 42 : 58;
        data[i + 1] = checker ? 48 : 64;
        data[i + 2] = checker ? 68 : 88;
      }
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function getPixel(buf: RgbaBuffer, x: number, y: number): [number, number, number, number] {
  const i = (y * buf.width + x) * 4;
  return [buf.data[i] ?? 0, buf.data[i + 1] ?? 0, buf.data[i + 2] ?? 0, buf.data[i + 3] ?? 0];
}

describe('M12B Visual 9-Slice Workshop, Auto-Margin Detection & Engine Exporters', () => {
  it('preserves all four 8x8 corners pixel-for-pixel across wide (120x40) and tall (40x120) renders', () => {
    const src = makeFramedPanel(32, 32, 8);
    const cfg = {
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
      edgeMode: 'stretch' as const,
      centerMode: 'stretch' as const,
    };

    for (const [tw, th] of [
      [120, 40],
      [40, 120],
    ] as const) {
      const dst = renderNineSlice(src, tw, th, cfg);
      expect(dst.width).toBe(tw);
      expect(dst.height).toBe(th);

      for (let dy = 0; dy < 8; dy++) {
        for (let dx = 0; dx < 8; dx++) {
          // TL 8x8
          expect(getPixel(dst, dx, dy)).toEqual(getPixel(src, dx, dy));
          // TR 8x8
          expect(getPixel(dst, tw - 8 + dx, dy)).toEqual(getPixel(src, 32 - 8 + dx, dy));
          // BL 8x8
          expect(getPixel(dst, dx, th - 8 + dy)).toEqual(getPixel(src, dx, 32 - 8 + dy));
          // BR 8x8
          expect(getPixel(dst, tw - 8 + dx, th - 8 + dy)).toEqual(
            getPixel(src, 32 - 8 + dx, 32 - 8 + dy),
          );
        }
      }
    }
  });

  it('yields alpha===0 strictly inside interior for centerMode="transparent" while keeping borders opaque', () => {
    const src = makeFramedPanel(32, 32, 8);
    const dst = renderNineSlice(src, 64, 48, {
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
      edgeMode: 'tile',
      centerMode: 'transparent',
    });

    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 64; x++) {
        const alpha = getPixel(dst, x, y)[3];
        const inInterior = x >= 8 && x < 64 - 8 && y >= 8 && y < 48 - 8;
        expect(alpha).toBe(inInterior ? 0 : 255);
      }
    }
  });

  it('autoDetectNineSliceMargins recovers exact 8px borders on synthetic framed panels', () => {
    const solidCornerPanel = makeFramedPanel(32, 32, 8, false);
    expect(autoDetectNineSliceMargins(solidCornerPanel)).toEqual({
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
    });

    const gradientCornerPanel = makeFramedPanel(32, 32, 8, true);
    expect(autoDetectNineSliceMargins(gradientCornerPanel)).toEqual({
      left: 8,
      right: 8,
      top: 8,
      bottom: 8,
    });
  });

  it('emits valid Godot 4 StyleBoxTexture .tres, Phaser 3 JSON, and PixiJS v8 JSON artifacts', () => {
    const cfg = {
      enabled: true,
      left: 12,
      right: 10,
      top: 14,
      bottom: 8,
      edgeMode: 'tile' as const,
      centerMode: 'transparent' as const,
      lockHorizontal: false,
      lockVertical: false,
    };

    const tres = exportGodotStyleBoxTres('stone_panel', cfg);
    expect(tres).toContain('[gd_resource type="StyleBoxTexture" load_steps=2 format=3]');
    expect(tres).toContain('path="stone_panel.png"');
    expect(tres).toContain('texture_margin_left = 12.0');
    expect(tres).toContain('texture_margin_top = 14.0');
    expect(tres).toContain('texture_margin_right = 10.0');
    expect(tres).toContain('texture_margin_bottom = 8.0');
    expect(tres).toContain('axis_stretch_horizontal = 1');
    expect(tres).toContain('axis_stretch_vertical = 1');
    expect(tres).toContain('draw_center = false');

    const phaser = exportPhaserNineSliceJson('stone_panel', cfg);
    expect(phaser).toEqual({
      key: 'stone_panel',
      frame: 'stone_panel.png',
      leftWidth: 12,
      rightWidth: 10,
      topHeight: 14,
      bottomHeight: 8,
    });

    const pixi = exportPixiNineSliceJson('stone_panel', cfg);
    expect(pixi.texture).toBe('stone_panel.png');
    expect(pixi.leftWidth).toBe(12);
    expect(pixi.bottomHeight).toBe(8);

    const files = buildNineSliceExportFiles('stone_panel', cfg);
    expect(Object.keys(files).sort()).toEqual([
      'stone_panel_nineslice_phaser.json',
      'stone_panel_nineslice_pixi.json',
      'stone_panel_stylebox.tres',
    ]);
  });
});
