import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Wrench,
} from 'lucide-react';
import { db } from '../../db/database';
import type { Project, ProviderConfig } from '../../domain/schemas';
import type {
  ArtDirectorFinding,
  ArtDirectorQaReport,
  QaIssueCategory,
  QaQuickFixTarget,
  QaSeverity,
} from '../../processing/artDirectorQaSchema';
import { packQaContactSheets, type QaSpriteEntry } from '../../processing/qaContactSheet';
import { estimateArtDirectorQaCost, runArtDirectorQaPass } from '../../providers/artDirectorQa';

export interface ArtDirectorQaPanelProps {
  project: Project;
  entries: readonly QaSpriteEntry[];
  providers: readonly ProviderConfig[];
  report: ArtDirectorQaReport | null;
  fromCache: boolean;
  onReportUpdated: (report: ArtDirectorQaReport, fromCache: boolean) => void;
  onFixFinding: (finding: ArtDirectorFinding) => void;
}

const CATEGORY_LABELS: Record<QaIssueCategory, string> = {
  'style-drift': 'Style Drift',
  'light-angle': 'Light Angle',
  'outline-inconsistency': 'Outline',
  'silhouette-readability': '1× Silhouette',
  'scale-proportion': 'Scale',
};

const FIX_LABELS: Record<QaQuickFixTarget, string> = {
  'micro-editor': 'Fix in Micro-Editor',
  'post-process': 'Open Post-Process',
  'sandbox-1x': 'Open 1× Sandbox',
  regenerate: 'Regenerate in Studio',
};

const SEVERITY_CARD_STYLES: Record<QaSeverity, string> = {
  pass: 'border-emerald-500/35 bg-emerald-950/20',
  warn: 'border-amber-500/45 bg-amber-950/25',
  fail: 'border-rose-500/50 bg-rose-950/30',
};

export function ArtDirectorQaPanel({
  project,
  entries,
  providers,
  report,
  fromCache,
  onReportUpdated,
  onFixFinding,
}: ArtDirectorQaPanelProps) {
  const [providerId, setProviderId] = useState<string>('offline-mock');
  const [pageIdx, setPageIdx] = useState(0);
  const [selectedIndexLabel, setSelectedIndexLabel] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const qaProviders = useMemo(() => {
    const filtered = providers.filter(
      (p) =>
        p.enabled && (p.kind === 'mock' || p.kind === 'gemini' || p.kind === 'antigravity-bridge'),
    );
    return filtered.length > 0 ? filtered : providers;
  }, [providers]);

  useEffect(() => {
    if (qaProviders.length === 0) return;
    if (qaProviders.some((p) => p.id === providerId)) return;
    const preferred =
      qaProviders.find((p) => p.kind === 'gemini' && p.apiKey.trim().length > 0) ??
      qaProviders.find((p) => p.kind === 'antigravity-bridge') ??
      qaProviders[0];
    if (preferred) setProviderId(preferred.id);
  }, [providerId, qaProviders]);

  const sheets = useMemo(() => packQaContactSheets(entries), [entries]);
  const safePageIdx = Math.min(pageIdx, Math.max(0, sheets.length - 1));
  const activeSheet = sheets[safePageIdx];

  const selectedProvider = qaProviders.find((p) => p.id === providerId) ?? qaProviders[0];
  const costEstimate = estimateArtDirectorQaCost(
    selectedProvider?.kind ?? 'mock',
    Math.max(1, sheets.length),
  );

  // Draw active contact sheet buffer onto Canvas2D
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSheet) return;
    canvas.width = activeSheet.sheet.width;
    canvas.height = activeSheet.sheet.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = project.artBible.artMode !== 'pixel-art';
    ctx.putImageData(
      new ImageData(
        new Uint8ClampedArray(activeSheet.sheet.data),
        activeSheet.sheet.width,
        activeSheet.sheet.height,
      ),
      0,
      0,
    );
  }, [activeSheet, project.artBible.artMode]);

  const handleRunQa = async (forceRefresh: boolean) => {
    if (!selectedProvider || entries.length === 0 || running) return;
    setRunning(true);
    setErrorMsg(null);
    try {
      const outcome = await runArtDirectorQaPass(
        db,
        project.id,
        entries,
        project.artBible,
        selectedProvider,
        { forceRefresh },
      );
      onReportUpdated(outcome.report, outcome.fromCache);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Visual QA run failed.');
    } finally {
      setRunning(false);
    }
  };

  const handleCanvasClick = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas || !activeSheet) return;
    const rect = canvas.getBoundingClientRect();
    const px = ((clientX - rect.left) / Math.max(1, rect.width)) * activeSheet.sheet.width;
    const py = ((clientY - rect.top) / Math.max(1, rect.height)) * activeSheet.sheet.height;
    const hit = activeSheet.cells.find(
      (c) =>
        px >= c.cellX &&
        px <= c.cellX + c.cellSizePx &&
        py >= c.cellY &&
        py <= c.cellY + c.cellSizePx,
    );
    if (hit) {
      setSelectedIndexLabel(hit.indexLabel === 'REF' ? null : hit.indexLabel);
    }
  };

  const visibleFindings = useMemo(() => {
    if (!report) return [];
    if (!selectedIndexLabel) return report.findings;
    const matching = report.findings.filter((f) => f.indexLabel === selectedIndexLabel);
    return matching.length > 0 ? matching : report.findings;
  }, [report, selectedIndexLabel]);

  return (
    <section
      data-testid="art-director-qa-panel"
      className="border-b border-slate-800 bg-slate-900/55 px-4 py-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Eye className="h-4 w-4 text-amber-400" />
          <div>
            <h3 className="text-xs font-semibold text-slate-100">
              Vision-LLM Art Director Visual QA
            </h3>
            <p className="text-[11px] text-slate-400">
              Checks light-angle drift, outline weights, 1× silhouettes &amp; Golden Reference
              cohesion across {entries.length} sprite(s).
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            data-testid="qa-provider-select"
            value={selectedProvider?.id ?? ''}
            onChange={(e) => setProviderId(e.target.value)}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
          >
            {qaProviders.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.displayName}
              </option>
            ))}
          </select>

          <span
            data-testid="qa-cost-badge"
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-[10px] text-amber-300"
          >
            {costEstimate.label}
          </span>

          {report && fromCache && (
            <span
              data-testid="qa-cached-badge"
              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 font-mono text-[10px] text-emerald-300"
            >
              Cached
            </span>
          )}

          {report && (
            <button
              type="button"
              data-testid="qa-force-rerun-btn"
              disabled={running || entries.length === 0}
              onClick={() => void handleRunQa(true)}
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-950 px-2.5 py-1 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              Force Re-Run
            </button>
          )}

          <button
            type="button"
            data-testid="qa-run-btn"
            disabled={running || entries.length === 0}
            onClick={() => void handleRunQa(false)}
            className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {running ? 'Reviewing Cast…' : 'Run Visual QA Pass (AI)'}
          </button>
        </div>
      </div>

      {errorMsg && (
        <p
          data-testid="qa-error-banner"
          className="mt-2 rounded border border-rose-500/40 bg-rose-950/40 px-3 py-1.5 text-xs text-rose-200"
        >
          {errorMsg}
        </p>
      )}

      {(activeSheet || report) && (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]">
          {/* Labeled Contact Sheet Thumbnail */}
          {activeSheet && (
            <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/75 p-2">
              <div className="flex items-center justify-between text-[10px] text-slate-400">
                <span>
                  Sheet {safePageIdx + 1}/{sheets.length} ({activeSheet.cells.length} cells)
                </span>
                {selectedIndexLabel && (
                  <button
                    type="button"
                    onClick={() => setSelectedIndexLabel(null)}
                    className="text-amber-300 underline"
                  >
                    Filter #{selectedIndexLabel} ×
                  </button>
                )}
              </div>

              <canvas
                ref={canvasRef}
                data-testid="qa-contact-sheet-canvas"
                onClick={(e) => handleCanvasClick(e.clientX, e.clientY)}
                className="max-h-56 w-full cursor-pointer rounded border border-slate-700 object-contain"
                style={{
                  imageRendering: project.artBible.artMode === 'pixel-art' ? 'pixelated' : 'auto',
                }}
                title="Click a sprite cell to filter findings"
              />

              {sheets.length > 1 && (
                <div className="flex justify-center gap-1 pt-1">
                  {sheets.map((_, idx) => (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setPageIdx(idx)}
                      className={`rounded px-2 py-0.5 font-mono text-[10px] ${
                        idx === safePageIdx
                          ? 'bg-amber-500 font-semibold text-zinc-950'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      P{idx + 1}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Structured Findings List */}
          <div className="space-y-2">
            {report ? (
              <>
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/75 px-3 py-2 text-xs">
                  <div className="flex items-center gap-2.5">
                    <span
                      data-testid="qa-overall-score"
                      className="rounded border border-amber-400/50 bg-amber-500/15 px-2 py-0.5 font-mono text-sm font-bold text-amber-200"
                    >
                      {report.overallScore}/100
                    </span>
                    <p data-testid="qa-global-notes" className="text-slate-200">
                      {report.globalNotes}
                    </p>
                  </div>
                </div>

                <div className="grid max-h-48 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {visibleFindings.map((finding) => (
                    <div
                      key={`${finding.indexLabel}-${finding.spriteId}`}
                      data-testid={`qa-finding-${finding.indexLabel}`}
                      data-severity={finding.severity}
                      className={`flex flex-col justify-between gap-2 rounded-lg border p-2.5 text-xs ${SEVERITY_CARD_STYLES[finding.severity]}`}
                    >
                      <div className="space-y-1">
                        <div className="flex items-center justify-between gap-1.5">
                          <div className="flex items-center gap-1.5">
                            {finding.severity === 'pass' ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-300" />
                            ) : finding.severity === 'fail' ? (
                              <ShieldAlert className="h-3.5 w-3.5 text-rose-300" />
                            ) : (
                              <AlertTriangle className="h-3.5 w-3.5 text-amber-300" />
                            )}
                            <span className="font-mono font-semibold text-slate-100">
                              Cell #{finding.indexLabel}
                            </span>
                            <span className="rounded bg-black/30 px-1.5 py-0.5 text-[10px] uppercase text-slate-200">
                              {finding.severity}
                            </span>
                          </div>
                          <span className="rounded border border-white/15 bg-black/25 px-1.5 py-0.5 text-[10px] text-slate-300">
                            {CATEGORY_LABELS[finding.category]}
                          </span>
                        </div>
                        <p className="text-[11px] leading-snug text-slate-200">{finding.summary}</p>
                      </div>

                      <div className="flex justify-end">
                        <button
                          type="button"
                          data-testid={`qa-fix-btn-${finding.indexLabel}`}
                          onClick={() => onFixFinding(finding)}
                          className="inline-flex items-center gap-1 rounded border border-slate-600 bg-slate-900 px-2 py-1 text-[11px] font-medium text-slate-100 hover:border-amber-400 hover:text-amber-200"
                        >
                          <Wrench className="h-3 w-3 text-amber-400" />
                          {FIX_LABELS[finding.suggestedFix]}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex h-full min-h-24 items-center justify-center rounded-lg border border-dashed border-slate-800 bg-slate-950/40 p-4 text-center text-xs text-slate-400">
                Click <strong className="mx-1 text-amber-300">Run Visual QA Pass (AI)</strong> to
                evaluate packed cast consistency (cached by SHA-256).
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
