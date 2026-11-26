import { quantizeToPaletteOklab } from './paletteQuantize';
import type { RgbaBuffer } from './types';

export type PoseJointId =
  | 'head'
  | 'neck'
  | 'pelvis'
  | 'r_shoulder'
  | 'r_elbow'
  | 'r_wrist'
  | 'l_shoulder'
  | 'l_elbow'
  | 'l_wrist'
  | 'r_hip'
  | 'r_knee'
  | 'r_ankle'
  | 'l_hip'
  | 'l_knee'
  | 'l_ankle';

export const ALL_POSE_JOINT_IDS: readonly PoseJointId[] = [
  'head',
  'neck',
  'pelvis',
  'r_shoulder',
  'r_elbow',
  'r_wrist',
  'l_shoulder',
  'l_elbow',
  'l_wrist',
  'r_hip',
  'r_knee',
  'r_ankle',
  'l_hip',
  'l_knee',
  'l_ankle',
];

export interface Vec2 {
  readonly x: number; // normalized 0..1 within frame
  readonly y: number; // normalized 0..1 within frame
}

export type PoseFrameJoints = Readonly<Record<PoseJointId, Vec2>>;

export interface PoseKeyframe {
  readonly id: string;
  readonly joints: PoseFrameJoints;
  /** Optional weapon/prop line segment (e.g. sword arc) rendered in bright cyan */
  readonly propLine?: readonly [Vec2, Vec2];
}

export interface PoseClipDefinition {
  readonly slug: string;
  readonly fps: number;
  readonly loop: boolean;
  readonly frameWidthPx: number;
  readonly frameHeightPx: number;
  readonly frames: readonly PoseKeyframe[];
  readonly generatedFrameBlobIds?: readonly string[];
  readonly generatedStripBlobId?: string;
}

export type RgbTriplet = readonly [number, number, number];

export interface PoseBoneSpec {
  readonly from: PoseJointId;
  readonly to: PoseJointId;
  readonly rgb: RgbTriplet;
  readonly group: 'spine' | 'right-arm' | 'left-arm' | 'right-leg' | 'left-leg';
}

export const PROP_LINE_RGB: RgbTriplet = [0, 255, 255];

/**
 * Standard OpenPose color-coded limb segments so left vs right limbs and
 * spine stay distinct on `#000000` across Gemini Image & ControlNet OpenPose.
 */
export const POSE_BONES: readonly PoseBoneSpec[] = [
  { from: 'head', to: 'neck', rgb: [255, 0, 85], group: 'spine' },
  { from: 'neck', to: 'pelvis', rgb: [255, 85, 0], group: 'spine' },
  // Right arm (warm orange -> yellow)
  { from: 'neck', to: 'r_shoulder', rgb: [255, 130, 0], group: 'right-arm' },
  { from: 'r_shoulder', to: 'r_elbow', rgb: [255, 170, 0], group: 'right-arm' },
  { from: 'r_elbow', to: 'r_wrist', rgb: [255, 255, 0], group: 'right-arm' },
  // Left arm (lime -> green)
  { from: 'neck', to: 'l_shoulder', rgb: [170, 255, 0], group: 'left-arm' },
  { from: 'l_shoulder', to: 'l_elbow', rgb: [85, 255, 0], group: 'left-arm' },
  { from: 'l_elbow', to: 'l_wrist', rgb: [0, 255, 85], group: 'left-arm' },
  // Right leg (teal -> sky blue)
  { from: 'pelvis', to: 'r_hip', rgb: [0, 255, 170], group: 'right-leg' },
  { from: 'r_hip', to: 'r_knee', rgb: [0, 210, 255], group: 'right-leg' },
  { from: 'r_knee', to: 'r_ankle', rgb: [0, 128, 255], group: 'right-leg' },
  // Left leg (indigo -> magenta)
  { from: 'pelvis', to: 'l_hip', rgb: [85, 0, 255], group: 'left-leg' },
  { from: 'l_hip', to: 'l_knee', rgb: [170, 0, 255], group: 'left-leg' },
  { from: 'l_knee', to: 'l_ankle', rgb: [255, 0, 255], group: 'left-leg' },
];

export const POSE_JOINT_COLORS: Readonly<Record<PoseJointId, RgbTriplet>> = {
  head: [255, 0, 85],
  neck: [255, 85, 0],
  pelvis: [255, 105, 40],
  r_shoulder: [255, 145, 0],
  r_elbow: [255, 195, 0],
  r_wrist: [255, 255, 0],
  l_shoulder: [170, 255, 0],
  l_elbow: [85, 255, 0],
  l_wrist: [0, 255, 85],
  r_hip: [0, 255, 170],
  r_knee: [0, 210, 255],
  r_ankle: [0, 128, 255],
  l_hip: [85, 0, 255],
  l_knee: [170, 0, 255],
  l_ankle: [255, 0, 255],
};

export interface PoseIkChainSpec {
  readonly root: PoseJointId;
  readonly mid: PoseJointId;
  readonly end: PoseJointId;
  readonly bendSign: 1 | -1;
}

export const POSE_IK_CHAINS: Readonly<Partial<Record<PoseJointId, PoseIkChainSpec>>> = {
  r_wrist: { root: 'r_shoulder', mid: 'r_elbow', end: 'r_wrist', bendSign: 1 },
  l_wrist: { root: 'l_shoulder', mid: 'l_elbow', end: 'l_wrist', bendSign: 1 },
  r_ankle: { root: 'r_hip', mid: 'r_knee', end: 'r_ankle', bendSign: -1 },
  l_ankle: { root: 'l_hip', mid: 'l_knee', end: 'l_ankle', bendSign: -1 },
};

const OPPOSITE_JOINT_MAP: Readonly<Partial<Record<PoseJointId, PoseJointId>>> = {
  r_shoulder: 'l_shoulder',
  r_elbow: 'l_elbow',
  r_wrist: 'l_wrist',
  l_shoulder: 'r_shoulder',
  l_elbow: 'r_elbow',
  l_wrist: 'r_wrist',
  r_hip: 'l_hip',
  r_knee: 'l_knee',
  r_ankle: 'l_ankle',
  l_hip: 'r_hip',
  l_knee: 'r_knee',
  l_ankle: 'r_ankle',
};

function clampNorm(v: number): number {
  if (!Number.isFinite(v)) return 0.5;
  return Math.max(0.02, Math.min(0.98, v));
}

function dist2d(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Analytic law-of-cosines 2-bone IK solver preserving exact segment lengths `lenA` and `lenB`.
 * Clamps target reach into `[|lenA - lenB| + 1e-4, (lenA + lenB) * 0.999]` so joints never snap or emit `NaN`.
 */
export function solveTwoBoneIk(
  root: Vec2,
  target: Vec2,
  lenA: number,
  lenB: number,
  bendSign: 1 | -1 = 1,
): { mid: Vec2; end: Vec2 } {
  const safeA = Number.isFinite(lenA) ? Math.max(1e-4, lenA) : 0.1;
  const safeB = Number.isFinite(lenB) ? Math.max(1e-4, lenB) : 0.1;
  const rx = Number.isFinite(root.x) ? root.x : 0.5;
  const ry = Number.isFinite(root.y) ? root.y : 0.5;
  const tx = Number.isFinite(target.x) ? target.x : rx;
  const ty = Number.isFinite(target.y) ? target.y : ry + safeA;

  const dx = tx - rx;
  const dy = ty - ry;
  const rawDist = Math.hypot(dx, dy);

  const minReach = Math.abs(safeA - safeB) + 1e-4;
  const maxReach = Math.max(minReach + 1e-4, (safeA + safeB) * 0.999);
  const clampedDist = Math.max(minReach, Math.min(maxReach, rawDist));

  const ux = rawDist > 1e-6 ? dx / rawDist : 0;
  const uy = rawDist > 1e-6 ? dy / rawDist : 1;

  const end: Vec2 = {
    x: rx + ux * clampedDist,
    y: ry + uy * clampedDist,
  };

  const cosAngle = Math.max(
    -1,
    Math.min(
      1,
      (safeA * safeA + clampedDist * clampedDist - safeB * safeB) / (2 * safeA * clampedDist),
    ),
  );
  const sinAngle = Math.sqrt(Math.max(0, 1 - cosAngle * cosAngle));
  const dirX = ux * cosAngle - uy * bendSign * sinAngle;
  const dirY = uy * cosAngle + ux * bendSign * sinAngle;

  const mid: Vec2 = {
    x: rx + dirX * safeA,
    y: ry + dirY * safeA,
  };

  return { mid, end };
}

/**
 * Applies an interactive joint drag onto a pose frame, solving 2-bone IK when enabled
 * and optionally anti-mirroring the opposite arm/leg relative to `pelvis.x`.
 */
export function applyJointDragWithIk(
  joints: PoseFrameJoints,
  jointId: PoseJointId,
  rawTarget: Vec2,
  opts: { readonly useIk?: boolean; readonly mirrorLimbs?: boolean } = {},
): PoseFrameJoints {
  const target: Vec2 = { x: clampNorm(rawTarget.x), y: clampNorm(rawTarget.y) };
  const useIk = opts.useIk ?? true;
  const mirrorLimbs = opts.mirrorLimbs ?? false;

  const mutable: Record<PoseJointId, Vec2> = { ...joints };
  const chain = useIk ? POSE_IK_CHAINS[jointId] : undefined;

  if (chain) {
    const rootPos = joints[chain.root];
    const lenA = Math.max(0.06, dist2d(joints[chain.root], joints[chain.mid]));
    const lenB = Math.max(0.06, dist2d(joints[chain.mid], joints[chain.end]));
    // Infer current bend side relative to root->end if clear, else use chain default
    const cross =
      (joints[chain.end].x - rootPos.x) * (joints[chain.mid].y - rootPos.y) -
      (joints[chain.end].y - rootPos.y) * (joints[chain.mid].x - rootPos.x);
    const bendSign: 1 | -1 = Math.abs(cross) > 1e-4 ? (cross >= 0 ? 1 : -1) : chain.bendSign;

    const solved = solveTwoBoneIk(rootPos, target, lenA, lenB, bendSign);
    mutable[chain.mid] = { x: clampNorm(solved.mid.x), y: clampNorm(solved.mid.y) };
    mutable[chain.end] = { x: clampNorm(solved.end.x), y: clampNorm(solved.end.y) };

    if (mirrorLimbs) {
      const oppEnd = OPPOSITE_JOINT_MAP[chain.end];
      const oppChain = oppEnd ? POSE_IK_CHAINS[oppEnd] : undefined;
      if (oppChain) {
        const oppRoot = joints[oppChain.root];
        const oppLenA = Math.max(0.06, dist2d(joints[oppChain.root], joints[oppChain.mid]));
        const oppLenB = Math.max(0.06, dist2d(joints[oppChain.mid], joints[oppChain.end]));
        const mirroredTarget: Vec2 = {
          x: clampNorm(2 * joints.pelvis.x - mutable[chain.end].x),
          y: mutable[chain.end].y,
        };
        const oppSolved = solveTwoBoneIk(
          oppRoot,
          mirroredTarget,
          oppLenA,
          oppLenB,
          -bendSign as 1 | -1,
        );
        mutable[oppChain.mid] = { x: clampNorm(oppSolved.mid.x), y: clampNorm(oppSolved.mid.y) };
        mutable[oppChain.end] = { x: clampNorm(oppSolved.end.x), y: clampNorm(oppSolved.end.y) };
      }
    }
    return mutable;
  }

  mutable[jointId] = target;
  if (mirrorLimbs) {
    const opp = OPPOSITE_JOINT_MAP[jointId];
    if (opp) {
      mutable[opp] = {
        x: clampNorm(2 * joints.pelvis.x - target.x),
        y: target.y,
      };
    }
  }
  return mutable;
}

/**
 * Linearly interpolates all 15 joints (and optional `propLine`) between two keyframes.
 */
export function interpolatePoseFrames(
  a: PoseKeyframe,
  b: PoseKeyframe,
  rawT: number,
  id = `pose-interp-${Date.now()}`,
): PoseKeyframe {
  const t = Number.isFinite(rawT) ? Math.max(0, Math.min(1, rawT)) : 0.5;
  const joints = {} as Record<PoseJointId, Vec2>;
  for (const jointId of ALL_POSE_JOINT_IDS) {
    const ja = a.joints[jointId];
    const jb = b.joints[jointId];
    joints[jointId] = {
      x: ja.x + (jb.x - ja.x) * t,
      y: ja.y + (jb.y - ja.y) * t,
    };
  }

  let propLine: readonly [Vec2, Vec2] | undefined;
  if (a.propLine && b.propLine) {
    propLine = [
      {
        x: a.propLine[0].x + (b.propLine[0].x - a.propLine[0].x) * t,
        y: a.propLine[0].y + (b.propLine[0].y - a.propLine[0].y) * t,
      },
      {
        x: a.propLine[1].x + (b.propLine[1].x - a.propLine[1].x) * t,
        y: a.propLine[1].y + (b.propLine[1].y - a.propLine[1].y) * t,
      },
    ];
  } else if (a.propLine || b.propLine) {
    propLine = t < 0.5 ? a.propLine : b.propLine;
  }

  return {
    id,
    joints,
    ...(propLine ? { propLine } : {}),
  };
}

function drawCapsule(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  radiusPx: number,
  rgb: RgbTriplet,
): void {
  const minX = Math.max(0, Math.floor(Math.min(x0, x1) - radiusPx - 1));
  const maxX = Math.min(width - 1, Math.ceil(Math.max(x0, x1) + radiusPx + 1));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1) - radiusPx - 1));
  const maxY = Math.min(height - 1, Math.ceil(Math.max(y0, y1) + radiusPx + 1));

  const segX = x1 - x0;
  const segY = y1 - y0;
  const segLenSq = segX * segX + segY * segY;
  const rSq = radiusPx * radiusPx;

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      let distSq: number;
      if (segLenSq <= 1e-6) {
        const dx = x - x0;
        const dy = y - y0;
        distSq = dx * dx + dy * dy;
      } else {
        const proj = Math.max(0, Math.min(1, ((x - x0) * segX + (y - y0) * segY) / segLenSq));
        const cx = x0 + proj * segX;
        const cy = y0 + proj * segY;
        const dx = x - cx;
        const dy = y - cy;
        distSq = dx * dx + dy * dy;
      }
      if (distSq <= rSq) {
        const idx = (y * width + x) * 4;
        data[idx] = rgb[0];
        data[idx + 1] = rgb[1];
        data[idx + 2] = rgb[2];
        data[idx + 3] = 255;
      }
    }
  }
}

/**
 * Pure-TS OpenPose color-coded stick-figure frame renderer onto `#000000` background.
 */
export function renderOpenPoseFrame(
  frame: PoseKeyframe,
  widthPx: number,
  heightPx: number,
): RgbaBuffer {
  const width = Math.max(8, Math.round(widthPx));
  const height = Math.max(8, Math.round(heightPx));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 255;
  }

  const limbRadius = Math.max(1.4, Math.min(2.6, Math.min(width, height) / 36));
  const jointRadius = Math.max(1.8, Math.min(2.8, Math.min(width, height) / 30));

  for (const bone of POSE_BONES) {
    const a = frame.joints[bone.from];
    const b = frame.joints[bone.to];
    drawCapsule(
      data,
      width,
      height,
      a.x * (width - 1),
      a.y * (height - 1),
      b.x * (width - 1),
      b.y * (height - 1),
      limbRadius,
      bone.rgb,
    );
  }

  if (frame.propLine) {
    const [pa, pb] = frame.propLine;
    drawCapsule(
      data,
      width,
      height,
      pa.x * (width - 1),
      pa.y * (height - 1),
      pb.x * (width - 1),
      pb.y * (height - 1),
      Math.max(1.2, limbRadius * 0.85),
      PROP_LINE_RGB,
    );
  }

  for (const jointId of ALL_POSE_JOINT_IDS) {
    const pt = frame.joints[jointId];
    const cx = pt.x * (width - 1);
    const cy = pt.y * (height - 1);
    drawCapsule(data, width, height, cx, cy, cx, cy, jointRadius, POSE_JOINT_COLORS[jointId]);
  }

  return { width, height, data };
}

/**
 * Packs `N` `PoseKeyframe` frames into one seamless `1×N` horizontal OpenPose guide strip.
 */
export function renderOpenPoseStrip(
  frames: readonly PoseKeyframe[],
  frameWidthPx: number,
  frameHeightPx: number,
): RgbaBuffer {
  const safeFrames = frames.length > 0 ? frames : [];
  const fw = Math.max(8, Math.round(frameWidthPx));
  const fh = Math.max(8, Math.round(frameHeightPx));
  const totalW = Math.max(fw, fw * Math.max(1, safeFrames.length));
  const data = new Uint8ClampedArray(totalW * fh * 4);
  for (let i = 3; i < data.length; i += 4) {
    data[i] = 255;
  }

  for (let f = 0; f < safeFrames.length; f++) {
    const cell = renderOpenPoseFrame(safeFrames[f]!, fw, fh);
    const xOffset = f * fw;
    for (let y = 0; y < fh; y++) {
      for (let x = 0; x < fw; x++) {
        const src = (y * fw + x) * 4;
        const dst = (y * totalW + (xOffset + x)) * 4;
        data[dst] = cell.data[src] ?? 0;
        data[dst + 1] = cell.data[src + 1] ?? 0;
        data[dst + 2] = cell.data[src + 2] ?? 0;
        data[dst + 3] = 255;
      }
    }
  }

  return { width: totalW, height: fh, data };
}

/**
 * Combines equal-sized frames into a single `1×N` horizontal sprite sheet strip.
 */
export function packFramesToHorizontalStrip(frames: readonly RgbaBuffer[]): RgbaBuffer {
  if (frames.length === 0) {
    return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  }
  const fw = frames[0]!.width;
  const fh = frames[0]!.height;
  const totalW = fw * frames.length;
  const data = new Uint8ClampedArray(totalW * fh * 4);

  for (let i = 0; i < frames.length; i++) {
    const frame = frames[i]!;
    const copyW = Math.min(fw, frame.width);
    const copyH = Math.min(fh, frame.height);
    const xOffset = i * fw;
    for (let y = 0; y < copyH; y++) {
      for (let x = 0; x < copyW; x++) {
        const src = (y * frame.width + x) * 4;
        const dst = (y * totalW + (xOffset + x)) * 4;
        data[dst] = frame.data[src] ?? 0;
        data[dst + 1] = frame.data[src + 1] ?? 0;
        data[dst + 2] = frame.data[src + 2] ?? 0;
        data[dst + 3] = frame.data[src + 3] ?? 0;
      }
    }
  }

  return { width: totalW, height: fh, data };
}

export interface SliceAndAlignPoseOptions {
  readonly chromaTolerance?: number;
  readonly groundMarginPx?: number;
  readonly paletteHex?: readonly string[];
  readonly snapToPalette?: boolean;
}

/**
 * Slices a `1×N` generated sprite strip into `N` equal cells, removes flat `#FF00FF` chroma
 * background pixels, optionally snaps opaque pixels to `paletteHex` in OKLab, and vertically
 * aligns every non-empty frame so its bottom-most opaque pixel rests on the shared ground row.
 */
export function sliceAndAlignPoseStrip(
  strip: RgbaBuffer,
  frameCount: number,
  chromaRgb: RgbTriplet = [255, 0, 255],
  opts: SliceAndAlignPoseOptions = {},
): readonly RgbaBuffer[] {
  const safeCount = Math.max(1, Math.round(frameCount));
  const cellW = Math.max(1, Math.floor(strip.width / safeCount));
  const cellH = Math.max(1, strip.height);
  const tolerance = Math.max(0, Math.min(180, opts.chromaTolerance ?? 42));
  const groundMargin = Math.max(0, Math.min(Math.max(0, cellH - 2), opts.groundMarginPx ?? 2));
  const targetBottomY = Math.max(0, cellH - 1 - groundMargin);
  const results: RgbaBuffer[] = [];

  for (let i = 0; i < safeCount; i++) {
    const startX = i * cellW;
    const keyed = new Uint8ClampedArray(cellW * cellH * 4);
    let maxOpaqueY = -1;

    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const sx = startX + x;
        if (sx >= strip.width) continue;
        const sIdx = (y * strip.width + sx) * 4;
        const r = strip.data[sIdx] ?? 0;
        const g = strip.data[sIdx + 1] ?? 0;
        const b = strip.data[sIdx + 2] ?? 0;
        const a = strip.data[sIdx + 3] ?? 0;
        if (a <= 12) continue;

        const dist = Math.hypot(r - chromaRgb[0], g - chromaRgb[1], b - chromaRgb[2]);
        if (dist <= tolerance) continue;

        const dIdx = (y * cellW + x) * 4;
        keyed[dIdx] = r;
        keyed[dIdx + 1] = g;
        keyed[dIdx + 2] = b;
        keyed[dIdx + 3] = a;
        if (y > maxOpaqueY) {
          maxOpaqueY = y;
        }
      }
    }

    let alignedData = new Uint8ClampedArray(cellW * cellH * 4);
    if (maxOpaqueY >= 0) {
      const shiftY = targetBottomY - maxOpaqueY;
      for (let y = 0; y < cellH; y++) {
        const dstY = y + shiftY;
        if (dstY < 0 || dstY >= cellH) continue;
        for (let x = 0; x < cellW; x++) {
          const sIdx = (y * cellW + x) * 4;
          if ((keyed[sIdx + 3] ?? 0) === 0) continue;
          const dIdx = (dstY * cellW + x) * 4;
          alignedData[dIdx] = keyed[sIdx]!;
          alignedData[dIdx + 1] = keyed[sIdx + 1]!;
          alignedData[dIdx + 2] = keyed[sIdx + 2]!;
          alignedData[dIdx + 3] = keyed[sIdx + 3]!;
        }
      }
    }

    if (opts.snapToPalette && opts.paletteHex && opts.paletteHex.length > 0) {
      alignedData = new Uint8ClampedArray(
        quantizeToPaletteOklab(alignedData, cellW, cellH, opts.paletteHex, { dither: false }),
      );
    }

    results.push({ width: cellW, height: cellH, data: alignedData });
  }

  return results;
}
