import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  AlertTriangle,
  Eraser,
  Eye,
  EyeOff,
  Grid3X3,
  Hand,
  Paintbrush,
  Pencil,
  Redo2,
  RotateCcw,
  Sparkles,
  Trash2,
  Undo2,
  Upload,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { OFFLINE_MOCK_PROVIDER_ID, db, repository } from '../../db/database';
import { commitZeroTouchAssetToDb } from '../../sync/autoPipelineCommit';
import {
  appendChildNode,
  deleteLeafNode,
  forkFromAncestor,
  getAncestorPath,
} from '../../domain/dag';
import { compilePrompt, type PromptSheetLayout } from '../../domain/promptCompiler';
import type { SpriteNode } from '../../domain/schemas';
import {
  buildSpriteAnimationArtifacts,
  selectDefaultAnimationNodeIds,
} from '../../export/animationExporter';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { CanvasHistory } from '../../processing/history';
import { sha256Bytes } from '../../processing/hash';
import {
  base64ToUint8,
  decodePngBytesToRgba,
  encodeRgbaToPngBytes,
  rgbaToPngBlob,
  uint8ToBase64,
} from '../../processing/png';
import { runAutoPixelPolishPipeline } from '../../processing/pixelPolish';
import { selectStyleLockAnchors } from '../../ai/styleLockGate';
import {
  AntigravityBridgeProvider,
  selectStatefulInteractionChain,
} from '../../providers/antigravityBridgeProvider';
import {
  buildAntigravityPromptBrief,
  type ExportAnimatedGifBridgeOptions,
  type NibgridAgentBridge,
} from '../../providers/antigravityProvider';
import type { BridgeCritiqueResponse } from '../../providers/bridgeContract';
import { ProviderError } from '../../providers/errors';
import { resolveProviderAdapter } from '../../providers/registry';
import type { GoldenReferencePayload } from '../../providers/types';
import { useAppStore } from '../../store/useAppStore';
import { normalizeSketchInWorker } from '../../workers/normalizeClient';
import { AnimationStudioModal } from './AnimationStudioModal';
import { CompareSplitModal } from './CompareSplitModal';
import { DagTreeDock } from './DagTreeDock';
import { GenerationInspector } from './GenerationInspector';

export type StudioTool = 'sketch-pen' | 'sketch-eraser' | 'mask-brush' | 'mask-eraser' | 'pan';
export type ViewportBackdrop = 'checkerboard' | 'dark' | 'light';

function createBlankWhiteRgba(width: number, height: number): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  buf.fill(255);
  return buf;
}

async function decodeBlobToRgba(
  blob: Blob,
  targetWidth: number,
  targetHeight: number,
  fitMode: 'stretch' | 'contain-white',
): Promise<{
  rgba: Uint8ClampedArray;
  sourceRgba: Uint8ClampedArray;
  sourceWidth: number;
  sourceHeight: number;
}> {
  const bitmap = await createImageBitmap(blob);
  const srcCanvas = document.createElement('canvas');
  const dstCanvas = document.createElement('canvas');
  try {
    srcCanvas.width = bitmap.width;
    srcCanvas.height = bitmap.height;
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) {
      throw new Error('Could not initialize 2D canvas context for decoding.');
    }
    srcCtx.drawImage(bitmap, 0, 0);
    const sourceRgba = new Uint8ClampedArray(
      srcCtx.getImageData(0, 0, bitmap.width, bitmap.height).data,
    );

    dstCanvas.width = targetWidth;
    dstCanvas.height = targetHeight;
    const dstCtx = dstCanvas.getContext('2d');
    if (!dstCtx) {
      throw new Error('Could not initialize 2D canvas context for sizing.');
    }
    dstCtx.fillStyle = '#FFFFFF';
    dstCtx.fillRect(0, 0, targetWidth, targetHeight);

    if (fitMode === 'stretch' || (bitmap.width === targetWidth && bitmap.height === targetHeight)) {
      dstCtx.drawImage(bitmap, 0, 0, targetWidth, targetHeight);
    } else {
      const scale = Math.min(targetWidth / bitmap.width, targetHeight / bitmap.height);
      const drawW = Math.max(1, Math.round(bitmap.width * scale));
      const drawH = Math.max(1, Math.round(bitmap.height * scale));
      const dx = Math.floor((targetWidth - drawW) / 2);
      const dy = Math.floor((targetHeight - drawH) / 2);
      dstCtx.drawImage(bitmap, dx, dy, drawW, drawH);
    }

    const rgba = new Uint8ClampedArray(dstCtx.getImageData(0, 0, targetWidth, targetHeight).data);
    return {
      rgba,
      sourceRgba,
      sourceWidth: bitmap.width,
      sourceHeight: bitmap.height,
    };
  } finally {
    bitmap.close();
    srcCanvas.width = 0;
    srcCanvas.height = 0;
    dstCanvas.width = 0;
    dstCanvas.height = 0;
  }
}

function paintDiskOnRgba(
  buffer: Uint8ClampedArray,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  colorValue: number,
): void {
  const r2 = radius * radius;
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(height - 1, Math.ceil(cy + radius));
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(width - 1, Math.ceil(cx + radius));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        const idx = (y * width + x) * 4;
        buffer[idx] = colorValue;
        buffer[idx + 1] = colorValue;
        buffer[idx + 2] = colorValue;
        buffer[idx + 3] = 255;
      }
    }
  }
}

function paintDiskOnMask(
  mask: Uint8Array,
  width: number,
  height: number,
  cx: number,
  cy: number,
  radius: number,
  value: 0 | 1,
): void {
  const r2 = radius * radius;
  const minY = Math.max(0, Math.floor(cy - radius));
  const maxY = Math.min(height - 1, Math.ceil(cy + radius));
  const minX = Math.max(0, Math.floor(cx - radius));
  const maxX = Math.min(width - 1, Math.ceil(cx + radius));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r2) {
        mask[y * width + x] = value;
      }
    }
  }
}

function interpolateLine(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  plot: (x: number, y: number) => void,
): void {
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const steps = Math.max(1, Math.max(dx, dy));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    plot(Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t));
  }
}

export function SpriteStudio() {
  const {
    activeProject,
    spriteNodes,
    providers,
    selectedProviderId,
    setSelectedProviderId,
    studioAdherence: adherence,
    setStudioAdherence: setAdherence,
    studioVariantCount: variantCount,
    setStudioVariantCount: setVariantCount,
    refreshSpriteNodes,
    refreshEntities,
    refreshAudioAssets,
    navigate,
  } = useAppStore();

  const targetWidth = activeProject?.artBible.targetWidth ?? 128;
  const targetHeight = activeProject?.artBible.targetHeight ?? 128;

  const [tool, setTool] = useState<StudioTool>('sketch-pen');
  const [brushSize, setBrushSize] = useState(4);
  const [zoomPercent, setZoomPercent] = useState(300);
  const [panOffset, setPanOffset] = useState({ x: 0, y: 0 });
  const [showPixelGrid, setShowPixelGrid] = useState(true);
  const [backdrop, setBackdrop] = useState<ViewportBackdrop>('checkerboard');
  const [showMask, setShowMask] = useState(true);
  const [isNormalized, setIsNormalized] = useState(false);
  const [isNormalizing, setIsNormalizing] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [maskPixelCount, setMaskPixelCount] = useState(0);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [forkParentId, setForkParentId] = useState<string | null>(null);
  const [promptDelta, setPromptDelta] = useState('');
  const [sheetMode, setSheetMode] = useState<PromptSheetLayout>('single');
  const [seed, setSeed] = useState(1024);
  const [isGenerating, setIsGenerating] = useState(false);
  const [autoAssembling, setAutoAssembling] = useState(false);
  const [compareNodes, setCompareNodes] = useState<{ leftId: string; rightId: string } | null>(
    null,
  );
  const [animationStudioOpen, setAnimationStudioOpen] = useState(false);
  const [bridgeCritique, setBridgeCritique] = useState<BridgeCritiqueResponse | null>(null);
  const [chainNotice, setChainNotice] = useState<string | null>(null);
  const [autoPolishEnabled, setAutoPolishEnabled] = useState(false);
  const [polishSummary, setPolishSummary] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<{
    message: string;
    remediation?: string;
  } | null>(null);

  const generationAbortRef = useRef<AbortController | null>(null);
  const pendingSketchUploadRef = useRef<Promise<SpriteNode | null> | null>(null);

  useEffect(() => {
    return () => {
      generationAbortRef.current?.abort();
    };
  }, [activeProject?.id]);

  const sketchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);

  const sketchBufferRef = useRef<Uint8ClampedArray>(
    createBlankWhiteRgba(targetWidth, targetHeight),
  );
  const maskBufferRef = useRef<Uint8Array>(new Uint8Array(targetWidth * targetHeight));
  const historyRef = useRef<CanvasHistory>(new CanvasHistory(sketchBufferRef.current, 20));
  const rawSourceRef = useRef<{
    rgba: Uint8ClampedArray;
    width: number;
    height: number;
  } | null>(null);
  const preNormalizeCanvasRef = useRef<Uint8ClampedArray | null>(null);
  const lastLoadedNodeIdRef = useRef<string | null>(null);

  const drawingRef = useRef<{
    active: boolean;
    lastX: number;
    lastY: number;
    panStartClientX: number;
    panStartClientY: number;
    panStartOffsetX: number;
    panStartOffsetY: number;
  }>({
    active: false,
    lastX: 0,
    lastY: 0,
    panStartClientX: 0,
    panStartClientY: 0,
    panStartOffsetX: 0,
    panStartOffsetY: 0,
  });

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(historyRef.current.canUndo());
    setCanRedo(historyRef.current.canRedo());
  }, []);

  const renderSketchCanvas = useCallback(() => {
    const canvas = sketchCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = activeProject?.artBible.artMode === 'hd-2d';
    const buf = sketchBufferRef.current;
    if (buf.length !== targetWidth * targetHeight * 4) return;
    const imageData = new ImageData(new Uint8ClampedArray(buf), targetWidth, targetHeight);
    ctx.putImageData(imageData, 0, 0);
  }, [targetWidth, targetHeight, activeProject?.artBible.artMode]);

  const renderMaskCanvas = useCallback(() => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = activeProject?.artBible.artMode === 'hd-2d';
    const mask = maskBufferRef.current;
    if (mask.length !== targetWidth * targetHeight) return;

    const rgba = new Uint8ClampedArray(targetWidth * targetHeight * 4);
    let count = 0;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) {
        count++;
        const px = i * 4;
        rgba[px] = 239;
        rgba[px + 1] = 68;
        rgba[px + 2] = 68;
        rgba[px + 3] = 140;
      }
    }
    setMaskPixelCount(count);
    const imageData = new ImageData(rgba, targetWidth, targetHeight);
    ctx.putImageData(imageData, 0, 0);
  }, [targetWidth, targetHeight, activeProject?.artBible.artMode]);

  // Initialize buffers when project or target dimensions change
  useEffect(() => {
    const blank = createBlankWhiteRgba(targetWidth, targetHeight);
    sketchBufferRef.current = blank;
    maskBufferRef.current = new Uint8Array(targetWidth * targetHeight);
    historyRef.current = new CanvasHistory(blank, 20);
    rawSourceRef.current = null;
    preNormalizeCanvasRef.current = null;
    lastLoadedNodeIdRef.current = null;
    setActiveNodeId(null);
    setForkParentId(null);
    setCompareNodes(null);
    setAnimationStudioOpen(false);
    setIsNormalized(false);
    syncHistoryFlags();
    renderSketchCanvas();
    renderMaskCanvas();
  }, [
    activeProject?.id,
    targetWidth,
    targetHeight,
    renderSketchCanvas,
    renderMaskCanvas,
    syncHistoryFlags,
  ]);

  // Hydrate canvas from IndexedDB when opening a project with existing nodes
  useEffect(() => {
    if (!activeProject || spriteNodes.length === 0) return;
    if (
      activeNodeId &&
      lastLoadedNodeIdRef.current === activeNodeId &&
      !spriteNodes.some((n) => n.id === activeNodeId)
    ) {
      return;
    }
    const targetNode =
      (activeNodeId ? spriteNodes.find((n) => n.id === activeNodeId) : undefined) ??
      spriteNodes[spriteNodes.length - 1];
    if (!targetNode || lastLoadedNodeIdRef.current === targetNode.id) return;

    let cancelled = false;
    void repository.getBlob(targetNode.imageBlobId).then(async (blobRecord) => {
      if (cancelled || !blobRecord) return;
      const decoded = await decodeBlobToRgba(
        blobRecord.bytes,
        targetWidth,
        targetHeight,
        'stretch',
      );
      if (cancelled) return;
      lastLoadedNodeIdRef.current = targetNode.id;
      sketchBufferRef.current = decoded.rgba;
      historyRef.current.reset(decoded.rgba);
      setActiveNodeId(targetNode.id);
      setForkParentId((prev) => prev ?? targetNode.id);
      syncHistoryFlags();
      renderSketchCanvas();
    });
    return () => {
      cancelled = true;
    };
  }, [
    activeProject,
    spriteNodes,
    activeNodeId,
    targetWidth,
    targetHeight,
    renderSketchCanvas,
    syncHistoryFlags,
  ]);

  const persistRootSketchNode = useCallback(
    async (rgba: Uint8ClampedArray, label: string) => {
      if (!activeProject) return undefined;
      const targetProjectId = activeProject.id;
      const pngBlob = rgbaToPngBlob(rgba, targetWidth, targetHeight);
      const blobRecord = await repository.storeBlob(pngBlob, 'image/png');
      const currentNodes = await repository.listSpriteNodes(targetProjectId);
      if (useAppStore.getState().activeProject?.id !== targetProjectId) {
        return undefined;
      }

      const existingSketchRoot = currentNodes.find(
        (n) => n.kind === 'sketch' && n.parentId === null,
      );
      const hasChildren =
        existingSketchRoot && currentNodes.some((n) => n.parentId === existingSketchRoot.id);

      const nodeId =
        existingSketchRoot && !hasChildren ? existingSketchRoot.id : globalThis.crypto.randomUUID();

      const node: SpriteNode = {
        id: nodeId,
        projectId: targetProjectId,
        parentId: null,
        kind: 'sketch',
        imageBlobId: blobRecord.id,
        sketchSha256: blobRecord.sha256,
        generationMeta: {
          providerId: OFFLINE_MOCK_PROVIDER_ID,
          modelId: 'sketch-input',
          seed: 0,
          adherence: 'strict',
          promptDelta: label,
          compiledPrompt: label,
          createdAt:
            existingSketchRoot && !hasChildren
              ? existingSketchRoot.generationMeta.createdAt
              : new Date().toISOString(),
        },
      };

      lastLoadedNodeIdRef.current = node.id;
      await repository.saveSpriteNode(node);
      if (useAppStore.getState().activeProject?.id !== targetProjectId) {
        return undefined;
      }
      setActiveNodeId(node.id);
      setForkParentId(node.id);
      await refreshSpriteNodes(targetProjectId);
      return node;
    },
    [activeProject, targetWidth, targetHeight, refreshSpriteNodes],
  );

  const clientToCanvasCoords = (clientX: number, clientY: number): { x: number; y: number } => {
    const stage = stageRef.current;
    if (!stage) return { x: 0, y: 0 };
    const rect = stage.getBoundingClientRect();
    const normX = (clientX - rect.left) / Math.max(1, rect.width);
    const normY = (clientY - rect.top) / Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(targetWidth - 1, Math.floor(normX * targetWidth))),
      y: Math.max(0, Math.min(targetHeight - 1, Math.floor(normY * targetHeight))),
    };
  };

  const applyStrokeSegment = (x0: number, y0: number, x1: number, y1: number) => {
    const radius = Math.max(0.5, brushSize / 2);
    if (tool === 'sketch-pen' || tool === 'sketch-eraser') {
      const colorVal = tool === 'sketch-pen' ? 0 : 255;
      interpolateLine(x0, y0, x1, y1, (x, y) =>
        paintDiskOnRgba(sketchBufferRef.current, targetWidth, targetHeight, x, y, radius, colorVal),
      );
      renderSketchCanvas();
    } else if (tool === 'mask-brush' || tool === 'mask-eraser') {
      const maskVal: 0 | 1 = tool === 'mask-brush' ? 1 : 0;
      interpolateLine(x0, y0, x1, y1, (x, y) =>
        paintDiskOnMask(maskBufferRef.current, targetWidth, targetHeight, x, y, radius, maskVal),
      );
      renderMaskCanvas();
    }
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    if (tool === 'pan' || event.button === 1 || event.shiftKey) {
      drawingRef.current = {
        ...drawingRef.current,
        active: true,
        panStartClientX: event.clientX,
        panStartClientY: event.clientY,
        panStartOffsetX: panOffset.x,
        panStartOffsetY: panOffset.y,
      };
      return;
    }

    const { x, y } = clientToCanvasCoords(event.clientX, event.clientY);
    drawingRef.current = {
      ...drawingRef.current,
      active: true,
      lastX: x,
      lastY: y,
    };
    applyStrokeSegment(x, y, x, y);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drawingRef.current.active) return;

    if (tool === 'pan' || event.shiftKey) {
      const dx = event.clientX - drawingRef.current.panStartClientX;
      const dy = event.clientY - drawingRef.current.panStartClientY;
      setPanOffset({
        x: drawingRef.current.panStartOffsetX + dx,
        y: drawingRef.current.panStartOffsetY + dy,
      });
      return;
    }

    const { x, y } = clientToCanvasCoords(event.clientX, event.clientY);
    applyStrokeSegment(drawingRef.current.lastX, drawingRef.current.lastY, x, y);
    drawingRef.current.lastX = x;
    drawingRef.current.lastY = y;
  };

  const handlePointerUp = async () => {
    if (!drawingRef.current.active) return;
    drawingRef.current.active = false;

    if (tool === 'sketch-pen' || tool === 'sketch-eraser') {
      historyRef.current.push(sketchBufferRef.current);
      rawSourceRef.current = {
        rgba: new Uint8ClampedArray(sketchBufferRef.current),
        width: targetWidth,
        height: targetHeight,
      };
      setIsNormalized(false);
      syncHistoryFlags();
      await persistRootSketchNode(sketchBufferRef.current, 'hand-drawn sketch');
    }
  };

  const handleUndo = useCallback(() => {
    const prev = historyRef.current.undo();
    if (!prev) return;
    sketchBufferRef.current = prev;
    syncHistoryFlags();
    renderSketchCanvas();
  }, [renderSketchCanvas, syncHistoryFlags]);

  const handleRedo = useCallback(() => {
    const next = historyRef.current.redo();
    if (!next) return;
    sketchBufferRef.current = next;
    syncHistoryFlags();
    renderSketchCanvas();
  }, [renderSketchCanvas, syncHistoryFlags]);

  const toolBeforeSpaceRef = useRef<StudioTool | null>(null);
  const currentToolRef = useRef(tool);
  currentToolRef.current = tool;

  useEffect(() => {
    const isEditableElement = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableElement(event.target)) return;

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }

      if (event.code === 'Space' && !event.repeat) {
        event.preventDefault();
        if (currentToolRef.current !== 'pan') {
          toolBeforeSpaceRef.current = currentToolRef.current;
          setTool('pan');
        }
        return;
      }

      const lower = event.key.toLowerCase();
      if (lower === 'b') {
        setTool('sketch-pen');
      } else if (lower === 'e') {
        setTool('sketch-eraser');
      } else if (lower === 'm') {
        setTool((prev) => (prev === 'mask-brush' ? 'sketch-pen' : 'mask-brush'));
      } else if (lower === 'g') {
        setShowPixelGrid((prev) => !prev);
      }
    };

    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Space' && toolBeforeSpaceRef.current) {
        setTool(toolBeforeSpaceRef.current);
        toolBeforeSpaceRef.current = null;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleUndo, handleRedo]);

  const handleClearSketch = async () => {
    const blank = createBlankWhiteRgba(targetWidth, targetHeight);
    sketchBufferRef.current = blank;
    rawSourceRef.current = null;
    preNormalizeCanvasRef.current = null;
    setIsNormalized(false);
    historyRef.current.push(blank);
    syncHistoryFlags();
    renderSketchCanvas();
    await persistRootSketchNode(blank, 'blank canvas');
  };

  const handleClearMask = () => {
    maskBufferRef.current = new Uint8Array(targetWidth * targetHeight);
    renderMaskCanvas();
  };

  const handleUploadSketch = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    const startedProjectId = activeProject?.id;
    const uploadPromise = (async (): Promise<SpriteNode | null> => {
      try {
        const decoded = await decodeBlobToRgba(file, targetWidth, targetHeight, 'contain-white');
        if (!startedProjectId || useAppStore.getState().activeProject?.id !== startedProjectId) {
          return null;
        }
        rawSourceRef.current = {
          rgba: decoded.sourceRgba,
          width: decoded.sourceWidth,
          height: decoded.sourceHeight,
        };
        preNormalizeCanvasRef.current = new Uint8ClampedArray(decoded.rgba);
        sketchBufferRef.current = decoded.rgba;
        historyRef.current.push(decoded.rgba);
        setIsNormalized(false);
        syncHistoryFlags();
        renderSketchCanvas();
        const saved = await persistRootSketchNode(decoded.rgba, `uploaded sketch: ${file.name}`);
        if (useAppStore.getState().activeProject?.id === startedProjectId) {
          setStatusMessage(
            `Loaded sketch "${file.name}" (${decoded.sourceWidth}×${decoded.sourceHeight}).`,
          );
        }
        return saved ?? null;
      } catch (error) {
        if (!startedProjectId || useAppStore.getState().activeProject?.id === startedProjectId) {
          setStatusMessage(
            error instanceof Error ? error.message : 'Failed to decode uploaded sketch.',
          );
        }
        return null;
      }
    })();

    pendingSketchUploadRef.current = uploadPromise;
    try {
      await uploadPromise;
    } finally {
      if (pendingSketchUploadRef.current === uploadPromise) {
        pendingSketchUploadRef.current = null;
      }
    }
  };

  const handleToggleNormalize = async () => {
    if (isNormalizing) return;
    if (pendingSketchUploadRef.current) {
      await pendingSketchUploadRef.current;
    }

    if (isNormalized && preNormalizeCanvasRef.current) {
      const restored = new Uint8ClampedArray(preNormalizeCanvasRef.current);
      sketchBufferRef.current = restored;
      historyRef.current.push(restored);
      setIsNormalized(false);
      syncHistoryFlags();
      renderSketchCanvas();
      await persistRootSketchNode(restored, 'raw sketch');
      setStatusMessage('Restored pre-normalization sketch.');
      return;
    }

    setIsNormalizing(true);
    setStatusMessage('Normalizing in Web Worker...');
    try {
      preNormalizeCanvasRef.current = new Uint8ClampedArray(sketchBufferRef.current);
      const source = rawSourceRef.current ?? {
        rgba: new Uint8ClampedArray(sketchBufferRef.current),
        width: targetWidth,
        height: targetHeight,
      };
      const result = await normalizeSketchInWorker({
        rgba: source.rgba,
        width: source.width,
        height: source.height,
        targetWidth,
        targetHeight,
        marginRatio: 0.1,
      });

      const verifyDigest = await sha256Bytes(
        encodeRgbaToPngBytes(result.normalizedRgba, targetWidth, targetHeight),
      );
      if (verifyDigest !== result.sha256) {
        throw new Error('Normalized buffer SHA-256 verification failed.');
      }

      sketchBufferRef.current = result.normalizedRgba;
      historyRef.current.push(result.normalizedRgba);
      setIsNormalized(true);
      syncHistoryFlags();
      renderSketchCanvas();
      await persistRootSketchNode(result.normalizedRgba, 'normalized sketch');
      setStatusMessage(`Normalized & centered (${result.sha256.slice(0, 8)}…).`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Normalization failed.');
    } finally {
      setIsNormalizing(false);
    }
  };

  const activeViewportNode =
    (activeNodeId ? spriteNodes.find((n) => n.id === activeNodeId) : undefined) ??
    spriteNodes[spriteNodes.length - 1] ??
    null;

  const activeParentNode =
    (forkParentId ? spriteNodes.find((n) => n.id === forkParentId) : undefined) ??
    activeViewportNode;

  const handleSelectNode = (nodeId: string) => {
    setActiveNodeId(nodeId);
    setForkParentId(nodeId);
  };

  const handleForkNode = (nodeId: string) => {
    try {
      const ancestor = forkFromAncestor(spriteNodes, nodeId);
      setForkParentId(ancestor.id);
      setStatusMessage(
        `Fork parent set to ${ancestor.kind} (seed #${ancestor.generationMeta.seed}).`,
      );
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Failed to fork node.');
    }
  };

  const handleCompareNode = (nodeId: string) => {
    if (spriteNodes.length < 2) return;
    const clicked =
      spriteNodes.find((n) => n.id === nodeId) ?? spriteNodes[spriteNodes.length - 1]!;
    const fallbackLeft =
      spriteNodes.find((n) => n.id === clicked.parentId) ??
      spriteNodes.find((n) => n.id !== clicked.id) ??
      clicked;
    setCompareNodes({ leftId: fallbackLeft.id, rightId: clicked.id });
  };

  const handleDeleteLeafNode = async (nodeId: string) => {
    if (!activeProject) return;
    try {
      const target = spriteNodes.find((n) => n.id === nodeId);
      deleteLeafNode(spriteNodes, nodeId);
      await repository.deleteSpriteNode(nodeId);
      if (activeNodeId === nodeId) {
        const nextActive = target?.parentId ?? null;
        lastLoadedNodeIdRef.current = null;
        setActiveNodeId(nextActive);
        setForkParentId(nextActive);
      }
      if (forkParentId === nodeId) {
        setForkParentId(target?.parentId ?? null);
      }
      await refreshSpriteNodes(activeProject.id);
      setStatusMessage('Deleted leaf node and pruned orphaned blobs.');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Cannot delete node.');
    }
  };

  const loadGoldenReferencePayloads = useCallback(async (): Promise<GoldenReferencePayload[]> => {
    if (!activeProject) return [];
    const anchorIds = selectStyleLockAnchors(
      activeProject.artBible.goldenReferenceBlobIds,
      spriteNodes,
      2,
    );
    const results: GoldenReferencePayload[] = [];
    for (const blobId of anchorIds) {
      const record = await repository.getBlob(blobId);
      if (record) {
        const bytes = new Uint8Array(await record.bytes.arrayBuffer());
        results.push({ mimeType: record.mimeType || 'image/png', bytes });
      }
    }
    return results;
  }, [activeProject, spriteNodes]);

  const handleToggleAutoPolish = async (enabled: boolean) => {
    setAutoPolishEnabled(enabled);
    if (!enabled) {
      setPolishSummary(null);
      return;
    }
    if (!activeProject) return;

    const polished = runAutoPixelPolishPipeline(
      sketchBufferRef.current,
      targetWidth,
      targetHeight,
      activeProject.artBible.palette,
    );
    sketchBufferRef.current = polished.data;
    historyRef.current.push(polished.data);
    syncHistoryFlags();
    renderSketchCanvas();

    const targetNode = activeViewportNode;
    if (targetNode) {
      const pngBytes = encodeRgbaToPngBytes(polished.data, targetWidth, targetHeight);
      const blobRecord = await repository.storeBlobDeduplicated(pngBytes, 'image/png');
      await repository.saveSpriteNode({
        ...targetNode,
        processedBlobId: blobRecord.id,
      });
      await repository.cleanupOrphanedBlobs();
      await refreshSpriteNodes(activeProject.id);
    }

    const summary = `Palette-Locked · ${polished.detectedScale}x grid · ${polished.strippedPixels} orphan px cleaned`;
    setPolishSummary(summary);
    setStatusMessage(`Auto-Polish applied (${summary}).`);
  };

  const handleGenerate = async () => {
    if (!activeProject || isGenerating) return;
    const providerConfig = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
    if (!providerConfig) {
      setStatusMessage('No provider configured in Provider Vault.');
      return;
    }

    const startedProjectId = activeProject.id;
    const isStaleOrAborted = () =>
      abortController.signal.aborted ||
      useAppStore.getState().activeProject?.id !== startedProjectId;

    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setIsGenerating(true);
    setProviderError(null);
    setStatusMessage(`Generating ${variantCount} sprite variant(s)...`);

    try {
      let uploadedRoot: SpriteNode | null = null;
      if (pendingSketchUploadRef.current) {
        uploadedRoot = await pendingSketchUploadRef.current;
        if (isStaleOrAborted()) return;
      }

      const latestNodes = await repository.listSpriteNodes(startedProjectId);
      if (isStaleOrAborted()) return;

      let workingNodes = [...latestNodes];
      let parentNode =
        uploadedRoot ??
        (forkParentId ? latestNodes.find((n) => n.id === forkParentId) : undefined) ??
        (activeNodeId ? latestNodes.find((n) => n.id === activeNodeId) : undefined) ??
        latestNodes[latestNodes.length - 1] ??
        null;

      if (!parentNode) {
        const savedRoot = await persistRootSketchNode(sketchBufferRef.current, 'sketch root');
        if (!savedRoot) {
          throw new Error('Failed to persist root sketch node.');
        }
        workingNodes = [savedRoot];
        parentNode = savedRoot;
      }

      if (isStaleOrAborted()) return;

      const currentViewportNodeId = uploadedRoot?.id ?? activeViewportNode?.id;
      let sourceRgba: Uint8ClampedArray = new Uint8ClampedArray(sketchBufferRef.current);
      if (parentNode.id !== currentViewportNodeId) {
        const parentBlob = await repository.getBlob(parentNode.imageBlobId);
        if (parentBlob) {
          const decoded = await decodeBlobToRgba(
            parentBlob.bytes,
            targetWidth,
            targetHeight,
            'stretch',
          );
          sourceRgba = decoded.rgba;
        }
      }

      if (isStaleOrAborted()) return;

      const ancestry = getAncestorPath(workingNodes, parentNode.id);
      const rootSketchSha = ancestry[0]?.sketchSha256 ?? parentNode.sketchSha256;
      const compiled = compilePrompt(activeProject.artBible, {
        adherence,
        promptDelta,
        sheetLayout: sheetMode,
      });
      const adapter = resolveProviderAdapter(providerConfig);
      const goldenReferenceImages = await loadGoldenReferencePayloads();
      if (providerConfig.kind === 'antigravity-bridge') {
        const decision = selectStatefulInteractionChain(parentNode, providerConfig.id);
        setChainNotice(
          decision.reAnchoredReason ??
            (decision.usedStatefulChain ? 'Stateful chain linked' : null),
        );
      } else {
        setChainNotice(null);
      }
      setBridgeCritique(null);

      if (isStaleOrAborted()) return;

      const outputs = await adapter.generate(
        {
          config: providerConfig,
          artBible: activeProject.artBible,
          sketchRgba: sourceRgba,
          sketchWidth: targetWidth,
          sketchHeight: targetHeight,
          sketchSha256: rootSketchSha,
          seed,
          adherence,
          promptDelta,
          compiledPrompt: compiled.fullCompiledPrompt,
          variantCount,
          ...(sheetMode !== 'single' ? { turnaroundLayout: sheetMode } : {}),
          goldenReferenceImages,
          parentNode,
        },
        abortController.signal,
      );

      if (isStaleOrAborted()) return;

      const createdNodes: SpriteNode[] = [];
      for (const output of outputs) {
        if (isStaleOrAborted()) {
          await repository.cleanupOrphanedBlobs();
          return;
        }
        let storedBlob = output.blob;
        let processedBlobId: string | undefined;
        if (autoPolishEnabled) {
          const decoded = await decodePngBytesToRgba(
            new Uint8Array(await output.blob.arrayBuffer()),
          );
          const polished = runAutoPixelPolishPipeline(
            decoded.rgba,
            decoded.width,
            decoded.height,
            activeProject.artBible.palette,
          );
          const pngBytes = encodeRgbaToPngBytes(polished.data, polished.width, polished.height);
          const polishedRec = await repository.storeBlobDeduplicated(pngBytes, 'image/png');
          storedBlob = polishedRec.bytes;
          processedBlobId = polishedRec.id;
          setPolishSummary(
            `Palette-Locked · ${polished.detectedScale}x grid · ${polished.strippedPixels} orphan px cleaned`,
          );
        }
        const blobRecord = await repository.storeBlob(storedBlob, 'image/png');
        const childNode: SpriteNode = {
          id: globalThis.crypto.randomUUID(),
          projectId: startedProjectId,
          parentId: parentNode.id,
          kind: 'generation',
          imageBlobId: blobRecord.id,
          ...(processedBlobId ? { processedBlobId } : {}),
          sketchSha256: rootSketchSha,
          ...(sheetMode !== 'single'
            ? {
                turnaroundMeta: {
                  isTurnaroundSheet: true,
                  turnaroundLayout: sheetMode,
                },
              }
            : {}),
          generationMeta: {
            providerId: providerConfig.id,
            modelId: providerConfig.modelId,
            seed: output.seed,
            adherence,
            promptDelta,
            compiledPrompt: compiled.fullCompiledPrompt,
            createdAt: new Date(Date.now() + output.variantIndex).toISOString(),
            ...(output.interactionId ? { interactionId: output.interactionId } : {}),
            ...(output.parentInteractionId
              ? { parentInteractionId: output.parentInteractionId }
              : {}),
            ...(output.interactionExpiresAt
              ? { interactionExpiresAt: output.interactionExpiresAt }
              : {}),
            ...(output.usedStatefulChain !== undefined
              ? { usedStatefulChain: output.usedStatefulChain }
              : {}),
          },
        };
        if (isStaleOrAborted()) {
          await repository.cleanupOrphanedBlobs();
          return;
        }
        workingNodes = appendChildNode(workingNodes, childNode);
        await repository.saveSpriteNode(childNode);
        createdNodes.push(childNode);
      }

      if (isStaleOrAborted()) return;

      const firstOutput = outputs[0];
      const firstNode = createdNodes[0];
      if (firstOutput && firstNode) {
        lastLoadedNodeIdRef.current = firstNode.id;
        let displayRgba: Uint8ClampedArray;
        if (firstOutput.width === targetWidth && firstOutput.height === targetHeight) {
          displayRgba = new Uint8ClampedArray(firstOutput.rgba);
        } else {
          const resized = await decodeBlobToRgba(
            firstOutput.blob,
            targetWidth,
            targetHeight,
            'stretch',
          );
          if (isStaleOrAborted()) return;
          displayRgba = resized.rgba;
        }
        sketchBufferRef.current = displayRgba;
        historyRef.current.reset(displayRgba);
        syncHistoryFlags();
        renderSketchCanvas();
        setActiveNodeId(firstNode.id);
        setForkParentId(firstNode.id);

        if (adapter instanceof AntigravityBridgeProvider) {
          try {
            const critique = await adapter.critiqueSprite(
              providerConfig,
              firstOutput.pngBytes,
              activeProject.artBible,
              promptDelta,
              abortController.signal,
            );
            if (!isStaleOrAborted()) {
              setBridgeCritique(critique);
            }
          } catch {
            // Optional critique check failures never fail an already succeeded generation
          }
        }
      }

      await refreshSpriteNodes(startedProjectId);
      setStatusMessage(`Generated ${createdNodes.length} variant(s) under ${parentNode.kind}.`);
    } catch (error) {
      if (
        abortController.signal.aborted ||
        (error instanceof ProviderError && error.code === 'ABORTED')
      ) {
        if (useAppStore.getState().activeProject?.id === startedProjectId) {
          setStatusMessage('Generation cancelled.');
        }
      } else if (useAppStore.getState().activeProject?.id === startedProjectId) {
        if (error instanceof ProviderError) {
          setProviderError({ message: error.message, remediation: error.remediation });
        } else {
          setProviderError({
            message: error instanceof Error ? error.message : 'Generation failed.',
          });
        }
        setStatusMessage(null);
      }
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
      if (useAppStore.getState().activeProject?.id === startedProjectId) {
        setIsGenerating(false);
      }
    }
  };

  const handleInpaint = async () => {
    if (!activeProject || isGenerating || !activeViewportNode || maskPixelCount === 0) return;
    const providerConfig = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
    if (!providerConfig) return;

    const startedProjectId = activeProject.id;
    const isStaleOrAborted = () =>
      abortController.signal.aborted ||
      useAppStore.getState().activeProject?.id !== startedProjectId;

    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setIsGenerating(true);
    setProviderError(null);
    setStatusMessage('Inpainting masked region...');

    try {
      const maskRgba = new Uint8ClampedArray(targetWidth * targetHeight * 4);
      for (let i = 0; i < maskBufferRef.current.length; i++) {
        if (maskBufferRef.current[i] === 1) {
          const px = i * 4;
          maskRgba[px] = 255;
          maskRgba[px + 1] = 255;
          maskRgba[px + 2] = 255;
          maskRgba[px + 3] = 255;
        } else {
          maskRgba[i * 4 + 3] = 255;
        }
      }
      const maskBlob = rgbaToPngBlob(maskRgba, targetWidth, targetHeight);

      const compiled = compilePrompt(activeProject.artBible, { adherence, promptDelta });
      const adapter = resolveProviderAdapter(providerConfig);
      const goldenReferenceImages = await loadGoldenReferencePayloads();

      if (isStaleOrAborted()) return;

      const outputs = await adapter.inpaint(
        {
          config: providerConfig,
          artBible: activeProject.artBible,
          sketchRgba: sketchBufferRef.current,
          baseImageRgba: sketchBufferRef.current,
          mask: maskBufferRef.current,
          sketchWidth: targetWidth,
          sketchHeight: targetHeight,
          sketchSha256: activeViewportNode.sketchSha256,
          seed,
          adherence,
          promptDelta,
          compiledPrompt: compiled.fullCompiledPrompt,
          variantCount: 1,
          goldenReferenceImages,
          parentNode: activeViewportNode,
        },
        abortController.signal,
      );

      if (isStaleOrAborted()) return;

      const inpaintOutput = outputs[0];
      if (!inpaintOutput) {
        throw new Error('Provider returned zero inpaint outputs.');
      }

      const maskBlobRecord = await repository.storeBlob(maskBlob, 'image/png');
      const imageBlobRecord = await repository.storeBlob(inpaintOutput.blob, 'image/png');
      if (isStaleOrAborted()) {
        await repository.cleanupOrphanedBlobs();
        return;
      }

      const inpaintNode: SpriteNode = {
        id: globalThis.crypto.randomUUID(),
        projectId: startedProjectId,
        parentId: activeViewportNode.id,
        kind: 'inpaint',
        imageBlobId: imageBlobRecord.id,
        maskBlobId: maskBlobRecord.id,
        sketchSha256: activeViewportNode.sketchSha256,
        generationMeta: {
          providerId: providerConfig.id,
          modelId: providerConfig.modelId,
          seed: inpaintOutput.seed,
          adherence,
          promptDelta: promptDelta || 'masked inpaint refinement',
          compiledPrompt: compiled.fullCompiledPrompt,
          createdAt: new Date().toISOString(),
          ...(inpaintOutput.interactionId ? { interactionId: inpaintOutput.interactionId } : {}),
          ...(inpaintOutput.parentInteractionId
            ? { parentInteractionId: inpaintOutput.parentInteractionId }
            : {}),
          ...(inpaintOutput.interactionExpiresAt
            ? { interactionExpiresAt: inpaintOutput.interactionExpiresAt }
            : {}),
          ...(inpaintOutput.usedStatefulChain !== undefined
            ? { usedStatefulChain: inpaintOutput.usedStatefulChain }
            : {}),
        },
      };

      appendChildNode(spriteNodes, inpaintNode);
      await repository.saveSpriteNode(inpaintNode);
      if (isStaleOrAborted()) return;

      lastLoadedNodeIdRef.current = inpaintNode.id;
      let displayRgba: Uint8ClampedArray;
      if (inpaintOutput.width === targetWidth && inpaintOutput.height === targetHeight) {
        displayRgba = new Uint8ClampedArray(inpaintOutput.rgba);
      } else {
        const resized = await decodeBlobToRgba(
          inpaintOutput.blob,
          targetWidth,
          targetHeight,
          'stretch',
        );
        if (isStaleOrAborted()) return;
        displayRgba = resized.rgba;
      }
      lastLoadedNodeIdRef.current = inpaintNode.id;
      sketchBufferRef.current = displayRgba;
      historyRef.current.reset(displayRgba);
      maskBufferRef.current = new Uint8Array(targetWidth * targetHeight);
      syncHistoryFlags();
      renderSketchCanvas();
      renderMaskCanvas();
      setActiveNodeId(inpaintNode.id);
      setForkParentId(inpaintNode.id);

      await refreshSpriteNodes(startedProjectId);
      setStatusMessage(`Created inpaint child node (seed #${inpaintNode.generationMeta.seed}).`);
    } catch (error) {
      if (
        abortController.signal.aborted ||
        (error instanceof ProviderError && error.code === 'ABORTED')
      ) {
        if (useAppStore.getState().activeProject?.id === startedProjectId) {
          setStatusMessage('Inpainting cancelled.');
        }
      } else if (useAppStore.getState().activeProject?.id === startedProjectId) {
        if (error instanceof ProviderError) {
          setProviderError({ message: error.message, remediation: error.remediation });
        } else {
          setProviderError({
            message: error instanceof Error ? error.message : 'Inpainting failed.',
          });
        }
        setStatusMessage(null);
      }
    } finally {
      if (generationAbortRef.current === abortController) {
        generationAbortRef.current = null;
      }
      if (useAppStore.getState().activeProject?.id === startedProjectId) {
        setIsGenerating(false);
      }
    }
  };

  const getAgentBriefText = useCallback((): string => {
    if (!activeProject) return '';
    const mode = maskPixelCount > 0 && activeViewportNode ? 'inpaint' : 'generate';
    const compiled = compilePrompt(activeProject.artBible, {
      adherence,
      promptDelta,
      sheetLayout: mode === 'generate' ? sheetMode : 'single',
    });
    return buildAntigravityPromptBrief({
      projectName: activeProject.name,
      artBible: activeProject.artBible,
      adherence,
      seed,
      promptDelta,
      compiledPrompt: compiled.fullCompiledPrompt,
      negativePrompt: compiled.negativePrompt,
      mode,
    });
  }, [activeProject, maskPixelCount, activeViewportNode, adherence, promptDelta, sheetMode, seed]);

  const handleCopyAgentBrief = async () => {
    if (!activeProject) return;
    const brief = getAgentBriefText();
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(brief);
    }
    setStatusMessage('Copied Antigravity IDE sprite brief to clipboard.');
  };

  const handleDownloadSketchForAgent = () => {
    if (!activeProject) return;
    const pngBlob = rgbaToPngBlob(sketchBufferRef.current, targetWidth, targetHeight);
    const filename = `${toAssetSlug(activeProject.name)}-sketch.png`;
    triggerBlobDownload(pngBlob, filename);
    setStatusMessage(`Exported "${filename}" for Antigravity IDE agent handoff.`);
  };

  const handleImportAgentSprite = useCallback(
    async (file: Blob, customPromptDelta?: string): Promise<string> => {
      if (!activeProject) {
        throw new Error('No active project open in Sprite Studio.');
      }
      const providerConfig = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
      if (!providerConfig) {
        throw new Error('No provider configured in Provider Vault.');
      }

      const startedProjectId = activeProject.id;
      let workingNodes = [...spriteNodes];
      let parentNode = activeParentNode;

      if (!parentNode) {
        const savedRoot = await persistRootSketchNode(sketchBufferRef.current, 'sketch root');
        if (!savedRoot) {
          throw new Error('Failed to persist root sketch node.');
        }
        workingNodes = [savedRoot];
        parentNode = savedRoot;
      }

      const decoded = await decodeBlobToRgba(file, targetWidth, targetHeight, 'stretch');
      if (useAppStore.getState().activeProject?.id !== startedProjectId) {
        return '';
      }

      const normalizedBlob =
        sheetMode !== 'single' && !maskPixelCount
          ? rgbaToPngBlob(decoded.sourceRgba, decoded.sourceWidth, decoded.sourceHeight)
          : rgbaToPngBlob(decoded.rgba, targetWidth, targetHeight);
      const imageBlobRecord = await repository.storeBlob(normalizedBlob, 'image/png');

      const isInpaintImport = maskPixelCount > 0 && Boolean(activeViewportNode);
      let maskBlobId: string | undefined;
      if (isInpaintImport) {
        const maskRgba = new Uint8ClampedArray(targetWidth * targetHeight * 4);
        for (let i = 0; i < maskBufferRef.current.length; i++) {
          if (maskBufferRef.current[i] === 1) {
            const px = i * 4;
            maskRgba[px] = 255;
            maskRgba[px + 1] = 255;
            maskRgba[px + 2] = 255;
            maskRgba[px + 3] = 255;
          } else {
            maskRgba[i * 4 + 3] = 255;
          }
        }
        const maskBlobRecord = await repository.storeBlob(
          rgbaToPngBlob(maskRgba, targetWidth, targetHeight),
          'image/png',
        );
        maskBlobId = maskBlobRecord.id;
      }

      const ancestry = getAncestorPath(workingNodes, parentNode.id);
      const rootSketchSha = ancestry[0]?.sketchSha256 ?? parentNode.sketchSha256;
      const effectiveDelta =
        customPromptDelta?.trim() || promptDelta.trim() || 'antigravity-ide import';
      const compiled = compilePrompt(activeProject.artBible, {
        adherence,
        promptDelta: effectiveDelta,
        sheetLayout: isInpaintImport ? 'single' : sheetMode,
      });

      const importedNode: SpriteNode = {
        id: globalThis.crypto.randomUUID(),
        projectId: startedProjectId,
        parentId: parentNode.id,
        kind: isInpaintImport ? 'inpaint' : 'generation',
        imageBlobId: imageBlobRecord.id,
        maskBlobId,
        sketchSha256: rootSketchSha,
        ...(!isInpaintImport && sheetMode !== 'single'
          ? {
              turnaroundMeta: {
                isTurnaroundSheet: true,
                turnaroundLayout: sheetMode,
              },
            }
          : {}),
        generationMeta: {
          providerId: providerConfig.id,
          modelId: providerConfig.modelId,
          seed,
          adherence,
          promptDelta: effectiveDelta,
          compiledPrompt: compiled.fullCompiledPrompt,
          createdAt: new Date().toISOString(),
        },
      };

      appendChildNode(workingNodes, importedNode);
      await repository.saveSpriteNode(importedNode);
      if (useAppStore.getState().activeProject?.id !== startedProjectId) {
        return '';
      }

      lastLoadedNodeIdRef.current = importedNode.id;
      sketchBufferRef.current = decoded.rgba;
      historyRef.current.reset(decoded.rgba);
      if (isInpaintImport) {
        maskBufferRef.current = new Uint8Array(targetWidth * targetHeight);
        renderMaskCanvas();
      }
      syncHistoryFlags();
      renderSketchCanvas();
      setActiveNodeId(importedNode.id);
      setForkParentId(importedNode.id);

      await refreshSpriteNodes(startedProjectId);
      setStatusMessage(`Imported Antigravity IDE sprite node (seed #${seed}).`);
      return importedNode.id;
    },
    [
      activeProject,
      providers,
      selectedProviderId,
      spriteNodes,
      activeParentNode,
      activeViewportNode,
      maskPixelCount,
      persistRootSketchNode,
      targetWidth,
      targetHeight,
      promptDelta,
      adherence,
      seed,
      renderMaskCanvas,
      syncHistoryFlags,
      renderSketchCanvas,
      refreshSpriteNodes,
      sheetMode,
    ],
  );

  const agentBridgeRef = useRef<NibgridAgentBridge | null>(null);
  agentBridgeRef.current = activeProject
    ? {
        getBrief: getAgentBriefText,
        getState: () => ({
          projectId: activeProject.id,
          projectName: activeProject.name,
          targetWidth,
          targetHeight,
          nodeCount: spriteNodes.length,
          activeNodeId: activeViewportNode?.id ?? null,
          selectedProviderId,
        }),
        importPngBase64: async (base64Png: string, promptDeltaOverride?: string) => {
          const cleanBase64 = base64Png.replace(/^data:image\/[^;]+;base64,/, '');
          const bytes = base64ToUint8(cleanBase64);
          const copy = new Uint8Array(bytes.byteLength);
          copy.set(bytes);
          return handleImportAgentSprite(
            new Blob([copy.buffer], { type: 'image/png' }),
            promptDeltaOverride,
          );
        },
        exportAnimatedGifBase64: async (options: ExportAnimatedGifBridgeOptions = {}) => {
          const selectedIds = selectDefaultAnimationNodeIds(spriteNodes);
          const orderedNodes = selectedIds
            .map((id) => spriteNodes.find((n) => n.id === id))
            .filter((n): n is SpriteNode => n !== undefined);
          const result = await buildSpriteAnimationArtifacts(orderedNodes, activeProject.artBible, {
            targetSize: options.targetSize ?? Math.min(256, targetWidth),
            autoCutout: options.autoCutout ?? true,
            tolerance: options.tolerance ?? 12,
            paletteSnap: activeProject.artBible.palette.length > 0,
            fps: options.fps ?? 6,
            pingPong: options.pingPong ?? true,
          });
          return {
            gifBase64: uint8ToBase64(result.gifBytes),
            spritesheetPngBase64: uint8ToBase64(result.spritesheetPngBytes),
            frameCount: result.frames.length,
            width: result.width,
            height: result.height,
          };
        },
      }
    : null;

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__NIBGRID_AGENT_BRIDGE__ = {
      getBrief: () => agentBridgeRef.current?.getBrief() ?? '',
      getState: () => {
        if (!agentBridgeRef.current) {
          throw new Error('No active Sprite Studio project mounted.');
        }
        return agentBridgeRef.current.getState();
      },
      importPngBase64: async (base64Png: string, promptDeltaOverride?: string) => {
        if (!agentBridgeRef.current) {
          throw new Error('No active Sprite Studio project mounted.');
        }
        return agentBridgeRef.current.importPngBase64(base64Png, promptDeltaOverride);
      },
      exportAnimatedGifBase64: async (options?: ExportAnimatedGifBridgeOptions) => {
        if (!agentBridgeRef.current) {
          throw new Error('No active Sprite Studio project mounted.');
        }
        return agentBridgeRef.current.exportAnimatedGifBase64(options);
      },
    };
    return () => {
      delete window.__NIBGRID_AGENT_BRIDGE__;
    };
  }, []);

  if (!activeProject) {
    return null;
  }

  const isPixelArt = activeProject.artBible.artMode === 'pixel-art';
  const canvasImageRendering = isPixelArt ? 'pixelated' : 'auto';
  const scale = zoomPercent / 100;
  const displayWidth = Math.round(targetWidth * scale);
  const displayHeight = Math.round(targetHeight * scale);

  const backdropClass =
    backdrop === 'checkerboard'
      ? 'bg-checkerboard'
      : backdrop === 'dark'
        ? 'bg-slate-950'
        : 'bg-slate-100';

  const handleAutoAssembleActiveSprite = async () => {
    if (!activeProject || !activeViewportNode || autoAssembling) return;
    setAutoAssembling(true);
    setProviderError(null);
    try {
      const res = await commitZeroTouchAssetToDb(db, activeProject, activeViewportNode);
      await Promise.all([
        refreshSpriteNodes(activeProject.id),
        refreshEntities(activeProject.id),
        refreshAudioAssets(activeProject.id),
      ]);
      setStatusMessage(
        `Auto-Assembled "${res.entity.slug}" (${res.pipelineResult.summarySteps.join(' · ')})`,
      );
    } catch (err) {
      setProviderError({
        message: err instanceof Error ? err.message : 'Auto-assemble entity failed.',
      });
    } finally {
      setAutoAssembling(false);
    }
  };

  return (
    <div data-testid="sprite-studio" className="flex flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-900/70 px-4 py-2.5">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-slate-100">{activeProject.name}</span>
          <span className="rounded border border-slate-700 bg-slate-950 px-2 py-0.5 font-mono text-xs text-slate-300">
            {targetWidth}×{targetHeight}
          </span>
          <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-xs text-indigo-300">
            {activeProject.artBible.projection} · {activeProject.artBible.artMode}
          </span>
        </div>

        <div className="flex items-center gap-3">
          {statusMessage && (
            <span data-testid="studio-status" className="text-xs text-emerald-300">
              {statusMessage}
            </span>
          )}
          {activeViewportNode && (
            <>
              <button
                type="button"
                data-testid="auto-assemble-entity-btn"
                disabled={autoAssembling}
                onClick={() => void handleAutoAssembleActiveSprite()}
                className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/45 bg-emerald-500/15 px-3 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
                title="Run zero-touch pipeline: Cutout, Palette, Normal/Emission, Collider, Sockets, Shader, SFX & Entity .tscn"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {autoAssembling ? 'Assembling...' : 'Auto-Assemble Entity'}
              </button>
              <button
                type="button"
                data-testid="open-postprocess-btn"
                onClick={() =>
                  void navigate({
                    screen: 'inspector',
                    projectId: activeProject.id,
                    nodeId: activeViewportNode.id,
                  })
                }
                className="rounded-md bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500"
              >
                Post-Process & Export
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => void navigate({ screen: 'bible', projectId: activeProject.id })}
            className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            Edit Art Bible
          </button>
        </div>
      </div>

      {providerError && (
        <div
          data-testid="studio-error-banner"
          role="alert"
          className="flex items-start justify-between gap-3 border-b border-rose-500/40 bg-rose-950/70 px-4 py-2.5 text-xs text-rose-100"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-400" />
            <div>
              <p className="font-semibold text-rose-200">{providerError.message}</p>
              {providerError.remediation && (
                <p className="mt-0.5 font-mono text-[11px] text-rose-300">
                  {providerError.remediation}
                </p>
              )}
            </div>
          </div>
          <button
            type="button"
            data-testid="dismiss-error-banner-btn"
            onClick={() => setProviderError(null)}
            className="rounded p-1 text-rose-300 hover:bg-rose-900/60 hover:text-white"
            aria-label="Dismiss provider error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      <div className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_300px]">
        {/* Left Pane: Sketch & Mask Tools */}
        <aside
          data-testid="studio-left-pane"
          className="space-y-5 border-b border-slate-800 bg-slate-900/50 p-4 lg:border-r lg:border-b-0"
        >
          <div className="space-y-2">
            <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Sketch Ingestion
            </h3>
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-slate-700 bg-slate-950/70 px-3 py-2.5 text-xs font-medium text-slate-200 hover:border-indigo-500 hover:text-white">
              <Upload className="h-3.5 w-3.5 text-indigo-400" />
              Upload Sketch PNG/JPG
              <input
                type="file"
                data-testid="sketch-upload-input"
                accept="image/png,image/jpeg,image/webp"
                onChange={(e) => void handleUploadSketch(e)}
                className="hidden"
              />
            </label>

            <button
              type="button"
              role="switch"
              aria-checked={isNormalized}
              data-testid="normalize-sketch-btn"
              disabled={isNormalizing}
              onClick={() => void handleToggleNormalize()}
              className={`flex w-full items-center justify-center gap-2 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
                isNormalized
                  ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-200'
                  : 'border-indigo-500/40 bg-indigo-600/20 text-indigo-200 hover:bg-indigo-600/30'
              } disabled:opacity-50`}
            >
              <Sparkles className="h-3.5 w-3.5" />
              {isNormalizing
                ? 'Normalizing in Worker...'
                : isNormalized
                  ? 'Normalized (Extract Lines & Center: ON)'
                  : 'Extract Lines & Center'}
            </button>
          </div>

          <div className="space-y-2 border-t border-slate-800 pt-4">
            <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Drawing & Mask Tools
            </h3>
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                data-testid="tool-sketch-pen"
                aria-pressed={tool === 'sketch-pen'}
                onClick={() => setTool('sketch-pen')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium ${
                  tool === 'sketch-pen'
                    ? 'bg-indigo-600 text-white'
                    : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Pencil className="h-3.5 w-3.5" />
                Sketch Pen
              </button>
              <button
                type="button"
                data-testid="tool-sketch-eraser"
                aria-pressed={tool === 'sketch-eraser'}
                onClick={() => setTool('sketch-eraser')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium ${
                  tool === 'sketch-eraser'
                    ? 'bg-indigo-600 text-white'
                    : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Eraser className="h-3.5 w-3.5" />
                Eraser
              </button>
              <button
                type="button"
                data-testid="mode-inpaint-mask"
                aria-pressed={tool === 'mask-brush'}
                onClick={() => setTool('mask-brush')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium ${
                  tool === 'mask-brush'
                    ? 'bg-rose-600 text-white'
                    : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Paintbrush className="h-3.5 w-3.5" />
                Inpaint Mask
              </button>
              <button
                type="button"
                data-testid="tool-mask-eraser"
                aria-pressed={tool === 'mask-eraser'}
                onClick={() => setTool('mask-eraser')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-2 text-xs font-medium ${
                  tool === 'mask-eraser'
                    ? 'bg-rose-600 text-white'
                    : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                }`}
              >
                <Eraser className="h-3.5 w-3.5" />
                Mask Erase
              </button>
            </div>

            <button
              type="button"
              data-testid="tool-pan"
              aria-pressed={tool === 'pan'}
              onClick={() => setTool('pan')}
              className={`flex w-full items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium ${
                tool === 'pan'
                  ? 'bg-sky-600 text-white'
                  : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
              }`}
            >
              <Hand className="h-3.5 w-3.5" />
              Pan Viewport (or Shift+Drag)
            </button>

            <label className="block space-y-1 pt-1 text-xs">
              <div className="flex justify-between text-slate-300">
                <span>Brush Size</span>
                <span className="font-mono">{brushSize}px</span>
              </div>
              <input
                type="range"
                data-testid="brush-size-slider"
                min={1}
                max={32}
                value={brushSize}
                onChange={(e) => setBrushSize(Number.parseInt(e.target.value, 10))}
                className="w-full accent-indigo-500"
              />
            </label>

            <div className="flex gap-1.5 pt-1">
              <button
                type="button"
                data-testid="sketch-undo-btn"
                disabled={!canUndo}
                onClick={handleUndo}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                <Undo2 className="h-3.5 w-3.5" />
                Undo
              </button>
              <button
                type="button"
                data-testid="sketch-redo-btn"
                disabled={!canRedo}
                onClick={handleRedo}
                className="inline-flex flex-1 items-center justify-center gap-1 rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                <Redo2 className="h-3.5 w-3.5" />
                Redo
              </button>
              <button
                type="button"
                data-testid="sketch-clear-btn"
                onClick={() => void handleClearSketch()}
                className="inline-flex items-center justify-center rounded border border-slate-700 bg-slate-950 px-2 py-1.5 text-xs text-slate-300 hover:bg-slate-800"
                title="Clear Sketch"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>

          <div className="space-y-2 border-t border-slate-800 pt-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
                Mask Layer
              </h3>
              <span data-testid="mask-pixel-count" className="font-mono text-[11px] text-rose-300">
                {maskPixelCount} px
              </span>
            </div>
            <div className="flex gap-1.5">
              <button
                type="button"
                data-testid="toggle-mask-visibility"
                aria-pressed={showMask}
                onClick={() => setShowMask(!showMask)}
                className="inline-flex flex-1 items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800"
              >
                {showMask ? <Eye className="h-3.5 w-3.5" /> : <EyeOff className="h-3.5 w-3.5" />}
                {showMask ? 'Mask Visible' : 'Mask Hidden'}
              </button>
              <button
                type="button"
                data-testid="clear-mask-btn"
                onClick={handleClearMask}
                className="rounded border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-300 hover:bg-rose-500/20"
              >
                Clear Mask
              </button>
            </div>
          </div>

          <div
            data-testid="shortcuts-hint"
            className="space-y-1 border-t border-slate-800 pt-3 text-[11px] text-slate-500"
          >
            <p className="font-semibold tracking-wider text-slate-400 uppercase">Shortcuts</p>
            <p className="font-mono leading-relaxed">
              B Brush · E Eraser · M Mask · G Grid · Space Pan · Cmd/Ctrl+Z Undo
            </p>
          </div>
        </aside>

        {/* Center Pane: Viewport */}
        <section
          data-testid="studio-viewport-pane"
          className="flex min-w-0 flex-col overflow-hidden bg-slate-950"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                data-testid="zoom-out-btn"
                onClick={() => setZoomPercent((z) => Math.max(50, z - 50))}
                className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
                aria-label="Zoom out"
              >
                <ZoomOut className="h-3.5 w-3.5" />
              </button>
              <span
                data-testid="zoom-level-badge"
                className="min-w-14 text-center font-mono text-xs text-slate-200"
              >
                {zoomPercent}%
              </span>
              <button
                type="button"
                data-testid="zoom-in-btn"
                onClick={() => setZoomPercent((z) => Math.min(800, z + 50))}
                className="rounded border border-slate-700 bg-slate-900 p-1.5 text-slate-200 hover:bg-slate-800"
                aria-label="Zoom in"
              >
                <ZoomIn className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                data-testid="pan-reset-btn"
                onClick={() => {
                  setZoomPercent(300);
                  setPanOffset({ x: 0, y: 0 });
                }}
                className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                data-testid="toggle-pixel-grid"
                aria-pressed={showPixelGrid}
                onClick={() => setShowPixelGrid(!showPixelGrid)}
                className={`inline-flex items-center gap-1 rounded border px-2.5 py-1 text-xs ${
                  showPixelGrid
                    ? 'border-indigo-500/50 bg-indigo-500/20 text-indigo-200'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                <Grid3X3 className="h-3.5 w-3.5" />
                Grid
              </button>

              <div className="flex overflow-hidden rounded border border-slate-700 text-xs">
                <button
                  type="button"
                  data-testid="backdrop-checkerboard"
                  onClick={() => setBackdrop('checkerboard')}
                  className={`px-2 py-1 ${
                    backdrop === 'checkerboard'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  Checker
                </button>
                <button
                  type="button"
                  data-testid="backdrop-dark"
                  onClick={() => setBackdrop('dark')}
                  className={`border-x border-slate-700 px-2 py-1 ${
                    backdrop === 'dark'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  Dark
                </button>
                <button
                  type="button"
                  data-testid="backdrop-light"
                  onClick={() => setBackdrop('light')}
                  className={`px-2 py-1 ${
                    backdrop === 'light'
                      ? 'bg-indigo-600 text-white'
                      : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  Light
                </button>
              </div>
            </div>
          </div>

          <div
            data-testid="viewport-backdrop"
            data-backdrop={backdrop}
            className={`relative flex flex-1 items-center justify-center overflow-hidden p-8 select-none ${backdropClass}`}
          >
            <div
              ref={stageRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={() => void handlePointerUp()}
              onPointerCancel={() => {
                drawingRef.current.active = false;
              }}
              className="relative cursor-crosshair shadow-2xl ring-1 ring-slate-600/70"
              style={{
                width: `${displayWidth}px`,
                height: `${displayHeight}px`,
                transform: `translate(${panOffset.x}px, ${panOffset.y}px)`,
                touchAction: 'none',
              }}
            >
              <canvas
                ref={sketchCanvasRef}
                data-testid="sketch-canvas"
                width={targetWidth}
                height={targetHeight}
                className="absolute inset-0 h-full w-full"
                style={{ imageRendering: canvasImageRendering }}
              />
              <canvas
                ref={maskCanvasRef}
                data-testid="mask-canvas"
                width={targetWidth}
                height={targetHeight}
                className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity ${
                  showMask ? 'opacity-100' : 'opacity-0'
                }`}
                style={{ imageRendering: canvasImageRendering }}
              />
              {showPixelGrid && zoomPercent >= 150 && (
                <div
                  data-testid="pixel-grid-overlay"
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundSize: `${scale}px ${scale}px`,
                    backgroundImage:
                      'linear-gradient(to right, rgba(148, 163, 184, 0.18) 1px, transparent 1px), linear-gradient(to bottom, rgba(148, 163, 184, 0.18) 1px, transparent 1px)',
                  }}
                />
              )}
            </div>
          </div>
        </section>

        {/* Right Pane: Generation Inspector */}
        <GenerationInspector
          artBible={activeProject.artBible}
          providers={providers}
          selectedProviderId={selectedProviderId}
          onSelectProvider={setSelectedProviderId}
          adherence={adherence}
          onChangeAdherence={setAdherence}
          promptDelta={promptDelta}
          onChangePromptDelta={setPromptDelta}
          sheetMode={sheetMode}
          onChangeSheetMode={setSheetMode}
          seed={seed}
          onChangeSeed={setSeed}
          variantCount={variantCount}
          onChangeVariantCount={setVariantCount}
          activeParentNode={activeParentNode}
          activeViewportNode={activeViewportNode}
          maskPixelCount={maskPixelCount}
          isGenerating={isGenerating}
          onGenerate={() => void handleGenerate()}
          onInpaint={() => void handleInpaint()}
          onCancel={() => generationAbortRef.current?.abort()}
          onCopyAgentBrief={() => void handleCopyAgentBrief()}
          onDownloadSketchForAgent={handleDownloadSketchForAgent}
          onImportAgentSpriteFile={(file) => void handleImportAgentSprite(file)}
          bridgeCritique={bridgeCritique}
          chainNotice={chainNotice}
          onApplySuggestedDelta={(delta) => setPromptDelta(delta)}
          autoPolishEnabled={autoPolishEnabled}
          onToggleAutoPolish={(enabled) => void handleToggleAutoPolish(enabled)}
          polishSummary={polishSummary}
        />
      </div>

      <DagTreeDock
        nodes={spriteNodes}
        artMode={activeProject.artBible.artMode}
        activeNodeId={activeViewportNode?.id ?? null}
        forkParentId={activeParentNode?.id ?? null}
        onSelectNode={handleSelectNode}
        onForkNode={handleForkNode}
        onCompareNode={handleCompareNode}
        onOpenInspector={(targetNodeId) =>
          void navigate({
            screen: 'inspector',
            projectId: activeProject.id,
            nodeId: targetNodeId,
          })
        }
        onOpenSandbox={(targetNodeId) =>
          void navigate({
            screen: 'inspector',
            projectId: activeProject.id,
            nodeId: targetNodeId,
            initialTab: 'sandbox',
          })
        }
        onOpenAnimationStudio={() => setAnimationStudioOpen(true)}
        onDeleteLeafNode={(id) => void handleDeleteLeafNode(id)}
      />

      {compareNodes && (
        <CompareSplitModal
          nodes={spriteNodes}
          artMode={activeProject.artBible.artMode}
          initialLeftId={compareNodes.leftId}
          initialRightId={compareNodes.rightId}
          onClose={() => setCompareNodes(null)}
        />
      )}

      {animationStudioOpen && (
        <AnimationStudioModal
          nodes={spriteNodes}
          artBible={activeProject.artBible}
          projectName={activeProject.name}
          onClose={() => setAnimationStudioOpen(false)}
        />
      )}
    </div>
  );
}
