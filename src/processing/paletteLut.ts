import { quantizeToPaletteOklab } from './paletteQuantize';
import { oklabToRgb, rgbToOklab } from './selOut';
import type { Rgb, RgbaBuffer } from './types';

export interface IndexedSpriteResult {
  readonly indexedBuffer: RgbaBuffer; // R=G=B=index (0..255), A=original alpha
  readonly palette: readonly Rgb[]; // length N <= 256
}

export interface PaletteRamp {
  readonly id: string;
  readonly label: string;
  readonly isNeutral: boolean;
  readonly swatchIndices: readonly number[]; // indices into base palette, sorted dark -> light
}

export interface RampTransform {
  readonly rampId: string;
  readonly hueShiftDeg: number; // -180..+180
  readonly chromaScale: number; // 0.0..2.0 (1.0 = unchanged)
  readonly lightnessShift: number; // -0.4..+0.4 in OKLab L
  readonly temperatureShift: number; // -0.05..+0.05 (cools shadows, warms highlights)
}

export interface PaletteVariant {
  readonly id: string;
  readonly name: string;
  readonly rampTransforms: readonly RampTransform[];
  readonly overrides: Readonly<Record<number, Rgb>>;
}

function rgbKey(r: number, g: number, b: number): number {
  return (r << 16) | (g << 8) | b;
}

function toHex(c: Rgb): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`;
}

/**
 * Counts unique opaque colors in `buf` (`alpha >= alphaThreshold`).
 */
export function countUniqueOpaqueColors(buf: RgbaBuffer, alphaThreshold = 1): number {
  const unique = new Set<number>();
  const { data } = buf;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < alphaThreshold) continue;
    unique.add(rgbKey(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0));
  }
  return unique.size;
}

/**
 * Deterministic palette reducer using OKLab farthest-point sampling + `quantizeToPaletteOklab`
 * so high-color sprites (`> 256` colors) can be cleanly indexed for 8-bit LUT swaps.
 */
export function quantizeBufferToMaxColors(buf: RgbaBuffer, maxColors = 32): RgbaBuffer {
  const cap = Math.max(2, Math.min(256, Math.floor(maxColors)));
  const unique = new Map<number, Rgb>();
  const { width, height, data } = buf;

  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) < 1) continue;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const k = rgbKey(r, g, b);
    if (!unique.has(k)) unique.set(k, { r, g, b });
  }

  const all = [...unique.values()];
  if (all.length === 0) {
    return { width, height, data: new Uint8ClampedArray(data) };
  }
  if (all.length <= cap) {
    return { width, height, data: new Uint8ClampedArray(data) };
  }

  const labs = all.map((c) => ({ rgb: c, lab: rgbToOklab(c) }));
  // Deterministically seed with darkest entry
  let startIdx = 0;
  for (let i = 1; i < labs.length; i++) {
    if (labs[i]!.lab.L < labs[startIdx]!.lab.L) startIdx = i;
  }

  const chosen: Rgb[] = [labs[startIdx]!.rgb];
  const minDist = new Float64Array(labs.length);
  const startLab = labs[startIdx]!.lab;
  for (let i = 0; i < labs.length; i++) {
    const c = labs[i]!.lab;
    minDist[i] = (c.L - startLab.L) ** 2 + (c.a - startLab.a) ** 2 + (c.b - startLab.b) ** 2;
  }

  while (chosen.length < cap) {
    let bestIdx = 0;
    let bestD = -1;
    for (let i = 0; i < minDist.length; i++) {
      if ((minDist[i] ?? 0) > bestD) {
        bestD = minDist[i] ?? 0;
        bestIdx = i;
      }
    }
    if (bestD <= 0) break;
    chosen.push(labs[bestIdx]!.rgb);
    const addedLab = labs[bestIdx]!.lab;
    for (let i = 0; i < labs.length; i++) {
      const c = labs[i]!.lab;
      const d = (c.L - addedLab.L) ** 2 + (c.a - addedLab.a) ** 2 + (c.b - addedLab.b) ** 2;
      if (d < (minDist[i] ?? Infinity)) {
        minDist[i] = d;
      }
    }
  }

  const quantizedRgba = quantizeToPaletteOklab(data, width, height, chosen.map(toHex), {
    dither: false,
  });
  return { width, height, data: quantizedRgba };
}

/**
 * Extracts a deterministic palette (sorted by OKLab L, then hue) and encodes
 * every opaque pixel into its exact byte index (0..N-1) as `(idx, idx, idx, alpha)`.
 */
export function extractIndexedSprite(
  buf: RgbaBuffer,
  explicitPalette?: readonly Rgb[],
  alphaThreshold = 1,
): IndexedSpriteResult {
  const { width, height, data } = buf;
  const palette: Rgb[] = [];
  const keyToIndex = new Map<number, number>();

  if (explicitPalette && explicitPalette.length > 0) {
    if (explicitPalette.length > 256) {
      throw new Error(`Palette exceeds 256-entry 8-bit index limit (${explicitPalette.length}).`);
    }
    for (const c of explicitPalette) {
      const k = rgbKey(c.r, c.g, c.b);
      if (!keyToIndex.has(k)) {
        keyToIndex.set(k, palette.length);
        palette.push(c);
      }
    }
  } else {
    const unique = new Map<number, Rgb>();
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < alphaThreshold) continue;
      const r = data[i] ?? 0;
      const g = data[i + 1] ?? 0;
      const b = data[i + 2] ?? 0;
      const k = rgbKey(r, g, b);
      if (!unique.has(k)) unique.set(k, { r, g, b });
    }
    if (unique.size > 256) {
      throw new Error(
        `Sprite has ${unique.size} unique colors; run Palette Quantization (<= 256 colors) before LUT indexing.`,
      );
    }
    const sorted = [...unique.values()].sort((a, b) => {
      const la = rgbToOklab(a);
      const lb = rgbToOklab(b);
      if (Math.abs(la.L - lb.L) > 1e-5) return la.L - lb.L;
      return Math.atan2(la.b, la.a) - Math.atan2(lb.b, lb.a);
    });
    for (const c of sorted) {
      keyToIndex.set(rgbKey(c.r, c.g, c.b), palette.length);
      palette.push(c);
    }
  }

  const paletteLab = palette.map((rgb) => rgbToOklab(rgb));
  const findNearestIndex = (r: number, g: number, b: number): number => {
    const exact = keyToIndex.get(rgbKey(r, g, b));
    if (exact !== undefined) return exact;
    const lab = rgbToOklab({ r, g, b });
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < paletteLab.length; i++) {
      const p = paletteLab[i]!;
      const d = (lab.L - p.L) ** 2 + (lab.a - p.a) ** 2 + (lab.b - p.b) ** 2;
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    return bestIdx;
  };

  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a < alphaThreshold) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 0;
      out[i + 3] = 0;
      continue;
    }
    const idx = findNearestIndex(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
    out[i] = idx;
    out[i + 1] = idx;
    out[i + 2] = idx;
    out[i + 3] = a;
  }

  return { indexedBuffer: { width, height, data: out }, palette };
}

/**
 * Automatically clusters a sprite's palette into editable OKLCH color ramps:
 * 1 neutral/achromatic ramp (`C < neutralChromaThreshold`) + circular hue-angle clusters.
 */
export function clusterPaletteRamps(
  palette: readonly Rgb[],
  hueBinToleranceDeg = 32,
  neutralChromaThreshold = 0.032,
): readonly PaletteRamp[] {
  const neutral: { idx: number; L: number }[] = [];
  const chromatic: { idx: number; L: number; hueDeg: number }[] = [];

  for (let i = 0; i < palette.length; i++) {
    const lab = rgbToOklab(palette[i]!);
    const C = Math.hypot(lab.a, lab.b);
    if (C < neutralChromaThreshold) {
      neutral.push({ idx: i, L: lab.L });
    } else {
      const hueDeg = ((Math.atan2(lab.b, lab.a) * 180) / Math.PI + 360) % 360;
      chromatic.push({ idx: i, L: lab.L, hueDeg });
    }
  }

  const ramps: PaletteRamp[] = [];
  if (neutral.length > 0) {
    neutral.sort((a, b) => a.L - b.L);
    ramps.push({
      id: 'ramp_neutral',
      label: 'Neutrals / Outlines',
      isNeutral: true,
      swatchIndices: neutral.map((n) => n.idx),
    });
  }

  chromatic.sort((a, b) => a.hueDeg - b.hueDeg);
  const clusters: { centerHue: number; items: typeof chromatic }[] = [];
  const circularDiff = (a: number, b: number): number => {
    const d = Math.abs(a - b) % 360;
    return d > 180 ? 360 - d : d;
  };

  for (const item of chromatic) {
    const match = clusters.find(
      (c) => circularDiff(c.centerHue, item.hueDeg) <= hueBinToleranceDeg,
    );
    if (match) {
      match.items.push(item);
    } else {
      clusters.push({ centerHue: item.hueDeg, items: [item] });
    }
  }

  clusters.forEach((c, idx) => {
    c.items.sort((a, b) => a.L - b.L);
    ramps.push({
      id: `ramp_${idx + 1}`,
      label: `Ramp ${idx + 1}`,
      isNeutral: false,
      swatchIndices: c.items.map((x) => x.idx),
    });
  });

  return ramps;
}

/**
 * Applies OKLCH ramp-shifting sliders + manual overrides to produce a variant palette.
 */
export function evaluatePaletteVariant(
  basePalette: readonly Rgb[],
  ramps: readonly PaletteRamp[],
  variant: PaletteVariant,
): readonly Rgb[] {
  const result: Rgb[] = basePalette.map((c) => ({ ...c }));
  const transformByRamp = new Map(variant.rampTransforms.map((t) => [t.rampId, t]));

  for (const ramp of ramps) {
    const tr = transformByRamp.get(ramp.id);
    if (!tr) continue;

    const count = ramp.swatchIndices.length;
    const normalizedDeg = ((tr.hueShiftDeg % 360) + 360) % 360;
    const isIdentityTransform =
      normalizedDeg === 0 &&
      tr.chromaScale === 1 &&
      tr.lightnessShift === 0 &&
      tr.temperatureShift === 0;
    if (isIdentityTransform) continue;

    const rad = (normalizedDeg * Math.PI) / 180;
    const cosH = Math.cos(rad);
    const sinH = Math.sin(rad);

    ramp.swatchIndices.forEach((swatchIdx, pos) => {
      const base = basePalette[swatchIdx];
      if (!base) return;
      const lab = rgbToOklab(base);

      const rampT = count > 1 ? (pos / (count - 1)) * 2 - 1 : 0;
      const rotA = (lab.a * cosH - lab.b * sinH) * tr.chromaScale;
      const rotB = (lab.a * sinH + lab.b * cosH) * tr.chromaScale + rampT * tr.temperatureShift;

      const nextL =
        tr.lightnessShift === 0
          ? lab.L
          : Math.max(0.01, Math.min(0.995, lab.L + tr.lightnessShift));
      result[swatchIdx] = oklabToRgb({ L: nextL, a: rotA, b: rotB });
    });
  }

  for (const [key, rgb] of Object.entries(variant.overrides)) {
    const idx = Number(key);
    if (Number.isInteger(idx) && idx >= 0 && idx < result.length) {
      result[idx] = rgb;
    }
  }

  return result;
}

/**
 * Encodes `1..M` palettes of length `N` into an `N × M` RGBA8 LUT texture buffer (`alpha === 255`).
 */
export function encodeLutBuffer(rows: readonly (readonly Rgb[])[]): RgbaBuffer {
  const height = Math.max(1, rows.length);
  const width = Math.max(1, rows[0]?.length ?? 1);
  const data = new Uint8ClampedArray(width * height * 4);

  for (let y = 0; y < height; y++) {
    const row = rows[y]!;
    for (let x = 0; x < width; x++) {
      const c = row[x] ?? { r: 0, g: 0, b: 0 };
      const i = (y * width + x) * 4;
      data[i] = c.r;
      data[i + 1] = c.g;
      data[i + 2] = c.b;
      data[i + 3] = 255;
    }
  }

  return { width, height, data };
}

/**
 * Pure-TS reference decoder used by live preview panels and Vitest round-trip gates.
 */
export function decodeIndexedSprite(
  indexed: RgbaBuffer,
  lut: RgbaBuffer,
  variantRow = 0,
): RgbaBuffer {
  const { width, height, data } = indexed;
  const out = new Uint8ClampedArray(width * height * 4);
  const clampedRow = Math.max(0, Math.min(lut.height - 1, variantRow));

  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3] ?? 0;
    if (a === 0) continue;
    const idx = Math.min(lut.width - 1, data[i] ?? 0);
    const li = (clampedRow * lut.width + idx) * 4;
    out[i] = lut.data[li] ?? 0;
    out[i + 1] = lut.data[li + 1] ?? 0;
    out[i + 2] = lut.data[li + 2] ?? 0;
    out[i + 3] = a;
  }

  return { width, height, data: out };
}
