import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  Copy,
  Download,
  Eraser,
  FolderSync,
  Grid,
  MapPin,
  Minus,
  Plus,
  Save,
  Sparkles,
  Square,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { OFFLINE_MOCK_PROVIDER_ID, db } from '../../db/database';
import { normalizeResSubpath, sanitizeEntitySlug } from '../../domain/entitySchema';
import type {
  ArtMode,
  PostProcessConfig,
  Project,
  ProviderConfig,
  SpriteNode,
} from '../../domain/schemas';
import { exportGodotRoomTscn, packageRoomBundleZip } from '../../export/godotRoomExporter';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { triggerBlobDownload } from '../../export/zipPackager';
import { BIT_E, BIT_N, BIT_S, BIT_W } from '../../processing/autoTile';
import { computeArtBibleHash } from '../../processing/projectAudit';
import {
  resolveRoomAutoTileCells,
  sanitizeRoomPlacements,
  sanitizeRoomSlug,
  type RoomCellKind,
  type RoomLayoutBlueprint,
  type RoomTileSetMode,
  type StoredRoomRecord,
} from '../../processing/roomLayoutCore';
import { redactSecrets } from '../../providers/errors';
import {
  ROOM_STARTER_PRESETS,
  estimateRoomPrototyperCost,
  generateMockRoomBlueprint,
  generateRoomBlueprint,
} from '../../providers/roomPrototyperAdapter';
import { useAppStore } from '../../store/useAppStore';
import {
  bindGodotDirectory,
  collectProjectGodotSyncFiles,
  getBoundDirectoryHandle,
  isFsaaSupported,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';
import { ScrubInput } from '../primitives/ScrubInput';

export interface RoomPrototyperWorkshopProps {
  readonly artMode: ArtMode;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly spriteNodes: readonly SpriteNode[];
  readonly providers: readonly ProviderConfig[];
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
}

type RoomToolMode = 'solid' | 'platform' | 'erase' | 'entity' | 'spawn';

const CELL_DRAW_PX = 24;

function resizeRoomCells(
  cells: readonly (readonly RoomCellKind[])[],
  nextCols: number,
  nextRows: number,
): RoomCellKind[][] {
  return Array.from({ length: nextRows }, (_, y) =>
    Array.from({ length: nextCols }, (_, x) => {
      const existing = cells[y]?.[x];
      if (existing === 1 || existing === 2) return existing;
      if (y === 0 || y === nextRows - 1 || x === 0 || x === nextCols - 1) return 1;
      return 0;
    }),
  );
}

function pickDefaultRoomProviderId(providers: readonly ProviderConfig[]): string {
  const gemini = providers.find((p) => p.enabled && p.kind === 'gemini' && p.apiKey.trim());
  if (gemini) return gemini.id;
  return (
    providers.find((p) => p.id === OFFLINE_MOCK_PROVIDER_ID)?.id ??
    providers[0]?.id ??
    OFFLINE_MOCK_PROVIDER_ID
  );
}

export function RoomPrototyperWorkshop({
  artMode,
  project,
  targetNode,
  spriteNodes,
  providers,
  postProcessConfig,
  rawWidth,
  rawHeight,
}: RoomPrototyperWorkshopProps) {
  const {
    rooms,
    entities,
    audioAssets,
    syncTarget,
    focusedRoomId,
    setFocusedRoomId,
    saveRoomRecord,
    deleteRoomRecord,
    refreshSyncTarget,
  } = useAppStore();

  const entitySlugs = useMemo(
    () =>
      entities.length > 0
        ? entities.map((e) => sanitizeEntitySlug(e.slug || e.displayName))
        : ['goblin_scout', 'treasure_chest'],
    [entities],
  );

  const entityResPaths = useMemo(() => {
    const map: Record<string, string> = {};
    for (const ent of entities) {
      const slug = sanitizeEntitySlug(ent.slug || ent.displayName);
      map[slug] = `res://${normalizeResSubpath(ent.resSubpath)}/${slug}/${slug}.tscn`;
    }
    return map;
  }, [entities]);

  const initialRecord = rooms[0] ?? null;
  const [activeRoomId, setActiveRoomId] = useState<string>(
    () => initialRecord?.id ?? globalThis.crypto.randomUUID(),
  );
  const [blueprint, setBlueprint] = useState<RoomLayoutBlueprint>(() =>
    initialRecord
      ? initialRecord.blueprint
      : generateMockRoomBlueprint({
          prompt: ROOM_STARTER_PRESETS[0]!.prompt,
          cols: 24,
          rows: 14,
          tileSizePx: 32,
          availableEntitySlugs: entitySlugs,
        }),
  );
  const [tileSetNodeId, setTileSetNodeId] = useState<string | null>(
    () => initialRecord?.tileSetNodeId ?? null,
  );
  const [tileSetMode, setTileSetMode] = useState<RoomTileSetMode>(
    () => initialRecord?.tileSetMode ?? 'blob47',
  );
  const [parallaxNodeId, setParallaxNodeId] = useState<string | null>(
    () => initialRecord?.parallaxNodeId ?? null,
  );

  const [selectedProviderId, setSelectedProviderId] = useState<string>(() =>
    pickDefaultRoomProviderId(providers),
  );
  const [tool, setTool] = useState<RoomToolMode>('solid');
  const [entityBrushSlug, setEntityBrushSlug] = useState<string>(
    () => entitySlugs[0] ?? 'goblin_scout',
  );
  const [entityFacing, setEntityFacing] = useState<'left' | 'right'>('left');
  const [zoomScale, setZoomScale] = useState<number>(1.0);
  const [showGrid, setShowGrid] = useState<boolean>(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [syncNotice, setSyncNotice] = useState<string | null>(null);
  const [copiedTscn, setCopiedTscn] = useState(false);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const isPaintingRef = useRef(false);
  const lastPaintedCellRef = useRef<string | null>(null);
  const hasDirtyLocalEditsRef = useRef(false);

  // Focus a flagged room when jumping from M45 World Map Softlock Audit
  useEffect(() => {
    if (!focusedRoomId) return;
    const match = rooms.find((r) => r.id === focusedRoomId);
    if (!match) return;
    hasDirtyLocalEditsRef.current = false;
    setActiveRoomId(match.id);
    setBlueprint(match.blueprint);
    setTileSetNodeId(match.tileSetNodeId);
    setTileSetMode(match.tileSetMode);
    setParallaxNodeId(match.parallaxNodeId);
    setFocusedRoomId(null);
  }, [focusedRoomId, rooms, setFocusedRoomId]);

  // Hydrate first saved room when IndexedDB store loads asynchronously on page reload
  useEffect(() => {
    if (rooms.length === 0 || hasDirtyLocalEditsRef.current) return;
    const match = rooms.find((r) => r.id === activeRoomId) ?? rooms[0]!;
    setActiveRoomId(match.id);
    setBlueprint(match.blueprint);
    setTileSetNodeId(match.tileSetNodeId);
    setTileSetMode(match.tileSetMode);
    setParallaxNodeId(match.parallaxNodeId);
  }, [rooms, activeRoomId]);

  const activeProvider = useMemo(
    () =>
      providers.find((p) => p.id === selectedProviderId) ??
      providers.find((p) => p.id === OFFLINE_MOCK_PROVIDER_ID) ??
      providers[0],
    [providers, selectedProviderId],
  );

  const costEstimate = useMemo(
    () => estimateRoomPrototyperCost(activeProvider?.kind ?? 'mock'),
    [activeProvider],
  );

  const tileSetNodes = useMemo(
    () =>
      spriteNodes.filter(
        (n) => Boolean(n.autoTile) || n.seamlessTile?.isSeamlessTile || n.assetClass === 'tile',
      ),
    [spriteNodes],
  );
  const parallaxNodes = useMemo(
    () => spriteNodes.filter((n) => Boolean(n.parallaxScene)),
    [spriteNodes],
  );

  const resolvedTileSetNode = useMemo(
    () => spriteNodes.find((n) => n.id === tileSetNodeId),
    [spriteNodes, tileSetNodeId],
  );
  const resolvedParallaxNode = useMemo(
    () => spriteNodes.find((n) => n.id === parallaxNodeId),
    [spriteNodes, parallaxNodeId],
  );

  const tileSetResPath = resolvedTileSetNode
    ? `res://tilesets/${sanitizeRoomSlug(resolvedTileSetNode.generationMeta.promptDelta || resolvedTileSetNode.id)}_tileset.tres`
    : undefined;
  const parallaxResPath = resolvedParallaxNode
    ? `res://parallax/${sanitizeRoomSlug(resolvedParallaxNode.generationMeta.promptDelta || resolvedParallaxNode.id)}_parallax.tscn`
    : undefined;

  const tscnContent = useMemo(
    () =>
      exportGodotRoomTscn({
        blueprint,
        tileSetMode,
        ...(tileSetResPath ? { tileSetResPath } : {}),
        ...(parallaxResPath ? { parallaxResPath } : {}),
        entityResPaths,
        isPixelArt: artMode === 'pixel-art',
      }),
    [blueprint, tileSetMode, tileSetResPath, parallaxResPath, entityResPaths, artMode],
  );

  const resolvedAutoCells = useMemo(
    () => resolveRoomAutoTileCells(blueprint, tileSetMode),
    [blueprint, tileSetMode],
  );

  const cellStats = useMemo(() => {
    let solid = 0;
    let platform = 0;
    for (const c of resolvedAutoCells) {
      if (c.kind === 1) solid++;
      else platform++;
    }
    return { solid, platform };
  }, [resolvedAutoCells]);

  // Draw live Canvas2D room preview
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const width = blueprint.cols * CELL_DRAW_PX;
    const height = blueprint.rows * CELL_DRAW_PX;
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = artMode !== 'pixel-art';

    // Sky / Parallax preview backdrop
    const grad = ctx.createLinearGradient(0, 0, 0, height);
    if (resolvedParallaxNode?.parallaxScene) {
      grad.addColorStop(0, resolvedParallaxNode.parallaxScene.skyTopHex || '#181A2F');
      grad.addColorStop(1, resolvedParallaxNode.parallaxScene.horizonHex || '#29366F');
    } else {
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(1, '#1e293b');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    const paletteFill = project.artBible.palette[1] ?? '#3b4252';
    const paletteAccent = project.artBible.palette[2] ?? '#88c0d0';

    // Render auto-tiled solid & one-way platform cells
    for (const cell of resolvedAutoCells) {
      const px = cell.x * CELL_DRAW_PX;
      const py = cell.y * CELL_DRAW_PX;

      if (cell.kind === 2) {
        ctx.fillStyle = '#d97706';
        ctx.fillRect(px + 1, py + 2, CELL_DRAW_PX - 2, 7);
        ctx.fillStyle = '#fcd34d';
        ctx.fillRect(px + 1, py + 2, CELL_DRAW_PX - 2, 2);
        continue;
      }

      ctx.fillStyle = paletteFill;
      ctx.fillRect(px, py, CELL_DRAW_PX, CELL_DRAW_PX);

      // Highlight exposed top/left edges & darken exposed right/bottom edges according to M20 mask
      const hasN = (cell.mask & BIT_N) !== 0;
      const hasS = (cell.mask & BIT_S) !== 0;
      const hasW = (cell.mask & BIT_W) !== 0;
      const hasE = (cell.mask & BIT_E) !== 0;

      ctx.fillStyle = paletteAccent;
      if (!hasN) ctx.fillRect(px, py, CELL_DRAW_PX, 3);
      if (!hasW) ctx.fillRect(px, py, 3, CELL_DRAW_PX);

      ctx.fillStyle = '#090d16';
      if (!hasS) ctx.fillRect(px, py + CELL_DRAW_PX - 3, CELL_DRAW_PX, 3);
      if (!hasE) ctx.fillRect(px + CELL_DRAW_PX - 3, py, 3, CELL_DRAW_PX);
    }

    if (showGrid) {
      ctx.strokeStyle = 'rgba(148, 163, 184, 0.16)';
      ctx.lineWidth = 1;
      for (let c = 0; c <= blueprint.cols; c++) {
        ctx.beginPath();
        ctx.moveTo(c * CELL_DRAW_PX + 0.5, 0);
        ctx.lineTo(c * CELL_DRAW_PX + 0.5, height);
        ctx.stroke();
      }
      for (let r = 0; r <= blueprint.rows; r++) {
        ctx.beginPath();
        ctx.moveTo(0, r * CELL_DRAW_PX + 0.5);
        ctx.lineTo(width, r * CELL_DRAW_PX + 0.5);
        ctx.stroke();
      }
    }

    // PlayerSpawn Marker2D badge
    const spX = (blueprint.playerSpawn.cellX + 0.5) * CELL_DRAW_PX;
    const spY = (blueprint.playerSpawn.cellY + 0.5) * CELL_DRAW_PX;
    ctx.fillStyle = '#10b981';
    ctx.beginPath();
    ctx.arc(spX, spY, CELL_DRAW_PX * 0.36, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ecfdf5';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.fillStyle = '#022c22';
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('P', spX, spY + 0.5);

    // Entity spawn markers
    for (const ent of blueprint.entities) {
      const ex = (ent.cellX + 0.5) * CELL_DRAW_PX;
      const ey = (ent.cellY + 0.5) * CELL_DRAW_PX;
      const isChest = ent.entitySlug.includes('chest') || ent.entitySlug.includes('pickup');
      ctx.fillStyle = isChest ? '#f59e0b' : '#f43f5e';
      ctx.fillRect(ex - 7, ey - 7, 14, 14);
      ctx.strokeStyle = '#fff1f2';
      ctx.lineWidth = 1;
      ctx.strokeRect(ex - 7, ey - 7, 14, 14);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 9px monospace';
      ctx.fillText(ent.facing === 'left' ? '<' : '>', ex, ey + 0.5);
    }
  }, [
    blueprint,
    resolvedAutoCells,
    showGrid,
    artMode,
    project.artBible.palette,
    resolvedParallaxNode,
  ]);

  const applyToolAtCell = useCallback(
    (cellX: number, cellY: number) => {
      hasDirtyLocalEditsRef.current = true;
      setStatusNotice(null);
      setBlueprint((prev) => {
        if (cellX < 0 || cellY < 0 || cellX >= prev.cols || cellY >= prev.rows) return prev;

        if (tool === 'spawn') {
          if (prev.cells[cellY]?.[cellX] === 1) {
            return prev;
          }
          return {
            ...prev,
            playerSpawn: { cellX, cellY },
          };
        }

        if (tool === 'entity') {
          if (prev.cells[cellY]?.[cellX] === 1) return prev;
          const existingIdx = prev.entities.findIndex(
            (e) => e.cellX === cellX && e.cellY === cellY,
          );
          if (existingIdx >= 0) {
            return {
              ...prev,
              entities: prev.entities.filter((_, i) => i !== existingIdx),
            };
          }
          const slug = sanitizeRoomSlug(entityBrushSlug || 'goblin_scout');
          return {
            ...prev,
            entities: [
              ...prev.entities,
              {
                id: `${slug}_${Date.now().toString(36)}_${prev.entities.length + 1}`,
                entitySlug: slug,
                cellX,
                cellY,
                patrolSpanCells: slug.includes('chest') ? 0 : 3,
                facing: entityFacing,
              },
            ],
          };
        }

        const nextKind: RoomCellKind = tool === 'solid' ? 1 : tool === 'platform' ? 2 : 0;
        if (prev.cells[cellY]?.[cellX] === nextKind) return prev;
        const nextCells = prev.cells.map((row, r) =>
          r === cellY ? row.map((v, c) => (c === cellX ? nextKind : v)) : row,
        );
        return sanitizeRoomPlacements({
          ...prev,
          cells: nextCells,
        });
      });
    },
    [tool, entityBrushSlug, entityFacing],
  );

  const clientToCell = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = Math.max(
      0,
      Math.min(
        blueprint.cols - 1,
        Math.floor(((clientX - rect.left) / rect.width) * blueprint.cols),
      ),
    );
    const y = Math.max(
      0,
      Math.min(
        blueprint.rows - 1,
        Math.floor(((clientY - rect.top) / rect.height) * blueprint.rows),
      ),
    );
    return { x, y };
  };

  const handleCanvasPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    const pt = clientToCell(e.clientX, e.clientY);
    if (!pt) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // ignore synthetic events
    }
    isPaintingRef.current = tool === 'solid' || tool === 'platform' || tool === 'erase';
    lastPaintedCellRef.current = `${pt.x},${pt.y}`;
    applyToolAtCell(pt.x, pt.y);
  };

  const handleCanvasPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!isPaintingRef.current) return;
    const pt = clientToCell(e.clientX, e.clientY);
    if (!pt) return;
    const key = `${pt.x},${pt.y}`;
    if (key === lastPaintedCellRef.current) return;
    lastPaintedCellRef.current = key;
    applyToolAtCell(pt.x, pt.y);
  };

  const handleCanvasPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>) => {
    isPaintingRef.current = false;
    lastPaintedCellRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // ignore
    }
  };

  const handleResizeDimensions = (nextCols: number, nextRows: number) => {
    hasDirtyLocalEditsRef.current = true;
    setBlueprint((prev) =>
      sanitizeRoomPlacements({
        ...prev,
        cols: nextCols,
        rows: nextRows,
        cells: resizeRoomCells(prev.cells, nextCols, nextRows),
      }),
    );
  };

  const handleGenerateRoom = async () => {
    if (!activeProvider) return;
    setIsGenerating(true);
    setErrorMessage(null);
    setStatusNotice(null);
    try {
      const res = await generateRoomBlueprint({
        prompt: blueprint.prompt,
        cols: blueprint.cols,
        rows: blueprint.rows,
        tileSizePx: blueprint.tileSizePx,
        artBible: project.artBible,
        availableEntitySlugs: entitySlugs,
        providerConfig: activeProvider,
      });
      hasDirtyLocalEditsRef.current = true;
      setBlueprint(res.blueprint);
      setStatusNotice(
        res.usedMock
          ? `Synthesized ${res.blueprint.cols}×${res.blueprint.rows} offline room layout.`
          : `Generated ${res.blueprint.cols}×${res.blueprint.rows} AI room layout.`,
      );
    } catch (err) {
      const secrets = providers.map((p) => p.apiKey);
      const msg = err instanceof Error ? err.message : 'Room generation failed.';
      setErrorMessage(redactSecrets(msg, secrets));
    } finally {
      setIsGenerating(false);
    }
  };

  const buildCurrentStoredRecord = (): StoredRoomRecord => {
    const cleanBp = sanitizeRoomPlacements(blueprint);
    return {
      id: activeRoomId,
      projectId: project.id,
      slug: cleanBp.slug,
      tileSetNodeId,
      tileSetMode,
      parallaxNodeId,
      blueprint: cleanBp,
      updatedAt: Date.now(),
    };
  };

  const handleSaveRoom = async () => {
    setErrorMessage(null);
    const saved = await saveRoomRecord(buildCurrentStoredRecord());
    hasDirtyLocalEditsRef.current = false;
    setBlueprint(saved.blueprint);
    setStatusNotice(`Saved "${saved.blueprint.displayName}" (levels/${saved.slug}.tscn)`);
    return saved;
  };

  const handleNewRoom = () => {
    hasDirtyLocalEditsRef.current = true;
    const nextId = globalThis.crypto.randomUUID();
    const fresh = generateMockRoomBlueprint({
      prompt: ROOM_STARTER_PRESETS[0]!.prompt,
      cols: 24,
      rows: 14,
      tileSizePx: 32,
      availableEntitySlugs: entitySlugs,
    });
    setActiveRoomId(nextId);
    setBlueprint({
      ...fresh,
      slug: `room_${rooms.length + 1}`,
      displayName: `Room ${rooms.length + 1}`,
    });
    setStatusNotice('Started new room draft.');
  };

  const handleDeleteRoom = async () => {
    await deleteRoomRecord(activeRoomId, project.id);
    hasDirtyLocalEditsRef.current = false;
    setStatusNotice('Deleted saved room.');
  };

  const handleSyncRoomToGodot = async () => {
    setIsSyncing(true);
    setErrorMessage(null);
    setSyncNotice(null);
    try {
      const saved = await handleSaveRoom();
      if (!isFsaaSupported()) {
        throw new Error('File System Access API (showDirectoryPicker) is unavailable.');
      }
      let handle = await getBoundDirectoryHandle(db, project.id);
      if (!handle) {
        await bindGodotDirectory(db, project.id);
        handle = await getBoundDirectoryHandle(db, project.id);
      }
      const nextRooms = [saved, ...rooms.filter((r) => r.id !== saved.id)];
      const files = await collectProjectGodotSyncFiles(
        db,
        project,
        entities,
        spriteNodes,
        audioAssets,
        nextRooms,
      );
      const res = await syncFilesToGodotDirectory(db, project.id, files);
      await refreshSyncTarget(project.id);
      setSyncNotice(
        `Synced levels/${saved.slug}.tscn (${res.writtenCount} written to ${res.folderName})`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Godot res:// sync failed.';
      setErrorMessage(
        redactSecrets(
          msg,
          providers.map((p) => p.apiKey),
        ),
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const handleDownloadBundleZip = () => {
    const cleanBp = sanitizeRoomPlacements(blueprint);
    const recipe = buildAssetRecipe({
      project,
      node: targetNode,
      postProcess: postProcessConfig,
      filename: `levels/${cleanBp.slug}.tscn`,
      outputWidth: cleanBp.cols * cleanBp.tileSizePx,
      outputHeight: cleanBp.rows * cleanBp.tileSizePx,
      normalizedWidth: rawWidth,
      normalizedHeight: rawHeight,
      recipeArtBibleHash: computeArtBibleHash(project.artBible),
      roomLayout: cleanBp,
    });
    const zipBytes = packageRoomBundleZip({
      slug: cleanBp.slug,
      tscnContent,
      recipe,
    });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'application/zip' }),
      `${cleanBp.slug}_level_bundle.zip`,
    );
    setStatusNotice(`Downloaded ${cleanBp.slug}_level_bundle.zip`);
  };

  return (
    <div
      data-testid="room-workshop-panel"
      className="flex h-full min-h-0 flex-1 overflow-hidden bg-slate-950 text-slate-100"
    >
      {/* Left Pane: AI Prompt, Grid Sizing & Asset Bindings */}
      <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-r border-slate-800 bg-slate-900/70 p-3 text-xs">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Room Director
          </h3>
          <span
            data-testid="room-cost-badge"
            className="rounded bg-slate-800 px-2 py-0.5 text-[11px] font-medium text-emerald-300"
          >
            {costEstimate.label}
          </span>
        </div>

        {/* Saved rooms selector */}
        <div className="flex items-center gap-1.5">
          <select
            data-testid="room-saved-select"
            value={rooms.some((r) => r.id === activeRoomId) ? activeRoomId : ''}
            onChange={(e) => {
              const found = rooms.find((r) => r.id === e.target.value);
              if (!found) return;
              hasDirtyLocalEditsRef.current = false;
              setActiveRoomId(found.id);
              setBlueprint(found.blueprint);
              setTileSetNodeId(found.tileSetNodeId);
              setTileSetMode(found.tileSetMode);
              setParallaxNodeId(found.parallaxNodeId);
            }}
            className="min-w-0 flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-200"
          >
            {!rooms.some((r) => r.id === activeRoomId) && (
              <option value="">Draft: {blueprint.displayName}</option>
            )}
            {rooms.map((r) => (
              <option key={r.id} value={r.id}>
                {r.blueprint.displayName} ({r.blueprint.cols}×{r.blueprint.rows})
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="room-new-btn"
            onClick={handleNewRoom}
            title="New Room"
            className="rounded border border-slate-700 bg-slate-800 p-1.5 text-slate-200 hover:bg-slate-700"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
          {rooms.some((r) => r.id === activeRoomId) && (
            <button
              type="button"
              data-testid="room-delete-btn"
              onClick={() => void handleDeleteRoom()}
              title="Delete Saved Room"
              className="rounded border border-rose-900/60 bg-rose-950/50 p-1.5 text-rose-300 hover:bg-rose-900/60"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-400">Room Name &amp; Slug</span>
          <input
            type="text"
            data-testid="room-name-input"
            value={blueprint.displayName}
            onChange={(e) => {
              const displayName = e.target.value;
              hasDirtyLocalEditsRef.current = true;
              setBlueprint((prev) => ({
                ...prev,
                displayName,
                slug: sanitizeRoomSlug(displayName || prev.slug),
              }));
            }}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-100"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-slate-400">Room Prompt</span>
          <textarea
            data-testid="room-prompt-input"
            rows={3}
            value={blueprint.prompt}
            onChange={(e) => {
              const prompt = e.target.value;
              hasDirtyLocalEditsRef.current = true;
              setBlueprint((prev) => ({ ...prev, prompt }));
            }}
            className="resize-none rounded border border-slate-700 bg-slate-950 p-2 text-xs text-slate-100"
            placeholder="Dungeon boss arena with stone pillars, raised side platforms, and 3 goblin scouts"
          />
        </label>

        <div className="flex flex-wrap gap-1">
          {ROOM_STARTER_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-testid={`room-preset-${preset.id}`}
              onClick={() => {
                hasDirtyLocalEditsRef.current = true;
                setBlueprint((prev) =>
                  sanitizeRoomPlacements({
                    ...prev,
                    prompt: preset.prompt,
                    displayName: preset.label,
                    slug: sanitizeRoomSlug(preset.label),
                    cols: preset.cols,
                    rows: preset.rows,
                    cells: resizeRoomCells(prev.cells, preset.cols, preset.rows),
                  }),
                );
              }}
              className="rounded border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-[10px] text-slate-300 hover:border-indigo-500/60 hover:text-white"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-2 gap-2">
          <ScrubInput
            label="Cols"
            testId="room-cols-scrub"
            value={blueprint.cols}
            min={12}
            max={64}
            step={1}
            onChange={(nextCols) => handleResizeDimensions(Math.round(nextCols), blueprint.rows)}
          />
          <ScrubInput
            label="Rows"
            testId="room-rows-scrub"
            value={blueprint.rows}
            min={8}
            max={32}
            step={1}
            onChange={(nextRows) => handleResizeDimensions(blueprint.cols, Math.round(nextRows))}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Tile Size</span>
            <select
              data-testid="room-tilesize-select"
              value={blueprint.tileSizePx}
              onChange={(e) => {
                hasDirtyLocalEditsRef.current = true;
                const px = Number(e.target.value) || 32;
                setBlueprint((prev) => ({ ...prev, tileSizePx: px }));
              }}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              <option value={16}>16 px</option>
              <option value={32}>32 px</option>
              <option value={64}>64 px</option>
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Provider</span>
            <select
              data-testid="room-provider-select"
              value={activeProvider?.id ?? OFFLINE_MOCK_PROVIDER_ID}
              onChange={(e) => setSelectedProviderId(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>
        </div>

        <button
          type="button"
          data-testid="room-generate-btn"
          disabled={isGenerating}
          onClick={() => void handleGenerateRoom()}
          className="flex items-center justify-center gap-1.5 rounded bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          <Sparkles className="h-3.5 w-3.5" />
          {isGenerating ? 'Planning Room...' : 'Generate Room (AI)'}
        </button>

        {errorMessage && (
          <div
            data-testid="room-error-banner"
            className="rounded border border-rose-700/70 bg-rose-950/70 p-2 text-[11px] text-rose-200"
          >
            {errorMessage}
          </div>
        )}

        <hr className="border-slate-800" />
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
          Godot Asset Bindings
        </div>

        <div className="grid grid-cols-2 gap-2">
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">M20 TileSet</span>
            <select
              data-testid="room-tileset-select"
              value={tileSetNodeId ?? ''}
              onChange={(e) => setTileSetNodeId(e.target.value || null)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              <option value="">Unbound (Default)</option>
              {tileSetNodes.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.generationMeta.promptDelta.slice(0, 24) || n.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Auto-Tile Mode</span>
            <select
              data-testid="room-tileset-mode-select"
              value={tileSetMode}
              onChange={(e) => setTileSetMode(e.target.value as RoomTileSetMode)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              <option value="blob47">Blob-47 (8×6)</option>
              <option value="wang16">Wang-16 (4×4)</option>
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1">
          <span className="text-[11px] text-slate-400">M23 Parallax Backdrop</span>
          <select
            data-testid="room-parallax-select"
            value={parallaxNodeId ?? ''}
            onChange={(e) => setParallaxNodeId(e.target.value || null)}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
          >
            <option value="">None (Solid Backdrop)</option>
            {parallaxNodes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.generationMeta.promptDelta.slice(0, 28) || n.id.slice(0, 8)}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-3 gap-2">
          <label className="col-span-2 flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">M25 Entity Brush</span>
            <select
              data-testid="room-entity-brush-select"
              value={entityBrushSlug}
              onChange={(e) => setEntityBrushSlug(e.target.value)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              {entitySlugs.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[11px] text-slate-400">Facing</span>
            <select
              data-testid="room-entity-facing-select"
              value={entityFacing}
              onChange={(e) => setEntityFacing(e.target.value as 'left' | 'right')}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-slate-100"
            >
              <option value="left">Left</option>
              <option value="right">Right</option>
            </select>
          </label>
        </div>
      </aside>

      {/* Center Pane: Interactive Canvas2D Grid Editor */}
      <main className="flex min-w-0 flex-1 flex-col bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {(
              [
                { id: 'solid', label: 'Paint Solid (1)', icon: Square, testId: 'room-tool-solid' },
                {
                  id: 'platform',
                  label: 'Paint Platform (2)',
                  icon: Minus,
                  testId: 'room-tool-platform',
                },
                { id: 'erase', label: 'Erase (0)', icon: Eraser, testId: 'room-tool-erase' },
                {
                  id: 'entity',
                  label: 'Place Entity',
                  icon: UserPlus,
                  testId: 'room-tool-entity',
                },
                {
                  id: 'spawn',
                  label: 'Move PlayerSpawn',
                  icon: MapPin,
                  testId: 'room-tool-spawn',
                },
              ] as const
            ).map((item) => {
              const Icon = item.icon;
              const active = tool === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={item.testId}
                  onClick={() => setTool(item.id)}
                  className={`flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition ${
                    active
                      ? 'bg-indigo-600 text-white'
                      : 'border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  <Icon className="h-3 w-3" />
                  {item.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
              <input
                type="checkbox"
                checked={showGrid}
                onChange={(e) => setShowGrid(e.target.checked)}
              />
              <Grid className="h-3.5 w-3.5 text-slate-400" />
              Grid
            </label>
            <div className="w-28">
              <ScrubInput
                label="Zoom"
                value={Math.round(zoomScale * 100)}
                min={50}
                max={200}
                step={10}
                unit="%"
                onChange={(v) => setZoomScale(v / 100)}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center overflow-auto p-4">
          <canvas
            ref={canvasRef}
            data-testid="room-editor-canvas"
            onPointerDown={handleCanvasPointerDown}
            onPointerMove={handleCanvasPointerMove}
            onPointerUp={handleCanvasPointerUp}
            style={{
              width: `${Math.round(blueprint.cols * CELL_DRAW_PX * zoomScale)}px`,
              height: `${Math.round(blueprint.rows * CELL_DRAW_PX * zoomScale)}px`,
              imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto',
            }}
            className="cursor-crosshair rounded border border-slate-700 shadow-xl"
          />
        </div>

        <div
          data-testid="room-stats-bar"
          className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-slate-900/70 px-3 py-1.5 text-[11px] text-slate-300"
        >
          <span>
            {blueprint.cols}×{blueprint.rows} ({blueprint.tileSizePx}px) • {cellStats.solid} solid •{' '}
            {cellStats.platform} platform • {blueprint.entities.length} entities
          </span>
          <span>
            PlayerSpawn: ({blueprint.playerSpawn.cellX}, {blueprint.playerSpawn.cellY}) • Path:
            levels/{sanitizeRoomSlug(blueprint.slug)}.tscn
          </span>
        </div>
      </main>

      {/* Right Pane: Godot 4.3+ .tscn Preview, Save, M25 Sync & Bundle ZIP */}
      <aside className="flex w-80 shrink-0 flex-col gap-2.5 border-l border-slate-800 bg-slate-900/70 p-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-300">
            Godot 4.3+ Scene (.tscn)
          </span>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard?.writeText(tscnContent);
              setCopiedTscn(true);
              setTimeout(() => setCopiedTscn(false), 1500);
            }}
            className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-700"
          >
            <Copy className="h-3 w-3" />
            {copiedTscn ? 'Copied' : 'Copy'}
          </button>
        </div>

        <pre
          data-testid="room-tscn-preview"
          className="min-h-0 flex-1 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-emerald-300"
        >
          {tscnContent}
        </pre>

        {statusNotice && (
          <div
            data-testid="room-status-notice"
            className="rounded border border-emerald-700/60 bg-emerald-950/60 p-2 text-[11px] text-emerald-200"
          >
            {statusNotice}
          </div>
        )}

        {syncNotice && (
          <div
            data-testid="room-sync-status"
            className="rounded border border-cyan-700/60 bg-cyan-950/60 p-2 text-[11px] text-cyan-200"
          >
            {syncNotice}
          </div>
        )}

        <div className="flex flex-col gap-1.5">
          <button
            type="button"
            data-testid="room-save-btn"
            onClick={() => void handleSaveRoom()}
            className="flex items-center justify-center gap-1.5 rounded border border-indigo-500/60 bg-indigo-950/70 px-3 py-1.5 text-xs font-semibold text-indigo-200 hover:bg-indigo-900/70"
          >
            <Save className="h-3.5 w-3.5" />
            Save Room to Project
          </button>

          <button
            type="button"
            data-testid="room-sync-godot-btn"
            disabled={isSyncing}
            onClick={() => void handleSyncRoomToGodot()}
            className="flex items-center justify-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <FolderSync className="h-3.5 w-3.5" />
            {isSyncing
              ? 'Syncing...'
              : syncTarget?.folderName
                ? `Sync Room to Godot (${syncTarget.folderName})`
                : 'Sync Room to Godot (res://)'}
          </button>

          <button
            type="button"
            data-testid="room-export-zip-btn"
            onClick={handleDownloadBundleZip}
            className="flex items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-semibold text-slate-100 hover:bg-slate-700"
          >
            <Download className="h-3.5 w-3.5" />
            Download Level Bundle (.zip)
          </button>
        </div>
      </aside>
    </div>
  );
}
