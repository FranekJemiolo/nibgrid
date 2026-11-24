import { useEffect, useRef, useState } from 'react';
import { Check, FileArchive, FolderSync, RefreshCw, X } from 'lucide-react';
import { db } from '../../db/database';
import type { VirtualSyncFile } from '../../export/godotPrefabAssembler';
import { useAppStore } from '../../store/useAppStore';
import {
  bindGodotDirectory,
  collectProjectGodotSyncFiles,
  downloadGodotSyncZip,
  isFsaaSupported,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';
import { computeSyncDiff, type SyncDiffPlan } from '../../sync/syncDiff';

export function GodotSyncPill() {
  const { activeProject, entities, spriteNodes, audioAssets, syncTarget, refreshSyncTarget } =
    useAppStore();

  const [popoverOpen, setPopoverOpen] = useState(false);
  const [virtualFiles, setVirtualFiles] = useState<readonly VirtualSyncFile[]>([]);
  const [diffPlan, setDiffPlan] = useState<SyncDiffPlan | null>(null);
  const [computing, setComputing] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const fsaaAvailable = isFsaaSupported();

  // Recompute virtual Godot files + SHA-256 diff whenever entities or assets change
  useEffect(() => {
    if (!activeProject) return;
    let cancelled = false;
    setComputing(true);

    void (async () => {
      try {
        const files = await collectProjectGodotSyncFiles(
          db,
          activeProject,
          entities,
          spriteNodes,
          audioAssets,
        );
        const { plan } = await computeSyncDiff(files, syncTarget?.lastSyncedHashes ?? {});
        if (!cancelled) {
          setVirtualFiles(files);
          setDiffPlan(plan);
          setComputing(false);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : 'Failed to prepare Godot sync diff.');
          setComputing(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProject, entities, spriteNodes, audioAssets, syncTarget]);

  // Close popover on click outside or Escape
  useEffect(() => {
    if (!popoverOpen) return;
    const handlePointerDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setPopoverOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPopoverOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKey);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKey);
    };
  }, [popoverOpen]);

  if (!activeProject) return null;

  const changedCount = diffPlan ? diffPlan.added.length + diffPlan.modified.length : 0;

  const handleBind = async () => {
    setErrorMsg(null);
    setStatusMessage(null);
    try {
      await bindGodotDirectory(db, activeProject.id);
      await refreshSyncTarget(activeProject.id);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setErrorMsg(err instanceof Error ? err.message : 'Could not bind Godot folder.');
    }
  };

  const handleConfirmSync = async () => {
    setSyncing(true);
    setErrorMsg(null);
    setStatusMessage(null);
    try {
      const result = await syncFilesToGodotDirectory(db, activeProject.id, virtualFiles);
      await refreshSyncTarget(activeProject.id);
      if (result.writtenCount === 0) {
        setStatusMessage(`0 files changed — ${result.folderName} is up to date.`);
      } else {
        setStatusMessage(`Synced ${result.writtenCount} file(s) to res://${result.folderName}.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to sync to Godot folder.');
    } finally {
      setSyncing(false);
    }
  };

  const handleDownloadZip = () => {
    downloadGodotSyncZip(activeProject.name, virtualFiles);
    setStatusMessage(`Downloaded ${virtualFiles.length}-file Godot sync ZIP.`);
  };

  if (!syncTarget && !fsaaAvailable) {
    return (
      <button
        type="button"
        data-testid="godot-download-zip-btn"
        disabled={virtualFiles.length === 0}
        onClick={handleDownloadZip}
        className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:border-[#F5B82E]/50 hover:text-[#F5B82E] disabled:opacity-50"
        title="Download Godot 4 res:// Sync ZIP"
      >
        <FileArchive className="h-3.5 w-3.5 text-[#F5B82E]" />
        <span>Godot Sync ZIP</span>
        {changedCount > 0 && (
          <span className="rounded-full bg-[#F5B82E]/20 px-1.5 font-mono text-[10px] text-[#F5B82E] tabular-nums">
            {changedCount}
          </span>
        )}
      </button>
    );
  }

  return (
    <div ref={containerRef} className="relative shrink-0">
      {!syncTarget ? (
        <button
          type="button"
          data-testid="godot-bind-btn"
          onClick={() => void handleBind()}
          className="inline-flex items-center gap-1.5 rounded-full border border-[#F5B82E]/45 bg-[#F5B82E]/10 px-2.5 py-1 text-[11px] font-medium text-[#F5B82E] hover:bg-[#F5B82E]/20"
          title="Bind local Godot project folder for 1-click live res:// sync"
        >
          <FolderSync className="h-3.5 w-3.5" />
          <span>Bind Godot res://</span>
        </button>
      ) : (
        <button
          type="button"
          data-testid="godot-sync-pill-btn"
          onClick={() => setPopoverOpen((prev) => !prev)}
          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors ${
            changedCount > 0
              ? 'border-[#F5B82E]/60 bg-[#F5B82E]/15 text-[#F5B82E] hover:bg-[#F5B82E]/25'
              : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/20'
          }`}
        >
          <FolderSync className="h-3.5 w-3.5 shrink-0" />
          <span className="max-w-[110px] truncate font-mono text-[10px]">
            res://{syncTarget.folderName}
          </span>
          <span className="rounded-full bg-black/35 px-1.5 font-mono text-[10px] tabular-nums">
            {computing ? '...' : changedCount > 0 ? `${changedCount} changed` : 'Synced'}
          </span>
        </button>
      )}

      {popoverOpen && syncTarget && (
        <div
          data-testid="godot-sync-popover"
          className="fixed top-14 right-4 z-50 w-80 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 shadow-2xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--border-hairline)] pb-2">
            <div>
              <h4 className="text-xs font-semibold text-slate-100">Live Godot 4 res:// Sync</h4>
              <p className="font-mono text-[10px] text-slate-400">
                Target: res://{syncTarget.folderName}
              </p>
            </div>
            <button
              type="button"
              aria-label="Close sync popover"
              onClick={() => setPopoverOpen(false)}
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="mt-2.5 space-y-2 text-[11px]">
            <div
              data-testid="sync-diff-summary"
              className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 font-mono"
            >
              {changedCount > 0 ? (
                <span className="text-[#F5B82E] tabular-nums">
                  {changedCount} file{changedCount === 1 ? '' : 's'} to write
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 text-emerald-300">
                  <Check className="h-3 w-3" />0 files changed — up to date
                </span>
              )}
              <span className="text-[10px] text-slate-400 tabular-nums">
                {diffPlan?.unchangedPaths.length ?? 0} unchanged
              </span>
            </div>

            {diffPlan && diffPlan.added.length > 0 && (
              <div data-testid="sync-diff-added-list" className="space-y-0.5">
                <span className="text-[10px] font-semibold tracking-wider text-emerald-300 uppercase">
                  + Added ({diffPlan.added.length})
                </span>
                <div className="max-h-28 space-y-0.5 overflow-y-auto rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-1.5 font-mono text-[10px] text-emerald-200">
                  {diffPlan.added.map((f) => (
                    <div key={f.relativePath} className="truncate">
                      + {f.relativePath}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {diffPlan && diffPlan.modified.length > 0 && (
              <div data-testid="sync-diff-modified-list" className="space-y-0.5">
                <span className="text-[10px] font-semibold tracking-wider text-[#F5B82E] uppercase">
                  ~ Modified ({diffPlan.modified.length})
                </span>
                <div className="max-h-24 space-y-0.5 overflow-y-auto rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-1.5 font-mono text-[10px] text-[#F5B82E]">
                  {diffPlan.modified.map((f) => (
                    <div key={f.relativePath} className="truncate">
                      ~ {f.relativePath}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {entities.length === 0 && (
              <p className="text-[11px] text-slate-400">
                Create an Entity in the <strong>Entities</strong> tab to assemble <code>.tscn</code>{' '}
                prefabs for sync.
              </p>
            )}

            {statusMessage && (
              <p
                data-testid="godot-sync-status"
                className="rounded border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 text-[11px] text-emerald-200"
              >
                {statusMessage}
              </p>
            )}

            {errorMsg && (
              <p className="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] text-rose-200">
                {errorMsg}
              </p>
            )}

            <div className="flex flex-col gap-1.5 pt-1">
              {fsaaAvailable && (
                <button
                  type="button"
                  data-testid="godot-sync-confirm-btn"
                  disabled={syncing || computing}
                  onClick={() => void handleConfirmSync()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
                >
                  <FolderSync className="h-3.5 w-3.5" />
                  {syncing ? 'Syncing...' : changedCount > 0 ? 'Sync to Godot' : 'Verify Sync (0)'}
                </button>
              )}

              <div className="grid grid-cols-2 gap-1.5">
                {fsaaAvailable && (
                  <button
                    type="button"
                    data-testid="godot-rebind-btn"
                    onClick={() => void handleBind()}
                    className="inline-flex items-center justify-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Rebind
                  </button>
                )}
                <button
                  type="button"
                  data-testid="godot-download-zip-btn"
                  disabled={virtualFiles.length === 0}
                  onClick={handleDownloadZip}
                  className="inline-flex items-center justify-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                >
                  <FileArchive className="h-3 w-3" />
                  Sync ZIP
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
