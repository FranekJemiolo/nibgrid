import { describe, expect, it } from 'vitest';
import {
  generateGodotPaletteSwapShader,
  generatePixiPaletteSwapFilterTs,
} from '../../src/export/lutShaders';
import {
  clusterPaletteRamps,
  countUniqueOpaqueColors,
  decodeIndexedSprite,
  encodeLutBuffer,
  evaluatePaletteVariant,
  extractIndexedSprite,
  quantizeBufferToMaxColors,
} from '../../src/processing/paletteLut';
import type { Rgb, RgbaBuffer } from '../../src/processing/types';

function make12ColorSpriteWithTransparentBorder(): RgbaBuffer {
  const width = 16;
  const height = 16;
  const data = new Uint8ClampedArray(width * height * 4);
  const swatchColors: Rgb[] = [
    { r: 22, g: 18, b: 28 },
    { r: 54, g: 48, b: 64 },
    { r: 235, g: 230, b: 242 },
    { r: 140, g: 28, b: 36 },
    { r: 210, g: 64, b: 56 },
    { r: 250, g: 138, b: 92 },
    { r: 26, g: 76, b: 148 },
    { r: 58, g: 136, b: 212 },
    { r: 126, g: 204, b: 246 },
    { r: 34, g: 112, b: 54 },
    { r: 84, g: 182, b: 86 },
    { r: 232, g: 196, b: 64 },
  ];

  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * 13 + x) % swatchColors.length;
      const c = swatchColors[idx]!;
      const i = (y * width + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 255;
    }
  }
  return { width, height, data };
}

function make16ColorPalette(): Rgb[] {
  const out: Rgb[] = [
    { r: 0, g: 0, b: 0 },
    { r: 255, g: 255, b: 255 },
  ];
  for (let i = 0; i < 14; i++) {
    out.push({
      r: (24 + i * 16) % 255,
      g: (70 + i * 19) % 255,
      b: (220 - i * 13 + 255) % 255,
    });
  }
  return out;
}

function makeOver256Gradient(uniqueCount = 300): RgbaBuffer {
  const width = 30;
  const height = Math.ceil(uniqueCount / width);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let n = 0; n < width * height; n++) {
    const id = n % uniqueCount;
    const i = n * 4;
    data[i] = (id * 17) % 256;
    data[i + 1] = Math.floor(id / 3) % 256;
    data[i + 2] = (255 - ((id * 11) % 256)) & 255;
    data[i + 3] = 255;
  }
  return { width, height, data };
}

describe('M12C Indexed Palette-Swap & 1D/Stacked LUT Exporter', () => {
  it('round-trips a 12-color sprite with transparent border at exact 0-byte diff', () => {
    const src = make12ColorSpriteWithTransparentBorder();
    expect(countUniqueOpaqueColors(src)).toBe(12);

    const { indexedBuffer, palette } = extractIndexedSprite(src);
    expect(palette).toHaveLength(12);

    const lut = encodeLutBuffer([palette]);
    expect(lut.width).toBe(12);
    expect(lut.height).toBe(1);

    const decoded = decodeIndexedSprite(indexedBuffer, lut, 0);
    expect(decoded.width).toBe(src.width);
    expect(decoded.height).toBe(src.height);

    let maxByteDiff = 0;
    for (let i = 0; i < src.data.length; i++) {
      const diff = Math.abs((decoded.data[i] ?? 0) - (src.data[i] ?? 0));
      if (diff > maxByteDiff) maxByteDiff = diff;
    }
    expect(maxByteDiff).toBe(0);

    // Ensure transparent border pixels remain transparent (alpha === 0)
    for (let x = 0; x < src.width; x++) {
      expect(indexedBuffer.data[x * 4 + 3]).toBe(0);
      expect(decoded.data[x * 4 + 3]).toBe(0);
    }
  });

  it('preserves OKLCH identity at hueShift=0 and 360-degree periodicity within <= 1 LSB', () => {
    const basePalette = make16ColorPalette();
    const ramps = clusterPaletteRamps(basePalette);
    expect(ramps.length).toBeGreaterThanOrEqual(2);

    const zeroShift = evaluatePaletteVariant(basePalette, ramps, {
      id: 'id-0',
      name: 'Zero',
      rampTransforms: ramps.map((r) => ({
        rampId: r.id,
        hueShiftDeg: 0,
        chromaScale: 1,
        lightnessShift: 0,
        temperatureShift: 0,
      })),
      overrides: {},
    });

    const fullPeriod = evaluatePaletteVariant(basePalette, ramps, {
      id: 'id-360',
      name: 'Period 360',
      rampTransforms: ramps.map((r) => ({
        rampId: r.id,
        hueShiftDeg: 360,
        chromaScale: 1,
        lightnessShift: 0,
        temperatureShift: 0,
      })),
      overrides: {},
    });

    for (let i = 0; i < basePalette.length; i++) {
      const orig = basePalette[i]!;
      const z = zeroShift[i]!;
      const p = fullPeriod[i]!;
      expect(Math.abs(z.r - orig.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(z.g - orig.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(z.b - orig.b)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.r - orig.r)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.g - orig.g)).toBeLessThanOrEqual(1);
      expect(Math.abs(p.b - orig.b)).toBeLessThanOrEqual(1);
    }

    // Confirm real hue shift mutates chromatic ramp cleanly while keeping base intact
    const chromaticRamp = ramps.find((r) => !r.isNeutral);
    expect(chromaticRamp).toBeDefined();
    const shifted = evaluatePaletteVariant(basePalette, ramps, {
      id: 'shift-120',
      name: 'Emerald',
      rampTransforms: [
        {
          rampId: chromaticRamp!.id,
          hueShiftDeg: 120,
          chromaScale: 1,
          lightnessShift: 0,
          temperatureShift: 0,
        },
      ],
      overrides: {},
    });
    const changed = shifted.some((c, i) => {
      const o = basePalette[i]!;
      return Math.abs(c.r - o.r) + Math.abs(c.g - o.g) + Math.abs(c.b - o.b) > 20;
    });
    expect(changed).toBe(true);
  });

  it('enforces the 256-color indexing guard and recovers cleanly after quantizeBufferToMaxColors(32)', () => {
    const gradient = makeOver256Gradient(300);
    expect(countUniqueOpaqueColors(gradient)).toBeGreaterThan(256);

    expect(() => extractIndexedSprite(gradient)).toThrow(/256/i);

    const quantized = quantizeBufferToMaxColors(gradient, 32);
    expect(countUniqueOpaqueColors(quantized)).toBeLessThanOrEqual(32);

    const { indexedBuffer, palette } = extractIndexedSprite(quantized);
    expect(palette.length).toBeLessThanOrEqual(32);
    expect(indexedBuffer.width).toBe(gradient.width);
    expect(indexedBuffer.height).toBe(gradient.height);
  });

  it('encodes stacked LUT dimensions (16x4 for 4 variants of a 16-color palette) with alpha=255 everywhere', () => {
    const base = make16ColorPalette();
    const ramps = clusterPaletteRamps(base);
    const rows = [0, 90, 180, -90].map((deg, idx) =>
      evaluatePaletteVariant(base, ramps, {
        id: `v-${idx}`,
        name: `Var ${idx}`,
        rampTransforms: ramps.map((r) => ({
          rampId: r.id,
          hueShiftDeg: deg,
          chromaScale: 1,
          lightnessShift: 0,
          temperatureShift: 0,
        })),
        overrides: {},
      }),
    );

    const lut = encodeLutBuffer(rows);
    expect(lut.width).toBe(16);
    expect(lut.height).toBe(4);
    for (let i = 3; i < lut.data.length; i += 4) {
      expect(lut.data[i]).toBe(255);
    }
  });

  it('emits Godot .gdshader and PixiJS v8 Filter with nearest sampling and half-texel offsets', () => {
    const godot = generateGodotPaletteSwapShader('crimson-cat', 16, 4);
    expect(godot).toContain('filter_nearest');
    expect(godot).toContain('(palette_idx + 0.5)');
    expect(godot).toContain('variant_index');

    const pixi = generatePixiPaletteSwapFilterTs('crimson-cat', 16, 4);
    expect(pixi).toContain("scaleMode = 'nearest'");
    expect(pixi).toContain('uVariantRow');
    expect(pixi).toContain('(paletteIdx + 0.5)');
  });
});
