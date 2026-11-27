import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Coins,
  Database,
  Download,
  FolderSync,
  Gamepad2,
  Plus,
  Swords,
  Trash2,
  TrendingUp,
} from 'lucide-react';
import {
  evaluateProgressionCurve,
  simulateCombatTtk,
  simulateLootEconomy,
} from '../../data/balanceSimulator';
import {
  createDefaultGameDataRegistry,
  sanitizeDataId,
  serializeGameDataJson,
  serializeItemsCsv,
  validateGameDataRegistry,
  type EnemyStatBlock,
  type GameDataRegistry,
  type WeaponItem,
} from '../../data/gameDataSchemas';
import { db } from '../../db/database';
import { toPlaytestCombatPatch } from '../../export/godotDataExporter';
import { ensureEntityPlaytestGdScript } from '../../export/playtestStatSync';
import { triggerBlobDownload } from '../../export/zipPackager';
import { createDefaultPlaytestJuiceConfig } from '../../processing/playtestEngineCore';
import { useAppStore } from '../../store/useAppStore';
import {
  bindGodotDirectory,
  collectProjectGodotSyncFiles,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';

type DataTab = 'items' | 'enemies' | 'loot' | 'xp';

/**
 * Milestone 46C Schema-Driven Game Data Foundry & Seeded Monte Carlo Balance Lab.
 */
export function DataFoundryPanel() {
  const {
    activeProject,
    entities,
    spriteNodes,
    audioAssets,
    rooms,
    gameDataRegistry,
    syncTarget,
    saveGameDataRegistryRecord,
    saveEntityRecord,
    refreshSyncTarget,
    navigate,
  } = useAppStore();

  const activeRegistry = useMemo(
    () =>
      gameDataRegistry ?? (activeProject ? createDefaultGameDataRegistry(activeProject.id) : null),
    [gameDataRegistry, activeProject],
  );

  const [tab, setTab] = useState<DataTab>('items');
  const [newWeaponId, setNewWeaponId] = useState('');
  const [newWeaponName, setNewWeaponName] = useState('');
  const [newWeaponDamage, setNewWeaponDamage] = useState('22');
  const [newWeaponAps, setNewWeaponAps] = useState('1.5');
  const [newWeaponCrit, setNewWeaponCrit] = useState('0.2');

  const [selectedWeaponId, setSelectedWeaponId] = useState(
    () => activeRegistry?.items[0]?.id ?? '',
  );
  const [selectedEnemyId, setSelectedEnemyId] = useState(
    () => activeRegistry?.enemies[0]?.id ?? '',
  );
  const [simSeed, setSimSeed] = useState(42);
  const [simRuns, setSimRuns] = useState(1000);
  const [simVersion, setSimVersion] = useState(0);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    if (!activeRegistry) return;
    if (!selectedWeaponId || !activeRegistry.items.some((i) => i.id === selectedWeaponId)) {
      setSelectedWeaponId(activeRegistry.items[0]?.id ?? '');
    }
    if (!selectedEnemyId || !activeRegistry.enemies.some((e) => e.id === selectedEnemyId)) {
      setSelectedEnemyId(activeRegistry.enemies[0]?.id ?? '');
    }
  }, [activeRegistry, selectedWeaponId, selectedEnemyId]);

  const validation = useMemo(
    () =>
      activeRegistry
        ? validateGameDataRegistry(activeRegistry)
        : { ok: false, errors: ['Open a project to edit game data.'] },
    [activeRegistry],
  );

  const selectedWeapon = useMemo(
    () => activeRegistry?.items.find((i) => i.id === selectedWeaponId) ?? activeRegistry?.items[0],
    [activeRegistry, selectedWeaponId],
  );
  const selectedEnemy = useMemo(
    () =>
      activeRegistry?.enemies.find((e) => e.id === selectedEnemyId) ?? activeRegistry?.enemies[0],
    [activeRegistry, selectedEnemyId],
  );

  const ttkSummary = useMemo(() => {
    if (!selectedWeapon || !selectedEnemy) return null;
    void simVersion;
    return simulateCombatTtk({ maxHp: 120, armor: 2 }, selectedWeapon, selectedEnemy, {
      runs: simRuns,
      seed: simSeed,
    });
  }, [selectedWeapon, selectedEnemy, simRuns, simSeed, simVersion]);

  const lootReport = useMemo(() => {
    if (!activeRegistry || !selectedEnemy?.lootTableId) return null;
    const table = activeRegistry.lootTables.find((t) => t.id === selectedEnemy.lootTableId);
    if (!table) return null;
    const itemsById = new Map(activeRegistry.items.map((i) => [i.id, i]));
    return simulateLootEconomy(table, itemsById, { runs: simRuns, seed: simSeed });
  }, [activeRegistry, selectedEnemy, simRuns, simSeed]);

  const xpSnapshots = useMemo(() => {
    const curve = activeRegistry?.progressionCurves[0];
    if (!curve) return [];
    return evaluateProgressionCurve(curve, selectedEnemy?.xpReward ?? 28);
  }, [activeRegistry, selectedEnemy]);

  if (!activeProject || !activeRegistry) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-slate-400">
        Open a project first to author typed game data and run balance simulations.
      </div>
    );
  }

  const persistRegistry = async (next: GameDataRegistry) => {
    setErrorMsg(null);
    await saveGameDataRegistryRecord({
      ...next,
      updatedAt: Date.now(),
    });
  };

  const handleUpdateWeapon = async (id: string, patch: Partial<WeaponItem>): Promise<void> => {
    const nextItems = activeRegistry.items.map((item) =>
      item.id === id ? { ...item, ...patch } : item,
    );
    await persistRegistry({ ...activeRegistry, items: nextItems });
  };

  const handleDeleteWeapon = async (id: string) => {
    if (activeRegistry.items.length <= 1) return;
    await persistRegistry({
      ...activeRegistry,
      items: activeRegistry.items.filter((i) => i.id !== id),
    });
  };

  const handleAddWeapon = async () => {
    const rawId =
      newWeaponId.trim() || newWeaponName.trim() || `weapon_${activeRegistry.items.length + 1}`;
    const id = sanitizeDataId(rawId, `weapon_${activeRegistry.items.length + 1}`);
    if (activeRegistry.items.some((i) => i.id === id)) {
      setErrorMsg(`Item id "${id}" already exists.`);
      return;
    }
    const created: WeaponItem = {
      id,
      displayName: newWeaponName.trim() || id,
      baseDamage: Math.max(0, Number(newWeaponDamage) || 12),
      attacksPerSecond: Math.max(0.1, Number(newWeaponAps) || 1.5),
      critChance: Math.max(0, Math.min(1, Number(newWeaponCrit) || 0.15)),
      critMultiplier: 2.0,
      goldValue: 65,
    };
    await persistRegistry({
      ...activeRegistry,
      items: [...activeRegistry.items, created],
    });
    setSelectedWeaponId(created.id);
    setNewWeaponId('');
    setNewWeaponName('');
    setStatusNotice(
      `Added "${created.id}" (${created.baseDamage} dmg @ ${created.attacksPerSecond}/s).`,
    );
  };

  const handleUpdateEnemy = async (id: string, patch: Partial<EnemyStatBlock>): Promise<void> => {
    const nextEnemies = activeRegistry.enemies.map((enemy) =>
      enemy.id === id ? { ...enemy, ...patch } : enemy,
    );
    await persistRegistry({ ...activeRegistry, enemies: nextEnemies });
  };

  const handlePushToPlaytest = async () => {
    if (!selectedWeapon || !selectedEnemy) return;
    const patch = toPlaytestCombatPatch(selectedWeapon, selectedEnemy);
    const matchedEntity =
      entities.find((e) => e.id === selectedEnemy.entityId || e.slug === selectedEnemy.id) ??
      entities[0];
    if (!matchedEntity) {
      setStatusNotice(
        `Prepared M36 Playtest patch (${patch.attackDamage} dmg, ${patch.dummyMaxHp} dummy HP) — create an Entity first to live-test.`,
      );
      return;
    }

    const baseJuice = createDefaultPlaytestJuiceConfig(matchedEntity.playtestConfig);
    const updatedEntity = await saveEntityRecord({
      ...matchedEntity,
      playtestConfig: {
        ...baseJuice,
        attackDamage: patch.attackDamage,
      },
      scriptContent: ensureEntityPlaytestGdScript(matchedEntity, {
        moveSpeedPx: baseJuice.moveSpeedPx,
        attackDamage: patch.attackDamage,
      }),
      updatedAt: Date.now(),
    });
    await navigate({
      screen: 'entities',
      projectId: activeProject.id,
      playtestEntityId: updatedEntity.id,
    });
  };

  const handleSyncToGodot = async () => {
    setIsSyncing(true);
    setErrorMsg(null);
    try {
      await persistRegistry(activeRegistry);
      if (!syncTarget?.directoryHandle) {
        await bindGodotDirectory(db, activeProject.id);
      }
      const files = await collectProjectGodotSyncFiles(
        db,
        activeProject,
        entities,
        spriteNodes,
        audioAssets,
        rooms,
      );
      const summary = await syncFilesToGodotDirectory(db, activeProject.id, files);
      await refreshSyncTarget(activeProject.id);
      setStatusNotice(
        `Synced Game Data (.gd/.tres) to res:// (${summary.writtenCount} written, ${summary.plan.unchangedPaths.length} unchanged).`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to sync Game Data to Godot res://.');
    } finally {
      setIsSyncing(false);
    }
  };

  const maxHistCount = ttkSummary
    ? Math.max(1, ...ttkSummary.histogramBuckets.map((b) => b.count))
    : 1;

  return (
    <div
      data-testid="data-foundry-panel"
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-[var(--bg-well)] lg:grid-cols-[1fr_360px]"
    >
      {/* Left: Schema-Driven Data Tables */}
      <div className="flex min-h-0 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-[#F5B82E]" />
            <h2 className="text-sm font-semibold text-white">Schema-Driven Game Data Foundry</h2>
            <span
              data-testid="data-validation-status"
              className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                validation.ok
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-rose-500/20 text-rose-200'
              }`}
            >
              {validation.ok ? (
                <>
                  <CheckCircle2 className="h-3 w-3" /> Valid Registry
                </>
              ) : (
                <>
                  <AlertTriangle className="h-3 w-3" /> {validation.errors.length} Issues
                </>
              )}
            </span>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                triggerBlobDownload(
                  new Blob([serializeItemsCsv(activeRegistry.items)], { type: 'text/csv' }),
                  `${activeProject.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_items.csv`,
                )
              }
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-slate-300 hover:text-white"
            >
              <Download className="h-3 w-3" /> CSV
            </button>
            <button
              type="button"
              onClick={() =>
                triggerBlobDownload(
                  new Blob([serializeGameDataJson(activeRegistry)], {
                    type: 'application/json',
                  }),
                  `${activeProject.name.toLowerCase().replace(/[^a-z0-9]+/g, '_')}_gamedata.json`,
                )
              }
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-slate-300 hover:text-white"
            >
              <Download className="h-3 w-3" /> JSON
            </button>
          </div>
        </div>

        {/* Sub-tabs */}
        <div className="flex gap-1 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-1.5 text-xs">
          {(
            [
              ['items', `Items (${activeRegistry.items.length})`, 'data-tab-items'],
              ['enemies', `Enemies (${activeRegistry.enemies.length})`, 'data-tab-enemies'],
              ['loot', `Loot Tables (${activeRegistry.lootTables.length})`, 'data-tab-loot'],
              ['xp', 'XP Curves', 'data-tab-xp'],
            ] as const
          ).map(([id, label, testId]) => (
            <button
              key={id}
              type="button"
              data-testid={testId}
              onClick={() => setTab(id)}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                tab === id
                  ? 'bg-[#F5B82E]/20 text-[#F5B82E] ring-1 ring-[#F5B82E]/40'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {!validation.ok && (
            <div className="mb-3 rounded border border-rose-500/40 bg-rose-950/50 p-2.5 text-xs text-rose-200">
              {validation.errors.map((e) => (
                <div key={e}>{e}</div>
              ))}
            </div>
          )}

          {tab === 'items' && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3 sm:grid-cols-6">
                <input
                  type="text"
                  data-testid="data-new-weapon-id"
                  value={newWeaponId}
                  onChange={(e) => setNewWeaponId(e.target.value)}
                  placeholder="id (flame_blade)"
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-white"
                />
                <input
                  type="text"
                  data-testid="data-new-weapon-name"
                  value={newWeaponName}
                  onChange={(e) => setNewWeaponName(e.target.value)}
                  placeholder="Display Name"
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-xs text-white sm:col-span-2"
                />
                <input
                  type="number"
                  data-testid="data-new-weapon-damage"
                  value={newWeaponDamage}
                  onChange={(e) => setNewWeaponDamage(e.target.value)}
                  placeholder="DMG"
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-white"
                />
                <input
                  type="number"
                  step="0.1"
                  data-testid="data-new-weapon-aps"
                  value={newWeaponAps}
                  onChange={(e) => setNewWeaponAps(e.target.value)}
                  placeholder="APS"
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-white"
                />
                <button
                  type="button"
                  data-testid="data-add-weapon-btn"
                  onClick={() => void handleAddWeapon()}
                  className="inline-flex items-center justify-center gap-1 rounded bg-[#F5B82E] px-2.5 py-1 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
                >
                  <Plus className="h-3.5 w-3.5" /> Add Weapon
                </button>
                <input
                  type="hidden"
                  value={newWeaponCrit}
                  onChange={(e) => setNewWeaponCrit(e.target.value)}
                />
              </div>

              <div className="overflow-x-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)]">
                <table className="w-full text-left text-xs text-slate-200">
                  <thead className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[11px] text-slate-400 uppercase">
                    <tr>
                      <th className="px-3 py-2">ID</th>
                      <th className="px-3 py-2">Name</th>
                      <th className="px-3 py-2">Damage</th>
                      <th className="px-3 py-2">APS</th>
                      <th className="px-3 py-2">Crit %</th>
                      <th className="px-3 py-2">Gold</th>
                      <th className="px-3 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--border-hairline)]">
                    {activeRegistry.items.map((item) => (
                      <tr key={item.id} data-testid={`data-item-row-${item.id}`}>
                        <td className="px-3 py-2 font-mono text-[#F5B82E]">{item.id}</td>
                        <td className="px-3 py-2">
                          <input
                            type="text"
                            value={item.displayName}
                            onChange={(e) =>
                              void handleUpdateWeapon(item.id, { displayName: e.target.value })
                            }
                            className="w-36 rounded border border-transparent bg-transparent px-1.5 py-0.5 text-white hover:border-slate-700 focus:border-[#F5B82E] focus:outline-none"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono">
                          <input
                            type="number"
                            value={item.baseDamage}
                            onChange={(e) =>
                              void handleUpdateWeapon(item.id, {
                                baseDamage: Math.max(0, Number(e.target.value) || 0),
                              })
                            }
                            className="w-16 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-0.5 text-white"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono">
                          <input
                            type="number"
                            step="0.1"
                            value={item.attacksPerSecond}
                            onChange={(e) =>
                              void handleUpdateWeapon(item.id, {
                                attacksPerSecond: Math.max(0.1, Number(e.target.value) || 0.1),
                              })
                            }
                            className="w-16 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-0.5 text-white"
                          />
                        </td>
                        <td className="px-3 py-2 font-mono">
                          {Math.round(item.critChance * 100)}%
                        </td>
                        <td className="px-3 py-2 font-mono">{item.goldValue}g</td>
                        <td className="px-3 py-2 text-right">
                          <button
                            type="button"
                            onClick={() => void handleDeleteWeapon(item.id)}
                            disabled={activeRegistry.items.length <= 1}
                            className="text-slate-400 hover:text-rose-400 disabled:opacity-30"
                            aria-label={`Delete ${item.id}`}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === 'enemies' && (
            <div className="overflow-x-auto rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)]">
              <table className="w-full text-left text-xs text-slate-200">
                <thead className="border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] text-[11px] text-slate-400 uppercase">
                  <tr>
                    <th className="px-3 py-2">ID</th>
                    <th className="px-3 py-2">Max HP</th>
                    <th className="px-3 py-2">Armor</th>
                    <th className="px-3 py-2">Atk Dmg</th>
                    <th className="px-3 py-2">XP</th>
                    <th className="px-3 py-2">Loot Table</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-hairline)]">
                  {activeRegistry.enemies.map((enemy) => (
                    <tr key={enemy.id} data-testid={`data-enemy-row-${enemy.id}`}>
                      <td className="px-3 py-2 font-mono text-emerald-300">{enemy.id}</td>
                      <td className="px-3 py-2 font-mono">
                        <input
                          type="number"
                          value={enemy.maxHp}
                          onChange={(e) =>
                            void handleUpdateEnemy(enemy.id, {
                              maxHp: Math.max(1, Number(e.target.value) || 1),
                            })
                          }
                          className="w-20 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-0.5 text-white"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <input
                          type="number"
                          value={enemy.armor}
                          onChange={(e) =>
                            void handleUpdateEnemy(enemy.id, {
                              armor: Math.max(0, Number(e.target.value) || 0),
                            })
                          }
                          className="w-16 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-0.5 text-white"
                        />
                      </td>
                      <td className="px-3 py-2 font-mono">{enemy.attackDamage}</td>
                      <td className="px-3 py-2 font-mono">{enemy.xpReward} XP</td>
                      <td className="px-3 py-2 font-mono text-slate-400">
                        {enemy.lootTableId ?? 'none'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'loot' && (
            <div className="space-y-3">
              {activeRegistry.lootTables.map((lt) => (
                <div
                  key={lt.id}
                  className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3"
                >
                  <div className="mb-2 flex items-center justify-between text-xs">
                    <span className="font-mono font-semibold text-[#F5B82E]">{lt.id}</span>
                    <span className="text-slate-400">{lt.rolls} rolls per kill</span>
                  </div>
                  <div className="space-y-1 text-xs">
                    {lt.entries.map((entry) => (
                      <div
                        key={entry.itemId}
                        className="flex items-center justify-between rounded bg-[var(--bg-well)] px-2.5 py-1 font-mono text-slate-200"
                      >
                        <span>{entry.itemId}</span>
                        <span className="text-slate-400">
                          wt {entry.weight} · qty {entry.minQty}–{entry.maxQty}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'xp' && (
            <div className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-white uppercase">
                <TrendingUp className="h-3.5 w-3.5 text-sky-400" />
                Progression Curve ({xpSnapshots.length} levels)
              </h3>
              <div className="grid max-h-96 grid-cols-2 gap-1.5 overflow-y-auto text-[11px] sm:grid-cols-4">
                {xpSnapshots.map((snap) => (
                  <div
                    key={snap.level}
                    className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2 font-mono"
                  >
                    <div className="font-semibold text-[#F5B82E]">Lv {snap.level}</div>
                    <div className="text-slate-200">{snap.xpToNext} XP</div>
                    <div className="text-slate-400">{snap.killsToNext} kills</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right: Seeded Monte Carlo Balance Lab & M36/M25 Bridges */}
      <aside
        data-testid="data-balance-lab"
        className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5"
      >
        {errorMsg && (
          <div className="rounded border border-rose-500/40 bg-rose-950/60 px-2.5 py-1.5 text-[11px] text-rose-200">
            {errorMsg}
          </div>
        )}
        {statusNotice && (
          <div
            data-testid="data-status-notice"
            className="rounded border border-emerald-500/40 bg-emerald-950/40 px-2.5 py-1.5 text-[11px] text-emerald-200"
          >
            {statusNotice}
          </div>
        )}

        <section className="space-y-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-white uppercase">
              <Swords className="h-3.5 w-3.5 text-[#F5B82E]" />
              Monte Carlo Balance Lab
            </h3>
            <span className="font-mono text-[10px] text-slate-400">{simRuns} runs</span>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="space-y-0.5 text-[10px] text-slate-400">
              <span>Weapon</span>
              <select
                data-testid="balance-weapon-select"
                value={selectedWeapon?.id ?? ''}
                onChange={(e) => setSelectedWeaponId(e.target.value)}
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-1 text-xs text-white"
              >
                {activeRegistry.items.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.displayName} ({item.id})
                  </option>
                ))}
              </select>
            </label>
            <label className="space-y-0.5 text-[10px] text-slate-400">
              <span>Enemy</span>
              <select
                data-testid="balance-enemy-select"
                value={selectedEnemy?.id ?? ''}
                onChange={(e) => setSelectedEnemyId(e.target.value)}
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-1 text-xs text-white"
              >
                {activeRegistry.enemies.map((enemy) => (
                  <option key={enemy.id} value={enemy.id}>
                    {enemy.displayName ?? enemy.id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <label className="space-y-0.5 text-[10px] text-slate-400">
              <span>Seed (Mulberry32)</span>
              <input
                type="number"
                data-testid="balance-seed-input"
                value={simSeed}
                onChange={(e) => setSimSeed(Math.max(1, Number(e.target.value) || 42))}
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-white"
              />
            </label>
            <label className="space-y-0.5 text-[10px] text-slate-400">
              <span>Sim Runs</span>
              <input
                type="number"
                value={simRuns}
                min={50}
                max={10000}
                onChange={(e) =>
                  setSimRuns(Math.max(50, Math.min(10000, Number(e.target.value) || 1000)))
                }
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-white"
              />
            </label>
          </div>

          <button
            type="button"
            data-testid="balance-run-sim-btn"
            onClick={() => setSimVersion((v) => v + 1)}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            <Activity className="h-3.5 w-3.5" />
            Run Monte Carlo TTK Sim
          </button>

          {ttkSummary && (
            <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2 text-xs">
              <div className="grid grid-cols-3 gap-1.5 font-mono">
                <div className="rounded bg-[var(--bg-well)] p-1.5">
                  <div className="text-[10px] text-slate-400">P50 TTK</div>
                  <div data-testid="balance-p50-ttk" className="font-semibold text-[#F5B82E]">
                    {ttkSummary.p50TtkSec.toFixed(2)}s
                  </div>
                </div>
                <div className="rounded bg-[var(--bg-well)] p-1.5">
                  <div className="text-[10px] text-slate-400">Eff. DPS</div>
                  <div data-testid="balance-effective-dps" className="font-semibold text-sky-300">
                    {ttkSummary.effectiveDps.toFixed(1)}
                  </div>
                </div>
                <div className="rounded bg-[var(--bg-well)] p-1.5">
                  <div className="text-[10px] text-slate-400">Win Rate</div>
                  <div data-testid="balance-win-rate" className="font-semibold text-emerald-300">
                    {(ttkSummary.playerWinRate * 100).toFixed(1)}%
                  </div>
                </div>
              </div>

              <div data-testid="balance-ttk-histogram" className="flex h-12 items-end gap-1 pt-1">
                {ttkSummary.histogramBuckets.map((bucket) => (
                  <div
                    key={bucket.label}
                    title={`${bucket.label}: ${bucket.count} runs`}
                    className="flex flex-1 flex-col items-center gap-0.5"
                  >
                    <div
                      className="w-full rounded-t bg-[#F5B82E]/75"
                      style={{
                        height: `${Math.max(4, Math.round((bucket.count / maxHistCount) * 34))}px`,
                      }}
                    />
                  </div>
                ))}
              </div>

              {ttkSummary.warnings.length > 0 && (
                <div className="space-y-1">
                  {ttkSummary.warnings.map((w) => (
                    <div
                      key={w}
                      className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] text-amber-200"
                    >
                      {w}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {lootReport && (
          <section className="space-y-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3 text-[11px]">
            <div className="flex items-center justify-between font-semibold text-white">
              <span className="flex items-center gap-1 uppercase">
                <Coins className="h-3.5 w-3.5 text-[#F5B82E]" /> Loot Economy
              </span>
              <span className="font-mono text-emerald-300">
                {lootReport.expectedGoldPerKill.toFixed(1)}g/kill
              </span>
            </div>
            {lootReport.entries.map((entry) => (
              <div
                key={entry.itemId}
                className="flex items-center justify-between font-mono text-slate-300"
              >
                <span className="truncate">{entry.displayName}</span>
                <span className="text-slate-400">
                  {(entry.empiricalDropRate * 100).toFixed(1)}% · P50 {entry.killsToAcquireP50}k
                </span>
              </div>
            ))}
          </section>
        )}

        <div className="space-y-2">
          <button
            type="button"
            data-testid="balance-push-playtest-btn"
            onClick={() => void handlePushToPlaytest()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25"
          >
            <Gamepad2 className="h-3.5 w-3.5" />
            Push to M36 Playtest
          </button>
          <button
            type="button"
            data-testid="data-sync-godot-btn"
            disabled={isSyncing}
            onClick={() => void handleSyncToGodot()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[#F5B82E]/50 bg-[#F5B82E]/15 px-3 py-1.5 text-xs font-semibold text-[#F5B82E] hover:bg-[#F5B82E]/25 disabled:opacity-45"
          >
            <FolderSync className="h-3.5 w-3.5" />
            {isSyncing ? 'Syncing Game Data...' : 'Sync .gd & .tres to Godot res://'}
          </button>
        </div>
      </aside>
    </div>
  );
}
