import {
  Copy,
  Dices,
  Download,
  Paintbrush,
  ShieldAlert,
  Sparkles,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { compilePrompt, type PromptSheetLayout } from '../../domain/promptCompiler';
import type { AdherenceLevel, ArtBible, ProviderConfig, SpriteNode } from '../../domain/schemas';
import { selectStatefulInteractionChain } from '../../providers/antigravityBridgeProvider';
import type { BridgeCritiqueResponse } from '../../providers/bridgeContract';
import { resolveProviderAdapter } from '../../providers/registry';

interface GenerationInspectorProps {
  artBible: ArtBible;
  providers: ProviderConfig[];
  selectedProviderId: string;
  onSelectProvider: (id: string) => void;
  adherence: AdherenceLevel;
  onChangeAdherence: (adherence: AdherenceLevel) => void;
  promptDelta: string;
  onChangePromptDelta: (delta: string) => void;
  sheetMode?: PromptSheetLayout;
  onChangeSheetMode?: (mode: PromptSheetLayout) => void;
  seed: number;
  onChangeSeed: (seed: number) => void;
  variantCount: 1 | 2;
  onChangeVariantCount: (count: 1 | 2) => void;
  activeParentNode: SpriteNode | null;
  activeViewportNode: SpriteNode | null;
  maskPixelCount: number;
  isGenerating: boolean;
  onGenerate: () => void;
  onInpaint: () => void;
  onCancel?: () => void;
  onCopyAgentBrief?: () => void;
  onDownloadSketchForAgent?: () => void;
  onImportAgentSpriteFile?: (file: File) => void;
  bridgeCritique?: BridgeCritiqueResponse | null;
  onApplySuggestedDelta?: (delta: string) => void;
  chainNotice?: string | null;
}

export function GenerationInspector({
  artBible,
  providers,
  selectedProviderId,
  onSelectProvider,
  adherence,
  onChangeAdherence,
  promptDelta,
  onChangePromptDelta,
  sheetMode = 'single',
  onChangeSheetMode,
  seed,
  onChangeSeed,
  variantCount,
  onChangeVariantCount,
  activeParentNode,
  activeViewportNode,
  maskPixelCount,
  isGenerating,
  onGenerate,
  onInpaint,
  onCancel,
  onCopyAgentBrief,
  onDownloadSketchForAgent,
  onImportAgentSpriteFile,
  bridgeCritique,
  onApplySuggestedDelta,
  chainNotice,
}: GenerationInspectorProps) {
  const activeConfig = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
  const adapter = activeConfig ? resolveProviderAdapter(activeConfig) : null;
  const compiled = compilePrompt(artBible, { adherence, promptDelta, sheetLayout: sheetMode });
  const bridgeDecision =
    activeConfig?.kind === 'antigravity-bridge'
      ? selectStatefulInteractionChain(activeParentNode, activeConfig.id)
      : null;

  const costLabel = adapter
    ? adapter.estimateCost({
        config: activeConfig!,
        artBible,
        sketchRgba: new Uint8ClampedArray(4),
        sketchWidth: artBible.targetWidth,
        sketchHeight: artBible.targetHeight,
        sketchSha256: '0'.repeat(64),
        seed,
        adherence,
        promptDelta,
        compiledPrompt: compiled.fullCompiledPrompt,
        variantCount,
      }).label
    : '$0.00 — Local Mock';

  const randomizeSeed = () => {
    onChangeSeed(Math.floor(Math.random() * 999999) + 1);
  };

  return (
    <aside
      data-testid="studio-right-pane"
      className="flex min-w-0 flex-col gap-4 overflow-y-auto border-t border-slate-800 bg-slate-900/50 p-4 lg:border-t-0 lg:border-l"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
          Generation Inspector
        </h3>
        <span
          data-testid="cost-estimate-badge"
          className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
        >
          {costLabel}
        </span>
      </div>

      <label className="space-y-1 text-xs">
        <span className="font-medium text-slate-300">Provider</span>
        <select
          data-testid="provider-select"
          value={activeConfig?.id ?? ''}
          onChange={(e) => onSelectProvider(e.target.value)}
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
        >
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.displayName} ({provider.modelId})
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2.5">
        <label className="space-y-1 text-xs">
          <span className="font-medium text-slate-300">Sketch Adherence</span>
          <select
            data-testid="adherence-select"
            value={adherence}
            onChange={(e) => onChangeAdherence(e.target.value as AdherenceLevel)}
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value="strict">Strict</option>
            <option value="balanced">Balanced</option>
            <option value="loose">Loose</option>
          </select>
        </label>

        <label className="space-y-1 text-xs">
          <span className="font-medium text-slate-300">Variants</span>
          <select
            data-testid="variant-count-select"
            value={variantCount}
            onChange={(e) =>
              onChangeVariantCount(Number.parseInt(e.target.value, 10) === 2 ? 2 : 1)
            }
            className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
          >
            <option value={1}>1 Variant</option>
            <option value={2}>2 Variants</option>
          </select>
        </label>
      </div>

      {onChangeSheetMode && (
        <div className="space-y-1 text-xs">
          <span className="font-medium text-slate-300">Sheet Mode</span>
          <div className="grid grid-cols-3 gap-1 rounded-md border border-slate-800 bg-slate-950 p-1">
            {(
              [
                ['single', 'Single Sprite'],
                ['2x2', 'Turnaround (2×2)'],
                ['1x4', 'Turnaround (1×4)'],
              ] as const
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                data-testid={`sheet-mode-${mode}`}
                aria-pressed={sheetMode === mode}
                onClick={() => onChangeSheetMode(mode)}
                className={`rounded px-1.5 py-1 text-[11px] font-medium transition-colors ${
                  sheetMode === mode
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}

      <label className="space-y-1 text-xs">
        <span className="font-medium text-slate-300">Prompt Delta</span>
        <textarea
          rows={2}
          data-testid="prompt-delta-input"
          value={promptDelta}
          onChange={(e) => onChangePromptDelta(e.target.value)}
          placeholder="e.g., metallic armor trim, glowing visor"
          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
        />
      </label>

      <label className="space-y-1 text-xs">
        <span className="font-medium text-slate-300">Seed</span>
        <div className="flex gap-1.5">
          <input
            type="number"
            data-testid="seed-input"
            min={0}
            value={seed}
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              onChangeSeed(Number.isNaN(parsed) || parsed < 0 ? 0 : parsed);
            }}
            className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
          />
          <button
            type="button"
            data-testid="randomize-seed-btn"
            onClick={randomizeSeed}
            className="inline-flex items-center gap-1 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-700"
            title="Randomize Seed"
          >
            <Dices className="h-3.5 w-3.5" />
          </button>
        </div>
      </label>

      <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-2.5 text-[11px] text-slate-400">
        <div className="flex items-center justify-between">
          <span>Branch Parent:</span>
          <span data-testid="active-parent-badge" className="font-mono text-indigo-300">
            {activeParentNode
              ? `${activeParentNode.kind} #${activeParentNode.generationMeta.seed}`
              : 'New Sketch Root'}
          </span>
        </div>
        <div className="mt-1 flex items-center justify-between">
          <span>Inpaint Target:</span>
          <span className="font-mono text-rose-300">
            {activeViewportNode
              ? `${activeViewportNode.kind} (${maskPixelCount} masked px)`
              : 'No active node'}
          </span>
        </div>
        {bridgeDecision &&
          (bridgeDecision.usedStatefulChain || bridgeDecision.reAnchoredReason || chainNotice) && (
            <div className="mt-1.5 border-t border-slate-800 pt-1.5">
              <span
                data-testid="bridge-chain-badge"
                className={`inline-block rounded px-1.5 py-0.5 font-mono text-[10px] ${
                  bridgeDecision.usedStatefulChain
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {bridgeDecision.usedStatefulChain
                  ? `Stateful chain: ${bridgeDecision.previousInteractionId}`
                  : (bridgeDecision.reAnchoredReason ?? chainNotice)}
              </span>
            </div>
          )}
      </div>

      <div className="flex flex-col gap-2">
        <button
          type="button"
          data-testid="generate-btn"
          disabled={isGenerating}
          onClick={onGenerate}
          className="inline-flex items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {isGenerating
            ? 'Synthesizing...'
            : `Generate ${variantCount === 2 ? '2 Variants' : 'Sprite'}`}
        </button>

        <button
          type="button"
          data-testid="inpaint-btn"
          disabled={isGenerating || maskPixelCount === 0 || !activeViewportNode}
          onClick={onInpaint}
          className="inline-flex items-center justify-center gap-2 rounded-md border border-rose-500/40 bg-rose-600/20 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-600/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Wand2 className="h-3.5 w-3.5" />
          Inpaint Masked Region
        </button>

        {isGenerating && onCancel && (
          <button
            type="button"
            data-testid="cancel-generation-btn"
            onClick={onCancel}
            className="inline-flex items-center justify-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
          >
            <X className="h-3.5 w-3.5" />
            Cancel Generation
          </button>
        )}
      </div>

      {bridgeCritique && (
        <div
          data-testid="bridge-critique-card"
          className="space-y-2 rounded-lg border border-amber-500/35 bg-amber-950/20 p-3 text-xs"
        >
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-200">
              <ShieldAlert className="h-3.5 w-3.5" />
              Art Bible Critique
            </span>
            <span
              data-testid="bridge-critique-score"
              className={`rounded px-2 py-0.5 font-mono text-[11px] font-semibold ${
                bridgeCritique.passed
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-rose-500/20 text-rose-300'
              }`}
            >
              {bridgeCritique.score}/100
            </span>
          </div>

          {bridgeCritique.driftFlags.length > 0 && (
            <div data-testid="bridge-drift-flags" className="flex flex-wrap gap-1">
              {bridgeCritique.driftFlags.map((flag) => (
                <span
                  key={flag}
                  className="rounded border border-rose-500/30 bg-rose-500/15 px-1.5 py-0.5 font-mono text-[10px] text-rose-200"
                >
                  {flag}
                </span>
              ))}
            </div>
          )}

          <p className="text-[11px] leading-relaxed text-slate-300">{bridgeCritique.rationale}</p>

          {bridgeCritique.suggestedPromptDelta && onApplySuggestedDelta && (
            <button
              type="button"
              data-testid="apply-suggested-delta-btn"
              onClick={() => onApplySuggestedDelta(bridgeCritique.suggestedPromptDelta)}
              className="w-full rounded border border-indigo-500/40 bg-indigo-600/25 px-2.5 py-1.5 text-[11px] font-semibold text-indigo-200 hover:bg-indigo-600/40"
            >
              Apply Suggested Delta
            </button>
          )}
        </div>
      )}

      {activeConfig?.kind === 'antigravity-agent' && (
        <div
          data-testid="antigravity-handoff-panel"
          className="space-y-2 rounded-lg border border-indigo-500/35 bg-indigo-950/25 p-3"
        >
          <p className="text-[11px] font-semibold tracking-wider text-indigo-300 uppercase">
            Antigravity IDE Handoff
          </p>
          <p className="text-[11px] leading-relaxed text-slate-300">
            Copy the compiled brief for Antigravity IDE&apos;s image tool or import any
            agent-rendered PNG directly into the sprite DAG.
          </p>
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              data-testid="copy-agent-brief-btn"
              onClick={onCopyAgentBrief}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              <Copy className="h-3.5 w-3.5 text-indigo-400" />
              Copy Prompt Brief
            </button>
            <button
              type="button"
              data-testid="download-agent-sketch-btn"
              onClick={onDownloadSketchForAgent}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              <Download className="h-3.5 w-3.5 text-indigo-400" />
              Export Sketch PNG
            </button>
            <label className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25">
              <Upload className="h-3.5 w-3.5" />
              Import Agent PNG into DAG
              <input
                type="file"
                data-testid="import-agent-sprite-input"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = '';
                  if (file && onImportAgentSpriteFile) {
                    onImportAgentSpriteFile(file);
                  }
                }}
              />
            </label>
          </div>
        </div>
      )}

      <div className="space-y-1 border-t border-slate-800 pt-3">
        <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-400">
          <Paintbrush className="h-3 w-3 text-indigo-400" />
          <span>Compiled Style-Locked Prompt</span>
        </div>
        <p
          data-testid="compiled-prompt-preview"
          className="max-h-24 overflow-y-auto rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-slate-400"
        >
          {compiled.fullCompiledPrompt}
        </p>
      </div>
    </aside>
  );
}
