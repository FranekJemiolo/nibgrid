import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Film,
  Plus,
  Shield,
  Sparkles,
  Swords,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { ArtMode, CollisionLayerShape, PuppetAnimConfig } from '../../domain/schemas';
import { exportGodotColliderTres, exportMatterPhysicsJson } from '../../export/colliderExporters';
import { computePivotPx } from '../../export/recipeBuilder';
import {
  extractCollisionHull,
  isPolygonConvex,
  type ColliderKind,
  type ColliderLayer,
  type Vec2,
} from '../../processing/collisionHull';
import { buildAlphaClippedMesh } from '../../processing/spriteMesh';
import type { RgbaBuffer } from '../../processing/types';
import { buildPuppetStripArtifacts } from '../../webgl/puppetRenderer';

export interface ColliderEditorProps {
  readonly sprite: RgbaBuffer;
  readonly spriteSlug: string;
  readonly artMode: ArtMode;
  readonly pivotNorm: { readonly x: number; readonly y: number };
  readonly paletteHex: readonly string[];
  readonly puppetConfig: PuppetAnimConfig;
  readonly shapes: readonly CollisionLayerShape[];
  readonly onChangeShapes: (shapes: CollisionLayerShape[]) => void;
  readonly exportSlot?: ReactNode;
}

type GridSnapMode = 'off' | '0.5' | '1';

const LAYER_META: Record<
  ColliderLayer,
  { readonly label: string; readonly color: string; readonly fill: string }
> = {
  collider: {
    label: 'Collider',
    color: '#22C55E',
    fill: 'rgba(34, 197, 94, 0.22)',
  },
  hurtbox: {
    label: 'Hurtbox',
    color: '#38BDF8',
    fill: 'rgba(56, 189, 248, 0.20)',
  },
  hitbox: {
    label: 'Hitbox',
    color: '#EF4444',
    fill: 'rgba(239, 68, 68, 0.22)',
  },
};

function applySnap(value: number, mode: GridSnapMode): number {
  if (mode === '1') return Math.round(value);
  if (mode === '0.5') return Number((Math.round(value * 2) * 0.5).toFixed(2));
  return Number(value.toFixed(2));
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function isShapeActiveOnFrame(shape: CollisionLayerShape, frameIdx: number): boolean {
  if (!shape.activeFrames || shape.activeFrames.length === 0) return true;
  return shape.activeFrames.includes(frameIdx);
}

export function ColliderEditor({
  sprite,
  spriteSlug,
  artMode,
  pivotNorm,
  paletteHex,
  puppetConfig,
  shapes,
  onChangeShapes,
  exportSlot,
}: ColliderEditorProps) {
  const pivotPx = useMemo(
    () => computePivotPx(pivotNorm, sprite.width, sprite.height),
    [pivotNorm, sprite.width, sprite.height],
  );

  const [selectedShapeId, setSelectedShapeId] = useState<string | null>(
    () => shapes[0]?.id ?? null,
  );
  const [selectedVertexIdx, setSelectedVertexIdx] = useState<number>(0);
  const [traceKind, setTraceKind] = useState<ColliderKind>('convex-hull');
  const [epsilonPx, setEpsilonPx] = useState<number>(1.5);
  const [maxVertices, setMaxVertices] = useState<number>(8);
  const [gridSnap, setGridSnap] = useState<GridSnapMode>('0.5');
  const [zoomPercent, setZoomPercent] = useState<number>(() => (sprite.width <= 80 ? 400 : 300));
  const [selectedFrameIdx, setSelectedFrameIdx] = useState<number>(0);
  const [onionSkin, setOnionSkin] = useState<boolean>(true);
  const [previewMode, setPreviewMode] = useState<'godot' | 'matter'>('godot');
  const [copiedCode, setCopiedCode] = useState<boolean>(false);
  const [editorHint, setEditorHint] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingRef = useRef<{ shapeId: string; vertexIdx: number } | null>(null);

  // Sync selectedShapeId when shapes array changes
  useEffect(() => {
    if (shapes.length === 0) {
      if (selectedShapeId !== null) setSelectedShapeId(null);
      return;
    }
    if (!selectedShapeId || !shapes.some((s) => s.id === selectedShapeId)) {
      setSelectedShapeId(shapes[0]!.id);
      setSelectedVertexIdx(0);
    }
  }, [shapes, selectedShapeId]);

  const activeShape = useMemo(
    () => shapes.find((s) => s.id === selectedShapeId) ?? shapes[0] ?? null,
    [shapes, selectedShapeId],
  );

  const latestShapesRef = useRef(shapes);
  latestShapesRef.current = shapes;
  const latestActiveRef = useRef(activeShape);
  latestActiveRef.current = activeShape;
  const latestSelectedVertexRef = useRef(selectedVertexIdx);
  latestSelectedVertexRef.current = selectedVertexIdx;

  // Bake M9 Puppet-Warp frames for scrubbing when pins exist (zero persistent WebGL context)
  const timelineFrames = useMemo<readonly RgbaBuffer[]>(() => {
    if (puppetConfig.pins.length > 0) {
      try {
        const mesh = buildAlphaClippedMesh(sprite, { artMode });
        const stripRes = buildPuppetStripArtifacts(sprite, mesh, 'collider-preview', {
          preset: puppetConfig.preset,
          mode: puppetConfig.mode,
          pins: puppetConfig.pins,
          frameCount: puppetConfig.frameCount,
          amplitudePx: puppetConfig.amplitudePx,
          fps: puppetConfig.fps,
          loop: puppetConfig.loop,
          pingPong: puppetConfig.pingPong,
          paddingPx: puppetConfig.paddingPx,
          reLockPolish: puppetConfig.reLockPolish,
          artMode,
          pivotNorm,
          paletteHex: [...paletteHex],
        });
        if (stripRes.frames.length > 0) return stripRes.frames;
      } catch {
        return [sprite];
      }
    }
    return [sprite];
  }, [sprite, artMode, puppetConfig, pivotNorm, paletteHex]);

  const frameSlotCount = puppetConfig.pins.length > 0 ? puppetConfig.frameCount : 6;
  const safeFrameIdx = selectedFrameIdx % Math.max(1, timelineFrames.length);

  // Draw sprite frame + optional previous-frame onion skin on Canvas2D
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = sprite.width;
    canvas.height = sprite.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = artMode !== 'pixel-art';

    const drawBuffer = (buf: RgbaBuffer, alpha: number) => {
      const off = document.createElement('canvas');
      off.width = buf.width;
      off.height = buf.height;
      const octx = off.getContext('2d');
      if (!octx) return;
      octx.putImageData(
        new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height),
        0,
        0,
      );
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.drawImage(off, 0, 0);
      ctx.restore();
      off.width = 0;
      off.height = 0;
    };

    if (onionSkin && timelineFrames.length > 1) {
      const prevIdx = (safeFrameIdx - 1 + timelineFrames.length) % timelineFrames.length;
      const prevBuf = timelineFrames[prevIdx];
      if (prevBuf) drawBuffer(prevBuf, 0.28);
    }

    const activeBuf = timelineFrames[safeFrameIdx] ?? sprite;
    drawBuffer(activeBuf, 1.0);
  }, [sprite, timelineFrames, safeFrameIdx, onionSkin, artMode]);

  const updateShapeById = useCallback(
    (shapeId: string, updater: (prev: CollisionLayerShape) => CollisionLayerShape) => {
      const next = latestShapesRef.current.map((s) => (s.id === shapeId ? updater(s) : s));
      onChangeShapes(next);
    },
    [onChangeShapes],
  );

  const deleteVertexAt = useCallback(
    (shapeId: string, idx: number) => {
      const shape = latestShapesRef.current.find((s) => s.id === shapeId);
      if (!shape) return;
      if (shape.vertices.length <= 3) {
        setEditorHint('Minimum 3 vertices required on a collision polygon.');
        return;
      }
      setEditorHint(null);
      const nextVerts = shape.vertices.filter((_, i) => i !== idx);
      updateShapeById(shapeId, (s) => ({ ...s, vertices: nextVerts }));
      setSelectedVertexIdx(Math.max(0, Math.min(idx, nextVerts.length - 1)));
    },
    [updateShapeById],
  );

  // Keyboard Delete / Backspace removes selected vertex, strictly isolated from form controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;
      const active = latestActiveRef.current;
      if (!active) return;
      const idx = latestSelectedVertexRef.current;
      if (idx < 0 || idx >= active.vertices.length) return;
      e.preventDefault();
      deleteVertexAt(active.id, idx);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [deleteVertexAt]);

  const makeFallbackBox = (halfW: number, halfH: number, offsetX = 0, offsetY = -halfH): Vec2[] => [
    { x: applySnap(offsetX - halfW, gridSnap), y: applySnap(offsetY - halfH, gridSnap) },
    { x: applySnap(offsetX + halfW, gridSnap), y: applySnap(offsetY - halfH, gridSnap) },
    { x: applySnap(offsetX + halfW, gridSnap), y: applySnap(offsetY + halfH, gridSnap) },
    { x: applySnap(offsetX - halfW, gridSnap), y: applySnap(offsetY + halfH, gridSnap) },
  ];

  const runAutoTraceForLayer = (
    overrideKind?: ColliderKind,
    overrideMaxVertices?: number,
    forceLayer?: ColliderLayer,
  ) => {
    setEditorHint(null);
    const kindToUse = overrideKind ?? traceKind;
    const maxV = overrideMaxVertices ?? maxVertices;
    const extracted = extractCollisionHull(timelineFrames[safeFrameIdx] ?? sprite, {
      kind: kindToUse,
      epsilonPx,
      ...(kindToUse === 'convex-hull' || kindToUse === 'polygon' ? { maxVertices: maxV } : {}),
      pivotPx,
    });

    const fallbackVerts = makeFallbackBox(
      Math.max(6, Math.round(sprite.width * 0.25)),
      Math.max(6, Math.round(sprite.height * 0.35)),
      0,
      -Math.max(6, Math.round(sprite.height * 0.35)),
    );
    const vertices = extracted.vertices.length >= 3 ? [...extracted.vertices] : fallbackVerts;

    if (activeShape && !forceLayer) {
      updateShapeById(activeShape.id, (s) => ({
        ...s,
        kind: kindToUse,
        vertices,
        ...(extracted.capsule ? { capsule: extracted.capsule } : { capsule: undefined }),
        autoTraceMeta: { epsilonPx, maxVertices: maxV },
      }));
      setSelectedVertexIdx(0);
      return;
    }

    const layer = forceLayer ?? 'collider';
    const newShape: CollisionLayerShape = {
      id: globalThis.crypto.randomUUID(),
      name: layer,
      layer,
      kind: kindToUse,
      isSensor: layer !== 'collider',
      visible: true,
      vertices,
      ...(extracted.capsule ? { capsule: extracted.capsule } : {}),
      autoTraceMeta: { epsilonPx, maxVertices: maxV },
    };
    onChangeShapes([...shapes, newShape]);
    setSelectedShapeId(newShape.id);
    setSelectedVertexIdx(0);
  };

  const handleAddSemanticLayer = (layer: ColliderLayer) => {
    setEditorHint(null);
    if (layer === 'collider') {
      runAutoTraceForLayer(traceKind, maxVertices, 'collider');
      return;
    }
    const existingCount = shapes.filter((s) => s.layer === layer).length;
    const suffix = existingCount > 0 ? `_${existingCount + 1}` : '';
    const w = Math.max(8, Math.round(sprite.width * 0.18));
    const h = Math.max(10, Math.round(sprite.height * 0.28));
    const vertices =
      layer === 'hitbox'
        ? makeFallbackBox(
            Math.max(6, Math.round(w * 0.75)),
            Math.max(6, Math.round(h * 0.65)),
            w,
            -h,
          )
        : makeFallbackBox(w, h, 0, -Math.round(h * 0.85));

    const newShape: CollisionLayerShape = {
      id: globalThis.crypto.randomUUID(),
      name: `${layer}${suffix}`,
      layer,
      kind: 'aabb',
      isSensor: true,
      visible: true,
      vertices,
    };
    onChangeShapes([...shapes, newShape]);
    setSelectedShapeId(newShape.id);
    setSelectedVertexIdx(0);
  };

  const latestGridSnapRef = useRef(gridSnap);
  latestGridSnapRef.current = gridSnap;

  const clientPointToPivotRelative = useCallback(
    (clientX: number, clientY: number): Vec2 | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const spriteX = ((clientX - rect.left) / Math.max(1, rect.width)) * sprite.width;
      const spriteY = ((clientY - rect.top) / Math.max(1, rect.height)) * sprite.height;
      const snap = latestGridSnapRef.current;
      return {
        x: applySnap(spriteX - pivotPx.x, snap),
        y: applySnap(spriteY - pivotPx.y, snap),
      };
    },
    [sprite.width, sprite.height, pivotPx.x, pivotPx.y],
  );

  useEffect(() => {
    const handleWindowPointerMove = (e: PointerEvent) => {
      const drag = draggingRef.current;
      if (!drag) return;
      const rel = clientPointToPivotRelative(e.clientX, e.clientY);
      if (!rel) return;
      updateShapeById(drag.shapeId, (shape) => ({
        ...shape,
        vertices: shape.vertices.map((v, i) => (i === drag.vertexIdx ? rel : v)),
      }));
    };
    const handleWindowPointerUp = () => {
      draggingRef.current = null;
    };
    window.addEventListener('pointermove', handleWindowPointerMove);
    window.addEventListener('pointerup', handleWindowPointerUp);
    window.addEventListener('pointercancel', handleWindowPointerUp);
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove);
      window.removeEventListener('pointerup', handleWindowPointerUp);
      window.removeEventListener('pointercancel', handleWindowPointerUp);
    };
  }, [clientPointToPivotRelative, updateShapeById]);

  const handleInsertMidpoint = (shapeId: string, edgeIdx: number) => {
    const shape = shapes.find((s) => s.id === shapeId);
    if (!shape || shape.vertices.length < 2) return;
    const a = shape.vertices[edgeIdx]!;
    const b = shape.vertices[(edgeIdx + 1) % shape.vertices.length]!;
    const mid: Vec2 = {
      x: applySnap((a.x + b.x) * 0.5, gridSnap),
      y: applySnap((a.y + b.y) * 0.5, gridSnap),
    };
    const nextVerts = [
      ...shape.vertices.slice(0, edgeIdx + 1),
      mid,
      ...shape.vertices.slice(edgeIdx + 1),
    ];
    updateShapeById(shapeId, (s) => ({ ...s, vertices: nextVerts }));
    setSelectedVertexIdx(edgeIdx + 1);
  };

  const toggleFrameActiveForShape = (frameIdx: number) => {
    if (!activeShape) return;
    const cur = activeShape.activeFrames;
    let nextFrames: number[] | undefined;
    if (!cur || cur.length === 0) {
      // Switching from "All Frames" to all except the toggled frame, or single frame?
      // Toggle to all frames except `frameIdx` when all frames are active makes per-frame gating intuitive,
      // OR toggle just that frame when building sparse activeFrames. Let's make button "Active on Frame #X" toggle cleanly:
      nextFrames = Array.from({ length: frameSlotCount }, (_, i) => i).filter(
        (i) => i !== frameIdx,
      );
    } else if (cur.includes(frameIdx)) {
      nextFrames = cur.filter((f) => f !== frameIdx);
    } else {
      nextFrames = [...cur, frameIdx].sort((a, b) => a - b);
    }
    updateShapeById(activeShape.id, (s) => ({
      ...s,
      ...(nextFrames && nextFrames.length > 0 && nextFrames.length < frameSlotCount
        ? { activeFrames: nextFrames }
        : { activeFrames: undefined }),
    }));
  };

  const codePreview = useMemo(() => {
    if (previewMode === 'godot') {
      return exportGodotColliderTres(shapes);
    }
    return JSON.stringify(exportMatterPhysicsJson(spriteSlug, shapes), null, 2);
  }, [previewMode, shapes, spriteSlug]);

  const handleCopySnippet = async () => {
    try {
      await navigator.clipboard.writeText(codePreview);
      setCopiedCode(true);
      window.setTimeout(() => setCopiedCode(false), 1500);
    } catch {
      setEditorHint('Clipboard write blocked in this browser context.');
    }
  };

  const stageW = Math.max(1, Math.round(sprite.width * (zoomPercent / 100)));
  const stageH = Math.max(1, Math.round(sprite.height * (zoomPercent / 100)));
  const activeConvex = activeShape ? isPolygonConvex(activeShape.vertices) : false;
  const selectedCoord = activeShape?.vertices[selectedVertexIdx] ?? null;
  const handleRadiusPx = Math.max(1.1, (7 * sprite.width) / Math.max(1, stageW));
  const midRadiusPx = Math.max(0.85, handleRadiusPx * 0.72);
  const strokeWidthPx = Math.max(0.4, (1.5 * sprite.width) / Math.max(1, stageW));

  return (
    <div
      data-testid="collider-editor"
      className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[300px_minmax(0,1fr)_320px]"
    >
      {/* Left Pane: Semantic Layers & Auto-Trace Controls */}
      <aside className="space-y-4 overflow-y-auto border-b border-slate-800 bg-slate-900/70 p-4 lg:border-r lg:border-b-0">
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
          <div className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
            Semantic Physics Layers
          </div>
          <div className="grid grid-cols-3 gap-1.5 text-[11px]">
            <button
              type="button"
              data-testid="collider-add-collider-btn"
              onClick={() => handleAddSemanticLayer('collider')}
              className="inline-flex items-center justify-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-1.5 font-semibold text-emerald-200 hover:bg-emerald-500/25"
            >
              <Shield className="h-3 w-3" />
              Collider
            </button>
            <button
              type="button"
              data-testid="collider-add-hurtbox-btn"
              onClick={() => handleAddSemanticLayer('hurtbox')}
              className="inline-flex items-center justify-center gap-1 rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-1.5 font-semibold text-sky-200 hover:bg-sky-500/25"
            >
              <Plus className="h-3 w-3" />
              Hurtbox
            </button>
            <button
              type="button"
              data-testid="collider-add-hitbox-btn"
              onClick={() => handleAddSemanticLayer('hitbox')}
              className="inline-flex items-center justify-center gap-1 rounded border border-rose-500/40 bg-rose-500/15 px-1.5 py-1.5 font-semibold text-rose-200 hover:bg-rose-500/25"
            >
              <Swords className="h-3 w-3" />
              Hitbox
            </button>
          </div>

          <div data-testid="collider-layer-list" className="space-y-1.5 pt-1">
            {shapes.length === 0 ? (
              <p className="text-[11px] text-slate-500">
                No shapes yet. Click Auto-Trace or add a Collider / Hurtbox / Hitbox layer.
              </p>
            ) : (
              shapes.map((shape) => {
                const meta = LAYER_META[shape.layer];
                const isSelected = activeShape?.id === shape.id;
                return (
                  <div
                    key={shape.id}
                    data-testid={`collider-layer-item-${shape.id}`}
                    className={`flex items-center justify-between gap-2 rounded border px-2 py-1.5 text-xs ${
                      isSelected
                        ? 'border-indigo-500 bg-indigo-600/20 text-white'
                        : 'border-slate-800 bg-slate-900/70 text-slate-300'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedShapeId(shape.id);
                        setSelectedVertexIdx(0);
                      }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className="h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: meta.color }}
                      />
                      <span className="truncate font-medium">{shape.name}</span>
                      <span className="font-mono text-[10px] text-slate-400">
                        ({shape.vertices.length})
                      </span>
                    </button>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        data-testid={`collider-layer-vis-${shape.id}`}
                        onClick={() =>
                          updateShapeById(shape.id, (s) => ({ ...s, visible: !s.visible }))
                        }
                        className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
                        title={shape.visible ? 'Hide layer' : 'Show layer'}
                      >
                        {shape.visible ? (
                          <Eye className="h-3.5 w-3.5" />
                        ) : (
                          <EyeOff className="h-3.5 w-3.5" />
                        )}
                      </button>
                      <button
                        type="button"
                        data-testid={`collider-layer-del-${shape.id}`}
                        onClick={() => onChangeShapes(shapes.filter((s) => s.id !== shape.id))}
                        className="rounded p-1 text-rose-400 hover:bg-rose-500/20"
                        title="Delete layer"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {activeShape && (
            <label className="flex items-center justify-between pt-1 text-[11px] text-slate-300">
              <span>Sensor Only (isSensor)</span>
              <input
                type="checkbox"
                checked={activeShape.isSensor}
                onChange={(e) =>
                  updateShapeById(activeShape.id, (s) => ({ ...s, isSensor: e.target.checked }))
                }
                className="accent-indigo-500"
              />
            </label>
          )}
        </div>

        {/* Auto-Trace Silhouette Card */}
        <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
          <div className="font-semibold text-slate-200">Auto-Trace Alpha Silhouette</div>

          <label className="block space-y-1">
            <span className="text-[11px] text-slate-400">Primitive / Simplifier Mode</span>
            <select
              data-testid="collider-kind-select"
              value={traceKind}
              onChange={(e) => setTraceKind(e.target.value as ColliderKind)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
            >
              <option value="convex-hull">Convex Hull (Box2D / Godot Safe)</option>
              <option value="polygon">Exact Contour Polygon (RDP)</option>
              <option value="aabb">Tight AABB Rectangle</option>
              <option value="capsule">Character Capsule (2D)</option>
            </select>
          </label>

          <label className="block space-y-1">
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>RDP Epsilon Tolerance</span>
              <span className="font-mono">{epsilonPx.toFixed(2)} px</span>
            </div>
            <input
              type="range"
              data-testid="collider-epsilon-slider"
              min={0.5}
              max={8.0}
              step={0.25}
              value={epsilonPx}
              onChange={(e) => setEpsilonPx(Number(e.target.value))}
              className="w-full accent-emerald-400"
            />
          </label>

          <label className="block space-y-1">
            <div className="flex justify-between text-[11px] text-slate-400">
              <span>Max Vertices Cap</span>
              <span className="font-mono">{maxVertices}</span>
            </div>
            <input
              type="range"
              data-testid="collider-max-vertices-slider"
              min={4}
              max={32}
              step={1}
              value={maxVertices}
              onChange={(e) => setMaxVertices(Number(e.target.value))}
              className="w-full accent-emerald-400"
            />
          </label>

          <div className="grid grid-cols-1 gap-1.5">
            <button
              type="button"
              data-testid="collider-autotrace-btn"
              onClick={() => runAutoTraceForLayer()}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Auto-Trace Silhouette
            </button>
            <button
              type="button"
              data-testid="collider-box2d-preset-btn"
              onClick={() => {
                setTraceKind('convex-hull');
                setMaxVertices(8);
                runAutoTraceForLayer('convex-hull', 8);
              }}
              className="w-full rounded border border-emerald-500/40 bg-emerald-950/40 px-2.5 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-900/40"
            >
              8-Vertex Box2D Safe Preset
            </button>
          </div>

          <label className="block space-y-1 pt-1">
            <span className="text-[11px] text-slate-400">Vertex Grid Snap</span>
            <select
              data-testid="collider-snap-select"
              value={gridSnap}
              onChange={(e) => setGridSnap(e.target.value as GridSnapMode)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
            >
              <option value="off">Sub-pixel Smooth (Off)</option>
              <option value="0.5">0.5 px Half-Pixel Grid</option>
              <option value="1">1 px Integer Grid</option>
            </select>
          </label>
        </div>
      </aside>

      {/* Center Pane: Interactive Vector Overlay + M9 Frame Timeline */}
      <section className="flex min-w-0 flex-col bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/50 px-4 py-2 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setZoomPercent((z) => Math.max(100, z - 50))}
              className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
              aria-label="Zoom out collider stage"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
            <span className="min-w-12 text-center font-mono text-slate-200">{zoomPercent}%</span>
            <button
              type="button"
              onClick={() => setZoomPercent((z) => Math.min(800, z + 50))}
              className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
              aria-label="Zoom in collider stage"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <span className="ml-1 font-mono text-[11px] text-slate-400">
              Pivot ({pivotPx.x}, {pivotPx.y})
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            {activeShape && (
              <>
                <span
                  data-testid="collider-convexity-badge"
                  className={`rounded border px-2 py-0.5 font-semibold ${
                    activeShape.kind === 'capsule' || activeConvex
                      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                      : 'border-amber-500/40 bg-amber-500/15 text-amber-200'
                  }`}
                >
                  {activeShape.kind === 'capsule'
                    ? 'Capsule'
                    : activeConvex
                      ? 'Convex ✓'
                      : 'Concave (needs decomp)'}
                </span>
                <span
                  data-testid="collider-vertex-count"
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 font-mono text-slate-200"
                >
                  {activeShape.vertices.length} vertices
                </span>
                {selectedCoord && (
                  <span
                    data-testid="collider-selected-coord"
                    className="rounded border border-indigo-500/40 bg-indigo-500/15 px-2 py-0.5 font-mono text-indigo-200"
                  >
                    v{selectedVertexIdx}: ({selectedCoord.x}, {selectedCoord.y})
                  </span>
                )}
              </>
            )}
          </div>
        </div>

        <div className="flex flex-1 flex-col items-center justify-center overflow-auto p-6">
          <div
            className="bg-checkerboard relative overflow-hidden rounded-lg border border-slate-700 shadow-2xl"
            style={{ width: stageW, height: stageH }}
          >
            <canvas
              ref={canvasRef}
              className="h-full w-full"
              style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
            />

            <svg
              ref={svgRef}
              data-testid="collider-svg-overlay"
              viewBox={`0 0 ${sprite.width} ${sprite.height}`}
              onContextMenu={(e) => e.preventDefault()}
              className="absolute inset-0 h-full w-full touch-none select-none"
            >
              {/* Pivot Crosshair */}
              <line
                x1={pivotPx.x - 4}
                y1={pivotPx.y}
                x2={pivotPx.x + 4}
                y2={pivotPx.y}
                stroke="#F59E0B"
                strokeWidth={strokeWidthPx}
                strokeDasharray={`${strokeWidthPx * 2} ${strokeWidthPx}`}
              />
              <line
                x1={pivotPx.x}
                y1={pivotPx.y - 4}
                x2={pivotPx.x}
                y2={pivotPx.y + 4}
                stroke="#F59E0B"
                strokeWidth={strokeWidthPx}
                strokeDasharray={`${strokeWidthPx * 2} ${strokeWidthPx}`}
              />

              {/* Visible Semantic Polygons */}
              {shapes.map((shape) => {
                if (!shape.visible || shape.vertices.length < 3) return null;
                const meta = LAYER_META[shape.layer];
                const frameEnabled = isShapeActiveOnFrame(shape, selectedFrameIdx);
                const pointsAttr = shape.vertices
                  .map((v) => `${(v.x + pivotPx.x).toFixed(2)},${(v.y + pivotPx.y).toFixed(2)}`)
                  .join(' ');
                return (
                  <polygon
                    key={shape.id}
                    data-testid={`collider-poly-${shape.layer}`}
                    points={pointsAttr}
                    fill={meta.fill}
                    stroke={meta.color}
                    strokeWidth={strokeWidthPx * (activeShape?.id === shape.id ? 1.4 : 1.0)}
                    opacity={frameEnabled ? 1.0 : 0.25}
                    onClick={() => {
                      setSelectedShapeId(shape.id);
                      setSelectedVertexIdx(0);
                    }}
                  />
                );
              })}

              {/* Active Layer Edge Midpoint Insert (+) Handles & Vertex Handles */}
              {activeShape && activeShape.visible && (
                <g>
                  {activeShape.vertices.map((v, idx) => {
                    const next = activeShape.vertices[(idx + 1) % activeShape.vertices.length] ?? v;
                    const mx = (v.x + next.x) * 0.5 + pivotPx.x;
                    const my = (v.y + next.y) * 0.5 + pivotPx.y;
                    return (
                      <circle
                        key={`mid-${idx}`}
                        data-testid={`collider-midpoint-handle-${idx}`}
                        cx={mx}
                        cy={my}
                        r={midRadiusPx}
                        fill="#0F172A"
                        stroke="#E2E8F0"
                        strokeWidth={strokeWidthPx * 0.8}
                        opacity={0.78}
                        className="cursor-copy"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleInsertMidpoint(activeShape.id, idx);
                        }}
                      />
                    );
                  })}

                  {activeShape.vertices.map((v, idx) => {
                    const meta = LAYER_META[activeShape.layer];
                    const isSelected = idx === selectedVertexIdx;
                    return (
                      <circle
                        key={`vert-${idx}`}
                        data-testid={`collider-vertex-handle-${idx}`}
                        cx={v.x + pivotPx.x}
                        cy={v.y + pivotPx.y}
                        r={handleRadiusPx}
                        fill={isSelected ? '#FFFFFF' : meta.color}
                        stroke="#090D16"
                        strokeWidth={strokeWidthPx}
                        className="cursor-grab active:cursor-grabbing"
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          deleteVertexAt(activeShape.id, idx);
                        }}
                        onPointerDown={(e) => {
                          e.stopPropagation();
                          if (e.button === 2) return;
                          if (e.altKey) {
                            e.preventDefault();
                            deleteVertexAt(activeShape.id, idx);
                            return;
                          }
                          setSelectedVertexIdx(idx);
                          draggingRef.current = { shapeId: activeShape.id, vertexIdx: idx };
                        }}
                      />
                    );
                  })}
                </g>
              )}
            </svg>
          </div>

          <p className="mt-3 text-[11px] text-slate-400">
            Drag handles to adjust vertices · Click white midpoint dot to insert · Right-click or
            Delete key to remove vertex
          </p>
          {editorHint && (
            <p className="mt-1 text-[11px] text-amber-300" data-testid="collider-hint">
              {editorHint}
            </p>
          )}
        </div>

        {/* Bottom Bar: M9 Puppet-Warp Frame Timeline Binding */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-800 bg-slate-900/60 px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-300">
              <Film className="h-3.5 w-3.5 text-indigo-400" />
              M9 Frames:
            </span>
            {Array.from({ length: frameSlotCount }, (_, idx) => {
              const activeOnFrame = activeShape ? isShapeActiveOnFrame(activeShape, idx) : true;
              return (
                <button
                  key={idx}
                  type="button"
                  data-testid={`collider-frame-btn-${idx}`}
                  onClick={() => setSelectedFrameIdx(idx)}
                  className={`rounded border px-2 py-0.5 font-mono text-[11px] ${
                    selectedFrameIdx === idx
                      ? 'border-indigo-400 bg-indigo-600 font-semibold text-white'
                      : activeOnFrame
                        ? 'border-slate-700 bg-slate-900 text-slate-200'
                        : 'border-slate-800 bg-slate-950 text-slate-500 opacity-60'
                  }`}
                >
                  F{idx}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-3 text-[11px]">
            {activeShape && (
              <button
                type="button"
                data-testid="collider-frame-active-toggle"
                onClick={() => toggleFrameActiveForShape(selectedFrameIdx)}
                className={`rounded border px-2 py-1 font-medium ${
                  isShapeActiveOnFrame(activeShape, selectedFrameIdx)
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200'
                    : 'border-slate-700 bg-slate-900 text-slate-400'
                }`}
              >
                {!activeShape.activeFrames || activeShape.activeFrames.length === 0
                  ? 'All Frames (Click to Gate F' + selectedFrameIdx + ')'
                  : isShapeActiveOnFrame(activeShape, selectedFrameIdx)
                    ? `Active on F${selectedFrameIdx} ✓`
                    : `Inactive on F${selectedFrameIdx}`}
              </button>
            )}
            <label className="inline-flex items-center gap-1.5 text-slate-300">
              <input
                type="checkbox"
                checked={onionSkin}
                onChange={(e) => setOnionSkin(e.target.checked)}
                className="accent-indigo-500"
              />
              Onion Skin
            </label>
          </div>
        </div>
      </section>

      {/* Right Pane: Engine Code Preview & Export Bundle */}
      <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
        <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-200">Engine Physics Preview</span>
            <button
              type="button"
              onClick={() => void handleCopySnippet()}
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800"
            >
              {copiedCode ? (
                <>
                  <Check className="h-3 w-3 text-emerald-400" />
                  Copied
                </>
              ) : (
                <>
                  <Copy className="h-3 w-3" />
                  Copy
                </>
              )}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="collider-preview-godot-btn"
              onClick={() => setPreviewMode('godot')}
              className={`rounded border px-2 py-1 text-[11px] font-semibold ${
                previewMode === 'godot'
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300'
              }`}
            >
              Godot 4 .tres
            </button>
            <button
              type="button"
              data-testid="collider-preview-matter-btn"
              onClick={() => setPreviewMode('matter')}
              className={`rounded border px-2 py-1 text-[11px] font-semibold ${
                previewMode === 'matter'
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300'
              }`}
            >
              Matter.js / Phaser
            </button>
          </div>

          <pre
            data-testid="collider-code-preview"
            className="max-h-56 overflow-auto rounded border border-slate-800 bg-slate-950 p-2 font-mono text-[10px] leading-relaxed text-emerald-200"
          >
            {codePreview}
          </pre>
        </div>

        {exportSlot}
      </aside>
    </div>
  );
}
