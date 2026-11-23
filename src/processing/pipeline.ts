import type { PostProcessConfig } from '../domain/schemas';
import { applyAlphaThreshold, defringeInteriorRgb, erodeAlphaMask } from './alphaCleanup';
import { parseHexRgb, removeBackgroundColorKey } from './backgroundKey';
import { quantizeToPaletteOklab } from './paletteQuantize';
import {
  autoTrimTransparent,
  padToPowerOfTwo,
  resampleRgba,
  type SizedRgbaBuffer,
} from './resampleAndTrim';

/**
 * Deterministic, pure-TS post-processing pipeline orchestrator.
 * (Local AI segmentation is handled prior to this function inside `postprocess.worker.ts` when `bgRemoval === 'ai-rembg'`.)
 */
export function runPostProcessPipeline(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  config: PostProcessConfig,
  paletteHex: readonly string[],
): SizedRgbaBuffer {
  let working = new Uint8ClampedArray(rgba);
  let curW = width;
  let curH = height;

  // 1. Background Removal (Fast Color-Key)
  if (config.bgRemoval === 'color-key') {
    working = new Uint8ClampedArray(
      removeBackgroundColorKey(working, curW, curH, {
        tolerance: config.bgTolerance,
        contiguous: config.bgContiguous,
        keyColor: config.bgKeyColor ? parseHexRgb(config.bgKeyColor) : undefined,
      }),
    );
  }

  // 2. Alpha Threshold Cleanup
  if (config.alphaThreshold > 0) {
    working = new Uint8ClampedArray(
      applyAlphaThreshold(working, curW, curH, config.alphaThreshold),
    );
  }

  // 3. Morphological Erosion
  if (config.erosionRadius > 0) {
    working = new Uint8ClampedArray(
      erodeAlphaMask(working, curW, curH, config.erosionRadius, config.erosionConnectivity),
    );
  }

  // 4. Interior-RGB Color Decontamination (Defringing)
  if (config.defringe) {
    working = new Uint8ClampedArray(defringeInteriorRgb(working, curW, curH, 2));
  }

  // 5. Resampling
  if (config.resampleEnabled) {
    const resampled = resampleRgba(
      working,
      curW,
      curH,
      config.targetWidth,
      config.targetHeight,
      config.resampleMode,
    );
    working = new Uint8ClampedArray(resampled.rgba);
    curW = resampled.width;
    curH = resampled.height;
  }

  // 6. Auto-Trim transparent outer margin
  if (config.autoTrim) {
    const trimmed = autoTrimTransparent(working, curW, curH, config.trimMargin);
    working = new Uint8ClampedArray(trimmed.rgba);
    curW = trimmed.width;
    curH = trimmed.height;
  }

  // 7. Perceptual OKLab Palette Quantization (+ optional 4x4 Ordered Bayer dithering)
  if (config.paletteSnap && paletteHex.length > 0) {
    working = new Uint8ClampedArray(
      quantizeToPaletteOklab(working, curW, curH, paletteHex, {
        dither: config.bayerDither,
        ditherStrength: config.ditherStrength,
      }),
    );
  }

  // 8. Optional Power-of-Two padding
  if (config.padToPot) {
    const padded = padToPowerOfTwo(working, curW, curH, 'center');
    working = new Uint8ClampedArray(padded.rgba);
    curW = padded.width;
    curH = padded.height;
  }

  return { rgba: working, width: curW, height: curH };
}
