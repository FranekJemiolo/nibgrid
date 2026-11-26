import { quantizeToPaletteOklab } from './paletteQuantize';
import type { PixelBrushSize } from './pixelEditorCore';
import type { RgbaBuffer } from './types';

/** Stamps a binary value (`1` or `0`) onto a flat `width * height` inpaint mask. */
export function paintMaskPixel(
  mask: Uint8Array,
  width: number,
  height: number,
  x: number,
  y: number,
  value: 0 | 1,
  brushSize: PixelBrushSize = 1,
  mirrorX = false,
): void {
  const half = Math.floor(brushSize / 2);
  const stamp = (cx: number, cy: number) => {
    for (let dy = -half; dy < brushSize - half; dy++) {
      for (let dx = -half; dx < brushSize - half; dx++) {
        const px = cx + dx;
        const py = cy + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;
        mask[py * width + px] = value;
      }
    }
  };
  const ix = Math.round(x);
  const iy = Math.round(y);
  stamp(ix, iy);
  if (mirrorX) {
    stamp(width - 1 - ix, iy);
  }
}

/** Paints or erases along a Bresenham segment on the binary inpaint mask. */
export function paintMaskLine(
  mask: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  value: 0 | 1,
  brushSize: PixelBrushSize = 1,
  mirrorX = false,
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
    paintMaskPixel(mask, width, height, cx, cy, value, brushSize, mirrorX);
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

/** Counts how many texels are marked editable (`!== 0`) in the mask. */
export function countMaskedPixels(mask: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    if ((mask[i] ?? 0) !== 0) count++;
  }
  return count;
}

/** Encodes a binary mask as an opaque white-on-black RGBA buffer for AI providers. */
export function maskToRgbaBuffer(mask: Uint8Array, width: number, height: number): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  const total = Math.min(mask.length, width * height);
  for (let i = 0; i < total; i++) {
    const val = (mask[i] ?? 0) !== 0 ? 255 : 0;
    const px = i * 4;
    data[px] = val;
    data[px + 1] = val;
    data[px + 2] = val;
    data[px + 3] = 255;
  }
  return { width, height, data };
}

/** Renders a translucent red (~45% alpha) UI overlay buffer from a binary mask. */
export function maskToOverlayRgba(mask: Uint8Array, width: number, height: number): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  const total = Math.min(mask.length, width * height);
  for (let i = 0; i < total; i++) {
    if ((mask[i] ?? 0) === 0) continue;
    const px = i * 4;
    data[px] = 239;
    data[px + 1] = 68;
    data[px + 2] = 68;
    data[px + 3] = 115;
  }
  return { width, height, data };
}

/**
 * Merges a generated inpaint image onto `original` using a binary mask.
 * Pixels where `mask[i] === 0` are guaranteed 100% byte-identical to `original`.
 */
export function compositeInpaintResult(
  original: RgbaBuffer,
  generated: RgbaBuffer,
  mask: Uint8Array,
): RgbaBuffer {
  if (
    original.width !== generated.width ||
    original.height !== generated.height ||
    mask.length !== original.width * original.height
  ) {
    throw new Error('Inpaint composite dimensions must match original sprite.');
  }

  const out = new Uint8ClampedArray(original.data);
  const pixelCount = original.width * original.height;

  for (let p = 0; p < pixelCount; p++) {
    if ((mask[p] ?? 0) === 0) continue;
    const i = p * 4;
    out[i] = generated.data[i] ?? 0;
    out[i + 1] = generated.data[i + 1] ?? 0;
    out[i + 2] = generated.data[i + 2] ?? 0;
    out[i + 3] = generated.data[i + 3] ?? 0;
  }

  return { width: original.width, height: original.height, data: out };
}

/**
 * Quantizes strictly masked opaque pixels to the active Art Bible palette while
 * leaving all unmasked pixels 100% byte-identical.
 */
export function snapMaskedPixelsToPalette(
  buf: RgbaBuffer,
  mask: Uint8Array,
  paletteHex: readonly string[],
): RgbaBuffer {
  if (paletteHex.length === 0) {
    return { width: buf.width, height: buf.height, data: new Uint8ClampedArray(buf.data) };
  }
  const quantized = quantizeToPaletteOklab(buf.data, buf.width, buf.height, paletteHex);
  return compositeInpaintResult(
    buf,
    { width: buf.width, height: buf.height, data: quantized },
    mask,
  );
}
