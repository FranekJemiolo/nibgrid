import {
  GOLD_ITEM_ID,
  type EnemyStatBlock,
  type LootTable,
  type ProgressionCurve,
  type WeaponItem,
} from './gameDataSchemas';

/**
 * Deterministic 32-bit seeded PRNG (Mulberry32) so simulations are 100% reproducible
 * across Chromium and Node without touching `Math.random()`.
 */
export function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Applies flat armor mitigation using M36's `max(1, rawDamage - armor)` invariant.
 */
export function computeMitigatedDamage(
  rawDamage: number,
  armor: number,
  isCrit = false,
  critMultiplier = 1,
): number {
  const safeRaw = Number.isFinite(rawDamage) ? Math.max(0, rawDamage) : 0;
  const safeArmor = Number.isFinite(armor) ? Math.max(0, armor) : 0;
  const mult = isCrit ? Math.max(1, Number.isFinite(critMultiplier) ? critMultiplier : 1) : 1;
  return Math.max(1, safeRaw * mult - safeArmor);
}

export interface PlayerCombatBaseline {
  readonly maxHp: number;
  readonly armor: number;
}

export interface TtkHistogramBucket {
  readonly label: string;
  readonly minSec: number;
  readonly maxSec: number;
  readonly count: number;
}

export interface TtkSummary {
  readonly runs: number;
  readonly seed: number;
  readonly p10TtkSec: number;
  readonly p50TtkSec: number;
  readonly p90TtkSec: number;
  readonly effectiveDps: number;
  readonly playerWinRate: number;
  readonly avgPlayerHpRemainingPct: number;
  readonly histogramBuckets: readonly TtkHistogramBucket[];
  readonly warnings: readonly string[];
}

function roundMetric(val: number, digits = 3): number {
  if (!Number.isFinite(val)) return 0;
  const rounded = Number(val.toFixed(digits));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function quantileSorted(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const clamped = Math.max(0, Math.min(1, q));
  const idx = Math.min(sorted.length - 1, Math.floor(clamped * (sorted.length - 1)));
  return sorted[idx]!;
}

/**
 * Simulates `runs` seeded encounters between `playerStats + weapon` and `enemy`.
 * Uses independent per-run RNG streams so swing crit rolls stay aligned across parameter sweeps.
 */
export function simulateCombatTtk(
  playerStats: PlayerCombatBaseline,
  weapon: WeaponItem,
  enemy: EnemyStatBlock,
  opts: { readonly runs?: number; readonly seed?: number } = {},
): TtkSummary {
  const runs = Math.max(1, Math.min(25000, Math.round(opts.runs ?? 1000)));
  const seed = (opts.seed ?? 42) >>> 0;

  const playerMaxHp = Math.max(1, Number.isFinite(playerStats.maxHp) ? playerStats.maxHp : 100);
  const playerArmor = Math.max(0, Number.isFinite(playerStats.armor) ? playerStats.armor : 0);
  const enemyMaxHp = Math.max(1, enemy.maxHp);
  const playerSwingDt = 1 / Math.max(0.05, weapon.attacksPerSecond);
  const enemySwingDt = 1 / Math.max(0.05, enemy.attacksPerSecond);

  const nonCritPlayerDmg = computeMitigatedDamage(weapon.baseDamage, enemy.armor, false, 1);
  const critPlayerDmg = computeMitigatedDamage(
    weapon.baseDamage,
    enemy.armor,
    true,
    weapon.critMultiplier,
  );
  const expectedHitDmg =
    weapon.critChance * critPlayerDmg + (1 - weapon.critChance) * nonCritPlayerDmg;
  const effectiveDps = expectedHitDmg * Math.max(0.05, weapon.attacksPerSecond);
  const enemyPerHitDmg =
    enemy.attackDamage > 0 ? computeMitigatedDamage(enemy.attackDamage, playerArmor, false, 1) : 0;

  const ttks: number[] = [];
  let wins = 0;
  let totalHpRemainingPct = 0;

  for (let i = 0; i < runs; i++) {
    const rng = createMulberry32((seed ^ Math.imul(i + 1, 0x9e3779b1)) >>> 0);
    let eHp = enemyMaxHp;
    let pHp = playerMaxHp;
    let nextPlayerAt = playerSwingDt;
    let nextEnemyAt = enemySwingDt;
    let elapsed = 0;
    const maxSwings = 2000;

    for (let step = 0; step < maxSwings && eHp > 0 && pHp > 0; step++) {
      if (nextPlayerAt <= nextEnemyAt) {
        elapsed = nextPlayerAt;
        const isCrit = rng() < weapon.critChance;
        const dmg = isCrit ? critPlayerDmg : nonCritPlayerDmg;
        eHp = Math.max(0, eHp - dmg);
        nextPlayerAt += playerSwingDt;
      } else {
        elapsed = nextEnemyAt;
        if (enemyPerHitDmg > 0) {
          pHp = Math.max(0, pHp - enemyPerHitDmg);
        }
        nextEnemyAt += enemySwingDt;
      }
    }

    if (eHp <= 0) {
      wins++;
    }
    ttks.push(elapsed);
    totalHpRemainingPct += Math.max(0, Math.min(100, (pHp / playerMaxHp) * 100));
  }

  const sortedTtks = [...ttks].sort((a, b) => a - b);
  const p10TtkSec = roundMetric(quantileSorted(sortedTtks, 0.1));
  const p50TtkSec = roundMetric(quantileSorted(sortedTtks, 0.5));
  const p90TtkSec = roundMetric(quantileSorted(sortedTtks, 0.9));
  const playerWinRate = roundMetric(wins / runs, 4);
  const avgPlayerHpRemainingPct = roundMetric(totalHpRemainingPct / runs, 2);

  // Build 5 equal-width histogram buckets across [min, max]
  const minTtk = sortedTtks[0] ?? 0;
  const maxTtk = sortedTtks[sortedTtks.length - 1] ?? minTtk;
  const span = Math.max(0.25, maxTtk - minTtk);
  const bucketWidth = span / 5;
  const counts = [0, 0, 0, 0, 0];
  for (const t of sortedTtks) {
    const bIdx = Math.min(4, Math.max(0, Math.floor((t - minTtk) / bucketWidth)));
    counts[bIdx] = (counts[bIdx] ?? 0) + 1;
  }
  const histogramBuckets: TtkHistogramBucket[] = counts.map((count, idx) => {
    const lo = roundMetric(minTtk + idx * bucketWidth, 2);
    const hi = roundMetric(minTtk + (idx + 1) * bucketWidth, 2);
    return {
      label: `${lo}-${hi}s`,
      minSec: lo,
      maxSec: hi,
      count,
    };
  });

  const warnings: string[] = [];
  if (p50TtkSec > 15) {
    warnings.push(`Sponge warning: P50 TTK (${p50TtkSec.toFixed(2)}s) exceeds 15s.`);
  }
  if (playerWinRate < 0.7) {
    warnings.push(
      `One-shot / lethality risk: Player dies in ${((1 - playerWinRate) * 100).toFixed(1)}% of runs.`,
    );
  }
  if (p50TtkSec > 0 && p50TtkSec < 1) {
    warnings.push(`Trivial encounter: P50 TTK (${p50TtkSec.toFixed(2)}s) is under 1.0s.`);
  }

  return {
    runs,
    seed,
    p10TtkSec,
    p50TtkSec,
    p90TtkSec,
    effectiveDps: roundMetric(effectiveDps, 2),
    playerWinRate,
    avgPlayerHpRemainingPct,
    histogramBuckets,
    warnings,
  };
}

export interface LootDropMetrics {
  readonly itemId: string;
  readonly displayName: string;
  readonly totalQtyDropped: number;
  readonly empiricalDropRate: number;
  readonly expectedQtyPerKill: number;
  readonly killsToAcquireP50: number;
  readonly killsToAcquireP90: number;
}

export interface LootEconomyReport {
  readonly lootTableId: string;
  readonly runs: number;
  readonly seed: number;
  readonly expectedGoldPerKill: number;
  readonly entries: readonly LootDropMetrics[];
}

function geometricKillsForQuantile(perKillSuccessProb: number, targetConfidence: number): number {
  if (perKillSuccessProb <= 0) return 0;
  if (perKillSuccessProb >= 1) return 1;
  return Math.max(1, Math.ceil(Math.log(1 - targetConfidence) / Math.log(1 - perKillSuccessProb)));
}

/**
 * Samples weighted `lootTable` drops over `runs` deterministic Mulberry32 kills.
 */
export function simulateLootEconomy(
  lootTable: LootTable,
  itemsById: ReadonlyMap<string, WeaponItem>,
  opts: { readonly runs?: number; readonly seed?: number } = {},
): LootEconomyReport {
  const runs = Math.max(1, Math.min(25000, Math.round(opts.runs ?? 1000)));
  const seed = (opts.seed ?? 42) >>> 0;
  const rng = createMulberry32(seed);

  const totalWeight = lootTable.entries.reduce((sum, e) => sum + Math.max(0, e.weight), 0);
  const cumulativeWeights: number[] = [];
  let running = 0;
  for (const entry of lootTable.entries) {
    running += Math.max(0, entry.weight);
    cumulativeWeights.push(running);
  }

  const qtyByItem = new Map<string, number>();
  const killsWithItem = new Map<string, number>();
  let totalGoldValue = 0;

  for (let k = 0; k < runs; k++) {
    const seenThisKill = new Set<string>();
    for (let r = 0; r < lootTable.rolls; r++) {
      const pick = rng() * Math.max(1e-9, totalWeight);
      let chosenIdx = lootTable.entries.length - 1;
      for (let ei = 0; ei < cumulativeWeights.length; ei++) {
        if (pick < cumulativeWeights[ei]!) {
          chosenIdx = ei;
          break;
        }
      }
      const chosen = lootTable.entries[chosenIdx]!;
      const lo = Math.min(chosen.minQty, chosen.maxQty);
      const hi = Math.max(chosen.minQty, chosen.maxQty);
      const qty = lo + Math.floor(rng() * (hi - lo + 1));

      qtyByItem.set(chosen.itemId, (qtyByItem.get(chosen.itemId) ?? 0) + qty);
      seenThisKill.add(chosen.itemId);

      if (chosen.itemId === GOLD_ITEM_ID) {
        totalGoldValue += qty;
      } else {
        const item = itemsById.get(chosen.itemId);
        if (item) {
          totalGoldValue += item.goldValue * qty;
        }
      }
    }
    for (const itemId of seenThisKill) {
      killsWithItem.set(itemId, (killsWithItem.get(itemId) ?? 0) + 1);
    }
  }

  const seenEntryIds = new Set<string>();
  const entries: LootDropMetrics[] = [];
  for (const entry of lootTable.entries) {
    if (seenEntryIds.has(entry.itemId)) continue;
    seenEntryIds.add(entry.itemId);
    const totalQtyDropped = qtyByItem.get(entry.itemId) ?? 0;
    const hitKills = killsWithItem.get(entry.itemId) ?? 0;
    const empiricalDropRate = roundMetric(hitKills / runs, 4);
    const expectedQtyPerKill = roundMetric(totalQtyDropped / runs, 4);
    const displayName =
      entry.itemId === GOLD_ITEM_ID
        ? 'Gold Coins'
        : (itemsById.get(entry.itemId)?.displayName ?? entry.itemId);

    entries.push({
      itemId: entry.itemId,
      displayName,
      totalQtyDropped,
      empiricalDropRate,
      expectedQtyPerKill,
      killsToAcquireP50:
        entry.itemId === GOLD_ITEM_ID ? 1 : geometricKillsForQuantile(empiricalDropRate, 0.5),
      killsToAcquireP90:
        entry.itemId === GOLD_ITEM_ID ? 1 : geometricKillsForQuantile(empiricalDropRate, 0.9),
    });
  }

  return {
    lootTableId: lootTable.id,
    runs,
    seed,
    expectedGoldPerKill: roundMetric(totalGoldValue / runs, 2),
    entries,
  };
}

export interface LevelSnapshot {
  readonly level: number;
  readonly xpToNext: number;
  readonly cumulativeXp: number;
  readonly bonusHp: number;
  readonly bonusDamage: number;
  readonly killsToNext: number;
}

/**
 * Evaluates per-level XP thresholds, cumulative totals, and benchmark kills required.
 */
export function evaluateProgressionCurve(
  curve: ProgressionCurve,
  benchmarkEnemyXp = 28,
): readonly LevelSnapshot[] {
  const safeXpPerKill = Math.max(1, Number.isFinite(benchmarkEnemyXp) ? benchmarkEnemyXp : 28);
  const snapshots: LevelSnapshot[] = [];
  let cumulativeXp = 0;

  for (let level = 1; level <= curve.maxLevel; level++) {
    const xpToNext = Math.max(1, Math.round(curve.baseXp * Math.pow(level, curve.exponent)));
    cumulativeXp += xpToNext;
    snapshots.push({
      level,
      xpToNext,
      cumulativeXp,
      bonusHp: roundMetric((level - 1) * curve.hpPerLevel, 2),
      bonusDamage: roundMetric((level - 1) * curve.damagePerLevel, 2),
      killsToNext: Math.max(1, Math.ceil(xpToNext / safeXpPerKill)),
    });
  }

  return snapshots;
}
