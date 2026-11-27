import { z } from 'zod';

export const NormalBakeHeightSourceSchema = z.enum(['luminance', 'alpha-bevel', 'hybrid']);
export type NormalBakeHeightSource = z.infer<typeof NormalBakeHeightSourceSchema>;

export const NormalBakeConfigSchema = z.object({
  strength: z.number().min(0.1).max(5.0).default(1.5),
  bevelRadiusPx: z.number().min(0).max(4).default(2),
  invertY: z.boolean().default(false),
  heightSource: NormalBakeHeightSourceSchema.default('hybrid'),
  sharpenPixelArt: z.boolean().default(true),
});
export type NormalBakeConfig = z.infer<typeof NormalBakeConfigSchema>;

export const EmissionBakeModeSchema = z.enum(['palette-swatches', 'luminance-threshold']);
export type EmissionBakeMode = z.infer<typeof EmissionBakeModeSchema>;

export const EmissionBakeConfigSchema = z.object({
  mode: EmissionBakeModeSchema.default('palette-swatches'),
  emissiveHexColors: z.array(z.string()).default([]),
  colorTolerance: z.number().min(0).max(32).default(8),
  minLuminance: z.number().min(0).max(1).default(0.75),
  minSaturation: z.number().min(0).max(1).default(0.5),
});
export type EmissionBakeConfig = z.infer<typeof EmissionBakeConfigSchema>;

export function createDefaultNormalBakeConfig(): NormalBakeConfig {
  return NormalBakeConfigSchema.parse({});
}

export function createDefaultEmissionBakeConfig(): EmissionBakeConfig {
  return EmissionBakeConfigSchema.parse({});
}

function clampNum(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampByte(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

function parseHexColorRgb(raw: string): readonly [number, number, number] | null {
  const clean = raw.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [
      parseInt(clean.slice(0, 2), 16),
      parseInt(clean.slice(2, 4), 16),
      parseInt(clean.slice(4, 6), 16),
    ];
  }
  if (/^[0-9a-fA-F]{3}$/.test(clean)) {
    return [
      parseInt(clean[0]! + clean[0]!, 16),
      parseInt(clean[1]! + clean[1]!, 16),
      parseInt(clean[2]! + clean[2]!, 16),
    ];
  }
  return null;
}

function computeHeightField(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  heightSource: NormalBakeHeightSource,
  bevelRadiusPx: number,
  sharpenPixelArt: boolean,
): Float32Array {
  const total = width * height;
  const hField = new Float32Array(total);
  const clampedRadius = clampNum(bevelRadiusPx, 0, 4);
  const searchRadius = Math.ceil(clampedRadius);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pIdx = y * width + x;
      const rgbaIdx = pIdx * 4;
      const alpha = rgba[rgbaIdx + 3] ?? 0;
      if (alpha === 0) {
        hField[pIdx] = 0;
        continue;
      }

      const r = rgba[rgbaIdx] ?? 0;
      const g = rgba[rgbaIdx + 1] ?? 0;
      const b = rgba[rgbaIdx + 2] ?? 0;
      const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

      let bevel = 1.0;
      if (clampedRadius > 0 && heightSource !== 'luminance') {
        let minDist = clampedRadius + 1;
        for (let oy = -searchRadius; oy <= searchRadius; oy++) {
          for (let ox = -searchRadius; ox <= searchRadius; ox++) {
            const nx = x + ox;
            const ny = y + oy;
            const isTransparent =
              nx < 0 ||
              ny < 0 ||
              nx >= width ||
              ny >= height ||
              (rgba[(ny * width + nx) * 4 + 3] ?? 0) === 0;
            if (isTransparent) {
              const dist = Math.hypot(ox, oy);
              if (dist < minDist) {
                minDist = dist;
              }
            }
          }
        }
        const t = Math.min(1, Math.max(0, minDist / clampedRadius));
        bevel = sharpenPixelArt ? t : t * t * (3 - 2 * t);
      }

      if (heightSource === 'luminance') {
        hField[pIdx] = luminance;
      } else if (heightSource === 'alpha-bevel') {
        hField[pIdx] = bevel;
      } else {
        hField[pIdx] = clampedRadius > 0 ? 0.55 * bevel + 0.45 * luminance : luminance;
      }
    }
  }

  return hField;
}

/**
 * Computes a deterministic tangent-space normal map RGBA buffer from raw RGBA pixels
 * using 3x3 Sobel gradients on a luminance / alpha-bevel height field.
 * Transparent pixels (`alpha === 0`) emit neutral flat normal `(128, 128, 255, 0)`.
 */
export function bakeNormalMapFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  config: NormalBakeConfig = createDefaultNormalBakeConfig(),
): Uint8ClampedArray {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid sprite dimensions ${width}x${height} for normal baking.`);
  }
  if (rgba.length < width * height * 4) {
    throw new Error('RGBA buffer length is smaller than width * height * 4.');
  }

  const strength = clampNum(config.strength, 0.1, 5.0);
  const bevelRadiusPx = clampNum(config.bevelRadiusPx, 0, 4);
  const hField = computeHeightField(
    rgba,
    width,
    height,
    config.heightSource,
    bevelRadiusPx,
    config.sharpenPixelArt,
  );

  const out = new Uint8ClampedArray(width * height * 4);
  const sampleH = (sx: number, sy: number): number => {
    const cx = Math.max(0, Math.min(width - 1, sx));
    const cy = Math.max(0, Math.min(height - 1, sy));
    return hField[cy * width + cx] ?? 0;
  };

  const centerWeight = config.sharpenPixelArt ? 2 : 1.5;
  const divisor = 4 + 2 * centerWeight;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if ((rgba[idx + 3] ?? 0) === 0) {
        out[idx] = 128;
        out[idx + 1] = 128;
        out[idx + 2] = 255;
        out[idx + 3] = 0;
        continue;
      }

      const tl = sampleH(x - 1, y - 1);
      const tm = sampleH(x, y - 1);
      const tr = sampleH(x + 1, y - 1);
      const ml = sampleH(x - 1, y);
      const mr = sampleH(x + 1, y);
      const bl = sampleH(x - 1, y + 1);
      const bm = sampleH(x, y + 1);
      const br = sampleH(x + 1, y + 1);

      const dx =
        ((tr + centerWeight * mr + br - (tl + centerWeight * ml + bl)) / divisor) * strength;
      const dy =
        ((bl + centerWeight * bm + br - (tl + centerWeight * tm + tr)) / divisor) * strength;

      const nxRaw = -dx;
      const nyRaw = config.invertY ? dy : -dy;
      const nzRaw = 1.0;
      const len = Math.hypot(nxRaw, nyRaw, nzRaw) || 1;

      const nx = nxRaw / len;
      const ny = nyRaw / len;
      const nz = nzRaw / len;

      out[idx] = clampByte(128 + 127 * nx);
      out[idx + 1] = clampByte(128 + 127 * ny);
      out[idx + 2] = clampByte(128 + 127 * nz);
      out[idx + 3] = 255;
    }
  }

  return out;
}

export interface EmissionBakeResult {
  readonly rgba: Uint8ClampedArray;
  readonly emissivePixelCount: number;
}

/**
 * Extracts emissive sprite pixels (`_e.png`) matching either configured palette swatches
 * or luminance/saturation thresholds, zeroing all non-emissive pixels `(0, 0, 0, 0)`.
 */
export function bakeEmissionMaskFromRgba(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  config: EmissionBakeConfig = createDefaultEmissionBakeConfig(),
): EmissionBakeResult {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`Invalid sprite dimensions ${width}x${height} for emission baking.`);
  }
  if (rgba.length < width * height * 4) {
    throw new Error('RGBA buffer length is smaller than width * height * 4.');
  }

  const out = new Uint8ClampedArray(width * height * 4);
  const parsedSwatches = config.emissiveHexColors
    .map(parseHexColorRgb)
    .filter((rgb): rgb is readonly [number, number, number] => rgb !== null);
  const maxDist = clampNum(config.colorTolerance, 0, 32) * Math.sqrt(3);
  const minLum = clampNum(config.minLuminance, 0, 1);
  const minSat = clampNum(config.minSaturation, 0, 1);

  let emissivePixelCount = 0;

  for (let i = 0; i < width * height; i++) {
    const idx = i * 4;
    const alpha = rgba[idx + 3] ?? 0;
    if (alpha === 0) continue;

    const r = rgba[idx] ?? 0;
    const g = rgba[idx + 1] ?? 0;
    const b = rgba[idx + 2] ?? 0;

    let isEmissive = false;
    if (config.mode === 'palette-swatches') {
      for (const [sr, sg, sb] of parsedSwatches) {
        if (Math.hypot(r - sr, g - sg, b - sb) <= maxDist + 1e-6) {
          isEmissive = true;
          break;
        }
      }
    } else {
      const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      const maxC = Math.max(r, g, b) / 255;
      const minC = Math.min(r, g, b) / 255;
      const sat = maxC === 0 ? 0 : (maxC - minC) / maxC;
      if (lum >= minLum && sat >= minSat) {
        isEmissive = true;
      }
    }

    if (isEmissive) {
      out[idx] = r;
      out[idx + 1] = g;
      out[idx + 2] = b;
      out[idx + 3] = alpha;
      emissivePixelCount++;
    }
  }

  return { rgba: out, emissivePixelCount };
}
