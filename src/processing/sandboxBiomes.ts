import type { RgbaBuffer } from './types';

export type BiomeId =
  'dark-dungeon' | 'sunlit-meadow' | 'bright-snow' | 'urban-asphalt' | 'neutral-checker';

export interface BiomePresetMeta {
  readonly id: BiomeId;
  readonly label: string;
  readonly shortLabel: string;
  readonly targetLuminanceHint: string;
}

export const BIOME_PRESETS: readonly BiomePresetMeta[] = [
  {
    id: 'dark-dungeon',
    label: 'Dark Dungeon',
    shortLabel: 'Dungeon',
    targetLuminanceHint: '~0.05L',
  },
  {
    id: 'urban-asphalt',
    label: 'Urban Asphalt',
    shortLabel: 'Asphalt',
    targetLuminanceHint: '~0.21L',
  },
  {
    id: 'sunlit-meadow',
    label: 'Sunlit Meadow',
    shortLabel: 'Meadow',
    targetLuminanceHint: '~0.36L',
  },
  {
    id: 'neutral-checker',
    label: 'Neutral Checker',
    shortLabel: 'Checker',
    targetLuminanceHint: '~0.50L',
  },
  {
    id: 'bright-snow',
    label: 'Bright Snow',
    shortLabel: 'Snow',
    targetLuminanceHint: '~0.78L',
  },
];

export interface ParallaxLayerSet {
  readonly far: RgbaBuffer;
  readonly mid: RgbaBuffer;
  readonly ground: RgbaBuffer;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** Deterministic integer 2D hash returning [0, 1). */
function hash2d(x: number, y: number, seed: number): number {
  let h =
    Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = h ^ (h >>> 16);
  return (h >>> 0) / 4294967296;
}

/** Smooth periodic value noise over a tile of `size` with integer cell count `cells`. */
function tileableValueNoise(
  x: number,
  y: number,
  size: number,
  cells: number,
  seed: number,
): number {
  const cellCount = Math.max(1, cells);
  const gx = ((((x % size) + size) % size) / size) * cellCount;
  const gy = ((((y % size) + size) % size) / size) * cellCount;
  const x0 = Math.floor(gx) % cellCount;
  const y0 = Math.floor(gy) % cellCount;
  const x1 = (x0 + 1) % cellCount;
  const y1 = (y0 + 1) % cellCount;

  const tx = gx - Math.floor(gx);
  const ty = gy - Math.floor(gy);
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);

  const v00 = hash2d(x0, y0, seed);
  const v10 = hash2d(x1, y0, seed);
  const v01 = hash2d(x0, y1, seed);
  const v11 = hash2d(x1, y1, seed);

  const ix0 = v00 + (v10 - v00) * sx;
  const ix1 = v01 + (v11 - v01) * sx;
  return ix0 + (ix1 - ix0) * sy;
}

function putOpaquePixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
): void {
  const i = (y * width + x) * 4;
  data[i] = clampByte(r);
  data[i + 1] = clampByte(g);
  data[i + 2] = clampByte(b);
  data[i + 3] = 255;
}

function putAlphaPixel(
  data: Uint8ClampedArray,
  width: number,
  x: number,
  y: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  const i = (y * width + x) * 4;
  data[i] = clampByte(r);
  data[i + 1] = clampByte(g);
  data[i + 2] = clampByte(b);
  data[i + 3] = clampByte(a);
}

/**
 * Generates a deterministic, seamlessly tiling procedural biome square (`alpha === 255`).
 */
export function generateBiomeTile(biomeId: BiomeId, size = 64): RgbaBuffer {
  const w = Math.max(8, Math.floor(size));
  const h = w;
  const data = new Uint8ClampedArray(w * h * 4);

  if (biomeId === 'dark-dungeon') {
    for (let y = 0; y < h; y++) {
      const rowIdx = Math.floor(y / 16);
      const rowOffset = (rowIdx % 2) * 8;
      const localY = y % 16;
      for (let x = 0; x < w; x++) {
        const brickX = (x + rowOffset) % w;
        const colIdx = Math.floor(brickX / 16);
        const localX = brickX % 16;
        const isMortar = localY === 0 || localX === 0;
        const n = tileableValueNoise(x, y, w, 16, 101);
        const stoneTint = hash2d(colIdx, rowIdx, 202) * 10;

        if (isMortar) {
          putOpaquePixel(data, w, x, y, 36 + n * 6, 39 + n * 6, 46 + n * 7);
        } else {
          const highlight = localY === 1 || localX === 1 ? 6 : 0;
          const baseR = 54 + stoneTint + n * 10 + highlight;
          const baseG = 57 + stoneTint + n * 10 + highlight;
          const baseB = 65 + stoneTint + n * 11 + highlight;
          putOpaquePixel(data, w, x, y, baseR, baseG, baseB);
        }
      }
    }
    return { width: w, height: h, data };
  }

  if (biomeId === 'sunlit-meadow') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const patch = tileableValueNoise(x, y, w, 8, 303);
        const blade = hash2d(x, y, 404);
        const pebble = hash2d(Math.floor(x / 2), Math.floor(y / 2), 505);

        if (pebble > 0.965 && patch > 0.35) {
          putOpaquePixel(data, w, x, y, 162, 156, 138);
        } else {
          const tuft = blade > 0.72 ? 14 : blade < 0.18 ? -10 : 0;
          const r = 84 + patch * 24 + tuft * 0.6;
          const g = 160 + patch * 28 + tuft;
          const b = 70 + patch * 18 + tuft * 0.4;
          putOpaquePixel(data, w, x, y, r, g, b);
        }
      }
    }
    return { width: w, height: h, data };
  }

  if (biomeId === 'bright-snow') {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const ripple = Math.sin(((x + y * 0.5) / w) * Math.PI * 4) * 0.5 + 0.5;
        const drift = tileableValueNoise(x, y, w, 8, 606);
        const sparkle = hash2d(x, y, 707) > 0.975 ? 10 : 0;
        const mix = ripple * 0.45 + drift * 0.55;
        const r = 210 + mix * 26 + sparkle;
        const g = 220 + mix * 24 + sparkle;
        const b = 232 + mix * 18 + sparkle;
        putOpaquePixel(data, w, x, y, r, g, b);
      }
    }
    return { width: w, height: h, data };
  }

  if (biomeId === 'urban-asphalt') {
    for (let y = 0; y < h; y++) {
      const centerBand = y >= Math.floor(h * 0.47) && y <= Math.floor(h * 0.52);
      for (let x = 0; x < w; x++) {
        const dash = centerBand && x % 16 < 9;
        const grit = hash2d(x, y, 808);
        const wear = tileableValueNoise(x, y, w, 12, 909);

        if (dash) {
          putOpaquePixel(data, w, x, y, 206 + grit * 14, 190 + grit * 12, 118 + grit * 8);
        } else {
          const speck = grit > 0.88 ? 14 : grit < 0.12 ? -10 : 0;
          const base = 108 + wear * 20 + speck;
          putOpaquePixel(data, w, x, y, base, base + 3, base + 8);
        }
      }
    }
    return { width: w, height: h, data };
  }

  // neutral-checker
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const darkSquare = ((Math.floor(x / 8) + Math.floor(y / 8)) & 1) === 0;
      const v = darkSquare ? 168 : 204;
      putOpaquePixel(data, w, x, y, v, v, v + 2);
    }
  }
  return { width: w, height: h, data };
}

/**
 * Generates 3 side-scroller parallax layers (`far`, `mid`, `ground`) matching each biome's palette.
 */
export function generateParallaxLayers(biomeId: BiomeId, size = 64): ParallaxLayerSet {
  const w = Math.max(8, Math.floor(size));
  const h = w;
  const far = new Uint8ClampedArray(w * h * 4);
  const mid = new Uint8ClampedArray(w * h * 4);
  const ground = generateBiomeTile(biomeId, w);

  for (let y = 0; y < h; y++) {
    const t = y / Math.max(1, h - 1);
    for (let x = 0; x < w; x++) {
      const ridgeFar = Math.floor(
        h * 0.48 +
          Math.sin((x / w) * Math.PI * 2) * (h * 0.14) +
          Math.cos((x / w) * Math.PI * 6) * 3,
      );
      const ridgeMid = Math.floor(h * 0.62 + Math.sin((x / w) * Math.PI * 4 + 1.1) * (h * 0.12));

      if (biomeId === 'dark-dungeon') {
        const arch = Math.abs((x % 32) - 16);
        const sky = 22 + t * 14;
        putOpaquePixel(far, w, x, y, sky, sky + 2, sky + 8);
        if (y >= ridgeFar && arch > 6) {
          putAlphaPixel(mid, w, x, y, 42, 46, 56, 220);
        }
      } else if (biomeId === 'sunlit-meadow') {
        putOpaquePixel(far, w, x, y, 118 + t * 44, 174 + t * 34, 226);
        if (y >= ridgeFar) {
          putOpaquePixel(far, w, x, y, 94, 148, 128);
        }
        if (y >= ridgeMid) {
          putAlphaPixel(mid, w, x, y, 72, 134, 76, 235);
        }
      } else if (biomeId === 'bright-snow') {
        putOpaquePixel(far, w, x, y, 186 + t * 32, 206 + t * 28, 232);
        if (y >= ridgeFar) {
          putOpaquePixel(far, w, x, y, 198, 214, 234);
        }
        if (y >= ridgeMid) {
          putAlphaPixel(mid, w, x, y, 214, 226, 240, 235);
        }
      } else if (biomeId === 'urban-asphalt') {
        putOpaquePixel(far, w, x, y, 68 + t * 24, 78 + t * 24, 98 + t * 24);
        const skyHeight = h * (0.35 + hash2d(Math.floor(x / 12), 1, 99) * 0.35);
        if (y >= skyHeight) {
          putOpaquePixel(far, w, x, y, 78, 86, 102);
        }
        if (y >= ridgeMid) {
          putAlphaPixel(mid, w, x, y, 88, 94, 108, 230);
        }
      } else {
        putOpaquePixel(far, w, x, y, 178, 180, 184);
        if (y >= ridgeMid) {
          putAlphaPixel(mid, w, x, y, 152, 156, 162, 200);
        }
      }
    }
  }

  return {
    far: { width: w, height: h, data: far },
    mid: { width: w, height: h, data: mid },
    ground,
  };
}
