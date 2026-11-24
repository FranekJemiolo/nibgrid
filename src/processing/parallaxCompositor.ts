import { parseHexRgb, removeBackgroundColorKey } from './backgroundKey';
import { quantizeToPaletteOklab } from './paletteQuantize';
import type { ParallaxBandRole } from './parallaxBlueprint';
import type { RgbaBuffer } from './types';

export type RgbTuple = readonly [number, number, number];

export interface ParallaxLayerInput {
  readonly id: string;
  readonly name: string;
  readonly role?: ParallaxBandRole;
  readonly source: RgbaBuffer;
  readonly scrollRatioX: number;
  readonly yOffsetPx: number;
  readonly seamBlendPx: number;
  readonly depthHaze: number;
  readonly visible: boolean;
  readonly stripChromaKey?: boolean;
  readonly chromaTolerance?: number;
}

export interface ParallaxSceneOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly skyTopRgb: RgbTuple;
  readonly horizonRgb: RgbTuple;
  readonly contrastDampening: number;
  readonly paletteHex?: readonly string[];
  readonly snapToPalette?: boolean;
}

export interface ProcessedParallaxLayer {
  readonly id: string;
  readonly name: string;
  readonly role?: ParallaxBandRole;
  readonly buffer: RgbaBuffer;
  readonly scrollRatioX: number;
  readonly yOffsetPx: number;
  readonly seamBlendPx: number;
  readonly depthHaze: number;
  readonly visible: boolean;
}

function clampFloat(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function sanitizeRgb(rgb: RgbTuple): [number, number, number] {
  return [clampInt(rgb[0], 0, 255, 0), clampInt(rgb[1], 0, 255, 0), clampInt(rgb[2], 0, 255, 0)];
}

export function hexToRgbTuple(hex: string): [number, number, number] {
  const { r, g, b } = parseHexRgb(hex);
  return sanitizeRgb([r, g, b]);
}

/**
 * Eliminates horizontal vertical-seam discontinuities across `x = width - 1 -> 0` by collapsing
 * `blendWidthPx` right-tail columns into the left-head columns via smoothstep-weighted,
 * premultiplied-alpha crossfade (preventing black fringes around semi-transparent edges).
 */
export function makeHorizontallySeamless(src: RgbaBuffer, blendWidthPx: number): RgbaBuffer {
  const w = src.width;
  const h = src.height;
  if (w <= 0 || h <= 0) {
    return { width: 0, height: 0, data: new Uint8ClampedArray(0) };
  }

  const maxBlend = Math.floor((w - 1) / 2);
  const b = clampInt(blendWidthPx, 0, Math.max(0, maxBlend), 0);
  if (b <= 0) {
    return { width: w, height: h, data: new Uint8ClampedArray(src.data) };
  }

  const outW = w - b;
  const out = new Uint8ClampedArray(outW * h * 4);
  const srcData = src.data;

  // Precompute smoothstep weights across [0 .. b - 1]
  const weights = new Float64Array(b);
  for (let x = 0; x < b; x++) {
    const u = (x + 1) / (b + 1);
    weights[x] = u * u * (3 - 2 * u);
  }

  for (let y = 0; y < h; y++) {
    const srcRowOffset = y * w * 4;
    const outRowOffset = y * outW * 4;

    for (let x = 0; x < b; x++) {
      const t = weights[x] ?? 0.5;
      const oneMinusT = 1 - t;

      const idxA = srcRowOffset + (outW + x) * 4; // Right tail [W - b + x]
      const idxB = srcRowOffset + x * 4; // Left head [x]
      const outIdx = outRowOffset + x * 4;

      const aA255 = srcData[idxA + 3] ?? 0;
      const aB255 = srcData[idxB + 3] ?? 0;
      const outA = Math.round(oneMinusT * aA255 + t * aB255);

      if (outA <= 0) {
        out[outIdx] = 0;
        out[outIdx + 1] = 0;
        out[outIdx + 2] = 0;
        out[outIdx + 3] = 0;
        continue;
      }

      const wA = oneMinusT * (aA255 / 255);
      const wB = t * (aB255 / 255);
      const wSum = wA + wB;

      if (wSum <= 1e-6) {
        out[outIdx] = 0;
        out[outIdx + 1] = 0;
        out[outIdx + 2] = 0;
        out[outIdx + 3] = 0;
        continue;
      }

      const rA = srcData[idxA] ?? 0;
      const gA = srcData[idxA + 1] ?? 0;
      const bA = srcData[idxA + 2] ?? 0;
      const rB = srcData[idxB] ?? 0;
      const gB = srcData[idxB + 1] ?? 0;
      const bB = srcData[idxB + 2] ?? 0;

      out[outIdx] = Math.round((wA * rA + wB * rB) / wSum);
      out[outIdx + 1] = Math.round((wA * gA + wB * gB) / wSum);
      out[outIdx + 2] = Math.round((wA * bA + wB * bB) / wSum);
      out[outIdx + 3] = outA;
    }

    // Copy unblended interior slice [b .. outW - 1]
    const tailLen = outW - b;
    if (tailLen > 0) {
      out.set(
        srcData.subarray(srcRowOffset + b * 4, srcRowOffset + outW * 4),
        outRowOffset + b * 4,
      );
    }
  }

  return { width: outW, height: h, data: out };
}

/**
 * Applies aerial perspective (contrast compression + horizon RGB scatter blend) to opaque pixels
 * while leaving `alpha === 0` silhouette gaps completely untouched.
 */
export function applyAtmosphericDepthTint(
  src: RgbaBuffer,
  depthHaze: number,
  horizonRgb: RgbTuple,
  contrastDampening = 0.35,
): RgbaBuffer {
  const haze = clampFloat(depthHaze, 0, 1, 0);
  const damp = clampFloat(contrastDampening, 0, 1, 0.35);
  const [hR, hG, hB] = sanitizeRgb(horizonRgb);

  const out = new Uint8ClampedArray(src.data);
  if (haze <= 0) {
    return { width: src.width, height: src.height, data: out };
  }

  const contrastScale = 1 - haze * damp * 0.65;
  const invHaze = 1 - haze;

  for (let px = 0; px < out.length; px += 4) {
    const alpha = out[px + 3] ?? 0;
    if (alpha === 0) continue;

    const r = out[px] ?? 0;
    const g = out[px + 1] ?? 0;
    const b = out[px + 2] ?? 0;

    const cR = Math.max(0, Math.min(255, 128 + (r - 128) * contrastScale));
    const cG = Math.max(0, Math.min(255, 128 + (g - 128) * contrastScale));
    const cB = Math.max(0, Math.min(255, 128 + (b - 128) * contrastScale));

    out[px] = Math.max(0, Math.min(255, Math.round(cR * invHaze + hR * haze)));
    out[px + 1] = Math.max(0, Math.min(255, Math.round(cG * invHaze + hG * haze)));
    out[px + 2] = Math.max(0, Math.min(255, Math.round(cB * invHaze + hB * haze)));
  }

  return { width: src.width, height: src.height, data: out };
}

/**
 * Runs optional `#FF00FF` chroma-key stripping, horizontal seam wrapping, aerial depth tinting,
 * and optional OKLab palette snapping on a single parallax layer.
 */
export function processSingleParallaxLayer(
  layer: ParallaxLayerInput,
  opts: Pick<
    ParallaxSceneOptions,
    'horizonRgb' | 'contrastDampening' | 'paletteHex' | 'snapToPalette'
  >,
): ProcessedParallaxLayer {
  let working: RgbaBuffer = {
    width: layer.source.width,
    height: layer.source.height,
    data: new Uint8ClampedArray(layer.source.data),
  };

  if (layer.stripChromaKey && working.width > 0 && working.height > 0) {
    const keyed = removeBackgroundColorKey(working.data, working.width, working.height, {
      tolerance: clampFloat(layer.chromaTolerance ?? 28, 0, 100, 28),
      contiguous: false,
      keyColor: { r: 255, g: 0, b: 255 },
    });
    working = {
      width: working.width,
      height: working.height,
      data: keyed,
    };
  }

  const seamBlendPx = clampInt(layer.seamBlendPx, 0, 64, 0);
  const depthHaze = clampFloat(layer.depthHaze, 0, 1, 0);
  const scrollRatioX = clampFloat(layer.scrollRatioX, 0.05, 1.25, 0.5);
  const yOffsetPx = clampInt(layer.yOffsetPx, -512, 512, 0);

  working = makeHorizontallySeamless(working, seamBlendPx);
  working = applyAtmosphericDepthTint(working, depthHaze, opts.horizonRgb, opts.contrastDampening);

  if (opts.snapToPalette && opts.paletteHex && opts.paletteHex.length > 0) {
    const quantized = quantizeToPaletteOklab(
      working.data,
      working.width,
      working.height,
      opts.paletteHex,
      { dither: false },
    );
    working = {
      width: working.width,
      height: working.height,
      data: quantized,
    };
  }

  return {
    id: layer.id,
    name: layer.name,
    ...(layer.role ? { role: layer.role } : {}),
    buffer: working,
    scrollRatioX,
    yOffsetPx,
    seamBlendPx,
    depthHaze,
    visible: layer.visible,
  };
}

/**
 * Processes an ordered back-to-front array of raw parallax bands deterministically.
 */
export function processParallaxStack(
  layers: readonly ParallaxLayerInput[],
  opts: ParallaxSceneOptions,
): ProcessedParallaxLayer[] {
  return layers.map((layer) => processSingleParallaxLayer(layer, opts));
}

/**
 * Renders a deterministic sky-to-horizon gradient and horizontally wrapped parallax frame at `cameraX`.
 */
export function composeParallaxPreviewFrame(
  layers: readonly ProcessedParallaxLayer[],
  opts: ParallaxSceneOptions,
  cameraX: number,
): RgbaBuffer {
  const vw = clampInt(opts.viewportWidth, 1, 2048, 320);
  const vh = clampInt(opts.viewportHeight, 1, 2048, 180);
  const [topR, topG, topB] = sanitizeRgb(opts.skyTopRgb);
  const [horR, horG, horB] = sanitizeRgb(opts.horizonRgb);
  const safeCamX = Number.isFinite(cameraX) ? cameraX : 0;

  const out = new Uint8ClampedArray(vw * vh * 4);

  // Fill sky gradient once per row
  const rowDiv = Math.max(1, vh - 1);
  for (let y = 0; y < vh; y++) {
    const t = y / rowDiv;
    const skyR = Math.round(topR + (horR - topR) * t);
    const skyG = Math.round(topG + (horG - topG) * t);
    const skyB = Math.round(topB + (horB - topB) * t);
    const rowStart = y * vw * 4;
    for (let x = 0; x < vw; x++) {
      const px = rowStart + x * 4;
      out[px] = skyR;
      out[px + 1] = skyG;
      out[px + 2] = skyB;
      out[px + 3] = 255;
    }
  }

  // Composite visible layers back-to-front with exact positive integer modulo wrapping
  for (const layer of layers) {
    if (!layer.visible) continue;
    const lw = layer.buffer.width;
    const lh = layer.buffer.height;
    if (lw <= 0 || lh <= 0) continue;

    const lData = layer.buffer.data;
    const shiftX = Math.round(safeCamX * layer.scrollRatioX);
    const baseY = vh - lh + Math.round(layer.yOffsetPx);

    for (let ly = 0; ly < lh; ly++) {
      const dstY = baseY + ly;
      if (dstY < 0 || dstY >= vh) continue;

      const srcRow = ly * lw * 4;
      const dstRow = dstY * vw * 4;

      for (let x = 0; x < vw; x++) {
        const srcX = (((x + shiftX) % lw) + lw) % lw;
        const sPx = srcRow + srcX * 4;
        const sa255 = lData[sPx + 3] ?? 0;
        if (sa255 === 0) continue;

        const dPx = dstRow + x * 4;
        if (sa255 === 255) {
          out[dPx] = lData[sPx] ?? 0;
          out[dPx + 1] = lData[sPx + 1] ?? 0;
          out[dPx + 2] = lData[sPx + 2] ?? 0;
          out[dPx + 3] = 255;
          continue;
        }

        const sa = sa255 / 255;
        const invSa = 1 - sa;
        out[dPx] = Math.round((lData[sPx] ?? 0) * sa + (out[dPx] ?? 0) * invSa);
        out[dPx + 1] = Math.round((lData[sPx + 1] ?? 0) * sa + (out[dPx + 1] ?? 0) * invSa);
        out[dPx + 2] = Math.round((lData[sPx + 2] ?? 0) * sa + (out[dPx + 2] ?? 0) * invSa);
        out[dPx + 3] = 255;
      }
    }
  }

  return { width: vw, height: vh, data: out };
}
