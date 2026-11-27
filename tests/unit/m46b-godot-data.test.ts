import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createDefaultGameDataRegistry } from '../../src/data/gameDataSchemas';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import {
  exportEnemyTres,
  exportLootTableTres,
  exportResourceSchemaGd,
  exportWeaponTres,
  toPlaytestCombatPatch,
} from '../../src/export/godotDataExporter';
import { collectProjectGodotSyncFiles } from '../../src/sync/fsaaSyncEngine';

describe('M46B: Godot 4 Typed Resource .gd / .tres Exporter & M25 Sync', () => {
  it('emits valid Resource schema scripts for weapon, enemy, and loot_table', () => {
    const weaponGd = exportResourceSchemaGd('weapon');
    const enemyGd = exportResourceSchemaGd('enemy');
    const lootGd = exportResourceSchemaGd('loot_table');

    expect(weaponGd).toContain('extends Resource');
    expect(weaponGd).toContain('class_name WeaponItemData');
    expect(weaponGd).toContain('@export var base_damage: float = 10.0');
    expect(enemyGd).toContain('class_name EnemyStatData');
    expect(enemyGd).toContain('@export var max_hp: float = 50.0');
    expect(lootGd).toContain('class_name LootTableData');
    expect(lootGd).toContain('@export var rolls: int = 1');
  });

  it('serializes format=3 .tres files with load_steps=2, safely escaped strings, and zero NaN', () => {
    const weaponTres = exportWeaponTres({
      id: 'iron_sword',
      displayName: 'Iron "Hero" Sword \\ MK1',
      baseDamage: 14,
      attacksPerSecond: 1.6,
      critChance: 0.15,
      critMultiplier: 2,
      goldValue: 45,
    });
    const enemyTres = exportEnemyTres({
      id: 'goblin_scout',
      displayName: 'Goblin Scout',
      maxHp: 65,
      armor: 2,
      attackDamage: 8,
      attacksPerSecond: 1.1,
      xpReward: 28,
      lootTableId: 'goblin_drops',
    });
    const lootTres = exportLootTableTres({
      id: 'goblin_drops',
      rolls: 2,
      entries: [{ itemId: 'iron_sword', weight: 10, minQty: 1, maxQty: 1 }],
    });

    expect(weaponTres).toContain(
      '[gd_resource type="Resource" script_class="WeaponItemData" load_steps=2 format=3]',
    );
    expect(weaponTres).toContain('display_name = "Iron \\"Hero\\" Sword \\\\ MK1"');
    expect(weaponTres).toContain('base_damage = 14.0');
    expect(weaponTres).toContain('attacks_per_second = 1.6');
    expect(weaponTres).toContain('gold_value = 45');

    expect(enemyTres).toContain(
      '[gd_resource type="Resource" script_class="EnemyStatData" load_steps=2 format=3]',
    );
    expect(enemyTres).toContain('max_hp = 65.0');
    expect(enemyTres).toContain('loot_table_id = "goblin_drops"');

    expect(lootTres).toContain('script_class="LootTableData" load_steps=2 format=3');
    expect(weaponTres + enemyTres + lootTres).not.toContain('NaN');
    expect(weaponTres + enemyTres + lootTres).not.toContain('undefined');
  });

  it('persists GameDataRegistry atomically in Dexie and emits .gd/.tres files in collectProjectGodotSyncFiles', async () => {
    const testDb = new NibgridDatabase(`m46b-test-${Date.now()}-${Math.random()}`);
    const repo = new NibgridRepository(testDb);
    try {
      const project = await repo.createProject('M46B Data Sync');
      const registry = createDefaultGameDataRegistry(project.id);
      const saved = await repo.saveGameDataRegistry(registry);

      expect(saved.items.length).toBeGreaterThanOrEqual(3);
      expect(await findOrphanBlobIds(testDb)).toEqual([]);

      const files = await collectProjectGodotSyncFiles(testDb, project, [], [], []);
      const byPath = new Map(files.map((f) => [f.relativePath, f]));

      expect(byPath.has('data/schemas/WeaponItemData.gd')).toBe(true);
      expect(byPath.has('data/schemas/EnemyStatData.gd')).toBe(true);
      expect(byPath.has('data/schemas/LootTableData.gd')).toBe(true);
      expect(byPath.has('data/items/iron_sword.tres')).toBe(true);
      expect(byPath.has('data/enemies/goblin_scout.tres')).toBe(true);
      expect(byPath.has('data/loot/goblin_drops.tres')).toBe(true);
      expect(byPath.has('data/progression_curves.json')).toBe(true);

      const patch = toPlaytestCombatPatch(registry.items[0]!, registry.enemies[0]!);
      expect(patch.attackDamage).toBe(14);
      expect(patch.dummyMaxHp).toBe(65);
    } finally {
      testDb.close();
      await testDb.delete();
    }
  });
});
