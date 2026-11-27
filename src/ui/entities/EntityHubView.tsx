import { useEffect, useMemo, useState } from 'react';
import {
  Boxes,
  Code2,
  FileArchive,
  FileCode2,
  FolderSync,
  Play,
  Plus,
  Save,
  Settings2,
  Sun,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { db, repository } from '../../db/database';
import {
  EntityDefinitionSchema,
  GodotBodyTypeSchema,
  normalizeResSubpath,
  sanitizeEntitySlug,
  type EntityAnimationClip,
  type EntityDefinition,
  type GodotBodyType,
} from '../../domain/entitySchema';
import type { SpriteNode } from '../../domain/schemas';
import { assembleGodotEntityFiles, type VirtualSyncFile } from '../../export/godotPrefabAssembler';
import { decodePngBytesToRgba } from '../../processing/png';
import type { RgbaBuffer } from '../../processing/types';
import { useAppStore } from '../../store/useAppStore';
import {
  collectEntitySyncFiles,
  downloadGodotSyncZip,
  isFsaaSupported,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';
import { BlobImage } from '../components/BlobImage';
import { LightingBakerPanel } from '../lighting/LightingBakerPanel';
import { EntityDirectorModal } from './EntityDirectorModal';
import { EntityPlaytestStage } from './EntityPlaytestStage';

const BODY_TYPES: readonly GodotBodyType[] = GodotBodyTypeSchema.options;

function createDraftEntity(
  projectId: string,
  spriteNodes: ReturnType<typeof useAppStore.getState>['spriteNodes'],
): EntityDefinition {
  const firstSprite = spriteNodes[spriteNodes.length - 1];
  return EntityDefinitionSchema.parse({
    id: globalThis.crypto.randomUUID(),
    projectId,
    slug: 'new_entity',
    displayName: 'New Entity',
    bodyType: 'CharacterBody2D',
    resSubpath: 'assets/nibgrid',
    primarySpriteNodeId: firstSprite?.id ?? 'unassigned',
    clips: firstSprite
      ? [
          {
            name: 'idle',
            spriteNodeId: firstSprite.id,
            fps: firstSprite.puppetAnim?.fps ?? 8,
            loop: true,
          },
        ]
      : [],
    audioAssetIds: [],
    includeNormalMap: false,
    updatedAt: Date.now(),
  });
}

export function EntityHubView() {
  const {
    route,
    activeProject,
    spriteNodes,
    audioAssets,
    entities,
    syncTarget,
    navigate,
    saveEntityRecord,
    deleteEntityRecord,
    refreshSyncTarget,
    refreshSpriteNodes,
  } = useAppStore();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<'config' | 'tscn' | 'gdscript'>('config');
  const [directorOpen, setDirectorOpen] = useState(false);
  const [playtestEntityId, setPlaytestEntityId] = useState<string | null>(() =>
    route.screen === 'entities' && route.playtestEntityId ? route.playtestEntityId : null,
  );
  const [lightingModal, setLightingModal] = useState<{
    readonly entity: EntityDefinition;
    readonly spriteNode: SpriteNode;
    readonly sprite: RgbaBuffer;
  } | null>(null);
  const [draft, setDraft] = useState<EntityDefinition | null>(null);
  const [slugLocked, setSlugLocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusBanner, setStatusBanner] = useState<string | null>(null);
  const [previewFiles, setPreviewFiles] = useState<readonly VirtualSyncFile[]>([]);

  const spriteById = useMemo(() => new Map(spriteNodes.map((n) => [n.id, n])), [spriteNodes]);

  // Keep `.tscn` live preview in sync whenever draft or drawer tab updates
  useEffect(() => {
    if (!activeProject || !drawerOpen || !draft || drawerTab !== 'tscn') return;
    let cancelled = false;

    void (async () => {
      try {
        const files = await collectEntitySyncFiles(
          db,
          activeProject,
          draft,
          spriteNodes,
          audioAssets,
        );
        if (!cancelled) {
          setPreviewFiles(files);
        }
      } catch {
        if (!cancelled) {
          // Pure fallback preview in case a blob is unavailable
          const primaryNode = spriteById.get(draft.primarySpriteNodeId);
          setPreviewFiles(
            assembleGodotEntityFiles({
              entity: draft,
              isPixelArt: activeProject.artBible.artMode === 'pixel-art',
              spriteFiles: primaryNode
                ? [
                    {
                      spriteNodeId: primaryNode.id,
                      filename: `${sanitizeEntitySlug(draft.slug)}.png`,
                      bytes: new Uint8Array([137, 80, 78, 71]),
                    },
                  ]
                : [],
              audioFiles: [],
              colliderPolygons: (primaryNode?.collisionShapes ?? []).map((s) => ({
                layer: s.layer,
                points: s.vertices,
                ...(s.activeFrames ? { activeFrames: s.activeFrames } : {}),
              })),
              sockets: (primaryNode?.sockets ?? []).map((s) => ({
                name: s.name,
                x: s.restPosPx.x - activeProject.artBible.targetWidth / 2,
                y: s.restPosPx.y - activeProject.artBible.targetHeight / 2,
                angleDeg: s.baseAngleDeg,
              })),
            }),
          );
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeProject, drawerOpen, drawerTab, draft, spriteNodes, audioAssets, spriteById]);

  const tscnPreviewText = useMemo(() => {
    const tscn = previewFiles.find((f) => f.relativePath.endsWith('.tscn'));
    if (!tscn) return '# Preparing Godot 4 .tscn scene...';
    return typeof tscn.content === 'string' ? tscn.content : new TextDecoder().decode(tscn.content);
  }, [previewFiles]);

  if (!activeProject) return null;

  const handleOpenNew = () => {
    setErrorBanner(null);
    setDraft(createDraftEntity(activeProject.id, spriteNodes));
    setSlugLocked(false);
    setDrawerTab('config');
    setDrawerOpen(true);
  };

  const handleOpenEdit = (entity: EntityDefinition) => {
    setErrorBanner(null);
    setDraft({ ...entity, clips: [...entity.clips], audioAssetIds: [...entity.audioAssetIds] });
    setSlugLocked(true);
    setDrawerTab('config');
    setDrawerOpen(true);
  };

  const handleSave = async () => {
    if (!draft) return;
    setErrorBanner(null);
    if (spriteNodes.length === 0 || !spriteById.has(draft.primarySpriteNodeId)) {
      setErrorBanner('Select a valid primary SpriteNode from Sprite Studio before saving.');
      return;
    }

    setSaving(true);
    try {
      const normalized = EntityDefinitionSchema.parse({
        ...draft,
        slug: sanitizeEntitySlug(draft.slug || draft.displayName),
        resSubpath: normalizeResSubpath(draft.resSubpath),
        displayName: draft.displayName.trim() || 'Entity',
        scriptResPath: draft.scriptResPath?.trim() || undefined,
        updatedAt: Date.now(),
      });
      await saveEntityRecord(normalized);
      setStatusBanner(`Saved entity "${normalized.slug}" (${normalized.bodyType}).`);
      setDrawerOpen(false);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to save entity.');
    } finally {
      setSaving(false);
    }
  };

  const handleSyncSingleEntity = async (entity: EntityDefinition) => {
    setErrorBanner(null);
    setStatusBanner(null);
    try {
      const files = await collectEntitySyncFiles(
        db,
        activeProject,
        entity,
        spriteNodes,
        audioAssets,
      );
      if (syncTarget && isFsaaSupported()) {
        const res = await syncFilesToGodotDirectory(db, activeProject.id, files);
        await refreshSyncTarget(activeProject.id);
        setStatusBanner(
          res.writtenCount === 0
            ? `${entity.slug}: 0 files changed — up to date.`
            : `${entity.slug}: Synced ${res.writtenCount} file(s) to res://${res.folderName}.`,
        );
      } else {
        downloadGodotSyncZip(entity.slug, files);
        setStatusBanner(`${entity.slug}: Downloaded ${files.length}-file Godot sync ZIP.`);
      }
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to sync entity.');
    }
  };

  const addClip = () => {
    if (!draft) return;
    const fallbackNodeId = spriteNodes[0]?.id ?? draft.primarySpriteNodeId;
    const nextClip: EntityAnimationClip = {
      name: `clip_${draft.clips.length + 1}`,
      spriteNodeId: fallbackNodeId,
      fps: 8,
      loop: true,
    };
    setDraft({ ...draft, clips: [...draft.clips, nextClip] });
  };

  const toggleAudioAsset = (audioId: string) => {
    if (!draft) return;
    const exists = draft.audioAssetIds.includes(audioId);
    const next = exists
      ? draft.audioAssetIds.filter((id) => id !== audioId)
      : [...draft.audioAssetIds, audioId];
    setDraft({ ...draft, audioAssetIds: next });
  };

  return (
    <div
      data-testid="entity-hub-view"
      className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-4 p-4 sm:p-6"
    >
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold text-slate-100">
            <Boxes className="h-4 w-4 text-[#F5B82E]" />
            Entity Hub & Godot 4 Prefab Foundry
          </h2>
          <p className="text-xs text-slate-400">
            Group sprites, normal maps, M16 colliders, M21 sockets, and M14/M15 audio into synced{' '}
            <code>.tscn</code> prefabs.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1 font-mono text-xs text-slate-300 tabular-nums">
            {entities.length} entit{entities.length === 1 ? 'y' : 'ies'}
          </span>
          <button
            type="button"
            data-testid="entity-director-open-btn"
            onClick={() => setDirectorOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md border border-[#F5B82E]/50 bg-[#F5B82E]/15 px-3 py-1.5 text-xs font-semibold text-[#F5B82E] hover:bg-[#F5B82E]/25"
          >
            <Wand2 className="h-3.5 w-3.5" />+ Prompt-to-Entity (AI)
          </button>
          <button
            type="button"
            data-testid="entity-create-btn"
            disabled={spriteNodes.length === 0}
            onClick={handleOpenNew}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            New Entity
          </button>
        </div>
      </div>

      {statusBanner && (
        <div
          data-testid="entity-status-banner"
          className="rounded-md border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
        >
          {statusBanner}
        </div>
      )}

      {errorBanner && (
        <div className="rounded-md border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {errorBanner}
        </div>
      )}

      {spriteNodes.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--border-hairline)] bg-[var(--bg-panel)] p-8 text-center">
          <p className="text-sm text-slate-300">
            No sprites found in <strong>{activeProject.name}</strong> yet.
          </p>
          <p className="max-w-md text-xs text-slate-400">
            Launch the AI Prompt-to-Entity Director to generate sprite, collider, sockets, SFX pack,
            and GDScript in one pass, or create sprites in Sprite Studio first.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <button
              type="button"
              onClick={() => setDirectorOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
            >
              <Wand2 className="h-3.5 w-3.5" />+ Prompt-to-Entity (AI)
            </button>
            <button
              type="button"
              onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
              className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
            >
              Go to Sprite Studio
            </button>
          </div>
        </div>
      ) : entities.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--border-hairline)] bg-[var(--bg-panel)] p-8 text-center">
          <Boxes className="h-8 w-8 text-[#F5B82E]/80" />
          <p className="text-sm font-medium text-slate-200">No Godot 4 Entities assembled yet</p>
          <p className="max-w-lg text-xs text-slate-400">
            Create an Entity Card to emit <code>.tscn</code> scenes, lossless{' '}
            <code>.png.import</code> sidecars, <code>SpriteFrames</code>, and synchronized{' '}
            <code>AnimationLibrary</code> tracks automatically.
          </p>
          <button
            type="button"
            onClick={handleOpenNew}
            className="inline-flex items-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
          >
            <Plus className="h-3.5 w-3.5" />
            Create First Entity
          </button>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {entities.map((entity) => {
            const primaryNode = spriteById.get(entity.primarySpriteNodeId);
            const hasSprite = Boolean(primaryNode);
            const hasNormal =
              entity.includeNormalMap || Boolean(primaryNode?.lightingBake?.normalBlobId);
            const hasCollider = (primaryNode?.collisionShapes?.length ?? 0) > 0;
            const hasSockets = (primaryNode?.sockets?.length ?? 0) > 0;
            const hasAudio = entity.audioAssetIds.length > 0;
            const hasScript = Boolean(entity.scriptContent || entity.scriptResPath);

            const coverage = [
              { label: 'Sprite', ok: hasSprite },
              { label: 'Normal', ok: hasNormal },
              { label: 'Collider', ok: hasCollider },
              { label: 'Sockets', ok: hasSockets },
              { label: 'Audio', ok: hasAudio },
              { label: '.gd', ok: hasScript },
            ];

            return (
              <div
                key={entity.id}
                tabIndex={0}
                data-testid={`entity-card-${entity.slug}`}
                data-inline-agent-target="entity"
                data-inline-agent-id={entity.id}
                data-inline-agent-slug={entity.slug}
                className="flex flex-col justify-between gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-4 focus:outline-none focus:ring-1 focus:ring-amber-500/40"
              >
                <div className="flex items-start gap-3">
                  <div className="bg-checkerboard flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded border border-[var(--border-hairline)]">
                    {primaryNode ? (
                      <BlobImage
                        blobId={primaryNode.processedBlobId ?? primaryNode.imageBlobId}
                        alt={entity.displayName}
                        artMode={activeProject.artBible.artMode}
                        className="h-full w-full object-contain"
                      />
                    ) : (
                      <span className="text-[10px] text-rose-400">Missing</span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <h3 className="truncate text-sm font-semibold text-slate-100">
                        {entity.displayName}
                      </h3>
                      <span className="shrink-0 rounded border border-[#F5B82E]/40 bg-[#F5B82E]/10 px-1.5 py-0.5 font-mono text-[10px] text-[#F5B82E]">
                        {entity.bodyType}
                      </span>
                    </div>
                    <p className="truncate font-mono text-[11px] text-slate-400">
                      res://{entity.resSubpath}/{entity.slug}/{entity.slug}.tscn
                    </p>
                    <p className="mt-1 text-[11px] text-slate-400 tabular-nums">
                      {entity.clips.length} clip{entity.clips.length === 1 ? '' : 's'} ·{' '}
                      {entity.audioAssetIds.length} audio
                    </p>
                  </div>
                </div>

                {/* 5 Coverage Dots */}
                <div
                  data-testid={`entity-coverage-${entity.slug}`}
                  className="flex flex-wrap items-center gap-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5"
                >
                  {coverage.map((item) => (
                    <span
                      key={item.label}
                      data-covered={item.ok ? 'true' : 'false'}
                      className="inline-flex items-center gap-1 text-[10px] text-slate-300"
                    >
                      <span
                        className={`h-2 w-2 rounded-full ${
                          item.ok ? 'bg-emerald-400' : 'bg-zinc-600'
                        }`}
                      />
                      {item.label}
                    </span>
                  ))}
                </div>

                <div className="flex items-center justify-between gap-2 border-t border-[var(--border-hairline)] pt-2.5">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid={`entity-edit-${entity.slug}`}
                      onClick={() => handleOpenEdit(entity)}
                      className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                    >
                      <Settings2 className="h-3 w-3" />
                      Configure
                    </button>
                    <button
                      type="button"
                      data-testid={`entity-playtest-${entity.slug}`}
                      onClick={() => setPlaytestEntityId(entity.id)}
                      className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/25"
                    >
                      <Play className="h-3 w-3" />
                      Playtest
                    </button>
                    {primaryNode && (
                      <button
                        type="button"
                        data-testid={`entity-lighting-${entity.slug}`}
                        onClick={() => {
                          void (async () => {
                            const blobId = primaryNode.processedBlobId ?? primaryNode.imageBlobId;
                            const rec = await repository.getBlob(blobId);
                            if (!rec) return;
                            const bytes = new Uint8Array(await rec.bytes.arrayBuffer());
                            const decoded = await decodePngBytesToRgba(bytes);
                            setLightingModal({
                              entity,
                              spriteNode: primaryNode,
                              sprite: {
                                width: decoded.width,
                                height: decoded.height,
                                data: decoded.rgba,
                              },
                            });
                          })();
                        }}
                        className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/25"
                      >
                        <Sun className="h-3 w-3" />
                        Lighting
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      data-testid={`entity-sync-${entity.slug}`}
                      onClick={() => void handleSyncSingleEntity(entity)}
                      className="inline-flex items-center gap-1 rounded bg-[#F5B82E]/15 px-2.5 py-1 text-[11px] font-medium text-[#F5B82E] hover:bg-[#F5B82E]/25"
                    >
                      {syncTarget && isFsaaSupported() ? (
                        <FolderSync className="h-3 w-3" />
                      ) : (
                        <FileArchive className="h-3 w-3" />
                      )}
                      Sync Unit
                    </button>
                    <button
                      type="button"
                      data-testid={`entity-delete-${entity.slug}`}
                      aria-label={`Delete ${entity.displayName}`}
                      onClick={() => void deleteEntityRecord(entity.id, activeProject.id)}
                      className="rounded p-1.5 text-slate-400 hover:bg-rose-950/60 hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Create / Edit Entity Drawer */}
      {drawerOpen && draft && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/60 backdrop-blur-xs">
          <div
            data-testid="entity-editor-drawer"
            className="flex h-full w-full max-w-xl flex-col border-l border-[var(--border-hairline)] bg-[var(--bg-panel)] shadow-2xl"
          >
            <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  Configure Godot 4 Entity Prefab
                </h3>
                <p className="font-mono text-[11px] text-slate-400">
                  res://{normalizeResSubpath(draft.resSubpath)}/{sanitizeEntitySlug(draft.slug)}/
                  {sanitizeEntitySlug(draft.slug)}.tscn
                </p>
              </div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="grid grid-cols-3 gap-1 border-b border-[var(--border-hairline)] bg-[var(--bg-well)] p-2 text-xs">
              <button
                type="button"
                data-testid="entity-tab-config"
                onClick={() => setDrawerTab('config')}
                className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 font-medium ${
                  drawerTab === 'config'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Settings2 className="h-3.5 w-3.5" />
                Configure
              </button>
              <button
                type="button"
                data-testid="entity-tab-tscn"
                onClick={() => setDrawerTab('tscn')}
                className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 font-medium ${
                  drawerTab === 'tscn'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Code2 className="h-3.5 w-3.5" />
                .tscn Preview
              </button>
              <button
                type="button"
                data-testid="entity-tab-gdscript"
                onClick={() => setDrawerTab('gdscript')}
                className={`inline-flex items-center justify-center gap-1.5 rounded px-3 py-1.5 font-medium ${
                  drawerTab === 'gdscript'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <FileCode2 className="h-3.5 w-3.5" />
                .gd Script
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {drawerTab === 'config' ? (
                <div className="space-y-4 text-xs">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-slate-300">
                      <span>Display Name</span>
                      <input
                        type="text"
                        data-testid="entity-name-input"
                        value={draft.displayName}
                        onChange={(e) => {
                          const displayName = e.target.value;
                          setDraft({
                            ...draft,
                            displayName,
                            slug: slugLocked ? draft.slug : sanitizeEntitySlug(displayName),
                          });
                        }}
                        className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-100"
                      />
                    </label>

                    <label className="space-y-1 text-slate-300">
                      <span>Entity Slug (snake_case)</span>
                      <input
                        type="text"
                        data-testid="entity-slug-input"
                        value={draft.slug}
                        onChange={(e) => {
                          setSlugLocked(true);
                          setDraft({ ...draft, slug: sanitizeEntitySlug(e.target.value) });
                        }}
                        className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 font-mono text-slate-100"
                      />
                    </label>
                  </div>

                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-slate-300">
                      <span>Godot Root Body</span>
                      <select
                        data-testid="entity-body-type-select"
                        value={draft.bodyType}
                        onChange={(e) =>
                          setDraft({ ...draft, bodyType: e.target.value as GodotBodyType })
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

                    <label className="space-y-1 text-slate-300">
                      <span>Target res:// Subpath</span>
                      <input
                        type="text"
                        data-testid="entity-res-subpath-input"
                        value={draft.resSubpath}
                        onChange={(e) => setDraft({ ...draft, resSubpath: e.target.value })}
                        className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 font-mono text-slate-100"
                      />
                    </label>
                  </div>

                  <label className="block space-y-1 text-slate-300">
                    <span>Primary SpriteNode (Colliders, Sockets & Base Texture)</span>
                    <select
                      data-testid="entity-primary-sprite-select"
                      value={draft.primarySpriteNodeId}
                      onChange={(e) => {
                        const spriteNodeId = e.target.value;
                        const updatedClips =
                          draft.clips.length > 0
                            ? draft.clips
                            : [{ name: 'idle', spriteNodeId, fps: 8, loop: true }];
                        setDraft({
                          ...draft,
                          primarySpriteNodeId: spriteNodeId,
                          clips: updatedClips,
                        });
                      }}
                      className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-slate-100"
                    >
                      {spriteNodes.map((node) => (
                        <option key={node.id} value={node.id}>
                          {node.kind} · seed #{node.generationMeta.seed} (
                          {node.collisionShapes?.length ?? 0} shapes, {node.sockets?.length ?? 0}{' '}
                          sockets)
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="block space-y-1 text-slate-300">
                    <span>Optional Attached Script (res://...)</span>
                    <input
                      type="text"
                      data-testid="entity-script-path-input"
                      placeholder="res://scripts/goblin_scout.gd"
                      value={draft.scriptResPath ?? ''}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          scriptResPath: e.target.value || undefined,
                        })
                      }
                      className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 font-mono text-slate-100"
                    />
                  </label>

                  <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-2 text-slate-200">
                    <span>Bake Normal Map (`_n.png`) & `CanvasTexture` `.tres`</span>
                    <input
                      type="checkbox"
                      data-testid="entity-normal-toggle"
                      checked={draft.includeNormalMap}
                      onChange={(e) => setDraft({ ...draft, includeNormalMap: e.target.checked })}
                      className="accent-[#F5B82E]"
                    />
                  </label>

                  {/* Animation Clips */}
                  <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold tracking-wider text-slate-300 uppercase">
                        Animation Clips ({draft.clips.length})
                      </span>
                      <button
                        type="button"
                        data-testid="entity-add-clip-btn"
                        onClick={addClip}
                        className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-[#F5B82E] hover:bg-slate-800"
                      >
                        <Plus className="h-3 w-3" />
                        Add Clip
                      </button>
                    </div>

                    <div className="space-y-2">
                      {draft.clips.map((clip, idx) => (
                        <div
                          key={idx}
                          className="grid grid-cols-12 items-center gap-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2"
                        >
                          <input
                            type="text"
                            value={clip.name}
                            onChange={(e) => {
                              const next = [...draft.clips];
                              next[idx] = { ...clip, name: e.target.value };
                              setDraft({ ...draft, clips: next });
                            }}
                            className="col-span-4 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 font-mono text-[11px] text-slate-100"
                          />
                          <select
                            value={clip.spriteNodeId}
                            onChange={(e) => {
                              const next = [...draft.clips];
                              next[idx] = { ...clip, spriteNodeId: e.target.value };
                              setDraft({ ...draft, clips: next });
                            }}
                            className="col-span-4 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-1.5 py-1 text-[11px] text-slate-200"
                          >
                            {spriteNodes.map((n) => (
                              <option key={n.id} value={n.id}>
                                #{n.generationMeta.seed}
                              </option>
                            ))}
                          </select>
                          <input
                            type="number"
                            min={1}
                            max={60}
                            value={clip.fps}
                            onChange={(e) => {
                              const next = [...draft.clips];
                              next[idx] = {
                                ...clip,
                                fps: Math.max(1, Math.min(60, Number(e.target.value) || 8)),
                              };
                              setDraft({ ...draft, clips: next });
                            }}
                            className="col-span-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-1.5 py-1 text-center font-mono text-[11px] text-slate-100 tabular-nums"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const next = draft.clips.filter((_, ci) => ci !== idx);
                              setDraft({ ...draft, clips: next });
                            }}
                            className="col-span-2 flex justify-center text-slate-400 hover:text-rose-300"
                            title="Remove clip"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Audio Assets */}
                  <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
                    <span className="font-semibold tracking-wider text-slate-300 uppercase">
                      Bound Audio Clips ({audioAssets.length})
                    </span>
                    {audioAssets.length === 0 ? (
                      <p className="text-[11px] text-slate-400">
                        No audio clips yet. Generate procedural or AI SFX in Audio Foundry to bind
                        them to <code>AudioStreamPlayer2D</code>.
                      </p>
                    ) : (
                      <div className="space-y-1.5">
                        {audioAssets.map((asset) => {
                          const checked = draft.audioAssetIds.includes(asset.id);
                          return (
                            <label
                              key={asset.id}
                              className="flex cursor-pointer items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 text-[11px] text-slate-200"
                            >
                              <span>
                                {asset.name}{' '}
                                <span className="font-mono text-[10px] text-slate-400">
                                  ({asset.durationSec.toFixed(2)}s · {asset.lufs.toFixed(1)} LUFS)
                                </span>
                              </span>
                              <input
                                type="checkbox"
                                data-testid={`entity-audio-checkbox-${asset.id}`}
                                checked={checked}
                                onChange={() => toggleAudioAsset(asset.id)}
                                className="accent-[#F5B82E]"
                              />
                            </label>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              ) : drawerTab === 'tscn' ? (
                <div className="space-y-3 text-xs">
                  <div className="space-y-1">
                    <span className="text-[11px] font-semibold text-slate-300">
                      Generated Prefab Files ({previewFiles.length})
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {previewFiles.map((f) => (
                        <span
                          key={f.relativePath}
                          className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-0.5 font-mono text-[10px] text-slate-300"
                        >
                          {f.relativePath.split('/').pop()}
                        </span>
                      ))}
                    </div>
                  </div>

                  <pre
                    data-testid="entity-tscn-preview"
                    className="max-h-[480px] overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-slate-200"
                  >
                    {tscnPreviewText}
                  </pre>
                </div>
              ) : (
                <div className="space-y-2 text-xs">
                  <p className="font-mono text-[11px] text-slate-400">
                    {draft.scriptResPath ||
                      `res://${normalizeResSubpath(draft.resSubpath)}/${sanitizeEntitySlug(draft.slug)}/${sanitizeEntitySlug(draft.slug)}.gd`}
                  </p>
                  <pre
                    data-testid="entity-gdscript-preview"
                    className="max-h-[500px] overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3 font-mono text-[11px] leading-relaxed whitespace-pre text-slate-200"
                  >
                    {draft.scriptContent ||
                      '# No attached GDScript controller yet.\n# Use Prompt-to-Entity (AI) to generate a typed Godot 4.3+ .gd controller.'}
                  </pre>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-4 py-3">
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-3 py-1.5 text-xs text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="entity-save-btn"
                disabled={saving}
                onClick={() => void handleSave()}
                className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                <Save className="h-3.5 w-3.5" />
                {saving ? 'Saving...' : 'Save Entity'}
              </button>
            </div>
          </div>
        </div>
      )}

      <EntityDirectorModal
        open={directorOpen}
        onClose={() => setDirectorOpen(false)}
        onCreated={(created) => {
          setStatusBanner(
            `Built entity "${created.displayName}" (${created.slug}) with typed Godot 4.3+ script.`,
          );
        }}
      />

      {(() => {
        const activePlaytest = playtestEntityId
          ? entities.find((e) => e.id === playtestEntityId)
          : undefined;
        if (!activePlaytest) return null;
        return (
          <EntityPlaytestStage
            entity={activePlaytest}
            project={activeProject}
            spriteNodes={spriteNodes}
            audioAssets={audioAssets}
            onApplyStats={async (updated) => {
              await saveEntityRecord(updated);
              setStatusBanner(
                `Updated "${updated.slug}" playtest stats & GDScript @export values.`,
              );
            }}
            onClose={() => setPlaytestEntityId(null)}
          />
        );
      })()}
      {lightingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-xs">
          <LightingBakerPanel
            sprite={lightingModal.sprite}
            spriteNode={lightingModal.spriteNode}
            artMode={activeProject.artBible.artMode}
            paletteHex={activeProject.artBible.palette}
            slug={lightingModal.entity.slug}
            onBaked={(updatedNode) => {
              setLightingModal((prev) => (prev ? { ...prev, spriteNode: updatedNode } : null));
              void refreshSpriteNodes(activeProject.id);
              setStatusBanner(
                `Baked _n.png + CanvasTexture metadata for "${lightingModal.entity.slug}". Ready for Godot res:// sync.`,
              );
            }}
            onClose={() => setLightingModal(null)}
          />
        </div>
      )}
    </div>
  );
}
