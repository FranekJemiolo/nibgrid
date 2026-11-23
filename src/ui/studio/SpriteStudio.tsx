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
import { OFFLINE_MOCK_PROVIDER_ID, repository } from '../../db/database';
import {
  appendChildNode,
  deleteLeafNode,
  forkFromAncestor,
  getAncestorPath,
} from '../../domain/dag';
import { compilePrompt } from '../../domain/promptCompiler';
import type { AdherenceLevel, SpriteNode } from '../../domain/schemas';
import { CanvasHistory } from '../../processing/history';
import { sha256Bytes } from '../../processing/hash';
import { encodeRgbaToPngBytes, rgbaToPngBlob } from '../../processing/png';
import { ProviderError } from '../../providers/errors';
import { resolveProviderAdapter } from '../../providers/registry';
import type { GoldenReferencePayload } from '../../providers/types';
import { useAppStore } from '../../store/useAppStore';
import { normalizeSketchInWorker } from '../../workers/normalizeClient';
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
  try {
    const srcCanvas = document.createElement('canvas');
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

    const dstCanvas = document.createElement('canvas');
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
    refreshSpriteNodes,
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
  const [adherence, setAdherence] = useState<AdherenceLevel>('balanced');
  const [promptDelta, setPromptDelta] = useState('');
  const [seed, setSeed] = useState(1024);
  const [variantCount, setVariantCount] = useState<1 | 2>(2);
  const [isGenerating, setIsGenerating] = useState(false);
  const [compareNodes, setCompareNodes] = useState<{ leftId: string; rightId: string } | null>(
    null,
  );
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [providerError, setProviderError] = useState<{
    message: string;
    remediation?: string;
  } | null>(null);

  const generationAbortRef = useRef<AbortController | null>(null);

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
    const buf = sketchBufferRef.current;
    if (buf.length !== targetWidth * targetHeight * 4) return;
    const imageData = new ImageData(new Uint8ClampedArray(buf), targetWidth, targetHeight);
    ctx.putImageData(imageData, 0, 0);
  }, [targetWidth, targetHeight]);

  const renderMaskCanvas = useCallback(() => {
    const canvas = maskCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
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
  }, [targetWidth, targetHeight]);

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
      if (!activeProject) return;
      const pngBlob = rgbaToPngBlob(rgba, targetWidth, targetHeight);
      const blobRecord = await repository.storeBlob(pngBlob, 'image/png');
      const existingSketchRoot = spriteNodes.find(
        (n) => n.kind === 'sketch' && n.parentId === null,
      );
      const hasChildren =
        existingSketchRoot && spriteNodes.some((n) => n.parentId === existingSketchRoot.id);

      const nodeId =
        existingSketchRoot && !hasChildren ? existingSketchRoot.id : globalThis.crypto.randomUUID();

      const node: SpriteNode = {
        id: nodeId,
        projectId: activeProject.id,
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
      setActiveNodeId(node.id);
      setForkParentId(node.id);
      await refreshSpriteNodes(activeProject.id);
      return node;
    },
    [activeProject, spriteNodes, targetWidth, targetHeight, refreshSpriteNodes],
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

  const handleUndo = () => {
    const prev = historyRef.current.undo();
    if (!prev) return;
    sketchBufferRef.current = prev;
    syncHistoryFlags();
    renderSketchCanvas();
  };

  const handleRedo = () => {
    const next = historyRef.current.redo();
    if (!next) return;
    sketchBufferRef.current = next;
    syncHistoryFlags();
    renderSketchCanvas();
  };

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

    try {
      const decoded = await decodeBlobToRgba(file, targetWidth, targetHeight, 'contain-white');
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
      await persistRootSketchNode(decoded.rgba, `uploaded sketch: ${file.name}`);
      setStatusMessage(
        `Loaded sketch "${file.name}" (${decoded.sourceWidth}×${decoded.sourceHeight}).`,
      );
    } catch (error) {
      setStatusMessage(
        error instanceof Error ? error.message : 'Failed to decode uploaded sketch.',
      );
    }
  };

  const handleToggleNormalize = async () => {
    if (isNormalizing) return;

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
    const results: GoldenReferencePayload[] = [];
    for (const blobId of activeProject.artBible.goldenReferenceBlobIds.slice(0, 3)) {
      const record = await repository.getBlob(blobId);
      if (record) {
        const bytes = new Uint8Array(await record.bytes.arrayBuffer());
        results.push({ mimeType: record.mimeType || 'image/png', bytes });
      }
    }
    return results;
  }, [activeProject]);

  const handleGenerate = async () => {
    if (!activeProject || isGenerating) return;
    const providerConfig = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
    if (!providerConfig) {
      setStatusMessage('No provider configured in Provider Vault.');
      return;
    }

    const abortController = new AbortController();
    generationAbortRef.current = abortController;
    setIsGenerating(true);
    setProviderError(null);
    setStatusMessage(`Generating ${variantCount} sprite variant(s)...`);

    try {
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

      let sourceRgba: Uint8ClampedArray = new Uint8ClampedArray(sketchBufferRef.current);
      if (parentNode.id !== activeViewportNode?.id) {
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

      const ancestry = getAncestorPath(workingNodes, parentNode.id);
      const rootSketchSha = ancestry[0]?.sketchSha256 ?? parentNode.sketchSha256;
      const compiled = compilePrompt(activeProject.artBible, { adherence, promptDelta });
      const adapter = resolveProviderAdapter(providerConfig);
      const goldenReferenceImages = await loadGoldenReferencePayloads();

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
          goldenReferenceImages,
        },
        abortController.signal,
      );

      const createdNodes: SpriteNode[] = [];
      for (const output of outputs) {
        const blobRecord = await repository.storeBlob(output.blob, 'image/png');
        const childNode: SpriteNode = {
          id: globalThis.crypto.randomUUID(),
          projectId: activeProject.id,
          parentId: parentNode.id,
          kind: 'generation',
          imageBlobId: blobRecord.id,
          sketchSha256: rootSketchSha,
          generationMeta: {
            providerId: providerConfig.id,
            modelId: providerConfig.modelId,
            seed: output.seed,
            adherence,
            promptDelta,
            compiledPrompt: compiled.fullCompiledPrompt,
            createdAt: new Date(Date.now() + output.variantIndex).toISOString(),
          },
        };
        workingNodes = appendChildNode(workingNodes, childNode);
        await repository.saveSpriteNode(childNode);
        createdNodes.push(childNode);
      }

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
          displayRgba = resized.rgba;
        }
        sketchBufferRef.current = displayRgba;
        historyRef.current.reset(displayRgba);
        syncHistoryFlags();
        renderSketchCanvas();
        setActiveNodeId(firstNode.id);
        setForkParentId(firstNode.id);
      }

      await refreshSpriteNodes(activeProject.id);
      setStatusMessage(`Generated ${createdNodes.length} variant(s) under ${parentNode.kind}.`);
    } catch (error) {
      if (error instanceof ProviderError) {
        setProviderError({ message: error.message, remediation: error.remediation });
      } else {
        setProviderError({
          message: error instanceof Error ? error.message : 'Generation failed.',
        });
      }
      setStatusMessage(null);
    } finally {
      generationAbortRef.current = null;
      setIsGenerating(false);
    }
  };

  const handleInpaint = async () => {
    if (!activeProject || isGenerating || !activeViewportNode || maskPixelCount === 0) return;
    const providerConfig = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
    if (!providerConfig) return;

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
      const maskBlobRecord = await repository.storeBlob(
        rgbaToPngBlob(maskRgba, targetWidth, targetHeight),
        'image/png',
      );

      const compiled = compilePrompt(activeProject.artBible, { adherence, promptDelta });
      const adapter = resolveProviderAdapter(providerConfig);
      const goldenReferenceImages = await loadGoldenReferencePayloads();

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
        },
        abortController.signal,
      );

      const inpaintOutput = outputs[0];
      if (!inpaintOutput) {
        throw new Error('Provider returned zero inpaint outputs.');
      }

      const imageBlobRecord = await repository.storeBlob(inpaintOutput.blob, 'image/png');
      const inpaintNode: SpriteNode = {
        id: globalThis.crypto.randomUUID(),
        projectId: activeProject.id,
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
        },
      };

      appendChildNode(spriteNodes, inpaintNode);
      await repository.saveSpriteNode(inpaintNode);

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
        displayRgba = resized.rgba;
      }
      sketchBufferRef.current = displayRgba;
      historyRef.current.reset(displayRgba);
      maskBufferRef.current = new Uint8Array(targetWidth * targetHeight);
      syncHistoryFlags();
      renderSketchCanvas();
      renderMaskCanvas();
      setActiveNodeId(inpaintNode.id);
      setForkParentId(inpaintNode.id);

      await refreshSpriteNodes(activeProject.id);
      setStatusMessage(`Created inpaint child node (seed #${inpaintNode.generationMeta.seed}).`);
    } catch (error) {
      if (error instanceof ProviderError) {
        setProviderError({ message: error.message, remediation: error.remediation });
      } else {
        setProviderError({
          message: error instanceof Error ? error.message : 'Inpainting failed.',
        });
      }
      setStatusMessage(null);
    } finally {
      generationAbortRef.current = null;
      setIsGenerating(false);
    }
  };

  if (!activeProject) {
    return null;
  }

  const scale = zoomPercent / 100;
  const displayWidth = Math.round(targetWidth * scale);
  const displayHeight = Math.round(targetHeight * scale);

  const backdropClass =
    backdrop === 'checkerboard'
      ? 'bg-checkerboard'
      : backdrop === 'dark'
        ? 'bg-slate-950'
        : 'bg-slate-100';

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

      <div className="grid flex-1 grid-cols-1 lg:grid-cols-[280px_1fr_300px]">
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
        </aside>

        {/* Center Pane: Viewport */}
        <section
          data-testid="studio-viewport-pane"
          className="flex flex-col overflow-hidden bg-slate-950"
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
                style={{ imageRendering: 'pixelated' }}
              />
              <canvas
                ref={maskCanvasRef}
                data-testid="mask-canvas"
                width={targetWidth}
                height={targetHeight}
                className={`pointer-events-none absolute inset-0 h-full w-full transition-opacity ${
                  showMask ? 'opacity-100' : 'opacity-0'
                }`}
                style={{ imageRendering: 'pixelated' }}
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
        />
      </div>

      <DagTreeDock
        nodes={spriteNodes}
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
        onDeleteLeafNode={(id) => void handleDeleteLeafNode(id)}
      />

      {compareNodes && (
        <CompareSplitModal
          nodes={spriteNodes}
          initialLeftId={compareNodes.leftId}
          initialRightId={compareNodes.rightId}
          onClose={() => setCompareNodes(null)}
        />
      )}
    </div>
  );
}
