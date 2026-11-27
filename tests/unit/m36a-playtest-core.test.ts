import { describe, expect, it } from 'vitest';
import {
  createDefaultPlaytestJuiceConfig,
  createEmptyPlaytestInput,
  createInitialPlaytestWorld,
  stepPlaytestSimulation,
  type PlaytestEntityMeta,
} from '../../src/processing/playtestEngineCore';

const DT_60HZ = 1000 / 60;

function makeTestMeta(): PlaytestEntityMeta {
  return {
    clips: [
      { name: 'idle', fps: 8, frameCount: 4, loop: true },
      {
        name: 'run',
        fps: 12,
        frameCount: 4,
        loop: true,
        frameAudioTriggers: { '1': 'footstep', '3': 'footstep' },
      },
      { name: 'jump', fps: 8, frameCount: 2, loop: false },
      {
        name: 'attack',
        fps: 12,
        frameCount: 4,
        loop: false,
        activeFrames: [1, 2],
        frameAudioTriggers: { '0': 'sword_whoosh' },
      },
    ],
    colliderBox: { minX: -12, minY: -28, maxX: 12, maxY: 0 },
    hurtbox: { minX: -14, minY: -30, maxX: 14, maxY: 0 },
    hitbox: { minX: 4, minY: -26, maxX: 46, maxY: -2 },
    hitboxActiveFrames: [1, 2],
    stageWidth: 320,
    stageHeight: 180,
    floorY: 148,
  };
}

describe('M36A Pure-TS 60 Hz Fixed-Timestep Playtest Simulation Core', () => {
  it('integrates 60 frames of side-platformer right movement + jump cleanly onto floor', () => {
    const config = createDefaultPlaytestJuiceConfig({ mode: 'side-platformer' });
    const meta = makeTestMeta();
    let world = createInitialPlaytestWorld(config, {
      width: meta.stageWidth,
      height: meta.stageHeight,
      floorY: meta.floorY,
    });
    const startX = world.player.x;

    let sawAirborne = false;
    const collectedSfx: string[] = [];

    for (let i = 0; i < 60; i++) {
      const res = stepPlaytestSimulation(
        world,
        {
          ...createEmptyPlaytestInput(),
          right: true,
          jumpPressed: i === 2,
        },
        meta,
        config,
        DT_60HZ,
      );
      world = res.nextState;
      expect(Number.isNaN(world.player.x)).toBe(false);
      expect(Number.isNaN(world.player.y)).toBe(false);
      if (!world.player.grounded) {
        sawAirborne = true;
      }
      for (const ev of res.events) {
        if (ev.kind === 'play-sfx' && ev.cueName) collectedSfx.push(ev.cueName);
      }
    }

    expect(world.player.x).toBeGreaterThan(startX + 100);
    expect(sawAirborne).toBe(true);
    expect(world.player.grounded).toBe(true);
    expect(world.player.y).toBe(meta.floorY);
  });

  it('normalizes 8-way diagonal speed in top-down mode', () => {
    const config = createDefaultPlaytestJuiceConfig({
      mode: 'top-down',
      moveSpeedPx: 140,
    });
    const meta = makeTestMeta();
    const world = createInitialPlaytestWorld(config, {
      width: meta.stageWidth,
      height: meta.stageHeight,
      floorY: meta.floorY,
    });

    const { nextState } = stepPlaytestSimulation(
      world,
      {
        ...createEmptyPlaytestInput(),
        right: true,
        down: true,
      },
      meta,
      config,
      100,
    );

    const dist = Math.hypot(
      nextState.player.x - world.player.x,
      nextState.player.y - world.player.y,
    );
    expect(dist).toBeCloseTo(14, 1); // 140 px/s * 0.1s = 14 px
  });

  it('applies exact damage, knockback, hitstop, flash & single hit event per swing on active frame, then freezes during hitstop', () => {
    const config = createDefaultPlaytestJuiceConfig({
      mode: 'side-platformer',
      hitstopMs: 55,
      flashDurationMs: 120,
      knockbackPx: 110,
      attackDamage: 12,
    });
    const meta = makeTestMeta();
    let world = createInitialPlaytestWorld(config, {
      width: meta.stageWidth,
      height: meta.stageHeight,
      floorY: meta.floorY,
    });
    // Place player within hitbox reach facing Dummy on the right
    world = {
      ...world,
      player: { ...world.player, x: 140, facing: 1 },
      dummy: { ...world.dummy, x: 162, hp: 100, maxHp: 100 },
    };

    const allDamageEvents: number[] = [];
    const allSfxCues: string[] = [];
    let sawHitstopTick = false;

    for (let f = 0; f < 20; f++) {
      const prevPlayerX = world.player.x;
      const prevDummyX = world.dummy.x;
      const wasHitstopped = world.hitstopRemainingMs > 0;

      const { nextState, events } = stepPlaytestSimulation(
        world,
        {
          ...createEmptyPlaytestInput(),
          right: true,
          attackPressed: f === 0,
        },
        meta,
        config,
        DT_60HZ,
      );
      world = nextState;

      if (wasHitstopped) {
        sawHitstopTick = true;
        expect(world.player.x).toBe(prevPlayerX);
        expect(world.dummy.x).toBe(prevDummyX);
      }

      for (const ev of events) {
        if (ev.kind === 'damage-number' && ev.value !== undefined) {
          expect(world.hitstopRemainingMs).toBe(config.hitstopMs);
          expect(world.dummy.flashRemainingMs).toBe(config.flashDurationMs);
          expect(world.dummy.vx).toBe(config.knockbackPx);
          allDamageEvents.push(ev.value);
        }
        if (ev.kind === 'play-sfx' && ev.cueName) {
          allSfxCues.push(ev.cueName);
        }
      }
    }

    expect(allDamageEvents).toEqual([12]);
    expect(world.dummy.hp).toBe(88);
    expect(allSfxCues).toContain('sword_whoosh');
    expect(allSfxCues.filter((c) => c === 'hit_impact')).toHaveLength(1);
    expect(sawHitstopTick).toBe(true);
    expect(world.hitstopRemainingMs).toBe(0);
    expect(world.dummy.x).toBeGreaterThan(162);
  });

  it('mirrors hitbox when player is facing left and emits frameAudioTriggers on run footsteps', () => {
    const config = createDefaultPlaytestJuiceConfig({ mode: 'side-platformer' });
    const meta = makeTestMeta();
    let world = createInitialPlaytestWorld(config);
    world = {
      ...world,
      player: { ...world.player, x: 180, facing: -1 },
      dummy: { ...world.dummy, x: 162, hp: 100 }, // Dummy is 18px to the left of player
    };

    let hitLeftDummy = false;
    for (let f = 0; f < 10; f++) {
      const { nextState, events } = stepPlaytestSimulation(
        world,
        { ...createEmptyPlaytestInput(), attackPressed: f === 0 },
        meta,
        config,
        DT_60HZ,
      );
      world = nextState;
      if (events.some((e) => e.kind === 'damage-number')) {
        expect(world.dummy.vx).toBe(-config.knockbackPx);
        hitLeftDummy = true;
      }
    }
    expect(hitLeftDummy).toBe(true);
    expect(world.dummy.x).toBeLessThan(162);

    // Verify run cycle emits footstep cue on triggered frames
    let runWorld = createInitialPlaytestWorld(config);
    const runCues: string[] = [];
    for (let f = 0; f < 25; f++) {
      const res = stepPlaytestSimulation(
        runWorld,
        { ...createEmptyPlaytestInput(), right: true },
        meta,
        config,
        DT_60HZ,
      );
      runWorld = res.nextState;
      for (const ev of res.events) {
        if (ev.kind === 'play-sfx' && ev.cueName) runCues.push(ev.cueName);
      }
    }
    expect(runCues).toContain('footstep');
  });
});
