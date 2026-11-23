import type { RgbaBuffer } from './types';

export interface Vec2 {
  readonly x: number;
  readonly y: number;
}

export type ColliderLayer = 'collider' | 'hurtbox' | 'hitbox';
export type ColliderKind = 'polygon' | 'convex-hull' | 'aabb' | 'capsule';

export interface ColliderExtractOptions {
  readonly alphaThreshold?: number;
  readonly epsilonPx?: number;
  readonly kind?: ColliderKind;
  readonly maxVertices?: number;
  readonly pivotPx?: Vec2;
}

export interface CapsuleShape {
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly height: number;
  readonly orientation: 'vertical' | 'horizontal';
}

export interface ExtractedCollisionShape {
  readonly kind: ColliderKind;
  readonly vertices: readonly Vec2[];
  readonly isConvex: boolean;
  readonly areaPx: number;
  readonly capsule?: CapsuleShape;
}

type Segment = readonly [number, number, number, number];

/**
 * Marching Squares lookup table keeping opaque interior on the RIGHT
 * (Clockwise in screen-space +X right, +Y down).
 * Bitmask: tl=8, tr=4, br=2, bl=1.
 */
function cellSegments(mask: number, x: number, y: number): readonly Segment[] {
  const tx = 2 * x + 1;
  const ty = 2 * y;
  const rx = 2 * x + 2;
  const ry = 2 * y + 1;
  const bx = 2 * x + 1;
  const by = 2 * y + 2;
  const lx = 2 * x;
  const ly = 2 * y + 1;

  switch (mask) {
    case 1:
      return [[lx, ly, bx, by]];
    case 2:
      return [[bx, by, rx, ry]];
    case 3:
      return [[lx, ly, rx, ry]];
    case 4:
      return [[rx, ry, tx, ty]];
    case 5:
      return [
        [lx, ly, bx, by],
        [rx, ry, tx, ty],
      ];
    case 6:
      return [[bx, by, tx, ty]];
    case 7:
      return [[lx, ly, tx, ty]];
    case 8:
      return [[tx, ty, lx, ly]];
    case 9:
      return [[tx, ty, bx, by]];
    case 10:
      return [
        [tx, ty, lx, ly],
        [bx, by, rx, ry],
      ];
    case 11:
      return [[tx, ty, rx, ry]];
    case 12:
      return [[rx, ry, lx, ly]];
    case 13:
      return [[rx, ry, bx, by]];
    case 14:
      return [[bx, by, lx, ly]];
    default:
      return [];
  }
}

/**
 * Traces all closed alpha contours via doubled-integer Marching Squares on a (W+2)x(H+2)
 * zero-padded binary alpha mask and returns contours in sprite pixel coordinates.
 */
export function traceMarchingSquaresContours(
  buf: RgbaBuffer,
  alphaThreshold = 128,
): readonly (readonly Vec2[])[] {
  const { width, height, data } = buf;
  if (width <= 0 || height <= 0) return [];

  const pw = width + 2;
  const ph = height + 2;
  const maskGrid = new Uint8Array(pw * ph);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if ((data[(y * width + x) * 4 + 3] ?? 0) >= alphaThreshold) {
        maskGrid[(y + 1) * pw + (x + 1)] = 1;
      }
    }
  }

  const edges = new Map<number, number[]>();
  const stride = pw * 2 + 4;
  const pack = (dx: number, dy: number): number => dy * stride + dx;

  for (let y = 0; y < ph - 1; y++) {
    for (let x = 0; x < pw - 1; x++) {
      const tl = maskGrid[y * pw + x] ?? 0;
      const tr = maskGrid[y * pw + x + 1] ?? 0;
      const br = maskGrid[(y + 1) * pw + x + 1] ?? 0;
      const bl = maskGrid[(y + 1) * pw + x] ?? 0;
      const code = (tl << 3) | (tr << 2) | (br << 1) | bl;
      if (code === 0 || code === 15) continue;

      for (const [x0, y0, x1, y1] of cellSegments(code, x, y)) {
        const k0 = pack(x0, y0);
        const k1 = pack(x1, y1);
        const list = edges.get(k0);
        if (list) list.push(k1);
        else edges.set(k0, [k1]);
      }
    }
  }

  const loops: Vec2[][] = [];
  for (const [startKey] of edges) {
    while ((edges.get(startKey)?.length ?? 0) > 0) {
      const loop: Vec2[] = [];
      let cur = startKey;
      let guard = 0;
      const maxSteps = pw * ph * 4;

      while (guard++ < maxSteps) {
        const nextList = edges.get(cur);
        if (!nextList || nextList.length === 0) break;
        const next = nextList.pop()!;
        const dx = cur % stride;
        const dy = (cur - dx) / stride;
        loop.push({ x: dx * 0.5 - 0.5, y: dy * 0.5 - 0.5 });
        cur = next;
        if (cur === startKey) break;
      }

      if (loop.length >= 3) loops.push(loop);
    }
  }

  return loops;
}

function pointToSegmentDistSq(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq <= 1e-12) return (p.x - a.x) ** 2 + (p.y - a.y) ** 2;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq));
  const projX = a.x + t * dx;
  const projY = a.y + t * dy;
  return (p.x - projX) ** 2 + (p.y - projY) ** 2;
}

function rdpOpen(pts: readonly Vec2[], epsSq: number): Vec2[] {
  if (pts.length <= 2) return [...pts];
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let maxDistSq = -1;
  let splitIdx = 0;

  for (let i = 1; i < pts.length - 1; i++) {
    const dSq = pointToSegmentDistSq(pts[i]!, first, last);
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      splitIdx = i;
    }
  }

  if (maxDistSq > epsSq) {
    const left = rdpOpen(pts.slice(0, splitIdx + 1), epsSq);
    const right = rdpOpen(pts.slice(splitIdx), epsSq);
    return [...left.slice(0, -1), ...right];
  }
  return [first, last];
}

/**
 * Closed-loop Ramer-Douglas-Peucker simplification splitting across the farthest antipodal vertex.
 */
export function simplifyClosedPolygonRdp(ring: readonly Vec2[], epsilonPx: number): Vec2[] {
  if (ring.length <= 3 || epsilonPx <= 0) return [...ring];

  const anchor = ring[0]!;
  let farIdx = Math.floor(ring.length / 2);
  let maxDistSq = -1;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    const dSq = (p.x - anchor.x) ** 2 + (p.y - anchor.y) ** 2;
    if (dSq > maxDistSq) {
      maxDistSq = dSq;
      farIdx = i;
    }
  }

  const epsSq = epsilonPx * epsilonPx;
  const chainA = rdpOpen(ring.slice(0, farIdx + 1), epsSq);
  const chainB = rdpOpen([...ring.slice(farIdx), anchor], epsSq);
  const merged = [...chainA.slice(0, -1), ...chainB.slice(0, -1)];
  return merged.length >= 3 ? merged : [...ring.slice(0, 3)];
}

/**
 * Andrew's Monotone Chain convex hull in O(n log n), clockwise in screen space (+Y down).
 */
export function computeConvexHull(points: readonly Vec2[]): Vec2[] {
  if (points.length <= 3) return [...points];
  const sorted = [...points].sort((a, b) => (a.x !== b.x ? a.x - b.x : a.y - b.y));
  const cross = (o: Vec2, a: Vec2, b: Vec2): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Vec2[] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  const upper: Vec2[] = [];
  for (let i = sorted.length - 1; i >= 0; i--) {
    const p = sorted[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  lower.pop();
  upper.pop();
  return [...lower, ...upper];
}

export function polygonArea(pts: readonly Vec2[]): number {
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return Math.abs(sum) * 0.5;
}

export function isPolygonConvex(pts: readonly Vec2[]): boolean {
  if (pts.length < 3) return false;
  let sign = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const c = pts[(i + 2) % pts.length]!;
    const z = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (Math.abs(z) > 1e-6) {
      const s = z > 0 ? 1 : -1;
      if (sign === 0) sign = s;
      else if (sign !== s) return false;
    }
  }
  return true;
}

/**
 * High-level collision hull extractor with optional vertex budget and pivot recentering.
 */
export function extractCollisionHull(
  buf: RgbaBuffer,
  options: ColliderExtractOptions = {},
): ExtractedCollisionShape {
  const kind = options.kind ?? 'convex-hull';
  const pivot = options.pivotPx ?? { x: 0, y: 0 };
  const contours = traceMarchingSquaresContours(buf, options.alphaThreshold ?? 128);

  if (contours.length === 0) {
    return { kind, vertices: [], isConvex: false, areaPx: 0 };
  }

  let primary = contours[0]!;
  let bestArea = polygonArea(primary);
  for (let i = 1; i < contours.length; i++) {
    const a = polygonArea(contours[i]!);
    if (a > bestArea) {
      bestArea = a;
      primary = contours[i]!;
    }
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of primary) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  let rawVerts: Vec2[];
  let capsule: CapsuleShape | undefined;

  if (kind === 'aabb') {
    rawVerts = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
  } else if (kind === 'capsule') {
    const bw = maxX - minX;
    const bh = maxY - minY;
    const vertical = bh >= bw;
    capsule = {
      cx: Number(((minX + maxX) * 0.5 - pivot.x).toFixed(2)),
      cy: Number(((minY + maxY) * 0.5 - pivot.y).toFixed(2)),
      radius: Number(((vertical ? bw : bh) * 0.5).toFixed(2)),
      height: Number((vertical ? bh : bw).toFixed(2)),
      orientation: vertical ? 'vertical' : 'horizontal',
    };
    rawVerts = [
      { x: minX, y: minY },
      { x: maxX, y: minY },
      { x: maxX, y: maxY },
      { x: minX, y: maxY },
    ];
  } else {
    let eps = options.epsilonPx ?? 1.5;
    rawVerts = simplifyClosedPolygonRdp(primary, eps);
    if (kind === 'convex-hull') {
      rawVerts = computeConvexHull(rawVerts);
    }
    const maxV = options.maxVertices;
    if (maxV && maxV >= 3) {
      let iter = 0;
      while (rawVerts.length > maxV && iter++ < 12) {
        eps *= 1.45;
        rawVerts = simplifyClosedPolygonRdp(primary, eps);
        if (kind === 'convex-hull') rawVerts = computeConvexHull(rawVerts);
      }
    }
  }

  const shifted = rawVerts.map((p) => ({
    x: Number((p.x - pivot.x).toFixed(2)),
    y: Number((p.y - pivot.y).toFixed(2)),
  }));

  return {
    kind,
    vertices: shifted,
    isConvex: isPolygonConvex(shifted),
    areaPx: Number(polygonArea(shifted).toFixed(2)),
    ...(capsule ? { capsule } : {}),
  };
}
