import { Play, RotateCcw, Sliders, Square } from 'lucide-react';
import type {
  BatchDryRunSummary,
  BatchProgressEvent,
  BatchRecipeOperations,
  BatchRecipePlan,
  BatchRunResult,
} from '../../processing/batchRunner';

export interface BatchRunnerDrawerProps {
  readonly plan: BatchRecipePlan;
  readonly dryRun: BatchDryRunSummary;
  readonly isRunning: boolean;
  readonly progress: BatchProgressEvent | null;
  readonly lastRunOutcome: {
    readonly beforeScore: number;
    readonly afterScore: number;
    readonly result: BatchRunResult;
  } | null;
  readonly onChangeOperations: (patch: Partial<BatchRecipeOperations>) => void;
  readonly onChangeMode: (mode: 'in-place' | 'fork-children') => void;
  readonly onRunBatch: () => void;
  readonly onCancelBatch: () => void;
  readonly onUndoBatch: () => void;
}

export function BatchRunnerDrawer({
  plan,
  dryRun,
  isRunning,
  progress,
  lastRunOutcome,
  onChangeOperations,
  onChangeMode,
  onRunBatch,
  onCancelBatch,
  onUndoBatch,
}: BatchRunnerDrawerProps) {
  const ops = plan.operations;
  const pct =
    progress && progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <aside
      data-testid="batch-runner-drawer"
      className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/75 p-4 lg:border-t-0 lg:border-l"
    >
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-indigo-200 uppercase">
          <Sliders className="h-3.5 w-3.5 text-indigo-400" />
          Batch Recipe Runner
        </h3>
        <span className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-200">
          $0.00 AI Cost
        </span>
      </div>

      {/* Deterministic Operation Toggles */}
      <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
        <div className="font-semibold text-slate-200">Deterministic Operations</div>

        <label className="flex items-center justify-between gap-2 text-slate-300">
          <span>Sync Art Bible Palette</span>
          <input
            type="checkbox"
            data-testid="batch-op-palette"
            checked={ops.syncArtBiblePalette}
            disabled={isRunning}
            onChange={(e) => onChangeOperations({ syncArtBiblePalette: e.target.checked })}
            className="accent-indigo-500"
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-slate-300">
          <span>Re-run Pixel Foundry</span>
          <input
            type="checkbox"
            data-testid="batch-op-foundry"
            checked={ops.rerunPixelFoundry}
            disabled={isRunning}
            onChange={(e) => onChangeOperations({ rerunPixelFoundry: e.target.checked })}
            className="accent-indigo-500"
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-slate-300">
          <span>Auto-Trace Missing Colliders</span>
          <input
            type="checkbox"
            data-testid="batch-op-collider"
            checked={ops.autoTraceMissingColliders}
            disabled={isRunning}
            onChange={(e) => onChangeOperations({ autoTraceMissingColliders: e.target.checked })}
            className="accent-indigo-500"
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-slate-300">
          <span>Re-bake Palette LUTs</span>
          <input
            type="checkbox"
            data-testid="batch-op-lut"
            checked={ops.rebakePaletteLuts}
            disabled={isRunning}
            onChange={(e) => onChangeOperations({ rebakePaletteLuts: e.target.checked })}
            className="accent-indigo-500"
          />
        </label>

        <label className="flex items-center justify-between gap-2 text-slate-300">
          <span>Normalize Audio LUFS</span>
          <input
            type="checkbox"
            data-testid="batch-op-audio"
            checked={ops.normalizeAudioLufs}
            disabled={isRunning}
            onChange={(e) => onChangeOperations({ normalizeAudioLufs: e.target.checked })}
            className="accent-indigo-500"
          />
        </label>

        <label className="block space-y-1 pt-2 border-t border-slate-800">
          <span className="text-[11px] text-slate-400">DAG Commit Mode</span>
          <select
            data-testid="batch-mode-select"
            value={plan.mode}
            disabled={isRunning}
            onChange={(e) => onChangeMode(e.target.value as 'in-place' | 'fork-children')}
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          >
            <option value="in-place">Update In-Place (Keep DAG Compact)</option>
            <option value="fork-children">Fork Child Nodes (Preserve Lineage)</option>
          </select>
        </label>
      </div>

      {/* Dry-Run Preview Manifest */}
      <div
        data-testid="batch-dry-run-summary"
        className="space-y-1.5 rounded-lg border border-indigo-500/30 bg-indigo-950/25 p-3 text-xs"
      >
        <div className="font-semibold text-indigo-200">Dry-Run Batch Plan</div>
        <div className="font-mono text-[11px] text-emerald-300">{dryRun.summaryText}</div>
        {dryRun.operationLabels.length > 0 ? (
          <ul className="list-inside list-disc text-[11px] text-slate-300">
            {dryRun.operationLabels.map((lbl) => (
              <li key={lbl}>{lbl}</li>
            ))}
          </ul>
        ) : (
          <div className="text-[11px] text-amber-300">Select at least one operation above.</div>
        )}
      </div>

      {/* Action / Progress / Cancel Controls */}
      {isRunning ? (
        <div className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-950/25 p-3 text-xs">
          <div className="flex justify-between font-mono text-[11px] text-amber-200">
            <span>
              Processing {progress?.current ?? 0}/{progress?.total ?? dryRun.totalSelected}…
            </span>
            <span>{pct}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              style={{ width: `${pct}%` }}
              className="h-full bg-amber-400 transition-all duration-150"
            />
          </div>
          {progress && (
            <div className="truncate text-[11px] text-slate-300">{progress.assetName}</div>
          )}
          <button
            type="button"
            data-testid="batch-cancel-btn"
            onClick={onCancelBatch}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-rose-500/50 bg-rose-600/20 px-3 py-1.5 font-semibold text-rose-100 hover:bg-rose-600/40"
          >
            <Square className="h-3.5 w-3.5" />
            Cancel Batch
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="batch-run-btn"
          disabled={dryRun.totalSelected === 0 || dryRun.operationLabels.length === 0}
          onClick={onRunBatch}
          className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-40"
        >
          <Play className="h-3.5 w-3.5" />
          Run Batch ({dryRun.totalSelected} selected)
        </button>
      )}

      {/* Post-Run Before -> After Readiness & 1-Click Session Rollback */}
      {lastRunOutcome && (
        <div
          data-testid="batch-result-banner"
          className="space-y-2 rounded-lg border border-emerald-500/40 bg-emerald-950/30 p-3 text-xs"
        >
          <div className="font-semibold text-emerald-200">
            Readiness Score: {lastRunOutcome.beforeScore} → {lastRunOutcome.afterScore}
          </div>
          <div className="font-mono text-[11px] text-slate-300">
            Status: {lastRunOutcome.result.status} · {lastRunOutcome.result.processedCount} updated
            ({lastRunOutcome.result.elapsedMs}ms)
          </div>
          {lastRunOutcome.result.rollbackManifest.length > 0 && (
            <button
              type="button"
              data-testid="batch-undo-btn"
              disabled={isRunning}
              onClick={onUndoBatch}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-amber-500/50 bg-amber-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-amber-100 hover:bg-amber-500/25 disabled:opacity-40"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Undo Last Batch ({lastRunOutcome.result.rollbackManifest.length} asset
              {lastRunOutcome.result.rollbackManifest.length === 1 ? '' : 's'})
            </button>
          )}
        </div>
      )}
    </aside>
  );
}
