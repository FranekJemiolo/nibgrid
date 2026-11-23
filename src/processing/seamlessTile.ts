import type { RgbaBuffer } from './types';

export interface SeamMaskOptions {
  readonly seamWidthPx: number; // total band width across the seam, e.g., 16..96
  readonly jitterPx?: number; // deterministic wavy edge (0..12) to avoid straight AI patch lines
  readonly tileX?: boolean; // default true (horizontal wrap)
  readonly tileY?: boolean; // default true (vertical wrap)
  readonly seed?: number; // deterministic jitter seed
}

export interface SeamContinuityReport {
  readonly horizontalDelta: number; // mean L1 RGB diff (0..255) between left & right edges
  readonly verticalDelta: number; // mean L1 RGB diff (0..255) between top & bottom edges
  readonly score: number; // 0..100 (100 = mathematically identical border transition)
}

/**
 * Toroidal wrap-offset shift. Passing `inverse = true` exact-reverses forward shifts
 * cleanly even on odd-dimension canvases.
 */
export function wrapOffsetBuffer(
  buf: RgbaBuffer,
  dx = Math.floor(buf.width / 2),
  dy = Math.floor(buf.height / 2),
  inverse = false,
): RgbaBuffer {
  const { width, height, data } = buf;
  const out = new Uint8ClampedArray(width * height * 4);
  if (width <= 0 || height <= 0) {
    return { width, height, data: out };
  }

  const shiftX = (((inverse ? -dx : dx) % width) + width) % width;
  const shiftY = (((inverse ? -dy : dy) % height) + height) % height;

  for (let y = 0; y < height; y++) {
    const dstY = (y + shiftY) % height;
    for (let x = 0; x < width; x++) {
      const dstX = (x + shiftX) % width;
      const si = (y * width + x) * 4;
      const di = (dstY * width + dstX) * 4;
      out[di] = data[si] ?? 0;
      out[di + 1] = data[si + 1] ?? 0;
      out[di + 2] = data[si + 2] ?? 0;
      out[di + 3] = data[si + 3] ?? 0;
    }
  }

  return { width, height, data: out };
}

/**
 * Generates a binary RGBA inpaint mask (`255` = heal seam, `0` = preserve, alpha = `255`)
 * strictly over the wrapped center cross-seam while locking the outer 2px border untouched.
 */
export function generateCrossSeamMask(
  width: number,
  height: number,
  options: SeamMaskOptions,
): RgbaBuffer {
  const w = Math.max(1, Math.floor(width));
  const h = Math.max(1, Math.floor(height));
  const tileX = options.tileX ?? true;
  const tileY = options.tileY ?? true;
  const halfBand = Math.max(2, Math.floor(options.seamWidthPx / 2));
  const jitter = Math.max(0, options.jitterPx ?? 4);
  const seed = options.seed ?? 1337;

  const cx = Math.floor(w / 2);
  const cy = Math.floor(h / 2);
  const data = new Uint8ClampedArray(w * h * 4);

  const wave = (coord: number, span: number, phase: number): number => {
    if (jitter === 0) return 0;
    const t = (coord / Math.max(1, span)) * Math.PI * 2;
    return Math.round(
      jitter * (0.6 * Math.sin(t * 3 + phase) + 0.4 * Math.cos(t * 7 - phase * 1.3)),
    );
  };

  for (let y = 0; y < h; y++) {
    const jx = wave(y, h, seed * 0.17);
    for (let x = 0; x < w; x++) {
      const jy = wave(x, w, seed * 0.31);
      const inVertSeam = tileX && Math.abs(x - cx) <= halfBand + jx;
      const inHorizSeam = tileY && Math.abs(y - cy) <= halfBand + jy;

      const onOuterLock = x < 2 || x >= w - 2 || y < 2 || y >= h - 2;
      const masked = (inVertSeam || inHorizSeam) && !onOuterLock;

      const i = (y * w + x) * 4;
      const v = masked ? 255 : 0;
      data[i] = v;
      data[i + 1] = v;
      data[i + 2] = v;
      data[i + 3] = 255;
    }
  }

  return { width: w, height: h, data };
}

/**
 * Quantifies border discontinuity by comparing opposite edge pixel pairs
 * (`left` vs `right`, `top` vs `bottom`).
 */
export function computeSeamContinuity(buf: RgbaBuffer): SeamContinuityReport {
  const { width, height, data } = buf;
  if (width <= 0 || height <= 0) {
    return { horizontalDelta: 0, verticalDelta: 0, score: 100 };
  }

  let hSum = 0;
  let vSum = 0;

  for (let y = 0; y < height; y++) {
    const left = y * width * 4;
    const right = (y * width + (width - 1)) * 4;
    hSum +=
      (Math.abs((data[left] ?? 0) - (data[right] ?? 0)) +
        Math.abs((data[left + 1] ?? 0) - (data[right + 1] ?? 0)) +
        Math.abs((data[left + 2] ?? 0) - (data[right + 2] ?? 0))) /
      3;
  }

  for (let x = 0; x < width; x++) {
    const top = x * 4;
    const bottom = ((height - 1) * width + x) * 4;
    vSum +=
      (Math.abs((data[top] ?? 0) - (data[bottom] ?? 0)) +
        Math.abs((data[top + 1] ?? 0) - (data[bottom + 1] ?? 0)) +
        Math.abs((data[top + 2] ?? 0) - (data[bottom + 2] ?? 0))) /
      3;
  }

  const horizontalDelta = height > 0 ? hSum / height : 0;
  const verticalDelta = width > 0 ? vSum / width : 0;
  const avgDelta = (horizontalDelta + verticalDelta) * 0.5;
  const score = Math.max(0, Math.min(100, Math.round(100 - avgDelta * 1.25)));

  return { horizontalDelta, verticalDelta, score };
}

/**
 * Optional high-pass luminance equalizer that subtracts a clamped local box-blurred
 * luminance field and restores global mean luminance, removing macro lighting gradients
 * across opposite edges before wrap/inpaint.
 */
export function flattenMacroLighting(buf: RgbaBuffer, radiusPx = 12): RgbaBuffer {
  const { width, height, data } = buf;
  const out = new Uint8ClampedArray(data);
  if (width <= 1 || height <= 1 || radiusPx <= 0) {
    return { width, height, data: out };
  }

  const count = width * height;
  const luma = new Float32Array(count);
  const alphaWeight = new Float32Array(count);
  let totalLuma = 0;
  let totalWeight = 0;

  for (let i = 0; i < count; i++) {
    const p = i * 4;
    const a = (data[p + 3] ?? 0) / 255;
    const lum = 0.2126 * (data[p] ?? 0) + 0.7152 * (data[p + 1] ?? 0) + 0.0722 * (data[p + 2] ?? 0);
    luma[i] = lum * a;
    alphaWeight[i] = a;
    totalLuma += luma[i]!;
    totalWeight += a;
  }

  if (totalWeight <= 1e-6) {
    return { width, height, data: out };
  }
  const globalMeanLuma = totalLuma / totalWeight;
  const r = Math.min(Math.max(1, Math.floor(radiusPx)), Math.floor(Math.max(width, height) / 2));

  // Separable clamped horizontal pass so left/right borders keep distinct local brightness estimates
  const hLum = new Float32Array(count);
  const hW = new Float32Array(count);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let sL = 0;
      let sW = 0;
      for (let k = -r; k <= r; k++) {
        const sx = Math.max(0, Math.min(width - 1, x + k));
        sL += luma[row + sx] ?? 0;
        sW += alphaWeight[row + sx] ?? 0;
      }
      hLum[row + x] = sL;
      hW[row + x] = sW;
    }
  }

  // Clamped vertical pass + luminance shift
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const p = idx * 4;
      if ((data[p + 3] ?? 0) === 0) continue;

      let sL = 0;
      let sW = 0;
      for (let k = -r; k <= r; k++) {
        const sy = Math.max(0, Math.min(height - 1, y + k));
        const off = sy * width + x;
        sL += hLum[off] ?? 0;
        sW += hW[off] ?? 0;
      }

      if (sW <= 1e-6) continue;
      const localMean = sL / sW;
      const delta = globalMeanLuma - localMean;
      out[p] = Math.max(0, Math.min(255, Math.round((data[p] ?? 0) + delta)));
      out[p + 1] = Math.max(0, Math.min(255, Math.round((data[p + 1] ?? 0) + delta)));
      out[p + 2] = Math.max(0, Math.min(255, Math.round((data[p + 2] ?? 0) + delta)));
    }
  }

  return { width, height, data: out };
}
