import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Bot,
  Check,
  CheckCheck,
  History,
  Loader2,
  Play,
  RotateCcw,
  Sparkles,
  Trash2,
  Volume2,
  X,
  XCircle,
} from 'lucide-react';
import {
  buildMentionCatalog,
  resolveAtMentions,
  type AgentProjectIndex,
} from '../../agent/contextResolver';
import {
  commitStagedTurn,
  rejectStagedTurn,
  restoreCheckpoint,
} from '../../agent/stagingTransactions';
import { executeStagedToolCall, type StagedAssetChange } from '../../agent/studioToolRegistry';
import { AudioPlaybackEngine } from '../../audio/playbackEngine';
import { createDefaultMockProviderConfig, db, repository } from '../../db/database';
import { planAgentTurn, type AgentTurnPlan } from '../../providers/assetAgentAdapter';
import { useAppStore } from '../../store/useAppStore';
import { BlobImage } from '../components/BlobImage';
import { BeforeAfterWipe } from '../primitives/BeforeAfterWipe';

export function AssetComposerRail() {
  const {
    activeProject,
    spriteNodes,
    entities,
    audioAssets,
    rooms,
    agentCheckpoints,
    providers,
    selectedProviderId,
    composerOpen,
    workspaceRulesText,
    setComposerOpen,
    setWorkspaceRulesText,
    refreshSpriteNodes,
    refreshEntities,
    refreshAudioAssets,
    refreshRooms,
    refreshAgentCheckpoints,
  } = useAppStore();

  const [prompt, setPrompt] = useState('');
  const [providerId, setProviderId] = useState(selectedProviderId);
  const [showRules, setShowRules] = useState(false);
  const [pendingPlan, setPendingPlan] = useState<AgentTurnPlan | null>(null);
  const [stagedChanges, setStagedChanges] = useState<StagedAssetChange[]>([]);
  const [wipePercentMap, setWipePercentMap] = useState<Record<string, number>>({});
  const [busy, setBusy] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const audioEngineRef = useRef<AudioPlaybackEngine | null>(null);

  useEffect(() => {
    setProviderId(selectedProviderId);
  }, [selectedProviderId]);

  useEffect(() => {
    return () => {
      void audioEngineRef.current?.dispose();
      audioEngineRef.current = null;
    };
  }, []);

  const projectIndex = useMemo<AgentProjectIndex | null>(() => {
    if (!activeProject) return null;
    return {
      project: activeProject,
      spriteNodes,
      entities,
      audioAssets,
      rooms,
    };
  }, [activeProject, spriteNodes, entities, audioAssets, rooms]);

  const mentionCatalog = useMemo(() => {
    if (!projectIndex) return [];
    return buildMentionCatalog(projectIndex);
  }, [projectIndex]);

  const activeAtQuery = useMemo(() => {
    const match = /(?:^|[\s(])@([a-zA-Z0-9_-]*)$/.exec(prompt);
    return match ? (match[1] ?? '').toLowerCase() : null;
  }, [prompt]);

  const filteredMentions = useMemo(() => {
    if (activeAtQuery === null) return [];
    return mentionCatalog
      .filter((item) => item.slug.includes(activeAtQuery) || item.label.includes(activeAtQuery))
      .slice(0, 8);
  }, [mentionCatalog, activeAtQuery]);

  const activeProvider = useMemo(() => {
    return providers.find((p) => p.id === providerId) ?? createDefaultMockProviderConfig();
  }, [providers, providerId]);

  if (!composerOpen) {
    return null;
  }

  const refreshAllSlices = async (projectId: string) => {
    await Promise.all([
      refreshSpriteNodes(projectId),
      refreshEntities(projectId),
      refreshAudioAssets(projectId),
      refreshRooms(projectId),
      refreshAgentCheckpoints(projectId),
    ]);
  };

  const handleInsertMention = (slug: string) => {
    setPrompt((prev) => prev.replace(/(^|[\s(])@[a-zA-Z0-9_-]*$/, `$1@${slug} `));
  };

  const stagePlanTools = async (plan: AgentTurnPlan) => {
    if (!activeProject) return;
    const changes: StagedAssetChange[] = [];
    for (const tc of plan.toolCalls) {
      const produced = await executeStagedToolCall(db, activeProject.id, tc, activeProvider);
      changes.push(...produced);
    }
    setStagedChanges(changes);
    setPendingPlan(null);
    setStatusNotice(
      changes.length > 0
        ? `Staged ${changes.length} diff(s) cleanly — inspect and Accept or Reject below.`
        : 'Plan ran with zero mutable changes.',
    );
  };

  const handlePlanAndStage = async () => {
    if (!activeProject || !projectIndex || busy || prompt.trim().length === 0) return;
    setBusy(true);
    setErrorNotice(null);
    setStatusNotice(null);
    setPendingPlan(null);
    try {
      if (stagedChanges.length > 0) {
        await rejectStagedTurn(db, stagedChanges);
        setStagedChanges([]);
      }

      const resolved = resolveAtMentions(prompt, projectIndex);
      const fallbackSlug = entities[0]?.slug ?? spriteNodes[0]?.id;
      const plan = await planAgentTurn(prompt, resolved, activeProject.artBible, activeProvider, {
        customRules: workspaceRulesText,
        fallbackTargetSlug: fallbackSlug,
      });

      if (plan.estimatedUsd > 0) {
        setPendingPlan(plan);
        setStatusNotice(
          `Tool Plan ready (~$${plan.estimatedUsd.toFixed(2)}) — confirm before running paid tools.`,
        );
      } else {
        await stagePlanTools(plan);
      }
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Agent turn planning failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPaidPlan = async () => {
    if (!pendingPlan || busy) return;
    setBusy(true);
    setErrorNotice(null);
    try {
      await stagePlanTools(pendingPlan);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to execute staged tools.');
    } finally {
      setBusy(false);
    }
  };

  const toggleChangeStatus = (changeId: string, nextStatus: 'accepted' | 'rejected') => {
    setStagedChanges((prev) =>
      prev.map((c) => (c.changeId === changeId ? { ...c, status: nextStatus } : c)),
    );
  };

  const handleCommitTurn = async (mode: 'selected' | 'all') => {
    if (!activeProject || stagedChanges.length === 0 || busy) return;
    setBusy(true);
    setErrorNotice(null);
    try {
      const normalized: StagedAssetChange[] = stagedChanges.map((c) =>
        mode === 'all'
          ? { ...c, status: 'accepted' }
          : c.status === 'pending'
            ? { ...c, status: 'rejected' }
            : c,
      );
      const res = await commitStagedTurn(
        db,
        activeProject.id,
        prompt.trim() || 'Asset Composer turn',
        normalized,
      );
      setStagedChanges([]);
      await refreshAllSlices(activeProject.id);
      setStatusNotice(
        `Committed ${res.acceptedCount} change(s)${res.rejectedCount > 0 ? ` (${res.rejectedCount} rejected & purged)` : ''}${res.checkpoint ? ' + Checkpoint saved' : ''}.`,
      );
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Commit failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRejectAll = async () => {
    if (busy) return;
    setBusy(true);
    setErrorNotice(null);
    try {
      await rejectStagedTurn(db, stagedChanges);
      setStagedChanges([]);
      setPendingPlan(null);
      setStatusNotice('Discarded staged changes cleanly (0 orphan blobs).');
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Discard failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleRestoreCheckpoint = async (checkpointId: string) => {
    if (!activeProject || busy) return;
    setBusy(true);
    setErrorNotice(null);
    try {
      const res = await restoreCheckpoint(db, checkpointId);
      await refreshAllSlices(activeProject.id);
      setStatusNotice(`Restored checkpoint (${res.restoredRecordCount} asset record(s) reverted).`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Restore checkpoint failed.');
    } finally {
      setBusy(false);
    }
  };

  const handlePlayStagedAudio = async (blobId: string) => {
    const rec = await repository.getBlob(blobId);
    if (!rec) return;
    if (!audioEngineRef.current) {
      audioEngineRef.current = new AudioPlaybackEngine();
    }
    await audioEngineRef.current.playWavBlob(rec.bytes);
  };

  return (
    <aside
      data-testid="asset-composer-rail"
      aria-label="Agentic Asset Composer"
      className="fixed top-12 right-0 bottom-0 z-40 flex w-96 max-w-full flex-col border-l border-[#2A2A2E] bg-[#141418] shadow-2xl"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#2A2A2E] bg-[#1A1A1F] px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-amber-400" />
          <div>
            <h2 className="text-xs font-semibold text-zinc-100">Asset Composer (⌘L)</h2>
            <p className="text-[10px] text-zinc-400">@ mentions · Tool Diffs · Dexie Rollback</p>
          </div>
        </div>
        <button
          type="button"
          data-testid="composer-close-btn"
          onClick={() => setComposerOpen(false)}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 space-y-3 overflow-y-auto p-3.5">
        {!activeProject ? (
          <p className="rounded border border-[#2A2A2E] bg-[#1B1B20] p-3 text-xs text-zinc-400">
            Open or create a project to edit sprites, shaders, sockets, SFX, and rooms with the
            Asset Composer.
          </p>
        ) : (
          <>
            {/* Provider + .nibgridrules bar */}
            <div className="flex items-center justify-between gap-2">
              <select
                data-testid="composer-provider-select"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
                className="min-w-0 flex-1 rounded border border-[#2E2E35] bg-[#1B1B20] px-2 py-1 text-[11px] text-zinc-200"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.kind === 'mock' ? 'Offline Mock Agent ($0.00)' : p.displayName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="composer-rules-toggle"
                onClick={() => setShowRules((v) => !v)}
                className="shrink-0 rounded border border-[#2E2E35] bg-[#1B1B20] px-2 py-1 text-[10px] font-medium text-zinc-300 hover:border-amber-500/50"
              >
                .nibgridrules
              </button>
            </div>

            {showRules && (
              <textarea
                data-testid="composer-rules-input"
                rows={2}
                value={workspaceRulesText}
                onChange={(e) => setWorkspaceRulesText(e.target.value)}
                placeholder="Custom .nibgridrules (injected with ArtBible palette & light angle)..."
                className="w-full rounded border border-[#2E2E35] bg-[#1A1A1F] p-2 font-mono text-[11px] text-zinc-200 focus:border-amber-500/50 focus:outline-none"
              />
            )}

            {/* Prompt + @ Mention Autocomplete */}
            <div className="relative space-y-2">
              <textarea
                data-testid="composer-prompt-input"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Type @ to mention @goblin_scout, @hit_flash, @enemies... e.g. 'Add cape_tip socket to @goblin_scout and tint @hit_flash emerald'"
                className="w-full rounded-md border border-[#2E2E35] bg-[#1A1A1F] p-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500/60 focus:outline-none"
              />

              {filteredMentions.length > 0 && (
                <div
                  data-testid="composer-at-popover"
                  className="max-h-40 overflow-y-auto rounded-md border border-[#34343D] bg-[#1E1E24] p-1 shadow-xl"
                >
                  {filteredMentions.map((item) => (
                    <button
                      key={`${item.kind}-${item.id}-${item.slug}`}
                      type="button"
                      data-testid={`composer-at-option-${item.slug}`}
                      onClick={() => handleInsertMention(item.slug)}
                      className="flex w-full items-center justify-between gap-2 rounded px-2 py-1 text-left text-[11px] text-zinc-200 hover:bg-amber-500/15 hover:text-amber-200"
                    >
                      <span className="font-mono font-semibold">{item.label}</span>
                      <span className="truncate text-[10px] text-zinc-400">{item.kind}</span>
                    </button>
                  ))}
                </div>
              )}

              <button
                type="button"
                data-testid="composer-submit-btn"
                disabled={busy || prompt.trim().length === 0}
                onClick={() => void handlePlanAndStage()}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
              >
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Sparkles className="h-3.5 w-3.5" />
                )}
                Plan & Stage Visual Diff
              </button>
            </div>

            {statusNotice && (
              <p
                data-testid="composer-status-notice"
                className="rounded border border-emerald-500/35 bg-emerald-950/30 px-2.5 py-1.5 text-[11px] text-emerald-200"
              >
                {statusNotice}
              </p>
            )}

            {errorNotice && (
              <p
                data-testid="composer-error-notice"
                className="flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-950/35 px-2.5 py-1.5 text-[11px] text-rose-200"
              >
                <XCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" />
                <span>{errorNotice}</span>
              </p>
            )}

            {/* Pending Paid Plan Cost Gate */}
            {pendingPlan && (
              <div
                data-testid="composer-tool-plan"
                className="space-y-2 rounded-md border border-sky-500/45 bg-sky-950/25 p-3"
              >
                <div className="flex items-center justify-between text-xs">
                  <span className="font-semibold text-sky-200">{pendingPlan.planSummary}</span>
                  <span
                    data-testid="composer-cost-badge"
                    className="rounded bg-sky-500/20 px-1.5 py-0.5 font-mono text-[10px] text-sky-200"
                  >
                    ~${pendingPlan.estimatedUsd.toFixed(2)}
                  </span>
                </div>
                <ul className="space-y-1 font-mono text-[10px] text-zinc-300">
                  {pendingPlan.toolCalls.map((tc, i) => (
                    <li key={`${tc.toolName}-${i}`}>• {tc.toolName}</li>
                  ))}
                </ul>
                <button
                  type="button"
                  data-testid="composer-confirm-paid-btn"
                  disabled={busy}
                  onClick={() => void handleConfirmPaidPlan()}
                  className="w-full rounded bg-sky-500 px-2.5 py-1 text-xs font-semibold text-zinc-950 hover:bg-sky-400"
                >
                  Confirm & Stage Tools
                </button>
              </div>
            )}

            {/* Staged Diff Cards */}
            {stagedChanges.length > 0 && (
              <div data-testid="composer-tool-plan" className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                    Staged Visual Diff ({stagedChanges.length})
                  </span>
                  <span
                    data-testid="composer-cost-badge"
                    className="font-mono text-[10px] text-emerald-300"
                  >
                    ${stagedChanges.reduce((s, c) => s + c.estimatedUsd, 0).toFixed(2)}
                  </span>
                </div>

                {stagedChanges.map((change) => (
                  <div
                    key={change.changeId}
                    data-testid="staged-change-card"
                    data-status={change.status}
                    className={`space-y-2 rounded-md border p-2.5 ${
                      change.status === 'rejected'
                        ? 'border-rose-500/40 bg-rose-950/15 opacity-60'
                        : change.status === 'accepted'
                          ? 'border-emerald-500/50 bg-emerald-950/20'
                          : 'border-[#2E2E35] bg-[#19191F]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <span className="rounded bg-zinc-800 px-1.5 py-0.5 font-mono text-[10px] text-amber-300">
                          {change.toolName}
                        </span>
                        <p className="mt-1 text-[11px] font-medium text-zinc-100">
                          @{change.targetSlug} — {change.summary}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          data-testid="staged-accept-btn"
                          onClick={() => toggleChangeStatus(change.changeId, 'accepted')}
                          className={`rounded p-1 ${
                            change.status === 'accepted'
                              ? 'bg-emerald-600 text-white'
                              : 'bg-zinc-800 text-zinc-300 hover:text-emerald-300'
                          }`}
                          title="Accept Hunk"
                        >
                          <Check className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          data-testid="staged-reject-btn"
                          onClick={() => toggleChangeStatus(change.changeId, 'rejected')}
                          className={`rounded p-1 ${
                            change.status === 'rejected'
                              ? 'bg-rose-600 text-white'
                              : 'bg-zinc-800 text-zinc-300 hover:text-rose-300'
                          }`}
                          title="Reject Hunk"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>

                    {change.beforeBlobId && change.afterBlobId && (
                      <div className="flex justify-center rounded border border-[#26262E] bg-[#121215] p-2">
                        <BeforeAfterWipe
                          enabled
                          percent={wipePercentMap[change.changeId] ?? 50}
                          onChangePercent={(pct) =>
                            setWipePercentMap((m) => ({ ...m, [change.changeId]: pct }))
                          }
                          beforeLabel="Before"
                          afterLabel="After"
                          widthPx={128}
                          heightPx={128}
                          before={
                            <BlobImage
                              blobId={change.beforeBlobId}
                              alt="Before staged sprite"
                              artMode={activeProject.artBible.artMode}
                              className="h-full w-full object-contain"
                            />
                          }
                          after={
                            <BlobImage
                              blobId={change.afterBlobId}
                              alt="After staged sprite"
                              artMode={activeProject.artBible.artMode}
                              className="h-full w-full object-contain"
                            />
                          }
                        />
                      </div>
                    )}

                    {change.kind === 'audio' && change.afterBlobId && (
                      <button
                        type="button"
                        onClick={() => void handlePlayStagedAudio(change.afterBlobId!)}
                        className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#121215] px-2 py-1 text-[11px] text-zinc-200 hover:border-amber-500/50"
                      >
                        <Volume2 className="h-3.5 w-3.5 text-amber-400" />
                        <Play className="h-3 w-3" />
                        Audition Staged WAV
                      </button>
                    )}

                    {change.textDiff && (
                      <div className="grid grid-cols-2 gap-1.5 font-mono text-[10px]">
                        <pre className="max-h-28 overflow-auto rounded bg-rose-950/25 p-1.5 text-rose-200">
                          {change.textDiff.before}
                        </pre>
                        <pre className="max-h-28 overflow-auto rounded bg-emerald-950/25 p-1.5 text-emerald-200">
                          {change.textDiff.after}
                        </pre>
                      </div>
                    )}
                  </div>
                ))}

                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    data-testid="composer-accept-all-btn"
                    disabled={busy}
                    onClick={() => void handleCommitTurn('all')}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 rounded bg-emerald-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                    Accept All & Checkpoint
                  </button>
                  <button
                    type="button"
                    data-testid="composer-reject-all-btn"
                    disabled={busy}
                    onClick={() => void handleRejectAll()}
                    className="rounded border border-[#2E2E35] bg-[#1B1B20] px-2.5 py-1.5 text-xs text-zinc-300 hover:border-rose-500/60 hover:text-rose-200"
                  >
                    Reject
                  </button>
                </div>
              </div>
            )}

            {/* Checkpoint History */}
            <div
              data-testid="composer-checkpoints"
              className="space-y-2 border-t border-[#2A2A2E] pt-3"
            >
              <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">
                <History className="h-3.5 w-3.5 text-amber-400" />
                Checkpoints ({agentCheckpoints.length})
              </div>
              {agentCheckpoints.length === 0 ? (
                <p className="text-[11px] text-zinc-500">
                  Accepted composer edits snapshot here for 1-click Dexie rollback.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {agentCheckpoints.map((cp) => (
                    <div
                      key={cp.id}
                      data-testid={`checkpoint-row-${cp.id}`}
                      className="flex items-center justify-between gap-2 rounded border border-[#26262E] bg-[#1A1A1F] px-2.5 py-2"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-medium text-zinc-200">
                          {cp.turnSummary}
                        </p>
                        <p className="text-[10px] text-zinc-500">
                          {new Date(cp.createdAt).toLocaleTimeString()}
                        </p>
                      </div>
                      <button
                        type="button"
                        data-testid="checkpoint-restore-btn"
                        disabled={busy}
                        onClick={() => void handleRestoreCheckpoint(cp.id)}
                        className="inline-flex shrink-0 items-center gap-1 rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-300 hover:bg-amber-500/20 disabled:opacity-50"
                      >
                        <RotateCcw className="h-3 w-3" />
                        Restore
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
