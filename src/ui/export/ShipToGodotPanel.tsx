import { useMemo, useState } from 'react';
import { FolderSync, Gamepad2, Plug, Rocket } from 'lucide-react';
import { db } from '../../db/database';
import { GAMEKIT_TEMPLATES, type GameKitTemplateId } from '../../export/godotGameKitExporter';
import { createDefaultProjectNarrative } from '../../narrative/dialogueSchemas';
import { useAppStore } from '../../store/useAppStore';
import {
  bindGodotDirectory,
  collectProjectGodotSyncFiles,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';
import { FixItCardList } from '../audit/FixItCardList';
import { buildFixItCards } from '../audit/fixItEngine';
import { ContextualInspector } from '../layout/ContextualInspector';

/**
 * Milestones 49–50 Workspace 4: Ship to Godot panel hosting GameKit Template selection
 * (`side-platformer`, `top-down-action`, `cozy-rpg`), `addons/nibgrid_sync` EditorPlugin export,
 * Pre-Flight Fix-It Cards, and Contextual Creator/Pro Presets.
 */
export function ShipToGodotPanel() {
  const {
    activeProject,
    entities,
    spriteNodes,
    audioAssets,
    rooms,
    worldGraph,
    narrativeBundle,
    syncTarget,
    refreshSyncTarget,
  } = useAppStore();

  const [selectedTemplate, setSelectedTemplate] = useState<GameKitTemplateId>('side-platformer');
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const effectiveBundle = useMemo(
    () =>
      narrativeBundle ?? (activeProject ? createDefaultProjectNarrative(activeProject.id) : null),
    [narrativeBundle, activeProject],
  );

  const fixItCards = useMemo(() => {
    if (!activeProject) return [];
    return buildFixItCards({
      narrativeBundle: effectiveBundle,
      worldGraph,
      paletteHex: activeProject.artBible.palette,
    });
  }, [activeProject, effectiveBundle, worldGraph]);

  const handleSync = async (withGameKit: boolean) => {
    if (!activeProject) return;
    setIsSyncing(true);
    setErrorMsg(null);
    try {
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
        withGameKit ? { gameKitTemplate: selectedTemplate } : undefined,
      );
      const summary = await syncFilesToGodotDirectory(db, activeProject.id, files);
      await refreshSyncTarget(activeProject.id);
      setStatusNotice(
        withGameKit
          ? `Synced Turnkey GameKit (${selectedTemplate}) + addons/nibgrid_sync to Godot res:// (${summary.writtenCount} written, ${summary.plan.unchangedPaths.length} unchanged).`
          : `Synced project assets to Godot res:// (${summary.writtenCount} written, ${summary.plan.unchangedPaths.length} unchanged).`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to sync project to Godot.');
    } finally {
      setIsSyncing(false);
    }
  };

  if (!activeProject) {
    return (
      <div className="p-6 text-sm text-slate-400" data-testid="ship-godot-panel">
        Open a project to configure your turnkey Godot 4 GameKit and live res:// sync.
      </div>
    );
  }

  return (
    <div data-testid="ship-godot-panel" className="flex flex-1 flex-col gap-4 p-4 text-slate-100">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-3">
        <div className="flex items-center gap-2.5">
          <Rocket className="h-4 w-4 text-emerald-400" />
          <div>
            <h2 className="text-sm font-semibold text-white">Ship to Godot 4 · Turnkey GameKit</h2>
            <p className="text-[11px] text-slate-400">
              Export F5-ready project.godot, main.tscn, composable entity prefabs &amp;
              addons/nibgrid_sync.
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="ship-sync-res-btn"
            disabled={isSyncing}
            onClick={() => void handleSync(false)}
            className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500 disabled:opacity-50"
          >
            <FolderSync className="h-3.5 w-3.5" />
            Sync Assets Only
          </button>
          <button
            type="button"
            data-testid="ship-sync-gamekit-btn"
            disabled={isSyncing}
            onClick={() => void handleSync(true)}
            className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Plug className="h-3.5 w-3.5" />
            {isSyncing ? 'Syncing...' : 'Sync Turnkey GameKit + Plugin to res://'}
          </button>
        </div>
      </div>

      {statusNotice && (
        <div
          data-testid="ship-status-notice"
          className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
        >
          {statusNotice}
        </div>
      )}
      {errorMsg && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {errorMsg}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <div className="flex flex-col gap-4 lg:col-span-7">
          {/* Turnkey GameKit Template Picker */}
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
            <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold tracking-wider text-slate-300 uppercase">
              <Gamepad2 className="h-3.5 w-3.5 text-indigo-400" />
              Godot 4.3+ Starter GameKit Template
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              {GAMEKIT_TEMPLATES.map((tpl) => {
                const active = selectedTemplate === tpl.id;
                return (
                  <button
                    key={tpl.id}
                    type="button"
                    data-testid={`gamekit-template-${tpl.id}`}
                    onClick={() => setSelectedTemplate(tpl.id)}
                    className={`rounded border p-2.5 text-left text-xs transition-colors ${
                      active
                        ? 'border-emerald-400 bg-emerald-500/15 text-white'
                        : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-600'
                    }`}
                  >
                    <div className="font-semibold">{tpl.label}</div>
                    <div className="mt-1 text-[11px] text-slate-400">{tpl.description}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Fix-It Cards */}
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
            <h3 className="mb-2 text-xs font-semibold tracking-wider text-slate-300 uppercase">
              Pre-Flight Fix-It Cards ({fixItCards.length})
            </h3>
            <FixItCardList cards={fixItCards} />
          </div>
        </div>

        <div className="lg:col-span-5">
          <ContextualInspector />
        </div>
      </div>
    </div>
  );
}
