import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckSquare, ClipboardCheck, Sparkles, Volume2 } from 'lucide-react';
import { decodeWav16 } from '../../audio/pcmPostProcess';
import type { PcmBuffer } from '../../audio/types';
import { db, repository } from '../../db/database';
import {
  buildBatchDryRunSummary,
  cleanupSupersededBatchBlobs,
  executeBatchRecipePlan,
  rollbackBatchRun,
  type BatchProgressEvent,
  type BatchRecipeOperations,
  type BatchRecipePlan,
  type BatchRunResult,
} from '../../processing/batchRunner';
import { decodePngBytesToRgba } from '../../processing/png';
import {
  auditAudioAsset,
  auditSpriteAsset,
  computeArtBibleHash,
  summarizeProjectAudit,
  type AssetAuditRow,
  type AuditAudioCategory,
  type AuditCheckId,
  type AuditSeverity,
} from '../../processing/projectAudit';
import type { ArtDirectorFinding, ArtDirectorQaReport } from '../../processing/artDirectorQaSchema';
import {
  computeQaSheetHash,
  packQaContactSheets,
  type QaSpriteEntry,
} from '../../processing/qaContactSheet';
import { BIOME_PRESETS, generateBiomeTile, type BiomeId } from '../../processing/sandboxBiomes';
import type { RgbaBuffer } from '../../processing/types';
import { useAppStore, type InspectorTab } from '../../store/useAppStore';
import { BlobImage } from '../components/BlobImage';
import { ArtDirectorQaPanel } from './ArtDirectorQaPanel';
import { BatchRunnerDrawer } from './BatchRunnerDrawer';

type AuditFilterMode = 'all' | 'fail' | 'warn' | 'stale' | 'sprites' | 'audio';

function inferAudioCategory(presetId: string): AuditAudioCategory {
  if (presetId.startsWith('bgm')) return 'bgm';
  if (presetId.startsWith('ambience')) return 'ambience';
  if (presetId.includes('ui')) return 'ui';
  if (presetId.startsWith('voice')) return 'voice';
  return 'sfx';
}

async function decodeSpriteBlobToRgba(blob: Blob): Promise<RgbaBuffer> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    const decoded = await decodePngBytesToRgba(bytes);
    return { width: decoded.width, height: decoded.height, data: decoded.rgba };
  } catch {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return { width: bitmap.width, height: bitmap.height, data: new Uint8ClampedArray(data.data) };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

const SEVERITY_BADGE_CLASSES: Record<AuditSeverity, string> = {
  pass: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25',
  warn: 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25',
  fail: 'border-rose-500/50 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30',
};

export function AuditMatrixView() {
  const {
    activeProject,
    spriteNodes,
    audioAssets,
    providers,
    refreshSpriteNodes,
    refreshAudioAssets,
    navigate,
  } = useAppStore();

  const [biomeId, setBiomeId] = useState<BiomeId>('dark-dungeon');
  const [requireNormalMap, setRequireNormalMap] = useState<boolean>(false);
  const [filterMode, setFilterMode] = useState<AuditFilterMode>('all');
  const [selectedIds, setSelectedIds] = useState<Record<string, boolean>>({});
  const [operations, setOperations] = useState<BatchRecipeOperations>({
    syncArtBiblePalette: true,
    rerunPixelFoundry: false,
    autoTraceMissingColliders: true,
    rebakePaletteLuts: true,
    normalizeAudioLufs: true,
  });
  const [batchMode, setBatchMode] = useState<'in-place' | 'fork-children'>('in-place');

  const [decodedSprites, setDecodedSprites] = useState<Record<string, RgbaBuffer>>({});
  const [decodedAudioPcm, setDecodedAudioPcm] = useState<Record<string, PcmBuffer>>({});
  const [goldenRefBuffer, setGoldenRefBuffer] = useState<RgbaBuffer | null>(null);
  const [qaReport, setQaReport] = useState<ArtDirectorQaReport | null>(null);
  const [qaFromCache, setQaFromCache] = useState<boolean>(false);
  const [isDecoding, setIsDecoding] = useState<boolean>(false);

  const [isRunningBatch, setIsRunningBatch] = useState<boolean>(false);
  const [batchProgress, setBatchProgress] = useState<BatchProgressEvent | null>(null);
  const [pendingBeforeScore, setPendingBeforeScore] = useState<{
    beforeScore: number;
    result: BatchRunResult;
  } | null>(null);
  const [lastRunOutcome, setLastRunOutcome] = useState<{
    beforeScore: number;
    afterScore: number;
    result: BatchRunResult;
  } | null>(null);

  const spriteCacheRef = useRef<Map<string, RgbaBuffer>>(new Map());
  const audioCacheRef = useRef<Map<string, PcmBuffer>>(new Map());
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeRollbackRef = useRef<boolean>(false);

  activeRollbackRef.current = Boolean(lastRunOutcome?.result.rollbackManifest.length);

  // Release any un-reverted session rollback blobs when leaving Screen 7
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      if (activeRollbackRef.current) {
        void cleanupSupersededBatchBlobs(db);
      }
    };
  }, []);

  const auditableSprites = useMemo(() => {
    const gen = spriteNodes.filter((n) => n.kind !== 'sketch');
    return gen.length > 0 ? gen : spriteNodes;
  }, [spriteNodes]);

  // Decode blobs into memory cache whenever sprite/audio blob IDs change
  useEffect(() => {
    let cancelled = false;
    setIsDecoding(true);

    void (async () => {
      const nextSprites: Record<string, RgbaBuffer> = {};
      for (const node of auditableSprites) {
        const blobId = node.processedBlobId ?? node.imageBlobId;
        const cached = spriteCacheRef.current.get(blobId);
        if (cached) {
          nextSprites[blobId] = cached;
          continue;
        }
        const rec = await repository.getBlob(blobId);
        if (rec && !cancelled) {
          try {
            const buf = await decodeSpriteBlobToRgba(rec.bytes);
            spriteCacheRef.current.set(blobId, buf);
            nextSprites[blobId] = buf;
          } catch {
            // Skip unreadable blob cleanly
          }
        }
      }

      const nextAudio: Record<string, PcmBuffer> = {};
      for (const asset of audioAssets) {
        const cached = audioCacheRef.current.get(asset.wavBlobId);
        if (cached) {
          nextAudio[asset.wavBlobId] = cached;
          continue;
        }
        const rec = await repository.getBlob(asset.wavBlobId);
        if (rec && !cancelled) {
          try {
            const bytes = new Uint8Array(await rec.bytes.arrayBuffer());
            const pcm = decodeWav16(bytes);
            audioCacheRef.current.set(asset.wavBlobId, pcm);
            nextAudio[asset.wavBlobId] = pcm;
          } catch {
            // Fall back to stored LUFS metadata
          }
        }
      }

      if (!cancelled) {
        let nextRef: RgbaBuffer | null = null;
        const refBlobId = activeProject?.artBible.goldenReferenceBlobIds[0];
        if (refBlobId) {
          const cachedRef = spriteCacheRef.current.get(refBlobId);
          if (cachedRef) {
            nextRef = cachedRef;
          } else {
            const rec = await repository.getBlob(refBlobId);
            if (rec && !cancelled) {
              try {
                nextRef = await decodeSpriteBlobToRgba(rec.bytes);
                spriteCacheRef.current.set(refBlobId, nextRef);
              } catch {
                nextRef = null;
              }
            }
          }
        }
        if (!cancelled) {
          setGoldenRefBuffer(nextRef);
          setDecodedSprites(nextSprites);
          setDecodedAudioPcm(nextAudio);
          setIsDecoding(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProject?.artBible.goldenReferenceBlobIds, auditableSprites, audioAssets]);

  const qaEntries = useMemo<QaSpriteEntry[]>(() => {
    const list: QaSpriteEntry[] = [];
    if (goldenRefBuffer && activeProject?.artBible.goldenReferenceBlobIds[0]) {
      list.push({
        spriteId: `ref:${activeProject.artBible.goldenReferenceBlobIds[0]}`,
        slug: '00-golden-reference',
        isGoldenRef: true,
        buffer: goldenRefBuffer,
      });
    }
    for (const node of auditableSprites) {
      const blobId = node.processedBlobId ?? node.imageBlobId;
      const buf = decodedSprites[blobId];
      if (!buf) continue;
      list.push({
        spriteId: node.id,
        slug: `${node.kind}-${String(node.generationMeta.seed).padStart(4, '0')}-${node.id.slice(0, 6)}`,
        buffer: buf,
      });
    }
    return list;
  }, [
    activeProject?.artBible.goldenReferenceBlobIds,
    auditableSprites,
    decodedSprites,
    goldenRefBuffer,
  ]);

  // Hydrate cached Visual QA report from Dexie on project load / sprite update
  useEffect(() => {
    if (!activeProject) {
      setQaReport(null);
      setQaFromCache(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const cached = await repository.getQaReport(activeProject.id);
      if (cancelled) return;
      if (!cached) {
        setQaReport(null);
        setQaFromCache(false);
        return;
      }
      if (qaEntries.length > 0) {
        const sheets = packQaContactSheets(qaEntries);
        const currentHash = await computeQaSheetHash(
          sheets,
          computeArtBibleHash(activeProject.artBible),
        );
        if (!cancelled) {
          setQaReport(cached);
          setQaFromCache(cached.sheetHash === currentHash);
        }
      } else {
        setQaReport(cached);
        setQaFromCache(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeProject, qaEntries]);

  const qaFindingBySpriteId = useMemo(() => {
    const map = new Map<string, ArtDirectorFinding>();
    for (const finding of qaReport?.findings ?? []) {
      const prev = map.get(finding.spriteId);
      const rank = (s: AuditSeverity) => (s === 'fail' ? 3 : s === 'warn' ? 2 : 1);
      if (!prev || rank(finding.severity) > rank(prev.severity)) {
        map.set(finding.spriteId, finding);
      }
    }
    return map;
  }, [qaReport]);

  const biomeTile = useMemo(() => generateBiomeTile(biomeId, 64), [biomeId]);

  const auditReport = useMemo(() => {
    if (!activeProject) {
      return summarizeProjectAudit([]);
    }
    const currentHash = computeArtBibleHash(activeProject.artBible);
    const rows: AssetAuditRow[] = [];

    for (const node of auditableSprites) {
      const blobId = node.processedBlobId ?? node.imageBlobId;
      const buf = decodedSprites[blobId];
      if (!buf) continue;
      rows.push(
        auditSpriteAsset({
          nodeId: node.id,
          name: `${node.kind} #${node.generationMeta.seed}`,
          processedBuffer: buf,
          artMode: activeProject.artBible.artMode,
          artBiblePaletteHex: activeProject.artBible.palette,
          currentArtBibleHash: currentHash,
          nodeArtBibleHash: node.recipeArtBibleHash,
          requireNormalMap,
          hasNormalMap: false,
          hasCollider: Boolean(node.collisionShapes && node.collisionShapes.length > 0),
          biomeTile,
        }),
      );
    }

    for (const asset of audioAssets) {
      const pcm = decodedAudioPcm[asset.wavBlobId];
      const category = inferAudioCategory(asset.presetId);
      rows.push(
        auditAudioAsset({
          assetId: asset.id,
          name: asset.name,
          category,
          ...(pcm ? { pcm } : { measuredLufs: asset.lufs }),
          targetLufs: asset.postProcess.targetLufs,
        }),
      );
    }

    return summarizeProjectAudit(rows);
  }, [
    activeProject,
    auditableSprites,
    audioAssets,
    decodedSprites,
    decodedAudioPcm,
    requireNormalMap,
    biomeTile,
  ]);

  // Finalize Before -> After banner once fresh blobs finish decoding after a batch run
  useEffect(() => {
    if (!pendingBeforeScore || isDecoding) return;
    setLastRunOutcome({
      beforeScore: pendingBeforeScore.beforeScore,
      afterScore: auditReport.readinessScore,
      result: pendingBeforeScore.result,
    });
    setPendingBeforeScore(null);
  }, [pendingBeforeScore, isDecoding, auditReport.readinessScore]);

  const visibleRows = useMemo(() => {
    return auditReport.rows.filter((row) => {
      if (filterMode === 'fail') return row.worstSeverity === 'fail';
      if (filterMode === 'warn') return row.worstSeverity !== 'pass';
      if (filterMode === 'stale') return row.isStale;
      if (filterMode === 'sprites') return row.assetKind === 'sprite';
      if (filterMode === 'audio') return row.assetKind === 'audio';
      return true;
    });
  }, [auditReport.rows, filterMode]);

  const activeAssetIds = useMemo(
    () => auditReport.rows.filter((r) => selectedIds[r.assetId]).map((r) => r.assetId),
    [auditReport.rows, selectedIds],
  );

  const plan: BatchRecipePlan = useMemo(
    () => ({
      assetIds: activeAssetIds,
      mode: batchMode,
      operations,
    }),
    [activeAssetIds, batchMode, operations],
  );

  const dryRun = useMemo(
    () => buildBatchDryRunSummary(auditReport.rows, plan),
    [auditReport.rows, plan],
  );

  const handleSelectAll = () => {
    const next: Record<string, boolean> = {};
    for (const row of auditReport.rows) next[row.assetId] = true;
    setSelectedIds(next);
  };

  const handleSelectFailingOrStale = () => {
    const next: Record<string, boolean> = {};
    let hasMixelFail = false;
    for (const row of auditReport.rows) {
      if (row.worstSeverity !== 'pass' || row.isStale) {
        next[row.assetId] = true;
        if (row.checks.some((c) => c.checkId === 'mixel' && c.severity === 'fail')) {
          hasMixelFail = true;
        }
      }
    }
    setSelectedIds(next);
    setOperations((prev) => ({
      ...prev,
      syncArtBiblePalette: true,
      rerunPixelFoundry: hasMixelFail || prev.rerunPixelFoundry,
      autoTraceMissingColliders: true,
      rebakePaletteLuts: true,
      normalizeAudioLufs: true,
    }));
  };

  const handleRunBatch = async () => {
    if (!activeProject || activeAssetIds.length === 0 || isRunningBatch) return;
    if (lastRunOutcome) {
      setLastRunOutcome(null);
      await cleanupSupersededBatchBlobs(db);
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    const beforeScore = auditReport.readinessScore;
    setIsRunningBatch(true);
    setBatchProgress(null);

    try {
      const result = await executeBatchRecipePlan(
        db,
        activeProject.id,
        plan,
        {
          onProgress: (evt) => setBatchProgress(evt),
        },
        controller.signal,
      );
      await Promise.all([
        refreshSpriteNodes(activeProject.id),
        refreshAudioAssets(activeProject.id),
      ]);
      setPendingBeforeScore({ beforeScore, result });
    } finally {
      setIsRunningBatch(false);
    }
  };

  const handleCancelBatch = () => {
    abortControllerRef.current?.abort();
  };

  const handleUndoBatch = async () => {
    if (!activeProject || !lastRunOutcome || isRunningBatch) return;
    await rollbackBatchRun(db, lastRunOutcome.result.rollbackManifest);
    setLastRunOutcome(null);
    setPendingBeforeScore(null);
    await Promise.all([refreshSpriteNodes(activeProject.id), refreshAudioAssets(activeProject.id)]);
  };

  const handleJumpToFix = (row: AssetAuditRow, checkId: AuditCheckId) => {
    if (!activeProject) return;
    if (row.assetKind === 'audio' || checkId === 'audioLufs') {
      void navigate({ screen: 'audio', projectId: activeProject.id });
      return;
    }
    const tabMap: Record<Exclude<AuditCheckId, 'audioLufs'>, InspectorTab> = {
      collider: 'collider',
      normalMap: 'normal',
      palette: 'postprocess',
      mixel: 'postprocess',
      contrast: 'postprocess',
      recipeSync: 'postprocess',
    };
    void navigate({
      screen: 'inspector',
      projectId: activeProject.id,
      nodeId: row.assetId,
      initialTab: tabMap[checkId],
    });
  };

  const handleFixQaFinding = (finding: ArtDirectorFinding) => {
    if (!activeProject) return;
    if (finding.suggestedFix === 'regenerate') {
      void navigate({ screen: 'studio', projectId: activeProject.id });
      return;
    }
    if (finding.suggestedFix === 'sandbox-1x') {
      void navigate({
        screen: 'inspector',
        projectId: activeProject.id,
        nodeId: finding.spriteId,
        initialTab: 'sandbox',
      });
      return;
    }
    if (finding.suggestedFix === 'micro-editor') {
      void navigate({
        screen: 'inspector',
        projectId: activeProject.id,
        nodeId: finding.spriteId,
        initialTab: 'postprocess',
        initialPixelTool: 'pencil',
      });
      return;
    }
    void navigate({
      screen: 'inspector',
      projectId: activeProject.id,
      nodeId: finding.spriteId,
      initialTab: 'postprocess',
    });
  };

  if (!activeProject) {
    return (
      <div className="mx-auto mt-8 max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-300">
        Open a project first to run the Project-Wide Audit Matrix.
      </div>
    );
  }

  const columns: readonly { id: AuditCheckId; label: string }[] = [
    { id: 'palette', label: 'Palette' },
    { id: 'mixel', label: 'Mixel' },
    { id: 'contrast', label: '1× Contrast' },
    { id: 'collider', label: 'Collider' },
    ...(requireNormalMap ? [{ id: 'normalMap' as const, label: 'Normal Map' }] : []),
    { id: 'audioLufs', label: 'Audio LUFS' },
    { id: 'recipeSync', label: 'Recipe' },
  ];

  const scoreColor =
    auditReport.readinessScore >= 85
      ? 'border-emerald-400 text-emerald-300'
      : auditReport.readinessScore >= 60
        ? 'border-amber-400 text-amber-200'
        : 'border-rose-400 text-rose-200';

  return (
    <div
      data-testid="audit-matrix-view"
      className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_320px]"
    >
      {/* Left + Center: Top Telemetry Strip + Compliance Matrix */}
      <section className="flex min-w-0 flex-col bg-slate-950">
        {/* Top Telemetry Strip */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/70 px-4 py-3">
          <div className="flex items-center gap-3">
            <div
              data-testid="audit-readiness-score"
              className={`flex h-12 w-12 items-center justify-center rounded-full border-2 bg-slate-950 font-mono text-base font-bold ${scoreColor}`}
              title="Weighted Project Readiness Score (0-100)"
            >
              {auditReport.readinessScore}
            </div>
            <div>
              <h2 className="flex items-center gap-1.5 text-sm font-semibold text-slate-100">
                <ClipboardCheck className="h-4 w-4 text-indigo-400" />
                Project-Wide Audit Matrix
              </h2>
              <div className="flex flex-wrap gap-2 text-[11px] font-mono">
                <span className="text-emerald-300">{auditReport.passCount} Pass</span>
                <span className="text-amber-300">{auditReport.warnCount} Warn</span>
                <span className="text-rose-300">{auditReport.failCount} Fail</span>
                <span className="text-cyan-300">{auditReport.staleCount} Stale</span>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <label className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
              <span>Target Biome:</span>
              <select
                data-testid="audit-biome-select"
                value={biomeId}
                onChange={(e) => setBiomeId(e.target.value as BiomeId)}
                className="bg-transparent font-medium text-slate-100 focus:outline-none"
              >
                {BIOME_PRESETS.map((b) => (
                  <option key={b.id} value={b.id} className="bg-slate-900">
                    {b.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={requireNormalMap}
                onChange={(e) => setRequireNormalMap(e.target.checked)}
                className="accent-indigo-500"
              />
              Require _n.png
            </label>

            <button
              type="button"
              data-testid="audit-fix-all-btn"
              onClick={handleSelectFailingOrStale}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 font-semibold text-white hover:bg-indigo-500"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Fix All Stale &amp; Failing
            </button>
          </div>
        </div>

        {/* Filter & Multi-Select Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2 text-[11px]">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ['all', 'All'],
                ['fail', 'Failing'],
                ['warn', 'Warnings+Fails'],
                ['stale', 'Stale'],
                ['sprites', 'Sprites'],
                ['audio', 'Audio'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                data-testid={`audit-filter-${id}`}
                onClick={() => setFilterMode(id)}
                className={`rounded border px-2 py-0.5 uppercase ${
                  filterMode === id
                    ? 'border-indigo-500 bg-indigo-600 font-semibold text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="audit-select-all-btn"
              onClick={handleSelectAll}
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-200 hover:bg-slate-800"
            >
              <CheckSquare className="h-3 w-3" />
              Select All
            </button>
            <button
              type="button"
              data-testid="audit-select-failing-btn"
              onClick={handleSelectFailingOrStale}
              className="rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-rose-200 hover:bg-rose-500/25"
            >
              Select Failing &amp; Stale
            </button>
          </div>
        </div>

        {/* M32: Vision-LLM Art Director Visual QA Panel */}
        <ArtDirectorQaPanel
          project={activeProject}
          entries={qaEntries}
          providers={providers}
          report={qaReport}
          fromCache={qaFromCache}
          onReportUpdated={(nextReport, cached) => {
            setQaReport(nextReport);
            setQaFromCache(cached);
          }}
          onFixFinding={handleFixQaFinding}
        />

        {/* Matrix Table */}
        <div className="flex-1 overflow-auto p-4">
          {visibleRows.length === 0 ? (
            <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-8 text-center text-xs text-slate-400">
              {isDecoding
                ? 'Scanning IndexedDB assets with pure-TS analyzers…'
                : 'No assets match the current filter.'}
            </div>
          ) : (
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 text-[11px] text-slate-400 uppercase">
                  <th className="py-2 pr-2">Sel</th>
                  <th className="py-2 pr-3">Asset</th>
                  {columns.map((col) => (
                    <th key={col.id} className="px-2 py-2">
                      {col.label}
                    </th>
                  ))}
                  <th className="px-2 py-2">Visual QA</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/70">
                {visibleRows.map((row) => {
                  const spriteNode =
                    row.assetKind === 'sprite'
                      ? auditableSprites.find((s) => s.id === row.assetId)
                      : undefined;
                  const blobId = spriteNode
                    ? (spriteNode.processedBlobId ?? spriteNode.imageBlobId)
                    : undefined;
                  return (
                    <tr
                      key={row.assetId}
                      data-testid={`audit-row-${row.assetId}`}
                      className="hover:bg-slate-900/50"
                    >
                      <td className="py-2 pr-2">
                        <input
                          type="checkbox"
                          data-testid={`audit-row-check-${row.assetId}`}
                          checked={Boolean(selectedIds[row.assetId])}
                          onChange={(e) =>
                            setSelectedIds((prev) => ({
                              ...prev,
                              [row.assetId]: e.target.checked,
                            }))
                          }
                          className="accent-indigo-500"
                        />
                      </td>
                      <td className="py-2 pr-3">
                        <div className="flex items-center gap-2.5">
                          {row.assetKind === 'sprite' && blobId ? (
                            <BlobImage
                              blobId={blobId}
                              alt={row.name}
                              artMode={activeProject.artBible.artMode}
                              className="bg-checkerboard h-9 w-9 rounded border border-slate-700 object-contain"
                            />
                          ) : (
                            <div className="flex h-9 w-9 items-center justify-center rounded border border-slate-700 bg-slate-900 text-cyan-300">
                              <Volume2 className="h-4 w-4" />
                            </div>
                          )}
                          <div className="min-w-0">
                            <div className="truncate font-medium text-slate-100">{row.name}</div>
                            <div className="font-mono text-[10px] text-slate-400 uppercase">
                              {row.assetKind}
                            </div>
                          </div>
                        </div>
                      </td>
                      {columns.map((col) => {
                        const check = row.checks.find((c) => c.checkId === col.id);
                        if (!check) {
                          return (
                            <td key={col.id} className="px-2 py-2 text-[11px] text-slate-600">
                              —
                            </td>
                          );
                        }
                        return (
                          <td key={col.id} className="px-2 py-2">
                            <button
                              type="button"
                              data-testid={`audit-cell-${row.assetId}-${check.checkId}`}
                              data-severity={check.severity}
                              title={`${check.detail} (Click to inspect)`}
                              onClick={() => handleJumpToFix(row, check.checkId)}
                              className={`rounded border px-2 py-0.5 font-mono text-[10px] font-medium whitespace-nowrap ${SEVERITY_BADGE_CLASSES[check.severity]}`}
                            >
                              {check.metricLabel}
                            </button>
                          </td>
                        );
                      })}
                      <td className="px-2 py-2">
                        {(() => {
                          if (row.assetKind !== 'sprite') {
                            return <span className="text-[11px] text-slate-600">—</span>;
                          }
                          const qaFinding = qaFindingBySpriteId.get(row.assetId);
                          if (!qaFinding) {
                            return <span className="text-[11px] text-slate-600">—</span>;
                          }
                          const label =
                            qaFinding.severity === 'fail'
                              ? 'Fail'
                              : qaFinding.severity === 'warn'
                                ? 'Warn'
                                : 'Pass';
                          return (
                            <button
                              type="button"
                              data-testid={`audit-cell-${row.assetId}-visualQa`}
                              data-severity={qaFinding.severity}
                              title={`${qaFinding.summary} (Click to fix)`}
                              onClick={() => handleFixQaFinding(qaFinding)}
                              className={`rounded border px-2 py-0.5 font-mono text-[10px] font-medium whitespace-nowrap ${SEVERITY_BADGE_CLASSES[qaFinding.severity]}`}
                            >
                              {label}
                            </button>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>

      {/* Right Drawer: Batch Recipe Runner */}
      <BatchRunnerDrawer
        plan={plan}
        dryRun={dryRun}
        isRunning={isRunningBatch}
        progress={batchProgress}
        lastRunOutcome={lastRunOutcome}
        onChangeOperations={(patch) => setOperations((prev) => ({ ...prev, ...patch }))}
        onChangeMode={setBatchMode}
        onRunBatch={() => void handleRunBatch()}
        onCancelBatch={handleCancelBatch}
        onUndoBatch={() => void handleUndoBatch()}
      />
    </div>
  );
}
