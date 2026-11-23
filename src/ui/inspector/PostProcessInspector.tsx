import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ArrowLeft,
  Crosshair,
  Download,
  Eraser,
  FileArchive,
  FolderOutput,
  Gamepad2,
  Grid3X3,
  Palette,
  Sliders,
  Sparkles,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { strToU8 } from 'fflate';
import { repository } from '../../db/database';
import {
  createDefaultNineSliceConfig,
  createDefaultNormalMapConfig,
  createDefaultPaletteLutConfig,
  createDefaultPostProcessConfig,
  createDefaultPuppetAnimConfig,
  createDefaultSeamlessTileConfig,
  type BackgroundRemovalMode,
  type CollisionLayerShape,
  type DemixelMode,
  type ErosionConnectivity,
  type Lighting,
  type NineSliceConfig,
  type NormalMapConfig,
  type PaletteLutConfig,
  type PostProcessConfig,
  type PuppetAnimConfig,
  type ResampleMode,
  type SeamlessTileConfig,
  type SelOutMode,
  type SpriteNode,
} from '../../domain/schemas';
import { buildColliderExportFiles } from '../../export/colliderExporters';
import { exportBundleToDirectory, supportsFileSystemAccess } from '../../export/fsAccess';
import { buildNineSliceExportFiles } from '../../export/nineSliceExporters';
import { buildAssetRecipe, computePivotPx } from '../../export/recipeBuilder';
import { packageSpriteZip, toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { parseHexRgb } from '../../processing/backgroundKey';
import type { DetectedGrid } from '../../processing/demixel';
import { bakeNormalMapCpu } from '../../processing/distanceField';
import type { PaletteVariant } from '../../processing/paletteLut';
import { runPostProcessPipeline } from '../../processing/pipeline';
import { decodePngBytesToRgba, encodeRgbaToPngBytes, rgbaToPngBlob } from '../../processing/png';
import { computeArtBibleHash } from '../../processing/projectAudit';
import { buildAlphaClippedMesh } from '../../processing/spriteMesh';
import type { RgbaBuffer } from '../../processing/types';
import { useAppStore, type InspectorTab } from '../../store/useAppStore';
import { buildPuppetStripArtifacts } from '../../webgl/puppetRenderer';
import {
  createMonotonicRequestGuard,
  runPostProcessInWorker,
} from '../../workers/postprocessClient';
import { ColliderEditor } from './ColliderEditor';
import { GameSandbox } from './GameSandbox';
import { NormalMapPreview } from './NormalMapPreview';
import { PaletteLutWorkshop } from './PaletteLutWorkshop';
import { PuppetWarpEditor } from './PuppetWarpEditor';
import { TileAndSliceWorkshop } from './TileAndSliceWorkshop';

export type InspectorBackdrop = 'checkerboard' | 'dark' | 'light' | 'game-green';

interface DecodedImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

async function decodeBlobFlexible(blob: Blob): Promise<DecodedImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return await decodePngBytesToRgba(bytes);
  } catch {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        rgba: new Uint8ClampedArray(data.data),
        width: bitmap.width,
        height: bitmap.height,
      };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function paletteVariantsFromNode(node?: SpriteNode): PaletteVariant[] {
  const saved = node?.paletteLut?.variants;
  if (!saved || saved.length === 0) return [];
  return saved.map((v) => ({
    id: v.id,
    name: v.name,
    rampTransforms: v.rampTransforms,
    overrides: Object.fromEntries(
      Object.entries(v.overrides).map(([k, hex]) => [Number(k), parseHexRgb(hex)]),
    ),
  }));
}

function rgbToUpperHex(r: number, g: number, b: number): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return `#${h(r)}${h(g)}${h(b)}`;
}

function paletteVariantsToConfig(
  variants: readonly PaletteVariant[],
  prev?: PaletteLutConfig,
): PaletteLutConfig {
  const base = prev ?? createDefaultPaletteLutConfig();
  return {
    ...base,
    variantCount: Math.max(1, variants.length + 1),
    variants: variants.map((v) => ({
      id: v.id,
      name: v.name,
      rampTransforms: [...v.rampTransforms],
      overrides: Object.fromEntries(
        Object.entries(v.overrides).map(([k, rgb]) => [k, rgbToUpperHex(rgb.r, rgb.g, rgb.b)]),
      ),
    })),
  };
}

export function PostProcessInspector({
  nodeId,
  initialTab,
}: {
  nodeId: string;
  initialTab?: InspectorTab;
}) {
  const { activeProject, spriteNodes, refreshSpriteNodes, navigate } = useAppStore();

  const targetNode: SpriteNode | undefined =
    spriteNodes.find((n) => n.id === nodeId) ?? spriteNodes[spriteNodes.length - 1];

  const [config, setConfig] = useState<PostProcessConfig>(
    () =>
      targetNode?.postProcessConfig ??
      createDefaultPostProcessConfig(
        activeProject?.artBible.targetWidth ?? 64,
        activeProject?.artBible.targetHeight ?? 64,
      ),
  );
  const [rawSize, setRawSize] = useState({ width: 128, height: 128 });
  const [rawLoadRev, setRawLoadRev] = useState(0);
  const [processedSize, setProcessedSize] = useState({ width: 128, height: 128 });
  const [splitPercent, setSplitPercent] = useState(50);
  const [zoomPercent, setZoomPercent] = useState(300);
  const [showPixelGrid, setShowPixelGrid] = useState(true);
  const [backdrop, setBackdrop] = useState<InspectorBackdrop>('checkerboard');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ phase: string; progress: number } | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [pivotPlaceMode, setPivotPlaceMode] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(initialTab ?? 'postprocess');
  const [normalConfig, setNormalConfig] = useState<NormalMapConfig>(() =>
    createDefaultNormalMapConfig(),
  );
  const [puppetConfig, setPuppetConfig] = useState<PuppetAnimConfig>(
    () => targetNode?.puppetAnim ?? createDefaultPuppetAnimConfig(),
  );
  const [seamlessConfig, setSeamlessConfig] = useState<SeamlessTileConfig>(
    () => targetNode?.seamlessTile ?? createDefaultSeamlessTileConfig(),
  );
  const [nineSliceConfig, setNineSliceConfig] = useState<NineSliceConfig>(
    () => targetNode?.nineSlice ?? createDefaultNineSliceConfig(),
  );
  const [lutVariants, setLutVariants] = useState<PaletteVariant[]>(() =>
    paletteVariantsFromNode(targetNode),
  );
  const [collisionShapes, setCollisionShapes] = useState<CollisionLayerShape[]>(
    () => targetNode?.collisionShapes ?? [],
  );
  const [activeSpriteBuffer, setActiveSpriteBuffer] = useState<RgbaBuffer | null>(null);
  const bakedNormalRef = useRef<{ buffer: RgbaBuffer; key: string } | null>(null);
  const [foundryStats, setFoundryStats] = useState<{
    detectedGrid?: DetectedGrid;
    orphanStats?: { removedIslands: number; cleanedSpecks: number };
  }>({});

  const rawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const processedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const comparatorRef = useRef<HTMLDivElement | null>(null);
  const draggingSplitRef = useRef(false);
  const requestGuardRef = useRef(createMonotonicRequestGuard());

  useEffect(() => {
    const guard = requestGuardRef.current;
    return () => {
      guard.invalidate();
    };
  }, []);

  const rawImageRef = useRef<DecodedImage | null>(null);
  const processedArtifactRef = useRef<{
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
    pngBytes: Uint8Array;
    pipelineKey: string;
  } | null>(null);
  const latestNodeRef = useRef<SpriteNode | undefined>(targetNode);
  latestNodeRef.current = targetNode;
  const targetNodeId = targetNode?.id;
  const targetImageBlobId = targetNode?.imageBlobId;

  const pipelineKey = useMemo(
    () =>
      JSON.stringify({
        ...config,
        pivotNorm: undefined,
      }),
    [config],
  );
  const latestConfigRef = useRef(config);
  latestConfigRef.current = config;
  const latestPuppetRef = useRef(puppetConfig);
  latestPuppetRef.current = puppetConfig;
  const latestSeamlessRef = useRef(seamlessConfig);
  latestSeamlessRef.current = seamlessConfig;
  const latestNineSliceRef = useRef(nineSliceConfig);
  latestNineSliceRef.current = nineSliceConfig;
  const latestLutVariantsRef = useRef(lutVariants);
  latestLutVariantsRef.current = lutVariants;
  const latestCollisionShapesRef = useRef(collisionShapes);
  latestCollisionShapesRef.current = collisionShapes;

  useEffect(() => {
    if (initialTab) {
      setInspectorTab(initialTab);
    }
  }, [initialTab]);

  // Sync initial config when node changes
  useEffect(() => {
    const node = latestNodeRef.current;
    if (!targetNodeId || !node || !activeProject) return;
    setConfig(
      node.postProcessConfig ??
        createDefaultPostProcessConfig(
          activeProject.artBible.targetWidth,
          activeProject.artBible.targetHeight,
        ),
    );
    setPuppetConfig(node.puppetAnim ?? createDefaultPuppetAnimConfig());
    setSeamlessConfig(node.seamlessTile ?? createDefaultSeamlessTileConfig());
    setNineSliceConfig(node.nineSlice ?? createDefaultNineSliceConfig());
    setLutVariants(paletteVariantsFromNode(node));
    setCollisionShapes(node.collisionShapes ?? []);
  }, [targetNodeId, activeProject]);

  // Persist puppet animation / 9-slice panel / LUT / collision metadata onto SpriteNode in Dexie for reloads & Screen 4F
  useEffect(() => {
    const nodeSnapshot = latestNodeRef.current;
    if (!activeProject || !targetNodeId || !nodeSnapshot) return;
    const puppetChanged =
      JSON.stringify(nodeSnapshot.puppetAnim ?? createDefaultPuppetAnimConfig()) !==
      JSON.stringify(puppetConfig);
    const sliceChanged =
      nineSliceConfig.enabled &&
      JSON.stringify(nodeSnapshot.nineSlice ?? createDefaultNineSliceConfig()) !==
        JSON.stringify(nineSliceConfig);
    const nextLutConfig =
      lutVariants.length > 0
        ? paletteVariantsToConfig(lutVariants, nodeSnapshot.paletteLut)
        : undefined;
    const lutChanged =
      lutVariants.length > 0 &&
      JSON.stringify(nodeSnapshot.paletteLut ?? null) !== JSON.stringify(nextLutConfig);
    const collisionChanged =
      JSON.stringify(nodeSnapshot.collisionShapes ?? []) !== JSON.stringify(collisionShapes);
    if (!puppetChanged && !sliceChanged && !lutChanged && !collisionChanged) {
      return;
    }
    const timer = window.setTimeout(() => {
      const currentNode = latestNodeRef.current;
      if (!currentNode || currentNode.id !== targetNodeId) return;
      const persistedLut =
        latestLutVariantsRef.current.length > 0
          ? paletteVariantsToConfig(latestLutVariantsRef.current, currentNode.paletteLut)
          : currentNode.paletteLut;
      void repository
        .saveSpriteNode({
          ...currentNode,
          puppetAnim: latestPuppetRef.current,
          ...(latestNineSliceRef.current.enabled ? { nineSlice: latestNineSliceRef.current } : {}),
          ...(persistedLut ? { paletteLut: persistedLut } : {}),
          ...(latestCollisionShapesRef.current.length > 0
            ? { collisionShapes: latestCollisionShapesRef.current }
            : { collisionShapes: [] }),
        })
        .then(() => refreshSpriteNodes(activeProject.id));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    puppetConfig,
    nineSliceConfig,
    lutVariants,
    collisionShapes,
    activeProject,
    targetNodeId,
    refreshSpriteNodes,
  ]);

  const drawCanvasBuffer = useCallback(
    (canvas: HTMLCanvasElement | null, rgba: Uint8ClampedArray, width: number, height: number) => {
      if (!canvas) return;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.imageSmoothingEnabled = activeProject?.artBible.artMode === 'hd-2d';
      ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    },
    [activeProject?.artBible.artMode],
  );

  // Load raw source image from Dexie when targetNode changes
  useEffect(() => {
    if (!targetNodeId || !targetImageBlobId) return;
    let cancelled = false;

    void repository.getBlob(targetImageBlobId).then(async (blobRecord) => {
      if (cancelled || !blobRecord) return;
      const decoded = await decodeBlobFlexible(blobRecord.bytes);
      if (cancelled) return;
      rawImageRef.current = decoded;
      setRawSize({ width: decoded.width, height: decoded.height });
      setRawLoadRev((rev) => rev + 1);
      setActiveSpriteBuffer({ width: decoded.width, height: decoded.height, data: decoded.rgba });
      drawCanvasBuffer(rawCanvasRef.current, decoded.rgba, decoded.width, decoded.height);
    });

    return () => {
      cancelled = true;
    };
  }, [targetNodeId, targetImageBlobId, drawCanvasBuffer]);

  // Execute post-processing pipeline in Dedicated Worker whenever pixel pipeline params change
  useEffect(() => {
    if (!activeProject || !targetNodeId) return;
    let cancelled = false;
    const guard = requestGuardRef.current;
    const startedProjectId = activeProject.id;

    const timer = window.setTimeout(() => {
      const raw = rawImageRef.current;
      if (!raw || cancelled) return;

      const token = guard.next();
      const activeConfig = latestConfigRef.current;
      setIsProcessing(true);
      setWorkerError(null);
      if (activeConfig.bgRemoval !== 'ai-rembg') {
        setAiProgress(null);
      }

      void runPostProcessInWorker({
        rgba: raw.rgba,
        width: raw.width,
        height: raw.height,
        config: activeConfig,
        paletteHex: activeProject.artBible.palette,
        onProgress: (phase, progress) => {
          if (!cancelled && guard.isCurrent(token)) {
            setAiProgress({ phase, progress });
          }
        },
      })
        .then(async (result) => {
          if (cancelled || !guard.isCurrent(token)) return;
          processedArtifactRef.current = {
            rgba: result.rgba,
            width: result.width,
            height: result.height,
            pngBytes: result.pngBytes,
            pipelineKey,
          };
          setProcessedSize({ width: result.width, height: result.height });
          setActiveSpriteBuffer({ width: result.width, height: result.height, data: result.rgba });
          setFoundryStats({
            detectedGrid: result.detectedGrid,
            orphanStats: result.orphanStats,
          });
          drawCanvasBuffer(processedCanvasRef.current, result.rgba, result.width, result.height);
          setAiProgress(null);

          const nodeSnapshot = latestNodeRef.current;
          if (!nodeSnapshot || nodeSnapshot.id !== targetNodeId) {
            setIsProcessing(false);
            return;
          }
          const processedBlob = rgbaToPngBlob(result.rgba, result.width, result.height);
          const stored = await repository.storeBlob(processedBlob, 'image/png');
          if (
            cancelled ||
            !guard.isCurrent(token) ||
            useAppStore.getState().activeProject?.id !== startedProjectId
          ) {
            await repository.cleanupOrphanedBlobs();
            if (!cancelled && guard.isCurrent(token)) {
              setIsProcessing(false);
            }
            return;
          }
          await repository.saveSpriteNode({
            ...nodeSnapshot,
            processedBlobId: stored.id,
            postProcessConfig: latestConfigRef.current,
            puppetAnim: latestPuppetRef.current,
            recipeArtBibleHash: computeArtBibleHash(activeProject.artBible),
            ...(latestSeamlessRef.current.isSeamlessTile
              ? { seamlessTile: latestSeamlessRef.current }
              : {}),
            ...(latestNineSliceRef.current.enabled
              ? { nineSlice: latestNineSliceRef.current }
              : {}),
            ...(latestLutVariantsRef.current.length > 0
              ? {
                  paletteLut: paletteVariantsToConfig(
                    latestLutVariantsRef.current,
                    nodeSnapshot.paletteLut,
                  ),
                }
              : {}),
            ...(latestCollisionShapesRef.current.length > 0
              ? { collisionShapes: latestCollisionShapesRef.current }
              : {}),
          });
          await repository.cleanupOrphanedBlobs();
          if (
            !cancelled &&
            guard.isCurrent(token) &&
            useAppStore.getState().activeProject?.id === startedProjectId
          ) {
            await refreshSpriteNodes(startedProjectId);
          }
          if (!cancelled && guard.isCurrent(token)) {
            setIsProcessing(false);
          }
        })
        .catch((error: unknown) => {
          if (cancelled || !guard.isCurrent(token)) return;
          setWorkerError(
            error instanceof Error ? error.message : 'Post-processing pipeline failed.',
          );
          setAiProgress(null);
          setIsProcessing(false);
        });
    }, 60);

    return () => {
      cancelled = true;
      guard.invalidate();
      window.clearTimeout(timer);
    };
  }, [
    pipelineKey,
    rawSize.width,
    rawSize.height,
    rawLoadRev,
    activeProject,
    targetNodeId,
    drawCanvasBuffer,
    refreshSpriteNodes,
  ]);

  // Persist pivot changes immediately without re-running pixel post-processing
  useEffect(() => {
    const nodeSnapshot = latestNodeRef.current;
    if (!activeProject || !targetNodeId || !nodeSnapshot) return;
    if (
      nodeSnapshot.postProcessConfig &&
      nodeSnapshot.postProcessConfig.pivotNorm.x === config.pivotNorm.x &&
      nodeSnapshot.postProcessConfig.pivotNorm.y === config.pivotNorm.y
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      const currentNode = latestNodeRef.current;
      if (!currentNode) return;
      void repository.saveSpriteNode({
        ...currentNode,
        postProcessConfig: latestConfigRef.current,
      });
    }, 80);
    return () => window.clearTimeout(timer);
  }, [config.pivotNorm.x, config.pivotNorm.y, activeProject, targetNodeId]);

  const updateSplitFromClientX = (clientX: number) => {
    const el = comparatorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const pct = ((clientX - rect.left) / Math.max(1, rect.width)) * 100;
    setSplitPercent(Math.max(0, Math.min(100, Math.round(pct))));
  };

  const updatePivotFromClient = (clientX: number, clientY: number) => {
    const el = comparatorRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const normX = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const normY = Math.max(0, Math.min(1, (clientY - rect.top) / Math.max(1, rect.height)));
    const pxX = Math.round(normX * processedSize.width);
    const pxY = Math.round(normY * processedSize.height);
    setConfig((prev) => ({
      ...prev,
      pivotNorm: {
        x: Number((pxX / Math.max(1, processedSize.width)).toFixed(4)),
        y: Number((pxY / Math.max(1, processedSize.height)).toFixed(4)),
      },
    }));
  };

  const handleSplitPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    draggingSplitRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pivotPlaceMode) {
      updatePivotFromClient(e.clientX, e.clientY);
    } else {
      updateSplitFromClientX(e.clientX);
    }
  };

  const handleSplitPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingSplitRef.current) return;
    if (pivotPlaceMode) {
      updatePivotFromClient(e.clientX, e.clientY);
    } else {
      updateSplitFromClientX(e.clientX);
    }
  };

  const handleSplitPointerUp = () => {
    draggingSplitRef.current = false;
  };

  const getExportArtifact = () => {
    if (!activeProject || !targetNode) {
      throw new Error('No active project or node available to export.');
    }
    const cached = processedArtifactRef.current;
    if (cached && cached.pipelineKey === pipelineKey) {
      return cached;
    }
    const raw = rawImageRef.current;
    if (!raw) {
      throw new Error('Source sprite image is still loading.');
    }
    const effective =
      config.bgRemoval === 'ai-rembg' ? { ...config, bgRemoval: 'none' as const } : config;
    const res = runPostProcessPipeline(
      raw.rgba,
      raw.width,
      raw.height,
      effective,
      activeProject.artBible.palette,
    );
    const pngBytes = encodeRgbaToPngBytes(res.rgba, res.width, res.height);
    const artifact = {
      rgba: res.rgba,
      width: res.width,
      height: res.height,
      pngBytes,
      pipelineKey,
    };
    processedArtifactRef.current = artifact;
    return artifact;
  };

  const getNormalExportBytes = (artifact: {
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
  }): Uint8Array | undefined => {
    if (!normalConfig.enabled) return undefined;
    const expectedKey = `${targetNodeId ?? ''}:${pipelineKey}:${normalConfig.bevelRadiusPx}:${normalConfig.bevelProfile}:${normalConfig.bevelStrength}:${normalConfig.detailStrength}:${normalConfig.convention}:${seamlessConfig.isSeamlessTile ? 'repeat' : 'clamp'}`;
    if (
      bakedNormalRef.current &&
      bakedNormalRef.current.key === expectedKey &&
      bakedNormalRef.current.buffer.width === artifact.width &&
      bakedNormalRef.current.buffer.height === artifact.height
    ) {
      return encodeRgbaToPngBytes(
        bakedNormalRef.current.buffer.data,
        bakedNormalRef.current.buffer.width,
        bakedNormalRef.current.buffer.height,
      );
    }
    const cpuNormal = bakeNormalMapCpu(
      { width: artifact.width, height: artifact.height, data: artifact.rgba },
      {
        bevelRadiusPx: normalConfig.bevelRadiusPx,
        bevelProfile: normalConfig.bevelProfile,
        bevelStrength: seamlessConfig.isSeamlessTile ? 0 : normalConfig.bevelStrength,
        detailStrength: normalConfig.detailStrength,
        convention: normalConfig.convention,
        seamlessWrap: seamlessConfig.isSeamlessTile,
      },
    );
    return encodeRgbaToPngBytes(cpuNormal.data, cpuNormal.width, cpuNormal.height);
  };

  const buildCurrentRecipeAndSlug = () => {
    if (!activeProject || !targetNode) {
      throw new Error('No active project or node available to export.');
    }
    const artifact = getExportArtifact();
    const slug = toAssetSlug(
      `${activeProject.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`,
    );
    const normalPngBytes = getNormalExportBytes(artifact);
    const extraFiles: Record<string, Uint8Array> = {};
    let puppetMeta:
      (PuppetAnimConfig & { stripFilename: string; atlasJsonFilename: string }) | undefined;

    if (puppetConfig.pins.length > 0) {
      const spriteBuf: RgbaBuffer = {
        width: artifact.width,
        height: artifact.height,
        data: artifact.rgba,
      };
      const mesh = buildAlphaClippedMesh(spriteBuf, { artMode: activeProject.artBible.artMode });
      const normalBuf = normalConfig.enabled
        ? bakeNormalMapCpu(spriteBuf, {
            bevelRadiusPx: normalConfig.bevelRadiusPx,
            bevelProfile: normalConfig.bevelProfile,
            bevelStrength: normalConfig.bevelStrength,
            detailStrength: normalConfig.detailStrength,
            convention: normalConfig.convention,
          })
        : undefined;
      const stripRes = buildPuppetStripArtifacts(spriteBuf, mesh, slug, {
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
        artMode: activeProject.artBible.artMode,
        pivotNorm: config.pivotNorm,
        paletteHex: activeProject.artBible.palette,
        normalMap: normalBuf,
        normalInvertY: normalConfig.convention === 'opengl' ? 1 : -1,
      });

      const stripFilename = `${slug}_${stripRes.stripFilenameSuffix}`;
      const atlasJsonFilename = `${slug}_${stripRes.jsonFilenameSuffix}`;
      extraFiles[stripFilename] = encodeRgbaToPngBytes(
        stripRes.stripBuffer.data,
        stripRes.stripBuffer.width,
        stripRes.stripBuffer.height,
      );
      extraFiles[atlasJsonFilename] = strToU8(stripRes.atlasJson);
      if (stripRes.normalStripBuffer) {
        extraFiles[`${stripFilename.replace(/_strip\.png$/, '_n_strip.png')}`] =
          encodeRgbaToPngBytes(
            stripRes.normalStripBuffer.data,
            stripRes.normalStripBuffer.width,
            stripRes.normalStripBuffer.height,
          );
      }
      puppetMeta = {
        ...puppetConfig,
        stripFilename,
        atlasJsonFilename,
      };
    }

    if (nineSliceConfig.enabled) {
      Object.assign(extraFiles, buildNineSliceExportFiles(slug, nineSliceConfig));
    }

    if (collisionShapes.length > 0) {
      Object.assign(extraFiles, buildColliderExportFiles(slug, collisionShapes));
    }

    const recipe = buildAssetRecipe({
      project: activeProject,
      node: targetNode,
      postProcess: config,
      filename: `${slug}.png`,
      outputWidth: artifact.width,
      outputHeight: artifact.height,
      normalizedWidth: rawSize.width,
      normalizedHeight: rawSize.height,
      ...(normalConfig.enabled
        ? { normalMap: { ...normalConfig, filename: `${slug}_n.png` } }
        : {}),
      ...(puppetMeta ? { puppetAnim: puppetMeta } : {}),
      ...(seamlessConfig.isSeamlessTile || targetNode.seamlessTile?.isSeamlessTile
        ? { seamlessTile: seamlessConfig.isSeamlessTile ? seamlessConfig : targetNode.seamlessTile }
        : {}),
      ...(nineSliceConfig.enabled || targetNode.nineSlice?.enabled
        ? { nineSlice: nineSliceConfig.enabled ? nineSliceConfig : targetNode.nineSlice }
        : {}),
      ...(collisionShapes.length > 0 ? { collisionShapes } : {}),
      recipeArtBibleHash: computeArtBibleHash(activeProject.artBible),
    });
    return { artifact, slug, recipe, normalPngBytes, extraFiles };
  };

  const handleDownloadPng = () => {
    try {
      const { artifact, slug } = buildCurrentRecipeAndSlug();
      const copy = new Uint8Array(artifact.pngBytes.byteLength);
      copy.set(artifact.pngBytes);
      triggerBlobDownload(new Blob([copy.buffer], { type: 'image/png' }), `${slug}.png`);
      setExportNotice(`Downloaded ${slug}.png (${artifact.width}×${artifact.height})`);
    } catch (error) {
      setExportNotice(error instanceof Error ? error.message : 'Failed to download PNG.');
    }
  };

  const handleDownloadZip = () => {
    try {
      const { slug, recipe, artifact, normalPngBytes, extraFiles } = buildCurrentRecipeAndSlug();
      const zipBytes = packageSpriteZip({
        slug,
        pngBytes: artifact.pngBytes,
        recipe,
        normalPngBytes,
        extraFiles,
      });
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      triggerBlobDownload(new Blob([copy.buffer], { type: 'application/zip' }), `${slug}.zip`);
      setExportNotice(
        `Downloaded ${slug}.zip (${slug}.png${normalPngBytes ? ` + ${slug}_n.png` : ''}${Object.keys(extraFiles).length > 0 ? ' + puppet strip' : ''} + ${slug}.recipe.json)`,
      );
    } catch (error) {
      setExportNotice(error instanceof Error ? error.message : 'Failed to build ZIP bundle.');
    }
  };

  const handleExportLocalFolder = async () => {
    try {
      const { artifact, slug, recipe, normalPngBytes, extraFiles } = buildCurrentRecipeAndSlug();
      const { directoryName } = await exportBundleToDirectory({
        slug,
        pngBytes: artifact.pngBytes,
        recipe,
        normalPngBytes,
        extraFiles,
      });
      setExportNotice(
        `Wrote ${slug}.png${normalPngBytes ? ` + ${slug}_n.png` : ''} + ${slug}.recipe.json to "${directoryName}"`,
      );
    } catch (error) {
      setExportNotice(error instanceof Error ? error.message : 'Folder export failed.');
    }
  };

  const handleNormalBufferBaked = useCallback(
    (normalBuf: RgbaBuffer) => {
      const key = `${targetNodeId ?? ''}:${pipelineKey}:${normalConfig.bevelRadiusPx}:${normalConfig.bevelProfile}:${normalConfig.bevelStrength}:${normalConfig.detailStrength}:${normalConfig.convention}:${seamlessConfig.isSeamlessTile ? 'repeat' : 'clamp'}`;
      bakedNormalRef.current = { buffer: normalBuf, key };
    },
    [
      targetNodeId,
      pipelineKey,
      normalConfig.bevelRadiusPx,
      normalConfig.bevelProfile,
      normalConfig.bevelStrength,
      normalConfig.detailStrength,
      normalConfig.convention,
      seamlessConfig.isSeamlessTile,
    ],
  );

  const handleSeamlessNodeCommitted = useCallback(
    async (newNode: SpriteNode, unwrappedBuffer: RgbaBuffer, updatedConfig: SeamlessTileConfig) => {
      if (!activeProject) return;
      setSeamlessConfig(updatedConfig);
      rawImageRef.current = {
        rgba: unwrappedBuffer.data,
        width: unwrappedBuffer.width,
        height: unwrappedBuffer.height,
      };
      const cleanPost = createDefaultPostProcessConfig(
        unwrappedBuffer.width,
        unwrappedBuffer.height,
      );
      setConfig(cleanPost);
      const cleanKey = JSON.stringify({ ...cleanPost, pivotNorm: undefined });
      processedArtifactRef.current = {
        rgba: unwrappedBuffer.data,
        width: unwrappedBuffer.width,
        height: unwrappedBuffer.height,
        pngBytes: encodeRgbaToPngBytes(
          unwrappedBuffer.data,
          unwrappedBuffer.width,
          unwrappedBuffer.height,
        ),
        pipelineKey: cleanKey,
      };
      setRawSize({ width: unwrappedBuffer.width, height: unwrappedBuffer.height });
      setProcessedSize({ width: unwrappedBuffer.width, height: unwrappedBuffer.height });
      setActiveSpriteBuffer(unwrappedBuffer);
      await repository.saveSpriteNode({
        ...newNode,
        postProcessConfig: cleanPost,
        seamlessTile: updatedConfig,
      });
      await refreshSpriteNodes(activeProject.id);
      await navigate({ screen: 'inspector', projectId: activeProject.id, nodeId: newNode.id });
    },
    [activeProject, refreshSpriteNodes, navigate],
  );

  if (!activeProject || !targetNode) {
    return (
      <div className="mx-auto mt-8 max-w-2xl rounded-xl border border-slate-800 bg-slate-900 p-6 text-center">
        <p className="text-sm text-slate-300">No sprite node selected for post-processing.</p>
        {activeProject && (
          <button
            type="button"
            onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
            className="mt-4 rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white"
          >
            Back to Sprite Studio
          </button>
        )}
      </div>
    );
  }

  const stageW = Math.max(1, Math.round(processedSize.width * (zoomPercent / 100)));
  const stageH = Math.max(1, Math.round(processedSize.height * (zoomPercent / 100)));
  const inspectorImageRendering =
    activeProject.artBible.artMode === 'pixel-art' ? 'pixelated' : 'auto';
  const pivotPx = computePivotPx(config.pivotNorm, processedSize.width, processedSize.height);
  const fsaSupported = supportsFileSystemAccess();

  const backdropStyle = backdrop === 'game-green' ? { backgroundColor: '#2D5A27' } : undefined;
  const backdropClass =
    backdrop === 'checkerboard'
      ? 'bg-checkerboard'
      : backdrop === 'dark'
        ? 'bg-slate-950'
        : backdrop === 'light'
          ? 'bg-slate-100'
          : '';

  const exportBarNode = (
    <div
      data-testid="export-bar"
      className="space-y-2.5 rounded-lg border border-indigo-500/30 bg-indigo-950/20 p-3.5"
    >
      <h4 className="text-xs font-semibold tracking-wider text-indigo-200 uppercase">
        Export Bundle
      </h4>
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="download-png-btn"
          onClick={handleDownloadPng}
          className="inline-flex items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-2 text-xs font-medium text-slate-100 hover:bg-slate-700"
        >
          <Download className="h-3.5 w-3.5" />
          Download PNG
        </button>
        <button
          type="button"
          data-testid="download-zip-btn"
          onClick={handleDownloadZip}
          className="inline-flex items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-2.5 py-2 text-xs font-semibold text-white hover:bg-indigo-500"
        >
          <FileArchive className="h-3.5 w-3.5" />
          Download ZIP
        </button>
      </div>

      <button
        type="button"
        data-testid="export-folder-btn"
        disabled={!fsaSupported}
        onClick={() => void handleExportLocalFolder()}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <FolderOutput className="h-3.5 w-3.5" />
        {fsaSupported ? 'Export to Local Folder' : 'Export to Local Folder (Chrome/Edge Only)'}
      </button>

      {exportNotice && (
        <p data-testid="export-notice" className="text-[11px] text-emerald-300">
          {exportNotice}
        </p>
      )}
    </div>
  );

  return (
    <div
      data-testid="postprocess-inspector"
      data-recipe-synced={String(Boolean(targetNode.recipeArtBibleHash))}
      className="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/80 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="back-to-studio-btn"
            onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Sprite Studio
          </button>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Post-Process & Export Inspector
            </h2>
            <p className="text-[11px] text-slate-400">
              Node {targetNode.kind} · seed #{targetNode.generationMeta.seed}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex overflow-hidden rounded-md border border-slate-700 bg-slate-950 p-0.5 text-xs">
            <button
              type="button"
              data-testid="inspector-tab-postprocess"
              onClick={() => setInspectorTab('postprocess')}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                inspectorTab === 'postprocess'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Post-Process
            </button>
            <button
              type="button"
              data-testid="inspector-tab-normal"
              onClick={() => {
                setInspectorTab('normal');
                setNormalConfig((prev) => ({ ...prev, enabled: true }));
              }}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                inspectorTab === 'normal'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              2D Lighting &amp; Normal Map
            </button>
            <button
              type="button"
              data-testid="inspector-tab-puppet"
              onClick={() => setInspectorTab('puppet')}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                inspectorTab === 'puppet'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Puppet Warp Animator
            </button>
            <button
              type="button"
              data-testid="inspector-tab-tile-slice"
              onClick={() => setInspectorTab('tile-slice')}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                inspectorTab === 'tile-slice'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Tile &amp; 9-Slice
            </button>
            <button
              type="button"
              data-testid="inspector-tab-palette-lut"
              onClick={() => setInspectorTab('palette-lut')}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                inspectorTab === 'palette-lut'
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Palette-Swap &amp; LUT
            </button>
            <button
              type="button"
              data-testid="inspector-tab-collider"
              onClick={() => setInspectorTab('collider')}
              className={`rounded px-2.5 py-1 font-medium transition-colors ${
                inspectorTab === 'collider'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Collider &amp; Hitbox
            </button>
            <button
              type="button"
              data-testid="inspector-tab-sandbox"
              onClick={() => setInspectorTab('sandbox')}
              className={`inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                inspectorTab === 'sandbox'
                  ? 'bg-emerald-600 text-white'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              <Gamepad2 className="h-3.5 w-3.5" />
              Game Sandbox
            </button>
          </div>

          <span
            data-testid="processed-dimensions-badge"
            className="rounded border border-indigo-500/40 bg-indigo-500/15 px-2.5 py-1 font-mono text-xs font-semibold text-indigo-200"
          >
            {processedSize.width}×{processedSize.height}
          </span>
          {isProcessing && <span className="text-xs text-amber-300">Processing in Worker...</span>}
        </div>
      </div>

      {workerError && (
        <div className="border-b border-rose-500/40 bg-rose-950/70 px-4 py-2 text-xs text-rose-200">
          {workerError}
        </div>
      )}

      {inspectorTab === 'normal' && activeSpriteBuffer ? (
        <NormalMapPreview
          sprite={activeSpriteBuffer}
          artMode={activeProject.artBible.artMode}
          normalConfig={normalConfig}
          isSeamlessTile={seamlessConfig.isSeamlessTile}
          onChangeConfig={setNormalConfig}
          onNormalBufferBaked={handleNormalBufferBaked}
          exportSlot={exportBarNode}
        />
      ) : inspectorTab === 'puppet' && activeSpriteBuffer ? (
        <PuppetWarpEditor
          sprite={activeSpriteBuffer}
          artMode={activeProject.artBible.artMode}
          puppetConfig={puppetConfig}
          onChangeConfig={setPuppetConfig}
          onExportStripZip={handleDownloadZip}
          exportSlot={exportBarNode}
        />
      ) : inspectorTab === 'tile-slice' && activeSpriteBuffer ? (
        <TileAndSliceWorkshop
          sprite={activeSpriteBuffer}
          artMode={activeProject.artBible.artMode}
          project={activeProject}
          targetNode={targetNode}
          seamlessConfig={seamlessConfig}
          nineSliceConfig={nineSliceConfig}
          onChangeSeamlessConfig={setSeamlessConfig}
          onChangeNineSliceConfig={setNineSliceConfig}
          onExportNineSliceZip={handleDownloadZip}
          onSeamlessNodeCommitted={handleSeamlessNodeCommitted}
          exportSlot={exportBarNode}
        />
      ) : inspectorTab === 'palette-lut' && activeSpriteBuffer ? (
        <PaletteLutWorkshop
          sprite={activeSpriteBuffer}
          artMode={activeProject.artBible.artMode}
          project={activeProject}
          targetNode={targetNode}
          postProcessConfig={config}
          rawWidth={rawSize.width}
          rawHeight={rawSize.height}
          variants={lutVariants}
          onChangeVariants={setLutVariants}
          exportSlot={exportBarNode}
        />
      ) : inspectorTab === 'collider' && activeSpriteBuffer ? (
        <ColliderEditor
          sprite={activeSpriteBuffer}
          spriteSlug={toAssetSlug(
            `${activeProject.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`,
          )}
          artMode={activeProject.artBible.artMode}
          pivotNorm={config.pivotNorm}
          paletteHex={activeProject.artBible.palette}
          puppetConfig={puppetConfig}
          shapes={collisionShapes}
          onChangeShapes={setCollisionShapes}
          exportSlot={exportBarNode}
        />
      ) : inspectorTab === 'sandbox' && activeSpriteBuffer ? (
        <GameSandbox
          sprite={activeSpriteBuffer}
          artMode={activeProject.artBible.artMode}
          projection={activeProject.artBible.projection}
          pivotNorm={config.pivotNorm}
          paletteHex={activeProject.artBible.palette}
          puppetConfig={puppetConfig}
          lutVariants={lutVariants}
        />
      ) : (
        <div className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* Left: Split-Screen Comparator */}
          <section className="flex min-w-0 flex-col overflow-hidden bg-slate-950">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="inspector-zoom-out-btn"
                  onClick={() => setZoomPercent((z) => Math.max(50, z - 50))}
                  className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
                  aria-label="Zoom out"
                >
                  <ZoomOut className="h-3.5 w-3.5" />
                </button>
                <span
                  data-testid="inspector-zoom-badge"
                  className="min-w-12 text-center font-mono text-xs text-slate-200"
                >
                  {zoomPercent}%
                </span>
                <button
                  type="button"
                  data-testid="inspector-zoom-in-btn"
                  onClick={() => setZoomPercent((z) => Math.min(800, z + 50))}
                  className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
                  aria-label="Zoom in"
                >
                  <ZoomIn className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  aria-pressed={showPixelGrid}
                  onClick={() => setShowPixelGrid(!showPixelGrid)}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-xs ${
                    showPixelGrid
                      ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
                      : 'border-slate-700 bg-slate-900 text-slate-300'
                  }`}
                >
                  <Grid3X3 className="h-3.5 w-3.5" />
                  Grid
                </button>
              </div>

              <div className="flex items-center gap-3">
                <label className="flex items-center gap-2 text-xs text-slate-300">
                  <span>Split</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={splitPercent}
                    onChange={(e) => setSplitPercent(Number.parseInt(e.target.value, 10))}
                    className="w-24 accent-indigo-500"
                    aria-label="Split comparison position"
                  />
                </label>

                <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
                  {(
                    [
                      ['checkerboard', 'Checker'],
                      ['dark', 'Dark'],
                      ['light', 'Light'],
                      ['game-green', 'Game Green'],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      data-testid={`inspector-backdrop-${key}`}
                      onClick={() => setBackdrop(key)}
                      className={`px-2 py-1 ${
                        backdrop === key
                          ? 'bg-indigo-600 text-white'
                          : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div
              className={`relative flex flex-1 items-center justify-center overflow-auto p-8 ${backdropClass}`}
              style={backdropStyle}
            >
              <div
                ref={comparatorRef}
                data-testid="split-comparator"
                onPointerDown={handleSplitPointerDown}
                onPointerMove={handleSplitPointerMove}
                onPointerUp={handleSplitPointerUp}
                onPointerCancel={handleSplitPointerUp}
                className={`relative shadow-2xl ring-1 ring-slate-600/80 select-none ${
                  pivotPlaceMode ? 'cursor-crosshair' : 'cursor-ew-resize'
                }`}
                style={{
                  width: `${stageW}px`,
                  height: `${stageH}px`,
                  touchAction: 'none',
                }}
              >
                {/* Left Layer: Raw AI Render */}
                <canvas
                  ref={rawCanvasRef}
                  data-testid="raw-preview-canvas"
                  className="absolute inset-0 h-full w-full"
                  style={{
                    imageRendering: inspectorImageRendering,
                    clipPath: `inset(0 ${100 - splitPercent}% 0 0)`,
                  }}
                />

                {/* Right Layer: Processed Sprite */}
                <canvas
                  ref={processedCanvasRef}
                  data-testid="processed-preview-canvas"
                  className="absolute inset-0 h-full w-full"
                  style={{
                    imageRendering: inspectorImageRendering,
                    clipPath: `inset(0 0 0 ${splitPercent}%)`,
                  }}
                />

                {showPixelGrid && zoomPercent >= 200 && (
                  <div
                    className="pointer-events-none absolute inset-0"
                    style={{
                      backgroundSize: `${stageW / Math.max(1, processedSize.width)}px ${stageH / Math.max(1, processedSize.height)}px`,
                      backgroundImage:
                        'linear-gradient(to right, rgba(148, 163, 184, 0.16) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.16) 1px, transparent 1px)',
                    }}
                  />
                )}

                {/* Split Handle */}
                <div
                  data-testid="split-handle"
                  className="pointer-events-none absolute top-0 bottom-0 w-0.5 bg-indigo-400 shadow-[0_0_8px_rgba(99,102,241,0.9)]"
                  style={{ left: `${splitPercent}%` }}
                >
                  <span className="absolute top-2 -left-12 rounded bg-slate-950/90 px-1.5 py-0.5 text-[10px] font-semibold text-slate-200">
                    Raw
                  </span>
                  <span className="absolute top-2 left-2 rounded bg-indigo-600/90 px-1.5 py-0.5 text-[10px] font-semibold text-white">
                    Processed
                  </span>
                </div>

                {/* Pivot Crosshair Overlay */}
                <div
                  data-testid="pivot-crosshair"
                  className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                  style={{
                    left: `${(pivotPx.x / Math.max(1, processedSize.width)) * 100}%`,
                    top: `${(pivotPx.y / Math.max(1, processedSize.height)) * 100}%`,
                  }}
                >
                  <div className="relative h-5 w-5">
                    <span className="absolute top-1/2 right-0 left-0 h-0.5 -translate-y-1/2 bg-amber-400 shadow-[0_0_4px_#000]" />
                    <span className="absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 bg-amber-400 shadow-[0_0_4px_#000]" />
                    <span className="absolute top-1/2 left-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full border border-slate-950 bg-amber-300" />
                  </div>
                </div>
              </div>
            </div>
          </section>

          {/* Right: Toggleable Post-Process Pipeline Cards */}
          <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
            {/* Card 1: Background Removal */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Eraser className="h-3.5 w-3.5 text-indigo-400" />
                <span>1. Background Removal</span>
              </div>

              <select
                data-testid="pp-bg-mode"
                value={config.bgRemoval}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    bgRemoval: e.target.value as BackgroundRemovalMode,
                  }))
                }
                className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
              >
                <option value="none">None (Keep Original)</option>
                <option value="color-key">Fast Color-Key (Flood Fill)</option>
                <option value="ai-rembg">Local AI Cutout (WebGPU / Single-Thread WASM)</option>
              </select>

              {config.bgRemoval === 'color-key' && (
                <div className="space-y-2 pt-1">
                  <label className="block space-y-1 text-xs">
                    <div className="flex justify-between text-slate-400">
                      <span>Color Tolerance</span>
                      <span className="font-mono">{config.bgTolerance}</span>
                    </div>
                    <input
                      type="range"
                      data-testid="pp-bg-tolerance"
                      min={0}
                      max={100}
                      value={config.bgTolerance}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          bgTolerance: Number.parseInt(e.target.value, 10),
                        }))
                      }
                      className="w-full accent-indigo-500"
                    />
                  </label>

                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      data-testid="pp-bg-contiguous"
                      checked={config.bgContiguous}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, bgContiguous: e.target.checked }))
                      }
                      className="accent-indigo-500"
                    />
                    Contiguous border flood-fill
                  </label>
                </div>
              )}

              {aiProgress && (
                <div data-testid="pp-ai-progress" className="space-y-1">
                  <div className="flex justify-between text-[11px] text-indigo-300">
                    <span>{aiProgress.phase}</span>
                    <span>{Math.round(aiProgress.progress * 100)}%</span>
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-slate-800">
                    <div
                      className="h-full bg-indigo-500 transition-all"
                      style={{ width: `${Math.round(aiProgress.progress * 100)}%` }}
                    />
                  </div>
                </div>
              )}
            </div>

            {/* Card 2: Alpha Cleanup & Defringing */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
                <span>2. Alpha Cleanup & Defringe</span>
              </div>

              <label className="block space-y-1 text-xs">
                <div className="flex justify-between text-slate-400">
                  <span>Alpha Cutoff Threshold</span>
                  <span className="font-mono">{config.alphaThreshold}</span>
                </div>
                <input
                  type="range"
                  data-testid="pp-alpha-threshold"
                  min={0}
                  max={255}
                  value={config.alphaThreshold}
                  onChange={(e) =>
                    setConfig((prev) => ({
                      ...prev,
                      alphaThreshold: Number.parseInt(e.target.value, 10),
                    }))
                  }
                  className="w-full accent-indigo-500"
                />
              </label>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs">
                  <span className="text-slate-400">Erosion</span>
                  <select
                    data-testid="pp-erosion-radius"
                    value={config.erosionRadius}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        erosionRadius: Number.parseInt(e.target.value, 10),
                      }))
                    }
                    className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  >
                    <option value={0}>0 px</option>
                    <option value={1}>1 px</option>
                    <option value={2}>2 px</option>
                  </select>
                </label>

                <label className="space-y-1 text-xs">
                  <span className="text-slate-400">Connectivity</span>
                  <select
                    value={config.erosionConnectivity}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        erosionConnectivity: e.target.value as ErosionConnectivity,
                      }))
                    }
                    className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  >
                    <option value="4-connected">4-Connected</option>
                    <option value="8-connected">8-Connected</option>
                  </select>
                </label>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="pp-defringe-toggle"
                  checked={config.defringe}
                  onChange={(e) => setConfig((prev) => ({ ...prev, defringe: e.target.checked }))}
                  className="accent-indigo-500"
                />
                Interior-RGB Color Decontamination (Defringe)
              </label>
            </div>

            {/* Card 3: Palette Snap & Bayer Dither */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Palette className="h-3.5 w-3.5 text-indigo-400" />
                <span>3. OKLab Palette Snap</span>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="pp-palette-snap-toggle"
                  checked={config.paletteSnap}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, paletteSnap: e.target.checked }))
                  }
                  className="accent-indigo-500"
                />
                Snap to Art Bible Palette ({activeProject.artBible.palette.length} colors)
              </label>

              <div className="flex flex-wrap gap-1">
                {activeProject.artBible.palette.map((hex) => (
                  <span
                    key={hex}
                    title={hex}
                    className="h-3.5 w-3.5 rounded-sm border border-slate-700"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>

              {config.paletteSnap && activeProject.artBible.palette.length === 0 && (
                <p
                  data-testid="empty-palette-snap-hint"
                  className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200"
                >
                  Your Art Bible palette is empty — add swatches in the Art Bible Editor to snap
                  colors cleanly.
                </p>
              )}

              {config.paletteSnap && (
                <div className="space-y-2 border-t border-slate-800 pt-2">
                  <label className="flex items-center gap-2 text-xs text-slate-300">
                    <input
                      type="checkbox"
                      data-testid="pp-bayer-toggle"
                      checked={config.bayerDither}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, bayerDither: e.target.checked }))
                      }
                      className="accent-indigo-500"
                    />
                    4×4 Ordered Bayer Dithering
                  </label>
                  {config.bayerDither && (
                    <label className="block space-y-1 text-xs">
                      <div className="flex justify-between text-slate-400">
                        <span>Dither Strength</span>
                        <span className="font-mono">{config.ditherStrength.toFixed(2)}</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={1}
                        step={0.05}
                        value={config.ditherStrength}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            ditherStrength: Number.parseFloat(e.target.value),
                          }))
                        }
                        className="w-full accent-indigo-500"
                      />
                    </label>
                  )}
                </div>
              )}
            </div>

            {/* Card 3B: Pixel-Art Foundry (De-Mixel, Orphan Cleaner & OKLab Sel-Out) */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
              <div className="flex items-center justify-between text-xs font-semibold text-slate-200">
                <div className="flex items-center gap-2">
                  <Grid3X3 className="h-3.5 w-3.5 text-emerald-400" />
                  <span>Pixel-Art Foundry</span>
                </div>
                {config.demixelEnabled && foundryStats.detectedGrid && (
                  <span
                    data-testid="pp-demixel-badge"
                    className="rounded border border-emerald-500/35 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] text-emerald-300"
                  >
                    {foundryStats.detectedGrid.cellWidth}px (
                    {Math.round(foundryStats.detectedGrid.confidence * 100)}%)
                  </span>
                )}
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="pp-demixel-toggle"
                  checked={config.demixelEnabled}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, demixelEnabled: e.target.checked }))
                  }
                  className="accent-indigo-500"
                />
                De-Mixel Grid Snap (Auto Period)
              </label>

              {config.demixelEnabled && (
                <div className="grid grid-cols-2 gap-2 pl-1">
                  <label className="space-y-1 text-xs">
                    <span className="text-slate-400">Grid Mode</span>
                    <select
                      data-testid="pp-demixel-mode"
                      value={config.demixelMode}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          demixelMode: e.target.value as DemixelMode,
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                    >
                      <option value="auto">Auto-Detect</option>
                      <option value="manual">Manual Cell</option>
                    </select>
                  </label>

                  <label className="space-y-1 text-xs">
                    <span className="text-slate-400">Cell Size (px)</span>
                    <input
                      type="number"
                      data-testid="pp-demixel-cell-size"
                      min={1}
                      max={32}
                      disabled={config.demixelMode === 'auto'}
                      value={config.demixelCellSize}
                      onChange={(e) => {
                        const v = Number.parseInt(e.target.value, 10);
                        if (!Number.isNaN(v) && v >= 1 && v <= 32) {
                          setConfig((prev) => ({ ...prev, demixelCellSize: v }));
                        }
                      }}
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100 disabled:opacity-50"
                    />
                  </label>
                </div>
              )}

              <div className="space-y-2 border-t border-slate-800 pt-2">
                <div className="flex items-center justify-between">
                  <label className="flex items-center gap-2 text-xs text-slate-200">
                    <input
                      type="checkbox"
                      data-testid="pp-orphan-toggle"
                      checked={config.orphanCleanEnabled}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, orphanCleanEnabled: e.target.checked }))
                      }
                      className="accent-indigo-500"
                    />
                    Orphan-Pixel &amp; Specks Cleaner
                  </label>
                  {config.orphanCleanEnabled && foundryStats.orphanStats && (
                    <span
                      data-testid="pp-orphan-badge"
                      className="font-mono text-[10px] text-slate-400"
                    >
                      -{foundryStats.orphanStats.removedIslands}i / -
                      {foundryStats.orphanStats.cleanedSpecks}s
                    </span>
                  )}
                </div>

                {config.orphanCleanEnabled && (
                  <div className="grid grid-cols-2 gap-2 pl-1">
                    <label className="space-y-1 text-xs">
                      <span className="text-slate-400">Max Island (px)</span>
                      <input
                        type="number"
                        data-testid="pp-orphan-max-island"
                        min={1}
                        max={16}
                        value={config.maxIslandPixels}
                        onChange={(e) => {
                          const v = Number.parseInt(e.target.value, 10);
                          if (!Number.isNaN(v) && v >= 1 && v <= 16) {
                            setConfig((prev) => ({ ...prev, maxIslandPixels: v }));
                          }
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                      />
                    </label>
                    <label className="mt-4 flex items-center gap-1.5 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        data-testid="pp-orphan-specks-toggle"
                        checked={config.removeInteriorSpecks}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            removeInteriorSpecks: e.target.checked,
                          }))
                        }
                        className="accent-indigo-500"
                      />
                      Pepper Despeckle
                    </label>
                  </div>
                )}
              </div>

              <div className="space-y-2 border-t border-slate-800 pt-2">
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs">
                    <span className="text-slate-400">Sel-Out Outline</span>
                    <select
                      data-testid="pp-selout-mode"
                      value={config.selOutMode}
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, selOutMode: e.target.value as SelOutMode }))
                      }
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                    >
                      <option value="off">Off</option>
                      <option value="outer">Outer 1px (Sel-Out)</option>
                      <option value="inner">Inner 1px (Sel-Out)</option>
                    </select>
                  </label>

                  <label className="space-y-1 text-xs">
                    <span className="text-slate-400">Light Angle</span>
                    <select
                      data-testid="pp-selout-lighting"
                      disabled={config.selOutMode === 'off'}
                      value={config.selOutLighting}
                      onChange={(e) =>
                        setConfig((prev) => ({
                          ...prev,
                          selOutLighting: e.target.value as Lighting,
                        }))
                      }
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100 disabled:opacity-50"
                    >
                      <option value="top-left">Top-Left</option>
                      <option value="top-right">Top-Right</option>
                      <option value="overhead">Overhead</option>
                      <option value="flat">Flat</option>
                    </select>
                  </label>
                </div>

                {config.selOutMode !== 'off' && (
                  <div className="space-y-2 pl-1">
                    <div className="grid grid-cols-2 gap-2">
                      <label className="space-y-1 text-xs">
                        <div className="flex justify-between text-slate-400">
                          <span>Lit Darken</span>
                          <span className="font-mono">{config.selOutLitDarken.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          data-testid="pp-selout-lit-darken"
                          min={0}
                          max={0.6}
                          step={0.02}
                          value={config.selOutLitDarken}
                          onChange={(e) =>
                            setConfig((prev) => ({
                              ...prev,
                              selOutLitDarken: Number.parseFloat(e.target.value),
                            }))
                          }
                          className="w-full accent-indigo-500"
                        />
                      </label>
                      <label className="space-y-1 text-xs">
                        <div className="flex justify-between text-slate-400">
                          <span>Shadow Darken</span>
                          <span className="font-mono">{config.selOutShadowDarken.toFixed(2)}</span>
                        </div>
                        <input
                          type="range"
                          data-testid="pp-selout-shadow-darken"
                          min={0.05}
                          max={0.75}
                          step={0.02}
                          value={config.selOutShadowDarken}
                          onChange={(e) =>
                            setConfig((prev) => ({
                              ...prev,
                              selOutShadowDarken: Number.parseFloat(e.target.value),
                            }))
                          }
                          className="w-full accent-indigo-500"
                        />
                      </label>
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-300">
                      <input
                        type="checkbox"
                        data-testid="pp-selout-palette-toggle"
                        checked={config.selOutSnapToPalette}
                        onChange={(e) =>
                          setConfig((prev) => ({
                            ...prev,
                            selOutSnapToPalette: e.target.checked,
                          }))
                        }
                        className="accent-indigo-500"
                      />
                      Snap Sel-Out to Darker Palette Swatches
                    </label>
                  </div>
                )}
              </div>
            </div>

            {/* Card 4: Resample, Auto-Trim & PoT */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                <Sliders className="h-3.5 w-3.5 text-indigo-400" />
                <span>4. Resample, Auto-Trim & PoT</span>
              </div>

              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="pp-resample-toggle"
                  checked={config.resampleEnabled}
                  onChange={(e) =>
                    setConfig((prev) => ({ ...prev, resampleEnabled: e.target.checked }))
                  }
                  className="accent-indigo-500"
                />
                Resize / Resample Output
              </label>

              {config.resampleEnabled && (
                <div className="space-y-2.5 pl-1">
                  <select
                    data-testid="pp-resample-mode"
                    value={config.resampleMode}
                    onChange={(e) =>
                      setConfig((prev) => ({
                        ...prev,
                        resampleMode: e.target.value as ResampleMode,
                      }))
                    }
                    className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
                  >
                    <option value="nearest">Nearest-Neighbor (Pixel Art)</option>
                    <option value="area">Area-Average Box (HD-2D)</option>
                  </select>

                  <div className="flex gap-1.5">
                    {[64, 128, 256].map((dim) => (
                      <button
                        key={dim}
                        type="button"
                        data-testid={`pp-preset-${dim}`}
                        onClick={() =>
                          setConfig((prev) => ({
                            ...prev,
                            targetWidth: dim,
                            targetHeight: dim,
                          }))
                        }
                        className={`flex-1 rounded border px-2 py-1 font-mono text-[11px] ${
                          config.targetWidth === dim && config.targetHeight === dim
                            ? 'border-indigo-500 bg-indigo-600 text-white'
                            : 'border-slate-700 bg-slate-900 text-slate-300'
                        }`}
                      >
                        {dim}×{dim}
                      </button>
                    ))}
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="space-y-0.5 text-[11px] text-slate-400">
                      <span>Width</span>
                      <input
                        type="number"
                        data-testid="pp-target-width"
                        min={16}
                        max={2048}
                        value={config.targetWidth}
                        onChange={(e) => {
                          const v = Number.parseInt(e.target.value, 10);
                          if (!Number.isNaN(v) && v >= 16 && v <= 2048) {
                            setConfig((prev) => ({ ...prev, targetWidth: v }));
                          }
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                      />
                    </label>
                    <label className="space-y-0.5 text-[11px] text-slate-400">
                      <span>Height</span>
                      <input
                        type="number"
                        data-testid="pp-target-height"
                        min={16}
                        max={2048}
                        value={config.targetHeight}
                        onChange={(e) => {
                          const v = Number.parseInt(e.target.value, 10);
                          if (!Number.isNaN(v) && v >= 16 && v <= 2048) {
                            setConfig((prev) => ({ ...prev, targetHeight: v }));
                          }
                        }}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                      />
                    </label>
                  </div>
                </div>
              )}

              <div className="space-y-2 border-t border-slate-800 pt-2">
                <label className="flex items-center gap-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    data-testid="pp-autotrim-toggle"
                    checked={config.autoTrim}
                    onChange={(e) => setConfig((prev) => ({ ...prev, autoTrim: e.target.checked }))}
                    className="accent-indigo-500"
                  />
                  Auto-Trim Transparent Border
                </label>

                <label className="flex items-center gap-2 text-xs text-slate-200">
                  <input
                    type="checkbox"
                    data-testid="pp-pot-toggle"
                    checked={config.padToPot}
                    onChange={(e) => setConfig((prev) => ({ ...prev, padToPot: e.target.checked }))}
                    className="accent-indigo-500"
                  />
                  Pad to Power-of-Two (PoT)
                </label>
              </div>
            </div>

            {/* Card 5: Interactive Pivot Editor */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold text-slate-200">
                  <Crosshair className="h-3.5 w-3.5 text-amber-400" />
                  <span>5. Pivot Anchor</span>
                </div>
                <span
                  data-testid="pivot-norm-readout"
                  className="font-mono text-[11px] text-amber-300"
                >
                  ({config.pivotNorm.x.toFixed(2)}, {config.pivotNorm.y.toFixed(2)})
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1.5">
                <button
                  type="button"
                  data-testid="pivot-preset-center"
                  onClick={() => setConfig((prev) => ({ ...prev, pivotNorm: { x: 0.5, y: 0.5 } }))}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                >
                  Center
                </button>
                <button
                  type="button"
                  data-testid="pivot-preset-bottom-center"
                  onClick={() => setConfig((prev) => ({ ...prev, pivotNorm: { x: 0.5, y: 1.0 } }))}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                >
                  Bottom-Center
                </button>
                <button
                  type="button"
                  data-testid="pivot-preset-top-left"
                  onClick={() => setConfig((prev) => ({ ...prev, pivotNorm: { x: 0, y: 0 } }))}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                >
                  Top-Left
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-0.5 text-[11px] text-slate-400">
                  <span>Pivot X (px)</span>
                  <input
                    type="number"
                    data-testid="pivot-px-x"
                    min={0}
                    max={processedSize.width}
                    value={pivotPx.x}
                    onChange={(e) => {
                      const px = Number.parseInt(e.target.value, 10);
                      if (!Number.isNaN(px) && px >= 0 && px <= processedSize.width) {
                        setConfig((prev) => ({
                          ...prev,
                          pivotNorm: {
                            ...prev.pivotNorm,
                            x: px / Math.max(1, processedSize.width),
                          },
                        }));
                      }
                    }}
                    className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                  />
                </label>
                <label className="space-y-0.5 text-[11px] text-slate-400">
                  <span>Pivot Y (px)</span>
                  <input
                    type="number"
                    data-testid="pivot-px-y"
                    min={0}
                    max={processedSize.height}
                    value={pivotPx.y}
                    onChange={(e) => {
                      const py = Number.parseInt(e.target.value, 10);
                      if (!Number.isNaN(py) && py >= 0 && py <= processedSize.height) {
                        setConfig((prev) => ({
                          ...prev,
                          pivotNorm: {
                            ...prev.pivotNorm,
                            y: py / Math.max(1, processedSize.height),
                          },
                        }));
                      }
                    }}
                    className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 font-mono text-xs text-slate-100"
                  />
                </label>
              </div>

              <button
                type="button"
                data-testid="pivot-place-mode-btn"
                aria-pressed={pivotPlaceMode}
                onClick={() => setPivotPlaceMode(!pivotPlaceMode)}
                className={`flex w-full items-center justify-center gap-1.5 rounded border px-2.5 py-1.5 text-xs font-medium ${
                  pivotPlaceMode
                    ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
                    : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Crosshair className="h-3.5 w-3.5" />
                {pivotPlaceMode
                  ? 'Click/Drag Canvas to Set Pivot (Active)'
                  : 'Place Pivot on Canvas'}
              </button>
            </div>

            {exportBarNode}
          </aside>
        </div>
      )}
    </div>
  );
}
