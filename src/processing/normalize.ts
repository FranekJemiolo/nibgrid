export { sha256Bytes } from './hash';

export interface InkBoundingBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
  inkCount: number;
}

function computePixelLuminance(rgba: Uint8ClampedArray, offset: number): number {
  const r = rgba[offset] ?? 255;
  const g = rgba[offset + 1] ?? 255;
  const b = rgba[offset + 2] ?? 255;
  const a = (rgba[offset + 3] ?? 255) / 255;
  const rawLum = 0.299 * r + 0.587 * g + 0.114 * b;
  // Composite semi-transparent pixels over opaque white paper
  return rawLum * a + 255 * (1 - a);
}

function estimateBackgroundLuminance(luminances: Float32Array): number {
  const histogram = new Uint32Array(256);
  for (let i = 0; i < luminances.length; i++) {
    const bin = Math.max(0, Math.min(255, Math.round(luminances[i] ?? 255)));
    histogram[bin] = (histogram[bin] ?? 0) + 1;
  }

  // 75th percentile captures dominant paper tone even when dark ink covers up to 74% of frame
  const targetRank = Math.max(1, Math.floor(luminances.length * 0.75));
  let cumulative = 0;
  let p75 = 255;
  for (let bin = 0; bin < 256; bin++) {
    cumulative += histogram[bin] ?? 0;
    if (cumulative >= targetRank) {
      p75 = bin;
      break;
    }
  }
  return Math.max(p75, 160);
}

/**
 * Converts a raw photo/canvas sketch into crisp black-on-white line art using
 * local adaptive thresholding (via a 2D summed-area table) combined with global contrast gating.
 */
export function extractLinesAndContrast(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid image dimensions: ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(`RGBA buffer mismatch: expected ${width * height * 4}, got ${rgba.length}`);
  }

  const pixelCount = width * height;
  const luminances = new Float32Array(pixelCount);
  for (let i = 0; i < pixelCount; i++) {
    luminances[i] = computePixelLuminance(rgba, i * 4);
  }

  const bgLum = estimateBackgroundLuminance(luminances);
  const globalInkCutoff = Math.min(120, bgLum - 55);

  // Build 2D summed-area table of size (width + 1) x (height + 1)
  const stride = width + 1;
  const sat = new Float64Array(stride * (height + 1));
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    const satRow = (y + 1) * stride;
    const prevSatRow = y * stride;
    const lumRow = y * width;
    for (let x = 0; x < width; x++) {
      rowSum += luminances[lumRow + x] ?? 255;
      sat[satRow + x + 1] = (sat[prevSatRow + x + 1] ?? 0) + rowSum;
    }
  }

  const radius = Math.max(6, Math.floor(Math.min(width, height) / 8));
  const out = new Uint8ClampedArray(pixelCount * 4);

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(height - 1, y + radius);
    const satY0 = y0 * stride;
    const satY1 = (y1 + 1) * stride;

    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(width - 1, x + radius);
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        (sat[satY1 + x1 + 1] ?? 0) -
        (sat[satY0 + x1 + 1] ?? 0) -
        (sat[satY1 + x0] ?? 0) +
        (sat[satY0 + x0] ?? 0);
      const localMean = sum / area;

      const idx = y * width + x;
      const lum = luminances[idx] ?? 255;
      const isAdaptiveInk = lum < localMean - 26 && lum < bgLum - 26;
      const isGlobalInk = lum < globalInkCutoff;
      const value = isAdaptiveInk || isGlobalInk ? 0 : 255;

      const outIdx = idx * 4;
      out[outIdx] = value;
      out[outIdx + 1] = value;
      out[outIdx + 2] = value;
      out[outIdx + 3] = 255;
    }
  }

  return out;
}

/**
 * Computes the bounding box enclosing all non-background dark ink pixels.
 * Returns null if the image contains no ink pixels.
 */
export function computeInkBoundingBox(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): InkBoundingBox | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  let inkCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const alpha = rgba[offset + 3] ?? 0;
      if (alpha < 128) continue;
      const lum = computePixelLuminance(rgba, offset);
      if (lum < 128) {
        inkCount++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (inkCount === 0 || maxX < minX || maxY < minY) {
    return null;
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
    inkCount,
  };
}

/**
 * Scales the ink bounding box preserving aspect ratio and centers it inside a
 * targetSize x targetHeight white canvas with the requested safe margin ratio.
 */
export function alignToSafeMargin(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  targetSize: number,
  marginRatio = 0.1,
  targetHeight = targetSize,
): Uint8ClampedArray {
  if (targetSize <= 0 || targetHeight <= 0) {
    throw new Error(`Invalid target dimensions: ${targetSize}x${targetHeight}`);
  }
  if (marginRatio < 0 || marginRatio >= 0.45) {
    throw new Error(`marginRatio must be in [0, 0.45), received ${marginRatio}`);
  }

  const out = new Uint8ClampedArray(targetSize * targetHeight * 4);
  out.fill(255);

  const bbox = computeInkBoundingBox(rgba, width, height);
  if (!bbox) {
    return out;
  }

  const marginX = Math.round(targetSize * marginRatio);
  const marginY = Math.round(targetHeight * marginRatio);
  const safeWidth = Math.max(1, targetSize - 2 * marginX);
  const safeHeight = Math.max(1, targetHeight - 2 * marginY);

  const scale = Math.min(safeWidth / bbox.width, safeHeight / bbox.height);
  const scaledW = Math.max(1, Math.round(bbox.width * scale));
  const scaledH = Math.max(1, Math.round(bbox.height * scale));

  const dstStartX = Math.floor((targetSize - scaledW) / 2);
  const dstStartY = Math.floor((targetHeight - scaledH) / 2);

  for (let dy = 0; dy < scaledH; dy++) {
    const outY = dstStartY + dy;
    if (outY < 0 || outY >= targetHeight) continue;

    const syStart = bbox.minY + Math.floor((dy * bbox.height) / scaledH);
    const syEnd =
      scale >= 1
        ? syStart
        : Math.min(
            bbox.maxY,
            bbox.minY + Math.max(0, Math.ceil(((dy + 1) * bbox.height) / scaledH) - 1),
          );

    for (let dx = 0; dx < scaledW; dx++) {
      const outX = dstStartX + dx;
      if (outX < 0 || outX >= targetSize) continue;

      const sxStart = bbox.minX + Math.floor((dx * bbox.width) / scaledW);
      const sxEnd =
        scale >= 1
          ? sxStart
          : Math.min(
              bbox.maxX,
              bbox.minX + Math.max(0, Math.ceil(((dx + 1) * bbox.width) / scaledW) - 1),
            );

      // Preserve thin strokes during downscaling by picking the darkest sampled pixel
      let minLum = 255;
      let chosenR = 255;
      let chosenG = 255;
      let chosenB = 255;

      for (let sy = syStart; sy <= syEnd; sy++) {
        for (let sx = sxStart; sx <= sxEnd; sx++) {
          const srcOffset = (sy * width + sx) * 4;
          const lum = computePixelLuminance(rgba, srcOffset);
          if (lum < minLum) {
            minLum = lum;
            const alpha = (rgba[srcOffset + 3] ?? 255) / 255;
            chosenR = Math.round((rgba[srcOffset] ?? 255) * alpha + 255 * (1 - alpha));
            chosenG = Math.round((rgba[srcOffset + 1] ?? 255) * alpha + 255 * (1 - alpha));
            chosenB = Math.round((rgba[srcOffset + 2] ?? 255) * alpha + 255 * (1 - alpha));
          }
        }
      }

      const dstOffset = (outY * targetSize + outX) * 4;
      out[dstOffset] = chosenR;
      out[dstOffset + 1] = chosenG;
      out[dstOffset + 2] = chosenB;
      out[dstOffset + 3] = 255;
    }
  }

  return out;
}
