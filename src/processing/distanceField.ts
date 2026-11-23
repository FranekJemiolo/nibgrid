import type { RgbaBuffer } from './types';

export type BevelProfile = 'spherical-dome' | 'smoothstep' | 'linear' | 'dome' | 'smooth';
export type NormalConvention = 'opengl' | 'directx';

export interface BevelOptions {
  readonly maxBevelPx?: number; // alias for bevelRadiusPx, default 16
  readonly bevelRadiusPx?: number;
  readonly profile?: BevelProfile;
  readonly alphaThreshold?: number; // default 128
}

export interface CpuNormalBakeOptions {
  readonly bevelRadiusPx: number;
  readonly bevelProfile: BevelProfile;
  readonly bevelStrength: number;
  readonly detailStrength: number;
  readonly convention: NormalConvention;
  readonly alphaThreshold?: number;
  readonly seamlessWrap?: boolean;
}

const INF = 1e12;

/**
 * Exact 1D squared Euclidean Distance Transform (Felzenszwalb & Huttenlocher) in O(n).
 */
function edt1d(
  f: Float32Array,
  n: number,
  out: Float32Array,
  v: Int32Array,
  z: Float32Array,
): void {
  let k = 0;
  v[0] = 0;
  z[0] = -INF;
  z[1] = INF;

  for (let q = 1; q < n; q++) {
    const fq = f[q] ?? INF;
    let vk = v[k] ?? 0;
    let s = (fq + q * q - ((f[vk] ?? INF) + vk * vk)) / (2 * q - 2 * vk);
    while (s <= (z[k] ?? -INF) && k > 0) {
      k--;
      vk = v[k] ?? 0;
      s = (fq + q * q - ((f[vk] ?? INF) + vk * vk)) / (2 * q - 2 * vk);
    }
    k++;
    v[k] = q;
    z[k] = s;
    z[k + 1] = INF;
  }

  k = 0;
  for (let q = 0; q < n; q++) {
    while ((z[k + 1] ?? INF) < q) k++;
    const vk = v[k] ?? 0;
    const dx = q - vk;
    out[q] = dx * dx + (f[vk] ?? INF);
  }
}

function shapeBevel(t: number, profile: BevelProfile): number {
  const c = Math.max(0, Math.min(1, t));
  switch (profile) {
    case 'spherical-dome':
    case 'dome':
      return Math.sqrt(1 - (1 - c) * (1 - c));
    case 'smoothstep':
    case 'smooth':
      return c * c * (3 - 2 * c);
    case 'linear':
      return c;
  }
}

/**
 * Computes exact inward Euclidean distances (in pixels) from every opaque pixel
 * to the nearest transparent pixel (treating outside canvas bounds as transparent).
 */
export function computeExactAlphaEdt(buf: RgbaBuffer, alphaThreshold = 128): Float32Array {
  const { width, height, data } = buf;
  if (width <= 0 || height <= 0) return new Float32Array(0);

  // Pad by a 1px transparent border so 1x1 / full-bleed opaque sprites always have 0 seeds
  const pw = width + 2;
  const ph = height + 2;
  const grid = new Float32Array(pw * ph);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const opaque = (data[(y * width + x) * 4 + 3] ?? 0) >= alphaThreshold;
      grid[(y + 1) * pw + (x + 1)] = opaque ? INF : 0;
    }
  }

  const maxDim = Math.max(pw, ph);
  const f = new Float32Array(maxDim);
  const d = new Float32Array(maxDim);
  const v = new Int32Array(maxDim);
  const z = new Float32Array(maxDim + 1);

  for (let y = 0; y < ph; y++) {
    const off = y * pw;
    for (let x = 0; x < pw; x++) f[x] = grid[off + x] ?? 0;
    edt1d(f, pw, d, v, z);
    for (let x = 0; x < pw; x++) grid[off + x] = d[x] ?? 0;
  }

  for (let x = 0; x < pw; x++) {
    for (let y = 0; y < ph; y++) f[y] = grid[y * pw + x] ?? 0;
    edt1d(f, ph, d, v, z);
    for (let y = 0; y < ph; y++) grid[y * pw + x] = d[y] ?? 0;
  }

  const distances = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distSq = grid[(y + 1) * pw + (x + 1)] ?? 0;
      distances[y * width + x] = distSq <= 0 ? 0 : Math.sqrt(distSq);
    }
  }
  return distances;
}

/**
 * Computes an 8-bit bevel heightmap (0..255) normalized by `maxBevelPx` / `bevelRadiusPx`.
 */
export function computeBevelHeightmap(buf: RgbaBuffer, options: BevelOptions = {}): Uint8Array {
  const { width, height } = buf;
  if (width <= 0 || height <= 0) return new Uint8Array(0);

  const radius = Math.max(1, options.bevelRadiusPx ?? options.maxBevelPx ?? 16);
  const profile = options.profile ?? 'spherical-dome';
  const distances = computeExactAlphaEdt(buf, options.alphaThreshold ?? 128);
  const out = new Uint8Array(width * height);

  for (let i = 0; i < distances.length; i++) {
    const dist = distances[i] ?? 0;
    if (dist <= 0) {
      out[i] = 0;
    } else {
      const shaped = shapeBevel(dist / radius, profile);
      out[i] = Math.round(shaped * 255);
    }
  }

  return out;
}

/**
 * Pure-TS deterministic CPU Sobel normal map baker matching `normalGen.frag.glsl` conventions.
 * Used as a fallback on headless / non-WebGL2 environments and for unit verification.
 */
export function bakeNormalMapCpu(buf: RgbaBuffer, options: CpuNormalBakeOptions): RgbaBuffer {
  const { width, height, data } = buf;
  const out = new Uint8ClampedArray(width * height * 4);
  if (width <= 0 || height <= 0) return { width, height, data: out };

  const threshold = options.alphaThreshold ?? 128;
  const seamlessWrap = Boolean(options.seamlessWrap);
  const bevelStrength = seamlessWrap ? 0 : options.bevelStrength;
  const bevel = seamlessWrap
    ? new Uint8Array(width * height)
    : computeBevelHeightmap(buf, {
        bevelRadiusPx: options.bevelRadiusPx,
        profile: options.bevelProfile,
        alphaThreshold: threshold,
      });

  const heightField = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const px = i * 4;
    const a = (data[px + 3] ?? 0) / 255;
    const r = (data[px] ?? 0) / 255;
    const g = (data[px + 1] ?? 0) / 255;
    const b = (data[px + 2] ?? 0) / 255;
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) * a;
    const bVal = (bevel[i] ?? 0) / 255;
    heightField[i] = bVal * bevelStrength + luma * options.detailStrength;
  }

  const sampleH = (x: number, y: number): number => {
    const cx = seamlessWrap ? ((x % width) + width) % width : Math.max(0, Math.min(width - 1, x));
    const cy = seamlessWrap
      ? ((y % height) + height) % height
      : Math.max(0, Math.min(height - 1, y));
    return heightField[cy * width + cx] ?? 0;
  };

  const invertY = options.convention === 'opengl' ? 1 : -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const alpha = data[idx + 3] ?? 0;
      if (alpha < threshold) {
        out[idx] = 128;
        out[idx + 1] = 128;
        out[idx + 2] = 255;
        out[idx + 3] = 0;
        continue;
      }

      // Match GLSL Sobel neighborhood where top is y - 1 and bottom is y + 1
      const tl = sampleH(x - 1, y - 1);
      const tc = sampleH(x, y - 1);
      const tr = sampleH(x + 1, y - 1);
      const ml = sampleH(x - 1, y);
      const mr = sampleH(x + 1, y);
      const bl = sampleH(x - 1, y + 1);
      const bc = sampleH(x, y + 1);
      const br = sampleH(x + 1, y + 1);

      const dX = tr + 2 * mr + br - (tl + 2 * ml + bl);
      const dY = tl + 2 * tc + tr - (bl + 2 * bc + br);

      const nx = -dX;
      const ny = -dY * invertY;
      const nz = 1;
      const len = Math.hypot(nx, ny, nz);

      out[idx] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      out[idx + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      out[idx + 2] = Math.round(((nz / len) * 0.5 + 0.5) * 255);
      out[idx + 3] = alpha;
    }
  }

  return { width, height, data: out };
}
