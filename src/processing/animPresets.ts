import type { MlsMode, Vec2 } from './mlsWarp';

export type PinRole = 'anchor' | 'driver' | 'tip';
export type AnimPresetKind = 'idle-breathe' | 'wind-sway' | 'hit-recoil' | 'squash-stretch';

export interface PuppetPin {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly role: PinRole;
  readonly label?: string;
}

export interface PinKeyframe {
  readonly t: number; // [0..1)
  readonly pins: readonly Vec2[];
}

export interface PresetDefinition {
  readonly id: AnimPresetKind;
  readonly label: string;
  readonly exportSuffix: string;
  readonly mlsMode: MlsMode;
  readonly defaultFrames: number;
  readonly defaultAmplitudePx: number;
}

export const ANIM_PRESETS: Record<AnimPresetKind, PresetDefinition> = {
  'idle-breathe': {
    id: 'idle-breathe',
    label: 'Idle Breathe',
    exportSuffix: 'idle',
    mlsMode: 'rigid',
    defaultFrames: 6,
    defaultAmplitudePx: 3,
  },
  'wind-sway': {
    id: 'wind-sway',
    label: 'Wind / Ambient Sway',
    exportSuffix: 'sway',
    mlsMode: 'rigid',
    defaultFrames: 8,
    defaultAmplitudePx: 4,
  },
  'hit-recoil': {
    id: 'hit-recoil',
    label: 'Hit Recoil',
    exportSuffix: 'recoil',
    mlsMode: 'rigid',
    defaultFrames: 6,
    defaultAmplitudePx: 5,
  },
  'squash-stretch': {
    id: 'squash-stretch',
    label: 'Squash & Stretch',
    exportSuffix: 'squash',
    mlsMode: 'similarity',
    defaultFrames: 6,
    defaultAmplitudePx: 4,
  },
};

/**
 * Computes centroid of anchor pins (or overall pins) for squash-and-stretch lateral expansion.
 */
function computeAnchorCenterX(restPins: readonly PuppetPin[]): number {
  const anchors = restPins.filter((p) => p.role === 'anchor');
  const source = anchors.length > 0 ? anchors : restPins;
  if (source.length === 0) return 0;
  let sumX = 0;
  for (const p of source) sumX += p.x;
  return sumX / source.length;
}

/**
 * Evaluates periodic animated pin positions for normalized loop parameter `tNormalized` in `[0, 1]`.
 * Guarantees exact cyclic closure (`evaluatePresetPins(..., 0)` matches `evaluatePresetPins(..., 1)`).
 */
export function evaluatePresetPins(
  restPins: readonly PuppetPin[],
  preset: AnimPresetKind,
  tNormalized: number,
  amplitudePx = ANIM_PRESETS[preset].defaultAmplitudePx,
): Vec2[] {
  const wrapped = ((tNormalized % 1) + 1) % 1;
  const t = wrapped < 1e-9 || wrapped > 1 - 1e-9 ? 0 : wrapped;
  const centerX = computeAnchorCenterX(restPins);

  return restPins.map((pin) => {
    if (pin.role === 'anchor') {
      return { x: pin.x, y: pin.y };
    }

    const weight = pin.role === 'tip' ? 1.0 : 0.45;
    switch (preset) {
      case 'idle-breathe': {
        const s = Math.sin(Math.PI * t);
        const dy = -amplitudePx * s * s * weight;
        return { x: pin.x, y: pin.y + dy };
      }
      case 'wind-sway': {
        const wave = Math.sin(2 * Math.PI * t);
        const dx = amplitudePx * wave * weight;
        const dy = Math.abs(wave) * amplitudePx * 0.2 * weight;
        return { x: pin.x + dx, y: pin.y + dy };
      }
      case 'hit-recoil': {
        const impulse = t === 0 ? 0 : Math.exp(-4 * t) * Math.sin(Math.PI * t);
        const dx = -amplitudePx * 1.8 * impulse * weight;
        const dy = -amplitudePx * 0.4 * impulse * weight;
        return { x: pin.x + dx, y: pin.y + dy };
      }
      case 'squash-stretch': {
        const wave = Math.sin(2 * Math.PI * t);
        const dy = -amplitudePx * wave * weight;
        const sideSign = pin.x >= centerX ? 1 : -1;
        const dx = sideSign * (amplitudePx * 0.55) * wave * weight;
        return { x: pin.x + dx, y: pin.y + dy };
      }
    }
  });
}

/**
 * Generates an ordered keyframe array `[0 .. frameCount - 1]` for seamless sprite looping.
 */
export function generatePresetKeyframes(
  restPins: readonly PuppetPin[],
  preset: AnimPresetKind,
  frameCount = ANIM_PRESETS[preset].defaultFrames,
  amplitudePx = ANIM_PRESETS[preset].defaultAmplitudePx,
): PinKeyframe[] {
  const count = Math.max(2, Math.round(frameCount));
  const frames: PinKeyframe[] = [];
  for (let i = 0; i < count; i++) {
    const t = i / count;
    frames.push({
      t,
      pins: evaluatePresetPins(restPins, preset, t, amplitudePx),
    });
  }
  return frames;
}
