export interface ColorRgb {
  r: number;
  g: number;
  b: number;
}

export interface BackgroundKeyOptions {
  tolerance: number;
  contiguous: boolean;
  keyColor?: ColorRgb;
}

const MAX_RGB_DISTANCE = Math.sqrt(255 * 255 * 3);

export function parseHexRgb(hex: string): ColorRgb {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  return {
    r: Number.parseInt(clean.slice(0, 2), 16) || 0,
    g: Number.parseInt(clean.slice(2, 4), 16) || 0,
    b: Number.parseInt(clean.slice(4, 6), 16) || 0,
  };
}

/**
 * Samples the 4 image corners and picks the dominant corner RGB color
 * as the default background chroma key.
 */
export function sampleCornerKeyColor(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): ColorRgb {
  const coords = [0, width - 1, (height - 1) * width, (height - 1) * width + (width - 1)];

  const buckets = new Map<string, { count: number; color: ColorRgb }>();
  for (const idx of coords) {
    const px = Math.max(0, Math.min(width * height - 1, idx)) * 4;
    const color: ColorRgb = {
      r: rgba[px] ?? 255,
      g: rgba[px + 1] ?? 255,
      b: rgba[px + 2] ?? 255,
    };
    const key = `${color.r},${color.g},${color.b}`;
    const existing = buckets.get(key);
    if (existing) {
      existing.count++;
    } else {
      buckets.set(key, { count: 1, color });
    }
  }

  let best: { count: number; color: ColorRgb } | null = null;
  for (const entry of buckets.values()) {
    if (!best || entry.count > best.count) {
      best = entry;
    }
  }
  return best?.color ?? { r: rgba[0] ?? 255, g: rgba[1] ?? 255, b: rgba[2] ?? 255 };
}

function normalizedColorDistance(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return (Math.sqrt(dr * dr + dg * dg + db * db) / MAX_RGB_DISTANCE) * 100;
}

/**
 * Removes background pixels matching the key color within `tolerance` (0..100).
 * When `contiguous` is true, runs a deterministic 4-connected BFS seeded from the image borders.
 */
export function removeBackgroundColorKey(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  options: BackgroundKeyOptions,
): Uint8ClampedArray {
  if (width <= 0 || height <= 0) {
    throw new Error(`Invalid dimensions: ${width}x${height}`);
  }
  const out = new Uint8ClampedArray(rgba);
  const tolerance = Math.max(0, Math.min(100, options.tolerance));
  const key = options.keyColor ?? sampleCornerKeyColor(rgba, width, height);
  const pixelCount = width * height;

  const matchesKey = (pixelIdx: number): boolean => {
    const px = pixelIdx * 4;
    if ((out[px + 3] ?? 0) === 0) return true;
    const dist = normalizedColorDistance(
      out[px] ?? 0,
      out[px + 1] ?? 0,
      out[px + 2] ?? 0,
      key.r,
      key.g,
      key.b,
    );
    return dist <= tolerance;
  };

  if (!options.contiguous) {
    for (let i = 0; i < pixelCount; i++) {
      if (matchesKey(i)) {
        const px = i * 4;
        out[px] = 0;
        out[px + 1] = 0;
        out[px + 2] = 0;
        out[px + 3] = 0;
      }
    }
    return out;
  }

  const visited = new Uint8Array(pixelCount);
  const queue = new Int32Array(pixelCount);
  let head = 0;
  let tail = 0;

  const tryEnqueue = (x: number, y: number) => {
    const idx = y * width + x;
    if (visited[idx] === 1) return;
    if (!matchesKey(idx)) return;
    visited[idx] = 1;
    queue[tail++] = idx;
  };

  for (let x = 0; x < width; x++) {
    tryEnqueue(x, 0);
    if (height > 1) tryEnqueue(x, height - 1);
  }
  for (let y = 1; y < height - 1; y++) {
    tryEnqueue(0, y);
    if (width > 1) tryEnqueue(width - 1, y);
  }

  while (head < tail) {
    const idx = queue[head++] ?? 0;
    const px = idx * 4;
    out[px] = 0;
    out[px + 1] = 0;
    out[px + 2] = 0;
    out[px + 3] = 0;

    const x = idx % width;
    const y = Math.floor(idx / width);
    if (x > 0) tryEnqueue(x - 1, y);
    if (x + 1 < width) tryEnqueue(x + 1, y);
    if (y > 0) tryEnqueue(x, y - 1);
    if (y + 1 < height) tryEnqueue(x, y + 1);
  }

  return out;
}
