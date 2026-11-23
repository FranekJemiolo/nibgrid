import type { ResampleMode } from '../domain/schemas';

export interface SizedRgbaBuffer {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

/**
 * Resamples an RGBA buffer to `targetWidth x targetHeight` using either crisp Nearest-Neighbor
 * or premultiplied-alpha Area-Average (box) filtering.
 */
export function resampleRgba(
  rgba: Uint8ClampedArray,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number,
  mode: ResampleMode,
): SizedRgbaBuffer {
  if (srcWidth <= 0 || srcHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    throw new Error(
      `Invalid resample dimensions: ${srcWidth}x${srcHeight} -> ${targetWidth}x${targetHeight}`,
    );
  }
  if (rgba.length !== srcWidth * srcHeight * 4) {
    throw new Error(
      `RGBA buffer mismatch: expected ${srcWidth * srcHeight * 4}, got ${rgba.length}`,
    );
  }
  if (srcWidth === targetWidth && srcHeight === targetHeight) {
    return { rgba: new Uint8ClampedArray(rgba), width: targetWidth, height: targetHeight };
  }

  const out = new Uint8ClampedArray(targetWidth * targetHeight * 4);

  if (mode === 'nearest') {
    for (let dy = 0; dy < targetHeight; dy++) {
      const sy = Math.min(srcHeight - 1, Math.floor(((dy + 0.5) * srcHeight) / targetHeight));
      for (let dx = 0; dx < targetWidth; dx++) {
        const sx = Math.min(srcWidth - 1, Math.floor(((dx + 0.5) * srcWidth) / targetWidth));
        const srcPx = (sy * srcWidth + sx) * 4;
        const dstPx = (dy * targetWidth + dx) * 4;
        out[dstPx] = rgba[srcPx] ?? 0;
        out[dstPx + 1] = rgba[srcPx + 1] ?? 0;
        out[dstPx + 2] = rgba[srcPx + 2] ?? 0;
        out[dstPx + 3] = rgba[srcPx + 3] ?? 0;
      }
    }
    return { rgba: out, width: targetWidth, height: targetHeight };
  }

  // Area-Average (Box) resampling with premultiplied alpha to avoid dark edge bleeding
  const scaleX = srcWidth / targetWidth;
  const scaleY = srcHeight / targetHeight;

  for (let dy = 0; dy < targetHeight; dy++) {
    const sy0 = dy * scaleY;
    const sy1 = (dy + 1) * scaleY;
    const iy0 = Math.max(0, Math.floor(sy0));
    const iy1 = Math.min(srcHeight - 1, Math.ceil(sy1) - 1);

    for (let dx = 0; dx < targetWidth; dx++) {
      const sx0 = dx * scaleX;
      const sx1 = (dx + 1) * scaleX;
      const ix0 = Math.max(0, Math.floor(sx0));
      const ix1 = Math.min(srcWidth - 1, Math.ceil(sx1) - 1);

      let totalCoverage = 0;
      let sumAlpha = 0;
      let sumPremulR = 0;
      let sumPremulG = 0;
      let sumPremulB = 0;

      for (let sy = iy0; sy <= iy1; sy++) {
        const wy = Math.min(sy + 1, sy1) - Math.max(sy, sy0);
        if (wy <= 0) continue;

        for (let sx = ix0; sx <= ix1; sx++) {
          const wx = Math.min(sx + 1, sx1) - Math.max(sx, sx0);
          if (wx <= 0) continue;

          const cov = wx * wy;
          const srcPx = (sy * srcWidth + sx) * 4;
          const alpha = (rgba[srcPx + 3] ?? 0) / 255;

          totalCoverage += cov;
          sumAlpha += alpha * cov;
          sumPremulR += (rgba[srcPx] ?? 0) * alpha * cov;
          sumPremulG += (rgba[srcPx + 1] ?? 0) * alpha * cov;
          sumPremulB += (rgba[srcPx + 2] ?? 0) * alpha * cov;
        }
      }

      const dstPx = (dy * targetWidth + dx) * 4;
      if (totalCoverage > 0 && sumAlpha > 0) {
        out[dstPx] = Math.round(sumPremulR / sumAlpha);
        out[dstPx + 1] = Math.round(sumPremulG / sumAlpha);
        out[dstPx + 2] = Math.round(sumPremulB / sumAlpha);
        out[dstPx + 3] = Math.round((sumAlpha / totalCoverage) * 255);
      }
    }
  }

  return { rgba: out, width: targetWidth, height: targetHeight };
}

/**
 * Crops away all fully transparent outer rows/columns (`alpha === 0`),
 * adding an optional transparent margin around the tight bounding box.
 */
export function autoTrimTransparent(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  margin = 0,
): SizedRgbaBuffer {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA buffer mismatch: expected ${width * height * 4}, got ${rgba.length}`);
  }
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const alpha = rgba[(y * width + x) * 4 + 3] ?? 0;
      if (alpha > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    const emptySize = Math.max(1, 1 + 2 * Math.max(0, Math.floor(margin)));
    return {
      rgba: new Uint8ClampedArray(emptySize * emptySize * 4),
      width: emptySize,
      height: emptySize,
    };
  }

  const safeMargin = Math.max(0, Math.floor(margin));
  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const outW = cropW + safeMargin * 2;
  const outH = cropH + safeMargin * 2;
  const out = new Uint8ClampedArray(outW * outH * 4);

  for (let y = 0; y < cropH; y++) {
    const srcStart = ((minY + y) * width + minX) * 4;
    const dstStart = ((y + safeMargin) * outW + safeMargin) * 4;
    out.set(rgba.subarray(srcStart, srcStart + cropW * 4), dstStart);
  }

  return { rgba: out, width: outW, height: outH };
}

export function nextPowerOfTwo(value: number): number {
  const n = Math.max(1, Math.ceil(value));
  let pot = 1;
  while (pot < n) {
    pot <<= 1;
  }
  return pot;
}

/**
 * Pads an RGBA buffer up to the next power-of-two width & height while preserving
 * horizontal center (and center or bottom-center vertical alignment).
 */
export function padToPowerOfTwo(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  verticalAlign: 'center' | 'bottom' = 'center',
): SizedRgbaBuffer {
  const potW = nextPowerOfTwo(width);
  const potH = nextPowerOfTwo(height);
  if (potW === width && potH === height) {
    return { rgba: new Uint8ClampedArray(rgba), width, height };
  }

  const out = new Uint8ClampedArray(potW * potH * 4);
  const offsetX = Math.floor((potW - width) / 2);
  const offsetY = verticalAlign === 'bottom' ? potH - height : Math.floor((potH - height) / 2);

  for (let y = 0; y < height; y++) {
    const srcStart = y * width * 4;
    const dstStart = ((offsetY + y) * potW + offsetX) * 4;
    out.set(rgba.subarray(srcStart, srcStart + width * 4), dstStart);
  }

  return { rgba: out, width: potW, height: potH };
}
