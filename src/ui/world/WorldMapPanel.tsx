import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Compass,
  ExternalLink,
  FolderSync,
  GitBranch,
  KeyRound,
  MapPin,
  Plus,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { db, repository } from '../../db/database';
import {
  parseAndClampRoomBlueprint,
  sanitizeRoomSlug,
  type StoredRoomRecord,
} from '../../processing/roomLayoutCore';
import { rgbaToPngBlob } from '../../processing/png';
import { generateMockRoomBlueprint } from '../../providers/roomPrototyperAdapter';
import { useAppStore } from '../../store/useAppStore';
import { collectProjectGodotSyncFiles, syncFilesToGodotDirectory } from '../../sync/fsaaSyncEngine';
import {
  bakeWorldMinimapRgba,
  deriveMinimapPaletteFromArtBible,
  type RoomCellGrid,
} from '../../world/minimapBaker';
import {
  auditWorldReachability,
  createDefaultWorldGraph,
  normalizeWorldFlag,
  type WorldGraph,
  type WorldPortalEdge,
  type WorldRoomNode,
} from '../../world/worldGraphCore';

const CARD_W = 168;
const CARD_H = 88;
const GRID_STEP_X = 216;
const GRID_STEP_Y = 128;
const CANVAS_PAD = 44;

function parseFlagList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const clean = normalizeWorldFlag(part);
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

/**
 * Merges persisted `WorldGraph` with all saved M35 `StoredRoomRecord`s so newly
 * added rooms appear cleanly on the World Map canvas while preserving manual layout/edges.
 */
function mergeGraphWithRooms(
  graph: WorldGraph | null,
  projectId: string,
  rooms: readonly StoredRoomRecord[],
): WorldGraph {
  if (!graph) {
    return createDefaultWorldGraph(
      projectId,
      rooms.map((r) => ({
        id: r.id,
        slug: r.slug,
        displayName: r.blueprint.displayName || r.slug,
      })),
    );
  }

  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const existingIds = new Set(graph.rooms.map((n) => n.roomId));
  const mergedRooms: WorldRoomNode[] = graph.rooms.map((node) => {
    const match = roomById.get(node.roomId);
    return match
      ? {
          ...node,
          label: match.blueprint.displayName || match.slug || node.label,
        }
      : node;
  });

  for (const room of rooms) {
    if (existingIds.has(room.id)) continue;
    const idx = mergedRooms.length;
    mergedRooms.push({
      roomId: room.id,
      label: room.blueprint.displayName || room.slug,
      worldGridPos: { x: idx % 4, y: Math.floor(idx / 4) },
      ...(idx === 0 && !mergedRooms.some((r) => r.isStart) ? { isStart: true } : {}),
      grantsFlags: [],
    });
  }

  return {
    ...graph,
    rooms: mergedRooms,
  };
}

/**
 * Milestone 45C Interactive World Map Graph, BFS/DFS Softlock Auditor,
 * Pixel-Art Minimap Baker & Godot 4 Portal Sync Panel.
 */
export function WorldMapPanel() {
  const {
    activeProject,
    rooms,
    spriteNodes,
    entities,
    audioAssets,
    worldGraph,
    saveRoomRecord,
    saveWorldGraphRecord,
    commitWorldGraphMinimap,
    setFocusedRoomId,
    refreshSyncTarget,
    navigate,
  } = useAppStore();

  const effectiveGraph = useMemo(
    () =>
      activeProject
        ? mergeGraphWithRooms(worldGraph, activeProject.id, rooms)
        : {
            id: 'world-empty',
            projectId: 'empty',
            name: 'World Map',
            rooms: [],
            edges: [],
            updatedAt: 0,
          },
    [worldGraph, activeProject, rooms],
  );

  const [selectedRoomId, setSelectedRoomId] = useState<string>(
    () => effectiveGraph.rooms[0]?.roomId ?? '',
  );
  const [grantsInput, setGrantsInput] = useState('');
  const [edgeFromId, setEdgeFromId] = useState('');
  const [edgeToId, setEdgeToId] = useState('');
  const [edgeBidirectional, setEdgeBidirectional] = useState(true);
  const [edgeFlagsInput, setEdgeFlagsInput] = useState('');
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [auditRunCount, setAuditRunCount] = useState(0);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isBaking, setIsBaking] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);

  const minimapCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const draggingRoomRef = useRef<{
    roomId: string;
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
    moved: boolean;
  } | null>(null);
  const panningRef = useRef<{
    startClientX: number;
    startClientY: number;
    originX: number;
    originY: number;
  } | null>(null);
  const [dragPreviewPos, setDragPreviewPos] = useState<{
    roomId: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const roomIds = effectiveGraph.rooms.map((r) => r.roomId);
    if (roomIds.length === 0) return;
    if (!selectedRoomId || !roomIds.includes(selectedRoomId)) {
      setSelectedRoomId(roomIds[0]!);
    }
    if (!edgeFromId || !roomIds.includes(edgeFromId)) {
      setEdgeFromId(roomIds[0]!);
    }
    if (!edgeToId || !roomIds.includes(edgeToId)) {
      setEdgeToId(roomIds[1] ?? roomIds[0]!);
    }
  }, [effectiveGraph.rooms, selectedRoomId, edgeFromId, edgeToId]);

  const selectedRoom = useMemo(
    () => effectiveGraph.rooms.find((r) => r.roomId === selectedRoomId) ?? effectiveGraph.rooms[0],
    [effectiveGraph.rooms, selectedRoomId],
  );

  useEffect(() => {
    setGrantsInput(selectedRoom ? selectedRoom.grantsFlags.join(', ') : '');
  }, [selectedRoom]);

  const auditReport = useMemo(() => auditWorldReachability(effectiveGraph), [effectiveGraph]);

  const paintMinimapRgba = useCallback((rgba: Uint8ClampedArray, width: number, height: number) => {
    const canvas = minimapCanvasRef.current;
    if (!canvas) return;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
  }, []);

  // Hydrate persisted minimap PNG from Dexie on mount/reload
  useEffect(() => {
    const blobId = worldGraph?.minimapBlobId;
    if (!blobId) return;
    let cancelled = false;
    void repository.getBlob(blobId).then(async (rec) => {
      if (cancelled || !rec) return;
      const bitmap = await createImageBitmap(rec.bytes);
      if (cancelled) {
        bitmap.close();
        return;
      }
      const canvas = minimapCanvasRef.current;
      if (!canvas) {
        bitmap.close();
        return;
      }
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, bitmap.width, bitmap.height);
        ctx.drawImage(bitmap, 0, 0);
      }
      bitmap.close();
    });
    return () => {
      cancelled = true;
    };
  }, [worldGraph?.minimapBlobId]);

  const persistGraph = useCallback(
    async (next: WorldGraph) => {
      setErrorMsg(null);
      await saveWorldGraphRecord({
        ...next,
        updatedAt: Date.now(),
      });
    },
    [saveWorldGraphRecord],
  );

  const handleSeedStarterRooms = async () => {
    if (!activeProject) return;
    setErrorMsg(null);
    const existingCount = rooms.length;
    const baseEntitySlugs = entities.map((e) => sanitizeRoomSlug(e.slug));
    const roomA = parseAndClampRoomBlueprint(
      generateMockRoomBlueprint({
        prompt: 'entry courtyard platform hub',
        cols: 20,
        rows: 12,
        tileSizePx: 16,
        availableEntitySlugs: baseEntitySlugs,
      }),
      { fallbackPrompt: 'entry courtyard', cols: 20, rows: 12, tileSizePx: 16 },
    );
    roomA.slug = 'entry_courtyard';
    roomA.displayName = 'Room A (Entry)';

    const roomB = parseAndClampRoomBlueprint(
      generateMockRoomBlueprint({
        prompt: 'locked boss sanctum chamber',
        cols: 20,
        rows: 12,
        tileSizePx: 16,
        availableEntitySlugs: baseEntitySlugs,
      }),
      { fallbackPrompt: 'boss sanctum', cols: 20, rows: 12, tileSizePx: 16 },
    );
    roomB.slug = 'boss_sanctum';
    roomB.displayName = 'Room B (Boss)';

    const savedA = await saveRoomRecord({
      id: rooms[0]?.id ?? globalThis.crypto.randomUUID(),
      projectId: activeProject.id,
      slug: roomA.slug,
      tileSetNodeId: rooms[0]?.tileSetNodeId ?? null,
      tileSetMode: 'blob47',
      parallaxNodeId: null,
      blueprint: roomA,
      updatedAt: Date.now(),
    });
    const savedB = await saveRoomRecord({
      id: rooms[1]?.id ?? globalThis.crypto.randomUUID(),
      projectId: activeProject.id,
      slug: roomB.slug,
      tileSetNodeId: rooms[1]?.tileSetNodeId ?? null,
      tileSetMode: 'blob47',
      parallaxNodeId: null,
      blueprint: roomB,
      updatedAt: Date.now() + 1,
    });

    const latestRooms = existingCount >= 2 ? rooms : [savedA, savedB];
    const seededGraph = mergeGraphWithRooms(worldGraph, activeProject.id, latestRooms);
    await persistGraph(seededGraph);
    setSelectedRoomId(savedA.id);
    setEdgeFromId(savedA.id);
    setEdgeToId(savedB.id);
    setStatusNotice('Synced 2 starter M35 rooms into the World Map.');
  };

  const handleToggleStart = async (roomId: string) => {
    const nextRooms = effectiveGraph.rooms.map((r) => ({
      ...r,
      isStart: r.roomId === roomId ? !r.isStart : false,
    }));
    await persistGraph({ ...effectiveGraph, rooms: nextRooms });
  };

  const handleToggleGoal = async (roomId: string) => {
    const nextRooms = effectiveGraph.rooms.map((r) =>
      r.roomId === roomId ? { ...r, isGoal: !r.isGoal } : r,
    );
    await persistGraph({ ...effectiveGraph, rooms: nextRooms });
  };

  const handleApplyRoomGrants = async () => {
    if (!selectedRoom) return;
    const parsed = parseFlagList(grantsInput);
    const nextRooms = effectiveGraph.rooms.map((r) =>
      r.roomId === selectedRoom.roomId ? { ...r, grantsFlags: parsed } : r,
    );
    await persistGraph({ ...effectiveGraph, rooms: nextRooms });
    setStatusNotice(
      parsed.length > 0
        ? `Updated ${selectedRoom.label} grants: ${parsed.join(', ')}`
        : `Cleared granted flags on ${selectedRoom.label}.`,
    );
  };

  const handleAddEdge = async () => {
    if (!edgeFromId || !edgeToId || edgeFromId === edgeToId) {
      setErrorMsg('Choose two distinct rooms to connect with a portal.');
      return;
    }
    const flags = parseFlagList(edgeFlagsInput);
    const idx = effectiveGraph.edges.length + 1;
    const newEdge: WorldPortalEdge = {
      id: `portal_${idx}_${Date.now().toString(36)}`,
      fromRoomId: edgeFromId,
      fromDoorId: `door_${idx}`,
      toRoomId: edgeToId,
      toSpawnId: `spawn_${idx}`,
      bidirectional: edgeBidirectional,
      requiredFlags: flags,
    };
    await persistGraph({
      ...effectiveGraph,
      edges: [...effectiveGraph.edges, newEdge],
    });
    setEdgeFlagsInput('');
    setStatusNotice(`Connected ${edgeFromId} -> ${edgeToId}.`);
  };

  const handleDeleteEdge = async (edgeId: string) => {
    await persistGraph({
      ...effectiveGraph,
      edges: effectiveGraph.edges.filter((e) => e.id !== edgeId),
    });
  };

  const handleRunAudit = async () => {
    await persistGraph(effectiveGraph);
    setAuditRunCount((c) => c + 1);
    setStatusNotice(
      auditReport.ok
        ? `Audit passed: ${auditReport.reachableRoomIds.length}/${effectiveGraph.rooms.length} rooms reachable with 0 softlocks.`
        : `Audit found issues (${auditReport.unreachableRoomIds.length} unreachable, ${auditReport.softlockTrapRoomIds.length} softlock traps).`,
    );
  };

  const handleBakeMinimap = async () => {
    if (!activeProject) return;
    setIsBaking(true);
    setErrorMsg(null);
    try {
      const roomGrids = new Map<string, RoomCellGrid>(rooms.map((r) => [r.id, r.blueprint]));
      const palette = deriveMinimapPaletteFromArtBible(activeProject.artBible.palette);
      const baked = bakeWorldMinimapRgba(effectiveGraph, roomGrids, { pxPerTile: 2, palette });
      paintMinimapRgba(baked.rgba, baked.width, baked.height);
      const pngBlob = rgbaToPngBlob(baked.rgba, baked.width, baked.height);
      await commitWorldGraphMinimap(
        {
          ...effectiveGraph,
          updatedAt: Date.now(),
        },
        pngBlob,
        JSON.stringify(baked.atlas, null, 2),
      );
      setStatusNotice(`Baked pixel-art minimap (${baked.width}×${baked.height}px) to IndexedDB.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to bake minimap.');
    } finally {
      setIsBaking(false);
    }
  };

  const handleSyncWorldToGodot = async () => {
    if (!activeProject) return;
    setIsSyncing(true);
    setErrorMsg(null);
    try {
      await persistGraph(effectiveGraph);
      const files = await collectProjectGodotSyncFiles(
        db,
        activeProject,
        entities,
        spriteNodes,
        audioAssets,
        rooms,
      );
      const summary = await syncFilesToGodotDirectory(db, activeProject.id, files);
      await refreshSyncTarget(activeProject.id);
      setStatusNotice(
        `Synced world to res:// (${summary.writtenCount} written, ${summary.plan.unchangedPaths.length} unchanged).`,
      );
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : 'Bind a Godot res:// folder via Entities Hub or Godot Sync pill first.',
      );
    } finally {
      setIsSyncing(false);
    }
  };

  const openRoomInBuilder = (roomId: string) => {
    if (!activeProject) return;
    const targetNode = spriteNodes[0];
    if (!targetNode) {
      setErrorMsg('Generate or upload a sprite first to open M35 Room Builder.');
      return;
    }
    setFocusedRoomId(roomId);
    void navigate({
      screen: 'inspector',
      projectId: activeProject.id,
      nodeId: targetNode.id,
      initialTab: 'room',
    });
  };

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-sm text-slate-400">
        Open a project first to edit its Multi-Room World Map.
      </div>
    );
  }

  const getRoomPixelPos = (room: WorldRoomNode): { x: number; y: number } => {
    if (dragPreviewPos && dragPreviewPos.roomId === room.roomId) {
      return { x: dragPreviewPos.x, y: dragPreviewPos.y };
    }
    return {
      x: CANVAS_PAD + room.worldGridPos.x * GRID_STEP_X,
      y: CANVAS_PAD + room.worldGridPos.y * GRID_STEP_Y,
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (draggingRoomRef.current) {
      const dr = draggingRoomRef.current;
      const dx = (e.clientX - dr.startClientX) / zoom;
      const dy = (e.clientY - dr.startClientY) / zoom;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        dr.moved = true;
      }
      setDragPreviewPos({
        roomId: dr.roomId,
        x: Math.max(8, dr.originX + dx),
        y: Math.max(8, dr.originY + dy),
      });
    } else if (panningRef.current) {
      const pr = panningRef.current;
      setPan({
        x: pr.originX + (e.clientX - pr.startClientX),
        y: pr.originY + (e.clientY - pr.startClientY),
      });
    }
  };

  const handlePointerUp = async () => {
    if (draggingRoomRef.current) {
      const dr = draggingRoomRef.current;
      draggingRoomRef.current = null;
      if (dr.moved && dragPreviewPos && dragPreviewPos.roomId === dr.roomId) {
        const snapX = Math.max(0, Math.round((dragPreviewPos.x - CANVAS_PAD) / GRID_STEP_X));
        const snapY = Math.max(0, Math.round((dragPreviewPos.y - CANVAS_PAD) / GRID_STEP_Y));
        setDragPreviewPos(null);
        const nextRooms = effectiveGraph.rooms.map((r) =>
          r.roomId === dr.roomId ? { ...r, worldGridPos: { x: snapX, y: snapY } } : r,
        );
        await persistGraph({ ...effectiveGraph, rooms: nextRooms });
      } else {
        setDragPreviewPos(null);
      }
    }
    panningRef.current = null;
  };

  const unreachableSet = new Set(auditReport.unreachableRoomIds);
  const trapSet = new Set(auditReport.softlockTrapRoomIds);

  return (
    <div
      data-testid="world-map-panel"
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden bg-[var(--bg-well)] lg:grid-cols-[1fr_360px]"
    >
      {/* Left: Pan/Zoom Snap-to-Grid Room Graph */}
      <div className="flex min-h-[420px] flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2.5">
          <div className="flex items-center gap-2">
            <Compass className="h-4 w-4 text-[#F5B82E]" />
            <h2 className="text-sm font-semibold text-white">World Map Graph &amp; Portals</h2>
            <span className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[11px] text-slate-300">
              {effectiveGraph.rooms.length} rooms · {effectiveGraph.edges.length} portals
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {rooms.length < 2 && (
              <button
                type="button"
                data-testid="world-seed-rooms-btn"
                onClick={() => void handleSeedStarterRooms()}
                className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2.5 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-500/25"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Seed 2 Starter M35 Rooms
              </button>
            )}
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.5, Number((z - 0.15).toFixed(2))))}
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-1.5 text-slate-300 hover:text-white"
              aria-label="Zoom out world map"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan({ x: 0, y: 0 });
              }}
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 font-mono text-[11px] text-slate-300 hover:text-white"
            >
              {Math.round(zoom * 100)}%
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.75, Number((z + 0.15).toFixed(2))))}
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-1.5 text-slate-300 hover:text-white"
              aria-label="Zoom in world map"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div
          data-testid="world-map-canvas"
          onPointerDown={(e) => {
            if (e.target === e.currentTarget) {
              panningRef.current = {
                startClientX: e.clientX,
                startClientY: e.clientY,
                originX: pan.x,
                originY: pan.y,
              };
            }
          }}
          onPointerMove={handlePointerMove}
          onPointerUp={() => void handlePointerUp()}
          className="relative flex-1 overflow-hidden bg-[radial-gradient(#262938_1px,transparent_1px)] [background-size:24px_24px]"
        >
          {effectiveGraph.rooms.length === 0 ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
              <p className="text-sm text-slate-300">
                No saved M35 rooms in this project yet. Seed starter rooms or build rooms in M35
                Room Builder.
              </p>
              <button
                type="button"
                data-testid="world-seed-empty-btn"
                onClick={() => void handleSeedStarterRooms()}
                className="inline-flex items-center gap-1.5 rounded-md bg-[#F5B82E] px-3.5 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
              >
                <Sparkles className="h-3.5 w-3.5" />
                Seed 2 Starter M35 Rooms
              </button>
            </div>
          ) : (
            <div
              className="absolute inset-0 origin-top-left"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
              }}
            >
              <svg
                className="pointer-events-none absolute inset-0 h-[1600px] w-[2000px]"
                aria-hidden="true"
              >
                <defs>
                  <marker
                    id="world-arrow"
                    markerWidth="8"
                    markerHeight="8"
                    refX="6"
                    refY="3"
                    orient="auto"
                  >
                    <path d="M0,0 L0,6 L7,3 z" fill="#F5B82E" />
                  </marker>
                </defs>
                {effectiveGraph.edges.map((edge) => {
                  const fromNode = effectiveGraph.rooms.find((r) => r.roomId === edge.fromRoomId);
                  const toNode = effectiveGraph.rooms.find((r) => r.roomId === edge.toRoomId);
                  if (!fromNode || !toNode) return null;
                  const fp = getRoomPixelPos(fromNode);
                  const tp = getRoomPixelPos(toNode);
                  const x1 = fp.x + CARD_W / 2;
                  const y1 = fp.y + CARD_H / 2;
                  const x2 = tp.x + CARD_W / 2;
                  const y2 = tp.y + CARD_H / 2;
                  const mx = (x1 + x2) / 2;
                  const my = (y1 + y2) / 2;
                  return (
                    <g key={edge.id}>
                      <line
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke={edge.requiredFlags.length > 0 ? '#f43f5e' : '#f5b82e'}
                        strokeWidth={2.5}
                        strokeDasharray={edge.bidirectional ? undefined : '6 4'}
                        markerEnd="url(#world-arrow)"
                      />
                      {edge.requiredFlags.length > 0 && (
                        <g transform={`translate(${mx - 36}, ${my - 10})`}>
                          <rect
                            width="72"
                            height="18"
                            rx="4"
                            fill="#18181b"
                            stroke="#f43f5e"
                            strokeWidth="1"
                          />
                          <text
                            x="36"
                            y="12"
                            textAnchor="middle"
                            fill="#fda4af"
                            fontSize="9"
                            fontFamily="monospace"
                          >
                            {edge.requiredFlags.join(',')}
                          </text>
                        </g>
                      )}
                    </g>
                  );
                })}
              </svg>

              {effectiveGraph.rooms.map((room) => {
                const pos = getRoomPixelPos(room);
                const selected = room.roomId === selectedRoom?.roomId;
                const isTrap = trapSet.has(room.roomId);
                const isUnreachable = unreachableSet.has(room.roomId);
                const borderTone = isTrap
                  ? 'border-rose-500 ring-1 ring-rose-500/40'
                  : isUnreachable
                    ? 'border-amber-400 ring-1 ring-amber-400/40'
                    : selected
                      ? 'border-[#F5B82E] ring-1 ring-[#F5B82E]/45'
                      : 'border-emerald-500/50';

                return (
                  <div
                    key={room.roomId}
                    data-testid={`world-room-node-${room.roomId}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      setSelectedRoomId(room.roomId);
                      draggingRoomRef.current = {
                        roomId: room.roomId,
                        startClientX: e.clientX,
                        startClientY: e.clientY,
                        originX: pos.x,
                        originY: pos.y,
                        moved: false,
                      };
                    }}
                    style={{
                      left: `${pos.x}px`,
                      top: `${pos.y}px`,
                      width: `${CARD_W}px`,
                      height: `${CARD_H}px`,
                    }}
                    className={`absolute flex cursor-grab flex-col justify-between rounded-lg border bg-[var(--bg-panel)] p-2.5 shadow-lg select-none active:cursor-grabbing ${borderTone}`}
                  >
                    <div className="flex items-start justify-between gap-1">
                      <span className="truncate text-xs font-semibold text-white">
                        {room.label}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-slate-400">
                        ({room.worldGridPos.x},{room.worldGridPos.y})
                      </span>
                    </div>

                    <div className="flex flex-wrap items-center gap-1">
                      {room.isStart && (
                        <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-emerald-300">
                          START
                        </span>
                      )}
                      {room.isGoal && (
                        <span className="rounded bg-rose-500/20 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-rose-300">
                          GOAL
                        </span>
                      )}
                      {isTrap && (
                        <span className="rounded bg-rose-600/30 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-rose-200">
                          TRAP
                        </span>
                      )}
                      {isUnreachable && (
                        <span className="rounded bg-amber-500/25 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-amber-200">
                          UNREACHABLE
                        </span>
                      )}
                    </div>

                    <div className="truncate font-mono text-[10px] text-slate-400">
                      {room.grantsFlags.length > 0
                        ? `Grants: ${room.grantsFlags.join(', ')}`
                        : 'Grants: none'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Right: Softlock Auditor, Room/Portal Editors & Minimap Preview */}
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5">
        {errorMsg && (
          <div className="rounded border border-rose-500/40 bg-rose-950/60 px-2.5 py-1.5 text-[11px] text-rose-200">
            {errorMsg}
          </div>
        )}
        {statusNotice && (
          <div
            data-testid="world-status-notice"
            className="rounded border border-emerald-500/40 bg-emerald-950/40 px-2.5 py-1.5 text-[11px] text-emerald-200"
          >
            {statusNotice}
          </div>
        )}

        {/* 1-Click Softlock Audit Panel */}
        <section
          data-testid="world-audit-panel"
          className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3"
        >
          <div className="flex items-center justify-between gap-2">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold text-white uppercase">
              {auditReport.ok ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400" />
              ) : (
                <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
              )}
              Softlock Audit
            </h3>
            <span
              data-testid="world-audit-status"
              data-audit-runs={auditRunCount}
              className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold ${
                auditReport.ok
                  ? 'bg-emerald-500/20 text-emerald-300'
                  : 'bg-amber-500/20 text-amber-200'
              }`}
            >
              {auditReport.ok ? 'OK' : 'Issues Found'}
            </span>
          </div>

          <button
            type="button"
            data-testid="world-run-audit-btn"
            onClick={() => void handleRunAudit()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Run Softlock Audit
          </button>

          <div className="space-y-1 text-[11px] text-slate-300">
            <div className="flex justify-between gap-2">
              <span className="text-slate-400">Progression</span>
              <span
                data-testid="world-audit-progression"
                className="truncate font-mono text-emerald-300"
              >
                {auditReport.progressionOrder.length > 0
                  ? auditReport.progressionOrder.join(' → ')
                  : 'None'}
              </span>
            </div>

            <div data-testid="world-audit-unreachable" className="space-y-1">
              {auditReport.unreachableRoomIds.map((rid) => {
                const label = effectiveGraph.rooms.find((r) => r.roomId === rid)?.label ?? rid;
                return (
                  <button
                    key={rid}
                    type="button"
                    onClick={() => openRoomInBuilder(rid)}
                    className="flex w-full items-center justify-between rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-left text-[11px] text-amber-200 hover:bg-amber-500/20"
                  >
                    <span>Unreachable: {label}</span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </button>
                );
              })}
            </div>

            <div data-testid="world-audit-traps" className="space-y-1">
              {auditReport.softlockTrapRoomIds.map((rid) => {
                const label = effectiveGraph.rooms.find((r) => r.roomId === rid)?.label ?? rid;
                return (
                  <button
                    key={rid}
                    type="button"
                    onClick={() => openRoomInBuilder(rid)}
                    className="flex w-full items-center justify-between rounded border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-left text-[11px] text-rose-200 hover:bg-rose-500/20"
                  >
                    <span>
                      <AlertTriangle className="mr-1 inline h-3 w-3" />
                      Softlock Trap: {label}
                    </span>
                    <ExternalLink className="h-3 w-3 shrink-0" />
                  </button>
                );
              })}
            </div>
          </div>
        </section>

        {/* Selected Room Editor */}
        {selectedRoom && (
          <section className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="flex items-center gap-1.5 text-xs font-semibold text-white uppercase">
                <MapPin className="h-3.5 w-3.5 text-[#F5B82E]" />
                {selectedRoom.label}
              </h3>
              <button
                type="button"
                data-testid="world-open-room-btn"
                onClick={() => openRoomInBuilder(selectedRoom.roomId)}
                className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] px-2 py-0.5 text-[10px] text-slate-300 hover:text-white"
              >
                <ExternalLink className="h-3 w-3" />
                Room Builder
              </button>
            </div>

            <div className="flex items-center gap-3 text-xs text-slate-200">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="world-room-start-toggle"
                  checked={Boolean(selectedRoom.isStart)}
                  onChange={() => void handleToggleStart(selectedRoom.roomId)}
                  className="accent-emerald-400"
                />
                Start Hub
              </label>
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="world-room-goal-toggle"
                  checked={Boolean(selectedRoom.isGoal)}
                  onChange={() => void handleToggleGoal(selectedRoom.roomId)}
                  className="accent-rose-400"
                />
                Goal Room
              </label>
            </div>

            <div className="space-y-1">
              <label className="block text-[11px] text-slate-300">
                <KeyRound className="mr-1 inline h-3 w-3 text-[#F5B82E]" />
                Grants Flags / Keys (comma-separated)
              </label>
              <div className="flex gap-1.5">
                <input
                  type="text"
                  data-testid="world-room-grants-input"
                  value={grantsInput}
                  onChange={(e) => setGrantsInput(e.target.value)}
                  placeholder="e.g. red_key, double_jump"
                  className="min-w-0 flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-white focus:border-[#F5B82E] focus:outline-none"
                />
                <button
                  type="button"
                  data-testid="world-room-grants-apply"
                  onClick={() => void handleApplyRoomGrants()}
                  className="rounded bg-[#F5B82E] px-2.5 py-1 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
                >
                  Apply
                </button>
              </div>
            </div>
          </section>
        )}

        {/* Portal Link Composer */}
        <section className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold text-white uppercase">
            <GitBranch className="h-3.5 w-3.5 text-sky-400" />
            Portal Transitions
          </h3>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-0.5 text-[10px] text-slate-400">
              <span>From Room</span>
              <select
                data-testid="world-edge-from-select"
                value={edgeFromId}
                onChange={(e) => setEdgeFromId(e.target.value)}
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-1 text-xs text-white"
              >
                {effectiveGraph.rooms.map((r) => (
                  <option key={r.roomId} value={r.roomId}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-0.5 text-[10px] text-slate-400">
              <span>To Room</span>
              <select
                data-testid="world-edge-to-select"
                value={edgeToId}
                onChange={(e) => setEdgeToId(e.target.value)}
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-1 text-xs text-white"
              >
                {effectiveGraph.rooms.map((r) => (
                  <option key={r.roomId} value={r.roomId}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="flex items-center justify-between gap-2 text-xs text-slate-200">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="world-edge-bidirectional-toggle"
                checked={edgeBidirectional}
                onChange={(e) => setEdgeBidirectional(e.target.checked)}
                className="accent-[#F5B82E]"
              />
              Bidirectional
            </label>
            <input
              type="text"
              data-testid="world-edge-flags-input"
              value={edgeFlagsInput}
              onChange={(e) => setEdgeFlagsInput(e.target.value)}
              placeholder="Requires: red_key"
              className="w-36 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-[11px] text-white"
            />
          </div>

          <button
            type="button"
            data-testid="world-add-edge-btn"
            disabled={effectiveGraph.rooms.length < 2}
            onClick={() => void handleAddEdge()}
            className="flex w-full items-center justify-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-200 hover:bg-sky-500/25 disabled:opacity-40"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Portal Link
          </button>

          {effectiveGraph.edges.length > 0 && (
            <div className="max-h-28 space-y-1 overflow-y-auto pt-1">
              {effectiveGraph.edges.map((edge) => {
                const fromLabel =
                  effectiveGraph.rooms.find((r) => r.roomId === edge.fromRoomId)?.label ??
                  edge.fromRoomId;
                const toLabel =
                  effectiveGraph.rooms.find((r) => r.roomId === edge.toRoomId)?.label ??
                  edge.toRoomId;
                return (
                  <div
                    key={edge.id}
                    className="flex items-center justify-between gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[10px] text-slate-300"
                  >
                    <span className="truncate font-mono">
                      {fromLabel} {edge.bidirectional ? '↔' : '→'} {toLabel}
                      {edge.requiredFlags.length > 0 ? ` [${edge.requiredFlags.join(',')}]` : ''}
                    </span>
                    <button
                      type="button"
                      data-testid={`world-edge-delete-${edge.id}`}
                      onClick={() => void handleDeleteEdge(edge.id)}
                      className="text-slate-400 hover:text-rose-400"
                      aria-label={`Delete portal ${edge.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Baked Pixel-Art Minimap & Godot Sync */}
        <section className="space-y-2 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3">
          <h3 className="text-xs font-semibold text-white uppercase">
            Pixel-Art Minimap &amp; Sync
          </h3>
          <div className="flex min-h-[112px] items-center justify-center rounded border border-[var(--border-hairline)] bg-[#0b0d14] p-2">
            <canvas
              ref={minimapCanvasRef}
              data-testid="world-minimap-canvas"
              style={{ imageRendering: 'pixelated' }}
              className="max-h-36 max-w-full"
            />
          </div>
          <div className="grid grid-cols-1 gap-2">
            <button
              type="button"
              data-testid="world-bake-minimap-btn"
              disabled={isBaking || effectiveGraph.rooms.length === 0}
              onClick={() => void handleBakeMinimap()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-45"
            >
              {isBaking ? 'Baking Minimap...' : 'Bake Minimap & Save'}
            </button>
            <button
              type="button"
              data-testid="world-sync-godot-btn"
              disabled={isSyncing || effectiveGraph.rooms.length === 0}
              onClick={() => void handleSyncWorldToGodot()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[#F5B82E]/50 bg-[#F5B82E]/15 px-3 py-1.5 text-xs font-semibold text-[#F5B82E] hover:bg-[#F5B82E]/25 disabled:opacity-45"
            >
              <FolderSync className="h-3.5 w-3.5" />
              {isSyncing ? 'Syncing World...' : 'Sync World & Portals to Godot'}
            </button>
          </div>
        </section>
      </aside>
    </div>
  );
}
