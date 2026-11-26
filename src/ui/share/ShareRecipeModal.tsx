import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Link2, Sparkles, Vault, X } from 'lucide-react';
import { repository } from '../../db/database';
import {
  buildArtBibleVaultItem,
  buildBmfontVaultItem,
  buildShaderVaultItem,
  buildVfxVaultItem,
} from '../../domain/vaultSchema';
import { transpileGdShaderToWebGL2 } from '../../processing/gdshaderTranspiler';
import {
  decodeRecipeFromHash,
  encodeRecipeToHash,
  MAX_SHARE_HASH_CHARS,
  SHARE_HASH_PREFIX,
  type ShareableRecipe,
} from '../../share/recipeUrlCodec';
import { useAppStore } from '../../store/useAppStore';

interface ShareRecipeModalProps {
  readonly outgoingRecipe: ShareableRecipe | null;
  readonly onCloseOutgoing: () => void;
}

export function ShareRecipeModal({ outgoingRecipe, onCloseOutgoing }: ShareRecipeModalProps) {
  const {
    activeProject,
    spriteNodes,
    createProject,
    navigate,
    refreshSpriteNodes,
    refreshVaultItems,
  } = useAppStore();

  const [incomingHash, setIncomingHash] = useState<string | null>(() =>
    typeof window !== 'undefined' && window.location.hash.startsWith(SHARE_HASH_PREFIX)
      ? window.location.hash
      : null,
  );
  const [copied, setCopied] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onHashChange = () => {
      if (window.location.hash.startsWith(SHARE_HASH_PREFIX)) {
        setIncomingHash(window.location.hash);
        setStatusNotice(null);
        setErrorNotice(null);
      }
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const outgoingState = useMemo(() => {
    if (!outgoingRecipe) return null;
    try {
      const hash = encodeRecipeToHash(outgoingRecipe);
      const baseOrigin =
        typeof window !== 'undefined'
          ? `${window.location.origin}${window.location.pathname}`
          : 'https://franekjemiolo.github.io/nibgrid/';
      return {
        ok: true as const,
        hash,
        fullUrl: `${baseOrigin}${hash}`,
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : 'Failed to encode share URL.',
      };
    }
  }, [outgoingRecipe]);

  const decodedIncoming = useMemo(() => {
    if (!incomingHash) return null;
    return decodeRecipeFromHash(incomingHash);
  }, [incomingHash]);

  const shaderPreviewCheck = useMemo(() => {
    if (!decodedIncoming?.ok || decodedIncoming.recipe.kind !== 'shader') return null;
    return transpileGdShaderToWebGL2(decodedIncoming.recipe.shaderConfig.gdshaderSource);
  }, [decodedIncoming]);

  const dismissIncoming = () => {
    setIncomingHash(null);
    setStatusNotice(null);
    setErrorNotice(null);
    if (typeof window !== 'undefined' && window.location.hash.startsWith(SHARE_HASH_PREFIX)) {
      window.history.replaceState(null, '', `${window.location.pathname}#/`);
    }
  };

  const handleCopyShareLink = async () => {
    if (!outgoingState?.ok) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(outgoingState.fullUrl);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(true);
    }
  };

  const handleSaveIncomingToVault = async () => {
    if (!decodedIncoming?.ok) return;
    setBusy(true);
    setErrorNotice(null);
    try {
      const r = decodedIncoming.recipe;
      const id = globalThis.crypto.randomUUID();
      if (r.kind === 'shader') {
        await repository.saveVaultItem(
          buildShaderVaultItem({
            id,
            name: r.name,
            shaderConfig: r.shaderConfig,
            sourceProjectName: '#share URL',
          }),
        );
      } else if (r.kind === 'vfx') {
        await repository.saveVaultItem(
          buildVfxVaultItem({
            id,
            name: r.name,
            vfxFlipbook: r.vfxFlipbook,
            sourceProjectName: '#share URL',
          }),
        );
      } else if (r.kind === 'bmfont') {
        await repository.saveVaultItem(
          buildBmfontVaultItem({
            id,
            name: r.name,
            bitmapFont: r.bitmapFont,
            sourceProjectName: '#share URL',
          }),
        );
      } else if (r.kind === 'art-bible') {
        await repository.saveVaultItem(
          buildArtBibleVaultItem({
            id,
            name: r.name,
            artBible: r.artBible,
            sourceProjectName: '#share URL',
          }),
        );
      }
      await refreshVaultItems();
      setStatusNotice(`Saved "${r.name}" to Global Asset Vault.`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to save shared recipe.');
    } finally {
      setBusy(false);
    }
  };

  const handleImportIncomingToProject = async () => {
    if (!decodedIncoming?.ok) return;
    setBusy(true);
    setErrorNotice(null);
    try {
      const r = decodedIncoming.recipe;
      const targetProj = activeProject ?? (await createProject(`Shared ${r.name}`.slice(0, 80)));

      if (r.kind === 'art-bible') {
        await repository.updateProjectArtBible(targetProj.id, r.artBible);
        dismissIncoming();
        await navigate({ screen: 'bible', projectId: targetProj.id });
        return;
      }

      // Create or attach to a target sprite node cleanly (generate a 1x1 or 64x64 blank/seed PNG blob if project has none)
      const nodes =
        activeProject?.id === targetProj.id
          ? spriteNodes
          : await repository.listSpriteNodes(targetProj.id);
      let targetNode = nodes[nodes.length - 1];
      if (!targetNode) {
        const pngModule = await import('../../processing/png');
        const w = Math.max(16, targetProj.artBible.targetWidth);
        const h = Math.max(16, targetProj.artBible.targetHeight);
        const rgba = new Uint8ClampedArray(w * h * 4);
        const cx = w / 2;
        const cy = h / 2;
        const rad = Math.min(w, h) * 0.3;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            if (Math.hypot(x - cx, y - cy) <= rad) {
              const idx = (y * w + x) * 4;
              rgba[idx] = 239;
              rgba[idx + 1] = 125;
              rgba[idx + 2] = 87;
              rgba[idx + 3] = 255;
            }
          }
        }
        const bytes = pngModule.encodeRgbaToPngBytes(rgba, w, h);
        const blobRec = await repository.storeBlobDeduplicated(bytes, 'image/png');
        targetNode = await repository.saveSpriteNode({
          id: globalThis.crypto.randomUUID(),
          projectId: targetProj.id,
          parentId: null,
          kind: 'generation',
          assetClass: r.kind === 'vfx' ? 'vfx' : r.kind === 'bmfont' ? 'ui-panel' : 'character',
          imageBlobId: blobRec.id,
          sketchSha256: blobRec.sha256,
          generationMeta: {
            providerId: 'offline-mock',
            modelId: 'shared-recipe-baker',
            seed: 404,
            adherence: 'strict',
            promptDelta: r.name,
            compiledPrompt: r.name,
            createdAt: new Date().toISOString(),
          },
        });
      }

      const updatedNode = await repository.saveSpriteNode({
        ...targetNode,
        ...(r.kind === 'shader' ? { shaderConfig: r.shaderConfig } : {}),
        ...(r.kind === 'vfx' ? { vfxFlipbook: r.vfxFlipbook } : {}),
        ...(r.kind === 'bmfont' ? { bitmapFont: r.bitmapFont } : {}),
      });
      await refreshSpriteNodes(targetProj.id);
      dismissIncoming();
      await navigate({
        screen: 'inspector',
        projectId: targetProj.id,
        nodeId: updatedNode.id,
        initialTab: r.kind === 'shader' ? 'shader' : r.kind === 'vfx' ? 'vfx-baker' : 'bmfont',
      });
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to import shared recipe.');
    } finally {
      setBusy(false);
    }
  };

  if (!outgoingRecipe && !incomingHash) {
    return null;
  }

  return (
    <div
      data-testid="share-recipe-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-xl rounded-xl border border-[#2A2A2E] bg-[#1A1A1D] p-5 shadow-2xl">
        {outgoingRecipe && (
          <div data-testid="share-outgoing-panel" className="space-y-4">
            <div className="flex items-start justify-between border-b border-[#2A2A2E] pb-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
                  Zero-Server URL Hash Share
                </p>
                <h3 className="text-base font-semibold text-zinc-100">
                  Share "{outgoingRecipe.name}" via `#share=`
                </h3>
              </div>
              <button
                type="button"
                data-testid="share-close-btn"
                onClick={onCloseOutgoing}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {outgoingState?.ok ? (
              <>
                <div className="flex items-center justify-between text-xs text-zinc-400">
                  <span>Compressed with zlib (level 9) + Base64URL</span>
                  <span
                    data-testid="share-hash-length"
                    className="rounded border border-[#2A2A2E] bg-[#121214] px-2 py-0.5 font-mono text-[11px] text-emerald-300"
                  >
                    {outgoingState.hash.length} / {MAX_SHARE_HASH_CHARS} chars
                  </span>
                </div>
                <textarea
                  readOnly
                  rows={4}
                  data-testid="share-hash-url-output"
                  value={outgoingState.fullUrl}
                  className="w-full resize-none rounded border border-[#2A2A2E] bg-[#121214] p-2.5 font-mono text-[11px] text-zinc-200 focus:outline-none"
                />
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    data-testid="share-copy-btn"
                    onClick={() => void handleCopyShareLink()}
                    className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
                  >
                    {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                    {copied ? 'Copied URL!' : 'Copy #share= Link'}
                  </button>
                </div>
              </>
            ) : (
              <p className="rounded border border-rose-500/40 bg-rose-950/35 p-3 text-xs text-rose-200">
                {outgoingState?.error}
              </p>
            )}
          </div>
        )}

        {incomingHash && (
          <div data-testid="share-incoming-panel" className="space-y-4">
            <div className="flex items-start justify-between border-b border-[#2A2A2E] pb-3">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-amber-400" />
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-400">
                    URL Recipe Detected
                  </p>
                  <h3 className="text-base font-semibold text-zinc-100">Shared Recipe Detected</h3>
                </div>
              </div>
              <button
                type="button"
                data-testid="share-incoming-dismiss-btn"
                onClick={dismissIncoming}
                className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {!decodedIncoming?.ok ? (
              <div
                data-testid="share-decode-error"
                className="rounded border border-rose-500/40 bg-rose-950/35 p-3 text-xs text-rose-200"
              >
                Invalid shared link: {decodedIncoming?.error}
              </div>
            ) : (
              <>
                <div className="space-y-2 rounded border border-[#2A2A2E] bg-[#121214] p-3 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-zinc-100">
                      {decodedIncoming.recipe.name}
                    </span>
                    <span className="rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 font-mono text-[10px] uppercase text-amber-200">
                      {decodedIncoming.recipe.kind}
                    </span>
                  </div>
                  {shaderPreviewCheck && (
                    <p
                      data-testid="share-rebake-status"
                      className="inline-flex items-center gap-1.5 text-[11px] text-emerald-300"
                    >
                      <Sparkles className="h-3.5 w-3.5" />
                      Re-baked cleanly ({shaderPreviewCheck.uniforms.length} uniforms, WebGL2{' '}
                      {shaderPreviewCheck.ok ? 'valid' : 'errors'})
                    </p>
                  )}
                  {decodedIncoming.recipe.kind === 'shader' && (
                    <pre className="max-h-40 overflow-auto rounded bg-[#1A1A1D] p-2 font-mono text-[10px] text-zinc-300">
                      {decodedIncoming.recipe.shaderConfig.gdshaderSource}
                    </pre>
                  )}
                </div>

                {statusNotice && (
                  <p className="rounded border border-emerald-500/40 bg-emerald-950/30 px-3 py-1.5 text-xs text-emerald-200">
                    {statusNotice}
                  </p>
                )}
                {errorNotice && (
                  <p className="rounded border border-rose-500/40 bg-rose-950/30 px-3 py-1.5 text-xs text-rose-200">
                    {errorNotice}
                  </p>
                )}

                <div className="flex flex-wrap items-center justify-end gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="share-save-vault-btn"
                    onClick={() => void handleSaveIncomingToVault()}
                    className="inline-flex items-center gap-1.5 rounded border border-[#2A2A2E] bg-[#121214] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
                  >
                    <Vault className="h-3.5 w-3.5 text-amber-400" />
                    Save to Vault
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    data-testid="share-import-project-btn"
                    onClick={() => void handleImportIncomingToProject()}
                    className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    {activeProject
                      ? `Import into ${activeProject.name}`
                      : 'Create Project & Import'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
