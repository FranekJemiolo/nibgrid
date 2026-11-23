import { Dices, Paintbrush, Sparkles, Wand2, X } from 'lucide-react';
import { compilePrompt } from '../../domain/promptCompiler';
import type { AdherenceLevel, ArtBible, ProviderConfig, SpriteNode } from '../../domain/schemas';
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
}: GenerationInspectorProps) {
  const activeConfig = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
  const adapter = activeConfig ? resolveProviderAdapter(activeConfig) : null;
  const compiled = compilePrompt(artBible, { adherence, promptDelta });

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
      className="flex flex-col gap-4 overflow-y-auto border-t border-slate-800 bg-slate-900/50 p-4 lg:border-t-0 lg:border-l"
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
