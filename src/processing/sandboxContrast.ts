import type { RgbaBuffer } from './types';

export type BiomeContrastRating = 'strong' | 'moderate' | 'weak';

export interface BiomeContrastReport {
  readonly edgePixelCount: number;
  readonly edgeLuminance: number;
  readonly biomeLuminance: number;
  readonly contrastRatio: number;
  readonly readableEdgePercent: number;
  readonly rating: BiomeContrastRating;
  readonly suggestion: string;
}

/**
 * Converts an 8-bit sRGB channel (0..255) to linear light using ITU-R BT.709 transfer.
 */
export function srgbChannelToLinear(c8: number): number {
  const c = Math.max(0, Math.min(255, c8)) / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * Computes Rec.709 relative luminance in `[0, 1]`.
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return (
    0.2126 * srgbChannelToLinear(r) +
    0.7152 * srgbChannelToLinear(g) +
    0.0722 * srgbChannelToLinear(b)
  );
}

/**
 * Computes WCAG-style luminance contrast ratio `>= 1.0`.
 */
export function contrastRatioFromLuminance(l1: number, l2: number): number {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Audits 1px exterior silhouette separation of `sprite` over `biomeTile`.
 */
export function computeBiomeContrast(
  sprite: RgbaBuffer,
  biomeTile: RgbaBuffer,
  alphaThreshold = 128,
): BiomeContrastReport {
  const biomeTotalPixels = biomeTile.width * biomeTile.height;
  let biomeLumSum = 0;
  for (let i = 0; i < biomeTile.data.length; i += 4) {
    biomeLumSum += relativeLuminance(
      biomeTile.data[i] ?? 0,
      biomeTile.data[i + 1] ?? 0,
      biomeTile.data[i + 2] ?? 0,
    );
  }
  const biomeLuminance = biomeTotalPixels > 0 ? biomeLumSum / biomeTotalPixels : 0.5;

  const { width, height, data } = sprite;
  let edgePixelCount = 0;
  let edgeLumSum = 0;
  let readableCount = 0;

  const isTransparentOrOob = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return true;
    return (data[(y * width + x) * 4 + 3] ?? 0) < alphaThreshold;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if ((data[i + 3] ?? 0) < alphaThreshold) continue;

      const isContour =
        isTransparentOrOob(x - 1, y) ||
        isTransparentOrOob(x + 1, y) ||
        isTransparentOrOob(x, y - 1) ||
        isTransparentOrOob(x, y + 1);
      if (!isContour) continue;

      const pixLum = relativeLuminance(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0);
      edgePixelCount += 1;
      edgeLumSum += pixLum;
      if (contrastRatioFromLuminance(pixLum, biomeLuminance) >= 2.2) {
        readableCount += 1;
      }
    }
  }

  if (edgePixelCount === 0) {
    return {
      edgePixelCount: 0,
      edgeLuminance: biomeLuminance,
      biomeLuminance,
      contrastRatio: 1,
      readableEdgePercent: 0,
      rating: 'weak',
      suggestion: 'No opaque silhouette pixels detected; check background cutout threshold.',
    };
  }

  const edgeLuminance = edgeLumSum / edgePixelCount;
  const contrastRatio = contrastRatioFromLuminance(edgeLuminance, biomeLuminance);
  const readableEdgePercent = (readableCount / edgePixelCount) * 100;

  let rating: BiomeContrastRating;
  if (contrastRatio >= 3.0 && readableEdgePercent >= 75) {
    rating = 'strong';
  } else if (contrastRatio >= 2.0 && readableEdgePercent >= 50) {
    rating = 'moderate';
  } else {
    rating = 'weak';
  }

  let suggestion: string;
  if (rating === 'strong') {
    suggestion = 'Strong perimeter separation against active biome terrain.';
  } else if (biomeLuminance < 0.25) {
    suggestion =
      'Weak silhouette separation over dark biome — add bright Inner Sel-Out or crisp rim-light highlights along top edges.';
  } else if (biomeLuminance > 0.6) {
    suggestion =
      'Contour washes out on bright biome — enable dark Outer Sel-Out outlines or deepen shadow contrast on edge pixels.';
  } else {
    suggestion =
      'Low mid-tone edge separation — apply Outer Sel-Out or shift perimeter luminance away from mid-gray terrain.';
  }

  return {
    edgePixelCount,
    edgeLuminance,
    biomeLuminance,
    contrastRatio,
    readableEdgePercent,
    rating,
    suggestion,
  };
}
