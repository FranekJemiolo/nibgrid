import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Loader2, Sparkles, X } from 'lucide-react';
import { resolveAtMentions, type AgentProjectIndex } from '../../agent/contextResolver';
import { commitStagedTurn, rejectStagedTurn } from '../../agent/stagingTransactions';
import { executeStagedToolCall, type StagedAssetChange } from '../../agent/studioToolRegistry';
import { createDefaultMockProviderConfig, db } from '../../db/database';
import { planAgentTurn } from '../../providers/assetAgentAdapter';
import { useAppStore } from '../../store/useAppStore';
import { BlobImage } from '../components/BlobImage';
import { BeforeAfterWipe } from '../primitives/BeforeAfterWipe';

export function InlineCanvasCommand() {
  const {
    activeProject,
    spriteNodes,
    entities,
    audioAssets,
    rooms,
    providers,
    selectedProviderId,
    inlineCommandTarget,
    workspaceRulesText,
    setInlineCommandTarget,
    refreshSpriteNodes,
    refreshEntities,
    refreshAudioAssets,
    refreshRooms,
    refreshAgentCheckpoints,
  } = useAppStore();

  const [prompt, setPrompt] = useState('');
  const [staged, setStaged] = useState<StagedAssetChange | null>(null);
  const [wipePercent, setWipePercent] = useState(50);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (inlineCommandTarget) {
      setPrompt('');
      setStaged(null);
      setErrorMsg(null);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [inlineCommandTarget]);

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? createDefaultMockProviderConfig(),
    [providers, selectedProviderId],
  );

  const dismissInline = async () => {
    if (staged) {
      await rejectStagedTurn(db, [staged]).catch(() => undefined);
    }
    setStaged(null);
    setInlineCommandTarget(null);
  };

  useEffect(() => {
    if (!inlineCommandTarget) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        void dismissInline();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineCommandTarget, staged]);

  if (!inlineCommandTarget || !activeProject) {
    return null;
  }

  const handleStage = async () => {
    if (busy || prompt.trim().length === 0) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      const index: AgentProjectIndex = {
        project: activeProject,
        spriteNodes,
        entities,
        audioAssets,
        rooms,
      };
      const fullPrompt = `@${inlineCommandTarget.slug} ${prompt.trim()}`;
      const resolved = resolveAtMentions(fullPrompt, index);
      const plan = await planAgentTurn(
        fullPrompt,
        resolved,
        activeProject.artBible,
        activeProvider,
        {
          customRules: workspaceRulesText,
          fallbackTargetSlug: inlineCommandTarget.slug,
        },
      );
      if (plan.toolCalls.length === 0) {
        setErrorMsg('No applicable Studio edit was generated for this target.');
        return;
      }
      const produced = await executeStagedToolCall(
        db,
        activeProject.id,
        plan.toolCalls[0]!,
        activeProvider,
      );
      setStaged(produced[0] ?? null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Inline command failed.');
    } finally {
      setBusy(false);
    }
  };

  const handleAccept = async () => {
    if (!staged || busy) return;
    setBusy(true);
    setErrorMsg(null);
    try {
      await commitStagedTurn(
        db,
        activeProject.id,
        `Inline ⌘K (@${inlineCommandTarget.slug}): ${prompt.trim()}`,
        [{ ...staged, status: 'accepted' }],
      );
      await Promise.all([
        refreshSpriteNodes(activeProject.id),
        refreshEntities(activeProject.id),
        refreshAudioAssets(activeProject.id),
        refreshRooms(activeProject.id),
        refreshAgentCheckpoints(activeProject.id),
      ]);
      setStaged(null);
      setInlineCommandTarget(null);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to commit inline edit.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="inline-canvas-command"
      className="fixed bottom-16 left-1/2 z-50 w-[min(92vw,34rem)] -translate-x-1/2 rounded-xl border border-amber-500/45 bg-[#16161B] p-3 shadow-2xl"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Sparkles className="h-3.5 w-3.5 text-amber-400" />
          <span
            data-testid="inline-target-chip"
            className="rounded bg-amber-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-amber-300"
          >
            @{inlineCommandTarget.slug}
          </span>
          <span className="text-[11px] text-zinc-400">Inline Edit (⌘K · Esc to close)</span>
        </div>
        <button
          type="button"
          onClick={() => void dismissInline()}
          className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void handleStage();
        }}
        className="flex items-center gap-2"
      >
        <input
          ref={inputRef}
          type="text"
          data-testid="inline-command-input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. repalette with crimson outline, or add cape_tip socket..."
          className="flex-1 rounded border border-[#2E2E35] bg-[#1E1E24] px-2.5 py-1.5 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-500/60 focus:outline-none"
        />
        <button
          type="submit"
          data-testid="inline-submit-btn"
          disabled={busy || prompt.trim().length === 0}
          className="inline-flex items-center gap-1 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Stage'}
        </button>
      </form>

      {errorMsg && (
        <p className="mt-2 rounded border border-rose-500/40 bg-rose-950/30 px-2.5 py-1 text-[11px] text-rose-200">
          {errorMsg}
        </p>
      )}

      {staged && (
        <div
          data-testid="inline-staged-preview"
          className="mt-2.5 space-y-2 rounded-md border border-[#2E2E35] bg-[#121215] p-2.5"
        >
          <p className="text-[11px] font-medium text-emerald-300">{staged.summary}</p>
          {staged.beforeBlobId && staged.afterBlobId && (
            <div className="flex justify-center">
              <BeforeAfterWipe
                enabled
                percent={wipePercent}
                onChangePercent={setWipePercent}
                beforeLabel="Before"
                afterLabel="After"
                widthPx={112}
                heightPx={112}
                before={
                  <BlobImage
                    blobId={staged.beforeBlobId}
                    alt="Before inline edit"
                    artMode={activeProject.artBible.artMode}
                    className="h-full w-full object-contain"
                  />
                }
                after={
                  <BlobImage
                    blobId={staged.afterBlobId}
                    alt="After inline edit"
                    artMode={activeProject.artBible.artMode}
                    className="h-full w-full object-contain"
                  />
                }
              />
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid="inline-reject-btn"
              disabled={busy}
              onClick={() => void dismissInline()}
              className="rounded border border-[#2E2E35] px-2.5 py-1 text-xs text-zinc-300 hover:text-white"
            >
              Reject
            </button>
            <button
              type="button"
              data-testid="inline-accept-btn"
              disabled={busy}
              onClick={() => void handleAccept()}
              className="inline-flex items-center gap-1 rounded bg-emerald-600 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              <Check className="h-3.5 w-3.5" />
              Accept
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
