import type { Vec2 } from './types_mls';

export type { Vec2 } from './types_mls';
export type MlsMode = 'rigid' | 'similarity';

export interface MlsSolveResult {
  /** Interleaved deformed vertex positions [x0, y0, x1, y1, ...] in sprite pixel space */
  readonly positions: Float32Array;
  /** Local rotation angle (radians) per vertex for tangent-space normal map rotation */
  readonly rotations: Float32Array;
}

const PIN_EPSILON_SQ = 1e-6;

function sanitizeFiniteFloat32(value: number, fallback: number): number {
  const f32 = Math.fround(value);
  return Number.isFinite(f32) ? f32 : fallback;
}

function arePinsValid(pins: readonly Vec2[]): boolean {
  for (const p of pins) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      return false;
    }
  }
  return true;
}

/**
 * Computes rigid/similarity rotation components `(cos, sin)` around a vertex,
 * optionally skipping a pinned index so angle continuity is preserved even directly on pins.
 */
function solveAtVertex(
  vx: number,
  vy: number,
  restPins: readonly Vec2[],
  deformedPins: readonly Vec2[],
  mode: MlsMode,
  alpha: number,
  skipIdx: number,
  weights: Float64Array,
): { px: number; py: number; cos: number; sin: number } {
  const pinCount = restPins.length;
  let wSum = 0;
  let pStarX = 0;
  let pStarY = 0;
  let qStarX = 0;
  let qStarY = 0;

  for (let i = 0; i < pinCount; i++) {
    if (i === skipIdx) {
      weights[i] = 0;
      continue;
    }
    const p = restPins[i]!;
    const q = deformedPins[i]!;
    const dx = p.x - vx;
    const dy = p.y - vy;
    const distSq = Math.max(PIN_EPSILON_SQ, dx * dx + dy * dy);
    const w = alpha === 1.0 ? 1 / distSq : 1 / Math.pow(distSq, alpha);
    weights[i] = w;
    wSum += w;
    pStarX += w * p.x;
    pStarY += w * p.y;
    qStarX += w * q.x;
    qStarY += w * q.y;
  }

  if (wSum <= 1e-12) {
    return { px: vx, py: vy, cos: 1, sin: 0 };
  }

  pStarX /= wSum;
  pStarY /= wSum;
  qStarX /= wSum;
  qStarY /= wSum;

  let C = 0;
  let S = 0;
  let muS = 0;

  for (let i = 0; i < pinCount; i++) {
    const w = weights[i] ?? 0;
    if (w === 0) continue;
    const p = restPins[i]!;
    const q = deformedPins[i]!;
    const phx = p.x - pStarX;
    const phy = p.y - pStarY;
    const qhx = q.x - qStarX;
    const qhy = q.y - qStarY;

    C += w * (phx * qhx + phy * qhy);
    S += w * (phx * qhy - phy * qhx);
    muS += w * (phx * phx + phy * phy);
  }

  let mCos = 1;
  let mSin = 0;

  if (mode === 'rigid') {
    const len = Math.hypot(C, S);
    if (len > 1e-9) {
      mCos = C / len;
      mSin = S / len;
    }
  } else if (muS > 1e-9) {
    mCos = C / muS;
    mSin = S / muS;
  }

  const vhx = vx - pStarX;
  const vhy = vy - pStarY;
  return {
    px: qStarX + (mCos * vhx - mSin * vhy),
    py: qStarY + (mSin * vhx + mCos * vhy),
    cos: mCos,
    sin: mSin,
  };
}

/**
 * Pure-TS Moving Least Squares 2D deformation solver (Schaefer, McPhail & Warren 2006).
 * Preserves local area in `'rigid'` mode and allows uniform scaling in `'similarity'` mode.
 */
export function solveMlsMesh(
  restVertices: Float32Array,
  restPins: readonly Vec2[],
  deformedPins: readonly Vec2[],
  mode: MlsMode = 'rigid',
  alpha = 1.0,
): MlsSolveResult {
  const vertexCount = Math.floor(restVertices.length / 2);
  const pinCount = restPins.length;
  const outPos = new Float32Array(restVertices.length);
  const outRot = new Float32Array(vertexCount);

  if (
    pinCount === 0 ||
    pinCount !== deformedPins.length ||
    !arePinsValid(restPins) ||
    !arePinsValid(deformedPins)
  ) {
    outPos.set(restVertices);
    return { positions: outPos, rotations: outRot };
  }

  if (pinCount === 1) {
    const dx = deformedPins[0]!.x - restPins[0]!.x;
    const dy = deformedPins[0]!.y - restPins[0]!.y;
    for (let vi = 0; vi < vertexCount; vi++) {
      const vx = restVertices[vi * 2] ?? 0;
      const vy = restVertices[vi * 2 + 1] ?? 0;
      outPos[vi * 2] = sanitizeFiniteFloat32(vx + dx, vx);
      outPos[vi * 2 + 1] = sanitizeFiniteFloat32(vy + dy, vy);
    }
    return { positions: outPos, rotations: outRot };
  }

  const weights = new Float64Array(pinCount);

  for (let vi = 0; vi < vertexCount; vi++) {
    const vx = restVertices[vi * 2] ?? 0;
    const vy = restVertices[vi * 2 + 1] ?? 0;

    let exactPinIdx = -1;
    for (let i = 0; i < pinCount; i++) {
      const p = restPins[i]!;
      const dx = p.x - vx;
      const dy = p.y - vy;
      if (dx * dx + dy * dy <= PIN_EPSILON_SQ) {
        exactPinIdx = i;
        break;
      }
    }

    if (exactPinIdx >= 0) {
      const q = deformedPins[exactPinIdx]!;
      outPos[vi * 2] = sanitizeFiniteFloat32(q.x, vx);
      outPos[vi * 2 + 1] = sanitizeFiniteFloat32(q.y, vy);
      // Estimate continuous rotation using remaining pins centered on the matched pin
      if (pinCount >= 2) {
        const ref = solveAtVertex(
          vx,
          vy,
          restPins,
          deformedPins,
          mode,
          alpha,
          exactPinIdx,
          weights,
        );
        // For remaining pins under rigid transform around (p_k -> q_k), use centroid displacement rotation
        const pK = restPins[exactPinIdx]!;
        let C = 0;
        let S = 0;
        for (let i = 0; i < pinCount; i++) {
          if (i === exactPinIdx) continue;
          const p = restPins[i]!;
          const dp = deformedPins[i]!;
          const dx = p.x - pK.x;
          const dy = p.y - pK.y;
          const qdx = dp.x - q.x;
          const qdy = dp.y - q.y;
          const dSq = Math.max(PIN_EPSILON_SQ, dx * dx + dy * dy);
          const w = 1 / dSq;
          C += w * (dx * qdx + dy * qdy);
          S += w * (dx * qdy - dy * qdx);
        }
        const len = Math.hypot(C, S);
        const angle = len > 1e-9 ? Math.atan2(S / len, C / len) : Math.atan2(ref.sin, ref.cos);
        outRot[vi] = sanitizeFiniteFloat32(angle, 0);
      }
      continue;
    }

    const res = solveAtVertex(vx, vy, restPins, deformedPins, mode, alpha, -1, weights);
    outPos[vi * 2] = sanitizeFiniteFloat32(res.px, vx);
    outPos[vi * 2 + 1] = sanitizeFiniteFloat32(res.py, vy);
    outRot[vi] = sanitizeFiniteFloat32(Math.atan2(res.sin, res.cos), 0);
  }

  return { positions: outPos, rotations: outRot };
}
