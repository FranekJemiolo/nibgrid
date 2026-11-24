import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import {
  Check,
  Copy,
  Crosshair,
  FileArchive,
  Plus,
  Save,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { ArtMode, PuppetAnimConfig } from '../../domain/schemas';
import { computePivotPx } from '../../export/recipeBuilder';
import {
  exportGodotSocketsTscnSnippet,
  exportPhaserSocketsJson,
  exportPixiSocketsJson,
  type SocketExportFormat,
} from '../../export/socketExporters';
import { generatePresetKeyframes } from '../../processing/animPresets';
import {
  evaluateSocketsAcrossFrames,
  extractMeshGeometry,
  interleavedPositionsToVec2,
  PRESET_SOCKETS,
  sanitizeSocketName,
  type EvaluatedSocketFrame,
  type PresetSocketMeta,
  type SocketDefinition,
} from '../../processing/attachmentSockets';
import type { Vec2 } from '../../processing/collisionHull';
import { solveMlsMesh, type MlsSolveResult } from '../../processing/mlsWarp';
import { buildAlphaClippedMesh, rasterizeDeformedMeshCpu } from '../../processing/spriteMesh';
import type { RgbaBuffer } from '../../processing/types';
import { ScrubInput } from '../primitives/ScrubInput';

export interface SocketEditorProps {
  readonly sprite: RgbaBuffer;
  readonly spriteSlug: string;
  readonly artMode: ArtMode;
  readonly pivotNorm: { readonly x: number; readonly y: number };
  readonly puppetConfig: PuppetAnimConfig;
  readonly sockets: readonly SocketDefinition[];
  readonly onChangeSockets: (next: SocketDefinition[]) => void;
  readonly onSaveSockets: (next: SocketDefinition[]) => Promise<void>;
  readonly onDownloadZip: () => void;
  readonly exportSlot?: ReactNode;
}

const CUSTOM_SOCKET_COLORS = ['#22C55E', '#EC4899', '#14B8A6', '#F59E0B', '#38BDF8', '#A855F7'];

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function makeUniqueSocketName(rawBase: string, existing: readonly SocketDefinition[]): string {
  const base = sanitizeSocketName(rawBase);
  const taken = new Set(existing.map((s) => s.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}_${n}`)) {
    n += 1;
  }
  return `${base}_${n}`;
}

function createSocketId(name: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `sock-${name}-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `sock-${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function round2(n: number): number {
  const rounded = Number(n.toFixed(2));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function clampCoord(value: number, max: number): number {
  return round2(Math.max(0, Math.min(max, value)));
}

export function SocketEditor({
  sprite,
  spriteSlug,
  artMode,
  pivotNorm,
  puppetConfig,
  sockets,
  onChangeSockets,
  onSaveSockets,
  onDownloadZip,
  exportSlot,
}: SocketEditorProps) {
  const [selectedSocketId, setSelectedSocketId] = useState<string | null>(
    () => sockets[0]?.id ?? null,
  );
  const [customName, setCustomName] = useState('');
  const [frameIndex, setFrameIndex] = useState(0);
  const [exportFormat, setExportFormat] = useState<SocketExportFormat>('godot');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [zoomPercent, setZoomPercent] = useState(() => {
    const maxDim = Math.max(1, sprite.width, sprite.height);
    const ideal = Math.floor(320 / maxDim) * 100;
    return Math.min(600, Math.max(200, ideal));
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const socketsRef = useRef(sockets);
  socketsRef.current = sockets;
  const onChangeSocketsRef = useRef(onChangeSockets);
  onChangeSocketsRef.current = onChangeSockets;
  const dragCleanupRef = useRef<(() => void) | null>(null);

  const pivotPx = useMemo(
    () => computePivotPx(pivotNorm, sprite.width, sprite.height),
    [pivotNorm, sprite.width, sprite.height],
  );

  // Sync selection if sockets list changes externally or active socket was removed
  useEffect(() => {
    if (sockets.length === 0) {
      if (selectedSocketId !== null) setSelectedSocketId(null);
      return;
    }
    if (!selectedSocketId || !sockets.some((s) => s.id === selectedSocketId)) {
      setSelectedSocketId(sockets[0]?.id ?? null);
    }
  }, [sockets, selectedSocketId]);

  useEffect(() => {
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
    };
  }, []);

  // Build rest triangulation only when sprite pixels/size change
  const restMesh = useMemo(() => {
    if (puppetConfig.pins.length === 0) return null;
    return buildAlphaClippedMesh(sprite, { artMode });
  }, [sprite, artMode, puppetConfig.pins.length]);

  const restGeometry = useMemo(() => {
    if (!restMesh) return null;
    return extractMeshGeometry(restMesh);
  }, [restMesh]);

  // Pre-solve MLS deformation across preset keyframes only when mesh or puppet config changes
  const mlsSolutions = useMemo<MlsSolveResult[]>(() => {
    if (!restMesh || puppetConfig.pins.length === 0) return [];
    const keyframes = generatePresetKeyframes(
      puppetConfig.pins,
      puppetConfig.preset,
      puppetConfig.frameCount,
      puppetConfig.amplitudePx,
    );
    return keyframes.map((kf) =>
      solveMlsMesh(restMesh.vertices, puppetConfig.pins, kf.pins, puppetConfig.mode, 1.0),
    );
  }, [restMesh, puppetConfig]);

  const deformedFramesVec2 = useMemo(
    () => mlsSolutions.map((sol) => interleavedPositionsToVec2(sol.positions)),
    [mlsSolutions],
  );

  const evaluatedByFrame = useMemo<EvaluatedSocketFrame[][]>(() => {
    if (restGeometry && deformedFramesVec2.length > 0) {
      return evaluateSocketsAcrossFrames(
        sockets,
        restGeometry.restVertices,
        restGeometry.triangles,
        deformedFramesVec2,
        pivotPx,
      );
    }
    return evaluateSocketsAcrossFrames(sockets, [], [], [null], pivotPx);
  }, [sockets, restGeometry, deformedFramesVec2, pivotPx]);

  const totalFrames = Math.max(1, evaluatedByFrame.length);
  const clampedFrameIndex = Math.min(frameIndex, totalFrames - 1);

  useEffect(() => {
    if (frameIndex >= totalFrames) {
      setFrameIndex(totalFrames - 1);
    }
  }, [frameIndex, totalFrames]);

  // Draw active rest or deformed frame using zero-WebGL2 Canvas2D
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = sprite.width;
    canvas.height = sprite.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, sprite.width, sprite.height);
    if (
      clampedFrameIndex > 0 &&
      restMesh &&
      mlsSolutions[clampedFrameIndex] &&
      puppetConfig.pins.length > 0
    ) {
      const sol = mlsSolutions[clampedFrameIndex]!;
      const deformed = rasterizeDeformedMeshCpu(sprite, restMesh, sol.positions, sol.rotations, {
        paddingPx: 0,
        pixelArt: artMode === 'pixel-art',
      });
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(deformed.data), deformed.width, deformed.height),
        0,
        0,
      );
    } else {
      ctx.putImageData(
        new ImageData(new Uint8ClampedArray(sprite.data), sprite.width, sprite.height),
        0,
        0,
      );
    }
  }, [sprite, artMode, restMesh, mlsSolutions, puppetConfig.pins.length, clampedFrameIndex]);

  const deleteSocketById = useCallback(
    (id: string) => {
      const current = socketsRef.current;
      const idx = current.findIndex((s) => s.id === id);
      if (idx === -1) return;
      const next = current.filter((s) => s.id !== id);
      onChangeSocketsRef.current(next);
      setSaveNotice(null);
      if (selectedSocketId === id) {
        const fallback = next[Math.min(idx, Math.max(0, next.length - 1))] ?? null;
        setSelectedSocketId(fallback?.id ?? null);
      }
    },
    [selectedSocketId],
  );

  // Keyboard Delete/Backspace shortcut strictly isolated from editable inputs
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target) || isEditableElement(document.activeElement)) {
        return;
      }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedSocketId) {
        event.preventDefault();
        deleteSocketById(selectedSocketId);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedSocketId, deleteSocketById]);

  const handleAddPreset = (preset: PresetSocketMeta) => {
    const name = makeUniqueSocketName(preset.name, sockets);
    const created: SocketDefinition = {
      id: createSocketId(name),
      name,
      restPosPx: {
        x: clampCoord(preset.defaultNorm.x * sprite.width, sprite.width),
        y: clampCoord(preset.defaultNorm.y * sprite.height, sprite.height),
      },
      baseAngleDeg: preset.baseAngleDeg,
      colorHex: preset.colorHex,
    };
    const next = [...sockets, created];
    onChangeSockets(next);
    setSelectedSocketId(created.id);
    setFrameIndex(0);
    setSaveNotice(null);
  };

  const handleAddCustom = (event: FormEvent) => {
    event.preventDefault();
    const raw = customName.trim();
    if (raw.length === 0) return;
    const name = makeUniqueSocketName(raw, sockets);
    const colorHex = CUSTOM_SOCKET_COLORS[sockets.length % CUSTOM_SOCKET_COLORS.length];
    const created: SocketDefinition = {
      id: createSocketId(name),
      name,
      restPosPx: {
        x: clampCoord(sprite.width * 0.5, sprite.width),
        y: clampCoord(sprite.height * 0.5, sprite.height),
      },
      baseAngleDeg: 0,
      colorHex,
    };
    const next = [...sockets, created];
    onChangeSockets(next);
    setCustomName('');
    setSelectedSocketId(created.id);
    setFrameIndex(0);
    setSaveNotice(null);
  };

  const mapPointerToSpriteCoords = useCallback(
    (clientX: number, clientY: number): Vec2 | null => {
      const svg = svgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) return null;
      const relX = ((clientX - rect.left) / rect.width) * sprite.width;
      const relY = ((clientY - rect.top) / rect.height) * sprite.height;
      return {
        x: clampCoord(relX, sprite.width),
        y: clampCoord(relY, sprite.height),
      };
    },
    [sprite.width, sprite.height],
  );

  const startDragSocket = (event: ReactPointerEvent<SVGGElement>, socketId: string) => {
    event.preventDefault();
    event.stopPropagation();
    dragCleanupRef.current?.();
    setSelectedSocketId(socketId);
    setFrameIndex(0);
    setDraggingId(socketId);
    setSaveNotice(null);

    const updateFromClient = (clientX: number, clientY: number) => {
      const mapped = mapPointerToSpriteCoords(clientX, clientY);
      if (!mapped) return;
      const current = socketsRef.current;
      const next = current.map((s) => (s.id === socketId ? { ...s, restPosPx: mapped } : s));
      onChangeSocketsRef.current(next);
    };

    const onPointerMove = (moveEv: PointerEvent) => {
      updateFromClient(moveEv.clientX, moveEv.clientY);
    };

    const cleanup = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      setDraggingId(null);
      dragCleanupRef.current = null;
    };

    const onPointerUp = (upEv: PointerEvent) => {
      updateFromClient(upEv.clientX, upEv.clientY);
      cleanup();
    };

    dragCleanupRef.current = cleanup;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  const selectedSocket = sockets.find((s) => s.id === selectedSocketId) ?? null;
  const activeFrameEntries = evaluatedByFrame[clampedFrameIndex] ?? [];
  const selectedEval = selectedSocket
    ? (activeFrameEntries.find((entry) => entry.socketId === selectedSocket.id) ?? null)
    : null;

  const previewCode = useMemo(() => {
    if (exportFormat === 'godot') {
      return exportGodotSocketsTscnSnippet(spriteSlug, sockets, evaluatedByFrame);
    }
    if (exportFormat === 'phaser') {
      return exportPhaserSocketsJson(spriteSlug, puppetConfig.fps, sockets, evaluatedByFrame);
    }
    return exportPixiSocketsJson(spriteSlug, puppetConfig.fps, sockets, evaluatedByFrame);
  }, [exportFormat, spriteSlug, puppetConfig.fps, sockets, evaluatedByFrame]);

  const handleCopySnippet = async () => {
    try {
      await navigator.clipboard.writeText(previewCode);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveNotice(null);
    try {
      await onSaveSockets([...sockets]);
      setSaveNotice(
        `Saved ${sockets.length} attachment socket${sockets.length === 1 ? '' : 's'} to IndexedDB.`,
      );
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : 'Failed to save sockets.');
    } finally {
      setSaving(false);
    }
  };

  const stageW = Math.max(1, Math.round(sprite.width * (zoomPercent / 100)));
  const stageH = Math.max(1, Math.round(sprite.height * (zoomPercent / 100)));
  const svgUnit = Math.max(0.45, Math.max(sprite.width, sprite.height) / 96);
  const hitRadius = Math.max(4, Math.max(sprite.width, sprite.height) * 0.065);
  const armLen = svgUnit * 3.8;
  const arrowLen = svgUnit * 6.5;

  return (
    <div
      data-testid="socket-editor-panel"
      className="flex flex-1 flex-col overflow-hidden bg-[var(--bg-well)] lg:flex-row"
    >
      {/* Left Pane: Presets, Custom Socket Form & Socket List */}
      <div className="w-full shrink-0 space-y-3 overflow-y-auto border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 lg:w-72 lg:border-r lg:border-b-0">
        <div>
          <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
            Quick Presets
          </h3>
          <p className="mt-0.5 text-[11px] text-[var(--text-muted)]">
            Bind named game sockets directly onto your sprite mesh.
          </p>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {PRESET_SOCKETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                data-testid={`socket-preset-${preset.name}`}
                onClick={() => handleAddPreset(preset)}
                className="flex items-center gap-1.5 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1.5 text-left font-mono text-[11px] text-slate-200 transition-colors hover:border-[#F5B82E]/60 hover:bg-slate-800"
              >
                <span
                  className="inline-block h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: preset.colorHex }}
                />
                <span className="truncate">{preset.label}</span>
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleAddCustom} className="space-y-1.5">
          <label
            htmlFor="socket-custom-name"
            className="block text-[11px] font-semibold tracking-wider text-slate-300 uppercase"
          >
            Custom Socket ID
          </label>
          <div className="flex gap-1.5">
            <input
              id="socket-custom-name"
              type="text"
              data-testid="socket-custom-name-input"
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              placeholder="e.g. wing_tip"
              className="min-w-0 flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1.5 font-mono text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#F5B82E] focus:outline-none"
            />
            <button
              type="submit"
              data-testid="socket-custom-add-btn"
              disabled={customName.trim().length === 0}
              className="inline-flex items-center gap-1 rounded bg-[#F5B82E] px-2.5 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:cursor-not-allowed disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              Add
            </button>
          </div>
        </form>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold tracking-wider text-slate-300 uppercase">
              Active Sockets ({sockets.length})
            </span>
            {puppetConfig.pins.length > 0 && (
              <span className="rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                MLS Bound
              </span>
            )}
          </div>

          {sockets.length === 0 ? (
            <div className="rounded border border-dashed border-[var(--border-hairline)] bg-[var(--bg-well)]/60 p-3 text-center text-[11px] text-[var(--text-muted)]">
              Add a preset or custom socket to place markers on the sprite.
            </div>
          ) : (
            <div className="space-y-1">
              {sockets.map((sock) => {
                const selected = sock.id === selectedSocketId;
                return (
                  <div
                    key={sock.id}
                    className={`flex items-center gap-1 rounded border px-2 py-1.5 text-xs transition-colors ${
                      selected
                        ? 'border-[#F5B82E]/70 bg-[#F5B82E]/10 text-slate-100'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:bg-slate-800/70'
                    }`}
                  >
                    <button
                      type="button"
                      data-testid={`socket-item-${sock.name}`}
                      onClick={() => setSelectedSocketId(sock.id)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span
                        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                        style={{ backgroundColor: sock.colorHex ?? '#F59E0B' }}
                      />
                      <span className="truncate font-mono font-medium">{sock.name}</span>
                      <span className="ml-auto shrink-0 font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
                        ({round2(sock.restPosPx.x)}, {round2(sock.restPosPx.y)})
                      </span>
                    </button>
                    <button
                      type="button"
                      data-testid={`socket-delete-${sock.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        deleteSocketById(sock.id);
                      }}
                      title={`Delete ${sock.name}`}
                      aria-label={`Delete ${sock.name}`}
                      className="rounded p-1 text-slate-400 hover:bg-rose-500/20 hover:text-rose-300"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {selectedSocket && (
          <div className="space-y-2.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-mono font-semibold text-[#F5B82E]">{selectedSocket.name}</span>
              <span className="text-[10px] text-[var(--text-muted)]">
                {selectedEval?.boundToMesh ? 'Mesh-Tracked' : 'Rest Pose'}
              </span>
            </div>

            <ScrubInput
              label="Base Angle"
              value={selectedSocket.baseAngleDeg}
              min={-180}
              max={180}
              step={1}
              unit="°"
              decimals={0}
              testId="socket-angle-scrub"
              onChange={(nextDeg) => {
                onChangeSockets(
                  sockets.map((s) =>
                    s.id === selectedSocket.id ? { ...s, baseAngleDeg: nextDeg } : s,
                  ),
                );
                setSaveNotice(null);
              }}
            />

            <div
              data-testid="socket-active-readout"
              className="space-y-1 rounded bg-[var(--bg-panel)] px-2 py-1.5 font-mono text-[11px] text-slate-300 tabular-nums"
            >
              <div>
                Rest ({round2(selectedSocket.restPosPx.x)}, {round2(selectedSocket.restPosPx.y)}) ·{' '}
                {round2(selectedSocket.baseAngleDeg)}°
              </div>
              {selectedEval && (
                <div className="text-[10px] text-emerald-300">
                  Frame {clampedFrameIndex}: Rel ({round2(selectedEval.pivotRelativePx.x)},{' '}
                  {round2(selectedEval.pivotRelativePx.y)}) · {round2(selectedEval.angleDeg)}°
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Center Pane: Zero-WebGL2 Canvas2D Stage + SVG Marker Overlay + Scrubber */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)]/70 px-4 py-2 text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            <Crosshair className="h-3.5 w-3.5 text-[#F5B82E]" />
            <span>
              Drag markers to position on rest frame · Amber cross = Pivot ({pivotPx.x}, {pivotPx.y}
              )
            </span>
          </div>
          <div className="flex items-center gap-2">
            <span
              data-testid="socket-count-badge"
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-0.5 font-mono text-[11px] text-slate-200 tabular-nums"
            >
              {sockets.length} socket{sockets.length === 1 ? '' : 's'}
            </span>
            <div className="flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1 py-0.5">
              <button
                type="button"
                aria-label="Zoom out sockets"
                onClick={() => setZoomPercent((z) => Math.max(100, z - 100))}
                className="rounded p-1 text-slate-300 hover:bg-slate-700"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span className="min-w-10 text-center font-mono text-[11px] text-slate-200 tabular-nums">
                {zoomPercent}%
              </span>
              <button
                type="button"
                aria-label="Zoom in sockets"
                onClick={() => setZoomPercent((z) => Math.min(800, z + 100))}
                className="rounded p-1 text-slate-300 hover:bg-slate-700"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex flex-1 items-center justify-center overflow-auto bg-[var(--bg-well)] p-6">
          <div
            className="bg-checkerboard relative shrink-0 rounded border border-[var(--border-hairline)] shadow-2xl"
            style={{ width: stageW, height: stageH }}
          >
            <canvas
              ref={canvasRef}
              data-testid="socket-stage-canvas"
              className="block h-full w-full"
              style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
            />
            <svg
              ref={svgRef}
              data-testid="socket-svg-overlay"
              viewBox={`0 0 ${sprite.width} ${sprite.height}`}
              className="absolute inset-0 h-full w-full select-none overflow-visible"
              style={{ touchAction: 'none' }}
            >
              {/* Pivot Anchor Crosshair */}
              <g pointerEvents="none" opacity={0.9}>
                <line
                  x1={pivotPx.x - armLen}
                  y1={pivotPx.y}
                  x2={pivotPx.x + armLen}
                  y2={pivotPx.y}
                  stroke="#F5B82E"
                  strokeWidth={svgUnit * 0.85}
                />
                <line
                  x1={pivotPx.x}
                  y1={pivotPx.y - armLen}
                  x2={pivotPx.x}
                  y2={pivotPx.y + armLen}
                  stroke="#F5B82E"
                  strokeWidth={svgUnit * 0.85}
                />
                <circle
                  cx={pivotPx.x}
                  cy={pivotPx.y}
                  r={svgUnit * 1.4}
                  fill="none"
                  stroke="#F5B82E"
                  strokeWidth={svgUnit * 0.65}
                />
              </g>

              {/* Draggable Socket Markers */}
              {sockets.map((sock) => {
                const evalEntry = activeFrameEntries.find((entry) => entry.socketId === sock.id);
                const dispX = evalEntry ? evalEntry.posPx.x : sock.restPosPx.x;
                const dispY = evalEntry ? evalEntry.posPx.y : sock.restPosPx.y;
                const dispAngleDeg = evalEntry ? evalEntry.angleDeg : sock.baseAngleDeg;
                const rad = (dispAngleDeg * Math.PI) / 180;
                const tipX = dispX + Math.cos(rad) * arrowLen;
                const tipY = dispY + Math.sin(rad) * arrowLen;
                const color = sock.colorHex ?? '#F59E0B';
                const isSelected = sock.id === selectedSocketId;
                const isDragging = draggingId === sock.id;

                return (
                  <g
                    key={sock.id}
                    data-testid={`socket-marker-${sock.name}`}
                    data-x={String(round2(dispX))}
                    data-y={String(round2(dispY))}
                    data-angle={String(round2(dispAngleDeg))}
                    style={{ cursor: isDragging ? 'grabbing' : 'grab' }}
                    onPointerDown={(e) => startDragSocket(e, sock.id)}
                  >
                    <circle cx={dispX} cy={dispY} r={hitRadius} fill="transparent" />
                    {isSelected && (
                      <circle
                        cx={dispX}
                        cy={dispY}
                        r={svgUnit * 4.4}
                        fill="none"
                        stroke="#FFFFFF"
                        strokeWidth={svgUnit * 0.7}
                        strokeDasharray={`${svgUnit * 1.6} ${svgUnit * 1.2}`}
                      />
                    )}
                    <line
                      x1={dispX}
                      y1={dispY}
                      x2={tipX}
                      y2={tipY}
                      stroke={color}
                      strokeWidth={svgUnit * 1.15}
                      strokeLinecap="round"
                    />
                    <circle cx={tipX} cy={tipY} r={svgUnit * 1.05} fill={color} />
                    <circle
                      cx={dispX}
                      cy={dispY}
                      r={svgUnit * 2.5}
                      fill="rgba(17, 17, 19, 0.55)"
                      stroke={color}
                      strokeWidth={svgUnit * 0.95}
                    />
                    <circle cx={dispX} cy={dispY} r={svgUnit * 0.85} fill="#FFFFFF" />
                    <text
                      x={dispX + svgUnit * 3.2}
                      y={dispY - svgUnit * 2.4}
                      fontSize={svgUnit * 3.8}
                      fontFamily="monospace"
                      fontWeight={700}
                      fill={color}
                      stroke="#111113"
                      strokeWidth={svgUnit * 0.8}
                      paintOrder="stroke"
                      pointerEvents="none"
                    >
                      {sock.name}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Bottom Frame Scrubber */}
        <div className="flex items-center gap-3 border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2 text-xs">
          <span className="shrink-0 font-mono text-[11px] text-slate-300 tabular-nums">
            {totalFrames > 1
              ? `Frame ${clampedFrameIndex + 1} / ${totalFrames}`
              : 'Rest Frame 1 / 1'}
          </span>
          <input
            type="range"
            data-testid="socket-frame-slider"
            min={0}
            max={Math.max(0, totalFrames - 1)}
            value={clampedFrameIndex}
            disabled={totalFrames <= 1}
            onChange={(e) => setFrameIndex(Number(e.target.value))}
            className="h-1.5 flex-1 accent-[#F5B82E] disabled:opacity-40"
          />
          {totalFrames === 1 && (
            <span className="shrink-0 text-[11px] text-[var(--text-muted)]">
              Add Puppet Warp pins to preview multi-frame socket deformation
            </span>
          )}
        </div>
      </div>

      {/* Right Pane: Engine Code Export, Save & ZIP Bundle */}
      <div className="w-full shrink-0 space-y-3 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 lg:w-80 lg:border-t-0 lg:border-l">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
              Engine Socket Export
            </h3>
            <button
              type="button"
              data-testid="socket-copy-btn"
              onClick={() => void handleCopySnippet()}
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
            >
              {copied ? (
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

          <div className="grid grid-cols-3 gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
            {(
              [
                { id: 'godot', label: 'Godot 4' },
                { id: 'phaser', label: 'Phaser 3' },
                { id: 'pixi', label: 'PixiJS' },
              ] as const
            ).map((tab) => {
              const active = exportFormat === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  data-testid={`socket-export-tab-${tab.id}`}
                  onClick={() => setExportFormat(tab.id)}
                  className={`rounded px-2 py-1 font-medium transition-colors ${
                    active
                      ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                      : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <pre
            data-testid="socket-export-preview"
            className="max-h-56 overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre text-slate-200"
          >
            {previewCode}
          </pre>
        </div>

        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <button
            type="button"
            data-testid="socket-save-btn"
            disabled={saving}
            onClick={() => void handleSave()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving Sockets...' : 'Save Sockets to Project'}
          </button>

          <button
            type="button"
            data-testid="socket-download-zip-btn"
            onClick={onDownloadZip}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
          >
            <FileArchive className="h-3.5 w-3.5" />
            Download Sprite + Sockets ZIP
          </button>

          {saveNotice && (
            <p data-testid="socket-save-notice" className="text-[11px] text-emerald-300">
              {saveNotice}
            </p>
          )}
        </div>

        {exportSlot}
      </div>
    </div>
  );
}
