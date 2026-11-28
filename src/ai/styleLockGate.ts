import type { SpriteNode } from '../domain/schemas';
import { parseHexRgb } from '../processing/backgroundKey';
import { srgbToOklab } from '../processing/paletteQuantize';

export interface QualityGateMetrics {
  readonly passed: boolean;
  readonly isEmptyFrame: boolean;
  readonly opaquePixelCount: number;
  readonly borderClipCount: number;
  readonly offPalettePixelCount: number;
  readonly paletteDriftPct: number;
}

export interface QualityGateRunResult<T> {
  readonly result: T;
  readonly metrics: QualityGateMetrics;
  readonly attempts: number;
  readonly rerolled: boolean;
}

/**
 * Evaluates a generated sprite buffer for empty-frame failure, border clipping, and OKLab drift
 * away from `paletteHex`.
 */
export function evaluateSpriteQuality(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  paletteHex: readonly string[],
  opts?: { readonly oklabTolerance?: number; readonly maxDriftPct?: number },
): QualityGateMetrics {
  const maxLabDistSq = Math.pow(opts?.oklabTolerance ?? 0.06, 2);
  const maxDriftPct = opts?.maxDriftPct ?? 0.25;
  const paletteLabs = paletteHex.map((hex) => {
    const rgb = parseHexRgb(hex);
    return srgbToOklab(rgb.r, rgb.g, rgb.b);
  });

  let opaquePixelCount = 0;
  let borderClipCount = 0;
  let offPalettePixelCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if ((rgba[i + 3] ?? 0) === 0) continue;
      opaquePixelCount++;

      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) {
        borderClipCount++;
      }

      if (paletteLabs.length > 0) {
        const lab = srgbToOklab(rgba[i] ?? 0, rgba[i + 1] ?? 0, rgba[i + 2] ?? 0);
        let bestDistSq = Infinity;
        for (const p of paletteLabs) {
          const dL = lab.L - p.L;
          const da = lab.a - p.a;
          const db = lab.b - p.b;
          const distSq = dL * dL + da * da + db * db;
          if (distSq < bestDistSq) bestDistSq = distSq;
        }
        if (bestDistSq > maxLabDistSq) {
          offPalettePixelCount++;
        }
      }
    }
  }

  const isEmptyFrame = opaquePixelCount === 0;
  const paletteDriftPct = opaquePixelCount > 0 ? offPalettePixelCount / opaquePixelCount : 1;
  const passed = !isEmptyFrame && borderClipCount === 0 && paletteDriftPct <= maxDriftPct;

  return {
    passed,
    isEmptyFrame,
    opaquePixelCount,
    borderClipCount,
    offPalettePixelCount,
    paletteDriftPct,
  };
}

/**
 * Combines up to 3 approved Golden Reference blob IDs with up to `maxExtraSprites` (default 2)
 * existing generated/approved project sprite blobs so new generations inherit consistent style cues.
 */
export function selectStyleLockAnchors(
  goldenReferenceBlobIds: readonly string[],
  existingSpriteNodes: readonly SpriteNode[],
  maxExtraSprites = 2,
): readonly string[] {
  const seen = new Set<string>();
  const anchors: string[] = [];

  for (const blobId of goldenReferenceBlobIds.slice(0, 3)) {
    if (!seen.has(blobId)) {
      seen.add(blobId);
      anchors.push(blobId);
    }
  }

  let addedExtra = 0;
  for (let i = existingSpriteNodes.length - 1; i >= 0 && addedExtra < maxExtraSprites; i--) {
    const node = existingSpriteNodes[i];
    if (!node || (node.kind !== 'generation' && node.kind !== 'inpaint')) continue;
    const blobId = node.processedBlobId ?? node.imageBlobId;
    if (!seen.has(blobId)) {
      seen.add(blobId);
      anchors.push(blobId);
      addedExtra++;
    }
  }

  return anchors;
}

/**
 * Executes `generateFn(0)` and inspects it with `inspectFn`; if it fails quality checks, silently
 * retries at most `maxRetries` (default 1) before returning the better result.
 */
export async function runWithSilentQualityGate<T>(
  generateFn: (attempt: number) => Promise<T>,
  inspectFn: (item: T) => QualityGateMetrics,
  maxRetries = 1,
): Promise<QualityGateRunResult<T>> {
  const firstResult = await generateFn(0);
  const firstMetrics = inspectFn(firstResult);
  if (firstMetrics.passed || maxRetries < 1) {
    return {
      result: firstResult,
      metrics: firstMetrics,
      attempts: 1,
      rerolled: false,
    };
  }

  const secondResult = await generateFn(1);
  const secondMetrics = inspectFn(secondResult);
  const chooseSecond =
    secondMetrics.passed ||
    (!firstMetrics.passed && secondMetrics.paletteDriftPct < firstMetrics.paletteDriftPct);

  return {
    result: chooseSecond ? secondResult : firstResult,
    metrics: chooseSecond ? secondMetrics : firstMetrics,
    attempts: 2,
    rerolled: true,
  };
}
