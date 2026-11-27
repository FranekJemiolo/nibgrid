import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  FolderSync,
  Gamepad2,
  Link2,
  Loader2,
  PauseCircle,
  Play,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
  XCircle,
} from 'lucide-react';
import { createDefaultMockProviderConfig, db, repository } from '../../db/database';
import {
  createSliceJobRecord,
  runSliceDag,
  type SliceDagNode,
  type SliceJobRecord,
  type SliceNodeStatus,
} from '../../processing/sliceDagRunner';
import {
  estimateSliceCostUsd,
  type SliceExecutionTier,
  type SliceGenre,
} from '../../processing/verticalSliceSchema';
import {
  buildMockVerticalSliceBlueprint,
  collectVerticalSliceGodotSyncFiles,
  createSliceNodeExecutor,
  draftVerticalSliceBlueprint,
} from '../../providers/verticalSliceDirector';
import { useAppStore } from '../../store/useAppStore';
import {
  bindGodotDirectory,
  downloadGodotSyncZip,
  getBoundDirectoryHandle,
  isFsaaSupported,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';
import { BlobImage } from '../components/BlobImage';

const STARTER_SLICE_PROMPTS: readonly {
  readonly label: string;
  readonly genre: SliceGenre;
  readonly prompt: string;
}[] = [
  {
    label: 'Gothic Platformer',
    genre: 'side-platformer',
    prompt:
      '16-bit gothic platformer: armored knight hero, 2 skeleton enemies, crypt stone tileset, moonlit parallax, gothic HUD, and a boss arena',
  },
  {
    label: 'Cyber Neon Runner',
    genre: 'side-platformer',
    prompt:
      'Neon cyberpunk platformer: blade runner hero, 2 security drones, steel grating tileset, rainy rooftop parallax, cyan HUD, and reactor arena',
  },
  {
    label: 'Sunlit Meadow Quest',
    genre: 'top-down',
    prompt:
      'Sunlit top-down pixel RPG: forest ranger hero, mossy slime and goblin enemies, grass cliff tileset, meadow parallax, oak HUD, and sanctum clearing',
  },
];

const TIER_OPTIONS: readonly {
  readonly id: SliceExecutionTier;
  readonly label: string;
  readonly hint: string;
}[] = [
  {
    id: 'instant-draft',
    label: 'Instant Draft ($0.00)',
    hint: '100% deterministic local mock — zero API calls',
  },
  {
    id: 'hybrid-prod',
    label: 'Hybrid Production',
    hint: 'GenAI hero + cast + parallax, local procedural tiles & HUD',
  },
  {
    id: 'full-genai',
    label: 'Full GenAI Production',
    hint: 'Full AI cast, OpenPose strips, parallax & visual QA',
  },
];

const STATUS_STYLE: Record<SliceNodeStatus, string> = {
  pending: 'border-zinc-700 bg-zinc-900/70 text-zinc-400',
  running: 'border-amber-500/60 bg-amber-500/15 text-amber-300',
  'awaiting-approval': 'border-sky-500/60 bg-sky-500/15 text-sky-300',
  done: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
  failed: 'border-rose-500/60 bg-rose-500/15 text-rose-300',
  aborted: 'border-orange-500/50 bg-orange-500/10 text-orange-300',
};

export function VerticalSliceWizard() {
  const {
    activeProject,
    spriteNodes,
    entities,
    sliceJobs,
    providers,
    selectedProviderId,
    autopilotOpen,
    setAutopilotOpen,
    createProject,
    navigate,
    saveSliceJobRecord,
    refreshProjects,
    refreshSpriteNodes,
    refreshEntities,
    refreshRooms,
    refreshSliceJobs,
    refreshSyncTarget,
    openShareModal,
  } = useAppStore();

  const [prompt, setPrompt] = useState(STARTER_SLICE_PROMPTS[0]!.prompt);
  const [genre, setGenre] = useState<SliceGenre>('side-platformer');
  const [tier, setTier] = useState<SliceExecutionTier>('instant-draft');
  const [activeJob, setActiveJob] = useState<SliceJobRecord | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [anchorBlobId, setAnchorBlobId] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  // Sync activeJob cleanly with persisted Dexie store when modal opens, switches project, or reloads
  useEffect(() => {
    if (!autopilotOpen || isRunning) return;
    const latest = sliceJobs[0] ?? null;
    setActiveJob(latest);
    if (latest) {
      setGenre(latest.blueprint.genre);
      setTier(latest.tier);
    }
  }, [autopilotOpen, activeProject?.id, sliceJobs, isRunning]);

  // Resolve Golden Reference blob ID for 1x / 4x preview gate
  const anchorNodeArtifactId =
    activeJob?.nodes.find((n) => n.id === 'golden_ref_hero')?.artifactId ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!anchorNodeArtifactId) {
      setAnchorBlobId(null);
      return;
    }
    const inStore = spriteNodes.find((n) => n.id === anchorNodeArtifactId);
    if (inStore) {
      setAnchorBlobId(inStore.processedBlobId ?? inStore.imageBlobId);
      return;
    }
    void db.spriteNodes.get(anchorNodeArtifactId).then((found) => {
      if (!cancelled && found) {
        setAnchorBlobId(found.processedBlobId ?? found.imageBlobId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [anchorNodeArtifactId, spriteNodes]);

  const previewBlueprint = useMemo(() => {
    if (activeJob) return activeJob.blueprint;
    return buildMockVerticalSliceBlueprint(prompt, genre);
  }, [activeJob, prompt, genre]);

  const costEstimate = useMemo(
    () => estimateSliceCostUsd(previewBlueprint, tier),
    [previewBlueprint, tier],
  );

  const selectedProvider = useMemo(() => {
    if (tier === 'instant-draft') {
      return createDefaultMockProviderConfig();
    }
    return providers.find((p) => p.id === selectedProviderId) ?? createDefaultMockProviderConfig();
  }, [providers, selectedProviderId, tier]);

  if (!autopilotOpen) {
    return null;
  }

  const refreshProjectArtifacts = async (projectId: string) => {
    await Promise.all([
      refreshProjects(),
      refreshSpriteNodes(projectId),
      refreshEntities(projectId),
      refreshRooms(projectId),
      refreshSliceJobs(projectId),
    ]);
  };

  const runDagWithState = async (
    startJob: SliceJobRecord,
    approvedAnchor: boolean,
  ): Promise<SliceJobRecord | null> => {
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsRunning(true);
    setWizardError(null);
    setSyncMessage(null);

    try {
      const executor = createSliceNodeExecutor({
        database: db,
        projectId: startJob.projectId,
        tier: startJob.tier,
        providerConfig:
          startJob.tier === 'instant-draft' ? createDefaultMockProviderConfig() : selectedProvider,
      });

      const finalJob = await runSliceDag(startJob, executor, {
        approvedAnchor,
        maxConcurrency: 2,
        signal: controller.signal,
        onJobUpdate: async (snap) => {
          setActiveJob(snap);
          await saveSliceJobRecord(snap);
        },
      });
      setActiveJob(finalJob);
      await saveSliceJobRecord(finalJob);
      await refreshProjectArtifacts(startJob.projectId);
      return finalJob;
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setWizardError(err instanceof Error ? err.message : 'Vertical slice orchestration failed.');
      }
      return null;
    } finally {
      abortControllerRef.current = null;
      setIsRunning(false);
    }
  };

  const handleDraftBlueprint = async () => {
    if (isRunning) return;
    setWizardError(null);
    setSyncMessage(null);
    try {
      const plannerProvider =
        tier === 'instant-draft' ? createDefaultMockProviderConfig() : selectedProvider;
      const drafted = await draftVerticalSliceBlueprint({
        prompt,
        genre,
        providerConfig: plannerProvider,
      });

      const targetProject =
        activeProject ?? (await createProject(drafted.blueprint.projectSlug.replace(/_/g, ' ')));
      if (!activeProject || activeProject.id !== targetProject.id) {
        await navigate({ screen: 'bible', projectId: targetProject.id });
      }

      const freshJob = createSliceJobRecord(targetProject.id, drafted.blueprint, tier);
      setActiveJob(freshJob);
      await saveSliceJobRecord(freshJob);
      await runDagWithState(freshJob, false);
    } catch (err) {
      setWizardError(err instanceof Error ? err.message : 'Failed to draft blueprint.');
    }
  };

  const handleRerollAnchor = async () => {
    if (!activeJob || isRunning) return;
    const resetJob: SliceJobRecord = {
      ...activeJob,
      status: 'idle',
      nodes: activeJob.nodes.map((n) =>
        n.id === 'golden_ref_hero'
          ? { ...n, status: 'pending', artifactId: undefined, errorMessage: undefined }
          : n,
      ),
      updatedAt: Date.now(),
    };
    await runDagWithState(resetJob, false);
  };

  const handleApproveAndFanOut = async () => {
    if (!activeJob || isRunning) return;
    await runDagWithState(activeJob, true);
  };

  const handleResumeDag = async () => {
    if (!activeJob || isRunning) return;
    const anchorDone =
      activeJob.nodes.find((n) => n.id === 'golden_ref_hero')?.status === 'done' ||
      activeJob.nodes.find((n) => n.id === 'golden_ref_hero')?.status === 'awaiting-approval';
    await runDagWithState(activeJob, anchorDone);
  };

  const handleAbort = () => {
    abortControllerRef.current?.abort();
  };

  const handleSyncToGodot = async () => {
    if (!activeJob) return;
    setWizardError(null);
    try {
      const freshProj =
        (await repository.getProject(activeJob.projectId)) ??
        activeProject ??
        (await createProject('Vertical Slice'));
      const files = await collectVerticalSliceGodotSyncFiles(db, freshProj, activeJob);

      if (isFsaaSupported()) {
        const existingHandle = await getBoundDirectoryHandle(db, freshProj.id);
        if (!existingHandle) {
          await bindGodotDirectory(db, freshProj.id);
        }
        const res = await syncFilesToGodotDirectory(db, freshProj.id, files);
        await refreshSyncTarget(freshProj.id);
        setSyncMessage(
          `Synced ${res.writtenCount} file(s) (${files.length} total in slice) to "${res.folderName}" — open res://main.tscn in Godot 4.3+.`,
        );
      } else {
        downloadGodotSyncZip(activeJob.blueprint.projectSlug, files);
        setSyncMessage(
          `Downloaded ${files.length} Godot 4 files as ${activeJob.blueprint.projectSlug}_godot_sync.zip.`,
        );
      }
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setWizardError(err instanceof Error ? err.message : 'Godot res:// sync failed.');
      }
    }
  };

  const handleLaunchPlaytest = async () => {
    if (!activeJob) return;
    const targetHero =
      entities.find((e) => e.slug === activeJob.blueprint.cast[0]?.slug) ?? entities[0];
    setAutopilotOpen(false);
    await navigate({
      screen: 'entities',
      projectId: activeJob.projectId,
      ...(targetHero ? { playtestEntityId: targetHero.id } : {}),
    });
  };

  const handleShareSliceBlueprint = () => {
    const bp = activeJob?.blueprint ?? previewBlueprint;
    openShareModal({
      kind: 'vertical-slice',
      name: bp.projectSlug,
      tier: activeJob?.tier ?? tier,
      blueprint: bp,
    });
  };

  const handleInspectNode = async (node: SliceDagNode) => {
    if (!activeJob || node.status !== 'done') return;
    const projId = activeJob.projectId;
    const fallbackNodeId = spriteNodes[0]?.id;
    setAutopilotOpen(false);
    if (node.kind === 'art-bible') {
      await navigate({ screen: 'bible', projectId: projId });
      return;
    }
    if (node.kind === 'entity') {
      await navigate({ screen: 'entities', projectId: projId });
      return;
    }
    if (node.kind === 'visual-qa') {
      await navigate({ screen: 'audit', projectId: projId });
      return;
    }
    const targetNodeId =
      node.kind === 'golden-ref' ||
      node.kind === 'tileset' ||
      node.kind === 'parallax' ||
      node.kind === 'bmfont' ||
      node.kind === 'ui-theme'
        ? (node.artifactId ?? fallbackNodeId)
        : (jobArtifactFallback(activeJob) ?? fallbackNodeId);
    if (!targetNodeId) {
      await navigate({ screen: 'entities', projectId: projId });
      return;
    }
    const tabMap = {
      'golden-ref': 'postprocess',
      tileset: 'autotile',
      parallax: 'parallax',
      bmfont: 'bmfont',
      'ui-theme': 'uikit',
      room: 'room',
      'main-scene': 'room',
    } as const;
    await navigate({
      screen: 'inspector',
      projectId: projId,
      nodeId: targetNodeId,
      initialTab: tabMap[node.kind],
    });
  };

  const anchorAwaiting = activeJob?.status === 'awaiting-approval';
  const canResume =
    Boolean(activeJob) &&
    !isRunning &&
    !anchorAwaiting &&
    activeJob?.status !== 'completed' &&
    activeJob!.nodes.some((n) => n.status !== 'done');
  const completedCount = activeJob?.nodes.filter((n) => n.status === 'done').length ?? 0;
  const totalCount = activeJob?.nodes.length ?? 0;

  return (
    <div
      data-testid="vertical-slice-wizard"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#2A2A2E] bg-[#161619] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2A2A2E] bg-[#1C1C20] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40">
              <Sparkles className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                Vertical Slice Autopilot · Single-Prompt Game Builder
              </h2>
              <p className="text-[11px] text-zinc-400">
                Prompt → Style Gate → Hero, Cast, Terrain, Parallax, UI Theme, Level `.tscn` &{' '}
                `main.tscn`
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span
              data-testid="slice-cost-badge"
              className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] font-medium text-emerald-300"
            >
              {costEstimate.label}
            </span>
            <button
              type="button"
              data-testid="slice-close-btn"
              onClick={() => setAutopilotOpen(false)}
              className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* Step 1: Prompt, Genre & Tier */}
          <div className="space-y-3 rounded-lg border border-[#2A2A2E] bg-[#121215] p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                1. Single Game Slice Prompt & Cost Tier
              </span>
              <div className="flex flex-wrap gap-1.5">
                {STARTER_SLICE_PROMPTS.map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    disabled={isRunning}
                    onClick={() => {
                      setPrompt(preset.prompt);
                      setGenre(preset.genre);
                    }}
                    className="rounded border border-[#2E2E35] bg-[#1B1B20] px-2 py-0.5 text-[11px] text-zinc-300 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-50"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>

            <textarea
              data-testid="slice-prompt-input"
              rows={2}
              value={prompt}
              disabled={isRunning}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Describe hero, enemies, tileset biome, parallax, UI theme, and arena layout..."
              className="w-full rounded-md border border-[#2E2E35] bg-[#1A1A1F] p-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500/60 focus:outline-none disabled:opacity-60"
            />

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <label className="space-y-1 text-[11px] text-zinc-400">
                <span>Genre</span>
                <select
                  data-testid="slice-genre-select"
                  value={genre}
                  disabled={isRunning}
                  onChange={(e) => setGenre(e.target.value as SliceGenre)}
                  className="w-full rounded border border-[#2E2E35] bg-[#1A1A1F] px-2.5 py-1.5 text-xs text-zinc-100"
                >
                  <option value="side-platformer">Side-Platformer</option>
                  <option value="top-down">Top-Down RPG</option>
                  <option value="twin-stick">Twin-Stick Arena</option>
                </select>
              </label>

              <label className="space-y-1 text-[11px] text-zinc-400">
                <span>Execution Tier</span>
                <select
                  data-testid="slice-tier-select"
                  value={tier}
                  disabled={isRunning}
                  onChange={(e) => setTier(e.target.value as SliceExecutionTier)}
                  className="w-full rounded border border-[#2E2E35] bg-[#1A1A1F] px-2.5 py-1.5 text-xs text-zinc-100"
                >
                  {TIER_OPTIONS.map((opt) => (
                    <option key={opt.id} value={opt.id}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex items-end gap-2">
                <button
                  type="button"
                  data-testid="slice-draft-btn"
                  disabled={isRunning || prompt.trim().length === 0}
                  onClick={() => void handleDraftBlueprint()}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
                >
                  {isRunning ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Play className="h-3.5 w-3.5" />
                  )}
                  Draft Blueprint & Lock Style
                </button>
              </div>
            </div>

            <p className="text-[11px] text-zinc-500">
              {TIER_OPTIONS.find((t) => t.id === tier)?.hint} · Room:{' '}
              <span className="font-mono text-zinc-300">
                {previewBlueprint.roomCols}×{previewBlueprint.roomRows}
              </span>{' '}
              ({previewBlueprint.tileSizePx}px) · Cast:{' '}
              <span className="font-mono text-zinc-300">
                {previewBlueprint.cast.map((c) => c.slug).join(', ')}
              </span>
            </p>
          </div>

          {wizardError && (
            <div
              data-testid="slice-error-banner"
              className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/35 px-3 py-2 text-xs text-rose-200"
            >
              <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{wizardError}</span>
            </div>
          )}

          {/* Step 2: Golden Reference Approval Gate */}
          {anchorAwaiting && activeJob && (
            <div
              data-testid="slice-anchor-gate"
              className="space-y-3 rounded-lg border border-sky-500/45 bg-sky-950/20 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">
                    2. Golden Reference Visual Approval Gate
                  </p>
                  <p className="text-xs text-zinc-300">
                    Inspect the locked Art Bible palette and 1×/4× Hero anchor before fanning out{' '}
                    {activeJob.nodes.length - 2} downstream stages.
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    data-testid="slice-reroll-anchor-btn"
                    disabled={isRunning}
                    onClick={() => void handleRerollAnchor()}
                    className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#1B1B20] px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Re-Roll Anchor
                  </button>
                  <button
                    type="button"
                    data-testid="slice-approve-fanout-btn"
                    disabled={isRunning}
                    onClick={() => void handleApproveAndFanOut()}
                    className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    <ShieldCheck className="h-3.5 w-3.5" />
                    Approve Style & Fan Out
                  </button>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-5 rounded-md border border-[#26262C] bg-[#121215] p-3">
                <div className="flex items-center gap-3">
                  {anchorBlobId && (
                    <>
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-zinc-400">1× Pixel</span>
                        <BlobImage
                          blobId={anchorBlobId}
                          alt="Hero anchor 1x"
                          artMode={
                            activeJob.blueprint.artMode === 'hd-handdrawn' ? 'hd-2d' : 'pixel-art'
                          }
                          className="h-16 w-16 rounded border border-[#2A2A2E] bg-[#1B1B20]"
                        />
                      </div>
                      <div className="flex flex-col items-center gap-1">
                        <span className="text-[10px] text-zinc-400">2× Scale Preview</span>
                        <BlobImage
                          blobId={anchorBlobId}
                          alt="Hero anchor 2x"
                          artMode={
                            activeJob.blueprint.artMode === 'hd-handdrawn' ? 'hd-2d' : 'pixel-art'
                          }
                          className="h-28 w-28 rounded border border-[#2A2A2E] bg-[#1B1B20]"
                        />
                      </div>
                    </>
                  )}
                </div>

                <div className="flex-1 space-y-2">
                  <p className="text-[11px] font-medium text-zinc-300">
                    Locked Palette ({(activeJob.blueprint.paletteHex ?? []).length} colors)
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {(activeJob.blueprint.paletteHex ?? []).map((hex) => (
                      <div
                        key={hex}
                        className="flex items-center gap-1 rounded border border-[#2E2E35] bg-[#1A1A1F] px-1.5 py-0.5 text-[10px] font-mono text-zinc-300"
                      >
                        <span
                          className="inline-block h-3 w-3 rounded-sm border border-white/20"
                          style={{ backgroundColor: hex }}
                        />
                        {hex}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Live Resumable DAG Progress Board */}
          {activeJob && (
            <div
              data-testid="slice-dag-board"
              className="space-y-3 rounded-lg border border-[#2A2A2E] bg-[#121215] p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                    3. Resumable Vertical Slice DAG ({completedCount}/{totalCount} Done)
                  </span>
                  <p className="text-[11px] text-zinc-500">
                    Job status: <span className="font-mono text-zinc-200">{activeJob.status}</span>{' '}
                    · Persisted in local IndexedDB across page reloads
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {isRunning && (
                    <button
                      type="button"
                      data-testid="slice-abort-btn"
                      onClick={handleAbort}
                      className="inline-flex items-center gap-1.5 rounded border border-orange-500/50 bg-orange-500/15 px-2.5 py-1 text-xs font-medium text-orange-200 hover:bg-orange-500/25"
                    >
                      <PauseCircle className="h-3.5 w-3.5" />
                      Pause / Abort
                    </button>
                  )}
                  {canResume && (
                    <button
                      type="button"
                      data-testid="slice-resume-btn"
                      onClick={() => void handleResumeDag()}
                      className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-2.5 py-1 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
                    >
                      <RefreshCw className="h-3.5 w-3.5" />
                      Resume Remaining
                    </button>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {activeJob.nodes.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    data-testid={`slice-node-${node.id}`}
                    data-status={node.status}
                    disabled={node.status !== 'done'}
                    onClick={() => void handleInspectNode(node)}
                    className={`flex flex-col items-start gap-1 rounded-md border p-2.5 text-left transition-colors ${STATUS_STYLE[node.status]} ${
                      node.status === 'done'
                        ? 'cursor-pointer hover:brightness-110'
                        : 'cursor-default'
                    }`}
                  >
                    <div className="flex w-full items-center justify-between gap-2">
                      <span className="truncate text-xs font-semibold">{node.label}</span>
                      <span className="shrink-0 font-mono text-[10px] uppercase">
                        {node.status}
                      </span>
                    </div>
                    {node.errorMessage && (
                      <span className="line-clamp-2 text-[10px] text-rose-200">
                        {node.errorMessage}
                      </span>
                    )}
                    {node.status === 'done' && (
                      <span className="text-[10px] text-emerald-300/80">
                        Click to inspect artifact →
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Completion Bar */}
          {activeJob?.status === 'completed' && (
            <div
              data-testid="slice-completion-bar"
              className="space-y-2.5 rounded-lg border border-emerald-500/45 bg-emerald-950/20 p-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-2 text-emerald-300">
                  <CheckCircle2 className="h-4 w-4 shrink-0" />
                  <span className="text-xs font-semibold">
                    Vertical Slice Complete — Ready for Playtest, `res://main.tscn` Godot Sync &
                    Sharing
                  </span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="slice-launch-playtest-btn"
                    onClick={() => void handleLaunchPlaytest()}
                    className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#1B1B20] px-3 py-1.5 text-xs font-medium text-zinc-100 hover:border-amber-500/60"
                  >
                    <Gamepad2 className="h-3.5 w-3.5 text-amber-400" />
                    Playtest Hero (M36)
                  </button>
                  <button
                    type="button"
                    data-testid="slice-sync-godot-btn"
                    onClick={() => void handleSyncToGodot()}
                    className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
                  >
                    <FolderSync className="h-3.5 w-3.5" />
                    Sync Full Slice to Godot (res://)
                  </button>
                  <button
                    type="button"
                    data-testid="slice-share-btn"
                    onClick={handleShareSliceBlueprint}
                    className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#1B1B20] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-sky-400"
                  >
                    <Link2 className="h-3.5 w-3.5 text-sky-400" />
                    Share `#share=`
                  </button>
                </div>
              </div>

              {syncMessage && (
                <p
                  data-testid="slice-sync-status"
                  className="rounded border border-emerald-500/35 bg-emerald-950/35 px-3 py-1.5 text-xs text-emerald-200"
                >
                  {syncMessage}
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function jobArtifactFallback(job: SliceJobRecord): string | undefined {
  return (
    job.nodes.find((n) => n.id === 'terrain_tileset')?.artifactId ??
    job.nodes.find((n) => n.id === 'golden_ref_hero')?.artifactId
  );
}
