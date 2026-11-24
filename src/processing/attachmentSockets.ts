import type { ArtMode, PuppetAnimConfig } from '../domain/schemas';
import { generatePresetKeyframes } from './animPresets';
import type { Vec2 } from './collisionHull';
import { solveMlsMesh, type MlsSolveResult } from './mlsWarp';
import { buildAlphaClippedMesh, type SpriteMesh } from './spriteMesh';
import type { RgbaBuffer } from './types';

export type PresetSocketName = 'hand_r' | 'hand_l' | 'muzzle' | 'exhaust' | 'head' | 'center';

export interface PresetSocketMeta {
  readonly name: PresetSocketName;
  readonly label: string;
  readonly colorHex: string;
  readonly defaultNorm: Vec2;
  readonly baseAngleDeg: number;
}

export const PRESET_SOCKETS: readonly PresetSocketMeta[] = [
  {
    name: 'hand_r',
    label: '+ hand_r',
    colorHex: '#F59E0B',
    defaultNorm: { x: 0.68, y: 0.56 },
    baseAngleDeg: 0,
  },
  {
    name: 'hand_l',
    label: '+ hand_l',
    colorHex: '#38BDF8',
    defaultNorm: { x: 0.32, y: 0.56 },
    baseAngleDeg: 180,
  },
  {
    name: 'muzzle',
    label: '+ muzzle',
    colorHex: '#EF4444',
    defaultNorm: { x: 0.85, y: 0.48 },
    baseAngleDeg: 0,
  },
  {
    name: 'exhaust',
    label: '+ exhaust',
    colorHex: '#A855F7',
    defaultNorm: { x: 0.16, y: 0.68 },
    baseAngleDeg: 180,
  },
  {
    name: 'head',
    label: '+ head',
    colorHex: '#22C55E',
    defaultNorm: { x: 0.5, y: 0.22 },
    baseAngleDeg: -90,
  },
  {
    name: 'center',
    label: '+ center',
    colorHex: '#E4E4E7',
    defaultNorm: { x: 0.5, y: 0.5 },
    baseAngleDeg: 0,
  },
];

export interface SocketDefinition {
  readonly id: string;
  readonly name: string;
  /** Rest-pose coordinates in sprite pixel space (0..width, 0..height) */
  readonly restPosPx: Vec2;
  /** Base facing/attachment angle in degrees (0 = +X right in screen space) */
  readonly baseAngleDeg: number;
  /** Optional color tag for UI overlay */
  readonly colorHex?: string;
}

export interface MeshTriangle {
  readonly i0: number;
  readonly i1: number;
  readonly i2: number;
}

export interface BarycentricBinding {
  readonly socketId: string;
  readonly triIndex: number;
  readonly w0: number;
  readonly w1: number;
  readonly w2: number;
  readonly restEdgeAngleRad: number;
}

export interface EvaluatedSocketFrame {
  readonly socketId: string;
  readonly name: string;
  readonly frameIndex: number;
  /** Position in sprite pixel coordinates */
  readonly posPx: Vec2;
  /** Position relative to sprite pivotPx (ready for Godot/Phaser/PixiJS children) */
  readonly pivotRelativePx: Vec2;
  /** World/sprite-local rotation in degrees */
  readonly angleDeg: number;
  readonly boundToMesh: boolean;
}

function round2(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const v = Number(n.toFixed(2));
  return Object.is(v, -0) ? 0 : v;
}

function wrapAngleRad(rad: number): number {
  if (!Number.isFinite(rad)) return 0;
  let a = rad % (2 * Math.PI);
  if (a <= -Math.PI) a += 2 * Math.PI;
  if (a > Math.PI) a -= 2 * Math.PI;
  return a;
}

function isFiniteVec2(v: Vec2 | undefined): v is Vec2 {
  return Boolean(v && Number.isFinite(v.x) && Number.isFinite(v.y));
}

function triangleArea2(a: Vec2, b: Vec2, c: Vec2): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

/**
 * Computes barycentric weights `(w0, w1, w2)` of point `p` inside triangle `(a, b, c)`.
 * Returns null if degenerate (`|denom| < 1e-7`) or outside beyond `margin`.
 */
function tryBarycentric(
  p: Vec2,
  a: Vec2,
  b: Vec2,
  c: Vec2,
  margin = 0.02,
): readonly [number, number, number] | null {
  const denom = triangleArea2(a, b, c);
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-7) return null;

  const w0 = triangleArea2(p, b, c) / denom;
  const w1 = triangleArea2(p, c, a) / denom;
  const w2 = 1 - w0 - w1;

  if (!Number.isFinite(w0) || !Number.isFinite(w1) || !Number.isFinite(w2)) return null;

  if (w0 >= -margin && w1 >= -margin && w2 >= -margin) {
    return [w0, w1, w2];
  }
  return null;
}

/**
 * Sanitizes an arbitrary user string into a valid engine-safe socket identifier matching `^[a-z0-9_]+$`.
 */
export function sanitizeSocketName(raw: string): string {
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return normalized || 'socket';
}

/**
 * Extracts Vec2 rest-pose vertices and triangle tuples from an interleaved `SpriteMesh`.
 */
export function extractMeshGeometry(mesh: Pick<SpriteMesh, 'vertices' | 'indices'>): {
  restVertices: Vec2[];
  triangles: MeshTriangle[];
} {
  const restVertices = interleavedPositionsToVec2(mesh.vertices);
  const triangles: MeshTriangle[] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    triangles.push({
      i0: mesh.indices[t]!,
      i1: mesh.indices[t + 1]!,
      i2: mesh.indices[t + 2]!,
    });
  }
  return { restVertices, triangles };
}

/**
 * Converts interleaved `[x0, y0, ...]` Float32Array coordinates into `Vec2[]`.
 */
export function interleavedPositionsToVec2(positions: Float32Array): Vec2[] {
  const count = Math.floor(positions.length / 2);
  const out: Vec2[] = new Array<Vec2>(count);
  for (let i = 0; i < count; i++) {
    out[i] = {
      x: positions[i * 2] ?? 0,
      y: positions[i * 2 + 1] ?? 0,
    };
  }
  return out;
}

/**
 * Binds a rest-pose socket to the closest enclosing non-degenerate MLS mesh triangle
 * (with fallback to the nearest non-degenerate triangle centroid at weights `[1/3, 1/3, 1/3]`).
 */
export function bindSocketToRestMesh(
  socket: SocketDefinition,
  restVertices: readonly Vec2[],
  triangles: readonly MeshTriangle[],
): BarycentricBinding | null {
  if (restVertices.length < 3 || triangles.length === 0 || !isFiniteVec2(socket.restPosPx)) {
    return null;
  }

  let bestTriIdx = -1;
  let bestWeights: readonly [number, number, number] | null = null;
  let bestDistSq = Infinity;

  for (let t = 0; t < triangles.length; t++) {
    const tri = triangles[t]!;
    const v0 = restVertices[tri.i0];
    const v1 = restVertices[tri.i1];
    const v2 = restVertices[tri.i2];
    if (!isFiniteVec2(v0) || !isFiniteVec2(v1) || !isFiniteVec2(v2)) continue;

    const denom = triangleArea2(v0, v1, v2);
    if (!Number.isFinite(denom) || Math.abs(denom) < 1e-7) continue;

    const weights = tryBarycentric(socket.restPosPx, v0, v1, v2, 0.02);
    if (weights) {
      bestTriIdx = t;
      bestWeights = weights;
      break;
    }

    const cx = (v0.x + v1.x + v2.x) / 3;
    const cy = (v0.y + v1.y + v2.y) / 3;
    const dSq = (socket.restPosPx.x - cx) ** 2 + (socket.restPosPx.y - cy) ** 2;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      bestTriIdx = t;
      bestWeights = [1 / 3, 1 / 3, 1 / 3];
    }
  }

  if (bestTriIdx < 0 || !bestWeights) return null;

  const chosen = triangles[bestTriIdx]!;
  const r0 = restVertices[chosen.i0]!;
  const r1 = restVertices[chosen.i1]!;
  const restEdgeAngleRad = Math.atan2(r1.y - r0.y, r1.x - r0.x);

  return {
    socketId: socket.id,
    triIndex: bestTriIdx,
    w0: bestWeights[0],
    w1: bestWeights[1],
    w2: bestWeights[2],
    restEdgeAngleRad: Number.isFinite(restEdgeAngleRad) ? restEdgeAngleRad : 0,
  };
}

/**
 * Evaluates a bound socket on a deformed mesh frame, returning sprite-space, pivot-relative,
 * and angleDeg values. Falls back cleanly to rest pose when `deformedVertices` is null/empty.
 */
export function evaluateSocketAtFrame(
  socket: SocketDefinition,
  binding: BarycentricBinding | null,
  deformedVertices: readonly Vec2[] | null,
  triangles: readonly MeshTriangle[],
  pivotPx: Vec2,
  frameIndex: number,
): EvaluatedSocketFrame {
  const safeBasePos: Vec2 = isFiniteVec2(socket.restPosPx) ? socket.restPosPx : { x: 0, y: 0 };
  const safePivot: Vec2 = isFiniteVec2(pivotPx) ? pivotPx : { x: 0, y: 0 };
  const safeBaseAngle = Number.isFinite(socket.baseAngleDeg) ? socket.baseAngleDeg : 0;

  let x = safeBasePos.x;
  let y = safeBasePos.y;
  let deltaAngleRad = 0;
  let boundToMesh = false;

  if (binding && deformedVertices && deformedVertices.length >= 3 && triangles.length > 0) {
    const tri = triangles[binding.triIndex];
    const d0 = tri ? deformedVertices[tri.i0] : undefined;
    const d1 = tri ? deformedVertices[tri.i1] : undefined;
    const d2 = tri ? deformedVertices[tri.i2] : undefined;

    if (isFiniteVec2(d0) && isFiniteVec2(d1) && isFiniteVec2(d2)) {
      const nextX = binding.w0 * d0.x + binding.w1 * d1.x + binding.w2 * d2.x;
      const nextY = binding.w0 * d0.y + binding.w1 * d1.y + binding.w2 * d2.y;
      if (Number.isFinite(nextX) && Number.isFinite(nextY)) {
        x = nextX;
        y = nextY;
        const curEdgeAngleRad = Math.atan2(d1.y - d0.y, d1.x - d0.x);
        if (Number.isFinite(curEdgeAngleRad)) {
          deltaAngleRad = wrapAngleRad(curEdgeAngleRad - binding.restEdgeAngleRad);
        }
        boundToMesh = true;
      }
    }
  }

  const roundedPos: Vec2 = {
    x: round2(x),
    y: round2(y),
  };

  return {
    socketId: socket.id,
    name: socket.name,
    frameIndex,
    posPx: roundedPos,
    pivotRelativePx: {
      x: round2(roundedPos.x - safePivot.x),
      y: round2(roundedPos.y - safePivot.y),
    },
    angleDeg: round2(safeBaseAngle + (deltaAngleRad * 180) / Math.PI),
    boundToMesh,
  };
}

/**
 * Binds each socket once to `restVertices` and evaluates `[frameIndex][socketIndex]` tracks.
 */
export function evaluateSocketsAcrossFrames(
  sockets: readonly SocketDefinition[],
  restVertices: readonly Vec2[],
  triangles: readonly MeshTriangle[],
  deformedFrames: readonly (readonly Vec2[] | null)[],
  pivotPx: Vec2,
): EvaluatedSocketFrame[][] {
  if (sockets.length === 0) {
    return deformedFrames.length > 0 ? deformedFrames.map(() => []) : [[]];
  }
  const bindings = sockets.map((sock) => bindSocketToRestMesh(sock, restVertices, triangles));
  const framesToEval = deformedFrames.length > 0 ? deformedFrames : [null];
  return framesToEval.map((deformedVerts, frameIdx) =>
    sockets.map((sock, sIdx) =>
      evaluateSocketAtFrame(
        sock,
        bindings[sIdx] ?? null,
        deformedVerts,
        triangles,
        pivotPx,
        frameIdx,
      ),
    ),
  );
}

/**
 * Computes per-frame MLS solutions (when Puppet pins exist) and evaluates all named
 * attachment sockets across every animation frame relative to `pivotPx`.
 */
export function computeEvaluatedSocketsForSprite(params: {
  readonly sprite: RgbaBuffer;
  readonly artMode?: ArtMode;
  readonly pivotPx: Vec2;
  readonly puppetConfig: PuppetAnimConfig;
  readonly sockets: readonly SocketDefinition[];
  readonly cachedMesh?: SpriteMesh;
}): {
  readonly mesh: SpriteMesh | null;
  readonly solutions: MlsSolveResult[];
  readonly evaluatedByFrame: EvaluatedSocketFrame[][];
} {
  const { sprite, artMode = 'pixel-art', pivotPx, puppetConfig, sockets, cachedMesh } = params;
  if (puppetConfig.pins.length === 0) {
    return {
      mesh: null,
      solutions: [],
      evaluatedByFrame: evaluateSocketsAcrossFrames(sockets, [], [], [null], pivotPx),
    };
  }

  const mesh = cachedMesh ?? buildAlphaClippedMesh(sprite, { artMode });
  const { restVertices, triangles } = extractMeshGeometry(mesh);
  const keyframes = generatePresetKeyframes(
    puppetConfig.pins,
    puppetConfig.preset,
    puppetConfig.frameCount,
    puppetConfig.amplitudePx,
  );
  const solutions = keyframes.map((kf) =>
    solveMlsMesh(mesh.vertices, puppetConfig.pins, kf.pins, puppetConfig.mode, 1.0),
  );
  const deformedFrames = solutions.map((sol) => interleavedPositionsToVec2(sol.positions));
  const evaluatedByFrame = evaluateSocketsAcrossFrames(
    sockets,
    restVertices,
    triangles,
    deformedFrames,
    pivotPx,
  );

  return { mesh, solutions, evaluatedByFrame };
}
