import type { RgbaBuffer } from './types';

export interface DemixelOptions {
  readonly minCellSize?: number; // default 2
  readonly maxCellSize?: number; // default 32
  readonly alphaThreshold?: number; // default 128
  readonly forceSquareCells?: boolean; // default true
  readonly manualCellSize?: number; // optional user override
}

export interface DetectedGrid {
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly confidence: number; // 0..1
}

function computeGradientProfiles(buf: RgbaBuffer): {
  ex: Float64Array;
  ey: Float64Array;
} {
  const { width, height, data } = buf;
  const ex = new Float64Array(width);
  const ey = new Float64Array(height);

  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      const i = (y * width + x) * 4;
      const p = i - 4;
      const diff =
        Math.abs((data[i] ?? 0) - (data[p] ?? 0)) +
        Math.abs((data[i + 1] ?? 0) - (data[p + 1] ?? 0)) +
        Math.abs((data[i + 2] ?? 0) - (data[p + 2] ?? 0)) +
        Math.abs((data[i + 3] ?? 0) - (data[p + 3] ?? 0));
      ex[x] = (ex[x] ?? 0) + diff;
    }
  }

  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const p = ((y - 1) * width + x) * 4;
      const diff =
        Math.abs((data[i] ?? 0) - (data[p] ?? 0)) +
        Math.abs((data[i + 1] ?? 0) - (data[p + 1] ?? 0)) +
        Math.abs((data[i + 2] ?? 0) - (data[p + 2] ?? 0)) +
        Math.abs((data[i + 3] ?? 0) - (data[p + 3] ?? 0));
      ey[y] = (ey[y] ?? 0) + diff;
    }
  }

  return { ex, ey };
}

function detectAxisPeriod(
  energy: Float64Array,
  minP: number,
  maxP: number,
): { period: number; offset: number; confidence: number } {
  const n = energy.length;
  if (n < minP * 2) return { period: 1, offset: 0, confidence: 0 };

  let mean = 0;
  for (let i = 0; i < n; i++) mean += energy[i] ?? 0;
  mean /= n;

  const centered = new Float64Array(n);
  let variance = 0;
  for (let i = 0; i < n; i++) {
    const v = (energy[i] ?? 0) - mean;
    centered[i] = v;
    variance += v * v;
  }
  if (variance <= 1e-9) return { period: 1, offset: 0, confidence: 0 };

  const clampedMax = Math.min(maxP, Math.floor(n / 3));
  if (clampedMax < minP) return { period: 1, offset: 0, confidence: 0 };

  const scores = new Float64Array(clampedMax + 1);
  let maxScore = -Infinity;
  let argMaxPeriod = minP;

  for (let p = minP; p <= clampedMax; p++) {
    let sum = 0;
    const count = n - p;
    for (let i = 0; i < count; i++) {
      sum += (centered[i] ?? 0) * (centered[i + p] ?? 0);
    }
    const score = sum / count / (variance / n);
    scores[p] = score;
    if (score > maxScore) {
      maxScore = score;
      argMaxPeriod = p;
    }
  }

  if (maxScore <= 0.05) return { period: 1, offset: 0, confidence: 0 };

  // Harmonic guard: prefer smallest local peak within 85% of global max
  let bestPeriod = argMaxPeriod;
  for (let p = minP; p <= clampedMax; p++) {
    const s = scores[p] ?? 0;
    const prev = p > minP ? (scores[p - 1] ?? -Infinity) : -Infinity;
    const next = p < clampedMax ? (scores[p + 1] ?? -Infinity) : -Infinity;
    if (s >= maxScore * 0.85 && s >= prev && s >= next) {
      bestPeriod = p;
      break;
    }
  }

  // Sweep integer phase offset maximizing average edge energy aligned on grid cuts
  let bestOffset = 0;
  let bestBoundaryEnergy = -1;
  for (let phi = 0; phi < bestPeriod; phi++) {
    let boundarySum = 0;
    let cuts = 0;
    for (let idx = phi; idx < n; idx += bestPeriod) {
      boundarySum += energy[idx] ?? 0;
      cuts++;
    }
    const avg = cuts > 0 ? boundarySum / cuts : 0;
    if (avg > bestBoundaryEnergy) {
      bestBoundaryEnergy = avg;
      bestOffset = phi;
    }
  }

  return {
    period: bestPeriod,
    offset: bestOffset,
    confidence: Math.max(0, Math.min(1, scores[bestPeriod] ?? 0)),
  };
}

function findOffsetForPeriod(energy: Float64Array, period: number): number {
  const n = energy.length;
  let bestOffset = 0;
  let bestAvg = -1;
  for (let phi = 0; phi < period; phi++) {
    let sum = 0;
    let cuts = 0;
    for (let idx = phi; idx < n; idx += period) {
      sum += energy[idx] ?? 0;
      cuts++;
    }
    const avg = cuts > 0 ? sum / cuts : 0;
    if (avg > bestAvg) {
      bestAvg = avg;
      bestOffset = phi;
    }
  }
  return bestOffset;
}

/**
 * Auto-detects the logical pixel grid `(cellWidth, cellHeight, offsetX, offsetY)`
 * via 1D L1 gradient autocorrelation + harmonic guard + phase sweep.
 */
export function detectPixelGrid(buf: RgbaBuffer, options: DemixelOptions = {}): DetectedGrid {
  const minP = Math.max(2, options.minCellSize ?? 2);
  const maxP = Math.max(minP, options.maxCellSize ?? 32);
  const forceSquare = options.forceSquareCells ?? true;

  if (buf.width <= 0 || buf.height <= 0) {
    return { cellWidth: 1, cellHeight: 1, offsetX: 0, offsetY: 0, confidence: 0 };
  }

  const { ex, ey } = computeGradientProfiles(buf);

  if (options.manualCellSize && options.manualCellSize >= 1) {
    const p = Math.round(options.manualCellSize);
    return {
      cellWidth: p,
      cellHeight: p,
      offsetX: p > 1 ? findOffsetForPeriod(ex, p) : 0,
      offsetY: p > 1 ? findOffsetForPeriod(ey, p) : 0,
      confidence: 1,
    };
  }

  const rx = detectAxisPeriod(ex, minP, maxP);
  const ry = detectAxisPeriod(ey, minP, maxP);

  if (forceSquare) {
    const chosen = rx.confidence >= ry.confidence ? rx.period : ry.period;
    return {
      cellWidth: chosen,
      cellHeight: chosen,
      offsetX: chosen > 1 ? findOffsetForPeriod(ex, chosen) : 0,
      offsetY: chosen > 1 ? findOffsetForPeriod(ey, chosen) : 0,
      confidence: Math.max(rx.confidence, ry.confidence),
    };
  }

  return {
    cellWidth: rx.period,
    cellHeight: ry.period,
    offsetX: rx.offset,
    offsetY: ry.offset,
    confidence: (rx.confidence + ry.confidence) / 2,
  };
}

/**
 * Re-rasterizes an image onto its detected or manually specified integer pixel grid,
 * trimming 1px seams when `cell >= 4` and choosing the dominant core mode color per cell.
 */
export function demixelBuffer(
  buf: RgbaBuffer,
  options: DemixelOptions = {},
): { buffer: RgbaBuffer; grid: DetectedGrid } {
  const grid = detectPixelGrid(buf, options);
  const alphaThreshold = options.alphaThreshold ?? 128;

  if (grid.cellWidth <= 1 && grid.cellHeight <= 1) {
    return {
      buffer: {
        width: buf.width,
        height: buf.height,
        data: new Uint8ClampedArray(buf.data),
      },
      grid,
    };
  }

  const outW = Math.max(1, Math.floor((buf.width - grid.offsetX) / grid.cellWidth));
  const outH = Math.max(1, Math.floor((buf.height - grid.offsetY) / grid.cellHeight));
  const out = new Uint8ClampedArray(outW * outH * 4);

  // Ignore 1px outer seam inside each cell when period >= 4 to discard AI edge anti-aliasing
  const marginX = grid.cellWidth >= 4 ? 1 : 0;
  const marginY = grid.cellHeight >= 4 ? 1 : 0;

  for (let gy = 0; gy < outH; gy++) {
    const y0 = grid.offsetY + gy * grid.cellHeight + marginY;
    const y1 = Math.min(buf.height, grid.offsetY + (gy + 1) * grid.cellHeight - marginY);

    for (let gx = 0; gx < outW; gx++) {
      const x0 = grid.offsetX + gx * grid.cellWidth + marginX;
      const x1 = Math.min(buf.width, grid.offsetX + (gx + 1) * grid.cellWidth - marginX);

      let total = 0;
      let opaque = 0;
      const bucketCounts = new Map<number, { count: number; r: number; g: number; b: number }>();

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * buf.width + x) * 4;
          const a = buf.data[i + 3] ?? 0;
          total++;
          if (a >= alphaThreshold) {
            opaque++;
            const r = buf.data[i] ?? 0;
            const g = buf.data[i + 1] ?? 0;
            const b = buf.data[i + 2] ?? 0;
            const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
            const entry = bucketCounts.get(key);
            if (entry) {
              entry.count++;
              entry.r += r;
              entry.g += g;
              entry.b += b;
            } else {
              bucketCounts.set(key, { count: 1, r, g, b });
            }
          }
        }
      }

      const dst = (gy * outW + gx) * 4;
      if (total === 0 || opaque * 2 < total) {
        out[dst] = 0;
        out[dst + 1] = 0;
        out[dst + 2] = 0;
        out[dst + 3] = 0;
        continue;
      }

      let best = { count: -1, r: 0, g: 0, b: 0 };
      for (const entry of bucketCounts.values()) {
        if (entry.count > best.count) best = entry;
      }

      out[dst] = Math.round(best.r / best.count);
      out[dst + 1] = Math.round(best.g / best.count);
      out[dst + 2] = Math.round(best.b / best.count);
      out[dst + 3] = 255;
    }
  }

  return { buffer: { width: outW, height: outH, data: out }, grid };
}
