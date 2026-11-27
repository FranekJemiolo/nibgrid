import { z } from 'zod';

export const GOLD_ITEM_ID = '__gold__' as const;

export function sanitizeDataId(raw: string, fallback = 'entry'): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : fallback;
}

export const WeaponItemSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1),
  baseDamage: z.number().finite().min(0),
  attacksPerSecond: z.number().finite().gt(0),
  critChance: z.number().finite().min(0).max(1),
  critMultiplier: z.number().finite().min(1),
  goldValue: z.number().finite().min(0),
  iconAssetId: z.string().min(1).optional(),
});
export type WeaponItem = z.infer<typeof WeaponItemSchema>;

export const EnemyStatBlockSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).optional(),
  entityId: z.string().min(1).optional(),
  maxHp: z.number().finite().gt(0),
  armor: z.number().finite().min(0),
  attackDamage: z.number().finite().min(0),
  attacksPerSecond: z.number().finite().gt(0),
  xpReward: z.number().finite().min(0),
  lootTableId: z.string().min(1).optional(),
});
export type EnemyStatBlock = z.infer<typeof EnemyStatBlockSchema>;

export const LootTableEntrySchema = z.object({
  itemId: z.string().min(1),
  weight: z.number().finite().gt(0),
  minQty: z.number().int().min(1),
  maxQty: z.number().int().min(1),
});
export type LootTableEntry = z.infer<typeof LootTableEntrySchema>;

export const LootTableSchema = z.object({
  id: z.string().min(1),
  rolls: z.number().int().min(1),
  entries: z.array(LootTableEntrySchema).min(1),
});
export type LootTable = z.infer<typeof LootTableSchema>;

export const ProgressionCurveSchema = z.object({
  id: z.string().min(1),
  maxLevel: z.number().int().min(1).max(100),
  baseXp: z.number().finite().gt(0),
  exponent: z.number().finite().min(1),
  hpPerLevel: z.number().finite().min(0),
  damagePerLevel: z.number().finite().min(0),
});
export type ProgressionCurve = z.infer<typeof ProgressionCurveSchema>;

export const GameDataRegistrySchema = z.object({
  projectId: z.string().min(1),
  schemaVersion: z.literal(1).default(1),
  items: z.array(WeaponItemSchema),
  enemies: z.array(EnemyStatBlockSchema),
  lootTables: z.array(LootTableSchema),
  progressionCurves: z.array(ProgressionCurveSchema),
  updatedAt: z.number().int().nonnegative(),
});
export type GameDataRegistry = z.infer<typeof GameDataRegistrySchema>;

export interface GameDataValidationResult {
  readonly ok: boolean;
  readonly errors: readonly string[];
}

export function createDefaultGameDataRegistry(projectId: string): GameDataRegistry {
  return GameDataRegistrySchema.parse({
    projectId,
    schemaVersion: 1,
    items: [
      {
        id: 'iron_sword',
        displayName: 'Iron Sword',
        baseDamage: 14,
        attacksPerSecond: 1.6,
        critChance: 0.15,
        critMultiplier: 2.0,
        goldValue: 45,
      },
      {
        id: 'steel_dagger',
        displayName: 'Steel Dagger',
        baseDamage: 9,
        attacksPerSecond: 2.5,
        critChance: 0.28,
        critMultiplier: 2.2,
        goldValue: 35,
      },
      {
        id: 'obsidian_relic',
        displayName: 'Obsidian Relic',
        baseDamage: 26,
        attacksPerSecond: 1.1,
        critChance: 0.12,
        critMultiplier: 2.5,
        goldValue: 180,
      },
    ],
    enemies: [
      {
        id: 'goblin_scout',
        displayName: 'Goblin Scout',
        maxHp: 65,
        armor: 2,
        attackDamage: 8,
        attacksPerSecond: 1.1,
        xpReward: 28,
        lootTableId: 'goblin_drops',
      },
      {
        id: 'stone_golem',
        displayName: 'Stone Golem',
        maxHp: 180,
        armor: 6,
        attackDamage: 16,
        attacksPerSecond: 0.7,
        xpReward: 95,
        lootTableId: 'goblin_drops',
      },
    ],
    lootTables: [
      {
        id: 'goblin_drops',
        rolls: 2,
        entries: [
          { itemId: GOLD_ITEM_ID, weight: 70, minQty: 4, maxQty: 12 },
          { itemId: 'steel_dagger', weight: 22, minQty: 1, maxQty: 1 },
          { itemId: 'obsidian_relic', weight: 8, minQty: 1, maxQty: 1 },
        ],
      },
    ],
    progressionCurves: [
      {
        id: 'hero_standard',
        maxLevel: 20,
        baseXp: 100,
        exponent: 1.45,
        hpPerLevel: 12,
        damagePerLevel: 2,
      },
    ],
    updatedAt: Date.now(),
  });
}

function collectDuplicateIds(ids: readonly string[], label: string, errors: string[]): Set<string> {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      errors.push(`Duplicate ${label} id "${id}".`);
    } else {
      seen.add(id);
    }
  }
  return seen;
}

/**
 * Validates Zod schema constraints AND referential integrity across items,
 * enemies, loot tables, quantity ranges, and progression curves.
 */
export function validateGameDataRegistry(input: unknown): GameDataValidationResult {
  const parsed = GameDataRegistrySchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`,
      ),
    };
  }

  const registry = parsed.data;
  const errors: string[] = [];

  const itemIds = collectDuplicateIds(
    registry.items.map((i) => i.id),
    'item',
    errors,
  );
  collectDuplicateIds(
    registry.enemies.map((e) => e.id),
    'enemy',
    errors,
  );
  const lootIds = collectDuplicateIds(
    registry.lootTables.map((l) => l.id),
    'loot table',
    errors,
  );
  collectDuplicateIds(
    registry.progressionCurves.map((c) => c.id),
    'progression curve',
    errors,
  );

  for (const table of registry.lootTables) {
    for (const entry of table.entries) {
      if (entry.minQty > entry.maxQty) {
        errors.push(
          `LootTable "${table.id}" entry "${entry.itemId}" has minQty (${entry.minQty}) > maxQty (${entry.maxQty}).`,
        );
      }
      if (entry.itemId !== GOLD_ITEM_ID && !itemIds.has(entry.itemId)) {
        errors.push(`LootTable "${table.id}" references missing itemId "${entry.itemId}".`);
      }
    }
  }

  for (const enemy of registry.enemies) {
    if (enemy.lootTableId && !lootIds.has(enemy.lootTableId)) {
      errors.push(`Enemy "${enemy.id}" references missing lootTableId "${enemy.lootTableId}".`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
  };
}

export function serializeGameDataJson(registry: GameDataRegistry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

function escapeCsvCell(value: string | number): string {
  const raw = String(value);
  return /[",\n\r]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw;
}

export function serializeItemsCsv(items: readonly WeaponItem[]): string {
  const header = 'id,displayName,baseDamage,attacksPerSecond,critChance,critMultiplier,goldValue';
  const rows = items.map((item) =>
    [
      item.id,
      item.displayName,
      item.baseDamage,
      item.attacksPerSecond,
      item.critChance,
      item.critMultiplier,
      item.goldValue,
    ]
      .map(escapeCsvCell)
      .join(','),
  );
  return [header, ...rows, ''].join('\n');
}
