export const HITSTOP_DURATION_MS = 40;
export const FLASH_DECAY_DURATION_MS = 110;
export const MAX_DT_MS = 50;

export type FlashColorMode = 'white' | 'red';
export type SandboxLens = 'normal' | 'value' | 'silhouette';
export type SandboxScale = 1 | 2 | 3 | 4;
export type SandboxGridSize = 0 | 16 | 32;

export interface SandboxState {
  readonly posX: number;
  readonly posY: number;
  readonly scrollOffsetX: number;
  readonly scrollOffsetY: number;
  readonly flipped: boolean;
  readonly flashAlpha: number;
  readonly flashRemainingMs: number;
  readonly hitstopRemainingMs: number;
  readonly shakeOffsetX: number;
  readonly shakeOffsetY: number;
  readonly knockbackOffsetX: number;
  readonly animAccumulatorMs: number;
  readonly frameIndex: number;
  readonly animDirection: 1 | -1;
  readonly elapsedMs: number;
  readonly bobOffsetY: number;
}

export interface SandboxInputState {
  readonly moveX: number; // -1..1
  readonly moveY: number; // -1..1
  readonly moveSpeedPxPerSec: number;
  readonly scrollSpeedPxPerSec: number;
  readonly cameraWidth: number;
  readonly cameraHeight: number;
  readonly playing: boolean;
  readonly fps: number;
  readonly frameCount: number;
  readonly pingPong: boolean;
}

export function createInitialSandboxState(partial: Partial<SandboxState> = {}): SandboxState {
  return {
    posX: partial.posX ?? 240,
    posY: partial.posY ?? 150,
    scrollOffsetX: partial.scrollOffsetX ?? 0,
    scrollOffsetY: partial.scrollOffsetY ?? 0,
    flipped: partial.flipped ?? false,
    flashAlpha: partial.flashAlpha ?? 0,
    flashRemainingMs: partial.flashRemainingMs ?? 0,
    hitstopRemainingMs: partial.hitstopRemainingMs ?? 0,
    shakeOffsetX: partial.shakeOffsetX ?? 0,
    shakeOffsetY: partial.shakeOffsetY ?? 0,
    knockbackOffsetX: partial.knockbackOffsetX ?? 0,
    animAccumulatorMs: partial.animAccumulatorMs ?? 0,
    frameIndex: partial.frameIndex ?? 0,
    animDirection: partial.animDirection ?? 1,
    elapsedMs: partial.elapsedMs ?? 0,
    bobOffsetY: partial.bobOffsetY ?? 0,
  };
}

/**
 * Triggers a 40ms hitstop freeze + 110ms linear hit-flash + micro camera shake & knockback nudge.
 */
export function triggerHit(state: SandboxState): SandboxState {
  return {
    ...state,
    hitstopRemainingMs: HITSTOP_DURATION_MS,
    flashRemainingMs: FLASH_DECAY_DURATION_MS,
    flashAlpha: 1,
    shakeOffsetX: -2,
    shakeOffsetY: 1,
    knockbackOffsetX: state.flipped ? 2 : -2,
  };
}

export function toggleFlip(state: SandboxState): SandboxState {
  return {
    ...state,
    flipped: !state.flipped,
  };
}

/**
 * Pure deterministic simulation step clamped to `dt <= 50ms`.
 */
export function stepSandboxState(
  state: SandboxState,
  input: SandboxInputState,
  rawDtMs: number,
): SandboxState {
  const dt = Math.max(0, Math.min(MAX_DT_MS, Number.isFinite(rawDtMs) ? rawDtMs : 0));

  let hitstopRemainingMs = state.hitstopRemainingMs;
  let flashRemainingMs = state.flashRemainingMs;
  let flashAlpha = state.flashAlpha;
  let shakeOffsetX = state.shakeOffsetX;
  let shakeOffsetY = state.shakeOffsetY;
  let knockbackOffsetX = state.knockbackOffsetX;

  // 1. Hitstop freeze pauses scroll, movement, and animation clock
  let activeDt = dt;
  if (hitstopRemainingMs > 0) {
    if (dt <= hitstopRemainingMs) {
      hitstopRemainingMs -= dt;
      return {
        ...state,
        hitstopRemainingMs,
        flashAlpha: flashRemainingMs > 0 ? 1 : state.flashAlpha,
      };
    }
    activeDt = dt - hitstopRemainingMs;
    hitstopRemainingMs = 0;
  }

  // 2. Post-hitstop linear flash decay + damped micro shake / knockback settle
  if (flashRemainingMs > 0 && activeDt > 0) {
    flashRemainingMs = Math.max(0, flashRemainingMs - activeDt);
    const ratio = flashRemainingMs / FLASH_DECAY_DURATION_MS;
    flashAlpha = ratio;
    const phase = Math.round(flashRemainingMs / 16) % 2 === 0 ? 1 : -1;
    shakeOffsetX = flashRemainingMs > 0 ? Math.round(ratio * 2) * phase : 0;
    shakeOffsetY = flashRemainingMs > 0 ? Math.round(ratio * 1.5) * -phase : 0;
    knockbackOffsetX = flashRemainingMs > 0 ? Math.round((state.flipped ? 2 : -2) * ratio) : 0;
  } else if (flashRemainingMs <= 0) {
    flashAlpha = 0;
    shakeOffsetX = 0;
    shakeOffsetY = 0;
    knockbackOffsetX = 0;
  }

  // 3. Movement clamped inside virtual camera margins
  const dtSec = activeDt / 1000;
  const marginX = 20;
  const marginY = 24;
  const minX = marginX;
  const maxX = Math.max(marginX, input.cameraWidth - marginX);
  const minY = marginY;
  const maxY = Math.max(marginY, input.cameraHeight - 12);

  const posX = Math.max(
    minX,
    Math.min(maxX, state.posX + input.moveX * input.moveSpeedPxPerSec * dtSec),
  );
  const posY = Math.max(
    minY,
    Math.min(maxY, state.posY + input.moveY * input.moveSpeedPxPerSec * dtSec),
  );

  // 4. World scroll offset (when playing or moving)
  const scrollDelta = input.scrollSpeedPxPerSec * dtSec;
  const scrollOffsetX = state.scrollOffsetX + scrollDelta;
  const scrollOffsetY = state.scrollOffsetY + scrollDelta * 0.5;

  // 5. Animation clock & subtle static sprite idle/walk bob
  let animAccumulatorMs = state.animAccumulatorMs;
  let frameIndex = state.frameIndex;
  let animDirection = state.animDirection;
  const elapsedMs = state.elapsedMs + activeDt;
  let bobOffsetY = 0;

  if (input.playing) {
    if (input.frameCount > 1) {
      const frameDurationMs = 1000 / Math.max(1, Math.min(24, input.fps));
      animAccumulatorMs += activeDt;
      while (animAccumulatorMs >= frameDurationMs) {
        animAccumulatorMs -= frameDurationMs;
        if (input.pingPong) {
          let next = frameIndex + animDirection;
          if (next >= input.frameCount) {
            animDirection = -1;
            next = Math.max(0, input.frameCount - 2);
          } else if (next < 0) {
            animDirection = 1;
            next = Math.min(input.frameCount - 1, 1);
          }
          frameIndex = next;
        } else {
          frameIndex = (frameIndex + 1) % input.frameCount;
        }
      }
    } else {
      const moving =
        Math.abs(input.moveX) > 0 || Math.abs(input.moveY) > 0 || input.scrollSpeedPxPerSec > 0;
      const freq = moving ? 0.012 : 0.005;
      bobOffsetY = Math.round(Math.sin(elapsedMs * freq) * (moving ? 1.5 : 1.0));
    }
  }

  return {
    ...state,
    posX,
    posY,
    scrollOffsetX,
    scrollOffsetY,
    flashAlpha,
    flashRemainingMs,
    hitstopRemainingMs,
    shakeOffsetX,
    shakeOffsetY,
    knockbackOffsetX,
    animAccumulatorMs,
    frameIndex: input.frameCount > 0 ? Math.max(0, Math.min(input.frameCount - 1, frameIndex)) : 0,
    animDirection,
    elapsedMs,
    bobOffsetY,
  };
}
