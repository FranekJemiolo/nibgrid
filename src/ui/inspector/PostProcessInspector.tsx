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
  ChevronDown,
  Crosshair,
  Download,
  Eraser,
  FileArchive,
  FolderOutput,
  Gamepad2,
  Grid3X3,
  Palette,
  PanelRightClose,
  PanelRightOpen,
  Scissors,
  Sliders,
  Sparkles,
} from 'lucide-react';
import { strToU8 } from 'fflate';
import { repository } from '../../db/database';
import {
  createDefaultAutoTileConfig,
  createDefaultBitmapFontConfig,
  createDefaultNineSliceConfig,
  createDefaultNormalMapConfig,
  createDefaultPaletteLutConfig,
  createDefaultParallaxSceneConfig,
  createDefaultPostProcessConfig,
  createDefaultPuppetAnimConfig,
  createDefaultSeamlessTileConfig,
  createDefaultShaderConfig,
  createDefaultVfxFlipbookConfig,
  type AssetClass,
  type AutoTileConfig,
  type BackgroundRemovalMode,
  type BitmapFontConfig,
  type CollisionLayerShape,
  type DemixelMode,
  type ErosionConnectivity,
  type Lighting,
  type NineSliceConfig,
  type NormalMapConfig,
  type PaletteLutConfig,
  type ParallaxSceneConfig,
  type PostProcessConfig,
  type PuppetAnimConfig,
  type ResampleMode,
  type SeamlessTileConfig,
  type SelOutMode,
  type ShaderConfig,
  type SocketDefinition,
  type SpriteNode,
  type VfxFlipbookConfig,
} from '../../domain/schemas';
import { buildColliderExportFiles } from '../../export/colliderExporters';
import { exportBundleToDirectory, supportsFileSystemAccess } from '../../export/fsAccess';
import { buildNineSliceExportFiles } from '../../export/nineSliceExporters';
import { buildAssetRecipe, computePivotPx } from '../../export/recipeBuilder';
import { buildSocketExportFiles } from '../../export/socketExporters';
import { packageSpriteZip, toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import {
  computeEvaluatedSocketsForSprite,
  type EvaluatedSocketFrame,
} from '../../processing/attachmentSockets';
import { parseHexRgb } from '../../processing/backgroundKey';
import type { DetectedGrid } from '../../processing/demixel';
import { bakeNormalMapCpu } from '../../processing/distanceField';
import type { PaletteVariant } from '../../processing/paletteLut';
import { runPostProcessPipeline } from '../../processing/pipeline';
import { decodePngBytesToRgba, encodeRgbaToPngBytes, rgbaToPngBlob } from '../../processing/png';
import { computeArtBibleHash } from '../../processing/projectAudit';
import { buildAlphaClippedMesh, type SpriteMesh } from '../../processing/spriteMesh';
import type { RgbaBuffer } from '../../processing/types';
import { useAppStore, type InspectorTab } from '../../store/useAppStore';
import { buildPuppetStripArtifacts } from '../../webgl/puppetRenderer';
import {
  createMonotonicRequestGuard,
  runPostProcessInWorker,
} from '../../workers/postprocessClient';
import { AutoTileWorkshop } from './AutoTileWorkshop';
import { BitmapFontWorkshop } from './BitmapFontWorkshop';
import { ColliderEditor } from './ColliderEditor';
import { GameSandbox } from './GameSandbox';
import { NormalMapPreview } from './NormalMapPreview';
import { PaletteLutWorkshop } from './PaletteLutWorkshop';
import { ParallaxWorkshop } from './ParallaxWorkshop';
import { PipBiomePreview } from './PipBiomePreview';
import { PuppetWarpEditor } from './PuppetWarpEditor';
import { ShaderStudio } from './ShaderStudio';
import { SocketEditor } from './SocketEditor';
import { TileAndSliceWorkshop } from './TileAndSliceWorkshop';
import { TurnaroundSlicer } from './TurnaroundSlicer';
import { VfxBaker } from './VfxBaker';
import {
  ASSET_CLASS_OPTIONS,
  INSPECTOR_TAB_META,
  inferAssetClass,
  resolveInspectorTabs,
} from './workspaceTabs';
import { BeforeAfterWipe } from '../primitives/BeforeAfterWipe';
import { CanvasHud, type CanvasBackdropMode } from '../primitives/CanvasHud';
import { ScrubInput } from '../primitives/ScrubInput';

export type InspectorBackdrop = CanvasBackdropMode;

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
  const { activeProject, spriteNodes, providers, refreshSpriteNodes, navigate } = useAppStore();

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
  const [wipeEnabled, setWipeEnabled] = useState(true);
  const [zoomPercent, setZoomPercent] = useState(300);
  const [showPixelGrid, setShowPixelGrid] = useState(true);
  const [drawerCollapsed, setDrawerCollapsed] = useState(false);
  const [backdrop, setBackdrop] = useState<InspectorBackdrop>('checkerboard');
  const [isProcessing, setIsProcessing] = useState(false);
  const [aiProgress, setAiProgress] = useState<{ phase: string; progress: number } | null>(null);
  const [workerError, setWorkerError] = useState<string | null>(null);
  const [pivotPlaceMode, setPivotPlaceMode] = useState(false);
  const [exportNotice, setExportNotice] = useState<string | null>(null);
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(
    () =>
      initialTab ?? (targetNode?.turnaroundMeta?.isTurnaroundSheet ? 'turnaround' : 'postprocess'),
  );
  const [assetClass, setAssetClass] = useState<AssetClass>(() => inferAssetClass(targetNode));
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowMenuRef = useRef<HTMLDivElement | null>(null);
  const [rawSheetBuffer, setRawSheetBuffer] = useState<RgbaBuffer | null>(null);
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
  const [autoTileConfig, setAutoTileConfig] = useState<AutoTileConfig>(
    () => targetNode?.autoTile ?? createDefaultAutoTileConfig(),
  );
  const [lutVariants, setLutVariants] = useState<PaletteVariant[]>(() =>
    paletteVariantsFromNode(targetNode),
  );
  const [collisionShapes, setCollisionShapes] = useState<CollisionLayerShape[]>(
    () => targetNode?.collisionShapes ?? [],
  );
  const [sockets, setSockets] = useState<SocketDefinition[]>(() => targetNode?.sockets ?? []);
  const [vfxFlipbookConfig, setVfxFlipbookConfig] = useState<VfxFlipbookConfig>(
    () => targetNode?.vfxFlipbook ?? createDefaultVfxFlipbookConfig(),
  );
  const [parallaxSceneConfig, setParallaxSceneConfig] = useState<ParallaxSceneConfig>(
    () => targetNode?.parallaxScene ?? createDefaultParallaxSceneConfig(),
  );
  const [bitmapFontConfig, setBitmapFontConfig] = useState<BitmapFontConfig>(
    () => targetNode?.bitmapFont ?? createDefaultBitmapFontConfig(),
  );
  const [shaderConfig, setShaderConfig] = useState<ShaderConfig>(
    () => targetNode?.shaderConfig ?? createDefaultShaderConfig(),
  );
  const [activeSpriteBuffer, setActiveSpriteBuffer] = useState<RgbaBuffer | null>(null);
  const bakedNormalRef = useRef<{ buffer: RgbaBuffer; key: string } | null>(null);
  const [foundryStats, setFoundryStats] = useState<{
    detectedGrid?: DetectedGrid;
    orphanStats?: { removedIslands: number; cleanedSpecks: number };
  }>({});

  const rawCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const processedCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const canvasWellRef = useRef<HTMLDivElement | null>(null);
  const draggingPivotRef = useRef(false);
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
  const activeProjectId = activeProject?.id;
  const latestProjectRef = useRef(activeProject);
  latestProjectRef.current = activeProject;

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
  const latestSocketsRef = useRef(sockets);
  latestSocketsRef.current = sockets;
  const latestAssetClassRef = useRef(assetClass);
  latestAssetClassRef.current = assetClass;
  const latestAutoTileRef = useRef(autoTileConfig);
  latestAutoTileRef.current = autoTileConfig;
  const latestVfxFlipbookRef = useRef(vfxFlipbookConfig);
  latestVfxFlipbookRef.current = vfxFlipbookConfig;
  const latestParallaxSceneRef = useRef(parallaxSceneConfig);
  latestParallaxSceneRef.current = parallaxSceneConfig;
  const latestBitmapFontRef = useRef(bitmapFontConfig);
  latestBitmapFontRef.current = bitmapFontConfig;
  const latestShaderConfigRef = useRef(shaderConfig);
  latestShaderConfigRef.current = shaderConfig;

  useEffect(() => {
    if (!overflowOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOverflowOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [overflowOpen]);

  useEffect(() => {
    if (initialTab) {
      setInspectorTab(initialTab);
    } else if (latestNodeRef.current?.turnaroundMeta?.isTurnaroundSheet) {
      setInspectorTab('turnaround');
    }
  }, [initialTab, targetNodeId]);

  // Sync initial assetClass, autoTileConfig, sockets, vfxFlipbook, parallaxScene & bitmapFont ONLY when targetNodeId changes
  useEffect(() => {
    const node = latestNodeRef.current;
    if (!targetNodeId || !node) return;
    setAssetClass(inferAssetClass(node));
    setAutoTileConfig(node.autoTile ?? createDefaultAutoTileConfig());
    setSockets(node.sockets ?? []);
    setVfxFlipbookConfig(node.vfxFlipbook ?? createDefaultVfxFlipbookConfig());
    setParallaxSceneConfig(node.parallaxScene ?? createDefaultParallaxSceneConfig());
    setBitmapFontConfig(node.bitmapFont ?? createDefaultBitmapFontConfig());
    setShaderConfig(node.shaderConfig ?? createDefaultShaderConfig());
  }, [targetNodeId]);

  // Auto-infer tile / ui-panel when enabling Seamless Tile or 9-Slice on unclassified sprite
  useEffect(() => {
    const node = latestNodeRef.current;
    if (!node || node.assetClass) return;
    if (nineSliceConfig.enabled && latestAssetClassRef.current !== 'ui-panel') {
      setAssetClass('ui-panel');
    } else if (seamlessConfig.isSeamlessTile && latestAssetClassRef.current !== 'tile') {
      setAssetClass('tile');
    }
  }, [nineSliceConfig.enabled, seamlessConfig.isSeamlessTile]);

  // Sync initial config when node or project ID changes (never clobber edits on project.updatedAt bumps)
  useEffect(() => {
    const node = latestNodeRef.current;
    const project = latestProjectRef.current;
    if (!targetNodeId || !node || !project) return;
    setConfig(
      node.postProcessConfig ??
        createDefaultPostProcessConfig(project.artBible.targetWidth, project.artBible.targetHeight),
    );
    setPuppetConfig(node.puppetAnim ?? createDefaultPuppetAnimConfig());
    setSeamlessConfig(node.seamlessTile ?? createDefaultSeamlessTileConfig());
    setNineSliceConfig(node.nineSlice ?? createDefaultNineSliceConfig());
    setLutVariants(paletteVariantsFromNode(node));
    setCollisionShapes(node.collisionShapes ?? []);
  }, [targetNodeId, activeProjectId]);

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
    const socketsChanged = JSON.stringify(nodeSnapshot.sockets ?? []) !== JSON.stringify(sockets);
    if (!puppetChanged && !sliceChanged && !lutChanged && !collisionChanged && !socketsChanged) {
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
          assetClass: latestAssetClassRef.current,
          puppetAnim: latestPuppetRef.current,
          ...(latestNineSliceRef.current.enabled ? { nineSlice: latestNineSliceRef.current } : {}),
          ...(persistedLut ? { paletteLut: persistedLut } : {}),
          ...(latestCollisionShapesRef.current.length > 0
            ? { collisionShapes: latestCollisionShapesRef.current }
            : { collisionShapes: [] }),
          ...(latestSocketsRef.current.length > 0
            ? { sockets: latestSocketsRef.current }
            : { sockets: [] }),
          ...(currentNode.autoTile ? { autoTile: latestAutoTileRef.current } : {}),
          ...(currentNode.vfxFlipbook ? { vfxFlipbook: latestVfxFlipbookRef.current } : {}),
          ...(currentNode.parallaxScene ? { parallaxScene: latestParallaxSceneRef.current } : {}),
          ...(currentNode.bitmapFont ? { bitmapFont: latestBitmapFontRef.current } : {}),
          ...(currentNode.shaderConfig ? { shaderConfig: latestShaderConfigRef.current } : {}),
        })
        .then(() => refreshSpriteNodes(activeProject.id));
    }, 120);
    return () => window.clearTimeout(timer);
  }, [
    puppetConfig,
    nineSliceConfig,
    lutVariants,
    collisionShapes,
    sockets,
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
    setRawSheetBuffer(null);

    void repository.getBlob(targetImageBlobId).then(async (blobRecord) => {
      if (cancelled || !blobRecord) return;
      const decoded = await decodeBlobFlexible(blobRecord.bytes);
      if (cancelled) return;
      rawImageRef.current = decoded;
      setRawSize({ width: decoded.width, height: decoded.height });
      setRawLoadRev((rev) => rev + 1);
      setRawSheetBuffer({ width: decoded.width, height: decoded.height, data: decoded.rgba });
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
            assetClass: latestAssetClassRef.current,
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
            ...(latestSocketsRef.current.length > 0 ? { sockets: latestSocketsRef.current } : {}),
            ...(nodeSnapshot.autoTile ? { autoTile: latestAutoTileRef.current } : {}),
            ...(nodeSnapshot.vfxFlipbook ? { vfxFlipbook: latestVfxFlipbookRef.current } : {}),
            ...(nodeSnapshot.parallaxScene
              ? { parallaxScene: latestParallaxSceneRef.current }
              : {}),
            ...(nodeSnapshot.bitmapFont ? { bitmapFont: latestBitmapFontRef.current } : {}),
            ...(nodeSnapshot.shaderConfig ? { shaderConfig: latestShaderConfigRef.current } : {}),
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

  // Re-paint Raw/Processed canvases whenever switching back to Screen 4A tab
  useEffect(() => {
    if (inspectorTab !== 'postprocess') return;
    if (rawImageRef.current) {
      drawCanvasBuffer(
        rawCanvasRef.current,
        rawImageRef.current.rgba,
        rawImageRef.current.width,
        rawImageRef.current.height,
      );
    }
    if (processedArtifactRef.current) {
      drawCanvasBuffer(
        processedCanvasRef.current,
        processedArtifactRef.current.rgba,
        processedArtifactRef.current.width,
        processedArtifactRef.current.height,
      );
    }
  }, [inspectorTab, drawCanvasBuffer]);

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

  const updatePivotFromClient = (el: HTMLElement, clientX: number, clientY: number) => {
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

  const handlePivotSurfacePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!pivotPlaceMode) return;
    e.preventDefault();
    draggingPivotRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updatePivotFromClient(e.currentTarget, e.clientX, e.clientY);
  };

  const handlePivotSurfacePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingPivotRef.current || !pivotPlaceMode) return;
    updatePivotFromClient(e.currentTarget, e.clientX, e.clientY);
  };

  const handlePivotSurfacePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingPivotRef.current) return;
    draggingPivotRef.current = false;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
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
    let cachedMesh: SpriteMesh | undefined;
    const spriteBuf: RgbaBuffer = {
      width: artifact.width,
      height: artifact.height,
      data: artifact.rgba,
    };

    if (puppetConfig.pins.length > 0) {
      const mesh = buildAlphaClippedMesh(spriteBuf, { artMode: activeProject.artBible.artMode });
      cachedMesh = mesh;
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

    let evaluatedSocketsByFrame: EvaluatedSocketFrame[][] | undefined;
    if (sockets.length > 0) {
      const exportPivotPx = computePivotPx(config.pivotNorm, artifact.width, artifact.height);
      const { evaluatedByFrame } = computeEvaluatedSocketsForSprite({
        sprite: spriteBuf,
        artMode: activeProject.artBible.artMode,
        pivotPx: exportPivotPx,
        puppetConfig,
        sockets,
        ...(cachedMesh ? { cachedMesh } : {}),
      });
      evaluatedSocketsByFrame = evaluatedByFrame;
      Object.assign(
        extraFiles,
        buildSocketExportFiles(slug, puppetConfig.fps, sockets, evaluatedByFrame),
      );
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
      ...(sockets.length > 0 ? { sockets } : {}),
      ...(targetNode.autoTile ? { autoTile: autoTileConfig } : {}),
      ...(targetNode.vfxFlipbook ? { vfxFlipbook: vfxFlipbookConfig } : {}),
      ...(targetNode.parallaxScene ? { parallaxScene: parallaxSceneConfig } : {}),
      ...(targetNode.bitmapFont ? { bitmapFont: bitmapFontConfig } : {}),
      ...(targetNode.shaderConfig ? { shaderConfig } : {}),
      recipeArtBibleHash: computeArtBibleHash(activeProject.artBible),
      assetClass,
    });
    return { artifact, slug, recipe, normalPngBytes, extraFiles, evaluatedSocketsByFrame };
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
      const { slug, recipe, artifact, normalPngBytes, extraFiles, evaluatedSocketsByFrame } =
        buildCurrentRecipeAndSlug();
      const zipBytes = packageSpriteZip({
        slug,
        pngBytes: artifact.pngBytes,
        recipe,
        normalPngBytes,
        extraFiles,
        ...(evaluatedSocketsByFrame ? { evaluatedSocketsByFrame } : {}),
        ...(targetNode?.shaderConfig ? { shaderBundle: shaderConfig } : {}),
        socketFps: puppetConfig.fps,
      });
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      triggerBlobDownload(new Blob([copy.buffer], { type: 'application/zip' }), `${slug}.zip`);
      const extraCount = Object.keys(extraFiles).length;
      setExportNotice(
        `Downloaded ${slug}.zip (${slug}.png${normalPngBytes ? ` + ${slug}_n.png` : ''}${extraCount > 0 ? ` + ${extraCount} engine file${extraCount === 1 ? '' : 's'}` : ''} + ${slug}.recipe.json)`,
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

  const handleSaveAutoTile = useCallback(
    async (savedConfig: AutoTileConfig) => {
      setAutoTileConfig(savedConfig);
      const current = latestNodeRef.current;
      if (!activeProject || !current) return;
      await repository.saveSpriteNode({
        ...current,
        assetClass: latestAssetClassRef.current,
        autoTile: savedConfig,
        ...(latestSocketsRef.current.length > 0 ? { sockets: latestSocketsRef.current } : {}),
      });
      await refreshSpriteNodes(activeProject.id);
    },
    [activeProject, refreshSpriteNodes],
  );

  const handleSaveSockets = useCallback(
    async (nextSockets: SocketDefinition[]) => {
      setSockets(nextSockets);
      latestSocketsRef.current = nextSockets;
      const current = latestNodeRef.current;
      if (!activeProject || !current) return;
      await repository.saveSpriteNode({
        ...current,
        assetClass: latestAssetClassRef.current,
        ...(latestCollisionShapesRef.current.length > 0
          ? { collisionShapes: latestCollisionShapesRef.current }
          : {}),
        sockets: nextSockets,
      });
      await refreshSpriteNodes(activeProject.id);
    },
    [activeProject, refreshSpriteNodes],
  );

  const handleSaveVfxFlipbook = useCallback(
    async (savedConfig: VfxFlipbookConfig) => {
      setVfxFlipbookConfig(savedConfig);
      latestVfxFlipbookRef.current = savedConfig;
      const current = latestNodeRef.current;
      if (!activeProject || !current) return;
      await repository.saveSpriteNode({
        ...current,
        assetClass: latestAssetClassRef.current,
        ...(latestCollisionShapesRef.current.length > 0
          ? { collisionShapes: latestCollisionShapesRef.current }
          : {}),
        ...(latestSocketsRef.current.length > 0 ? { sockets: latestSocketsRef.current } : {}),
        vfxFlipbook: savedConfig,
      });
      await refreshSpriteNodes(activeProject.id);
    },
    [activeProject, refreshSpriteNodes],
  );

  const handleSaveParallaxScene = useCallback(
    async (savedConfig: ParallaxSceneConfig) => {
      setParallaxSceneConfig(savedConfig);
      latestParallaxSceneRef.current = savedConfig;
      const current = latestNodeRef.current;
      if (!activeProject || !current) return;
      await repository.saveSpriteNode({
        ...current,
        assetClass: latestAssetClassRef.current,
        parallaxScene: savedConfig,
      });
      await repository.cleanupOrphanedBlobs();
      await refreshSpriteNodes(activeProject.id);
    },
    [activeProject, refreshSpriteNodes],
  );

  const handleSaveBitmapFont = useCallback(
    async (savedConfig: BitmapFontConfig) => {
      setBitmapFontConfig(savedConfig);
      latestBitmapFontRef.current = savedConfig;
      const current = latestNodeRef.current;
      if (!activeProject || !current) return;
      await repository.saveSpriteNode({
        ...current,
        assetClass: latestAssetClassRef.current,
        bitmapFont: savedConfig,
      });
      await refreshSpriteNodes(activeProject.id);
    },
    [activeProject, refreshSpriteNodes],
  );

  const handleSaveShaderConfig = useCallback(
    async (savedConfig: ShaderConfig) => {
      setShaderConfig(savedConfig);
      latestShaderConfigRef.current = savedConfig;
      const current = latestNodeRef.current;
      if (!activeProject || !current) return;
      await repository.saveSpriteNode({
        ...current,
        assetClass: latestAssetClassRef.current,
        shaderConfig: savedConfig,
      });
      await refreshSpriteNodes(activeProject.id);
    },
    [activeProject, refreshSpriteNodes],
  );

  const handleAssetClassChange = useCallback(
    async (nextClass: AssetClass) => {
      setAssetClass(nextClass);
      const current = latestNodeRef.current;
      if (!activeProject || !current) return;
      await repository.saveSpriteNode({
        ...current,
        assetClass: nextClass,
      });
      await refreshSpriteNodes(activeProject.id);
    },
    [activeProject, refreshSpriteNodes],
  );

  const handleFitZoom = useCallback(() => {
    const well = canvasWellRef.current;
    if (!well) {
      setZoomPercent(300);
      return;
    }
    const availW = Math.max(64, well.clientWidth - 96);
    const availH = Math.max(64, well.clientHeight - 120);
    const scaleX = availW / Math.max(1, processedSize.width);
    const scaleY = availH / Math.max(1, processedSize.height);
    const rawPct = Math.floor((Math.min(scaleX, scaleY) * 100) / 50) * 50;
    setZoomPercent(Math.max(100, Math.min(800, rawPct)));
  }, [processedSize.height, processedSize.width]);

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

  const backdropStyle =
    backdrop === 'game-green'
      ? { backgroundColor: '#2D5A27' }
      : backdrop === 'mid'
        ? { backgroundColor: '#808080' }
        : backdrop === 'dark'
          ? { backgroundColor: '#111113' }
          : backdrop === 'light'
            ? { backgroundColor: '#E4E4E7' }
            : undefined;
  const backdropClass = backdrop === 'checkerboard' ? 'bg-checkerboard' : '';

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

  const resolvedTabs = resolveInspectorTabs(
    assetClass,
    Boolean(targetNode.turnaroundMeta?.isTurnaroundSheet),
  );
  const activeTabInOverflow = resolvedTabs.overflow.includes(inspectorTab);

  const selectTab = (tab: InspectorTab) => {
    setInspectorTab(tab);
    if (tab === 'normal') {
      setNormalConfig((prev) => ({ ...prev, enabled: true }));
    }
    setOverflowOpen(false);
  };

  const tabButtonStyle = (tab: InspectorTab, active: boolean) => {
    if (active) {
      if (tab === 'collider' || tab === 'sandbox') return 'bg-emerald-600 text-white';
      if (tab === 'turnaround') return 'bg-cyan-600 text-white';
      return 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)]';
    }
    if (tab === 'turnaround' && targetNode.turnaroundMeta?.isTurnaroundSheet) {
      return 'border border-cyan-500/40 text-cyan-200 hover:text-white';
    }
    return 'text-slate-300 hover:bg-slate-800 hover:text-white';
  };

  return (
    <div
      data-testid="postprocess-inspector"
      data-recipe-synced={String(Boolean(targetNode.recipeArtBibleHash))}
      className="flex flex-1 flex-col overflow-hidden"
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            data-testid="back-to-studio-btn"
            onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
            className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Sprite Studio
          </button>
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Post-Process &amp; Export Inspector
            </h2>
            <p className="text-[11px] text-[var(--text-muted)]">
              Node {targetNode.kind} · seed #{targetNode.generationMeta.seed}
            </p>
          </div>
          <label className="ml-1 flex items-center gap-1.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-slate-300">
            <span className="text-[10px] tracking-wide text-[var(--text-muted)] uppercase">
              Class
            </span>
            <select
              data-testid="inspector-asset-class-select"
              value={assetClass}
              onChange={(e) => void handleAssetClassChange(e.target.value as AssetClass)}
              className="bg-transparent font-medium text-[#F5B82E] outline-none"
            >
              {ASSET_CLASS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value} className="bg-[#18181B] text-[#E4E4E7]">
                  {opt.label}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-0.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-xs">
            {resolvedTabs.primary.map((tabId) => {
              const meta = INSPECTOR_TAB_META[tabId];
              return (
                <button
                  key={tabId}
                  type="button"
                  data-testid={meta.testId}
                  title={meta.label}
                  onClick={() => selectTab(tabId)}
                  className={`inline-flex items-center gap-1 rounded px-2 py-1 font-medium whitespace-nowrap transition-colors ${tabButtonStyle(
                    tabId,
                    inspectorTab === tabId,
                  )}`}
                >
                  {tabId === 'sandbox' && <Gamepad2 className="h-3.5 w-3.5" />}
                  {tabId === 'turnaround' && <Scissors className="h-3.5 w-3.5" />}
                  {meta.shortLabel}
                </button>
              );
            })}

            {resolvedTabs.overflow.length > 0 && (
              <div ref={overflowMenuRef} className="relative">
                <button
                  type="button"
                  data-testid="inspector-more-tools-btn"
                  aria-expanded={overflowOpen}
                  onClick={() => setOverflowOpen((o) => !o)}
                  className={`inline-flex items-center gap-1 rounded px-2.5 py-1 font-medium transition-colors ${
                    activeTabInOverflow
                      ? 'bg-[var(--accent-primary)]/20 text-[#F5B82E] ring-1 ring-[var(--accent-primary)]/40'
                      : 'text-[var(--text-muted)] hover:bg-slate-800 hover:text-white'
                  }`}
                >
                  <span>
                    {activeTabInOverflow
                      ? `+ Tools (${INSPECTOR_TAB_META[inspectorTab].shortLabel})`
                      : '+ Tools'}
                  </span>
                  <ChevronDown className="h-3 w-3" />
                </button>

                {overflowOpen && (
                  <div
                    data-testid="inspector-overflow-menu"
                    className="absolute right-0 z-40 mt-1.5 w-52 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-1 shadow-2xl"
                  >
                    {resolvedTabs.overflow.map((tabId) => {
                      const meta = INSPECTOR_TAB_META[tabId];
                      const active = inspectorTab === tabId;
                      return (
                        <button
                          key={tabId}
                          type="button"
                          data-testid={meta.testId}
                          onClick={() => selectTab(tabId)}
                          className={`flex w-full items-center gap-2 rounded px-2.5 py-1.5 text-left text-xs transition-colors ${
                            active
                              ? 'bg-[var(--accent-primary)]/20 font-semibold text-[#F5B82E]'
                              : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                          }`}
                        >
                          {tabId === 'sandbox' && <Gamepad2 className="h-3.5 w-3.5" />}
                          {tabId === 'turnaround' && <Scissors className="h-3.5 w-3.5" />}
                          <span>{meta.label}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>

          <span
            data-testid="processed-dimensions-badge"
            className="tabular-nums rounded border border-[var(--accent-primary)]/40 bg-[var(--accent-primary)]/15 px-2.5 py-1 font-mono text-xs font-semibold text-[#F5B82E]"
          >
            {processedSize.width}×{processedSize.height}
          </span>
          {inspectorTab === 'postprocess' && (
            <button
              type="button"
              data-testid="inspector-drawer-toggle"
              onClick={() => setDrawerCollapsed((c) => !c)}
              className="hidden items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-xs text-slate-300 hover:bg-slate-700 lg:inline-flex"
              aria-label={drawerCollapsed ? 'Show inspector drawer' : 'Hide inspector drawer'}
              title={drawerCollapsed ? 'Show inspector drawer' : 'Hide inspector drawer'}
            >
              {drawerCollapsed ? (
                <PanelRightOpen className="h-3.5 w-3.5" />
              ) : (
                <PanelRightClose className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          {isProcessing && <span className="text-xs text-amber-300">Processing in Worker...</span>}
        </div>
      </div>

      {workerError && (
        <div className="border-b border-rose-500/40 bg-rose-950/70 px-4 py-2 text-xs text-rose-200">
          {workerError}
        </div>
      )}

      <div className="relative flex min-w-0 flex-1 flex-col overflow-hidden">
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
        ) : inspectorTab === 'sockets' && activeSpriteBuffer ? (
          <SocketEditor
            sprite={activeSpriteBuffer}
            spriteSlug={toAssetSlug(
              `${activeProject.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`,
            )}
            artMode={activeProject.artBible.artMode}
            pivotNorm={config.pivotNorm}
            puppetConfig={puppetConfig}
            sockets={sockets}
            onChangeSockets={setSockets}
            onSaveSockets={handleSaveSockets}
            onDownloadZip={handleDownloadZip}
            exportSlot={exportBarNode}
          />
        ) : inspectorTab === 'vfx-baker' && activeSpriteBuffer ? (
          <VfxBaker
            sprite={activeSpriteBuffer}
            artMode={activeProject.artBible.artMode}
            project={activeProject}
            targetNode={targetNode}
            postProcessConfig={config}
            rawWidth={rawSize.width}
            rawHeight={rawSize.height}
            vfxConfig={vfxFlipbookConfig}
            onChangeConfig={setVfxFlipbookConfig}
            onSaveToProject={handleSaveVfxFlipbook}
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
        ) : inspectorTab === 'autotile' && activeSpriteBuffer ? (
          <AutoTileWorkshop
            sprite={activeSpriteBuffer}
            artMode={activeProject.artBible.artMode}
            project={activeProject}
            targetNode={targetNode}
            spriteNodes={spriteNodes}
            postProcessConfig={config}
            rawWidth={rawSize.width}
            rawHeight={rawSize.height}
            autoTileConfig={autoTileConfig}
            onChangeConfig={setAutoTileConfig}
            onSaveToProject={handleSaveAutoTile}
          />
        ) : inspectorTab === 'parallax' && activeSpriteBuffer ? (
          <ParallaxWorkshop
            sprite={activeSpriteBuffer}
            artMode={activeProject.artBible.artMode}
            project={activeProject}
            targetNode={targetNode}
            spriteNodes={spriteNodes}
            providers={providers}
            postProcessConfig={config}
            rawWidth={rawSize.width}
            rawHeight={rawSize.height}
            parallaxConfig={parallaxSceneConfig}
            onChangeConfig={setParallaxSceneConfig}
            onSaveToProject={handleSaveParallaxScene}
          />
        ) : inspectorTab === 'bmfont' && activeSpriteBuffer ? (
          <BitmapFontWorkshop
            sprite={activeSpriteBuffer}
            artMode={activeProject.artBible.artMode}
            project={activeProject}
            targetNode={targetNode}
            postProcessConfig={config}
            rawWidth={rawSize.width}
            rawHeight={rawSize.height}
            bitmapConfig={bitmapFontConfig}
            onChangeConfig={setBitmapFontConfig}
            onSaveToProject={handleSaveBitmapFont}
          />
        ) : inspectorTab === 'shader' && activeSpriteBuffer ? (
          <ShaderStudio
            sprite={activeSpriteBuffer}
            project={activeProject}
            targetNode={targetNode}
            providers={providers}
            postProcessConfig={config}
            rawWidth={rawSize.width}
            rawHeight={rawSize.height}
            shaderConfig={shaderConfig}
            onChangeConfig={setShaderConfig}
            onSaveToProject={handleSaveShaderConfig}
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
        ) : inspectorTab === 'turnaround' && (rawSheetBuffer ?? activeSpriteBuffer) ? (
          <TurnaroundSlicer
            sheetBuffer={(rawSheetBuffer ?? activeSpriteBuffer)!}
            artMode={activeProject.artBible.artMode}
            project={activeProject}
            targetNode={targetNode}
            onCommitted={async () => {
              await refreshSpriteNodes(activeProject.id);
            }}
            onOpenAtlas={() => void navigate({ screen: 'atlas', projectId: activeProject.id })}
            onOpenSandbox={(committedNodeId) =>
              void navigate({
                screen: 'inspector',
                projectId: activeProject.id,
                nodeId: committedNodeId,
                initialTab: 'sandbox',
              })
            }
            onOpenStudio={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
          />
        ) : (
          <div
            className={`grid min-w-0 flex-1 grid-cols-1 ${
              drawerCollapsed
                ? 'lg:grid-cols-[minmax(0,1fr)]'
                : 'lg:grid-cols-[minmax(0,1fr)_288px]'
            }`}
          >
            {/* Left: Canvas-First Viewport with Floating CanvasHud & PiP Biome */}
            <section
              ref={canvasWellRef}
              data-testid="inspector-canvas-well"
              className={`relative flex min-w-0 flex-1 flex-col overflow-hidden ${backdropClass}`}
              style={backdropStyle}
            >
              <div className="flex flex-1 items-center justify-center overflow-auto p-6 pb-20">
                <BeforeAfterWipe
                  enabled={wipeEnabled}
                  percent={splitPercent}
                  onChangePercent={setSplitPercent}
                  onToggleEnabled={() => setWipeEnabled((w) => !w)}
                  enableBackslashShortcut
                  beforeLabel="Raw"
                  afterLabel="Processed"
                  widthPx={stageW}
                  heightPx={stageH}
                  disabledDrag={pivotPlaceMode}
                  onSurfacePointerDown={handlePivotSurfacePointerDown}
                  onSurfacePointerMove={handlePivotSurfacePointerMove}
                  onSurfacePointerUp={handlePivotSurfacePointerUp}
                  className="shadow-2xl ring-1 ring-slate-600/80"
                  before={
                    <canvas
                      ref={rawCanvasRef}
                      data-testid="raw-preview-canvas"
                      className="h-full w-full"
                      style={{ imageRendering: inspectorImageRendering }}
                    />
                  }
                  after={
                    <canvas
                      ref={processedCanvasRef}
                      data-testid="processed-preview-canvas"
                      className="h-full w-full"
                      style={{ imageRendering: inspectorImageRendering }}
                    />
                  }
                  overlay={
                    <>
                      {showPixelGrid && zoomPercent >= 200 && (
                        <div
                          className="pointer-events-none absolute inset-0"
                          style={{
                            backgroundSize: `${stageW / Math.max(1, processedSize.width)}px ${stageH / Math.max(1, processedSize.height)}px`,
                            backgroundImage:
                              'linear-gradient(to right, rgba(228, 228, 231, 0.14) 1px, transparent 1px), linear-gradient(to bottom, rgba(228, 228, 231, 0.14) 1px, transparent 1px)',
                          }}
                        />
                      )}

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
                    </>
                  }
                />
              </div>

              <PipBiomePreview
                sprite={activeSpriteBuffer}
                pixelArt={activeProject.artBible.artMode === 'pixel-art'}
                onOpenSandbox={() => selectTab('sandbox')}
              />

              <CanvasHud
                zoomPercent={zoomPercent}
                onZoomChange={setZoomPercent}
                onFitZoom={handleFitZoom}
                showPixelGrid={showPixelGrid}
                onTogglePixelGrid={() => setShowPixelGrid((g) => !g)}
                wipeEnabled={wipeEnabled}
                onToggleWipe={() => setWipeEnabled((w) => !w)}
                backdrop={backdrop}
                onBackdropChange={setBackdrop}
              />
            </section>

            {/* Right: Collapsible 288px Studio Post-Process Sidebar */}
            {!drawerCollapsed && (
              <aside
                data-testid="inspector-drawer"
                className="space-y-3 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3 lg:border-t-0 lg:border-l"
              >
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
                      <ScrubInput
                        label="Color Tolerance"
                        value={config.bgTolerance}
                        min={0}
                        max={100}
                        step={1}
                        decimals={0}
                        testId="scrub-bg-tolerance"
                        compatRangeTestId="pp-bg-tolerance"
                        onChange={(next) =>
                          setConfig((prev) => ({
                            ...prev,
                            bgTolerance: Math.round(next),
                          }))
                        }
                      />

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

                  <ScrubInput
                    label="Alpha Cutoff Threshold"
                    value={config.alphaThreshold}
                    min={0}
                    max={255}
                    step={1}
                    decimals={0}
                    testId="scrub-alpha-threshold"
                    compatRangeTestId="pp-alpha-threshold"
                    onChange={(next) =>
                      setConfig((prev) => ({
                        ...prev,
                        alphaThreshold: Math.round(next),
                      }))
                    }
                  />

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
                      onChange={(e) =>
                        setConfig((prev) => ({ ...prev, defringe: e.target.checked }))
                      }
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
                        <ScrubInput
                          label="Dither Strength"
                          value={config.ditherStrength}
                          min={0}
                          max={1}
                          step={0.05}
                          decimals={2}
                          testId="scrub-dither-strength"
                          onChange={(next) =>
                            setConfig((prev) => ({
                              ...prev,
                              ditherStrength: next,
                            }))
                          }
                        />
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
                            setConfig((prev) => ({
                              ...prev,
                              selOutMode: e.target.value as SelOutMode,
                            }))
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
                        <div className="grid grid-cols-1 gap-2">
                          <ScrubInput
                            label="Lit Darken"
                            value={config.selOutLitDarken}
                            min={0}
                            max={0.6}
                            step={0.02}
                            decimals={2}
                            testId="scrub-selout-lit"
                            compatRangeTestId="pp-selout-lit-darken"
                            onChange={(next) =>
                              setConfig((prev) => ({
                                ...prev,
                                selOutLitDarken: next,
                              }))
                            }
                          />
                          <ScrubInput
                            label="Shadow Darken"
                            value={config.selOutShadowDarken}
                            min={0.05}
                            max={0.75}
                            step={0.02}
                            decimals={2}
                            testId="scrub-selout-shadow"
                            compatRangeTestId="pp-selout-shadow-darken"
                            onChange={(next) =>
                              setConfig((prev) => ({
                                ...prev,
                                selOutShadowDarken: next,
                              }))
                            }
                          />
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
                        onChange={(e) =>
                          setConfig((prev) => ({ ...prev, autoTrim: e.target.checked }))
                        }
                        className="accent-indigo-500"
                      />
                      Auto-Trim Transparent Border
                    </label>

                    {config.autoTrim && (
                      <ScrubInput
                        label="Trim Margin"
                        value={config.trimMargin}
                        min={0}
                        max={64}
                        step={1}
                        decimals={0}
                        unit="px"
                        testId="scrub-trim-margin"
                        onChange={(next) =>
                          setConfig((prev) => ({ ...prev, trimMargin: Math.round(next) }))
                        }
                      />
                    )}

                    <label className="flex items-center gap-2 text-xs text-slate-200">
                      <input
                        type="checkbox"
                        data-testid="pp-pot-toggle"
                        checked={config.padToPot}
                        onChange={(e) =>
                          setConfig((prev) => ({ ...prev, padToPot: e.target.checked }))
                        }
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
                      onClick={() =>
                        setConfig((prev) => ({ ...prev, pivotNorm: { x: 0.5, y: 0.5 } }))
                      }
                      className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                    >
                      Center
                    </button>
                    <button
                      type="button"
                      data-testid="pivot-preset-bottom-center"
                      onClick={() =>
                        setConfig((prev) => ({ ...prev, pivotNorm: { x: 0.5, y: 1.0 } }))
                      }
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
            )}
          </div>
        )}

        {inspectorTab !== 'postprocess' && inspectorTab !== 'sandbox' && (
          <div className="pointer-events-none absolute inset-0 lg:right-[360px]">
            <PipBiomePreview
              sprite={activeSpriteBuffer}
              pixelArt={activeProject.artBible.artMode === 'pixel-art'}
              onOpenSandbox={() => selectTab('sandbox')}
            />
          </div>
        )}
      </div>
    </div>
  );
}
