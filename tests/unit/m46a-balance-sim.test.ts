import { describe, expect, it } from 'vitest';
import {
  evaluateProgressionCurve,
  simulateCombatTtk,
  simulateLootEconomy,
} from '../../src/data/balanceSimulator';
import {
  createDefaultGameDataRegistry,
  validateGameDataRegistry,
  type EnemyStatBlock,
  type WeaponItem,
} from '../../src/data/gameDataSchemas';

describe('M46A: Game Data Registry Validator & Seeded Monte Carlo Simulator', () => {
  it('produces byte-identical TTK and loot economy distributions for identical seeds', () => {
    const registry = createDefaultGameDataRegistry('proj-m46a');
    const sword = registry.items[0]!;
    const goblin = registry.enemies[0]!;
    const lootTable = registry.lootTables[0]!;
    const itemsById = new Map(registry.items.map((item) => [item.id, item]));

    const ttk1 = simulateCombatTtk({ maxHp: 100, armor: 2 }, sword, goblin, {
      runs: 500,
      seed: 42,
    });
    const ttk2 = simulateCombatTtk({ maxHp: 100, armor: 2 }, sword, goblin, {
      runs: 500,
      seed: 42,
    });
    expect(ttk1).toEqual(ttk2);
    expect(ttk1.p10TtkSec).toBeLessThanOrEqual(ttk1.p50TtkSec);
    expect(ttk1.p50TtkSec).toBeLessThanOrEqual(ttk1.p90TtkSec);
    expect(ttk1.effectiveDps).toBeGreaterThan(0);

    const econ1 = simulateLootEconomy(lootTable, itemsById, { runs: 500, seed: 42 });
    const econ2 = simulateLootEconomy(lootTable, itemsById, { runs: 500, seed: 42 });
    expect(econ1).toEqual(econ2);
    expect(econ1.expectedGoldPerKill).toBeGreaterThan(0);
  });

  it('guarantees monotonic TTK reduction as weapon baseDamage increases and surfaces balance warnings', () => {
    const enemy: EnemyStatBlock = {
      id: 'armored_brute',
      maxHp: 300,
      armor: 10,
      attackDamage: 40,
      attacksPerSecond: 1.0,
      xpReward: 120,
    };

    let prevP50 = Number.POSITIVE_INFINITY;
    for (const dmg of [6, 18, 35, 70]) {
      const weapon: WeaponItem = {
        id: `w_${dmg}`,
        displayName: `Blade ${dmg}`,
        baseDamage: dmg,
        attacksPerSecond: 1.5,
        critChance: 0.2,
        critMultiplier: 2.0,
        goldValue: 50,
      };
      const sim = simulateCombatTtk({ maxHp: 100, armor: 0 }, weapon, enemy, {
        runs: 400,
        seed: 77,
      });
      expect(Number.isFinite(sim.p10TtkSec)).toBe(true);
      expect(Number.isFinite(sim.p50TtkSec)).toBe(true);
      expect(Number.isFinite(sim.p90TtkSec)).toBe(true);
      expect(sim.p50TtkSec).toBeLessThanOrEqual(prevP50);
      prevP50 = sim.p50TtkSec;
    }

    const spongeWeapon: WeaponItem = {
      id: 'twig',
      displayName: 'Twig',
      baseDamage: 1,
      attacksPerSecond: 1.0,
      critChance: 0,
      critMultiplier: 1.0,
      goldValue: 1,
    };
    const spongeSim = simulateCombatTtk(
      { maxHp: 500, armor: 100 },
      spongeWeapon,
      { ...enemy, attackDamage: 1 },
      { runs: 100, seed: 9 },
    );
    expect(spongeSim.warnings.some((w) => w.includes('Sponge warning'))).toBe(true);

    const lethalSim = simulateCombatTtk({ maxHp: 50, armor: 0 }, spongeWeapon, enemy, {
      runs: 100,
      seed: 9,
    });
    expect(lethalSim.warnings.some((w) => w.includes('One-shot / lethality risk'))).toBe(true);
  });

  it('rejects dangling loot itemIds, missing enemy loot tables, duplicate IDs, and minQty > maxQty', () => {
    const base = createDefaultGameDataRegistry('proj-val');
    expect(validateGameDataRegistry(base)).toEqual({ ok: true, errors: [] });

    const broken = {
      ...base,
      items: [...base.items, { ...base.items[0]!, id: 'iron_sword' }],
      enemies: [{ ...base.enemies[0]!, lootTableId: 'nonexistent_table' }],
      lootTables: [
        {
          id: 'broken_table',
          rolls: 1,
          entries: [{ itemId: 'ghost_axe', weight: 10, minQty: 5, maxQty: 2 }],
        },
      ],
    };

    const res = validateGameDataRegistry(broken);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes('Duplicate item id'))).toBe(true);
    expect(res.errors.some((e) => e.includes('missing lootTableId "nonexistent_table"'))).toBe(
      true,
    );
    expect(res.errors.some((e) => e.includes('missing itemId "ghost_axe"'))).toBe(true);
    expect(res.errors.some((e) => e.includes('minQty (5) > maxQty (2)'))).toBe(true);
  });

  it('evaluates deterministic XP progression curves and kills-to-level', () => {
    const reg = createDefaultGameDataRegistry('proj-xp');
    const levels = evaluateProgressionCurve(reg.progressionCurves[0]!, 25);
    expect(levels).toHaveLength(20);
    expect(levels[0]).toEqual({
      level: 1,
      xpToNext: 100,
      cumulativeXp: 100,
      bonusHp: 0,
      bonusDamage: 0,
      killsToNext: 4,
    });
    expect(levels[1]!.xpToNext).toBe(Math.round(100 * Math.pow(2, 1.45)));
    expect(levels[1]!.cumulativeXp).toBe(100 + levels[1]!.xpToNext);
  });
});
