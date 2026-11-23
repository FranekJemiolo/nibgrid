import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Eye, Film, Grid2X2, Layers, Sparkles } from 'lucide-react';
import { repository } from '../../db/database';
import { createDefaultPuppetAnimConfig, type SpriteNode } from '../../domain/schemas';
import { decodeBlobToNativeRgba } from '../../export/animationExporter';
import { packageAtlasZip, type AtlasEngineTarget } from '../../export/atlasExporters';
import { buildNineSliceExportFiles } from '../../export/nineSliceExporters';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { ANIM_PRESETS } from '../../processing/animPresets';
import { composeAtlasPages, type AtlasFrameInput } from '../../processing/atlasCompositor';
import { removeBackgroundColorKey } from '../../processing/backgroundKey';
import { bakeNormalMapCpu } from '../../processing/distanceField';
import { buildAlphaClippedMesh } from '../../processing/spriteMesh';
import type { RgbaBuffer } from '../../processing/types';
import { useAppStore } from '../../store/useAppStore';
import { buildPuppetStripArtifacts } from '../../webgl/puppetRenderer';

interface DecodedNodeAsset {
  readonly node: SpriteNode;
  readonly rgba: RgbaBuffer;
}

export function AtlasWorkshop() {
  const { activeProject, spriteNodes, refreshSpriteNodes, navigate } = useAppStore();
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [decodedAssets, setDecodedAssets] = useState<DecodedNodeAsset[]>([]);
  const [selectedStaticIds, setSelectedStaticIds] = useState<Record<string, boolean>>({});
  const [selectedLoopIds, setSelectedLoopIds] = useState<Record<string, boolean>>({});
  const [engines, setEngines] = useState<AtlasEngineTarget[]>(['godot', 'phaser', 'pixi']);
  const [maxSize, setMaxSize] = useState(1024);
  const [padding, setPadding] = useState(2);
  const [extrude, setExtrude] = useState(1);
  const [powerOfTwo, setPowerOfTwo] = useState(true);
  const [allowRotation, setAllowRotation] = useState(false);
  const [includeNormals, setIncludeNormals] = useState(false);
  const [showOverlay, setShowOverlay] = useState(true);
  const [previewChannel, setPreviewChannel] = useState<'albedo' | 'normal'>('albedo');
  const [activePageIndex, setActivePageIndex] = useState(0);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [exportNotice, setExportNotice] = useState<string | null>(null);

  const sourceNodes = useMemo(() => {
    const gen = spriteNodes.filter((n) => n.kind !== 'sketch');
    return gen.length > 0 ? gen : spriteNodes;
  }, [spriteNodes]);

  // Load RGBA buffers cleanly from Dexie blobs whenever project sprite nodes update
  useEffect(() => {
    let cancelled = false;
    void Promise.all(
      sourceNodes.map(async (node) => {
        const blobId = node.processedBlobId ?? node.imageBlobId;
        const rec = await repository.getBlob(blobId);
        if (!rec) return null;
        const decoded = await decodeBlobToNativeRgba(rec.bytes);
        // Apply clean default color-key cutout if sprite has zero transparent pixels
        let alphaTransparent = false;
        for (let i = 3; i < decoded.rgba.length; i += 4) {
          if ((decoded.rgba[i] ?? 255) < 255) {
            alphaTransparent = true;
            break;
          }
        }
        const rgba = alphaTransparent
          ? decoded.rgba
          : removeBackgroundColorKey(decoded.rgba, decoded.width, decoded.height, {
              tolerance: 20,
              contiguous: true,
            });
        return {
          node,
          rgba: { width: decoded.width, height: decoded.height, data: rgba },
        };
      }),
    ).then((items) => {
      if (cancelled) return;
      const valid = items.filter((item): item is DecodedNodeAsset => item !== null);
      setDecodedAssets(valid);
      setSelectedStaticIds((prev) => {
        const next: Record<string, boolean> = {};
        for (const item of valid) {
          next[item.node.id] = prev[item.node.id] ?? true;
        }
        return next;
      });
      setSelectedLoopIds((prev) => {
        const next: Record<string, boolean> = {};
        for (const item of valid) {
          if (item.node.puppetAnim && item.node.puppetAnim.pins.length > 0) {
            next[item.node.id] = prev[item.node.id] ?? true;
          }
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [sourceNodes]);

  const rotationLockedReason =
    engines.includes('godot') || includeNormals
      ? 'Rotation is locked OFF automatically when Godot 4 or Normal Maps are enabled.'
      : null;

  useEffect(() => {
    if (rotationLockedReason !== null && allowRotation) {
      setAllowRotation(false);
    }
  }, [rotationLockedReason, allowRotation]);

  const { atlasResult, packError, frameNodeMap } = useMemo(() => {
    const emptyMap = new Map<string, string>();
    if (!activeProject || decodedAssets.length === 0) {
      return { atlasResult: null, packError: null as string | null, frameNodeMap: emptyMap };
    }

    const frames: AtlasFrameInput[] = [];
    for (let idx = 0; idx < decodedAssets.length; idx++) {
      const asset = decodedAssets[idx]!;
      const nodeSlug = `sprite_${idx}_${asset.node.generationMeta.seed}`;
      const pivot = asset.node.postProcessConfig?.pivotNorm ?? { x: 0.5, y: 0.5 };
      const bakedNorm = includeNormals
        ? bakeNormalMapCpu(asset.rgba, {
            bevelRadiusPx: 12,
            bevelProfile: 'spherical-dome',
            bevelStrength: 2.2,
            detailStrength: 1.0,
            convention: 'opengl',
          })
        : undefined;

      if (selectedStaticIds[asset.node.id]) {
        frames.push({
          id: nodeSlug,
          sprite: asset.rgba,
          normalMap: bakedNorm,
          pivotNorm: pivot,
        });
        emptyMap.set(nodeSlug, asset.node.id);
      }

      if (
        selectedLoopIds[asset.node.id] &&
        asset.node.puppetAnim &&
        asset.node.puppetAnim.pins.length > 0
      ) {
        const anim = asset.node.puppetAnim;
        const mesh = buildAlphaClippedMesh(asset.rgba, { artMode: activeProject.artBible.artMode });
        const stripRes = buildPuppetStripArtifacts(asset.rgba, mesh, nodeSlug, {
          preset: anim.preset,
          mode: anim.mode,
          pins: anim.pins,
          frameCount: anim.frameCount,
          amplitudePx: anim.amplitudePx,
          fps: anim.fps,
          loop: anim.loop,
          pingPong: anim.pingPong,
          paddingPx: anim.paddingPx,
          reLockPolish: anim.reLockPolish,
          artMode: activeProject.artBible.artMode,
          pivotNorm: pivot,
          paletteHex: activeProject.artBible.palette,
          normalMap: bakedNorm,
          normalInvertY: 1,
        });

        const suffix = ANIM_PRESETS[anim.preset].exportSuffix;
        const loopName = `${nodeSlug}_${suffix}`;
        for (let fIdx = 0; fIdx < stripRes.frames.length; fIdx++) {
          const frameBuf = stripRes.frames[fIdx]!;
          let frameNorm: RgbaBuffer | undefined;
          if (stripRes.normalStripBuffer) {
            const fw = frameBuf.width;
            const fh = frameBuf.height;
            const nData = new Uint8ClampedArray(fw * fh * 4);
            for (let y = 0; y < fh; y++) {
              const srcStart = (y * stripRes.normalStripBuffer.width + fIdx * fw) * 4;
              nData.set(
                stripRes.normalStripBuffer.data.subarray(srcStart, srcStart + fw * 4),
                y * fw * 4,
              );
            }
            frameNorm = { width: fw, height: fh, data: nData };
          }
          const frameId = `${loopName}_${fIdx}`;
          frames.push({
            id: frameId,
            sprite: frameBuf,
            normalMap: frameNorm,
            pivotNorm: pivot,
            animationName: loopName,
          });
          emptyMap.set(frameId, asset.node.id);
        }
      }
    }

    if (frames.length === 0) {
      return { atlasResult: null, packError: null as string | null, frameNodeMap: emptyMap };
    }

    try {
      const packed = composeAtlasPages(frames, {
        maxWidth: maxSize,
        maxHeight: maxSize,
        padding,
        extrude,
        powerOfTwo,
        allowRotation: rotationLockedReason !== null ? false : allowRotation,
        disableRotationForEngine: engines.includes('godot') || includeNormals,
      });
      return { atlasResult: packed, packError: null as string | null, frameNodeMap: emptyMap };
    } catch (err) {
      return {
        atlasResult: null,
        packError: err instanceof Error ? err.message : 'Failed to pack selected sprites.',
        frameNodeMap: emptyMap,
      };
    }
  }, [
    activeProject,
    decodedAssets,
    selectedStaticIds,
    selectedLoopIds,
    includeNormals,
    maxSize,
    padding,
    extrude,
    powerOfTwo,
    allowRotation,
    rotationLockedReason,
    engines,
  ]);

  const safePageIndex =
    atlasResult && activePageIndex < atlasResult.pages.length ? activePageIndex : 0;
  const activePage = atlasResult?.pages[safePageIndex] ?? null;
  const isPixelArtMode = activeProject?.artBible.artMode === 'pixel-art';

  // Render live packed preview canvas + optional UV bounds & extrusion overlay
  useEffect(() => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !activePage) return;
    if (canvas.width !== activePage.width) canvas.width = activePage.width;
    if (canvas.height !== activePage.height) canvas.height = activePage.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = !isPixelArtMode;

    const src =
      previewChannel === 'normal' && activePage.normal ? activePage.normal : activePage.albedo;
    ctx.putImageData(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 0, 0);

    if (showOverlay) {
      for (const rect of activePage.rects) {
        const ownerNodeId = frameNodeMap.get(rect.id);
        const isHighlighted = Boolean(highlightedNodeId && ownerNodeId === highlightedNodeId);

        if (extrude > 0) {
          ctx.strokeStyle = 'rgba(245, 158, 11, 0.65)';
          ctx.lineWidth = 1;
          ctx.strokeRect(
            rect.x - extrude + 0.5,
            rect.y - extrude + 0.5,
            rect.width + extrude * 2 - 1,
            rect.height + extrude * 2 - 1,
          );
        }

        if (isHighlighted) {
          ctx.fillStyle = 'rgba(16, 185, 129, 0.16)';
          ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
        }

        ctx.strokeStyle = isHighlighted ? 'rgba(52, 211, 153, 0.98)' : 'rgba(129, 140, 248, 0.85)';
        ctx.lineWidth = isHighlighted ? 2 : 1;
        ctx.strokeRect(rect.x + 0.5, rect.y + 0.5, rect.width - 1, rect.height - 1);
      }
    }
  }, [
    activePage,
    previewChannel,
    showOverlay,
    extrude,
    highlightedNodeId,
    frameNodeMap,
    isPixelArtMode,
  ]);

  const handleCanvasClick = (clientX: number, clientY: number) => {
    const canvas = previewCanvasRef.current;
    if (!canvas || !activePage) return;
    const rect = canvas.getBoundingClientRect();
    const ax = ((clientX - rect.left) / Math.max(1, rect.width)) * activePage.width;
    const ay = ((clientY - rect.top) / Math.max(1, rect.height)) * activePage.height;
    const hit = activePage.rects.find(
      (r) => ax >= r.x && ax <= r.x + r.width && ay >= r.y && ay <= r.y + r.height,
    );
    if (!hit) {
      setHighlightedNodeId(null);
      return;
    }
    const ownerNodeId = frameNodeMap.get(hit.id) ?? null;
    setHighlightedNodeId(ownerNodeId);
  };

  const toggleEngine = (target: AtlasEngineTarget) => {
    setEngines((prev) => {
      if (prev.includes(target)) {
        return prev.length > 1 ? prev.filter((e) => e !== target) : prev;
      }
      return [...prev, target];
    });
  };

  const handleAttachQuickPuppetLoop = async (asset: DecodedNodeAsset) => {
    if (!activeProject) return;
    const w = asset.rgba.width;
    const h = asset.rgba.height;
    const defaultRig = createDefaultPuppetAnimConfig();
    const updatedRig = {
      ...defaultRig,
      preset: 'idle-breathe' as const,
      mode: 'rigid' as const,
      frameCount: 6,
      pins: [
        { id: globalThis.crypto.randomUUID(), x: w * 0.5, y: h * 0.82, role: 'anchor' as const },
        { id: globalThis.crypto.randomUUID(), x: w * 0.5, y: h * 0.52, role: 'driver' as const },
        { id: globalThis.crypto.randomUUID(), x: w * 0.5, y: h * 0.22, role: 'tip' as const },
      ],
    };
    await repository.saveSpriteNode({
      ...asset.node,
      puppetAnim: updatedRig,
    });
    await refreshSpriteNodes(activeProject.id);
    setSelectedLoopIds((prev) => ({ ...prev, [asset.node.id]: true }));
  };

  const handleDownloadAtlasZip = () => {
    if (!activeProject || !atlasResult) return;
    const extraFiles: Record<string, Uint8Array> = {};
    for (let idx = 0; idx < decodedAssets.length; idx++) {
      const asset = decodedAssets[idx]!;
      if (selectedStaticIds[asset.node.id] && asset.node.nineSlice?.enabled) {
        const nodeSlug = `sprite_${idx}_${asset.node.generationMeta.seed}`;
        Object.assign(extraFiles, buildNineSliceExportFiles(nodeSlug, asset.node.nineSlice));
      }
    }
    const zipBytes = packageAtlasZip({
      atlas: atlasResult,
      baseSlug: 'atlas',
      engines,
      artMode: activeProject.artBible.artMode,
      extraFiles,
    });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    const projectSlug = toAssetSlug(activeProject.name);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'application/zip' }),
      `${projectSlug}-atlas.zip`,
    );
    setExportNotice(
      `Exported ${atlasResult.pages.length} page(s), ${atlasResult.frames.length} frame(s) (${atlasResult.deduplicatedCount} deduplicated)`,
    );
  };

  if (!activeProject) {
    return (
      <div className="mx-auto mt-8 max-w-xl rounded-xl border border-slate-800 bg-slate-900 p-6 text-center text-sm text-slate-300">
        Open a project first to pack sprites into game engine atlases.
      </div>
    );
  }

  return (
    <div data-testid="atlas-workshop" className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/80 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <Grid2X2 className="h-4 w-4 text-indigo-400" />
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              MaxRects Atlas Packer &amp; Engine Exporter
            </h2>
            <p className="text-[11px] text-slate-400">
              Project: {activeProject.name} · {activeProject.artBible.artMode}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {atlasResult && activePage && (
            <span
              data-testid="atlas-occupancy-badge"
              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 font-mono text-xs text-emerald-200"
            >
              {activePage.width}×{activePage.height} · {(activePage.occupancy * 100).toFixed(1)}%
              packed · {atlasResult.deduplicatedCount} deduped
            </span>
          )}
          <button
            type="button"
            onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
            className="rounded border border-slate-700 bg-slate-800 px-3 py-1 text-xs text-slate-200 hover:bg-slate-700"
          >
            Back to Studio
          </button>
        </div>
      </div>

      <div className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[290px_minmax(0,1fr)_320px]">
        {/* Left Pane: Sprite & Animation Selector */}
        <aside className="space-y-3 overflow-y-auto border-b border-slate-800 bg-slate-900/50 p-4 lg:border-r lg:border-b-0">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Sprites &amp; Loops ({decodedAssets.length})
            </h3>
            {atlasResult && (
              <span
                data-testid="atlas-dedup-summary"
                className="font-mono text-[10px] text-indigo-300"
              >
                {atlasResult.uniquePackedCount}/{atlasResult.totalInputCount} unique
              </span>
            )}
          </div>

          {decodedAssets.length === 0 && (
            <p className="rounded border border-slate-800 bg-slate-950 p-3 text-xs text-slate-400">
              Generate or import sprites in Sprite Studio first.
            </p>
          )}

          <div className="space-y-2">
            {decodedAssets.map((asset, idx) => {
              const hasRig = Boolean(
                asset.node.puppetAnim && asset.node.puppetAnim.pins.length > 0,
              );
              const isHighlighted = highlightedNodeId === asset.node.id;
              return (
                <div
                  key={asset.node.id}
                  data-testid={`atlas-card-${idx}`}
                  data-highlighted={isHighlighted ? 'true' : 'false'}
                  onClick={() => setHighlightedNodeId(asset.node.id)}
                  className={`space-y-1.5 rounded-lg border p-2.5 text-xs transition-colors ${
                    isHighlighted
                      ? 'border-emerald-400 bg-emerald-950/30 ring-1 ring-emerald-400/50'
                      : 'border-slate-800 bg-slate-950/70'
                  }`}
                >
                  <label className="flex items-center gap-2 font-medium text-slate-200">
                    <input
                      type="checkbox"
                      data-testid={`atlas-item-${idx}`}
                      checked={Boolean(selectedStaticIds[asset.node.id])}
                      onChange={(e) =>
                        setSelectedStaticIds((prev) => ({
                          ...prev,
                          [asset.node.id]: e.target.checked,
                        }))
                      }
                      className="accent-indigo-500"
                    />
                    <span className="truncate">
                      #{idx + 1} {asset.node.kind} · seed {asset.node.generationMeta.seed}
                    </span>
                  </label>

                  {hasRig ? (
                    <label className="flex items-center gap-2 pl-4 text-[11px] text-cyan-300">
                      <input
                        type="checkbox"
                        data-testid={`atlas-loop-${idx}`}
                        checked={Boolean(selectedLoopIds[asset.node.id])}
                        onChange={(e) =>
                          setSelectedLoopIds((prev) => ({
                            ...prev,
                            [asset.node.id]: e.target.checked,
                          }))
                        }
                        className="accent-cyan-500"
                      />
                      <Film className="h-3 w-3" />
                      <span>
                        {asset.node.puppetAnim!.preset} ({asset.node.puppetAnim!.frameCount}f)
                      </span>
                    </label>
                  ) : (
                    <button
                      type="button"
                      data-testid={`atlas-add-loop-${idx}`}
                      onClick={() => void handleAttachQuickPuppetLoop(asset)}
                      className="ml-4 inline-flex items-center gap-1 rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-medium text-cyan-200 hover:bg-cyan-500/20"
                    >
                      <Sparkles className="h-2.5 w-2.5" />
                      Add 6f Puppet Loop
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </aside>

        {/* Center Pane: Packed Atlas Canvas Preview */}
        <section className="flex min-w-0 flex-col bg-slate-950">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
            <div className="flex items-center gap-1.5 text-xs">
              {atlasResult?.pages.map((p) => (
                <button
                  key={p.pageIndex}
                  type="button"
                  data-testid={`atlas-page-${p.pageIndex}`}
                  onClick={() => setActivePageIndex(p.pageIndex)}
                  className={`rounded border px-2.5 py-1 font-mono ${
                    safePageIndex === p.pageIndex
                      ? 'border-indigo-500 bg-indigo-600 text-white'
                      : 'border-slate-700 bg-slate-900 text-slate-300'
                  }`}
                >
                  Page {p.pageIndex + 1}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-2 text-xs">
              <button
                type="button"
                data-testid="atlas-overlay-toggle"
                onClick={() => setShowOverlay(!showOverlay)}
                className={`inline-flex items-center gap-1 rounded border px-2 py-1 ${
                  showOverlay
                    ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                <Eye className="h-3.5 w-3.5" />
                UV Bounds
              </button>

              {includeNormals && (
                <div className="flex overflow-hidden rounded border border-slate-700">
                  <button
                    type="button"
                    data-testid="atlas-channel-albedo"
                    onClick={() => setPreviewChannel('albedo')}
                    className={`px-2 py-1 ${
                      previewChannel === 'albedo'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-900 text-slate-300'
                    }`}
                  >
                    Albedo
                  </button>
                  <button
                    type="button"
                    data-testid="atlas-channel-normal"
                    onClick={() => setPreviewChannel('normal')}
                    className={`px-2 py-1 ${
                      previewChannel === 'normal'
                        ? 'bg-indigo-600 text-white'
                        : 'bg-slate-900 text-slate-300'
                    }`}
                  >
                    Normal Map
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="flex flex-1 items-center justify-center overflow-auto bg-checkerboard p-8">
            {packError ? (
              <div
                data-testid="atlas-error-banner"
                className="max-w-md rounded-lg border border-rose-500/40 bg-rose-950/50 px-4 py-3 text-xs text-rose-200"
              >
                <p className="font-semibold text-rose-100">Atlas Packing Constraint Exceeded</p>
                <p className="mt-1">{packError}</p>
              </div>
            ) : activePage ? (
              (() => {
                const intZoom = isPixelArtMode
                  ? Math.max(
                      1,
                      Math.min(8, Math.floor(420 / Math.max(activePage.width, activePage.height))),
                    )
                  : 1;
                return (
                  <canvas
                    ref={previewCanvasRef}
                    data-testid="atlas-preview-canvas"
                    onClick={(e) => handleCanvasClick(e.clientX, e.clientY)}
                    className="max-h-[520px] max-w-full cursor-pointer rounded border border-slate-700 object-contain shadow-2xl"
                    style={{
                      width: `${activePage.width * intZoom}px`,
                      height: `${activePage.height * intZoom}px`,
                      imageRendering: isPixelArtMode ? 'pixelated' : 'auto',
                    }}
                  />
                );
              })()
            ) : (
              <p data-testid="atlas-empty-state" className="text-xs text-slate-400">
                Select at least one sprite or loop to pack.
              </p>
            )}
          </div>
        </section>

        {/* Right Pane: Engine Targets & Export Controls */}
        <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
          <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
            <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
              <Layers className="h-3.5 w-3.5 text-indigo-400" />
              <span>Target Game Engines</span>
            </div>

            {(
              [
                ['godot', 'Godot 4 (.tres SpriteFrames + AtlasTexture)'],
                ['phaser', 'Phaser 3 (Multiatlas JSON)'],
                ['pixi', 'PixiJS v8 (JSON Hash + Animations)'],
              ] as const
            ).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid={`atlas-engine-${key}`}
                  checked={engines.includes(key)}
                  onChange={() => toggleEngine(key)}
                  className="accent-indigo-500"
                />
                {label}
              </label>
            ))}
          </div>

          <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs">
            <label className="block space-y-1">
              <span className="text-slate-400">Max Atlas Page Size</span>
              <select
                data-testid="atlas-max-size"
                value={maxSize}
                onChange={(e) => setMaxSize(Number.parseInt(e.target.value, 10))}
                className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
              >
                <option value={512}>512×512</option>
                <option value={1024}>1024×1024</option>
                <option value={2048}>2048×2048</option>
                <option value={4096}>4096×4096</option>
              </select>
            </label>

            <div className="grid grid-cols-2 gap-2">
              <label className="space-y-1">
                <span className="text-slate-400">Padding (px)</span>
                <input
                  type="number"
                  data-testid="atlas-padding"
                  min={0}
                  max={8}
                  value={padding}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v) && v >= 0 && v <= 8) setPadding(v);
                  }}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                />
              </label>
              <label className="space-y-1">
                <span className="text-slate-400">Extrude (px)</span>
                <input
                  type="number"
                  data-testid="atlas-extrude"
                  min={0}
                  max={2}
                  value={extrude}
                  onChange={(e) => {
                    const v = Number.parseInt(e.target.value, 10);
                    if (!Number.isNaN(v) && v >= 0 && v <= 2) setExtrude(v);
                  }}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                />
              </label>
            </div>

            <label className="flex items-center gap-2 text-slate-200">
              <input
                type="checkbox"
                data-testid="atlas-pot-toggle"
                checked={powerOfTwo}
                onChange={(e) => setPowerOfTwo(e.target.checked)}
                className="accent-indigo-500"
              />
              Shrink to Power-of-Two (PoT)
            </label>

            <label
              className="flex items-center gap-2 text-slate-200"
              title={rotationLockedReason ?? 'Allow 90° CW bin packing rotation'}
            >
              <input
                type="checkbox"
                data-testid="atlas-rotation-toggle"
                disabled={rotationLockedReason !== null}
                checked={rotationLockedReason ? false : allowRotation}
                onChange={(e) => setAllowRotation(e.target.checked)}
                className="accent-indigo-500"
              />
              Allow 90° Rotation {rotationLockedReason ? '(Locked Off)' : ''}
            </label>

            <label className="flex items-center gap-2 text-slate-200">
              <input
                type="checkbox"
                data-testid="atlas-normal-toggle"
                checked={includeNormals}
                onChange={(e) => setIncludeNormals(e.target.checked)}
                className="accent-indigo-500"
              />
              Bundle Lockstep `_n.png` Normal Atlas
            </label>
          </div>

          <button
            type="button"
            data-testid="download-atlas-zip-btn"
            disabled={!atlasResult}
            onClick={handleDownloadAtlasZip}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2.5 text-xs font-semibold text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-4 w-4" />
            Download Atlas ZIP
          </button>

          {exportNotice && (
            <p data-testid="atlas-export-notice" className="text-[11px] text-emerald-300">
              {exportNotice}
            </p>
          )}
        </aside>
      </div>
    </div>
  );
}
