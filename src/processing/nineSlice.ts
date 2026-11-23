import type { NineSliceCenterMode, NineSliceFillMode } from '../domain/schemas';
import type { RgbaBuffer } from './types';

export type SliceFillMode = NineSliceFillMode;

export interface NineSliceMargins {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

export interface NineSliceRenderConfig extends NineSliceMargins {
  readonly edgeMode: SliceFillMode;
  readonly centerMode: NineSliceCenterMode;
}

/**
 * Computes average L1 RGBA delta between two columns (`axis === 'x'`) or rows (`axis === 'y'`),
 * optionally restricted to the outer border strips so patterned interiors do not obscure
 * corner-to-border transitions.
 */
function lineDelta(
  buf: RgbaBuffer,
  axis: 'x' | 'y',
  aIdx: number,
  bIdx: number,
  borderBandOnly: boolean,
): number {
  const { width, height, data } = buf;
  if (axis === 'x') {
    const band = borderBandOnly ? Math.min(4, Math.max(1, Math.floor(height * 0.2))) : height;
    let sum = 0;
    let count = 0;
    for (let y = 0; y < height; y++) {
      if (borderBandOnly && y >= band && y < height - band) continue;
      const a = (y * width + aIdx) * 4;
      const b = (y * width + bIdx) * 4;
      sum +=
        Math.abs((data[a] ?? 0) - (data[b] ?? 0)) +
        Math.abs((data[a + 1] ?? 0) - (data[b + 1] ?? 0)) +
        Math.abs((data[a + 2] ?? 0) - (data[b + 2] ?? 0)) +
        Math.abs((data[a + 3] ?? 0) - (data[b + 3] ?? 0));
      count += 4;
    }
    return count > 0 ? sum / count : 0;
  }

  const band = borderBandOnly ? Math.min(4, Math.max(1, Math.floor(width * 0.2))) : width;
  let sum = 0;
  let count = 0;
  for (let x = 0; x < width; x++) {
    if (borderBandOnly && x >= band && x < width - band) continue;
    const a = (aIdx * width + x) * 4;
    const b = (bIdx * width + x) * 4;
    sum +=
      Math.abs((data[a] ?? 0) - (data[b] ?? 0)) +
      Math.abs((data[a + 1] ?? 0) - (data[b + 1] ?? 0)) +
      Math.abs((data[a + 2] ?? 0) - (data[b + 2] ?? 0)) +
      Math.abs((data[a + 3] ?? 0) - (data[b + 3] ?? 0));
    count += 4;
  }
  return count > 0 ? sum / count : 0;
}

function detectSideMargin(
  buf: RgbaBuffer,
  axis: 'x' | 'y',
  fromEnd: boolean,
  deltaThreshold: number,
): number {
  const span = axis === 'x' ? buf.width : buf.height;
  const maxMargin = Math.max(1, Math.floor(span * 0.45));
  if (span < 4) return 1;

  const coord = (offset: number): number => (fromEnd ? span - 1 - offset : offset);

  // Measure outer border bands first so patterned interiors don't look like continuous corner bevels,
  // then fall back to full line delta when outer edge rows/cols are completely flat.
  for (const borderOnly of [true, false]) {
    const startDelta = lineDelta(buf, axis, coord(0), coord(1), borderOnly);

    // Ornate/gradient corner bevels vary immediately near edge -> stop where consecutive lines settle
    if (startDelta > deltaThreshold) {
      for (let i = 1; i < maxMargin; i++) {
        if (lineDelta(buf, axis, coord(i), coord(i + 1), borderOnly) <= deltaThreshold) {
          return i;
        }
      }
      return Math.min(8, maxMargin);
    }

    // Flat solid corner block -> find the transition step where corner meets the repeatable border
    for (let i = 1; i < maxMargin; i++) {
      if (lineDelta(buf, axis, coord(i - 1), coord(i), borderOnly) > deltaThreshold) {
        return i;
      }
    }
  }

  return Math.min(8, maxMargin);
}

/**
 * Estimates 9-slice margins by scanning inward from each edge to identify
 * where corner ornamentation ends and repeatable straight borders begin.
 */
export function autoDetectNineSliceMargins(buf: RgbaBuffer, deltaThreshold = 6): NineSliceMargins {
  return {
    left: detectSideMargin(buf, 'x', false, deltaThreshold),
    right: detectSideMargin(buf, 'x', true, deltaThreshold),
    top: detectSideMargin(buf, 'y', false, deltaThreshold),
    bottom: detectSideMargin(buf, 'y', true, deltaThreshold),
  };
}

/**
 * Pure-TS deterministic 9-slice renderer (nearest-neighbor) for live stress-testing
 * and Vitest corner-preservation invariant checks.
 */
export function renderNineSlice(
  src: RgbaBuffer,
  targetW: number,
  targetH: number,
  cfg: NineSliceRenderConfig,
): RgbaBuffer {
  const { width: sw, height: sh, data: sdata } = src;
  const outW = Math.max(1, Math.floor(targetW));
  const outH = Math.max(1, Math.floor(targetH));
  const out = new Uint8ClampedArray(outW * outH * 4);
  if (sw <= 0 || sh <= 0) {
    return { width: outW, height: outH, data: out };
  }

  const clampedL = Math.max(0, Math.min(cfg.left, sw - 1));
  const clampedR = Math.max(0, Math.min(cfg.right, sw - 1 - clampedL));
  const clampedT = Math.max(0, Math.min(cfg.top, sh - 1));
  const clampedB = Math.max(0, Math.min(cfg.bottom, sh - 1 - clampedT));

  const srcMidW = Math.max(1, sw - clampedL - clampedR);
  const srcMidH = Math.max(1, sh - clampedT - clampedB);
  const dstMidW = Math.max(0, outW - clampedL - clampedR);
  const dstMidH = Math.max(0, outH - clampedT - clampedB);

  const effL = outW >= clampedL + clampedR ? clampedL : Math.floor(outW / 2);
  const effR = outW >= clampedL + clampedR ? clampedR : outW - effL;
  const effT = outH >= clampedT + clampedB ? clampedT : Math.floor(outH / 2);
  const effB = outH >= clampedT + clampedB ? clampedB : outH - effT;

  const mapAxis = (
    dst: number,
    dstLen: number,
    lead: number,
    trail: number,
    srcLead: number,
    srcLen: number,
    srcMid: number,
    dstMid: number,
    mode: SliceFillMode,
  ): { coord: number; region: 'lead' | 'mid' | 'trail' } => {
    if (dst < lead) {
      return { coord: Math.min(dst, Math.max(0, srcLead - 1)), region: 'lead' };
    }
    if (dst >= dstLen - trail) {
      const fromRight = dstLen - dst;
      return { coord: Math.max(0, Math.min(srcLen - 1, srcLen - fromRight)), region: 'trail' };
    }
    const local = dst - lead;
    const mapped =
      mode === 'tile'
        ? srcLead + (local % srcMid)
        : srcLead + Math.min(srcMid - 1, Math.floor((local * srcMid) / Math.max(1, dstMid)));
    return { coord: Math.max(0, Math.min(srcLen - 1, mapped)), region: 'mid' };
  };

  const centerMode = cfg.centerMode;
  for (let dy = 0; dy < outH; dy++) {
    const my = mapAxis(dy, outH, effT, effB, clampedT, sh, srcMidH, dstMidH, cfg.edgeMode);
    for (let dx = 0; dx < outW; dx++) {
      const mx = mapAxis(dx, outW, effL, effR, clampedL, sw, srcMidW, dstMidW, cfg.edgeMode);
      const isCenter = mx.region === 'mid' && my.region === 'mid';

      let sx = mx.coord;
      let sy = my.coord;
      if (isCenter) {
        if (centerMode === 'transparent') continue;
        if (centerMode !== cfg.edgeMode) {
          sx = mapAxis(dx, outW, effL, effR, clampedL, sw, srcMidW, dstMidW, centerMode).coord;
          sy = mapAxis(dy, outH, effT, effB, clampedT, sh, srcMidH, dstMidH, centerMode).coord;
        }
      }

      const si = (sy * sw + sx) * 4;
      const di = (dy * outW + dx) * 4;
      out[di] = sdata[si] ?? 0;
      out[di + 1] = sdata[si + 1] ?? 0;
      out[di + 2] = sdata[si + 2] ?? 0;
      out[di + 3] = sdata[si + 3] ?? 0;
    }
  }

  return { width: outW, height: outH, data: out };
}
