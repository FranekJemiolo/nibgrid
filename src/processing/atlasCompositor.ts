import type { PivotNorm } from '../domain/schemas';
import { packMaxRects, type MaxRectsOptions, type PlacedRect } from './maxRects';
import type { RgbaBuffer } from './types';

export interface AtlasFrameInput {
  readonly id: string;
  readonly sprite: RgbaBuffer;
  readonly normalMap?: RgbaBuffer;
  readonly pivotNorm?: PivotNorm;
  readonly animationName?: string;
}

export interface TrimmedFrameMeta {
  readonly trimX: number;
  readonly trimY: number;
  readonly trimW: number;
  readonly trimH: number;
  readonly sourceW: number;
  readonly sourceH: number;
  readonly trimmed: boolean;
}

export interface AtlasFramePlacement {
  readonly id: string;
  readonly hashKey: string;
  readonly pageIndex: number;
  readonly rect: PlacedRect;
  readonly trim: TrimmedFrameMeta;
  readonly pivotNorm: PivotNorm;
  readonly animationName?: string;
}

export interface ComposedAtlasPage {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly occupancy: number;
  readonly rects: readonly PlacedRect[];
  readonly albedo: RgbaBuffer;
  readonly normal?: RgbaBuffer;
}

export interface ComposedAtlasResult {
  readonly pages: readonly ComposedAtlasPage[];
  readonly frames: readonly AtlasFramePlacement[];
  readonly totalInputCount: number;
  readonly uniquePackedCount: number;
  readonly deduplicatedCount: number;
  readonly extrude: number;
  readonly padding: number;
}

function hashRgbaContent(buf: RgbaBuffer, normal?: RgbaBuffer): string {
  // Exact 64-bit FNV-1a pair to eliminate hash collisions in deterministic deduplication
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  const { data } = buf;
  for (let i = 0; i < data.length; i++) {
    const byte = data[i] ?? 0;
    h1 ^= byte;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (byte + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  if (normal) {
    for (let i = 0; i < normal.data.length; i++) {
      const byte = normal.data[i] ?? 0;
      h1 ^= byte;
      h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= (byte + i * 3) & 0xff;
      h2 = Math.imul(h2, 0xc2b2ae35) >>> 0;
    }
  }
  return `${buf.width}x${buf.height}:${h1.toString(16)}_${h2.toString(16)}`;
}

function cropBuffer(buf: RgbaBuffer, x0: number, y0: number, w: number, h: number): RgbaBuffer {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcStart = ((y0 + y) * buf.width + x0) * 4;
    const dstStart = y * w * 4;
    out.set(buf.data.subarray(srcStart, srcStart + w * 4), dstStart);
  }
  return { width: w, height: h, data: out };
}

function trimSpriteWithNormal(
  sprite: RgbaBuffer,
  normalMap?: RgbaBuffer,
): { albedo: RgbaBuffer; normal?: RgbaBuffer; meta: TrimmedFrameMeta } {
  const { width, height, data } = sprite;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < minX || maxY < minY) {
    // 100% transparent fallback: preserve 1x1 dummy frame so packer stays valid
    const blank = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
    const blankNorm = normalMap
      ? { width: 1, height: 1, data: new Uint8ClampedArray([128, 128, 255, 0]) }
      : undefined;
    return {
      albedo: blank,
      normal: blankNorm,
      meta: {
        trimX: 0,
        trimY: 0,
        trimW: 1,
        trimH: 1,
        sourceW: width,
        sourceH: height,
        trimmed: true,
      },
    };
  }

  const trimW = maxX - minX + 1;
  const trimH = maxY - minY + 1;
  const isTrimmed = minX !== 0 || minY !== 0 || trimW !== width || trimH !== height;
  const albedo = isTrimmed ? cropBuffer(sprite, minX, minY, trimW, trimH) : sprite;
  const normal =
    normalMap && normalMap.width === width && normalMap.height === height
      ? isTrimmed
        ? cropBuffer(normalMap, minX, minY, trimW, trimH)
        : normalMap
      : undefined;

  return {
    albedo,
    normal,
    meta: {
      trimX: minX,
      trimY: minY,
      trimW,
      trimH,
      sourceW: width,
      sourceH: height,
      trimmed: isTrimmed,
    },
  };
}

function blitWithExtrusion(
  dst: Uint8ClampedArray,
  dstW: number,
  dstH: number,
  src: RgbaBuffer,
  rect: PlacedRect,
  extrude: number,
): void {
  const copyPixel = (dx: number, dy: number, sx: number, sy: number) => {
    if (dx < 0 || dx >= dstW || dy < 0 || dy >= dstH) return;
    const clampedX = Math.max(0, Math.min(src.width - 1, sx));
    const clampedY = Math.max(0, Math.min(src.height - 1, sy));
    const si = (clampedY * src.width + clampedX) * 4;
    const di = (dy * dstW + dx) * 4;
    dst[di] = src.data[si] ?? 0;
    dst[di + 1] = src.data[si + 1] ?? 0;
    dst[di + 2] = src.data[si + 2] ?? 0;
    dst[di + 3] = src.data[si + 3] ?? 0;
  };

  for (let ly = -extrude; ly < rect.height + extrude; ly++) {
    for (let lx = -extrude; lx < rect.width + extrude; lx++) {
      const clampedLx = Math.max(0, Math.min(rect.width - 1, lx));
      const clampedLy = Math.max(0, Math.min(rect.height - 1, ly));
      let sx: number;
      let sy: number;
      if (rect.rotated) {
        // Inverse of 90-deg CW rotation (x' = srcH - 1 - sy, y' = sx)
        sx = clampedLy;
        sy = src.height - 1 - clampedLx;
      } else {
        sx = clampedLx;
        sy = clampedLy;
      }
      copyPixel(rect.x + lx, rect.y + ly, sx, sy);
    }
  }
}

/**
 * Deduplicates identical trimmed sprite frames, runs BSSF MaxRects packing,
 * blits clamped edge extrusion, and composites lockstep `_n.png` normal atlases when present.
 */
export function composeAtlasPages(
  inputs: readonly AtlasFrameInput[],
  options: MaxRectsOptions & { readonly disableRotationForEngine?: boolean },
): ComposedAtlasResult {
  const hasAnyNormal = inputs.some((item) => item.normalMap !== undefined);
  const safeAllowRotation =
    options.allowRotation && !hasAnyNormal && !options.disableRotationForEngine;

  interface UniqueItem {
    readonly packId: string;
    readonly albedo: RgbaBuffer;
    readonly normal?: RgbaBuffer;
  }

  const uniqueByHash = new Map<string, UniqueItem>();
  const uniqueOrder: UniqueItem[] = [];
  const preparedInputs: {
    readonly input: AtlasFrameInput;
    readonly hashKey: string;
    readonly trim: TrimmedFrameMeta;
    readonly packId: string;
  }[] = [];

  for (const input of inputs) {
    const trimmed = trimSpriteWithNormal(input.sprite, input.normalMap);
    const hashKey = hashRgbaContent(trimmed.albedo, trimmed.normal);
    let unique = uniqueByHash.get(hashKey);
    if (!unique) {
      unique = {
        packId: input.id,
        albedo: trimmed.albedo,
        normal: trimmed.normal,
      };
      uniqueByHash.set(hashKey, unique);
      uniqueOrder.push(unique);
    }
    preparedInputs.push({
      input,
      hashKey,
      trim: trimmed.meta,
      packId: unique.packId,
    });
  }

  const packedPages = packMaxRects(
    uniqueOrder.map((u) => ({
      id: u.packId,
      width: u.albedo.width,
      height: u.albedo.height,
    })),
    {
      ...options,
      allowRotation: safeAllowRotation,
    },
  );

  const uniqueByPackId = new Map<string, UniqueItem>();
  for (const u of uniqueOrder) {
    uniqueByPackId.set(u.packId, u);
  }

  const placementByPackId = new Map<string, PlacedRect>();
  const composedPages: ComposedAtlasPage[] = packedPages.map((page) => {
    const albedoData = new Uint8ClampedArray(page.width * page.height * 4);
    const normalData = hasAnyNormal
      ? new Uint8ClampedArray(page.width * page.height * 4)
      : undefined;

    if (normalData) {
      for (let i = 0; i < page.width * page.height; i++) {
        normalData[i * 4] = 128;
        normalData[i * 4 + 1] = 128;
        normalData[i * 4 + 2] = 255;
        normalData[i * 4 + 3] = 0;
      }
    }

    for (const rect of page.rects) {
      placementByPackId.set(rect.id, rect);
      const unique = uniqueByPackId.get(rect.id);
      if (!unique) continue;

      blitWithExtrusion(albedoData, page.width, page.height, unique.albedo, rect, options.extrude);

      if (normalData) {
        const normalSrc: RgbaBuffer = unique.normal ?? {
          width: unique.albedo.width,
          height: unique.albedo.height,
          data: (() => {
            // Flat +Z normal preserving albedo alpha silhouette for sprites missing a baked normal
            const d = new Uint8ClampedArray(unique.albedo.width * unique.albedo.height * 4);
            for (let i = 0; i < unique.albedo.width * unique.albedo.height; i++) {
              d[i * 4] = 128;
              d[i * 4 + 1] = 128;
              d[i * 4 + 2] = 255;
              d[i * 4 + 3] = unique.albedo.data[i * 4 + 3] ?? 0;
            }
            return d;
          })(),
        };
        blitWithExtrusion(normalData, page.width, page.height, normalSrc, rect, options.extrude);
      }
    }

    return {
      pageIndex: page.pageIndex,
      width: page.width,
      height: page.height,
      occupancy: page.occupancy,
      rects: page.rects,
      albedo: { width: page.width, height: page.height, data: albedoData },
      ...(normalData
        ? { normal: { width: page.width, height: page.height, data: normalData } }
        : {}),
    };
  });

  const frames: AtlasFramePlacement[] = preparedInputs.map((item) => {
    const rect = placementByPackId.get(item.packId)!;
    return {
      id: item.input.id,
      hashKey: item.hashKey,
      pageIndex: rect.page,
      rect,
      trim: item.trim,
      pivotNorm: item.input.pivotNorm ?? { x: 0.5, y: 0.5 },
      animationName: item.input.animationName,
    };
  });

  return {
    pages: composedPages,
    frames,
    totalInputCount: inputs.length,
    uniquePackedCount: uniqueOrder.length,
    deduplicatedCount: Math.max(0, inputs.length - uniqueOrder.length),
    extrude: options.extrude,
    padding: options.padding,
  };
}
