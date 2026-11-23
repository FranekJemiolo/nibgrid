import type { LightDirection, Oklab, Rgb, RgbaBuffer } from './types';

export interface SelOutOptions {
  readonly mode?: 'outer' | 'inner'; // default 'outer'
  readonly lighting?: LightDirection; // default 'top-left'
  readonly litDarken?: number; // OKLab L drop on lit edge, default 0.16
  readonly shadowDarken?: number; // OKLab L drop on shadow edge, default 0.36
  readonly hueShiftStrength?: number; // default 0.025
  readonly palette?: readonly Rgb[]; // optional locked Art Bible palette
  readonly alphaThreshold?: number; // default 128
  readonly expandCanvas?: boolean; // default true for 'outer' mode
}

function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function linearToSrgb(v: number): number {
  const clamped = Math.max(0, Math.min(1, v));
  const s = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055;
  return Math.round(s * 255);
}

/**
 * Exact Björn Ottosson linear-light sRGB -> perceptual OKLab conversion.
 */
export function rgbToOklab(rgb: Rgb): Oklab {
  const r = srgbToLinear(rgb.r);
  const g = srgbToLinear(rgb.g);
  const b = srgbToLinear(rgb.b);

  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);

  return {
    L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  };
}

/**
 * Exact Björn Ottosson OKLab -> 8-bit sRGB conversion (gamut-clamped).
 */
export function oklabToRgb(lab: Oklab): Rgb {
  const l_ = lab.L + 0.3963377774 * lab.a + 0.2158037573 * lab.b;
  const m_ = lab.L - 0.1055613458 * lab.a - 0.0638541728 * lab.b;
  const s_ = lab.L - 0.0894841775 * lab.a - 1.291485548 * lab.b;

  const l = l_ * l_ * l_;
  const m = m_ * m_ * m_;
  const s = s_ * s_ * s_;

  return {
    r: linearToSrgb(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: linearToSrgb(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: linearToSrgb(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  };
}

function getLightVector(dir: LightDirection): readonly [number, number] {
  const invSqrt2 = Math.SQRT1_2;
  switch (dir) {
    case 'top-left':
      return [-invSqrt2, -invSqrt2];
    case 'top-right':
      return [invSqrt2, -invSqrt2];
    case 'overhead':
      return [0, -1];
    case 'flat':
      return [0, 0];
  }
}

function oklabDistSq(x: Oklab, y: Oklab): number {
  const dL = x.L - y.L;
  const da = x.a - y.a;
  const db = x.b - y.b;
  return dL * dL + da * da + db * db;
}

/**
 * Generates a directional, palette-aware 1px selective colored outline ("sel-out")
 * around or inside the sprite silhouette in perceptual OKLab space.
 */
export function applySelectiveOutline(buf: RgbaBuffer, options: SelOutOptions = {}): RgbaBuffer {
  const mode = options.mode ?? 'outer';
  const lighting = options.lighting ?? 'top-left';
  const litDarken = options.litDarken ?? 0.16;
  const shadowDarken = options.shadowDarken ?? 0.36;
  const hueShift = options.hueShiftStrength ?? 0.025;
  const alphaThreshold = options.alphaThreshold ?? 128;
  const pad = mode === 'outer' && (options.expandCanvas ?? true) ? 1 : 0;

  if (buf.width <= 0 || buf.height <= 0) {
    return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
  }

  const w = buf.width + pad * 2;
  const h = buf.height + pad * 2;
  const src = new Uint8ClampedArray(w * h * 4);

  for (let y = 0; y < buf.height; y++) {
    for (let x = 0; x < buf.width; x++) {
      const si = (y * buf.width + x) * 4;
      const di = ((y + pad) * w + (x + pad)) * 4;
      src[di] = buf.data[si] ?? 0;
      src[di + 1] = buf.data[si + 1] ?? 0;
      src[di + 2] = buf.data[si + 2] ?? 0;
      src[di + 3] = buf.data[si + 3] ?? 0;
    }
  }

  const out = new Uint8ClampedArray(src);
  const [lx, ly] = getLightVector(lighting);

  const isOpaque = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return (src[(y * w + x) * 4 + 3] ?? 0) >= alphaThreshold ? 1 : 0;
  };

  const paletteLab = (options.palette ?? []).map((rgb) => ({
    rgb,
    lab: rgbToOklab(rgb),
  }));

  const dirs = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ] as const;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const selfOpaque = isOpaque(x, y);
      if (mode === 'outer' && selfOpaque === 1) continue;
      if (mode === 'inner' && selfOpaque === 0) continue;

      const opaqueNeighbors: Rgb[] = [];
      let hasTransparentNeighbor = false;

      for (const [dx, dy] of dirs) {
        const nx = x + dx;
        const ny = y + dy;
        if (isOpaque(nx, ny) === 1) {
          const ni = (ny * w + nx) * 4;
          opaqueNeighbors.push({
            r: src[ni] ?? 0,
            g: src[ni + 1] ?? 0,
            b: src[ni + 2] ?? 0,
          });
        } else {
          hasTransparentNeighbor = true;
        }
      }

      if (mode === 'outer' && opaqueNeighbors.length === 0) continue;
      if (mode === 'inner' && !hasTransparentNeighbor) continue;

      let baseLab: Oklab;
      if (mode === 'inner') {
        const si = (y * w + x) * 4;
        baseLab = rgbToOklab({
          r: src[si] ?? 0,
          g: src[si + 1] ?? 0,
          b: src[si + 2] ?? 0,
        });
      } else {
        let darkest = rgbToOklab(opaqueNeighbors[0]!);
        for (let k = 1; k < opaqueNeighbors.length; k++) {
          const cand = rgbToOklab(opaqueNeighbors[k]!);
          if (cand.L < darkest.L) darkest = cand;
        }
        baseLab = darkest;
      }

      // 3x3 Sobel on binary opacity mask
      const gx =
        -isOpaque(x - 1, y - 1) +
        isOpaque(x + 1, y - 1) -
        2 * isOpaque(x - 1, y) +
        2 * isOpaque(x + 1, y) -
        isOpaque(x - 1, y + 1) +
        isOpaque(x + 1, y + 1);
      const gy =
        -isOpaque(x - 1, y - 1) -
        2 * isOpaque(x, y - 1) -
        isOpaque(x + 1, y - 1) +
        isOpaque(x - 1, y + 1) +
        2 * isOpaque(x, y + 1) +
        isOpaque(x + 1, y + 1);

      const len = Math.hypot(gx, gy);
      const nx = len > 0 ? -gx / len : 0;
      const ny = len > 0 ? -gy / len : 0;

      const dot = nx * lx + ny * ly;
      const t = lighting === 'flat' ? 0.5 : (dot + 1) * 0.5;

      const darken = shadowDarken * (1 - t) + litDarken * t;
      const targetL = Math.max(0.06, baseLab.L - darken);
      const chromaScale = Math.min(1, targetL / Math.max(0.15, baseLab.L));
      const targetLab: Oklab = {
        L: targetL,
        a: baseLab.a * chromaScale,
        b: baseLab.b * chromaScale + (t - 0.5) * 2 * hueShift,
      };

      let finalRgb: Rgb;
      if (paletteLab.length > 0) {
        const darker = paletteLab.filter((p) => p.lab.L < baseLab.L - 0.04);
        const candidates = darker.length > 0 ? darker : paletteLab;
        let best = candidates[0]!;
        let bestDist = oklabDistSq(targetLab, best.lab);
        for (let k = 1; k < candidates.length; k++) {
          const cand = candidates[k]!;
          const d = oklabDistSq(targetLab, cand.lab);
          if (d < bestDist) {
            bestDist = d;
            best = cand;
          }
        }
        finalRgb = best.rgb;
      } else {
        finalRgb = oklabToRgb(targetLab);
      }

      const di = (y * w + x) * 4;
      out[di] = finalRgb.r;
      out[di + 1] = finalRgb.g;
      out[di + 2] = finalRgb.b;
      out[di + 3] = 255;
    }
  }

  return { width: w, height: h, data: out };
}
