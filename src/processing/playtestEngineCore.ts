import { z } from 'zod';
import type { CollisionLayerShape } from '../domain/schemas';

export const PlaytestMovementModeSchema = z.enum(['side-platformer', 'top-down']);
export type PlaytestMovementMode = z.infer<typeof PlaytestMovementModeSchema>;

export const PlaytestJuiceConfigSchema = z.object({
  mode: PlaytestMovementModeSchema.default('side-platformer'),
  moveSpeedPx: z.number().min(20).max(600).default(140),
  jumpVelocityPx: z.number().min(-800).max(-40).default(-280),
  gravityPx: z.number().min(100).max(2400).default(780),
  hitstopMs: z.number().min(0).max(250).default(55),
  screenShakePx: z.number().min(0).max(24).default(5),
  knockbackPx: z.number().min(0).max(400).default(110),
  flashDurationMs: z.number().min(0).max(500).default(120),
  attackDamage: z.number().int().min(1).max(999).default(12),
});
export type PlaytestJuiceConfig = z.infer<typeof PlaytestJuiceConfigSchema>;

export function createDefaultPlaytestJuiceConfig(
  overrides: Partial<PlaytestJuiceConfig> = {},
): PlaytestJuiceConfig {
  return PlaytestJuiceConfigSchema.parse(overrides);
}

export interface PlaytestInputState {
  readonly left: boolean;
  readonly right: boolean;
  readonly up: boolean;
  readonly down: boolean;
  readonly jumpPressed: boolean;
  readonly attackPressed: boolean;
}

export function createEmptyPlaytestInput(): PlaytestInputState {
  return {
    left: false,
    right: false,
    up: false,
    down: false,
    jumpPressed: false,
    attackPressed: false,
  };
}

export interface PlaytestEvent {
  readonly kind: 'play-sfx' | 'spawn-vfx' | 'damage-number';
  readonly cueName?: string;
  readonly x: number;
  readonly y: number;
  readonly value?: number;
}

export interface PlaytestAabb {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

export interface PlaytestClipMeta {
  readonly name: string;
  readonly fps: number;
  readonly frameCount: number;
  readonly loop: boolean;
  readonly activeFrames?: readonly number[];
  readonly frameAudioTriggers?: Readonly<Record<string, string>>;
}

export interface PlaytestEntityMeta {
  readonly clips: readonly PlaytestClipMeta[];
  readonly colliderBox: PlaytestAabb;
  readonly hurtbox: PlaytestAabb;
  readonly hitbox: PlaytestAabb;
  readonly hitboxActiveFrames: readonly number[];
  readonly stageWidth: number;
  readonly stageHeight: number;
  readonly floorY: number;
}

export interface PlaytestActorState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly vy: number;
  readonly facing: 1 | -1;
  readonly grounded: boolean;
  readonly activeClip: string;
  readonly frameIndex: number;
  readonly frameElapsedMs: number;
  readonly attackCooldownMs: number;
  readonly hitAlreadyApplied: boolean;
}

export interface PlaytestDummyState {
  readonly x: number;
  readonly y: number;
  readonly vx: number;
  readonly hp: number;
  readonly maxHp: number;
  readonly flashRemainingMs: number;
}

export interface PlaytestWorldState {
  readonly player: PlaytestActorState;
  readonly dummy: PlaytestDummyState;
  readonly hitstopRemainingMs: number;
  readonly shakeTrauma: number;
  readonly tick: number;
}

export interface PlaytestStageBounds {
  readonly width: number;
  readonly height: number;
  readonly floorY: number;
}

export const DEFAULT_PLAYTEST_STAGE_BOUNDS: PlaytestStageBounds = {
  width: 320,
  height: 180,
  floorY: 148,
};

/**
 * Extracts a pivot-centered local AABB and active-frame indices from M16 collision shapes.
 */
export function computeAabbFromCollisionShapes(
  shapes: readonly CollisionLayerShape[] | undefined,
  layer: 'collider' | 'hurtbox' | 'hitbox',
  fallback: PlaytestAabb,
): { readonly aabb: PlaytestAabb; readonly activeFrames: readonly number[] } {
  const matching = (shapes ?? []).filter((s) => s.layer === layer && s.visible !== false);
  if (matching.length === 0) {
    return { aabb: fallback, activeFrames: layer === 'hitbox' ? [1, 2] : [] };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const activeFrameSet = new Set<number>();

  for (const shape of matching) {
    for (const f of shape.activeFrames ?? []) {
      activeFrameSet.add(f);
    }
    if (shape.capsule) {
      const cap = shape.capsule;
      const halfSpan = cap.height * 0.5 + cap.radius;
      const hw = cap.orientation === 'horizontal' ? halfSpan : cap.radius;
      const hh = cap.orientation === 'vertical' ? halfSpan : cap.radius;
      minX = Math.min(minX, cap.cx - hw);
      minY = Math.min(minY, cap.cy - hh);
      maxX = Math.max(maxX, cap.cx + hw);
      maxY = Math.max(maxY, cap.cy + hh);
    }
    for (const pt of shape.vertices) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return { aabb: fallback, activeFrames: layer === 'hitbox' ? [1, 2] : [] };
  }

  return {
    aabb: { minX, minY, maxX, maxY },
    activeFrames:
      activeFrameSet.size > 0
        ? [...activeFrameSet].sort((a, b) => a - b)
        : layer === 'hitbox'
          ? [1, 2]
          : [],
  };
}

/**
 * Mirrors local hitbox/hurtbox bounds cleanly across X when `facing === -1` and translates to world space.
 */
export function transformLocalAabbToWorld(
  local: PlaytestAabb,
  x: number,
  y: number,
  facing: 1 | -1,
): PlaytestAabb {
  if (facing === -1) {
    return {
      minX: x - local.maxX,
      minY: y + local.minY,
      maxX: x - local.minX,
      maxY: y + local.maxY,
    };
  }
  return {
    minX: x + local.minX,
    minY: y + local.minY,
    maxX: x + local.maxX,
    maxY: y + local.maxY,
  };
}

export function aabbsOverlap(a: PlaytestAabb, b: PlaytestAabb): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function createInitialPlaytestWorld(
  config: PlaytestJuiceConfig,
  bounds: PlaytestStageBounds = DEFAULT_PLAYTEST_STAGE_BOUNDS,
): PlaytestWorldState {
  const startY = config.mode === 'top-down' ? Math.round(bounds.height * 0.56) : bounds.floorY;
  return {
    player: {
      x: Math.round(bounds.width * 0.34),
      y: startY,
      vx: 0,
      vy: 0,
      facing: 1,
      grounded: true,
      activeClip: 'idle',
      frameIndex: 0,
      frameElapsedMs: 0,
      attackCooldownMs: 0,
      hitAlreadyApplied: false,
    },
    dummy: {
      x: Math.round(bounds.width * 0.54),
      y: startY,
      vx: 0,
      hp: 100,
      maxHp: 100,
      flashRemainingMs: 0,
    },
    hitstopRemainingMs: 0,
    shakeTrauma: 0,
    tick: 0,
  };
}

export function resetPlaytestDummy(
  state: PlaytestWorldState,
  bounds: PlaytestStageBounds = DEFAULT_PLAYTEST_STAGE_BOUNDS,
  mode: PlaytestMovementMode = 'side-platformer',
): PlaytestWorldState {
  const targetY = mode === 'top-down' ? Math.round(bounds.height * 0.56) : bounds.floorY;
  return {
    ...state,
    dummy: {
      x: Math.round(bounds.width * 0.54),
      y: targetY,
      vx: 0,
      hp: state.dummy.maxHp,
      maxHp: state.dummy.maxHp,
      flashRemainingMs: 0,
    },
    hitstopRemainingMs: 0,
    shakeTrauma: 0,
  };
}

function findClipMeta(entityMeta: PlaytestEntityMeta, name: string): PlaytestClipMeta {
  const exact = entityMeta.clips.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (exact) return exact;

  if (name === 'attack') {
    const slash = entityMeta.clips.find((c) => /attack|slash|strike|swing|hit/i.test(c.name));
    if (slash) return slash;
    return { name: 'attack', fps: 12, frameCount: 4, loop: false, activeFrames: [1, 2] };
  }
  if (name === 'run') {
    const run = entityMeta.clips.find((c) => /run|walk|move/i.test(c.name));
    if (run) return run;
    return { name: 'run', fps: 10, frameCount: 4, loop: true };
  }
  if (name === 'jump') {
    const jump = entityMeta.clips.find((c) => /jump|air/i.test(c.name));
    if (jump) return jump;
    return { name: 'jump', fps: 8, frameCount: 2, loop: false };
  }

  return (
    entityMeta.clips[0] ?? {
      name: 'idle',
      fps: 8,
      frameCount: 4,
      loop: true,
    }
  );
}

/**
 * Steps the deterministic 60 Hz mini-playtest world simulation by `dtMs` milliseconds:
 * 1. Enforces hitstop freeze-frame pause while decaying camera trauma.
 * 2. Integrates movement (`side-platformer` gravity/jump or `top-down` 8-way motion) & facing.
 * 3. Advances animation clips and emits M25 `frameAudioTriggers`.
 * 4. Evaluates M16 Hitbox vs Dummy Hurtbox strictly on active attack frames once per swing.
 * 5. Integrates dummy knockback friction and decays hit-flash / shake timers.
 */
export function stepPlaytestSimulation(
  state: PlaytestWorldState,
  input: PlaytestInputState,
  entityMeta: PlaytestEntityMeta,
  config: PlaytestJuiceConfig,
  dtMs: number,
): { readonly nextState: PlaytestWorldState; readonly events: readonly PlaytestEvent[] } {
  const safeDtMs = Math.max(0, Number.isFinite(dtMs) ? dtMs : 0);
  const dtSec = safeDtMs / 1000;
  const events: PlaytestEvent[] = [];

  // 1. Hitstop freeze: suspend player/dummy integration while countdown drains
  if (state.hitstopRemainingMs > 0) {
    return {
      nextState: {
        ...state,
        hitstopRemainingMs: Math.max(0, state.hitstopRemainingMs - safeDtMs),
        shakeTrauma: Math.max(0, state.shakeTrauma - dtSec * 3.5),
        tick: state.tick + 1,
      },
      events,
    };
  }

  let {
    x,
    y,
    vx,
    vy,
    facing,
    grounded,
    activeClip,
    frameIndex,
    frameElapsedMs,
    attackCooldownMs,
    hitAlreadyApplied,
  } = state.player;

  attackCooldownMs = Math.max(0, attackCooldownMs - safeDtMs);

  // 2. Movement & Facing Integration
  const moveX = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  if (moveX !== 0) {
    facing = moveX > 0 ? 1 : -1;
  }

  if (config.mode === 'top-down') {
    const moveY = (input.down ? 1 : 0) - (input.up ? 1 : 0);
    const len = Math.hypot(moveX, moveY);
    if (len > 0) {
      vx = (moveX / len) * config.moveSpeedPx;
      vy = (moveY / len) * config.moveSpeedPx;
    } else {
      vx = 0;
      vy = 0;
    }
    x = Math.max(16, Math.min(entityMeta.stageWidth - 16, x + vx * dtSec));
    y = Math.max(24, Math.min(entityMeta.stageHeight - 16, y + vy * dtSec));
    grounded = true;
  } else {
    vx = moveX * config.moveSpeedPx;
    const wantsJump = input.jumpPressed || input.up;
    if (wantsJump && grounded) {
      vy = config.jumpVelocityPx;
      grounded = false;
    }
    vy += config.gravityPx * dtSec;
    x = Math.max(16, Math.min(entityMeta.stageWidth - 16, x + vx * dtSec));
    y += vy * dtSec;
    if (y >= entityMeta.floorY) {
      y = entityMeta.floorY;
      vy = 0;
      grounded = true;
    }
  }

  // 3. Attack Trigger & Clip Switching
  let clipJustStarted = false;
  if (input.attackPressed && activeClip !== 'attack' && attackCooldownMs <= 0) {
    activeClip = 'attack';
    frameIndex = 0;
    frameElapsedMs = 0;
    hitAlreadyApplied = false;
    clipJustStarted = true;
  } else if (activeClip !== 'attack') {
    const desiredClip = !grounded
      ? 'jump'
      : Math.abs(vx) > 1 || (config.mode === 'top-down' && Math.abs(vy) > 1)
        ? 'run'
        : 'idle';
    if (desiredClip !== activeClip) {
      activeClip = desiredClip;
      frameIndex = 0;
      frameElapsedMs = 0;
      clipJustStarted = true;
    }
  }

  const clipMeta = findClipMeta(entityMeta, activeClip);
  const totalFrames = Math.max(1, clipMeta.frameCount);
  const frameDurationMs = 1000 / Math.max(1, clipMeta.fps);

  if (clipJustStarted) {
    const cue0 = clipMeta.frameAudioTriggers?.[String(frameIndex)];
    if (cue0) {
      events.push({ kind: 'play-sfx', cueName: cue0, x, y });
    }
  }

  frameElapsedMs += safeDtMs;
  while (frameElapsedMs >= frameDurationMs) {
    frameElapsedMs -= frameDurationMs;
    const nextIdx = frameIndex + 1;
    if (nextIdx >= totalFrames) {
      if (activeClip === 'attack') {
        activeClip = !grounded
          ? 'jump'
          : Math.abs(vx) > 1 || (config.mode === 'top-down' && Math.abs(vy) > 1)
            ? 'run'
            : 'idle';
        frameIndex = 0;
        frameElapsedMs = 0;
        attackCooldownMs = 120;
        hitAlreadyApplied = false;
        break;
      } else if (clipMeta.loop) {
        frameIndex = 0;
      } else {
        frameIndex = totalFrames - 1;
      }
    } else {
      frameIndex = nextIdx;
    }

    const cue = clipMeta.frameAudioTriggers?.[String(frameIndex)];
    if (cue) {
      events.push({ kind: 'play-sfx', cueName: cue, x, y });
    }
  }

  // 4. Active-Frame Hitbox Intersection vs Target Dummy Hurtbox
  let dummyX = state.dummy.x;
  let dummyVx = state.dummy.vx;
  let dummyHp = state.dummy.hp;
  let dummyFlash = state.dummy.flashRemainingMs;
  let hitstopRemainingMs = 0;
  let shakeTrauma = Math.max(0, state.shakeTrauma - dtSec * 4.5);
  let hitAppliedThisStep = false;

  if (activeClip === 'attack' && !hitAlreadyApplied) {
    const rawActive =
      clipMeta.activeFrames && clipMeta.activeFrames.length > 0
        ? clipMeta.activeFrames
        : entityMeta.hitboxActiveFrames;
    const effectiveActive = totalFrames === 1 ? [0] : rawActive.length > 0 ? rawActive : [1, 2];

    if (effectiveActive.includes(frameIndex)) {
      const worldHitbox = transformLocalAabbToWorld(entityMeta.hitbox, x, y, facing);
      const worldHurtbox = transformLocalAabbToWorld(entityMeta.hurtbox, dummyX, state.dummy.y, 1);

      if (aabbsOverlap(worldHitbox, worldHurtbox)) {
        dummyHp = Math.max(0, dummyHp - config.attackDamage);
        dummyVx = config.knockbackPx * facing;
        dummyFlash = config.flashDurationMs;
        hitstopRemainingMs = config.hitstopMs;
        shakeTrauma = 1.0;
        hitAlreadyApplied = true;
        hitAppliedThisStep = true;

        const hitMidX =
          (Math.max(worldHitbox.minX, worldHurtbox.minX) +
            Math.min(worldHitbox.maxX, worldHurtbox.maxX)) *
          0.5;
        const hitMidY =
          (Math.max(worldHitbox.minY, worldHurtbox.minY) +
            Math.min(worldHitbox.maxY, worldHurtbox.maxY)) *
          0.5;

        events.push(
          { kind: 'play-sfx', cueName: 'hit_impact', x: hitMidX, y: hitMidY },
          { kind: 'spawn-vfx', x: hitMidX, y: hitMidY },
          { kind: 'damage-number', x: dummyX, y: state.dummy.y - 28, value: config.attackDamage },
        );
      }
    }
  }

  // 5. Dummy Knockback Friction & Hit-Flash Decay
  if (!hitAppliedThisStep) {
    dummyX = Math.max(24, Math.min(entityMeta.stageWidth - 24, dummyX + dummyVx * dtSec));
    dummyVx *= Math.max(0, 1 - dtSec * 8);
    if (Math.abs(dummyVx) < 0.5) dummyVx = 0;
    dummyFlash = Math.max(0, dummyFlash - safeDtMs);
  }

  return {
    nextState: {
      player: {
        x,
        y,
        vx,
        vy,
        facing,
        grounded,
        activeClip,
        frameIndex,
        frameElapsedMs,
        attackCooldownMs,
        hitAlreadyApplied,
      },
      dummy: {
        ...state.dummy,
        x: dummyX,
        vx: dummyVx,
        hp: dummyHp,
        flashRemainingMs: dummyFlash,
      },
      hitstopRemainingMs,
      shakeTrauma,
      tick: state.tick + 1,
    },
    events,
  };
}
