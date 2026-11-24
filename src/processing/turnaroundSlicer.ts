import type { RgbaBuffer } from './types';

export type TurnaroundLayout = '2x2' | '1x4';
export type CardinalDirection = 'south' | 'east' | 'north' | 'west';

export interface TurnaroundSliceOptions {
  readonly layout: TurnaroundLayout;
  /** Mapping from slot index (0..3, reading order) to cardinal direction */
  readonly slotDirections?: readonly [
    CardinalDirection,
    CardinalDirection,
    CardinalDirection,
    CardinalDirection,
  ];
  readonly alphaThreshold?: number;
  readonly minComponentPixels?: number;
  readonly normalizeHeight?: boolean;
  readonly paddingPx?: number;
  readonly mirrorEastToWest?: boolean;
}

export interface RawSliceBounds {
  readonly slotIndex: number;
  readonly direction: CardinalDirection;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly pixelCount: number;
}

export interface AlignedTurnaroundFrame {
  readonly direction: CardinalDirection;
  readonly buffer: RgbaBuffer;
  readonly sourceBounds: RawSliceBounds;
  readonly scaleApplied: number;
}

export interface TurnaroundSliceResult {
  readonly frameWidth: number;
  readonly frameHeight: number;
  /** Shared pivot in pixel coordinates across all aligned frames */
  readonly sharedPivotPx: { readonly x: number; readonly y: number };
  readonly frames: readonly AlignedTurnaroundFrame[];
}

interface ComponentBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  sumX: number;
  sumY: number;
  count: number;
}

const DEFAULT_SLOTS: readonly [
  CardinalDirection,
  CardinalDirection,
  CardinalDirection,
  CardinalDirection,
] = ['south', 'east', 'north', 'west'];

/**
 * Extracts 4-connected opaque components via iterative BFS and merges them into the
 * 4 expected turnaround slots (`2x2` or `1x4`) by centroid proximity.
 */
export function detectTurnaroundSlots(
  buf: RgbaBuffer,
  options: TurnaroundSliceOptions,
): readonly RawSliceBounds[] {
  const { width, height, data } = buf;
  if (width <= 0 || height <= 0 || data.length < width * height * 4) {
    return [];
  }

  const alphaThresh = options.alphaThreshold ?? 128;
  const minPx = Math.max(1, options.minComponentPixels ?? 16);
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const components: ComponentBox[] = [];

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const startIdx = y * width + x;
      if (visited[startIdx] || (data[startIdx * 4 + 3] ?? 0) < alphaThresh) {
        continue;
      }

      let head = 0;
      let tail = 0;
      queue[tail++] = startIdx;
      visited[startIdx] = 1;

      const box: ComponentBox = {
        minX: x,
        minY: y,
        maxX: x,
        maxY: y,
        sumX: 0,
        sumY: 0,
        count: 0,
      };

      while (head < tail) {
        const idx = queue[head++]!;
        const cx = idx % width;
        const cy = (idx - cx) / width;

        if (cx < box.minX) box.minX = cx;
        if (cx > box.maxX) box.maxX = cx;
        if (cy < box.minY) box.minY = cy;
        if (cy > box.maxY) box.maxY = cy;
        box.sumX += cx;
        box.sumY += cy;
        box.count++;

        if (cx > 0 && !visited[idx - 1] && (data[(idx - 1) * 4 + 3] ?? 0) >= alphaThresh) {
          visited[idx - 1] = 1;
          queue[tail++] = idx - 1;
        }
        if (cx + 1 < width && !visited[idx + 1] && (data[(idx + 1) * 4 + 3] ?? 0) >= alphaThresh) {
          visited[idx + 1] = 1;
          queue[tail++] = idx + 1;
        }
        if (cy > 0 && !visited[idx - width] && (data[(idx - width) * 4 + 3] ?? 0) >= alphaThresh) {
          visited[idx - width] = 1;
          queue[tail++] = idx - width;
        }
        if (
          cy + 1 < height &&
          !visited[idx + width] &&
          (data[(idx + width) * 4 + 3] ?? 0) >= alphaThresh
        ) {
          visited[idx + width] = 1;
          queue[tail++] = idx + width;
        }
      }

      if (box.count >= minPx) {
        components.push(box);
      }
    }
  }

  // Merge components assigned to the same turnaround slot (absorbs floating hats/weapons)
  const slotMap = new Map<number, ComponentBox>();
  for (const comp of components) {
    const cx = comp.sumX / comp.count;
    const cy = comp.sumY / comp.count;
    const slot =
      options.layout === '2x2'
        ? (cy >= height / 2 ? 2 : 0) + (cx >= width / 2 ? 1 : 0)
        : Math.min(3, Math.max(0, Math.floor((cx / Math.max(1, width)) * 4)));

    const existing = slotMap.get(slot);
    if (!existing) {
      slotMap.set(slot, { ...comp });
    } else {
      existing.minX = Math.min(existing.minX, comp.minX);
      existing.minY = Math.min(existing.minY, comp.minY);
      existing.maxX = Math.max(existing.maxX, comp.maxX);
      existing.maxY = Math.max(existing.maxY, comp.maxY);
      existing.sumX += comp.sumX;
      existing.sumY += comp.sumY;
      existing.count += comp.count;
    }
  }

  const dirs = options.slotDirections ?? DEFAULT_SLOTS;
  const results: RawSliceBounds[] = [];
  for (let slot = 0; slot < 4; slot++) {
    const b = slotMap.get(slot);
    if (!b) continue;
    results.push({
      slotIndex: slot,
      direction: dirs[slot]!,
      minX: b.minX,
      minY: b.minY,
      maxX: b.maxX,
      maxY: b.maxY,
      pixelCount: b.count,
    });
  }

  return results;
}

function sampleAxisNearest(dstIdx: number, dstLen: number, srcLen: number): number {
  if (srcLen <= 1 || dstLen <= 1) return 0;
  if (dstIdx === 0) return 0;
  if (dstIdx === dstLen - 1) return srcLen - 1;
  return Math.min(srcLen - 1, Math.floor(((dstIdx + 0.5) * srcLen) / dstLen));
}

/** Nearest-neighbor crop + optional uniform scale + bottom-center pivot blit. */
function blitAlignedFrame(
  src: RgbaBuffer,
  bounds: RawSliceBounds,
  targetW: number,
  targetH: number,
  scale: number,
  pivotX: number,
  pivotY: number,
): RgbaBuffer {
  const out = new Uint8ClampedArray(targetW * targetH * 4);
  const srcW = bounds.maxX - bounds.minX + 1;
  const srcH = bounds.maxY - bounds.minY + 1;
  const scaledW = Math.max(1, Math.round(srcW * scale));
  const scaledH = Math.max(1, Math.round(srcH * scale));

  const dstOriginX = Math.round(pivotX - scaledW * 0.5);
  const dstOriginY = Math.round(pivotY - scaledH);

  for (let dy = 0; dy < scaledH; dy++) {
    const outY = dstOriginY + dy;
    if (outY < 0 || outY >= targetH) continue;
    const sy = bounds.minY + sampleAxisNearest(dy, scaledH, srcH);

    for (let dx = 0; dx < scaledW; dx++) {
      const outX = dstOriginX + dx;
      if (outX < 0 || outX >= targetW) continue;
      const sx = bounds.minX + sampleAxisNearest(dx, scaledW, srcW);

      const si = (sy * src.width + sx) * 4;
      const di = (outY * targetW + outX) * 4;
      out[di] = src.data[si] ?? 0;
      out[di + 1] = src.data[si + 1] ?? 0;
      out[di + 2] = src.data[si + 2] ?? 0;
      out[di + 3] = src.data[si + 3] ?? 0;
    }
  }

  return { width: targetW, height: targetH, data: out };
}

/**
 * Exact horizontal mirror of an RGBA buffer across its full canvas width.
 */
export function flipBufferHorizontal(src: RgbaBuffer): RgbaBuffer {
  const { width, height, data } = src;
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4;
      const di = (y * width + (width - 1 - x)) * 4;
      out[di] = data[si] ?? 0;
      out[di + 1] = data[si + 1] ?? 0;
      out[di + 2] = data[si + 2] ?? 0;
      out[di + 3] = data[si + 3] ?? 0;
    }
  }
  return { width, height, data: out };
}

/**
 * Slices a `2x2` or `1x4` turnaround sheet into uniformly sized, height-normalized,
 * bottom-center shared-pivot RGBA frames.
 */
export function sliceAndAlignTurnaround(
  buf: RgbaBuffer,
  options: TurnaroundSliceOptions,
): TurnaroundSliceResult {
  const slots = detectTurnaroundSlots(buf, options);
  if (slots.length === 0) {
    return { frameWidth: 0, frameHeight: 0, sharedPivotPx: { x: 0, y: 0 }, frames: [] };
  }

  const heights = slots.map((s) => s.maxY - s.minY + 1).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] ?? 1;

  const scales = slots.map((s) => {
    if (!(options.normalizeHeight ?? true)) return 1;
    const h = s.maxY - s.minY + 1;
    return h > 0 ? medianH / h : 1;
  });

  const pad = Math.max(0, Math.round(options.paddingPx ?? 4));
  let maxScaledW = 0;
  let maxScaledH = 0;
  slots.forEach((s, i) => {
    const sc = scales[i]!;
    maxScaledW = Math.max(maxScaledW, Math.round((s.maxX - s.minX + 1) * sc));
    maxScaledH = Math.max(maxScaledH, Math.round((s.maxY - s.minY + 1) * sc));
  });

  const frameWidth = maxScaledW + pad * 2;
  const frameHeight = maxScaledH + pad * 2;
  const sharedPivotPx = {
    x: Math.floor(frameWidth / 2),
    y: frameHeight - pad,
  };

  const blitted: AlignedTurnaroundFrame[] = slots.map((slot, i) => {
    const scale = scales[i]!;
    return {
      direction: slot.direction,
      sourceBounds: slot,
      scaleApplied: Number(scale.toFixed(4)),
      buffer: blitAlignedFrame(
        buf,
        slot,
        frameWidth,
        frameHeight,
        scale,
        sharedPivotPx.x,
        sharedPivotPx.y,
      ),
    };
  });

  const eastFrame = blitted.find((f) => f.direction === 'east');
  const frames: AlignedTurnaroundFrame[] = blitted.map((frame) => {
    if (!options.mirrorEastToWest || frame.direction !== 'west' || !eastFrame) {
      return frame;
    }
    return {
      direction: 'west',
      sourceBounds: eastFrame.sourceBounds,
      scaleApplied: eastFrame.scaleApplied,
      buffer: flipBufferHorizontal(eastFrame.buffer),
    };
  });

  return { frameWidth, frameHeight, sharedPivotPx, frames };
}
