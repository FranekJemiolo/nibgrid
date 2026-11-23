import type { PostProcessConfig } from '../domain/schemas';
import { applyAlphaThreshold, defringeInteriorRgb, erodeAlphaMask } from './alphaCleanup';
import { parseHexRgb, removeBackgroundColorKey } from './backgroundKey';
import { demixelBuffer, type DetectedGrid } from './demixel';
import { cleanOrphanPixels } from './orphanCleaner';
import { quantizeToPaletteOklab } from './paletteQuantize';
import {
  autoTrimTransparent,
  padToPowerOfTwo,
  resampleRgba,
  type SizedRgbaBuffer,
} from './resampleAndTrim';
import { applySelectiveOutline } from './selOut';

export interface PostProcessPipelineResult extends SizedRgbaBuffer {
  detectedGrid?: DetectedGrid;
  orphanStats?: {
    removedIslands: number;
    cleanedSpecks: number;
  };
}

/**
 * Deterministic, pure-TS post-processing pipeline orchestrator.
 * Execution order: Background Removal -> Alpha Cleanup / Defringe -> De-Mixel -> Orphan Clean
 * -> Resample -> Palette Quantize -> Sel-Out -> Auto-Trim / PoT Padding.
 */
export function runPostProcessPipeline(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  config: PostProcessConfig,
  paletteHex: readonly string[],
): PostProcessPipelineResult {
  let working = new Uint8ClampedArray(rgba);
  let curW = width;
  let curH = height;
  let detectedGrid: DetectedGrid | undefined;
  let orphanStats: { removedIslands: number; cleanedSpecks: number } | undefined;
  const binaryCutoff = Math.max(128, config.alphaThreshold);

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

  // 5. Pixel-Art De-Mixel Grid Snap (M7)
  if (config.demixelEnabled) {
    const demix = demixelBuffer(
      { width: curW, height: curH, data: working },
      {
        alphaThreshold: binaryCutoff,
        manualCellSize: config.demixelMode === 'manual' ? config.demixelCellSize : undefined,
      },
    );
    working = new Uint8ClampedArray(demix.buffer.data);
    curW = demix.buffer.width;
    curH = demix.buffer.height;
    detectedGrid = demix.grid;
  }

  // 6. Orphan-Pixel & Jaggy Cleaner (M7)
  if (config.orphanCleanEnabled) {
    const cleaned = cleanOrphanPixels(
      { width: curW, height: curH, data: working },
      {
        maxIslandPixels: config.maxIslandPixels,
        removeInteriorSpecks: config.removeInteriorSpecks,
        alphaThreshold: binaryCutoff,
      },
    );
    working = new Uint8ClampedArray(cleaned.buffer.data);
    orphanStats = {
      removedIslands: cleaned.removedIslands,
      cleanedSpecks: cleaned.cleanedSpecks,
    };
  }

  // 7. Resampling
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

  // 8. Perceptual OKLab Palette Quantization (+ optional 4x4 Ordered Bayer dithering)
  if (config.paletteSnap && paletteHex.length > 0) {
    working = new Uint8ClampedArray(
      quantizeToPaletteOklab(working, curW, curH, paletteHex, {
        dither: config.bayerDither,
        ditherStrength: config.ditherStrength,
      }),
    );
  }

  // 9. Selective Colored Outline "Sel-Out" (M7)
  if (config.selOutMode && config.selOutMode !== 'off') {
    const parsedPalette =
      config.selOutSnapToPalette && paletteHex.length > 0
        ? paletteHex.map((hex) => parseHexRgb(hex))
        : undefined;
    const outlined = applySelectiveOutline(
      { width: curW, height: curH, data: working },
      {
        mode: config.selOutMode,
        lighting: config.selOutLighting,
        litDarken: config.selOutLitDarken,
        shadowDarken: config.selOutShadowDarken,
        palette: parsedPalette,
        alphaThreshold: binaryCutoff,
        expandCanvas: config.selOutMode === 'outer',
      },
    );
    working = new Uint8ClampedArray(outlined.data);
    curW = outlined.width;
    curH = outlined.height;
  }

  // 10. Auto-Trim transparent outer margin
  if (config.autoTrim) {
    const trimmed = autoTrimTransparent(working, curW, curH, config.trimMargin);
    working = new Uint8ClampedArray(trimmed.rgba);
    curW = trimmed.width;
    curH = trimmed.height;
  }

  // 11. Optional Power-of-Two padding
  if (config.padToPot) {
    const padded = padToPowerOfTwo(working, curW, curH, 'center');
    working = new Uint8ClampedArray(padded.rgba);
    curW = padded.width;
    curH = padded.height;
  }

  return { rgba: working, width: curW, height: curH, detectedGrid, orphanStats };
}
