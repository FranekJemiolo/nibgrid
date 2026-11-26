import { useMemo, useRef, useState } from 'react';
import {
  Archive,
  CheckSquare,
  Download,
  ExternalLink,
  Filter,
  FolderInput,
  Globe,
  Palette,
  Package,
  Radio,
  Search,
  Sparkles,
  Square,
  Trash2,
  Upload,
} from 'lucide-react';
import { db, repository } from '../../db/database';
import { createDefaultPostProcessConfig, type SpriteNode } from '../../domain/schemas';
import type { VaultItemKind } from '../../domain/vaultSchema';
import { triggerBlobDownload } from '../../export/zipPackager';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../../processing/png';
import { computeArtBibleHash } from '../../processing/projectAudit';
import { useAppStore } from '../../store/useAppStore';
import { exportProjectSnapshotFromDb, importProjectSnapshotToDb } from '../../sync/projectSnapshot';
import { runPostProcessInWorker } from '../../workers/postprocessClient';
import { BlobImage } from '../components/BlobImage';
import { PackFeedBrowser } from '../share/PackFeedBrowser';

export type VaultBrowserTab = 'project' | 'vault' | 'feeds';

export function VaultAndBrowserView() {
  const {
    activeProject,
    spriteNodes,
    entities,
    syncTarget,
    vaultItems,
    navigate,
    refreshProjects,
    refreshSpriteNodes,
    promoteSpriteToVault,
    importVaultItemToActiveProject,
    deleteVaultItemRecord,
    setP2pOpen,
  } = useAppStore();

  const [tab, setTab] = useState<VaultBrowserTab>(activeProject ? 'project' : 'vault');
  const [searchQuery, setSearchQuery] = useState('');
  const [classFilter, setClassFilter] = useState<string>('all');
  const [bodyTypeFilter, setBodyTypeFilter] = useState<string>('all');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [vaultKindFilter, setVaultKindFilter] = useState<'all' | VaultItemKind>('all');
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(() => new Set());
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  const currentBibleHash = useMemo(
    () => (activeProject ? computeArtBibleHash(activeProject.artBible) : ''),
    [activeProject],
  );

  const entityBySpriteId = useMemo(() => {
    const map = new Map<string, (typeof entities)[number]>();
    for (const ent of entities) {
      map.set(ent.primarySpriteNodeId, ent);
      for (const clip of ent.clips) {
        map.set(clip.spriteNodeId, ent);
      }
    }
    return map;
  }, [entities]);

  const filteredProjectNodes = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return spriteNodes.filter((node) => {
      const label = (
        node.generationMeta.promptDelta ||
        node.generationMeta.compiledPrompt ||
        `${node.kind} #${node.generationMeta.seed}`
      ).toLowerCase();
      if (q && !label.includes(q) && !(node.assetClass ?? '').toLowerCase().includes(q)) {
        return false;
      }
      if (classFilter !== 'all' && (node.assetClass ?? 'character') !== classFilter) {
        return false;
      }
      if (bodyTypeFilter !== 'all') {
        const linked = entityBySpriteId.get(node.id);
        if (!linked || linked.bodyType !== bodyTypeFilter) return false;
      }
      if (statusFilter === 'missing-collider' && (node.collisionShapes?.length ?? 0) > 0) {
        return false;
      }
      if (statusFilter === 'has-shader' && !node.shaderConfig) {
        return false;
      }
      if (statusFilter === 'stale' && node.recipeArtBibleHash === currentBibleHash) {
        return false;
      }
      if (statusFilter === 'unsynced' && syncTarget?.lastSyncedAt != null) {
        return false;
      }
      return true;
    });
  }, [
    bodyTypeFilter,
    classFilter,
    currentBibleHash,
    entityBySpriteId,
    searchQuery,
    spriteNodes,
    statusFilter,
    syncTarget?.lastSyncedAt,
  ]);

  const filteredVaultItems = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return vaultItems.filter((item) => {
      if (vaultKindFilter !== 'all' && item.kind !== vaultKindFilter) return false;
      if (
        q &&
        !item.name.toLowerCase().includes(q) &&
        !item.tags.some((t) => t.toLowerCase().includes(q))
      ) {
        return false;
      }
      return true;
    });
  }, [searchQuery, vaultItems, vaultKindFilter]);

  const toggleSelectNode = (nodeId: string) => {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
  };

  const handlePromoteOne = async (node: SpriteNode) => {
    setErrorNotice(null);
    try {
      const item = await promoteSpriteToVault(node);
      setStatusNotice(`Promoted "${item.name}" to Global Asset Vault.`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to promote asset to Vault.');
    }
  };

  const handleBulkPromote = async () => {
    const targets = filteredProjectNodes.filter((n) => selectedNodeIds.has(n.id));
    if (targets.length === 0) return;
    setBusyMessage(`Promoting ${targets.length} item(s) to Vault...`);
    setErrorNotice(null);
    try {
      for (const node of targets) {
        await promoteSpriteToVault(node);
      }
      setSelectedNodeIds(new Set());
      setStatusNotice(`Promoted ${targets.length} sprite(s) to Global Asset Vault.`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Bulk promote failed.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleBatchRepalette = async () => {
    if (!activeProject) return;
    const targets = filteredProjectNodes.filter((n) => selectedNodeIds.has(n.id));
    if (targets.length === 0) return;
    setBusyMessage(`Re-paletting ${targets.length} sprite(s) to Art Bible...`);
    setErrorNotice(null);
    try {
      for (const node of targets) {
        const blobRec = await repository.getBlob(node.processedBlobId ?? node.imageBlobId);
        if (!blobRec) continue;
        const rawBytes = new Uint8Array(await blobRec.bytes.arrayBuffer());
        const decoded = await decodePngBytesToRgba(rawBytes);
        const cfg = {
          ...(node.postProcessConfig ??
            createDefaultPostProcessConfig(decoded.width, decoded.height)),
          paletteSnap: true,
        };
        const result = await runPostProcessInWorker({
          rgba: new Uint8ClampedArray(decoded.rgba),
          width: decoded.width,
          height: decoded.height,
          config: cfg,
          paletteHex: activeProject.artBible.palette,
        });
        const pngBytes = encodeRgbaToPngBytes(result.rgba, result.width, result.height);
        const savedBlob = await repository.storeBlobDeduplicated(pngBytes, 'image/png');
        await repository.saveSpriteNode({
          ...node,
          processedBlobId: savedBlob.id,
          postProcessConfig: cfg,
          recipeArtBibleHash: currentBibleHash,
        });
      }
      await refreshSpriteNodes(activeProject.id);
      setStatusNotice(`Re-paletted ${targets.length} sprite(s) to active Art Bible.`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Batch re-palette failed.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleImportFromVault = async (vaultItemId: string) => {
    setErrorNotice(null);
    try {
      const outcome = await importVaultItemToActiveProject(vaultItemId);
      setStatusNotice(`Imported ${outcome.kind} item into "${activeProject?.name ?? 'project'}".`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Vault import failed.');
    }
  };

  const handleExportSnapshot = async () => {
    if (!activeProject) return;
    setBusyMessage('Packing .nibgrid.zip snapshot...');
    setErrorNotice(null);
    try {
      const { filename, bytes } = await exportProjectSnapshotFromDb(db, activeProject.id);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      triggerBlobDownload(new Blob([copy.buffer], { type: 'application/zip' }), filename);
      setStatusNotice(`Exported portable snapshot ${filename}.`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Snapshot export failed.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleImportSnapshotFile = async (file: File | undefined) => {
    if (!file) return;
    setBusyMessage(`Verifying SHA-256 hashes in ${file.name}...`);
    setErrorNotice(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await importProjectSnapshotToDb(db, bytes);
      await refreshProjects();
      setStatusNotice(
        `Imported "${res.project.name}" (${res.spriteCount} sprites, ${res.audioCount} audio, ${res.entityCount} entities).`,
      );
      await navigate({ screen: 'vault', projectId: res.project.id });
      setTab('project');
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Snapshot import failed.');
    } finally {
      setBusyMessage(null);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  return (
    <div
      data-testid="vault-browser-view"
      className="mx-auto flex w-full max-w-7xl flex-col gap-5 p-6"
    >
      {/* Header & Portable Snapshot Actions */}
      <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-[#2A2A2E] bg-[#1A1A1D] p-5">
        <div>
          <div className="flex items-center gap-2">
            <Archive className="h-5 w-5 text-amber-400" />
            <h2 className="text-lg font-semibold text-zinc-100">
              Global Asset Vault &amp; Smart Browser
            </h2>
          </div>
          <p className="mt-1 text-xs text-zinc-400">
            Reuse sprites, shaders, and audio across projects with SHA-256 deduplication and export
            portable <code className="text-zinc-200">.nibgrid.zip</code> snapshots.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={importInputRef}
            type="file"
            accept=".zip,.nibgrid.zip"
            data-testid="snapshot-import-input"
            onChange={(e) => void handleImportSnapshotFile(e.target.files?.[0])}
            className="hidden"
          />
          <button
            type="button"
            data-testid="snapshot-import-btn"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded border border-[#2A2A2E] bg-[#121214] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500"
          >
            <Upload className="h-3.5 w-3.5 text-amber-400" />
            Import .nibgrid.zip
          </button>
          <button
            type="button"
            data-testid="vault-p2p-btn"
            onClick={() => setP2pOpen(true)}
            className="inline-flex items-center gap-1.5 rounded border border-amber-500/40 bg-amber-500/15 px-3 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25"
          >
            <Radio className="h-3.5 w-3.5" />
            Share via P2P
          </button>
          {activeProject && (
            <button
              type="button"
              data-testid="export-snapshot-btn"
              onClick={() => void handleExportSnapshot()}
              className="inline-flex items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
            >
              <Download className="h-3.5 w-3.5" />
              Export .nibgrid.zip
            </button>
          )}
        </div>
      </section>

      {/* Tabs + Search/Filter Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#2A2A2E] bg-[#1A1A1D] p-3">
        <div className="flex items-center gap-1.5">
          {activeProject && (
            <button
              type="button"
              data-testid="vault-tab-project"
              onClick={() => setTab('project')}
              className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
                tab === 'project'
                  ? 'bg-amber-500 text-zinc-950'
                  : 'bg-[#121214] text-zinc-300 hover:text-white'
              }`}
            >
              <Package className="h-3.5 w-3.5" />
              Project Browser ({spriteNodes.length})
            </button>
          )}
          <button
            type="button"
            data-testid="vault-tab-global"
            onClick={() => setTab('vault')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
              tab === 'vault'
                ? 'bg-amber-500 text-zinc-950'
                : 'bg-[#121214] text-zinc-300 hover:text-white'
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Global Vault ({vaultItems.length})
          </button>
          <button
            type="button"
            data-testid="vault-tab-feeds"
            onClick={() => setTab('feeds')}
            className={`inline-flex items-center gap-1.5 rounded px-3 py-1.5 text-xs font-medium ${
              tab === 'feeds'
                ? 'bg-amber-500 text-zinc-950'
                : 'bg-[#121214] text-zinc-300 hover:text-white'
            }`}
          >
            <Globe className="h-3.5 w-3.5" />
            Pack Feeds
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute top-2 left-2.5 h-3.5 w-3.5 text-zinc-500" />
            <input
              type="text"
              data-testid="browser-search-input"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter by name or tag..."
              className="w-52 rounded border border-[#2A2A2E] bg-[#121214] py-1 pr-2.5 pl-8 text-xs text-zinc-100 placeholder-zinc-500 focus:border-amber-400 focus:outline-none"
            />
          </div>

          {tab === 'project' ? (
            <>
              <select
                data-testid="browser-class-select"
                aria-label="Filter by asset class"
                value={classFilter}
                onChange={(e) => setClassFilter(e.target.value)}
                className="rounded border border-[#2A2A2E] bg-[#121214] px-2 py-1 text-xs text-zinc-200"
              >
                <option value="all">All Classes</option>
                <option value="character">Character</option>
                <option value="prop">Prop</option>
                <option value="tile">Tile</option>
                <option value="ui-panel">UI Panel</option>
                <option value="vfx">VFX</option>
              </select>
              <select
                data-testid="browser-body-select"
                aria-label="Filter by Godot bodyType"
                value={bodyTypeFilter}
                onChange={(e) => setBodyTypeFilter(e.target.value)}
                className="rounded border border-[#2A2A2E] bg-[#121214] px-2 py-1 text-xs text-zinc-200"
              >
                <option value="all">All Bodies</option>
                <option value="CharacterBody2D">CharacterBody2D</option>
                <option value="Area2D">Area2D</option>
                <option value="StaticBody2D">StaticBody2D</option>
                <option value="RigidBody2D">RigidBody2D</option>
              </select>
              <select
                data-testid="browser-status-select"
                aria-label="Filter by status"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                className="rounded border border-[#2A2A2E] bg-[#121214] px-2 py-1 text-xs text-zinc-200"
              >
                <option value="all">All Statuses</option>
                <option value="has-shader">Has Shader</option>
                <option value="missing-collider">Missing Collider</option>
                <option value="stale">Art Bible Stale</option>
                <option value="unsynced">Unsynced</option>
              </select>
            </>
          ) : (
            <div className="flex items-center gap-1.5">
              <Filter className="h-3.5 w-3.5 text-zinc-400" />
              <select
                data-testid="vault-kind-filter"
                aria-label="Filter Vault item kind"
                value={vaultKindFilter}
                onChange={(e) => setVaultKindFilter(e.target.value as 'all' | VaultItemKind)}
                className="rounded border border-[#2A2A2E] bg-[#121214] px-2 py-1 text-xs text-zinc-200"
              >
                <option value="all">All Kinds</option>
                <option value="sprite">Sprites</option>
                <option value="shader">Shaders (.gdshader)</option>
                <option value="bmfont">Bitmap Fonts</option>
                <option value="vfx">VFX</option>
                <option value="sfx">Audio / SFX</option>
                <option value="art-bible">Art Bibles</option>
              </select>
            </div>
          )}
        </div>
      </div>

      {/* Notices */}
      {(busyMessage || statusNotice || errorNotice) && (
        <div
          data-testid="vault-status-banner"
          className={`rounded-lg border px-4 py-2 text-xs ${
            errorNotice
              ? 'border-rose-500/40 bg-rose-950/35 text-rose-200'
              : 'border-emerald-500/40 bg-emerald-950/30 text-emerald-200'
          }`}
        >
          {busyMessage ?? errorNotice ?? statusNotice}
        </div>
      )}

      {/* Project Browser Grid */}
      {tab === 'project' && activeProject && (
        <section className="space-y-3">
          {selectedNodeIds.size > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/35 bg-amber-500/10 px-4 py-2 text-xs text-amber-100">
              <span>{selectedNodeIds.size} sprite(s) selected</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="bulk-promote-vault-btn"
                  onClick={() => void handleBulkPromote()}
                  className="inline-flex items-center gap-1 rounded bg-amber-500 px-2.5 py-1 font-semibold text-zinc-950 hover:bg-amber-400"
                >
                  <Archive className="h-3.5 w-3.5" />
                  Promote Selected to Vault
                </button>
                <button
                  type="button"
                  data-testid="bulk-repalette-btn"
                  onClick={() => void handleBatchRepalette()}
                  className="inline-flex items-center gap-1 rounded border border-amber-400/50 bg-[#121214] px-2.5 py-1 font-medium text-amber-200 hover:bg-zinc-900"
                >
                  <Palette className="h-3.5 w-3.5" />
                  Batch Re-Palette to Art Bible
                </button>
              </div>
            </div>
          )}

          {filteredProjectNodes.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#2A2A2E] bg-[#1A1A1D]/50 p-10 text-center text-sm text-zinc-400">
              No matching sprites in "{activeProject.name}". Generate a sprite in Sprite Studio or
              import from your Global Vault.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredProjectNodes.map((node) => {
                const selected = selectedNodeIds.has(node.id);
                const label =
                  node.generationMeta.promptDelta || `${node.kind} #${node.generationMeta.seed}`;
                return (
                  <article
                    key={node.id}
                    data-testid={`browser-sprite-card-${node.id}`}
                    className={`flex flex-col justify-between rounded-xl border p-4 transition-colors ${
                      selected ? 'border-amber-400 bg-amber-500/5' : 'border-[#2A2A2E] bg-[#1A1A1D]'
                    }`}
                  >
                    <div className="flex items-start gap-3">
                      <button
                        type="button"
                        onClick={() => toggleSelectNode(node.id)}
                        aria-label={`Select ${label}`}
                        className="mt-1 text-zinc-400 hover:text-amber-300"
                      >
                        {selected ? (
                          <CheckSquare className="h-4 w-4 text-amber-400" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                      <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-[#2A2A2E] bg-[#121214]">
                        <BlobImage
                          blobId={node.processedBlobId ?? node.imageBlobId}
                          alt={label}
                          artMode={activeProject.artBible.artMode}
                          className="h-14 w-14 object-contain"
                        />
                      </div>
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-sm font-semibold text-zinc-100">{label}</h3>
                        <div className="mt-1 flex flex-wrap gap-1 text-[10px]">
                          <span className="rounded border border-[#2A2A2E] bg-[#121214] px-1.5 py-0.5 text-zinc-300">
                            {node.assetClass ?? 'character'}
                          </span>
                          {node.shaderConfig && (
                            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-amber-200">
                              shader:{node.shaderConfig.presetId}
                            </span>
                          )}
                          {(node.collisionShapes?.length ?? 0) === 0 && (
                            <span className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-400">
                              no collider
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    <div className="mt-4 flex items-center gap-2 border-t border-[#2A2A2E] pt-3">
                      <button
                        type="button"
                        data-testid={`promote-sprite-${node.id}`}
                        onClick={() => void handlePromoteOne(node)}
                        className="inline-flex flex-1 items-center justify-center gap-1 rounded bg-amber-500/15 px-2.5 py-1.5 text-xs font-medium text-amber-200 hover:bg-amber-500/25"
                      >
                        <Archive className="h-3.5 w-3.5" />
                        Promote to Vault
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void navigate({
                            screen: 'inspector',
                            projectId: activeProject.id,
                            nodeId: node.id,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1.5 text-xs text-zinc-200 hover:border-zinc-500"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                        Inspect
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {/* Global Vault Grid */}
      {tab === 'vault' && (
        <section data-testid="global-vault-grid">
          {filteredVaultItems.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#2A2A2E] bg-[#1A1A1D]/50 p-10 text-center text-sm text-zinc-400">
              Your Global Vault is empty. Promote any sprite, `.gdshader`, or asset from a project
              to reuse it everywhere.
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {filteredVaultItems.map((item) => (
                <article
                  key={item.id}
                  data-testid={`vault-item-${item.id}`}
                  data-vault-kind={item.kind}
                  className="flex flex-col justify-between rounded-xl border border-[#2A2A2E] bg-[#1A1A1D] p-4"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded border border-[#2A2A2E] bg-[#121214]">
                      {item.previewBlobId ? (
                        <BlobImage
                          blobId={item.previewBlobId}
                          alt={item.name}
                          className="h-12 w-12 object-contain"
                        />
                      ) : (
                        <Sparkles className="h-5 w-5 text-amber-400" />
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="truncate text-sm font-semibold text-zinc-100">
                          {item.name}
                        </h3>
                        <span className="shrink-0 rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-200">
                          {item.kind}
                        </span>
                      </div>
                      {item.sourceProjectName && (
                        <p className="mt-0.5 truncate text-[11px] text-zinc-400">
                          From {item.sourceProjectName}
                        </p>
                      )}
                      {item.tags.length > 0 && (
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          {item.tags.slice(0, 4).map((tag) => (
                            <span
                              key={tag}
                              className="rounded border border-[#2A2A2E] bg-[#121214] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                            >
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="mt-4 flex items-center gap-2 border-t border-[#2A2A2E] pt-3">
                    <button
                      type="button"
                      disabled={!activeProject}
                      data-testid={`vault-import-btn-${item.id}`}
                      onClick={() => void handleImportFromVault(item.id)}
                      className="inline-flex flex-1 items-center justify-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      <FolderInput className="h-3.5 w-3.5" />
                      {activeProject ? 'Import to Project' : 'Open a Project First'}
                    </button>
                    <button
                      type="button"
                      data-testid={`vault-delete-btn-${item.id}`}
                      onClick={() => void deleteVaultItemRecord(item.id)}
                      aria-label={`Delete ${item.name} from Vault`}
                      className="rounded border border-rose-500/35 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {/* Pack Feeds Browser */}
      {tab === 'feeds' && <PackFeedBrowser />}
    </div>
  );
}
