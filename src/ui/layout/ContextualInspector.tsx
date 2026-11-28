import { Sliders, Sparkles, Terminal } from 'lucide-react';
import {
  CURATED_CREATOR_PRESETS,
  useUxModeStore,
  type CreatorPresetMeta,
  type ProTechnicalDefaults,
} from '../../state/uxModeStore';
import { useAppStore } from '../../store/useAppStore';

const PRESET_PRO_DEFAULTS: Record<CreatorPresetMeta['id'], ProTechnicalDefaults> = {
  'crisp-16bit': { sobelBevelStrength: 2.0, rdpEpsilonPx: 1.25 },
  'cozy-handdrawn': { sobelBevelStrength: 1.5, rdpEpsilonPx: 1.5 },
  'dynamic-torchlight': { sobelBevelStrength: 3.0, rdpEpsilonPx: 1.0 },
};

/**
 * Progressive-disclosure Contextual Inspector:
 * - Creator Mode (default): curated 1-click presets & context card, hiding raw shaders/sliders.
 * - Pro Mode: reveals granular M0-M55 shader, Sobel bevel, RDP epsilon, and JSON schema controls.
 */
export function ContextualInspector() {
  const {
    mode,
    setMode,
    activePresetId,
    setActivePresetId,
    selectedContext,
    proDefaults,
    setProDefaults,
  } = useUxModeStore();
  const activeProject = useAppStore((s) => s.activeProject);
  const patchActiveArtBible = useAppStore((s) => s.patchActiveArtBible);

  const handleSelectPreset = (preset: CreatorPresetMeta) => {
    setActivePresetId(preset.id);
    setProDefaults(PRESET_PRO_DEFAULTS[preset.id]);
    if (activeProject) {
      void patchActiveArtBible({
        artMode: preset.defaultFilterMode === 'hand-drawn' ? 'hd-2d' : 'pixel-art',
      });
    }
  };

  const contextLabel = selectedContext
    ? `${selectedContext.kind.toUpperCase()}: ${selectedContext.label}`
    : 'Project Workspace';

  return (
    <aside
      data-testid="contextual-inspector"
      className="flex flex-col gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 text-xs text-slate-200"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 font-semibold text-white">
          <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
          <span>Contextual Inspector</span>
        </div>
        <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[10px] text-slate-300">
          {contextLabel}
        </span>
      </div>

      {/* Curated Creator Presets */}
      <div className="flex flex-col gap-1.5">
        <div className="text-[10px] font-semibold tracking-wider text-slate-400 uppercase">
          Smart Style Presets
        </div>
        {CURATED_CREATOR_PRESETS.map((preset) => {
          const active = activePresetId === preset.id;
          return (
            <button
              key={preset.id}
              type="button"
              data-testid={`creator-preset-${preset.id}`}
              onClick={() => handleSelectPreset(preset)}
              className={`rounded border px-2.5 py-2 text-left transition-colors ${
                active
                  ? 'border-indigo-400 bg-indigo-500/15 text-white'
                  : 'border-slate-800 bg-slate-900/60 text-slate-300 hover:border-slate-600'
              }`}
            >
              <div className="font-semibold">{preset.title}</div>
              <div className="mt-0.5 text-[11px] text-slate-400">{preset.summary}</div>
            </button>
          );
        })}
      </div>

      {mode === 'creator' ? (
        <div
          data-testid="creator-mode-hint"
          className="flex items-center justify-between rounded border border-slate-800 bg-slate-950/60 px-2.5 py-2 text-[11px] text-slate-400"
        >
          <span>
            Low-level shaders, bevel math &amp; JSON schemas are tucked away in Creator Mode.
          </span>
          <button
            type="button"
            onClick={() => setMode('pro')}
            className="ml-2 shrink-0 text-indigo-300 underline hover:text-white"
          >
            Pro Mode
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 border-t border-slate-800 pt-2.5">
          <div className="flex items-center gap-1.5 text-[10px] font-semibold tracking-wider text-amber-300 uppercase">
            <Sliders className="h-3 w-3" />
            <span>Pro Technical Parameters</span>
          </div>

          <label className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px] text-slate-300">
              <span>Sobel Normal Bevel Strength (1.0 - 4.0)</span>
              <span className="font-mono text-[10px] text-amber-300">
                {proDefaults.sobelBevelStrength.toFixed(2)}
              </span>
            </div>
            <input
              data-testid="pro-sobel-bevel-slider"
              type="range"
              min="1"
              max="4"
              step="0.25"
              value={proDefaults.sobelBevelStrength}
              onChange={(e) =>
                setProDefaults({ sobelBevelStrength: Number.parseFloat(e.target.value) })
              }
              className="accent-indigo-500"
            />
          </label>

          <label className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[11px] text-slate-300">
              <span>RDP Collider Epsilon (0.5 - 4.0 px)</span>
              <span className="font-mono text-[10px] text-amber-300">
                {proDefaults.rdpEpsilonPx.toFixed(2)} px
              </span>
            </div>
            <input
              data-testid="pro-rdp-epsilon-slider"
              type="range"
              min="0.5"
              max="4"
              step="0.25"
              value={proDefaults.rdpEpsilonPx}
              onChange={(e) => setProDefaults({ rdpEpsilonPx: Number.parseFloat(e.target.value) })}
              className="accent-indigo-500"
            />
          </label>

          <div
            data-testid="pro-raw-shader-panel"
            className="rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] text-slate-300"
          >
            <div className="mb-1 flex items-center gap-1 text-indigo-300">
              <Terminal className="h-3 w-3" />
              <span>shader_type canvas_item;</span>
            </div>
            <pre className="overflow-x-auto text-slate-400">
              {`uniform float hit_flash : hint_range(0.0, 1.0) = 0.0;`}
            </pre>
          </div>

          <div
            data-testid="pro-json-schema-panel"
            className="rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] text-slate-400"
          >
            Schema: GameDataRegistry v1 · EntityDefinition v3 · NarrativeBundle v1
          </div>
        </div>
      )}
    </aside>
  );
}
