import { useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  FileArchive,
  FolderSync,
  Gamepad2,
  Loader2,
  Play,
  RefreshCw,
  Rocket,
  ShieldCheck,
  Sparkles,
  XCircle,
} from 'lucide-react';
import { createDefaultMockProviderConfig, db, repository } from '../../db/database';
import type { GodotGraphValidationReport } from '../../export/godotProjectCompiler';
import {
  createSliceJobRecord,
  invalidateStaleDagNodes,
  runSliceDag,
  type SliceDagNode,
  type SliceJobRecord,
  type SliceNodeStatus,
} from '../../processing/sliceDagRunner';
import {
  estimateSliceCostUsd,
  type SliceExecutionTier,
  type SliceGenre,
  type SliceScope,
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
  collectAndValidateProjectGodotSyncFiles,
  downloadGodotSyncZip,
  getBoundDirectoryHandle,
  isFsaaSupported,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';
import { BlobImage } from '../components/BlobImage';

const DIRECTOR_PITCH_PRESETS: readonly {
  readonly label: string;
  readonly genre: SliceGenre;
  readonly scope: SliceScope;
  readonly prompt: string;
}[] = [
  {
    label: 'Gothic 3-Room Crypt',
    genre: 'side-platformer',
    scope: 'multi-room-dungeon',
    prompt:
      '16-bit gothic platformer: armored knight hero, 2 skeleton enemies, crypt stone tileset, moonlit parallax, gothic HUD, and a boss arena',
  },
  {
    label: 'Meadow Town & Boss',
    genre: 'top-down',
    scope: 'town-and-boss',
    prompt:
      'Sunlit top-down pixel RPG: forest ranger hero, mossy slime and goblin enemies, grass cliff tileset, meadow parallax, oak HUD, and sanctum clearing',
  },
  {
    label: 'Cyber Arena Slice',
    genre: 'side-platformer',
    scope: 'single-arena',
    prompt:
      'Neon cyberpunk platformer: blade runner hero, 2 security drones, steel grating tileset, rainy rooftop parallax, cyan HUD, and reactor arena',
  },
];

const STATUS_BADGE: Record<SliceNodeStatus, string> = {
  pending: 'border-zinc-700 bg-zinc-900/70 text-zinc-400',
  running: 'border-amber-500/60 bg-amber-500/15 text-amber-300',
  'awaiting-approval': 'border-sky-500/60 bg-sky-500/15 text-sky-300',
  done: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
  failed: 'border-rose-500/60 bg-rose-500/15 text-rose-300',
  aborted: 'border-orange-500/50 bg-orange-500/10 text-orange-300',
};

/**
 * Milestone 53: Minimal-input Director Studio Workspace (`#/project/:id/director`).
 * Guides the studio director from a single pitch + scope to an approved Visual Style Anchor,
 * reactive full-game DAG build (Cast, Multi-Room World Map, Balanced GameData, L10n, Self-Heal QA),
 * and validated turnkey Godot 4 `project.godot` + `main.tscn` sync.
 */
export function DirectorStudioView() {
  const {
    activeProject,
    spriteNodes,
    entities,
    rooms,
    audioAssets,
    sliceJobs,
    providers,
    selectedProviderId,
    navigate,
    saveSliceJobRecord,
    refreshProjects,
    refreshSpriteNodes,
    refreshEntities,
    refreshRooms,
    refreshWorldGraph,
    refreshGameDataRegistry,
    refreshNarrativeBundle,
    refreshSliceJobs,
    refreshSyncTarget,
  } = useAppStore();

  const [prompt, setPrompt] = useState(DIRECTOR_PITCH_PRESETS[0]!.prompt);
  const [genre, setGenre] = useState<SliceGenre>('side-platformer');
  const [scope, setScope] = useState<SliceScope>('multi-room-dungeon');
  const [tier, setTier] = useState<SliceExecutionTier>('instant-draft');
  const [activeJob, setActiveJob] = useState<SliceJobRecord | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [anchorBlobId, setAnchorBlobId] = useState<string | null>(null);
  const [graphReport, setGraphReport] = useState<GodotGraphValidationReport | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (isRunning) return;
    const latest = sliceJobs[0] ?? null;
    setActiveJob(latest);
    if (latest) {
      setGenre(latest.blueprint.genre);
      setScope(latest.blueprint.scope ?? 'multi-room-dungeon');
      setTier(latest.tier);
      setPrompt(latest.blueprint.artBiblePrompt);
    }
  }, [activeProject?.id, sliceJobs, isRunning]);

  const anchorArtifactId =
    activeJob?.nodes.find((n) => n.id === 'golden_ref_hero')?.artifactId ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!anchorArtifactId) {
      setAnchorBlobId(null);
      return;
    }
    const found = spriteNodes.find((n) => n.id === anchorArtifactId);
    if (found) {
      setAnchorBlobId(found.processedBlobId ?? found.imageBlobId);
      return;
    }
    void db.spriteNodes.get(anchorArtifactId).then((node) => {
      if (!cancelled && node) {
        setAnchorBlobId(node.processedBlobId ?? node.imageBlobId);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [anchorArtifactId, spriteNodes]);

  useEffect(() => {
    if (!activeProject || activeJob?.status !== 'completed') {
      setGraphReport(null);
      return;
    }
    let cancelled = false;
    const templateId =
      activeJob.blueprint.genre === 'top-down' ? 'top-down-action' : 'side-platformer';
    void collectAndValidateProjectGodotSyncFiles(
      db,
      activeProject,
      entities,
      spriteNodes,
      audioAssets,
      rooms,
      { gameKitTemplate: templateId },
    )
      .then((res) => {
        if (!cancelled) {
          setGraphReport(res.validation);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setGraphReport(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeProject, activeJob, entities, spriteNodes, audioAssets, rooms]);

  const previewBlueprint = useMemo(() => {
    if (activeJob) return activeJob.blueprint;
    return {
      ...buildMockVerticalSliceBlueprint(prompt, genre),
      scope,
      includeFullGameKit: true,
    };
  }, [activeJob, prompt, genre, scope]);

  const costEstimate = useMemo(
    () => estimateSliceCostUsd(previewBlueprint, tier),
    [previewBlueprint, tier],
  );

  const selectedProvider = useMemo(() => {
    if (tier === 'instant-draft') return createDefaultMockProviderConfig();
    return providers.find((p) => p.id === selectedProviderId) ?? createDefaultMockProviderConfig();
  }, [providers, selectedProviderId, tier]);

  if (!activeProject) {
    return (
      <div className="p-6 text-sm text-slate-400" data-testid="director-studio-view">
        Open or create a project to use Director Studio.
      </div>
    );
  }

  const refreshAll = async (projectId: string) => {
    await Promise.all([
      refreshProjects(),
      refreshSpriteNodes(projectId),
      refreshEntities(projectId),
      refreshRooms(projectId),
      refreshWorldGraph(projectId),
      refreshGameDataRegistry(projectId),
      refreshNarrativeBundle(projectId),
      refreshSliceJobs(projectId),
    ]);
  };

  const executeDag = async (startJob: SliceJobRecord, approvedAnchor: boolean) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setErrorMsg(null);
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
      await refreshAll(startJob.projectId);
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setErrorMsg(err instanceof Error ? err.message : 'Director build failed.');
      }
    } finally {
      abortRef.current = null;
      setIsRunning(false);
    }
  };

  const handleStartPlan = async () => {
    if (isRunning || !prompt.trim()) return;
    setErrorMsg(null);
    setSyncMessage(null);
    try {
      const plannerProvider =
        tier === 'instant-draft' ? createDefaultMockProviderConfig() : selectedProvider;
      const drafted = await draftVerticalSliceBlueprint({
        prompt,
        genre,
        providerConfig: plannerProvider,
      });
      const enrichedBlueprint = {
        ...drafted.blueprint,
        scope,
        includeFullGameKit: true,
      };
      const freshJob = createSliceJobRecord(activeProject.id, enrichedBlueprint, tier);
      setActiveJob(freshJob);
      await saveSliceJobRecord(freshJob);
      await executeDag(freshJob, false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to build production plan.');
    }
  };

  const handleEditCastName = async (index: number, nextPrompt: string) => {
    if (!activeJob || isRunning) return;
    const nextCast = activeJob.blueprint.cast.map((c, idx) =>
      idx === index ? { ...c, prompt: nextPrompt } : c,
    );
    const nextBp = { ...activeJob.blueprint, cast: nextCast };
    const invalidated = invalidateStaleDagNodes(activeJob, nextBp);
    setActiveJob(invalidated);
    await saveSliceJobRecord(invalidated);
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
    await executeDag(resetJob, false);
  };

  const handleApproveAndBuild = async () => {
    if (!activeJob || isRunning) return;
    await executeDag(activeJob, true);
  };

  const handleSyncToGodot = async (forceZip = false) => {
    if (!activeJob) return;
    setErrorMsg(null);
    try {
      const freshProj = (await repository.getProject(activeProject.id)) ?? activeProject;
      const files = await collectVerticalSliceGodotSyncFiles(db, freshProj, activeJob);

      if (forceZip || !isFsaaSupported()) {
        downloadGodotSyncZip(activeJob.blueprint.projectSlug, files);
        setSyncMessage(
          `Downloaded ${files.length} Godot 4 GameKit files (${activeJob.blueprint.projectSlug}_godot_sync.zip).`,
        );
        return;
      }

      const existingHandle = await getBoundDirectoryHandle(db, freshProj.id);
      if (!existingHandle) {
        await bindGodotDirectory(db, freshProj.id);
      }
      const res = await syncFilesToGodotDirectory(db, freshProj.id, files);
      await refreshSyncTarget(freshProj.id);
      setSyncMessage(
        `Synced ${res.writtenCount} file(s) (${files.length} total in GameKit) to "${res.folderName}" — press F5 in Godot 4.3+.`,
      );
    } catch (err) {
      if (!(err instanceof DOMException && err.name === 'AbortError')) {
        setErrorMsg(err instanceof Error ? err.message : 'Godot res:// sync failed.');
      }
    }
  };

  const handleInspectNode = async (node: SliceDagNode) => {
    if (node.status !== 'done') return;
    if (node.kind === 'art-bible') {
      await navigate({ screen: 'bible', projectId: activeProject.id });
    } else if (node.kind === 'entity') {
      await navigate({ screen: 'entities', projectId: activeProject.id });
    } else if (node.kind === 'world-graph') {
      await navigate({ screen: 'world', projectId: activeProject.id });
    } else if (node.kind === 'game-data') {
      await navigate({ screen: 'data', projectId: activeProject.id });
    } else if (node.kind === 'narrative-l10n') {
      await navigate({ screen: 'dialogue', projectId: activeProject.id });
    } else if (node.kind === 'visual-qa' || node.kind === 'self-heal-qa') {
      await navigate({ screen: 'audit', projectId: activeProject.id });
    } else if (node.kind === 'gamekit-bundle' || node.kind === 'main-scene') {
      await navigate({ screen: 'ship', projectId: activeProject.id });
    } else if (node.artifactId) {
      const tabMap: Partial<
        Record<
          SliceDagNode['kind'],
          'postprocess' | 'autotile' | 'parallax' | 'bmfont' | 'uikit' | 'room'
        >
      > = {
        'golden-ref': 'postprocess',
        tileset: 'autotile',
        parallax: 'parallax',
        bmfont: 'bmfont',
        'ui-theme': 'uikit',
        room: 'room',
      };
      await navigate({
        screen: 'inspector',
        projectId: activeProject.id,
        nodeId: node.artifactId,
        initialTab: tabMap[node.kind] ?? 'postprocess',
      });
    }
  };

  const anchorAwaiting = activeJob?.status === 'awaiting-approval';
  const completedCount = activeJob?.nodes.filter((n) => n.status === 'done').length ?? 0;
  const totalCount = activeJob?.nodes.length ?? 0;

  return (
    <div
      data-testid="director-studio-view"
      className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 sm:p-6"
    >
      {/* Header Banner */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-5 py-3.5">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40">
            <Sparkles className="h-4 w-4" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-zinc-100">
              Director Studio · Minimal-Input Full Godot 4 Game Builder
            </h2>
            <p className="text-[11px] text-zinc-400">
              Pitch → Production Plan → Style Anchor Gate → Reactive Multi-Room DAG → Self-Healing
              QA → Turnkey Godot 4 GameKit
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {graphReport && (
            <span
              data-testid="director-integrity-badge"
              className={`rounded-full border px-2.5 py-0.5 font-mono text-[11px] font-medium ${
                graphReport.ok
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                  : 'border-rose-500/40 bg-rose-500/15 text-rose-200'
              }`}
            >
              {graphReport.brokenReferences.length} broken res:// refs · {graphReport.totalFiles}{' '}
              files
            </span>
          )}
          <span className="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 font-mono text-[11px] text-emerald-300">
            {costEstimate.label}
          </span>
        </div>
      </div>

      {/* 1. Creative Brief & Scope */}
      <section className="space-y-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">
            1. Creative Brief &amp; Production Scope
          </span>
          <div className="flex flex-wrap gap-1.5">
            {DIRECTOR_PITCH_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                disabled={isRunning}
                onClick={() => {
                  setPrompt(preset.prompt);
                  setGenre(preset.genre);
                  setScope(preset.scope);
                }}
                className="rounded border border-[#2E2E35] bg-[#1B1B20] px-2.5 py-1 text-[11px] text-zinc-300 hover:border-amber-500/50 hover:text-amber-300 disabled:opacity-50"
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <textarea
          data-testid="director-prompt-input"
          rows={2}
          value={prompt}
          disabled={isRunning}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Describe your game world, hero, enemies, biome, and mood..."
          className="w-full rounded-md border border-[#2E2E35] bg-[#16161B] p-2.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500/60 focus:outline-none disabled:opacity-60"
        />

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <label className="space-y-1 text-[11px] text-zinc-400">
            <span>Genre</span>
            <select
              data-testid="director-genre-select"
              value={genre}
              disabled={isRunning}
              onChange={(e) => setGenre(e.target.value as SliceGenre)}
              className="w-full rounded border border-[#2E2E35] bg-[#16161B] px-2.5 py-1.5 text-xs text-zinc-100"
            >
              <option value="side-platformer">Side-Platformer</option>
              <option value="top-down">Top-Down RPG</option>
              <option value="twin-stick">Twin-Stick Arena</option>
            </select>
          </label>

          <label className="space-y-1 text-[11px] text-zinc-400">
            <span>Game Scope</span>
            <select
              data-testid="director-scope-select"
              value={scope}
              disabled={isRunning}
              onChange={(e) => setScope(e.target.value as SliceScope)}
              className="w-full rounded border border-[#2E2E35] bg-[#16161B] px-2.5 py-1.5 text-xs text-zinc-100"
            >
              <option value="multi-room-dungeon">3-Room Dungeon Loop</option>
              <option value="town-and-boss">Town + Boss Sanctum</option>
              <option value="single-arena">Single Arena Slice</option>
            </select>
          </label>

          <label className="space-y-1 text-[11px] text-zinc-400">
            <span>Execution Tier</span>
            <select
              data-testid="director-tier-select"
              value={tier}
              disabled={isRunning}
              onChange={(e) => setTier(e.target.value as SliceExecutionTier)}
              className="w-full rounded border border-[#2E2E35] bg-[#16161B] px-2.5 py-1.5 text-xs text-zinc-100"
            >
              <option value="instant-draft">Instant Draft ($0.00 Local)</option>
              <option value="hybrid-prod">Hybrid Production</option>
              <option value="full-genai">Full GenAI Production</option>
            </select>
          </label>

          <div className="flex items-end">
            <button
              type="button"
              data-testid="director-start-btn"
              disabled={isRunning || !prompt.trim()}
              onClick={() => void handleStartPlan()}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
            >
              {isRunning ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
              Plan &amp; Lock Style Anchor
            </button>
          </div>
        </div>
      </section>

      {errorMsg && (
        <div className="flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-950/35 px-3 py-2 text-xs text-rose-200">
          <XCircle className="h-4 w-4 shrink-0 text-rose-400" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* 2. Golden Reference Visual Approval Gate */}
      {anchorAwaiting && activeJob && (
        <section
          data-testid="director-anchor-gate"
          className="space-y-3 rounded-xl border border-sky-500/45 bg-sky-950/20 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[11px] font-semibold tracking-wider text-sky-300 uppercase">
                2. Visual Style Anchor Gate
              </p>
              <p className="text-xs text-zinc-300">
                Approve the locked palette and Hero Anchor before launching all {totalCount - 2}{' '}
                downstream production stages.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="director-reroll-anchor-btn"
                disabled={isRunning}
                onClick={() => void handleRerollAnchor()}
                className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#1B1B20] px-2.5 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                Re-Roll Anchor
              </button>
              <button
                type="button"
                data-testid="director-approve-build-btn"
                disabled={isRunning}
                onClick={() => void handleApproveAndBuild()}
                className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                Approve Style &amp; Build Full Godot Game
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-5 rounded-md border border-[#26262C] bg-[#121215] p-3">
            {anchorBlobId && (
              <div className="flex items-center gap-3">
                <BlobImage
                  blobId={anchorBlobId}
                  alt="Hero anchor 1x"
                  artMode={activeJob.blueprint.artMode === 'hd-handdrawn' ? 'hd-2d' : 'pixel-art'}
                  className="h-16 w-16 rounded border border-[#2A2A2E] bg-[#1B1B20]"
                />
                <BlobImage
                  blobId={anchorBlobId}
                  alt="Hero anchor 2x"
                  artMode={activeJob.blueprint.artMode === 'hd-handdrawn' ? 'hd-2d' : 'pixel-art'}
                  className="h-24 w-24 rounded border border-[#2A2A2E] bg-[#1B1B20]"
                />
              </div>
            )}
            <div className="flex flex-1 flex-wrap gap-1.5">
              {(activeJob.blueprint.paletteHex ?? []).map((hex) => (
                <span
                  key={hex}
                  className="inline-flex items-center gap-1 rounded border border-[#2E2E35] bg-[#1A1A1F] px-1.5 py-0.5 font-mono text-[10px] text-zinc-300"
                >
                  <span
                    className="inline-block h-3 w-3 rounded-sm border border-white/20"
                    style={{ backgroundColor: hex }}
                  />
                  {hex}
                </span>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* 3. Editable Production Plan Cards + Reactive DAG */}
      {activeJob && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <section className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-4 lg:col-span-4">
            <h3 className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">
              Editable Cast Roster (Reactive)
            </h3>
            <p className="text-[11px] text-zinc-500">
              Tweaking a cast prompt invalidates only that entity&apos;s branch without rebuilding
              the rest of the game.
            </p>
            <div className="space-y-2">
              {activeJob.blueprint.cast.map((member, idx) => (
                <div
                  key={member.slug}
                  className="space-y-1 rounded-md border border-[#2A2A2E] bg-[#141418] p-2.5"
                >
                  <div className="flex items-center justify-between text-[11px]">
                    <span className="font-mono font-semibold text-zinc-100">{member.slug}</span>
                    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-amber-300 uppercase">
                      {member.role}
                    </span>
                  </div>
                  <input
                    type="text"
                    value={member.prompt}
                    disabled={isRunning}
                    onChange={(e) => void handleEditCastName(idx, e.target.value)}
                    className="w-full rounded border border-[#2E2E35] bg-[#1A1A1F] px-2 py-1 text-[11px] text-zinc-200 focus:border-amber-500/60 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </section>

          <section
            data-testid="director-dag-board"
            className="space-y-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-4 lg:col-span-8"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold tracking-wider text-zinc-400 uppercase">
                3. Reactive Production DAG ({completedCount}/{totalCount} Done)
              </span>
              <span className="font-mono text-[11px] text-zinc-400">{activeJob.status}</span>
            </div>

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {activeJob.nodes.map((node) => (
                <button
                  key={node.id}
                  type="button"
                  data-testid={`director-node-${node.id}`}
                  data-status={node.status}
                  disabled={node.status !== 'done'}
                  onClick={() => void handleInspectNode(node)}
                  className={`flex flex-col items-start gap-1 rounded-md border p-2.5 text-left transition-colors ${STATUS_BADGE[node.status]} ${
                    node.status === 'done'
                      ? 'cursor-pointer hover:brightness-110'
                      : 'cursor-default'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold">{node.label}</span>
                    <span className="shrink-0 font-mono text-[10px] uppercase">{node.status}</span>
                  </div>
                  {node.status === 'done' && (
                    <span className="text-[10px] text-emerald-300/80">Inspect →</span>
                  )}
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {/* 4. One-Click Delivery Bar */}
      {activeJob?.status === 'completed' && (
        <section
          data-testid="director-completion-bar"
          className="space-y-2.5 rounded-xl border border-emerald-500/45 bg-emerald-950/20 p-4"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-emerald-300">
              <CheckCircle2 className="h-4 w-4 shrink-0" />
              <span className="text-xs font-semibold">
                Full Godot 4 Game Built &amp; Self-Healed — Ready for F5 Playtest &amp; res:// Sync
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                data-testid="director-playtest-btn"
                onClick={() =>
                  void navigate({
                    screen: 'entities',
                    projectId: activeProject.id,
                    ...(entities[0]?.id ? { playtestEntityId: entities[0].id } : {}),
                  })
                }
                className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#1B1B20] px-3 py-1.5 text-xs font-medium text-zinc-100 hover:border-amber-500/60"
              >
                <Gamepad2 className="h-3.5 w-3.5 text-amber-400" />
                Playtest Hero
              </button>
              <button
                type="button"
                data-testid="director-download-zip-btn"
                onClick={() => void handleSyncToGodot(true)}
                className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#1B1B20] px-3 py-1.5 text-xs font-medium text-zinc-100 hover:border-slate-500"
              >
                <FileArchive className="h-3.5 w-3.5" />
                Download Godot ZIP
              </button>
              <button
                type="button"
                data-testid="director-sync-godot-btn"
                onClick={() => void handleSyncToGodot(false)}
                className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500"
              >
                <FolderSync className="h-3.5 w-3.5" />
                Sync Full GameKit to Godot (res://)
              </button>
              <button
                type="button"
                onClick={() => void navigate({ screen: 'ship', projectId: activeProject.id })}
                className="inline-flex items-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-1.5 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20"
              >
                <Rocket className="h-3.5 w-3.5" />
                Ship Console
              </button>
            </div>
          </div>

          {syncMessage && (
            <p
              data-testid="director-sync-status"
              className="rounded border border-emerald-500/35 bg-emerald-950/35 px-3 py-1.5 text-xs text-emerald-200"
            >
              {syncMessage}
            </p>
          )}
        </section>
      )}
    </div>
  );
}
