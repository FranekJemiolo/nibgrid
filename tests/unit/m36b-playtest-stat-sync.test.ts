import { describe, expect, it } from 'vitest';
import { validateGdScript } from '../../src/export/gdscriptGenerator';
import {
  applyPlaytestStatsToGdScript,
  computeHitFlashUniform,
  createFixedTimestepRunner,
  ensureEntityPlaytestGdScript,
} from '../../src/export/playtestStatSync';

describe('M36B Entity .gd Stat Sync, Hit-Flash Uniform & Fixed-Timestep Accumulator', () => {
  it('updates @export move_speed and attack_damage while preserving surrounding comments and functions byte-for-byte', () => {
    const original = [
      'class_name GoblinScout',
      'extends CharacterBody2D',
      '',
      '# Custom user comment preserved',
      '@export var move_speed: float = 95.0',
      '@export var max_health: int = 40',
      '@export var attack_damage: int = 12',
      '',
      'func _ready() -> void:',
      '\tprint("custom logic")',
      '',
    ].join('\n');

    const updated = applyPlaytestStatsToGdScript(original, {
      moveSpeedPx: 215.5,
      attackDamage: 24,
    });

    expect(updated).toContain('@export var move_speed: float = 215.5');
    expect(updated).toContain('@export var attack_damage: int = 24');
    expect(updated).toContain('@export var max_health: int = 40');
    expect(updated).toContain('# Custom user comment preserved');
    expect(updated).toContain('func _ready() -> void:\n\tprint("custom logic")');
    expect(validateGdScript(updated, 'CharacterBody2D').valid).toBe(true);
  });

  it('ensureEntityPlaytestGdScript generates a valid Godot 4.3+ script when none exists yet', () => {
    const generated = ensureEntityPlaytestGdScript(
      {
        slug: 'goblin_scout',
        displayName: 'Goblin Scout',
        bodyType: 'CharacterBody2D',
      },
      { moveSpeedPx: 185, attackDamage: 18 },
    );

    expect(generated).toContain('@export var move_speed: float = 185.0');
    expect(generated).toContain('@export var attack_damage: int = 18');
    expect(validateGdScript(generated, 'CharacterBody2D').valid).toBe(true);
  });

  it('computeHitFlashUniform returns 1 at impact, 0.5 halfway, and 0 when expired or invalid', () => {
    expect(computeHitFlashUniform(120, 120)).toBe(1);
    expect(computeHitFlashUniform(60, 120)).toBe(0.5);
    expect(computeHitFlashUniform(0, 120)).toBe(0);
    expect(computeHitFlashUniform(-10, 120)).toBe(0);
    expect(computeHitFlashUniform(50, 0)).toBe(0);
  });

  it('createFixedTimestepRunner caps spiral-of-death deltas and carries fractional accumulator remainder', () => {
    const runner = createFixedTimestepRunner(1000 / 60, 100);
    let stepCalls = 0;

    // 5000ms tab-background pause caps cleanly at 100ms = 6 fixed steps
    const spikeSteps = runner.advance(5000, () => {
      stepCalls++;
    });
    expect(spikeSteps).toBe(6);
    expect(stepCalls).toBe(6);

    runner.reset();
    const s1 = runner.advance(10, () => {
      stepCalls++;
    });
    expect(s1).toBe(0);

    const s2 = runner.advance(10, () => {
      stepCalls++;
    });
    expect(s2).toBe(1); // 10 + 10 = 20ms >= 16.6667ms -> 1 step with ~3.33ms remainder
  });
});
