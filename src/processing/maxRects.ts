export interface PackInputItem {
  readonly id: string;
  readonly width: number;
  readonly height: number;
}

export interface MaxRectsOptions {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly padding: number;
  readonly extrude: number;
  readonly powerOfTwo: boolean;
  readonly allowRotation: boolean;
}

export interface PlacedRect {
  readonly id: string;
  readonly page: number;
  /** Exact UV placement excluding padding and extrusion halo */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly rotated: boolean;
}

export interface PackedPage {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly rects: readonly PlacedRect[];
  readonly occupancy: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

class MaxRectsBin {
  private freeRects: Rect[];

  constructor(
    public readonly binWidth: number,
    public readonly binHeight: number,
  ) {
    this.freeRects = [{ x: 0, y: 0, w: binWidth, h: binHeight }];
  }

  insert(w: number, h: number, allowRotation: boolean): (Rect & { rotated: boolean }) | null {
    let bestNode: (Rect & { rotated: boolean }) | null = null;
    let bestShortSide = Infinity;
    let bestLongSide = Infinity;

    for (const free of this.freeRects) {
      if (free.w >= w && free.h >= h) {
        const leftoverH = Math.abs(free.w - w);
        const leftoverV = Math.abs(free.h - h);
        const shortSide = Math.min(leftoverH, leftoverV);
        const longSide = Math.max(leftoverH, leftoverV);
        if (shortSide < bestShortSide || (shortSide === bestShortSide && longSide < bestLongSide)) {
          bestNode = { x: free.x, y: free.y, w, h, rotated: false };
          bestShortSide = shortSide;
          bestLongSide = longSide;
        }
      }

      if (allowRotation && free.w >= h && free.h >= w) {
        const leftoverH = Math.abs(free.w - h);
        const leftoverV = Math.abs(free.h - w);
        const shortSide = Math.min(leftoverH, leftoverV);
        const longSide = Math.max(leftoverH, leftoverV);
        if (shortSide < bestShortSide || (shortSide === bestShortSide && longSide < bestLongSide)) {
          bestNode = { x: free.x, y: free.y, w: h, h: w, rotated: true };
          bestShortSide = shortSide;
          bestLongSide = longSide;
        }
      }
    }

    if (!bestNode) return null;

    const nextFree: Rect[] = [];
    for (const free of this.freeRects) {
      if (!this.splitFreeNode(free, bestNode, nextFree)) {
        nextFree.push(free);
      }
    }

    this.freeRects = this.pruneContained(nextFree);
    return bestNode;
  }

  private splitFreeNode(free: Rect, used: Rect, out: Rect[]): boolean {
    if (
      used.x >= free.x + free.w ||
      used.x + used.w <= free.x ||
      used.y >= free.y + free.h ||
      used.y + used.h <= free.y
    ) {
      return false;
    }

    if (used.x < free.x + free.w && used.x + used.w > free.x) {
      if (used.y > free.y && used.y < free.y + free.h) {
        out.push({ x: free.x, y: free.y, w: free.w, h: used.y - free.y });
      }
      if (used.y + used.h < free.y + free.h) {
        out.push({
          x: free.x,
          y: used.y + used.h,
          w: free.w,
          h: free.y + free.h - (used.y + used.h),
        });
      }
    }

    if (used.y < free.y + free.h && used.y + used.h > free.y) {
      if (used.x > free.x && used.x < free.x + free.w) {
        out.push({ x: free.x, y: free.y, w: used.x - free.x, h: free.h });
      }
      if (used.x + used.w < free.x + free.w) {
        out.push({
          x: used.x + used.w,
          y: free.y,
          w: free.x + free.w - (used.x + used.w),
          h: free.h,
        });
      }
    }
    return true;
  }

  private pruneContained(rects: Rect[]): Rect[] {
    const kept: Rect[] = [];
    for (let i = 0; i < rects.length; i++) {
      const a = rects[i]!;
      let contained = false;
      for (let j = 0; j < rects.length; j++) {
        if (i === j) continue;
        const b = rects[j]!;
        if (a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
          contained = true;
          break;
        }
      }
      if (!contained) kept.push(a);
    }
    return kept;
  }
}

export function nextPowerOfTwo(v: number): number {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

/**
 * Deterministically packs rectangles across 1..N pages using Jylänki's BSSF MaxRects
 * heuristic, sorting inputs by longest side descending and tie-breaking by area and ID.
 */
export function packMaxRects(
  items: readonly PackInputItem[],
  options: MaxRectsOptions,
): readonly PackedPage[] {
  if (items.length === 0) return [];
  const margin = Math.max(0, options.extrude) * 2 + Math.max(0, options.padding);

  const sorted = [...items].sort((a, b) => {
    const maxDiff = Math.max(b.width, b.height) - Math.max(a.width, a.height);
    if (maxDiff !== 0) return maxDiff;
    const areaDiff = b.width * b.height - a.width * a.height;
    if (areaDiff !== 0) return areaDiff;
    return a.id.localeCompare(b.id);
  });

  const pages: PackedPage[] = [];
  let remaining = sorted;

  while (remaining.length > 0) {
    const bin = new MaxRectsBin(options.maxWidth, options.maxHeight);
    const placed: PlacedRect[] = [];
    const overflow: PackInputItem[] = [];
    let usedW = 0;
    let usedH = 0;
    let pixelArea = 0;

    for (const item of remaining) {
      const reqW = item.width + margin;
      const reqH = item.height + margin;
      if (reqW > options.maxWidth || reqH > options.maxHeight) {
        throw new Error(
          `Sprite "${item.id}" (${reqW}×${reqH} incl. padding) exceeds max atlas ${options.maxWidth}×${options.maxHeight}`,
        );
      }

      const fit = bin.insert(reqW, reqH, options.allowRotation);
      if (!fit) {
        overflow.push(item);
        continue;
      }

      const contentW = fit.rotated ? item.height : item.width;
      const contentH = fit.rotated ? item.width : item.height;
      placed.push({
        id: item.id,
        page: pages.length,
        x: fit.x + Math.max(0, options.extrude),
        y: fit.y + Math.max(0, options.extrude),
        width: contentW,
        height: contentH,
        rotated: fit.rotated,
      });

      usedW = Math.max(usedW, fit.x + fit.w);
      usedH = Math.max(usedH, fit.y + fit.h);
      pixelArea += item.width * item.height;
    }

    if (placed.length === 0) {
      throw new Error('Failed to place any sprites into atlas page.');
    }

    const finalW = options.powerOfTwo
      ? Math.min(options.maxWidth, nextPowerOfTwo(Math.max(16, usedW)))
      : Math.max(1, usedW);
    const finalH = options.powerOfTwo
      ? Math.min(options.maxHeight, nextPowerOfTwo(Math.max(16, usedH)))
      : Math.max(1, usedH);

    pages.push({
      pageIndex: pages.length,
      width: finalW,
      height: finalH,
      rects: placed,
      occupancy: finalW * finalH > 0 ? pixelArea / (finalW * finalH) : 0,
    });

    remaining = overflow;
  }

  return pages;
}
