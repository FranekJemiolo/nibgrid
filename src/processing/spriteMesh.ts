import type { ArtMode } from '../domain/schemas';
import type { RgbaBuffer } from './types';

export interface SpriteMesh {
  readonly spriteWidth: number;
  readonly spriteHeight: number;
  /** Interleaved rest-pose vertex coordinates [x0, y0, ...] in pixel space */
  readonly vertices: Float32Array;
  /** Interleaved UVs [u0, v0, ...] where u=[0..1] left->right, v=[0..1] top->bottom */
  readonly uvs: Float32Array;
  /** Triangle vertex indices (3 per triangle, 2 triangles per active quad) */
  readonly indices: Uint16Array;
  readonly quadCount: number;
}

export interface SpriteMeshOptions {
  readonly cellPx?: number;
  readonly artMode?: ArtMode;
  readonly alphaThreshold?: number;
  readonly dilationCells?: number;
}

/**
 * Builds an alpha-clipped indexed triangle grid mesh covering the sprite's opaque bounding box
 * plus a 1-cell silhouette halo so MLS warps smoothly deform all boundary contours.
 */
export function buildAlphaClippedMesh(
  buf: RgbaBuffer,
  options: SpriteMeshOptions = {},
): SpriteMesh {
  const { width, height, data } = buf;
  const cellPx = Math.max(2, options.cellPx ?? (options.artMode === 'hd-2d' ? 8 : 4));
  const threshold = options.alphaThreshold ?? 128;
  const dilation = Math.max(0, options.dilationCells ?? 1);

  const cols = Math.max(1, Math.ceil(width / cellPx));
  const rows = Math.max(1, Math.ceil(height / cellPx));

  const baseActive = new Uint8Array(cols * rows);
  let anyActive = false;

  for (let gy = 0; gy < rows; gy++) {
    const y0 = gy * cellPx;
    const y1 = Math.min(height, y0 + cellPx);
    for (let gx = 0; gx < cols; gx++) {
      const x0 = gx * cellPx;
      const x1 = Math.min(width, x0 + cellPx);
      let hit = false;
      for (let y = y0; y < y1 && !hit; y++) {
        for (let x = x0; x < x1; x++) {
          if ((data[(y * width + x) * 4 + 3] ?? 0) >= threshold) {
            hit = true;
            break;
          }
        }
      }
      if (hit) {
        baseActive[gy * cols + gx] = 1;
        anyActive = true;
      }
    }
  }

  // Fallback for 100% transparent image: full single quad
  if (!anyActive) {
    return {
      spriteWidth: width,
      spriteHeight: height,
      vertices: new Float32Array([0, 0, width, 0, 0, height, width, height]),
      uvs: new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]),
      indices: new Uint16Array([0, 2, 1, 1, 2, 3]),
      quadCount: 1,
    };
  }

  // Dilate active grid cells by 1-cell halo so outer edges are never cropped
  const active = new Uint8Array(cols * rows);
  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      if (!baseActive[gy * cols + gx]) continue;
      for (let dy = -dilation; dy <= dilation; dy++) {
        const ny = gy + dy;
        if (ny < 0 || ny >= rows) continue;
        for (let dx = -dilation; dx <= dilation; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= cols) continue;
          active[ny * cols + nx] = 1;
        }
      }
    }
  }

  const vCols = cols + 1;
  const vRows = rows + 1;
  const vertexIndexMap = new Int32Array(vCols * vRows).fill(-1);
  const vertList: number[] = [];
  const uvList: number[] = [];
  const triIndices: number[] = [];
  let quadCount = 0;

  const getOrAddVertex = (vx: number, vy: number): number => {
    const key = vy * vCols + vx;
    const existing = vertexIndexMap[key] ?? -1;
    if (existing >= 0) return existing;

    const idx = vertList.length / 2;
    vertexIndexMap[key] = idx;
    const px = Math.min(width, vx * cellPx);
    const py = Math.min(height, vy * cellPx);
    vertList.push(px, py);
    uvList.push(px / Math.max(1, width), py / Math.max(1, height));
    return idx;
  };

  for (let gy = 0; gy < rows; gy++) {
    for (let gx = 0; gx < cols; gx++) {
      if (!active[gy * cols + gx]) continue;
      const i00 = getOrAddVertex(gx, gy);
      const i10 = getOrAddVertex(gx + 1, gy);
      const i01 = getOrAddVertex(gx, gy + 1);
      const i11 = getOrAddVertex(gx + 1, gy + 1);
      triIndices.push(i00, i01, i10, i10, i01, i11);
      quadCount++;
    }
  }

  return {
    spriteWidth: width,
    spriteHeight: height,
    vertices: new Float32Array(vertList),
    uvs: new Float32Array(uvList),
    indices: new Uint16Array(triIndices),
    quadCount,
  };
}

function edgeFn(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

/**
 * Pure-TS barycentric rasterizer fallback for MLS-deformed sprite meshes.
 * Supports nearest-neighbor (pixel-art) and bilinear (hd-2d) sampling with optional padding.
 */
export function rasterizeDeformedMeshCpu(
  source: RgbaBuffer,
  mesh: SpriteMesh,
  deformedPositions: Float32Array,
  rotations: Float32Array,
  options: { paddingPx?: number; pixelArt?: boolean; isNormalMap?: boolean } = {},
): RgbaBuffer {
  const pad = Math.max(0, options.paddingPx ?? 0);
  const outW = source.width + pad * 2;
  const outH = source.height + pad * 2;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const isNormal = Boolean(options.isNormalMap);
  const nearest = options.pixelArt ?? true;

  if (isNormal) {
    for (let i = 0; i < outW * outH; i++) {
      out[i * 4] = 128;
      out[i * 4 + 1] = 128;
      out[i * 4 + 2] = 255;
      out[i * 4 + 3] = 0;
    }
  }

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const i0 = mesh.indices[t] ?? 0;
    const i1 = mesh.indices[t + 1] ?? 0;
    const i2 = mesh.indices[t + 2] ?? 0;

    const x0 = (deformedPositions[i0 * 2] ?? 0) + pad;
    const y0 = (deformedPositions[i0 * 2 + 1] ?? 0) + pad;
    const x1 = (deformedPositions[i1 * 2] ?? 0) + pad;
    const y1 = (deformedPositions[i1 * 2 + 1] ?? 0) + pad;
    const x2 = (deformedPositions[i2 * 2] ?? 0) + pad;
    const y2 = (deformedPositions[i2 * 2 + 1] ?? 0) + pad;

    const u0 = mesh.uvs[i0 * 2] ?? 0;
    const v0 = mesh.uvs[i0 * 2 + 1] ?? 0;
    const u1 = mesh.uvs[i1 * 2] ?? 0;
    const v1 = mesh.uvs[i1 * 2 + 1] ?? 0;
    const u2 = mesh.uvs[i2 * 2] ?? 0;
    const v2 = mesh.uvs[i2 * 2 + 1] ?? 0;

    const r0 = rotations[i0] ?? 0;
    const r1 = rotations[i1] ?? 0;
    const r2 = rotations[i2] ?? 0;

    const area = edgeFn(x0, y0, x1, y1, x2, y2);
    if (Math.abs(area) < 1e-6) continue;
    const invArea = 1 / area;

    const minX = Math.max(0, Math.floor(Math.min(x0, x1, x2)));
    const maxX = Math.min(outW - 1, Math.ceil(Math.max(x0, x1, x2)));
    const minY = Math.max(0, Math.floor(Math.min(y0, y1, y2)));
    const maxY = Math.min(outH - 1, Math.ceil(Math.max(y0, y1, y2)));

    for (let py = minY; py <= maxY; py++) {
      const cy = py + 0.5;
      for (let px = minX; px <= maxX; px++) {
        const cx = px + 0.5;
        const w0 = edgeFn(x1, y1, x2, y2, cx, cy) * invArea;
        const w1 = edgeFn(x2, y2, x0, y0, cx, cy) * invArea;
        const w2 = 1 - w0 - w1;
        if (w0 < -1e-4 || w1 < -1e-4 || w2 < -1e-4) continue;

        const u = Math.max(0, Math.min(1, w0 * u0 + w1 * u1 + w2 * u2));
        const v = Math.max(0, Math.min(1, w0 * v0 + w1 * v1 + w2 * v2));
        const sx = nearest
          ? Math.min(source.width - 1, Math.floor(u * source.width))
          : Math.min(source.width - 1, Math.round(u * (source.width - 1)));
        const sy = nearest
          ? Math.min(source.height - 1, Math.floor(v * source.height))
          : Math.min(source.height - 1, Math.round(v * (source.height - 1)));

        const srcIdx = (sy * source.width + sx) * 4;
        const alpha = source.data[srcIdx + 3] ?? 0;
        if (alpha === 0) continue;

        const dstIdx = (py * outW + px) * 4;
        if (isNormal) {
          const rot = w0 * r0 + w1 * r1 + w2 * r2;
          const nx = ((source.data[srcIdx] ?? 128) / 255) * 2 - 1;
          const ny = ((source.data[srcIdx + 1] ?? 128) / 255) * 2 - 1;
          const cos = Math.cos(-rot);
          const sin = Math.sin(-rot);
          const rnx = cos * nx - sin * ny;
          const rny = sin * nx + cos * ny;
          out[dstIdx] = Math.max(0, Math.min(255, Math.round((rnx * 0.5 + 0.5) * 255)));
          out[dstIdx + 1] = Math.max(0, Math.min(255, Math.round((rny * 0.5 + 0.5) * 255)));
          out[dstIdx + 2] = source.data[srcIdx + 2] ?? 255;
          out[dstIdx + 3] = alpha;
        } else {
          out[dstIdx] = source.data[srcIdx] ?? 0;
          out[dstIdx + 1] = source.data[srcIdx + 1] ?? 0;
          out[dstIdx + 2] = source.data[srcIdx + 2] ?? 0;
          out[dstIdx + 3] = alpha;
        }
      }
    }
  }

  return { width: outW, height: outH, data: out };
}
