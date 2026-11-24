import { parseHexRgb } from './backgroundKey';
import type { RgbaBuffer } from './types';

export const BIT_N = 1;
export const BIT_NE = 2;
export const BIT_E = 4;
export const BIT_SE = 8;
export const BIT_S = 16;
export const BIT_SW = 32;
export const BIT_W = 64;
export const BIT_NW = 128;

export type AutoTileMode = 'blob-47' | 'wang-16';
export type AutoTileEdgeStyle = 'crisp-bevel' | 'organic-overhang' | 'pixel-outline';

export interface AutoTileOptions {
  readonly mode: AutoTileMode;
  readonly edgeStyle: AutoTileEdgeStyle;
  readonly borderWidthPx: number;
  readonly cornerRadiusPx: number;
  readonly jitterPx: number;
  readonly edgeTintHex: string;
  readonly seed: number;
}

export interface AutoTileAtlasCell {
  readonly index: number;
  readonly mask: number;
  readonly col: number;
  readonly row: number;
}

export interface AutoTileSheetResult {
  readonly sheet: RgbaBuffer;
  readonly tileSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly cells: readonly AutoTileAtlasCell[];
  readonly maskToCellIndex: Readonly<Record<number, number>>;
}

/**
 * Strips redundant diagonal bits whose adjacent orthogonal cardinal bits are not both set,
 * collapsing 256 raw 8-neighbor combinations into the canonical 47-tile Blob set.
 */
export function gateBlobMask(rawMask: number): number {
  const cardinals = rawMask & (BIT_N | BIT_E | BIT_S | BIT_W);
  let gated = cardinals;

  if ((cardinals & BIT_N) !== 0 && (cardinals & BIT_E) !== 0 && (rawMask & BIT_NE) !== 0) {
    gated |= BIT_NE;
  }
  if ((cardinals & BIT_E) !== 0 && (cardinals & BIT_S) !== 0 && (rawMask & BIT_SE) !== 0) {
    gated |= BIT_SE;
  }
  if ((cardinals & BIT_S) !== 0 && (cardinals & BIT_W) !== 0 && (rawMask & BIT_SW) !== 0) {
    gated |= BIT_SW;
  }
  if ((cardinals & BIT_W) !== 0 && (cardinals & BIT_N) !== 0 && (rawMask & BIT_NW) !== 0) {
    gated |= BIT_NW;
  }

  return gated;
}

/**
 * Returns the 47 canonical Blob bitmasks sorted ascending.
 */
export function getCanonicalBlob47Masks(): number[] {
  const unique = new Set<number>();
  for (let raw = 0; raw < 256; raw++) {
    unique.add(gateBlobMask(raw));
  }
  return [...unique].sort((a, b) => a - b);
}

/**
 * Returns the 16 canonical 4-corner Wang bitmasks (`0..15`, where NW=8, NE=4, SE=2, SW=1).
 */
export function getCanonicalWang16Masks(): number[] {
  return Array.from({ length: 16 }, (_, i) => i);
}

function hash2d(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/**
 * Computes the terrain auto-tile bitmask at cell `(cx, cy)` inside a `cols × rows` boolean grid.
 */
export function computeAutoTileGridMask(
  grid: readonly boolean[],
  cols: number,
  rows: number,
  cx: number,
  cy: number,
  mode: AutoTileMode,
): number {
  const filled = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= cols || y >= rows) return false;
    return Boolean(grid[y * cols + x]);
  };

  if (mode === 'wang-16') {
    const nw = filled(cx, cy) ? 8 : 0;
    const ne = filled(cx + 1, cy) ? 4 : 0;
    const se = filled(cx + 1, cy + 1) ? 2 : 0;
    const sw = filled(cx, cy + 1) ? 1 : 0;
    return nw | ne | se | sw;
  }

  let raw = 0;
  if (filled(cx, cy - 1)) raw |= BIT_N;
  if (filled(cx + 1, cy - 1)) raw |= BIT_NE;
  if (filled(cx + 1, cy)) raw |= BIT_E;
  if (filled(cx + 1, cy + 1)) raw |= BIT_SE;
  if (filled(cx, cy + 1)) raw |= BIT_S;
  if (filled(cx - 1, cy + 1)) raw |= BIT_SW;
  if (filled(cx - 1, cy)) raw |= BIT_W;
  if (filled(cx - 1, cy - 1)) raw |= BIT_NW;
  return gateBlobMask(raw);
}

function evaluateBlobSdf(
  px: number,
  py: number,
  tileSize: number,
  mask: number,
  borderWidthPx: number,
  cornerRadiusPx: number,
): number {
  if (mask === 255) {
    return Infinity;
  }

  const u = px + 0.5;
  const v = py + 0.5;
  const B = Math.max(0, Math.min(tileSize * 0.45, borderWidthPx));
  const R = Math.max(0.5, Math.min(tileSize * 0.48, cornerRadiusPx));

  const hasN = (mask & BIT_N) !== 0;
  const hasNE = (mask & BIT_NE) !== 0;
  const hasE = (mask & BIT_E) !== 0;
  const hasSE = (mask & BIT_SE) !== 0;
  const hasS = (mask & BIT_S) !== 0;
  const hasSW = (mask & BIT_SW) !== 0;
  const hasW = (mask & BIT_W) !== 0;
  const hasNW = (mask & BIT_NW) !== 0;

  let d = Math.min(
    hasN ? Infinity : v - B,
    hasS ? Infinity : tileSize - v - B,
    hasW ? Infinity : u - B,
    hasE ? Infinity : tileSize - u - B,
  );

  // Outer convex rounded corners where adjacent cardinal edges are open
  if (!hasN && !hasW && u < B + R && v < B + R) {
    d = Math.min(d, R - Math.hypot(u - (B + R), v - (B + R)));
  }
  if (!hasN && !hasE && u > tileSize - B - R && v < B + R) {
    d = Math.min(d, R - Math.hypot(tileSize - B - R - u, v - (B + R)));
  }
  if (!hasS && !hasW && u < B + R && v > tileSize - B - R) {
    d = Math.min(d, R - Math.hypot(u - (B + R), tileSize - B - R - v));
  }
  if (!hasS && !hasE && u > tileSize - B - R && v > tileSize - B - R) {
    d = Math.min(d, R - Math.hypot(tileSize - B - R - u, tileSize - B - R - v));
  }

  // Inner concave corner cutouts when both adjacent cardinals connect but the diagonal is open
  const notchR = Math.max(1, B);
  if (hasN && hasW && !hasNW) {
    d = Math.min(d, Math.hypot(u, v) - notchR);
  }
  if (hasN && hasE && !hasNE) {
    d = Math.min(d, Math.hypot(tileSize - u, v) - notchR);
  }
  if (hasS && hasW && !hasSW) {
    d = Math.min(d, Math.hypot(u, tileSize - v) - notchR);
  }
  if (hasS && hasE && !hasSE) {
    d = Math.min(d, Math.hypot(tileSize - u, tileSize - v) - notchR);
  }

  return d;
}

function evaluateWang16Sdf(
  px: number,
  py: number,
  tileSize: number,
  mask: number,
  borderWidthPx: number,
): number {
  if (mask === 0) return -Infinity;
  if (mask === 15) return Infinity;

  const hasNW = (mask & 8) !== 0 ? 1 : 0;
  const hasNE = (mask & 4) !== 0 ? 1 : 0;
  const hasSE = (mask & 2) !== 0 ? 1 : 0;
  const hasSW = (mask & 1) !== 0 ? 1 : 0;

  const fx = (px + 0.5) / tileSize;
  const fy = (py + 0.5) / tileSize;
  const val =
    hasNW * (1 - fx) * (1 - fy) + hasNE * fx * (1 - fy) + hasSE * fx * fy + hasSW * (1 - fx) * fy;

  const insetRatio = Math.min(0.18, Math.max(0, borderWidthPx / Math.max(1, tileSize)) * 0.35);
  return (val - (0.5 + insetRatio)) * tileSize;
}

function blendChannel(a: number, b: number, t: number): number {
  return Math.max(0, Math.min(255, Math.round(a + (b - a) * t)));
}

/**
 * Deterministically composes a packed auto-tile sprite sheet (`blob-47` in `8×6` or `wang-16` in `4×4`)
 * using pure-TS SDF edge masking over a seamless square fill tile and optional underlay tile.
 */
export function composeAutoTileSheet(
  fillTile: RgbaBuffer,
  underlayTile: RgbaBuffer | null,
  options: AutoTileOptions,
): AutoTileSheetResult {
  if (fillTile.width <= 0 || fillTile.height <= 0) {
    throw new Error('Auto-tile fill tile must have positive width and height.');
  }
  if (fillTile.width !== fillTile.height) {
    throw new Error(
      `Auto-tile requires a square fill tile, received ${fillTile.width}×${fillTile.height}.`,
    );
  }
  if (fillTile.data.length < fillTile.width * fillTile.height * 4) {
    throw new Error('Fill tile RGBA buffer is shorter than width * height * 4.');
  }
  if (underlayTile && (underlayTile.width <= 0 || underlayTile.height <= 0)) {
    throw new Error('Auto-tile underlay tile must have positive width and height.');
  }

  const tileSize = fillTile.width;
  const isBlob = options.mode === 'blob-47';
  const masks = isBlob ? getCanonicalBlob47Masks() : getCanonicalWang16Masks();
  const columns = isBlob ? 8 : 4;
  const rows = isBlob ? 6 : 4;

  const sheetW = columns * tileSize;
  const sheetH = rows * tileSize;
  const out = new Uint8ClampedArray(sheetW * sheetH * 4);
  const edgeTint = parseHexRgb(options.edgeTintHex);

  const cells: AutoTileAtlasCell[] = [];
  const maskToCellIndex: Record<number, number> = {};

  for (let idx = 0; idx < masks.length; idx++) {
    const mask = masks[idx]!;
    const col = idx % columns;
    const row = Math.floor(idx / columns);
    cells.push({ index: idx, mask, col, row });
    maskToCellIndex[mask] = idx;

    const originX = col * tileSize;
    const originY = row * tileSize;
    const rowStride = tileSize * 4;

    if ((isBlob && mask === 255) || (!isBlob && mask === 15)) {
      for (let py = 0; py < tileSize; py++) {
        const srcRow = fillTile.data.subarray(py * rowStride, (py + 1) * rowStride);
        out.set(srcRow, ((originY + py) * sheetW + originX) * 4);
      }
      continue;
    }

    if (!isBlob && mask === 0 && !underlayTile) {
      continue;
    }

    const topExposed = isBlob ? (mask & BIT_N) === 0 : (mask & 12) !== 12;

    for (let py = 0; py < tileSize; py++) {
      for (let px = 0; px < tileSize; px++) {
        const rawD = isBlob
          ? evaluateBlobSdf(px, py, tileSize, mask, options.borderWidthPx, options.cornerRadiusPx)
          : evaluateWang16Sdf(px, py, tileSize, mask, options.borderWidthPx);

        let d = rawD;
        if (options.edgeStyle === 'organic-overhang' && Number.isFinite(rawD)) {
          const jitter =
            (hash2d(
              Math.floor(px / 2) + col * tileSize,
              Math.floor(py / 2) + row * tileSize,
              options.seed,
            ) -
              0.5) *
            2 *
            Math.max(0, options.jitterPx);
          d = rawD + jitter;
        }

        const outIdx = ((originY + py) * sheetW + (originX + px)) * 4;

        if (d < 0) {
          if (underlayTile) {
            const ux = px % underlayTile.width;
            const uy = py % underlayTile.height;
            const uIdx = (uy * underlayTile.width + ux) * 4;
            out[outIdx] = underlayTile.data[uIdx] ?? 0;
            out[outIdx + 1] = underlayTile.data[uIdx + 1] ?? 0;
            out[outIdx + 2] = underlayTile.data[uIdx + 2] ?? 0;
            out[outIdx + 3] = underlayTile.data[uIdx + 3] ?? 255;
          }
          continue;
        }

        const fIdx = (py * tileSize + px) * 4;
        const fr = fillTile.data[fIdx] ?? 0;
        const fg = fillTile.data[fIdx + 1] ?? 0;
        const fb = fillTile.data[fIdx + 2] ?? 0;
        const fa = fillTile.data[fIdx + 3] ?? 255;

        if (Number.isFinite(d)) {
          if (options.edgeStyle === 'pixel-outline' && d < 1.25) {
            out[outIdx] = edgeTint.r;
            out[outIdx + 1] = edgeTint.g;
            out[outIdx + 2] = edgeTint.b;
            out[outIdx + 3] = 255;
            continue;
          }
          if (options.edgeStyle === 'crisp-bevel' && d < 2.2) {
            const isTopOrLeft = py < tileSize * 0.5 || px < tileSize * 0.5;
            if (isTopOrLeft && topExposed) {
              out[outIdx] = Math.min(255, fr + 28);
              out[outIdx + 1] = Math.min(255, fg + 28);
              out[outIdx + 2] = Math.min(255, fb + 28);
            } else {
              out[outIdx] = blendChannel(fr, edgeTint.r, 0.55);
              out[outIdx + 1] = blendChannel(fg, edgeTint.g, 0.55);
              out[outIdx + 2] = blendChannel(fb, edgeTint.b, 0.55);
            }
            out[outIdx + 3] = fa;
            continue;
          }
          if (options.edgeStyle === 'organic-overhang' && d < 1.35) {
            out[outIdx] = blendChannel(fr, edgeTint.r, 0.42);
            out[outIdx + 1] = blendChannel(fg, edgeTint.g, 0.42);
            out[outIdx + 2] = blendChannel(fb, edgeTint.b, 0.42);
            out[outIdx + 3] = fa;
            continue;
          }
        }

        out[outIdx] = fr;
        out[outIdx + 1] = fg;
        out[outIdx + 2] = fb;
        out[outIdx + 3] = fa;
      }
    }
  }

  return {
    sheet: { width: sheetW, height: sheetH, data: out },
    tileSize,
    columns,
    rows,
    cells,
    maskToCellIndex,
  };
}
