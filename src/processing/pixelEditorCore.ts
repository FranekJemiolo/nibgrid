import { parseHexRgb } from './backgroundKey';
import type { RgbaBuffer } from './types';

export type PixelTool = 'pencil' | 'eraser' | 'eyedropper' | 'fill' | 'mask-brush' | 'mask-eraser';
export type RgbaColor = readonly [number, number, number, number];
export type PixelBrushSize = 1 | 2 | 3;

export interface PixelStrokeOptions {
  readonly color: RgbaColor;
  readonly mirrorX: boolean;
  readonly brushSize?: PixelBrushSize;
}

export interface ClientRectLike {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** Parses a `#RRGGBB` string into a 4-tuple RGBA color. */
export function hexToRgbaColor(hex: string, alpha = 255): RgbaColor {
  const { r, g, b } = parseHexRgb(hex);
  const clampedA = Math.max(0, Math.min(255, Math.round(alpha)));
  return [r, g, b, clampedA];
}

/** Formats an RGBA tuple as uppercase `#RRGGBB`. */
export function rgbaColorToHex(color: RgbaColor): string {
  const hexByte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${hexByte(color[0])}${hexByte(color[1])}${hexByte(color[2])}`;
}

/** Reads an RGBA pixel cleanly or returns `null` when out of bounds. */
export function samplePixelRgba(buf: RgbaBuffer, x: number, y: number): RgbaColor | null {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= buf.width || iy < 0 || iy >= buf.height) return null;
  const idx = (iy * buf.width + ix) * 4;
  return [
    buf.data[idx] ?? 0,
    buf.data[idx + 1] ?? 0,
    buf.data[idx + 2] ?? 0,
    buf.data[idx + 3] ?? 0,
  ];
}

/**
 * Maps CSS-pixel pointer coordinates inside a surface bounding rect to clamped
 * integer texel coordinates `[0..width-1, 0..height-1]` at any DPR or zoom level.
 */
export function mapClientToTexel(
  clientX: number,
  clientY: number,
  rect: ClientRectLike,
  width: number,
  height: number,
): { x: number; y: number } {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const relX = (clientX - rect.left) / Math.max(1e-6, rect.width);
  const relY = (clientY - rect.top) / Math.max(1e-6, rect.height);
  return {
    x: Math.max(0, Math.min(w - 1, Math.floor(relX * w))),
    y: Math.max(0, Math.min(h - 1, Math.floor(relY * h))),
  };
}

/** Sets a square brush stamp at `(x, y)` (and its horizontal mirror when `mirrorX` is true). */
export function plotPixel(buf: RgbaBuffer, x: number, y: number, opts: PixelStrokeOptions): void {
  const size = opts.brushSize ?? 1;
  const half = Math.floor(size / 2);

  const stamp = (cx: number, cy: number) => {
    for (let dy = -half; dy < size - half; dy++) {
      for (let dx = -half; dx < size - half; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= buf.width || py < 0 || py >= buf.height) continue;
        const idx = (py * buf.width + px) * 4;
        buf.data[idx] = opts.color[0];
        buf.data[idx + 1] = opts.color[1];
        buf.data[idx + 2] = opts.color[2];
        buf.data[idx + 3] = opts.color[3];
      }
    }
  };

  const ix = Math.round(x);
  const iy = Math.round(y);
  stamp(ix, iy);
  if (opts.mirrorX) {
    stamp(buf.width - 1 - ix, iy);
  }
}

/** Bresenham line interpolation so rapid pointer drags never leave pixel gaps. */
export function plotBresenhamLine(
  buf: RgbaBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  opts: PixelStrokeOptions,
): void {
  let cx = Math.round(x0);
  let cy = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);
  const dx = Math.abs(tx - cx);
  const dy = Math.abs(ty - cy);
  const sx = cx < tx ? 1 : -1;
  const sy = cy < ty ? 1 : -1;
  let err = dx - dy;

  while (true) {
    plotPixel(buf, cx, cy, opts);
    if (cx === tx && cy === ty) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
}

/** Iterative 4-connected flood fill (zero recursion stack overflow risk). */
export function floodFillRgba(
  buf: RgbaBuffer,
  startX: number,
  startY: number,
  fillColor: RgbaColor,
): number {
  const sx = Math.round(startX);
  const sy = Math.round(startY);
  if (sx < 0 || sx >= buf.width || sy < 0 || sy >= buf.height) return 0;

  const startIdx = (sy * buf.width + sx) * 4;
  const tr = buf.data[startIdx] ?? 0;
  const tg = buf.data[startIdx + 1] ?? 0;
  const tb = buf.data[startIdx + 2] ?? 0;
  const ta = buf.data[startIdx + 3] ?? 0;

  if (tr === fillColor[0] && tg === fillColor[1] && tb === fillColor[2] && ta === fillColor[3]) {
    return 0;
  }

  const visited = new Uint8Array(buf.width * buf.height);
  const stack: number[] = [sx, sy];
  let filled = 0;

  while (stack.length > 0) {
    const y = stack.pop()!;
    const x = stack.pop()!;
    const pIdx = y * buf.width + x;
    if (visited[pIdx]) continue;
    visited[pIdx] = 1;

    const i = pIdx * 4;
    if (
      buf.data[i] !== tr ||
      buf.data[i + 1] !== tg ||
      buf.data[i + 2] !== tb ||
      buf.data[i + 3] !== ta
    ) {
      continue;
    }

    buf.data[i] = fillColor[0];
    buf.data[i + 1] = fillColor[1];
    buf.data[i + 2] = fillColor[2];
    buf.data[i + 3] = fillColor[3];
    filled++;

    if (x > 0) stack.push(x - 1, y);
    if (x + 1 < buf.width) stack.push(x + 1, y);
    if (y > 0) stack.push(x, y - 1);
    if (y + 1 < buf.height) stack.push(x, y + 1);
  }

  return filled;
}

/** Bounded immutable snapshot stack for deterministic Undo/Redo (`maxDepth = 50`). */
export class PixelUndoStack {
  private readonly past: Uint8ClampedArray[] = [];
  private readonly future: Uint8ClampedArray[] = [];
  private readonly maxDepth: number;

  constructor(maxDepth = 50) {
    this.maxDepth = Math.max(1, Math.floor(maxDepth));
  }

  pushBeforeEdit(current: Uint8ClampedArray): void {
    this.past.push(new Uint8ClampedArray(current));
    if (this.past.length > this.maxDepth) {
      this.past.shift();
    }
    this.future.length = 0;
  }

  undo(current: Uint8ClampedArray): Uint8ClampedArray | null {
    const prev = this.past.pop();
    if (!prev) return null;
    this.future.push(new Uint8ClampedArray(current));
    return prev;
  }

  redo(current: Uint8ClampedArray): Uint8ClampedArray | null {
    const next = this.future.pop();
    if (!next) return null;
    this.past.push(new Uint8ClampedArray(current));
    if (this.past.length > this.maxDepth) {
      this.past.shift();
    }
    return next;
  }

  clear(): void {
    this.past.length = 0;
    this.future.length = 0;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get undoCount(): number {
    return this.past.length;
  }

  get redoCount(): number {
    return this.future.length;
  }
}
