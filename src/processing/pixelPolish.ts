import { quantizeToPaletteOklab } from './paletteQuantize';
import type { RgbaBuffer } from './types';

export interface PixelPolishOptions {
  readonly dither?: 'none' | 'bayer4x4';
  readonly ditherStrength?: number;
  readonly minNeighbors?: number;
  readonly normalizeOutline?: boolean;
  readonly outlineHex?: string;
}

export interface PixelPolishResult {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly detectedScale: number;
  readonly strippedPixels: number;
}

/**
 * Computes horizontal & vertical RGBA L1 transition profiles and selects the dominant integer
 * pixel grid scale (`1`, `2`, `4`, or `8`) via boundary-cut energy concentration (solving harmonic
 * aliasing so a 4x upscaled sprite yields `4`, not `2`).
 */
export function detectPixelGridScale(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): number {
  if (width < 4 || height < 4) return 1;

  const ex = new Float64Array(width);
  const ey = new Float64Array(height);
  let totalEnergy = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const i = (y * width + x) * 4;
      const p = i - 4;
      const diff =
        Math.abs((rgba[i] ?? 0) - (rgba[p] ?? 0)) +
        Math.abs((rgba[i + 1] ?? 0) - (rgba[p + 1] ?? 0)) +
        Math.abs((rgba[i + 2] ?? 0) - (rgba[p + 2] ?? 0)) +
        Math.abs((rgba[i + 3] ?? 0) - (rgba[p + 3] ?? 0));
      ex[x] = (ex[x] ?? 0) + diff;
      totalEnergy += diff;
    }
  }

  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const p = ((y - 1) * width + x) * 4;
      const diff =
        Math.abs((rgba[i] ?? 0) - (rgba[p] ?? 0)) +
        Math.abs((rgba[i + 1] ?? 0) - (rgba[p + 1] ?? 0)) +
        Math.abs((rgba[i + 2] ?? 0) - (rgba[p + 2] ?? 0)) +
        Math.abs((rgba[i + 3] ?? 0) - (rgba[p + 3] ?? 0));
      ey[y] = (ey[y] ?? 0) + diff;
      totalEnergy += diff;
    }
  }

  if (totalEnergy <= 1e-6) return 1;

  const candidates = [2, 4, 8] as const;
  let bestScale = 1;
  let bestBoundaryMean = -1;

  for (const s of candidates) {
    if (width < s * 3 || height < s * 3) continue;

    let boundaryEnergy = 0;
    let boundaryCuts = 0;
    let interiorEnergy = 0;

    for (let x = 1; x < width; x++) {
      const e = ex[x] ?? 0;
      if (x % s === 0) {
        boundaryEnergy += e;
        boundaryCuts++;
      } else {
        interiorEnergy += e;
      }
    }
    for (let y = 1; y < height; y++) {
      const e = ey[y] ?? 0;
      if (y % s === 0) {
        boundaryEnergy += e;
        boundaryCuts++;
      } else {
        interiorEnergy += e;
      }
    }

    if (boundaryCuts === 0) continue;
    const interiorRatio = interiorEnergy / totalEnergy;
    const boundaryMean = boundaryEnergy / boundaryCuts;

    if (interiorRatio <= 0.22 && boundaryMean > bestBoundaryMean) {
      bestBoundaryMean = boundaryMean;
      bestScale = s;
    }
  }

  return bestScale;
}

/**
 * Downsamples an upscaled pixel-art buffer by integer factor `scale` using deterministic
 * per-block mode pooling (majority exact RGBA tuple).
 */
export function downsampleModePool(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  scale: number,
): RgbaBuffer {
  const s = Math.max(1, Math.floor(scale));
  if (s <= 1) {
    return { width, height, data: new Uint8ClampedArray(rgba) };
  }

  const outW = Math.max(1, Math.floor(width / s));
  const outH = Math.max(1, Math.floor(height / s));
  const out = new Uint8ClampedArray(outW * outH * 4);
  const blockPixels = s * s;

  for (let by = 0; by < outH; by++) {
    for (let bx = 0; bx < outW; bx++) {
      const counts = new Map<number, number>();
      let transparentCount = 0;
      let bestKey = 0;
      let bestCount = 0;

      for (let dy = 0; dy < s; dy++) {
        const sy = by * s + dy;
        for (let dx = 0; dx < s; dx++) {
          const sx = bx * s + dx;
          const idx = (sy * width + sx) * 4;
          const a = rgba[idx + 3] ?? 0;
          if (a < 128) {
            transparentCount++;
            continue;
          }
          const r = rgba[idx] ?? 0;
          const g = rgba[idx + 1] ?? 0;
          const b = rgba[idx + 2] ?? 0;
          const packed = (((r & 0xff) << 24) | ((g & 0xff) << 16) | ((b & 0xff) << 8) | 255) >>> 0;
          const next = (counts.get(packed) ?? 0) + 1;
          counts.set(packed, next);
          if (next > bestCount) {
            bestCount = next;
            bestKey = packed;
          }
        }
      }

      const dst = (by * outW + bx) * 4;
      if (transparentCount > blockPixels / 2 || bestCount === 0) {
        out[dst] = 0;
        out[dst + 1] = 0;
        out[dst + 2] = 0;
        out[dst + 3] = 0;
      } else {
        out[dst] = (bestKey >>> 24) & 0xff;
        out[dst + 1] = (bestKey >>> 16) & 0xff;
        out[dst + 2] = (bestKey >>> 8) & 0xff;
        out[dst + 3] = 255;
      }
    }
  }

  return { width: outW, height: outH, data: out };
}

function upscaleNearest(
  rgba: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number,
): Uint8ClampedArray {
  if (srcW === dstW && srcH === dstH) {
    return new Uint8ClampedArray(rgba);
  }
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  for (let y = 0; y < dstH; y++) {
    const sy = Math.min(srcH - 1, Math.floor((y * srcH) / dstH));
    for (let x = 0; x < dstW; x++) {
      const sx = Math.min(srcW - 1, Math.floor((x * srcW) / dstW));
      const si = (sy * srcW + sx) * 4;
      const di = (y * dstW + x) * 4;
      out[di] = rgba[si] ?? 0;
      out[di + 1] = rgba[si + 1] ?? 0;
      out[di + 2] = rgba[si + 2] ?? 0;
      out[di + 3] = rgba[si + 3] ?? 0;
    }
  }
  return out;
}

/**
 * Snaps every opaque pixel (`alpha > 0`) to the nearest `ArtBible` swatch in OKLab space,
 * with optional 4x4 Bayer ordered dithering while leaving `alpha === 0` pixels byte-identical.
 */
export function quantizeToArtBibleOklab(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  paletteHex: readonly string[],
  opts: { readonly dither: 'none' | 'bayer4x4'; readonly ditherStrength?: number } = {
    dither: 'none',
  },
): Uint8ClampedArray {
  return quantizeToPaletteOklab(rgba, width, height, paletteHex, {
    dither: opts.dither === 'bayer4x4',
    ...(opts.ditherStrength !== undefined ? { ditherStrength: opts.ditherStrength } : {}),
  });
}

/**
 * Strips isolated opaque 1px speckles (`alpha > 0` with `< minNeighbors` opaque 8-neighbors).
 * Default `minNeighbors = 2` removes stray 1px noise and hairline tails while preserving every 2x2+ block.
 */
export function stripOrphanPixels(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  minNeighbors = 2,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  if (width <= 0 || height <= 0 || minNeighbors <= 0) return out;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if ((rgba[idx + 3] ?? 0) === 0) continue;

      let opaqueNeighbors = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          if (nx < 0 || nx >= width) continue;
          if ((rgba[(ny * width + nx) * 4 + 3] ?? 0) > 0) {
            opaqueNeighbors++;
          }
        }
      }

      if (opaqueNeighbors < minNeighbors) {
        out[idx] = 0;
        out[idx + 1] = 0;
        out[idx + 2] = 0;
        out[idx + 3] = 0;
      }
    }
  }

  return out;
}

/**
 * Runs the automatic pure-TS pixel-art cleanup pass: grid-scale detection + nearest normalization,
 * OKLab palette quantization against `ArtBible.palette`, and isolated 1px orphan stripping.
 */
export function runAutoPixelPolishPipeline(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  paletteHex: readonly string[],
  opts: PixelPolishOptions = {},
): PixelPolishResult {
  const detectedScale = detectPixelGridScale(rgba, width, height);
  let working: Uint8ClampedArray = new Uint8ClampedArray(rgba);

  if (detectedScale > 1) {
    const down = downsampleModePool(working, width, height, detectedScale);
    const cleanedDown = stripOrphanPixels(
      down.data,
      down.width,
      down.height,
      opts.minNeighbors ?? 2,
    );
    working = upscaleNearest(cleanedDown, down.width, down.height, width, height);
  }

  const quantized = quantizeToArtBibleOklab(working, width, height, paletteHex, {
    dither: opts.dither ?? 'none',
    ...(opts.ditherStrength !== undefined ? { ditherStrength: opts.ditherStrength } : {}),
  });

  const minNeighbors = opts.minNeighbors ?? 2;
  const finalData = stripOrphanPixels(quantized, width, height, minNeighbors);

  let initialOpaque = 0;
  let finalOpaque = 0;
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 0) > 0) initialOpaque++;
    if ((finalData[i] ?? 0) > 0) finalOpaque++;
  }
  const strippedPixels = Math.max(0, initialOpaque - finalOpaque);

  return {
    data: finalData,
    width,
    height,
    detectedScale,
    strippedPixels,
  };
}
