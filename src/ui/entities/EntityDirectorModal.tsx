import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Circle, Loader2, Sparkles, Square, Wand2, X, XCircle } from 'lucide-react';
import { db } from '../../db/database';
import { sanitizeEntitySlug, type EntityDefinition } from '../../domain/entitySchema';
import type {
  DirectorBodyType,
  EntityDirectorBlueprint,
  EntityGenrePreset,
} from '../../processing/entityDirectorBlueprint';
import {
  draftEntityBlueprint,
  estimateDirectorCost,
  executeEntityDirectorPlan,
  type DirectorProgressEvent,
  type DirectorStageId,
  type DirectorStageStatus,
} from '../../providers/entityDirector';
import { useAppStore } from '../../store/useAppStore';

export interface EntityDirectorModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated?: (entity: EntityDefinition) => void;
}

const GENRE_OPTIONS: ReadonlyArray<{ readonly id: EntityGenrePreset; readonly label: string }> = [
  { id: 'side-platformer', label: 'Side-Platformer' },
  { id: 'top-down', label: 'Top-Down' },
  { id: 'twin-stick', label: 'Twin-Stick' },
  { id: 'prop-interactive', label: 'Interactive Prop' },
];

const BODY_TYPES: readonly DirectorBodyType[] = [
  'CharacterBody2D',
  'StaticBody2D',
  'Area2D',
  'RigidBody2D',
];

const STAGE_LABELS: ReadonlyArray<{ readonly id: DirectorStageId; readonly label: string }> = [
  { id: 'sprite', label: '1. Sprite & M7 Post-Process' },
  { id: 'collider', label: '2. M16 Collision Hulls & Hitboxes' },
  { id: 'sockets', label: '3. M21 Opaque-Bound Sockets' },
  { id: 'sfx', label: '4. M14/M15 SFX Pack + LUFS Trim' },
  { id: 'gdscript', label: '5. Typed Godot 4.3+ GDScript' },
  { id: 'commit', label: '6. Atomic M25 Entity Commit' },
];

function createInitialStageMap(): Record<
  DirectorStageId,
  { status: DirectorStageStatus; detail?: string }
> {
  return {
    sprite: { status: 'pending' },
    collider: { status: 'pending' },
    sockets: { status: 'pending' },
    sfx: { status: 'pending' },
    gdscript: { status: 'pending' },
    commit: { status: 'pending' },
  };
}

export function EntityDirectorModal({ open, onClose, onCreated }: EntityDirectorModalProps) {
  const {
    activeProject,
    providers,
    selectedProviderId,
    refreshSpriteNodes,
    refreshAudioAssets,
    refreshEntities,
  } = useAppStore();

  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [prompt, setPrompt] = useState(
    'Armored goblin scout, 32px pixel art, sword slash, heavy boots',
  );
  const [genre, setGenre] = useState<EntityGenrePreset>('side-platformer');
  const [providerId, setProviderId] = useState<string>(selectedProviderId);

  const [drafting, setDrafting] = useState(false);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [blueprint, setBlueprint] = useState<EntityDirectorBlueprint | null>(null);
  const [includeGdScript, setIncludeGdScript] = useState(true);

  const [building, setBuilding] = useState(false);
  const [buildError, setBuildError] = useState<string | null>(null);
  const [stages, setStages] = useState(createInitialStageMap);
  const [builtEntity, setBuiltEntity] = useState<EntityDefinition | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Sync default provider when modal opens
  useEffect(() => {
    if (!open) return;
    const configuredGemini = providers.find(
      (p) => p.kind === 'gemini' && p.enabled && p.apiKey.trim(),
    );
    setProviderId(configuredGemini?.id ?? selectedProviderId);
    setStep(1);
    setDraftError(null);
    setBuildError(null);
    setBuiltEntity(null);
    setStages(createInitialStageMap());
  }, [open, providers, selectedProviderId]);

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === providerId) ?? providers[0],
    [providers, providerId],
  );

  const costEstimate = useMemo(() => {
    if (!blueprint || !activeProvider) return null;
    return estimateDirectorCost(activeProvider.kind, blueprint, includeGdScript);
  }, [blueprint, activeProvider, includeGdScript]);

  if (!open || !activeProject || !activeProvider) return null;

  const handleDraftBlueprint = async () => {
    setDrafting(true);
    setDraftError(null);
    try {
      const res = await draftEntityBlueprint({
        prompt,
        genre,
        artBible: activeProject.artBible,
        providerConfig: activeProvider,
      });
      setBlueprint(res.blueprint);
      setStep(2);
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : 'Failed to draft entity blueprint.');
    } finally {
      setDrafting(false);
    }
  };

  const handleBuildEntity = async () => {
    if (!blueprint) return;
    const controller = new AbortController();
    abortRef.current = controller;

    setStep(3);
    setBuilding(true);
    setBuildError(null);
    setBuiltEntity(null);
    setStages(createInitialStageMap());

    try {
      const result = await executeEntityDirectorPlan(db, activeProject.id, blueprint, {
        providerConfig: activeProvider,
        generateGdScript: includeGdScript,
        signal: controller.signal,
        onProgress: (ev: DirectorProgressEvent) => {
          setStages((prev) => ({
            ...prev,
            [ev.stage]: { status: ev.status, detail: ev.detail },
          }));
        },
      });

      await Promise.all([
        refreshSpriteNodes(activeProject.id),
        refreshAudioAssets(activeProject.id),
        refreshEntities(activeProject.id),
      ]);
      setBuiltEntity(result.entity);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setBuildError('Build aborted cleanly. All temporary blobs were purged.');
      } else {
        setBuildError(err instanceof Error ? err.message : 'Failed to build entity.');
      }
    } finally {
      setBuilding(false);
      abortRef.current = null;
    }
  };

  const handleAbort = () => {
    abortRef.current?.abort();
  };

  const handleFinish = () => {
    if (builtEntity) {
      onCreated?.(builtEntity);
    }
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
      <div
        data-testid="entity-director-modal"
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] shadow-2xl"
      >
        <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-4 py-3">
          <div className="flex items-center gap-2">
            <Wand2 className="h-4 w-4 text-[#F5B82E]" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Prompt-to-Entity Director (Godot 4)
              </h3>
              <p className="text-[11px] text-slate-400">
                Step {step} of 3 ·{' '}
                {step === 1
                  ? 'Prompt & Genre'
                  : step === 2
                    ? 'Blueprint Review'
                    : 'Live Build Stream'}
              </p>
            </div>
          </div>

          <button
            type="button"
            disabled={building}
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4 text-xs">
          {step === 1 && (
            <div className="space-y-4">
              <label className="block space-y-1 text-slate-300">
                <span>AI / Local Provider</span>
                <select
                  data-testid="director-provider-select"
                  value={providerId}
                  onChange={(e) => setProviderId(e.target.value)}
                  className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-100"
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} ({p.kind === 'mock' ? '$0.00' : p.modelId})
                    </option>
                  ))}
                </select>
              </label>

              <div className="space-y-1.5">
                <span className="text-slate-300">Target Game Genre</span>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {GENRE_OPTIONS.map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      data-testid={`director-genre-${opt.id}`}
                      onClick={() => setGenre(opt.id)}
                      className={`rounded border px-2 py-1.5 text-[11px] font-medium ${
                        genre === opt.id
                          ? 'border-[#F5B82E] bg-[#F5B82E]/15 text-[#F5B82E]'
                          : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:text-white'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block space-y-1 text-slate-300">
                <span>Describe Your Entity (Visuals, Attacks & Sound Cues)</span>
                <textarea
                  data-testid="director-prompt-input"
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="Armored goblin scout, 32px pixel art, sword slash, heavy boots"
                  className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-2 text-slate-100"
                />
              </label>

              {draftError && (
                <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200">
                  {draftError}
                </p>
              )}
            </div>
          )}

          {step === 2 && blueprint && (
            <div className="space-y-4">
              {costEstimate && (
                <div
                  data-testid="director-cost-badge"
                  className="flex items-center justify-between rounded border border-[#F5B82E]/40 bg-[#F5B82E]/10 px-3 py-2 font-mono text-[11px] text-[#F5B82E]"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Sparkles className="h-3.5 w-3.5" />
                    {costEstimate.label}
                  </span>
                  <span>Ready to build</span>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <label className="space-y-1 text-slate-300">
                  <span>Display Name</span>
                  <input
                    type="text"
                    data-testid="director-bp-name"
                    value={blueprint.displayName}
                    onChange={(e) => setBlueprint({ ...blueprint, displayName: e.target.value })}
                    className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-100"
                  />
                </label>

                <label className="space-y-1 text-slate-300">
                  <span>Slug</span>
                  <input
                    type="text"
                    data-testid="director-bp-slug"
                    value={blueprint.slug}
                    onChange={(e) =>
                      setBlueprint({ ...blueprint, slug: sanitizeEntitySlug(e.target.value) })
                    }
                    className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 font-mono text-slate-100"
                  />
                </label>

                <label className="space-y-1 text-slate-300">
                  <span>Body Type</span>
                  <select
                    data-testid="director-bp-body-type"
                    value={blueprint.bodyType}
                    onChange={(e) =>
                      setBlueprint({ ...blueprint, bodyType: e.target.value as DirectorBodyType })
                    }
                    className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-100"
                  >
                    {BODY_TYPES.map((bt) => (
                      <option key={bt} value={bt}>
                        {bt}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-200">
                  <span>Normal Map</span>
                  <input
                    type="checkbox"
                    data-testid="director-bp-normal-toggle"
                    checked={blueprint.generateNormalMap}
                    onChange={(e) =>
                      setBlueprint({ ...blueprint, generateNormalMap: e.target.checked })
                    }
                    className="accent-[#F5B82E]"
                  />
                </label>
                <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-200">
                  <span>2×2 Turnaround</span>
                  <input
                    type="checkbox"
                    data-testid="director-bp-turnaround-toggle"
                    checked={blueprint.turnaroundLayout === '2x2'}
                    onChange={(e) =>
                      setBlueprint({
                        ...blueprint,
                        turnaroundLayout: e.target.checked ? '2x2' : 'single',
                      })
                    }
                    className="accent-[#F5B82E]"
                  />
                </label>
                <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-200">
                  <span>Hitbox</span>
                  <input
                    type="checkbox"
                    data-testid="director-bp-hitbox-toggle"
                    checked={blueprint.includeHitbox}
                    onChange={(e) =>
                      setBlueprint({ ...blueprint, includeHitbox: e.target.checked })
                    }
                    className="accent-[#F5B82E]"
                  />
                </label>
                <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-200">
                  <span>Hurtbox</span>
                  <input
                    type="checkbox"
                    data-testid="director-bp-hurtbox-toggle"
                    checked={blueprint.includeHurtbox}
                    onChange={(e) =>
                      setBlueprint({ ...blueprint, includeHurtbox: e.target.checked })
                    }
                    className="accent-[#F5B82E]"
                  />
                </label>
                <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-200 sm:col-span-2">
                  <span>Typed Godot 4.3+ Script (.gd)</span>
                  <input
                    type="checkbox"
                    data-testid="director-bp-gdscript-toggle"
                    checked={includeGdScript}
                    onChange={(e) => setIncludeGdScript(e.target.checked)}
                    className="accent-[#F5B82E]"
                  />
                </label>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div
                  data-testid="director-bp-sockets-list"
                  className="space-y-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5"
                >
                  <span className="text-[11px] font-semibold text-slate-300">
                    Named Sockets ({blueprint.sockets.length})
                  </span>
                  {blueprint.sockets.map((sock) => (
                    <div
                      key={sock.name}
                      className="flex items-center justify-between font-mono text-[11px] text-slate-300"
                    >
                      <span>{sock.name}</span>
                      <span className="text-slate-500">
                        ({sock.normX.toFixed(2)}, {sock.normY.toFixed(2)})
                      </span>
                    </div>
                  ))}
                </div>

                <div
                  data-testid="director-bp-sfx-list"
                  className="space-y-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5"
                >
                  <span className="text-[11px] font-semibold text-slate-300">
                    Audio Cues ({blueprint.sfxSpecs.length})
                  </span>
                  {blueprint.sfxSpecs.map((sfx, idx) => (
                    <div
                      key={sfx.cueName}
                      className="flex items-center justify-between gap-2 text-[11px] text-slate-300"
                    >
                      <span className="truncate font-mono">{sfx.cueName}</span>
                      <select
                        value={sfx.engine}
                        onChange={(e) => {
                          const next = [...blueprint.sfxSpecs];
                          next[idx] = {
                            ...sfx,
                            engine: e.target.value as 'procedural' | 'google-ai',
                          };
                          setBlueprint({ ...blueprint, sfxSpecs: next });
                        }}
                        className="rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-1.5 py-0.5 text-[10px]"
                      >
                        <option value="procedural">Procedural ($0.00)</option>
                        <option value="google-ai">Google AI</option>
                      </select>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-2.5">
              {STAGE_LABELS.map((stage) => {
                const st = stages[stage.id];
                return (
                  <div
                    key={stage.id}
                    data-testid={`director-stage-${stage.id}`}
                    data-status={st.status}
                    className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-2"
                  >
                    <div className="flex items-center gap-2">
                      {st.status === 'done' ? (
                        <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      ) : st.status === 'running' ? (
                        <Loader2 className="h-4 w-4 animate-spin text-[#F5B82E]" />
                      ) : st.status === 'error' ? (
                        <XCircle className="h-4 w-4 text-rose-400" />
                      ) : (
                        <Circle className="h-4 w-4 text-zinc-600" />
                      )}
                      <span className="font-medium text-slate-200">{stage.label}</span>
                    </div>
                    {st.detail && (
                      <span className="font-mono text-[11px] text-slate-400">{st.detail}</span>
                    )}
                  </div>
                );
              })}

              {buildError && (
                <p className="rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-rose-200">
                  {buildError}
                </p>
              )}

              {builtEntity && (
                <p className="rounded border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-200">
                  Built <strong>{builtEntity.displayName}</strong> (<code>{builtEntity.slug}</code>)
                  with controller script and bound assets! Ready for <strong>Sync to Godot</strong>.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-[var(--border-hairline)] px-4 py-3 text-xs">
          {step === 1 && (
            <>
              <button
                type="button"
                onClick={onClose}
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-1.5 text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="director-draft-btn"
                disabled={drafting || !prompt.trim()}
                onClick={() => void handleDraftBlueprint()}
                className="inline-flex items-center gap-1.5 rounded bg-[#F5B82E] px-3.5 py-1.5 font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
              >
                <Wand2 className="h-3.5 w-3.5" />
                {drafting ? 'Drafting Blueprint...' : 'Draft Blueprint'}
              </button>
            </>
          )}

          {step === 2 && (
            <>
              <button
                type="button"
                onClick={() => setStep(1)}
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-1.5 text-slate-300 hover:text-white"
              >
                Back
              </button>
              <button
                type="button"
                data-testid="director-build-btn"
                onClick={() => void handleBuildEntity()}
                className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3.5 py-1.5 font-semibold text-white hover:bg-emerald-500"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Build Entity
              </button>
            </>
          )}

          {step === 3 && (
            <>
              {building ? (
                <button
                  type="button"
                  data-testid="director-abort-btn"
                  onClick={handleAbort}
                  className="inline-flex items-center gap-1.5 rounded border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 font-medium text-rose-200 hover:bg-rose-500/25"
                >
                  <Square className="h-3.5 w-3.5" />
                  Abort Build
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setStep(2)}
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-1.5 text-slate-300 hover:text-white"
                >
                  Review Plan
                </button>
              )}

              <button
                type="button"
                data-testid="director-done-btn"
                disabled={building}
                onClick={handleFinish}
                className="rounded bg-[#F5B82E] px-3.5 py-1.5 font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
              >
                {builtEntity ? 'View Entity' : 'Close'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
