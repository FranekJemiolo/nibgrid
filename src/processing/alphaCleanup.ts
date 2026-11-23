import type { ErosionConnectivity } from '../domain/schemas';

/**
 * Eliminates translucent fringe pixels whose alpha falls strictly below `threshold`.
 */
export function applyAlphaThreshold(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  threshold: number,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  if (threshold <= 0) return out;
  const pixelCount = width * height;

  for (let i = 0; i < pixelCount; i++) {
    const px = i * 4;
    const a = out[px + 3] ?? 0;
    if (a < threshold) {
      out[px] = 0;
      out[px + 1] = 0;
      out[px + 2] = 0;
      out[px + 3] = 0;
    }
  }
  return out;
}

/**
 * Applies morphological alpha erosion by `radius` passes (0..2) using 4- or 8-connectivity.
 */
export function erodeAlphaMask(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  radius: number,
  connectivity: ErosionConnectivity = '4-connected',
): Uint8ClampedArray {
  let current = new Uint8ClampedArray(rgba);
  const passes = Math.max(0, Math.min(2, Math.floor(radius)));
  if (passes === 0) return current;

  const offsets4: readonly [number, number][] = [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ];
  const offsets8: readonly [number, number][] = [...offsets4, [-1, -1], [1, -1], [-1, 1], [1, 1]];
  const neighbors = connectivity === '8-connected' ? offsets8 : offsets4;

  for (let pass = 0; pass < passes; pass++) {
    const next = new Uint8ClampedArray(current);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const px = (y * width + x) * 4;
        if ((current[px + 3] ?? 0) === 0) continue;

        let shouldErode = x === 0 || y === 0 || x === width - 1 || y === height - 1;
        if (!shouldErode) {
          for (const [dx, dy] of neighbors) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) {
              shouldErode = true;
              break;
            }
            const nAlpha = current[(ny * width + nx) * 4 + 3] ?? 0;
            if (nAlpha === 0) {
              shouldErode = true;
              break;
            }
          }
        }

        if (shouldErode) {
          next[px] = 0;
          next[px + 1] = 0;
          next[px + 2] = 0;
          next[px + 3] = 0;
        }
      }
    }
    current = next;
  }

  return current;
}

/**
 * Color-decontaminates semi-transparent edge pixels (0 < alpha < 255) by replacing
 * their RGB channels with the inverse-distance weighted average RGB of nearby opaque
 * interior pixels (alpha === 255) within `searchRadius` (default 2px).
 */
export function defringeInteriorRgb(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  searchRadius = 2,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(rgba);
  const rLimit = Math.max(1, Math.min(4, Math.floor(searchRadius)));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      const alpha = rgba[px + 3] ?? 0;
      if (alpha === 0 || alpha === 255) continue;

      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      let totalWeight = 0;

      const minY = Math.max(0, y - rLimit);
      const maxY = Math.min(height - 1, y + rLimit);
      const minX = Math.max(0, x - rLimit);
      const maxX = Math.min(width - 1, x + rLimit);

      for (let ny = minY; ny <= maxY; ny++) {
        for (let nx = minX; nx <= maxX; nx++) {
          if (nx === x && ny === y) continue;
          const nPx = (ny * width + nx) * 4;
          if ((rgba[nPx + 3] ?? 0) !== 255) continue;
          const dist2 = (nx - x) * (nx - x) + (ny - y) * (ny - y);
          const weight = 1 / dist2;
          sumR += (rgba[nPx] ?? 0) * weight;
          sumG += (rgba[nPx + 1] ?? 0) * weight;
          sumB += (rgba[nPx + 2] ?? 0) * weight;
          totalWeight += weight;
        }
      }

      if (totalWeight > 0) {
        out[px] = Math.round(sumR / totalWeight);
        out[px + 1] = Math.round(sumG / totalWeight);
        out[px + 2] = Math.round(sumB / totalWeight);
      }
    }
  }

  return out;
}
