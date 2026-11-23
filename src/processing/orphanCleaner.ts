import type { RgbaBuffer } from './types';

export interface OrphanCleanOptions {
  readonly maxIslandPixels?: number; // default 2 (removes 1px and 2px floating dust)
  readonly removeInteriorSpecks?: boolean; // default true
  readonly colorToleranceSq?: number; // squared Euclidean RGB tolerance, default 900 (~30 per channel)
  readonly alphaThreshold?: number; // default 128
}

function rgbDistSq(data: Uint8ClampedArray, idxA: number, idxB: number): number {
  const dr = (data[idxA] ?? 0) - (data[idxB] ?? 0);
  const dg = (data[idxA + 1] ?? 0) - (data[idxB + 1] ?? 0);
  const db = (data[idxA + 2] ?? 0) - (data[idxB + 2] ?? 0);
  return dr * dr + dg * dg + db * db;
}

/**
 * Purges detached small alpha islands via 4-connected BFS and removes isolated
 * 1px interior color specks where >= 3 cardinal neighbors form a uniform surface.
 */
export function cleanOrphanPixels(
  buf: RgbaBuffer,
  options: OrphanCleanOptions = {},
): { buffer: RgbaBuffer; removedIslands: number; cleanedSpecks: number } {
  const { width, height } = buf;
  const out = new Uint8ClampedArray(buf.data);
  if (width <= 0 || height <= 0) {
    return { buffer: { width, height, data: out }, removedIslands: 0, cleanedSpecks: 0 };
  }

  const maxIsland = Math.max(0, options.maxIslandPixels ?? 2);
  const alphaThreshold = options.alphaThreshold ?? 128;
  const tolSq = Math.max(0, options.colorToleranceSq ?? 900);

  // Pass 1: 4-connected alpha island removal
  const visited = new Uint8Array(width * height);
  const components: number[][] = [];
  const queue = new Int32Array(width * height);

  for (let i = 0; i < width * height; i++) {
    if (visited[i] || (out[i * 4 + 3] ?? 0) < alphaThreshold) continue;

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    const pixels: number[] = [];

    while (head < tail) {
      const cur = queue[head++] ?? 0;
      pixels.push(cur);
      const cx = cur % width;
      const cy = (cur - cx) / width;

      const neighbors = [
        cx > 0 ? cur - 1 : -1,
        cx + 1 < width ? cur + 1 : -1,
        cy > 0 ? cur - width : -1,
        cy + 1 < height ? cur + width : -1,
      ];

      for (const n of neighbors) {
        if (n >= 0 && !visited[n] && (out[n * 4 + 3] ?? 0) >= alphaThreshold) {
          visited[n] = 1;
          queue[tail++] = n;
        }
      }
    }
    components.push(pixels);
  }

  let largestSize = 0;
  for (const c of components) {
    if (c.length > largestSize) largestSize = c.length;
  }

  let removedIslands = 0;
  for (const c of components) {
    if (c.length <= maxIsland && c.length < largestSize) {
      removedIslands++;
      for (const p of c) {
        const base = p * 4;
        out[base] = 0;
        out[base + 1] = 0;
        out[base + 2] = 0;
        out[base + 3] = 0;
      }
    }
  }

  // Pass 2: Interior 1px pepper despeckle
  let cleanedSpecks = 0;
  if ((options.removeInteriorSpecks ?? true) && width >= 3 && height >= 3) {
    const snapshot = new Uint8ClampedArray(out);

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const idx = (y * width + x) * 4;
        if ((snapshot[idx + 3] ?? 0) < alphaThreshold) continue;

        const nIdx = [idx - 4, idx + 4, idx - width * 4, idx + width * 4] as const;

        if (nIdx.some((ni) => (snapshot[ni + 3] ?? 0) < alphaThreshold)) continue;
        if (nIdx.some((ni) => rgbDistSq(snapshot, idx, ni) <= tolSq)) continue;

        let consensus: number[] | null = null;
        for (const seed of nIdx) {
          const group = nIdx.filter((other) => rgbDistSq(snapshot, seed, other) <= tolSq);
          if (group.length >= 3) {
            consensus = group;
            break;
          }
        }

        if (consensus) {
          let r = 0;
          let g = 0;
          let b = 0;
          for (const ci of consensus) {
            r += snapshot[ci] ?? 0;
            g += snapshot[ci + 1] ?? 0;
            b += snapshot[ci + 2] ?? 0;
          }
          out[idx] = Math.round(r / consensus.length);
          out[idx + 1] = Math.round(g / consensus.length);
          out[idx + 2] = Math.round(b / consensus.length);
          cleanedSpecks++;
        }
      }
    }
  }

  return {
    buffer: { width, height, data: out },
    removedIslands,
    cleanedSpecks,
  };
}
