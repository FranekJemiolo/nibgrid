import type { PoseClipDefinition, PoseFrameJoints, PoseKeyframe, Vec2 } from './poseRigCore';

export type PoseCyclePresetId = 'run_6f' | 'melee_slash_5f' | 'jump_4f' | 'idle_4f';

export interface PoseCyclePresetSpec {
  readonly id: PoseCyclePresetId;
  readonly label: string;
  readonly slug: string;
  readonly fps: number;
  readonly loop: boolean;
  readonly description: string;
  readonly frames: readonly PoseKeyframe[];
}

function makeJoints(overrides: Partial<PoseFrameJoints>): PoseFrameJoints {
  const base: PoseFrameJoints = {
    head: { x: 0.5, y: 0.2 },
    neck: { x: 0.5, y: 0.31 },
    pelvis: { x: 0.5, y: 0.54 },
    r_shoulder: { x: 0.43, y: 0.33 },
    r_elbow: { x: 0.39, y: 0.45 },
    r_wrist: { x: 0.42, y: 0.55 },
    l_shoulder: { x: 0.57, y: 0.33 },
    l_elbow: { x: 0.61, y: 0.45 },
    l_wrist: { x: 0.58, y: 0.55 },
    r_hip: { x: 0.45, y: 0.56 },
    r_knee: { x: 0.44, y: 0.72 },
    r_ankle: { x: 0.43, y: 0.89 },
    l_hip: { x: 0.55, y: 0.56 },
    l_knee: { x: 0.56, y: 0.72 },
    l_ankle: { x: 0.57, y: 0.89 },
  };
  return { ...base, ...overrides };
}

function makeFrame(
  id: string,
  overrides: Partial<PoseFrameJoints>,
  propLine?: readonly [Vec2, Vec2],
): PoseKeyframe {
  return {
    id,
    joints: makeJoints(overrides),
    ...(propLine ? { propLine } : {}),
  };
}

const RUN_6F_FRAMES: readonly PoseKeyframe[] = [
  makeFrame('run-0', {
    head: { x: 0.54, y: 0.19 },
    neck: { x: 0.52, y: 0.31 },
    pelvis: { x: 0.49, y: 0.53 },
    r_shoulder: { x: 0.48, y: 0.33 },
    r_elbow: { x: 0.37, y: 0.43 },
    r_wrist: { x: 0.32, y: 0.51 },
    l_shoulder: { x: 0.56, y: 0.33 },
    l_elbow: { x: 0.66, y: 0.41 },
    l_wrist: { x: 0.73, y: 0.35 },
    r_hip: { x: 0.47, y: 0.55 },
    r_knee: { x: 0.62, y: 0.69 },
    r_ankle: { x: 0.69, y: 0.88 },
    l_hip: { x: 0.51, y: 0.55 },
    l_knee: { x: 0.37, y: 0.71 },
    l_ankle: { x: 0.27, y: 0.85 },
  }),
  makeFrame('run-1', {
    head: { x: 0.54, y: 0.22 },
    neck: { x: 0.52, y: 0.34 },
    pelvis: { x: 0.49, y: 0.56 },
    r_shoulder: { x: 0.48, y: 0.35 },
    r_elbow: { x: 0.41, y: 0.47 },
    r_wrist: { x: 0.46, y: 0.54 },
    l_shoulder: { x: 0.56, y: 0.35 },
    l_elbow: { x: 0.61, y: 0.46 },
    l_wrist: { x: 0.63, y: 0.43 },
    r_hip: { x: 0.47, y: 0.58 },
    r_knee: { x: 0.54, y: 0.74 },
    r_ankle: { x: 0.52, y: 0.9 },
    l_hip: { x: 0.51, y: 0.58 },
    l_knee: { x: 0.43, y: 0.72 },
    l_ankle: { x: 0.34, y: 0.78 },
  }),
  makeFrame('run-2', {
    head: { x: 0.55, y: 0.17 },
    neck: { x: 0.53, y: 0.29 },
    pelvis: { x: 0.49, y: 0.51 },
    r_shoulder: { x: 0.49, y: 0.31 },
    r_elbow: { x: 0.59, y: 0.39 },
    r_wrist: { x: 0.68, y: 0.34 },
    l_shoulder: { x: 0.56, y: 0.31 },
    l_elbow: { x: 0.42, y: 0.42 },
    l_wrist: { x: 0.33, y: 0.47 },
    r_hip: { x: 0.47, y: 0.53 },
    r_knee: { x: 0.39, y: 0.7 },
    r_ankle: { x: 0.31, y: 0.87 },
    l_hip: { x: 0.51, y: 0.53 },
    l_knee: { x: 0.65, y: 0.66 },
    l_ankle: { x: 0.59, y: 0.81 },
  }),
  makeFrame('run-3', {
    head: { x: 0.54, y: 0.19 },
    neck: { x: 0.52, y: 0.31 },
    pelvis: { x: 0.49, y: 0.53 },
    r_shoulder: { x: 0.48, y: 0.33 },
    r_elbow: { x: 0.65, y: 0.41 },
    r_wrist: { x: 0.73, y: 0.35 },
    l_shoulder: { x: 0.56, y: 0.33 },
    l_elbow: { x: 0.38, y: 0.43 },
    l_wrist: { x: 0.31, y: 0.51 },
    r_hip: { x: 0.47, y: 0.55 },
    r_knee: { x: 0.36, y: 0.71 },
    r_ankle: { x: 0.26, y: 0.85 },
    l_hip: { x: 0.51, y: 0.55 },
    l_knee: { x: 0.63, y: 0.68 },
    l_ankle: { x: 0.7, y: 0.88 },
  }),
  makeFrame('run-4', {
    head: { x: 0.54, y: 0.22 },
    neck: { x: 0.52, y: 0.34 },
    pelvis: { x: 0.49, y: 0.56 },
    r_shoulder: { x: 0.48, y: 0.35 },
    r_elbow: { x: 0.6, y: 0.45 },
    r_wrist: { x: 0.62, y: 0.42 },
    l_shoulder: { x: 0.56, y: 0.35 },
    l_elbow: { x: 0.42, y: 0.47 },
    l_wrist: { x: 0.47, y: 0.53 },
    r_hip: { x: 0.47, y: 0.58 },
    r_knee: { x: 0.44, y: 0.72 },
    r_ankle: { x: 0.35, y: 0.78 },
    l_hip: { x: 0.51, y: 0.58 },
    l_knee: { x: 0.53, y: 0.74 },
    l_ankle: { x: 0.51, y: 0.9 },
  }),
  makeFrame('run-5', {
    head: { x: 0.55, y: 0.17 },
    neck: { x: 0.53, y: 0.29 },
    pelvis: { x: 0.49, y: 0.51 },
    r_shoulder: { x: 0.49, y: 0.31 },
    r_elbow: { x: 0.41, y: 0.42 },
    r_wrist: { x: 0.32, y: 0.48 },
    l_shoulder: { x: 0.56, y: 0.31 },
    l_elbow: { x: 0.6, y: 0.39 },
    l_wrist: { x: 0.68, y: 0.34 },
    r_hip: { x: 0.47, y: 0.53 },
    r_knee: { x: 0.65, y: 0.65 },
    r_ankle: { x: 0.59, y: 0.8 },
    l_hip: { x: 0.51, y: 0.53 },
    l_knee: { x: 0.39, y: 0.7 },
    l_ankle: { x: 0.3, y: 0.87 },
  }),
];

const MELEE_SLASH_5F_FRAMES: readonly PoseKeyframe[] = [
  makeFrame(
    'slash-0',
    {
      head: { x: 0.47, y: 0.21 },
      neck: { x: 0.47, y: 0.33 },
      pelvis: { x: 0.48, y: 0.55 },
      r_shoulder: { x: 0.41, y: 0.35 },
      r_elbow: { x: 0.31, y: 0.29 },
      r_wrist: { x: 0.28, y: 0.2 },
      l_shoulder: { x: 0.54, y: 0.35 },
      l_elbow: { x: 0.61, y: 0.44 },
      l_wrist: { x: 0.66, y: 0.49 },
      r_ankle: { x: 0.38, y: 0.89 },
      l_ankle: { x: 0.58, y: 0.89 },
    },
    [
      { x: 0.28, y: 0.2 },
      { x: 0.14, y: 0.08 },
    ],
  ),
  makeFrame(
    'slash-1',
    {
      head: { x: 0.51, y: 0.22 },
      neck: { x: 0.5, y: 0.33 },
      pelvis: { x: 0.49, y: 0.55 },
      r_shoulder: { x: 0.44, y: 0.34 },
      r_elbow: { x: 0.52, y: 0.26 },
      r_wrist: { x: 0.64, y: 0.24 },
      l_shoulder: { x: 0.56, y: 0.35 },
      l_elbow: { x: 0.5, y: 0.45 },
      l_wrist: { x: 0.43, y: 0.51 },
      r_knee: { x: 0.59, y: 0.71 },
      r_ankle: { x: 0.62, y: 0.89 },
      l_ankle: { x: 0.39, y: 0.89 },
    },
    [
      { x: 0.64, y: 0.24 },
      { x: 0.85, y: 0.15 },
    ],
  ),
  makeFrame(
    'slash-2',
    {
      head: { x: 0.56, y: 0.24 },
      neck: { x: 0.54, y: 0.35 },
      pelvis: { x: 0.5, y: 0.56 },
      r_shoulder: { x: 0.5, y: 0.36 },
      r_elbow: { x: 0.64, y: 0.38 },
      r_wrist: { x: 0.76, y: 0.44 },
      l_shoulder: { x: 0.58, y: 0.37 },
      l_elbow: { x: 0.45, y: 0.47 },
      l_wrist: { x: 0.37, y: 0.52 },
      r_knee: { x: 0.63, y: 0.72 },
      r_ankle: { x: 0.66, y: 0.9 },
      l_ankle: { x: 0.36, y: 0.89 },
    },
    [
      { x: 0.76, y: 0.44 },
      { x: 0.94, y: 0.48 },
    ],
  ),
  makeFrame(
    'slash-3',
    {
      head: { x: 0.54, y: 0.23 },
      neck: { x: 0.53, y: 0.35 },
      pelvis: { x: 0.5, y: 0.56 },
      r_shoulder: { x: 0.49, y: 0.36 },
      r_elbow: { x: 0.61, y: 0.49 },
      r_wrist: { x: 0.69, y: 0.61 },
      l_shoulder: { x: 0.57, y: 0.36 },
      l_elbow: { x: 0.46, y: 0.45 },
      l_wrist: { x: 0.38, y: 0.48 },
      r_knee: { x: 0.61, y: 0.72 },
      r_ankle: { x: 0.64, y: 0.89 },
      l_ankle: { x: 0.38, y: 0.89 },
    },
    [
      { x: 0.69, y: 0.61 },
      { x: 0.87, y: 0.76 },
    ],
  ),
  makeFrame(
    'slash-4',
    {
      head: { x: 0.5, y: 0.2 },
      neck: { x: 0.5, y: 0.32 },
      pelvis: { x: 0.5, y: 0.54 },
      r_shoulder: { x: 0.44, y: 0.34 },
      r_elbow: { x: 0.44, y: 0.46 },
      r_wrist: { x: 0.55, y: 0.5 },
      l_shoulder: { x: 0.56, y: 0.34 },
      l_elbow: { x: 0.6, y: 0.45 },
      l_wrist: { x: 0.58, y: 0.54 },
      r_ankle: { x: 0.43, y: 0.89 },
      l_ankle: { x: 0.58, y: 0.89 },
    },
    [
      { x: 0.55, y: 0.5 },
      { x: 0.73, y: 0.38 },
    ],
  ),
];

const JUMP_4F_FRAMES: readonly PoseKeyframe[] = [
  makeFrame('jump-0', {
    head: { x: 0.5, y: 0.27 },
    neck: { x: 0.5, y: 0.38 },
    pelvis: { x: 0.5, y: 0.6 },
    r_shoulder: { x: 0.43, y: 0.4 },
    r_elbow: { x: 0.35, y: 0.5 },
    r_wrist: { x: 0.31, y: 0.59 },
    l_shoulder: { x: 0.57, y: 0.4 },
    l_elbow: { x: 0.65, y: 0.5 },
    l_wrist: { x: 0.69, y: 0.59 },
    r_knee: { x: 0.41, y: 0.72 },
    r_ankle: { x: 0.43, y: 0.9 },
    l_knee: { x: 0.59, y: 0.72 },
    l_ankle: { x: 0.57, y: 0.9 },
  }),
  makeFrame('jump-1', {
    head: { x: 0.5, y: 0.14 },
    neck: { x: 0.5, y: 0.25 },
    pelvis: { x: 0.5, y: 0.47 },
    r_shoulder: { x: 0.43, y: 0.27 },
    r_elbow: { x: 0.34, y: 0.2 },
    r_wrist: { x: 0.3, y: 0.11 },
    l_shoulder: { x: 0.57, y: 0.27 },
    l_elbow: { x: 0.66, y: 0.21 },
    l_wrist: { x: 0.7, y: 0.13 },
    r_knee: { x: 0.44, y: 0.64 },
    r_ankle: { x: 0.43, y: 0.83 },
    l_knee: { x: 0.56, y: 0.63 },
    l_ankle: { x: 0.57, y: 0.81 },
  }),
  makeFrame('jump-2', {
    head: { x: 0.51, y: 0.13 },
    neck: { x: 0.51, y: 0.24 },
    pelvis: { x: 0.5, y: 0.44 },
    r_shoulder: { x: 0.43, y: 0.26 },
    r_elbow: { x: 0.35, y: 0.19 },
    r_wrist: { x: 0.38, y: 0.11 },
    l_shoulder: { x: 0.57, y: 0.26 },
    l_elbow: { x: 0.66, y: 0.21 },
    l_wrist: { x: 0.68, y: 0.15 },
    r_knee: { x: 0.4, y: 0.54 },
    r_ankle: { x: 0.45, y: 0.68 },
    l_knee: { x: 0.61, y: 0.55 },
    l_ankle: { x: 0.55, y: 0.71 },
  }),
  makeFrame('jump-3', {
    head: { x: 0.5, y: 0.22 },
    neck: { x: 0.5, y: 0.33 },
    pelvis: { x: 0.5, y: 0.56 },
    r_shoulder: { x: 0.43, y: 0.35 },
    r_elbow: { x: 0.34, y: 0.42 },
    r_wrist: { x: 0.29, y: 0.36 },
    l_shoulder: { x: 0.57, y: 0.35 },
    l_elbow: { x: 0.66, y: 0.42 },
    l_wrist: { x: 0.71, y: 0.36 },
    r_knee: { x: 0.42, y: 0.7 },
    r_ankle: { x: 0.43, y: 0.89 },
    l_knee: { x: 0.58, y: 0.7 },
    l_ankle: { x: 0.57, y: 0.89 },
  }),
];

const IDLE_4F_FRAMES: readonly PoseKeyframe[] = [
  makeFrame('idle-0', {
    head: { x: 0.5, y: 0.2 },
    neck: { x: 0.5, y: 0.31 },
    pelvis: { x: 0.5, y: 0.54 },
  }),
  makeFrame('idle-1', {
    head: { x: 0.5, y: 0.215 },
    neck: { x: 0.5, y: 0.325 },
    pelvis: { x: 0.5, y: 0.545 },
    r_wrist: { x: 0.41, y: 0.56 },
    l_wrist: { x: 0.59, y: 0.56 },
  }),
  makeFrame('idle-2', {
    head: { x: 0.5, y: 0.22 },
    neck: { x: 0.5, y: 0.33 },
    pelvis: { x: 0.5, y: 0.55 },
    r_wrist: { x: 0.4, y: 0.57 },
    l_wrist: { x: 0.6, y: 0.57 },
  }),
  makeFrame('idle-3', {
    head: { x: 0.5, y: 0.21 },
    neck: { x: 0.5, y: 0.32 },
    pelvis: { x: 0.5, y: 0.545 },
    r_wrist: { x: 0.41, y: 0.56 },
    l_wrist: { x: 0.59, y: 0.56 },
  }),
];

export const POSE_CYCLE_PRESETS: Readonly<Record<PoseCyclePresetId, PoseCyclePresetSpec>> = {
  run_6f: {
    id: 'run_6f',
    label: 'Run Cycle (6f)',
    slug: 'run',
    fps: 12,
    loop: true,
    description: '6-frame contact/down/pass/stride athletic run loop',
    frames: RUN_6F_FRAMES,
  },
  melee_slash_5f: {
    id: 'melee_slash_5f',
    label: 'Melee Slash (5f)',
    slug: 'slash',
    fps: 14,
    loop: false,
    description: '5-frame anticipation, swing arc, follow-through with sword line',
    frames: MELEE_SLASH_5F_FRAMES,
  },
  jump_4f: {
    id: 'jump_4f',
    label: 'Jump Arc (4f)',
    slug: 'jump',
    fps: 10,
    loop: false,
    description: '4-frame crouch, launch, apex tuck, and landing',
    frames: JUMP_4F_FRAMES,
  },
  idle_4f: {
    id: 'idle_4f',
    label: 'Idle Ready (4f)',
    slug: 'idle',
    fps: 6,
    loop: true,
    description: '4-frame breathing stance with subtle weight drop',
    frames: IDLE_4F_FRAMES,
  },
};

export function getPoseCyclePreset(id: PoseCyclePresetId): PoseCyclePresetSpec {
  return POSE_CYCLE_PRESETS[id];
}

export function createPoseClipFromPreset(
  presetId: PoseCyclePresetId = 'run_6f',
  frameWidthPx = 64,
  frameHeightPx = 64,
): PoseClipDefinition {
  const preset = POSE_CYCLE_PRESETS[presetId];
  return {
    slug: preset.slug,
    fps: preset.fps,
    loop: preset.loop,
    frameWidthPx: Math.max(16, Math.min(256, Math.round(frameWidthPx))),
    frameHeightPx: Math.max(16, Math.min(256, Math.round(frameHeightPx))),
    frames: preset.frames.map((frame) => ({
      id: frame.id,
      joints: { ...frame.joints },
      ...(frame.propLine ? { propLine: [{ ...frame.propLine[0] }, { ...frame.propLine[1] }] } : {}),
    })),
  };
}
