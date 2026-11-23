import { parseHexRgb } from './backgroundKey';

export interface OklabColor {
  L: number;
  a: number;
  b: number;
}

interface PaletteEntry extends OklabColor {
  r: number;
  g: number;
  bRgb: number;
}

const BAYER_4X4: readonly (readonly [number, number, number, number])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

function srgbChannelToLinear(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

/**
 * Converts 8-bit sRGB channels to Björn Ottosson's perceptual OKLab color space.
 */
export function srgbToOklab(r: number, g: number, b: number): OklabColor {
  const lr = srgbChannelToLinear(r);
  const lg = srgbChannelToLinear(g);
  const lb = srgbChannelToLinear(b);

  const l = 0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb;
  const m = 0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb;
  const s = 0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb;

  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);

  return {
    L: 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    a: 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    b: 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  };
}

export interface PaletteQuantizeOptions {
  dither?: boolean;
  ditherStrength?: number;
}

/**
 * Quantizes every non-transparent pixel (`alpha > 0`) to the exact nearest `#RRGGBB`
 * entry in `paletteHex` using perceptual OKLab distance and optional 4x4 Ordered Bayer dithering.
 * Pixels with `alpha === 0` are preserved untouched.
 */
export function quantizeToPaletteOklab(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  paletteHex: readonly string[],
  options: PaletteQuantizeOptions = {},
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  if (paletteHex.length === 0) {
    return out;
  }

  const palette: PaletteEntry[] = paletteHex.map((hex) => {
    const rgb = parseHexRgb(hex);
    const lab = srgbToOklab(rgb.r, rgb.g, rgb.b);
    return {
      r: rgb.r,
      g: rgb.g,
      bRgb: rgb.b,
      ...lab,
    };
  });

  const useDither = Boolean(options.dither);
  const strength = Math.max(0, Math.min(1, options.ditherStrength ?? 0.35));
  const ditherAmplitude = strength * 64;

  for (let y = 0; y < height; y++) {
    const bayerRow = BAYER_4X4[y & 3]!;
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      const alpha = out[px + 3] ?? 0;
      if (alpha === 0) continue;

      let r = out[px] ?? 0;
      let g = out[px + 1] ?? 0;
      let b = out[px + 2] ?? 0;

      if (useDither && ditherAmplitude > 0) {
        const threshold = ((bayerRow[x & 3] ?? 0) + 0.5) / 16 - 0.5;
        const offset = threshold * ditherAmplitude;
        r = Math.max(0, Math.min(255, Math.round(r + offset)));
        g = Math.max(0, Math.min(255, Math.round(g + offset)));
        b = Math.max(0, Math.min(255, Math.round(b + offset)));
      }

      const lab = srgbToOklab(r, g, b);
      let bestEntry = palette[0]!;
      let bestDist = Infinity;

      for (let p = 0; p < palette.length; p++) {
        const entry = palette[p]!;
        const dL = lab.L - entry.L;
        const da = lab.a - entry.a;
        const db = lab.b - entry.b;
        const dist = dL * dL + da * da + db * db;
        if (dist < bestDist) {
          bestDist = dist;
          bestEntry = entry;
        }
      }

      out[px] = bestEntry.r;
      out[px + 1] = bestEntry.g;
      out[px + 2] = bestEntry.bRgb;
    }
  }

  return out;
}
