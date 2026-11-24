import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Eye,
  EyeOff,
  FileArchive,
  ImagePlus,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Sparkles,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { OFFLINE_MOCK_PROVIDER_ID, repository } from '../../db/database';
import type {
  ArtMode,
  ParallaxLayerConfig,
  ParallaxSceneBlueprint,
  ParallaxSceneConfig,
  PostProcessConfig,
  Project,
  ProviderConfig,
  SpriteNode,
} from '../../domain/schemas';
import {
  exportGodotParallaxTscn,
  exportParallaxManifestJson,
  packageParallaxZip,
  type ParallaxExportLayer,
  type ParallaxExportOptions,
} from '../../export/parallaxExporters';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { hexToRgbTuple, processSingleParallaxLayer } from '../../processing/parallaxCompositor';
import { decodePngBytesToRgba, rgbaToPngBlob } from '../../processing/png';
import { computeArtBibleHash } from '../../processing/projectAudit';
import type { RgbaBuffer } from '../../processing/types';
import { redactSecrets } from '../../providers/errors';
import {
  PARALLAX_BIOME_PRESETS,
  estimateParallaxGenerationCost,
  generateMatchedParallaxStack,
  regenerateParallaxBand,
  type GeneratedParallaxBandArtifact,
} from '../../providers/parallaxGenerator';
import {
  createMonotonicRequestGuard,
  processParallaxLayerInWorker,
  type MonotonicRequestGuard,
} from '../../workers/postprocessClient';
import { ScrubInput } from '../primitives/ScrubInput';

export interface ParallaxWorkshopProps {
  readonly sprite: RgbaBuffer;
  readonly artMode: ArtMode;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly spriteNodes: readonly SpriteNode[];
  readonly providers: readonly ProviderConfig[];
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly parallaxConfig: ParallaxSceneConfig;
  readonly onChangeConfig: (next: ParallaxSceneConfig) => void;
  readonly onSaveToProject: (saved: ParallaxSceneConfig) => Promise<void>;
}

const VIEWPORT_PRESETS: readonly {
  readonly w: number;
  readonly h: number;
  readonly label: string;
}[] = [
  { w: 320, h: 180, label: '320×180' },
  { w: 480, h: 270, label: '480×270' },
  { w: 640, h: 360, label: '640×360' },
];

async function decodeBlobToBuffer(blob: Blob): Promise<RgbaBuffer> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    const decoded = await decodePngBytesToRgba(bytes);
    return { width: decoded.width, height: decoded.height, data: decoded.rgba };
  } catch {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas context unavailable.');
      ctx.drawImage(bitmap, 0, 0);
      const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        width: bitmap.width,
        height: bitmap.height,
        data: new Uint8ClampedArray(imageData.data),
      };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function makeOffscreenCanvas(buf: RgbaBuffer, existing?: HTMLCanvasElement): HTMLCanvasElement {
  const canvas = existing ?? document.createElement('canvas');
  canvas.width = Math.max(1, buf.width);
  canvas.height = Math.max(1, buf.height);
  const ctx = canvas.getContext('2d');
  if (ctx && buf.width > 0 && buf.height > 0) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
  }
  return canvas;
}

function pickDefaultProviderId(providers: readonly ProviderConfig[]): string {
  const enabledGemini = providers.find(
    (p) => p.enabled && p.kind === 'gemini' && p.apiKey.trim().length > 0,
  );
  if (enabledGemini) return enabledGemini.id;
  const enabledBridge = providers.find((p) => p.enabled && p.kind === 'antigravity-bridge');
  if (enabledBridge) return enabledBridge.id;
  const enabledMock = providers.find((p) => p.id === OFFLINE_MOCK_PROVIDER_ID);
  return enabledMock?.id ?? providers[0]?.id ?? OFFLINE_MOCK_PROVIDER_ID;
}

function artifactToLayerConfig(
  artifact: GeneratedParallaxBandArtifact,
  index: number,
): ParallaxLayerConfig {
  return {
    id: artifact.band.id || `band-${index + 1}`,
    name: artifact.band.name,
    role: artifact.band.role,
    sourceKind: 'ai-band',
    scrollRatioX: artifact.band.scrollRatioX,
    yOffsetPx: artifact.band.yOffsetPx,
    seamBlendPx: artifact.band.seamBlendPx,
    depthHaze: artifact.band.depthHaze,
    visible: true,
    stripChromaKey: artifact.stripChromaKey,
    subjectPrompt: artifact.band.subjectPrompt,
  };
}

export function ParallaxWorkshop({
  sprite,
  artMode,
  project,
  targetNode,
  spriteNodes,
  providers,
  postProcessConfig,
  rawWidth,
  rawHeight,
  parallaxConfig,
  onChangeConfig,
  onSaveToProject,
}: ParallaxWorkshopProps) {
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(
    () => parallaxConfig.layers[0]?.id ?? null,
  );
  const [playing, setPlaying] = useState(true);
  const [docHidden, setDocHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.hidden,
  );
  const [exportTab, setExportTab] = useState<'godot' | 'json'>('godot');
  const [copied, setCopied] = useState(false);

  // AI Matched-Stack controls
  const [aiExpanded, setAiExpanded] = useState(true);
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() =>
    pickDefaultProviderId(providers),
  );
  const [themePrompt, setThemePrompt] = useState<string>(
    () => parallaxConfig.blueprint?.themePrompt ?? PARALLAX_BIOME_PRESETS[0]!.themePrompt,
  );
  const [bandCount, setBandCount] = useState<3 | 4>(() =>
    parallaxConfig.blueprint?.bandCount === 4 ? 4 : 3,
  );
  const [includeMasterKeyframe, setIncludeMasterKeyframe] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [regenLayerId, setRegenLayerId] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<string | null>(null);
  const [aiError, setAiError] = useState<string | null>(null);

  // Add project sprite dropdown state
  const [addSpriteNodeId, setAddSpriteNodeId] = useState<string>(
    () => spriteNodes[0]?.id ?? targetNode.id,
  );
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);

  // Reactivity ticks for raw hydration and worker completion
  const [layerRevisions, setLayerRevisions] = useState<Record<string, number>>({});
  const [layerSizes, setLayerSizes] = useState<Record<string, { width: number; height: number }>>(
    {},
  );
  const [processedRev, setProcessedRev] = useState(0);

  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const cameraXRef = useRef(0);
  const lastFrameTimeRef = useRef<number | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const aiAbortRef = useRef<AbortController | null>(null);

  const rawBuffersRef = useRef<Map<string, { rev: number; buffer: RgbaBuffer }>>(new Map());
  const processedBuffersRef = useRef<
    Map<string, { sig: string; buffer: RgbaBuffer; canvas: HTMLCanvasElement }>
  >(new Map());
  const dirtyLayerIdsRef = useRef<Set<string>>(new Set());
  const masterKeyframeBytesRef = useRef<Uint8Array | null>(null);
  const dirtyMasterRef = useRef(false);
  const foregroundCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const layerGuardsRef = useRef<Map<string, MonotonicRequestGuard>>(new Map());

  const latestConfigRef = useRef(parallaxConfig);
  latestConfigRef.current = parallaxConfig;
  const latestSpriteNodesRef = useRef(spriteNodes);
  latestSpriteNodesRef.current = spriteNodes;
  const latestSpriteRef = useRef(sprite);
  latestSpriteRef.current = sprite;
  const hydratedNodeIdRef = useRef<string | null>(null);

  const selectableProviders = useMemo(
    () =>
      providers.filter(
        (p) => p.kind === 'mock' || p.kind === 'gemini' || p.kind === 'antigravity-bridge',
      ),
    [providers],
  );

  const activeProvider = useMemo(
    () =>
      selectableProviders.find((p) => p.id === selectedProviderId) ??
      selectableProviders.find((p) => p.id === OFFLINE_MOCK_PROVIDER_ID) ??
      selectableProviders[0],
    [selectableProviders, selectedProviderId],
  );

  // Keep selected provider valid if Vault providers update
  useEffect(() => {
    if (!selectableProviders.some((p) => p.id === selectedProviderId)) {
      setSelectedProviderId(pickDefaultProviderId(selectableProviders));
    }
  }, [selectableProviders, selectedProviderId]);

  // Keep selected layer valid when layers change
  useEffect(() => {
    if (parallaxConfig.layers.length === 0) {
      setSelectedLayerId(null);
      return;
    }
    if (!selectedLayerId || !parallaxConfig.layers.some((l) => l.id === selectedLayerId)) {
      setSelectedLayerId(parallaxConfig.layers[0]!.id);
    }
  }, [parallaxConfig.layers, selectedLayerId]);

  // Visibility pause listener
  useEffect(() => {
    const onVisibility = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Unmount cleanup: abort AI fetches, invalidate worker guards, release offscreen canvases
  useEffect(() => {
    const guards = layerGuardsRef.current;
    const processedMap = processedBuffersRef.current;
    return () => {
      aiAbortRef.current?.abort();
      aiAbortRef.current = null;
      for (const guard of guards.values()) {
        guard.invalidate();
      }
      guards.clear();
      for (const entry of processedMap.values()) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
      }
      processedMap.clear();
      if (foregroundCanvasRef.current) {
        foregroundCanvasRef.current.width = 0;
        foregroundCanvasRef.current.height = 0;
        foregroundCanvasRef.current = null;
      }
    };
  }, []);

  // Keep foreground character dummy offscreen canvas in sync with active sprite
  useEffect(() => {
    foregroundCanvasRef.current = makeOffscreenCanvas(
      sprite,
      foregroundCanvasRef.current ?? undefined,
    );
  }, [sprite]);

  // Hydrate saved master keyframe & layer PNG blobs from Dexie ONLY when targetNode.id changes
  useEffect(() => {
    if (hydratedNodeIdRef.current === targetNode.id) return;
    hydratedNodeIdRef.current = targetNode.id;

    let cancelled = false;
    const processedMap = processedBuffersRef.current;
    for (const entry of processedMap.values()) {
      entry.canvas.width = 0;
      entry.canvas.height = 0;
    }
    processedMap.clear();
    rawBuffersRef.current.clear();
    dirtyLayerIdsRef.current.clear();
    dirtyMasterRef.current = false;
    masterKeyframeBytesRef.current = null;

    const initialConfig = latestConfigRef.current;
    if (initialConfig.blueprint?.themePrompt) {
      setThemePrompt(initialConfig.blueprint.themePrompt);
      setBandCount(initialConfig.blueprint.bandCount === 4 ? 4 : 3);
    }

    const hydrate = async () => {
      if (initialConfig.masterKeyframeBlobId) {
        const masterRec = await repository.getBlob(initialConfig.masterKeyframeBlobId);
        if (!cancelled && masterRec) {
          masterKeyframeBytesRef.current = new Uint8Array(await masterRec.bytes.arrayBuffer());
        }
      }

      const nextRevs: Record<string, number> = {};
      const nodesSnapshot = latestSpriteNodesRef.current;
      for (const layer of initialConfig.layers) {
        if (cancelled) return;
        let resolvedBlobId = layer.blobId;
        if (!resolvedBlobId && layer.sourceNodeId) {
          const srcNode = nodesSnapshot.find((n) => n.id === layer.sourceNodeId);
          resolvedBlobId = srcNode?.processedBlobId ?? srcNode?.imageBlobId;
        }
        if (resolvedBlobId) {
          const rec = await repository.getBlob(resolvedBlobId);
          if (!cancelled && rec) {
            const buf = await decodeBlobToBuffer(rec.bytes);
            if (cancelled) return;
            rawBuffersRef.current.set(layer.id, { rev: 1, buffer: buf });
            nextRevs[layer.id] = 1;
          }
        } else if (layer.sourceKind === 'node') {
          rawBuffersRef.current.set(layer.id, { rev: 1, buffer: latestSpriteRef.current });
          nextRevs[layer.id] = 1;
        }
      }
      if (!cancelled) {
        setLayerRevisions((prev) => ({ ...prev, ...nextRevs }));
      }
    };

    void hydrate();
    return () => {
      cancelled = true;
      hydratedNodeIdRef.current = null;
    };
  }, [targetNode.id]);

  // Process any layer whose raw buffer rev or layer/scene params changed via Dedicated Worker
  useEffect(() => {
    let cancelled = false;
    const horizonRgb = hexToRgbTuple(parallaxConfig.horizonHex);
    const activeIds = new Set(parallaxConfig.layers.map((l) => l.id));

    // Dispose processed caches for removed layers
    for (const [id, entry] of processedBuffersRef.current.entries()) {
      if (!activeIds.has(id)) {
        entry.canvas.width = 0;
        entry.canvas.height = 0;
        processedBuffersRef.current.delete(id);
        layerGuardsRef.current.get(id)?.invalidate();
        layerGuardsRef.current.delete(id);
      }
    }

    for (const layer of parallaxConfig.layers) {
      const rawEntry = rawBuffersRef.current.get(layer.id);
      if (!rawEntry) continue;
      const rev = layerRevisions[layer.id] ?? rawEntry.rev;
      const sig = JSON.stringify({
        rev,
        seamBlendPx: layer.seamBlendPx,
        depthHaze: layer.depthHaze,
        stripChromaKey: layer.stripChromaKey,
        horizonHex: parallaxConfig.horizonHex,
        contrastDampening: parallaxConfig.contrastDampening,
        snapToPalette: parallaxConfig.snapToPalette,
        palette: parallaxConfig.snapToPalette ? project.artBible.palette : [],
      });

      const existing = processedBuffersRef.current.get(layer.id);
      if (existing && existing.sig === sig) continue;

      let guard = layerGuardsRef.current.get(layer.id);
      if (!guard) {
        guard = createMonotonicRequestGuard();
        layerGuardsRef.current.set(layer.id, guard);
      }
      const token = guard.next();

      void processParallaxLayerInWorker({
        layerId: layer.id,
        layerName: layer.name,
        rgba: rawEntry.buffer.data,
        width: rawEntry.buffer.width,
        height: rawEntry.buffer.height,
        scrollRatioX: layer.scrollRatioX,
        yOffsetPx: layer.yOffsetPx,
        seamBlendPx: layer.seamBlendPx,
        depthHaze: layer.depthHaze,
        visible: layer.visible,
        horizonRgb,
        contrastDampening: parallaxConfig.contrastDampening,
        stripChromaKey: layer.stripChromaKey,
        chromaTolerance: 28,
        paletteHex: project.artBible.palette,
        snapToPalette: parallaxConfig.snapToPalette,
      })
        .then((res) => {
          if (cancelled || !guard.isCurrent(token)) return;
          if (!latestConfigRef.current.layers.some((l) => l.id === layer.id)) return;
          const processedBuf: RgbaBuffer = {
            width: res.width,
            height: res.height,
            data: res.rgba,
          };
          const prevEntry = processedBuffersRef.current.get(layer.id);
          const offscreen = makeOffscreenCanvas(processedBuf, prevEntry?.canvas);
          processedBuffersRef.current.set(layer.id, {
            sig,
            buffer: processedBuf,
            canvas: offscreen,
          });
          setLayerSizes((prev) => {
            const cur = prev[layer.id];
            if (cur && cur.width === res.width && cur.height === res.height) return prev;
            return { ...prev, [layer.id]: { width: res.width, height: res.height } };
          });
          setProcessedRev((r) => r + 1);
        })
        .catch(() => {
          // Ignore stale/cancelled layer processing errors cleanly
        });
    }

    return () => {
      cancelled = true;
    };
  }, [
    parallaxConfig.layers,
    parallaxConfig.horizonHex,
    parallaxConfig.contrastDampening,
    parallaxConfig.snapToPalette,
    project.artBible.palette,
    layerRevisions,
  ]);

  // Render function shared by static redraws and the 60 FPS rAF loop
  useEffect(() => {
    const drawFrame = () => {
      const canvas = stageCanvasRef.current;
      if (!canvas) return;
      const cfg = latestConfigRef.current;
      const vw = cfg.viewportWidth;
      const vh = cfg.viewportHeight;
      if (canvas.width !== vw || canvas.height !== vh) {
        canvas.width = vw;
        canvas.height = vh;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.imageSmoothingEnabled = artMode !== 'pixel-art';
      const skyGrad = ctx.createLinearGradient(0, 0, 0, vh);
      skyGrad.addColorStop(0, cfg.skyTopHex);
      skyGrad.addColorStop(1, cfg.horizonHex);
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, vw, vh);

      const camX = cameraXRef.current;
      for (const layer of cfg.layers) {
        if (!layer.visible) continue;
        const entry = processedBuffersRef.current.get(layer.id);
        if (!entry || entry.canvas.width <= 0 || entry.canvas.height <= 0) continue;

        const lw = entry.canvas.width;
        const lh = entry.canvas.height;
        const shiftX = Math.round(camX * layer.scrollRatioX);
        const wrappedOffset = ((shiftX % lw) + lw) % lw;
        const dstY = Math.round(vh - lh + layer.yOffsetPx);

        for (let drawX = -wrappedOffset; drawX < vw; drawX += lw) {
          ctx.drawImage(entry.canvas, drawX, dstY);
        }
      }

      if (cfg.showForegroundDummy && foregroundCanvasRef.current) {
        const fg = foregroundCanvasRef.current;
        const drawX = Math.round((vw - fg.width) / 2);
        const drawY = Math.max(0, vh - fg.height - 6);
        ctx.drawImage(fg, drawX, drawY);
      }
    };

    drawFrame();

    if (!playing || docHidden) {
      lastFrameTimeRef.current = null;
      return;
    }

    let rafId = 0;
    lastFrameTimeRef.current = null;

    const tick = (now: number) => {
      const prev = lastFrameTimeRef.current ?? now;
      const dtSec = Math.min(0.1, Math.max(0, (now - prev) / 1000));
      lastFrameTimeRef.current = now;
      cameraXRef.current += latestConfigRef.current.cameraSpeedPxPerSec * dtSec;
      drawFrame();
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
      lastFrameTimeRef.current = null;
    };
  }, [playing, docHidden, artMode, parallaxConfig, processedRev]);

  const updateConfig = (next: ParallaxSceneConfig) => {
    setSaveNotice(null);
    onChangeConfig(next);
  };

  const updateSelectedLayer = (patch: Partial<ParallaxLayerConfig>) => {
    if (!selectedLayerId) return;
    updateConfig({
      ...parallaxConfig,
      layers: parallaxConfig.layers.map((layer) =>
        layer.id === selectedLayerId ? { ...layer, ...patch } : layer,
      ),
    });
  };

  const setLayerRawBuffer = (layerId: string, buf: RgbaBuffer, markDirty: boolean) => {
    const prevRev = rawBuffersRef.current.get(layerId)?.rev ?? 0;
    const nextRev = prevRev + 1;
    rawBuffersRef.current.set(layerId, { rev: nextRev, buffer: buf });
    if (markDirty) {
      dirtyLayerIdsRef.current.add(layerId);
    }
    setLayerRevisions((prev) => ({ ...prev, [layerId]: nextRev }));
  };

  const handleGenerateMatchedStack = async () => {
    if (!activeProvider) return;
    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;

    setIsGenerating(true);
    setAiError(null);
    setSaveNotice(null);
    setAiStatus('Planning parallax blueprint...');

    const streamedConfigs: ParallaxLayerConfig[] = [];
    let activeBlueprint: ParallaxSceneBlueprint | undefined;

    try {
      const result = await generateMatchedParallaxStack({
        providerConfig: activeProvider,
        artBible: project.artBible,
        themePrompt: themePrompt.trim() || PARALLAX_BIOME_PRESETS[0]!.themePrompt,
        bandCount,
        viewportWidth: parallaxConfig.viewportWidth,
        viewportHeight: parallaxConfig.viewportHeight,
        includeMasterKeyframe,
        signal: controller.signal,
        onStage: (status) => {
          setAiStatus(status);
        },
        onBlueprintReady: (blueprint) => {
          activeBlueprint = blueprint;
          // Clear previous dirty flags for fresh AI stack
          dirtyLayerIdsRef.current.clear();
          updateConfig({
            ...latestConfigRef.current,
            skyTopHex: blueprint.skyTopHex,
            horizonHex: blueprint.horizonHex,
            blueprint,
            masterKeyframeBlobId: undefined,
            layers: [],
          });
        },
        onBandReady: (artifact, idx) => {
          const cfg = artifactToLayerConfig(artifact, idx);
          streamedConfigs.push(cfg);
          setLayerRawBuffer(cfg.id, artifact.rawBuffer, true);
          const nextLayers = [...streamedConfigs];
          setSelectedLayerId(cfg.id);
          updateConfig({
            ...latestConfigRef.current,
            ...(activeBlueprint
              ? {
                  skyTopHex: activeBlueprint.skyTopHex,
                  horizonHex: activeBlueprint.horizonHex,
                  blueprint: activeBlueprint,
                }
              : {}),
            layers: nextLayers,
          });
        },
      });

      if (result.masterKeyframePngBytes) {
        masterKeyframeBytesRef.current = result.masterKeyframePngBytes;
        dirtyMasterRef.current = true;
      } else {
        masterKeyframeBytesRef.current = null;
        dirtyMasterRef.current = false;
      }

      setAiStatus(`Generated ${result.bands.length} matched bands.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setAiStatus('Generation aborted.');
      } else {
        const rawMsg = error instanceof Error ? error.message : 'Parallax generation failed.';
        const secret = activeProvider.apiKey ? [activeProvider.apiKey] : [];
        setAiError(redactSecrets(rawMsg, secret));
        setAiStatus(null);
      }
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
      }
      setIsGenerating(false);
    }
  };

  const handleRegenerateBand = async (index: number) => {
    if (!activeProvider) return;
    const layer = parallaxConfig.layers[index];
    if (!layer) return;

    aiAbortRef.current?.abort();
    const controller = new AbortController();
    aiAbortRef.current = controller;

    setRegenLayerId(layer.id);
    setAiError(null);
    setSaveNotice(null);
    setAiStatus(`Regenerating ${layer.name}...`);

    const blueprint: ParallaxSceneBlueprint = parallaxConfig.blueprint ?? {
      sceneTitle: project.name,
      themePrompt: themePrompt.trim() || project.artBible.stylePrompt,
      skyTopHex: parallaxConfig.skyTopHex,
      horizonHex: parallaxConfig.horizonHex,
      horizonLinePct: 0.6,
      lightingDirection: project.artBible.lighting,
      bandCount: Math.max(2, Math.min(6, parallaxConfig.layers.length)),
      bands: parallaxConfig.layers.map((l) => ({
        id: l.id,
        name: l.name,
        role: l.role ?? 'midground',
        scrollRatioX: l.scrollRatioX,
        depthHaze: l.depthHaze,
        seamBlendPx: l.seamBlendPx,
        yOffsetPx: Math.max(-256, Math.min(256, l.yOffsetPx)),
        subjectPrompt: l.subjectPrompt || `${themePrompt} — ${l.name}`,
        silhouetteRule: 'Flat #FF00FF chroma key background',
        edgeHeightHint: 'Seamless left/right horizontal alignment',
      })),
    };

    const bandSpec = blueprint.bands.find((b) => b.id === layer.id) ?? {
      id: layer.id,
      name: layer.name,
      role: layer.role ?? 'midground',
      scrollRatioX: layer.scrollRatioX,
      depthHaze: layer.depthHaze,
      seamBlendPx: layer.seamBlendPx,
      yOffsetPx: Math.max(-256, Math.min(256, layer.yOffsetPx)),
      subjectPrompt: layer.subjectPrompt || `${themePrompt} — ${layer.name}`,
      silhouetteRule: 'Flat #FF00FF chroma key background',
      edgeHeightHint: 'Seamless left/right horizontal alignment',
    };

    try {
      const artifact = await regenerateParallaxBand({
        providerConfig: activeProvider,
        blueprint,
        band: bandSpec,
        artBible: project.artBible,
        viewportWidth: parallaxConfig.viewportWidth,
        viewportHeight: parallaxConfig.viewportHeight,
        masterKeyframePngBytes: masterKeyframeBytesRef.current ?? undefined,
        variationSeed: (Date.now() & 0xffffff) + index * 31,
        signal: controller.signal,
      });

      setLayerRawBuffer(layer.id, artifact.rawBuffer, true);
      updateConfig({
        ...latestConfigRef.current,
        layers: latestConfigRef.current.layers.map((item) =>
          item.id === layer.id ? { ...item, stripChromaKey: artifact.stripChromaKey } : item,
        ),
      });
      setAiStatus(`Regenerated ${layer.name}.`);
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        setAiStatus('Band regeneration cancelled.');
      } else {
        const rawMsg = error instanceof Error ? error.message : 'Band regeneration failed.';
        const secret = activeProvider.apiKey ? [activeProvider.apiKey] : [];
        setAiError(redactSecrets(rawMsg, secret));
        setAiStatus(null);
      }
    } finally {
      if (aiAbortRef.current === controller) {
        aiAbortRef.current = null;
      }
      setRegenLayerId(null);
    }
  };

  const handleAddCurrentSprite = () => {
    if (parallaxConfig.layers.length >= 6) return;
    const id = `layer-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const idx = parallaxConfig.layers.length;
    const newLayer: ParallaxLayerConfig = {
      id,
      name: `Sprite Band ${idx + 1}`,
      sourceKind: 'node',
      sourceNodeId: targetNode.id,
      scrollRatioX: Number(Math.min(1.1, 0.25 + idx * 0.25).toFixed(2)),
      yOffsetPx: 0,
      seamBlendPx: 16,
      depthHaze: Number(Math.max(0, 0.45 - idx * 0.15).toFixed(2)),
      visible: true,
      stripChromaKey: false,
    };
    setLayerRawBuffer(id, sprite, true);
    setSelectedLayerId(id);
    updateConfig({
      ...parallaxConfig,
      layers: [...parallaxConfig.layers, newLayer],
    });
  };

  const handleAddProjectSprite = async () => {
    if (parallaxConfig.layers.length >= 6) return;
    const picked = spriteNodes.find((n) => n.id === addSpriteNodeId);
    if (!picked) return;
    const blobId = picked.processedBlobId ?? picked.imageBlobId;
    const blobRec = await repository.getBlob(blobId);
    if (!blobRec) return;
    const buf = await decodeBlobToBuffer(blobRec.bytes);
    const id = `layer-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const idx = parallaxConfig.layers.length;
    const newLayer: ParallaxLayerConfig = {
      id,
      name: `${picked.kind} #${picked.generationMeta.seed}`,
      sourceKind: 'node',
      sourceNodeId: picked.id,
      blobId,
      scrollRatioX: Number(Math.min(1.1, 0.25 + idx * 0.25).toFixed(2)),
      yOffsetPx: 0,
      seamBlendPx: 16,
      depthHaze: Number(Math.max(0, 0.45 - idx * 0.15).toFixed(2)),
      visible: true,
      stripChromaKey: false,
    };
    setLayerRawBuffer(id, buf, false);
    setSelectedLayerId(id);
    updateConfig({
      ...parallaxConfig,
      layers: [...parallaxConfig.layers, newLayer],
    });
  };

  const handleUploadBandFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || parallaxConfig.layers.length >= 6) return;
    const buf = await decodeBlobToBuffer(file);
    const id = `layer-${globalThis.crypto.randomUUID().slice(0, 8)}`;
    const baseName = file.name.replace(/\.[^.]+$/, '').slice(0, 48) || 'Uploaded Band';
    const newLayer: ParallaxLayerConfig = {
      id,
      name: baseName,
      sourceKind: 'blob',
      scrollRatioX: Number(Math.min(1.1, 0.3 + parallaxConfig.layers.length * 0.2).toFixed(2)),
      yOffsetPx: 0,
      seamBlendPx: 24,
      depthHaze: 0.2,
      visible: true,
      stripChromaKey: false,
    };
    setLayerRawBuffer(id, buf, true);
    setSelectedLayerId(id);
    updateConfig({
      ...parallaxConfig,
      layers: [...parallaxConfig.layers, newLayer],
    });
  };

  const moveLayer = (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= parallaxConfig.layers.length) return;
    const copy = [...parallaxConfig.layers];
    const [moved] = copy.splice(index, 1);
    if (!moved) return;
    copy.splice(nextIdx, 0, moved);
    updateConfig({ ...parallaxConfig, layers: copy });
  };

  const removeLayer = (layerId: string) => {
    rawBuffersRef.current.delete(layerId);
    dirtyLayerIdsRef.current.delete(layerId);
    updateConfig({
      ...parallaxConfig,
      layers: parallaxConfig.layers.filter((l) => l.id !== layerId),
    });
  };

  const collectProcessedExportLayers = (): ParallaxExportLayer[] => {
    const horizonRgb = hexToRgbTuple(parallaxConfig.horizonHex);
    const visibleOrAll = parallaxConfig.layers.some((l) => l.visible)
      ? parallaxConfig.layers.filter((l) => l.visible)
      : parallaxConfig.layers;

    const out: ParallaxExportLayer[] = [];
    for (const layer of visibleOrAll) {
      const cached = processedBuffersRef.current.get(layer.id);
      if (cached) {
        out.push({
          id: layer.id,
          name: layer.name,
          ...(layer.role ? { role: layer.role } : {}),
          scrollRatioX: layer.scrollRatioX,
          yOffsetPx: layer.yOffsetPx,
          seamBlendPx: layer.seamBlendPx,
          depthHaze: layer.depthHaze,
          buffer: cached.buffer,
        });
        continue;
      }
      const raw = rawBuffersRef.current.get(layer.id);
      if (raw) {
        const processed = processSingleParallaxLayer(
          {
            id: layer.id,
            name: layer.name,
            ...(layer.role ? { role: layer.role } : {}),
            source: raw.buffer,
            scrollRatioX: layer.scrollRatioX,
            yOffsetPx: layer.yOffsetPx,
            seamBlendPx: layer.seamBlendPx,
            depthHaze: layer.depthHaze,
            visible: layer.visible,
            stripChromaKey: layer.stripChromaKey,
          },
          {
            horizonRgb,
            contrastDampening: parallaxConfig.contrastDampening,
            paletteHex: project.artBible.palette,
            snapToPalette: parallaxConfig.snapToPalette,
          },
        );
        out.push({
          id: layer.id,
          name: layer.name,
          ...(layer.role ? { role: layer.role } : {}),
          scrollRatioX: layer.scrollRatioX,
          yOffsetPx: layer.yOffsetPx,
          seamBlendPx: layer.seamBlendPx,
          depthHaze: layer.depthHaze,
          buffer: processed.buffer,
        });
      }
    }
    return out;
  };

  const slug = toAssetSlug(`${project.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`);

  const exportOpts: ParallaxExportOptions = useMemo(
    () => ({
      viewportWidth: parallaxConfig.viewportWidth,
      viewportHeight: parallaxConfig.viewportHeight,
      skyTopHex: parallaxConfig.skyTopHex,
      horizonHex: parallaxConfig.horizonHex,
      contrastDampening: parallaxConfig.contrastDampening,
      cameraSpeedPxPerSec: parallaxConfig.cameraSpeedPxPerSec,
      artMode,
      ...(parallaxConfig.blueprint ? { blueprint: parallaxConfig.blueprint } : {}),
    }),
    [parallaxConfig, artMode],
  );

  const exportPreviewText = useMemo(() => {
    const visibleOrAll = parallaxConfig.layers.some((l) => l.visible)
      ? parallaxConfig.layers.filter((l) => l.visible)
      : parallaxConfig.layers;
    const previewLayers: ParallaxExportLayer[] = visibleOrAll.map((layer) => {
      const dims = layerSizes[layer.id];
      const w = Math.max(16, dims?.width ?? parallaxConfig.viewportWidth);
      const h = Math.max(16, dims?.height ?? parallaxConfig.viewportHeight);
      return {
        id: layer.id,
        name: layer.name,
        ...(layer.role ? { role: layer.role } : {}),
        scrollRatioX: layer.scrollRatioX,
        yOffsetPx: layer.yOffsetPx,
        seamBlendPx: layer.seamBlendPx,
        depthHaze: layer.depthHaze,
        buffer: { width: w, height: h, data: new Uint8ClampedArray(0) },
      };
    });
    return exportTab === 'godot'
      ? exportGodotParallaxTscn(slug, previewLayers, exportOpts)
      : exportParallaxManifestJson(slug, previewLayers, exportOpts);
  }, [
    slug,
    exportTab,
    exportOpts,
    parallaxConfig.layers,
    parallaxConfig.viewportWidth,
    parallaxConfig.viewportHeight,
    layerSizes,
  ]);

  const handleCopyPreview = async () => {
    try {
      await navigator.clipboard.writeText(exportPreviewText);
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
      let masterBlobId = parallaxConfig.masterKeyframeBlobId;
      if (masterKeyframeBytesRef.current && (dirtyMasterRef.current || !masterBlobId)) {
        const masterBytesCopy = new Uint8Array(masterKeyframeBytesRef.current);
        const rec = await repository.storeBlob(
          new Blob([masterBytesCopy.buffer], { type: 'image/png' }),
          'image/png',
        );
        masterBlobId = rec.id;
        dirtyMasterRef.current = false;
      }

      const persistedLayers: ParallaxLayerConfig[] = [];
      for (const layer of parallaxConfig.layers) {
        const rawEntry = rawBuffersRef.current.get(layer.id);
        const needsBlobStore =
          Boolean(rawEntry) && (dirtyLayerIdsRef.current.has(layer.id) || !layer.blobId);
        if (rawEntry && needsBlobStore) {
          const rec = await repository.storeBlob(
            rgbaToPngBlob(rawEntry.buffer.data, rawEntry.buffer.width, rawEntry.buffer.height),
            'image/png',
          );
          dirtyLayerIdsRef.current.delete(layer.id);
          persistedLayers.push({ ...layer, blobId: rec.id });
        } else {
          persistedLayers.push(layer);
        }
      }

      const savedConfig: ParallaxSceneConfig = {
        ...parallaxConfig,
        ...(masterBlobId ? { masterKeyframeBlobId: masterBlobId } : {}),
        layers: persistedLayers,
      };

      onChangeConfig(savedConfig);
      await onSaveToProject(savedConfig);
      setSaveNotice(`Saved ${persistedLayers.length} parallax layers to IndexedDB.`);
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : 'Failed to save parallax scene.');
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadZip = () => {
    try {
      const exportLayers = collectProcessedExportLayers();
      if (exportLayers.length === 0) {
        setSaveNotice('No processed parallax layer buffers available to export.');
        return;
      }

      const recipe = buildAssetRecipe({
        project,
        node: targetNode,
        postProcess: postProcessConfig,
        filename: `${slug}.png`,
        outputWidth: parallaxConfig.viewportWidth,
        outputHeight: parallaxConfig.viewportHeight,
        normalizedWidth: rawWidth,
        normalizedHeight: rawHeight,
        recipeArtBibleHash: computeArtBibleHash(project.artBible),
        assetClass: targetNode.assetClass ?? 'tile',
        parallaxScene: parallaxConfig,
      });

      const zipBytes = packageParallaxZip({
        slug,
        layers: exportLayers,
        opts: exportOpts,
        recipe,
      });
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      triggerBlobDownload(
        new Blob([copy.buffer], { type: 'application/zip' }),
        `${slug}_parallax_bundle.zip`,
      );
      setSaveNotice(`Exported ${slug}_parallax_bundle.zip (${exportLayers.length} bands).`);
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : 'Failed to build parallax ZIP.');
    }
  };

  const selectedLayer = parallaxConfig.layers.find((l) => l.id === selectedLayerId) ?? null;
  const costEstimate = estimateParallaxGenerationCost(
    activeProvider?.kind ?? 'mock',
    bandCount,
    includeMasterKeyframe,
  );

  return (
    <div
      data-testid="parallax-workshop-panel"
      className="flex flex-1 flex-col overflow-hidden bg-[var(--bg-well)] lg:flex-row"
    >
      {/* Center/Left Stage: 60 FPS Parallax Canvas & Live Engine Export Preview */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-testid="parallax-play-toggle"
              onClick={() => setPlaying((p) => !p)}
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
            >
              {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {playing ? 'Pause' : 'Play'}
            </button>

            <button
              type="button"
              data-testid="parallax-reset-scroll-btn"
              onClick={() => {
                cameraXRef.current = 0;
              }}
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700"
            >
              <RotateCcw className="h-3 w-3" />
              Reset X
            </button>

            <button
              type="button"
              data-testid="parallax-dummy-toggle"
              aria-pressed={parallaxConfig.showForegroundDummy}
              onClick={() =>
                updateConfig({
                  ...parallaxConfig,
                  showForegroundDummy: !parallaxConfig.showForegroundDummy,
                })
              }
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium ${
                parallaxConfig.showForegroundDummy
                  ? 'border-[#F5B82E]/70 bg-[#F5B82E]/15 text-[#F5B82E]'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-slate-300 hover:bg-slate-700'
              }`}
            >
              <UserCheck className="h-3 w-3" />
              1× Sprite Contrast
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
              {VIEWPORT_PRESETS.map((vp) => {
                const active =
                  parallaxConfig.viewportWidth === vp.w && parallaxConfig.viewportHeight === vp.h;
                return (
                  <button
                    key={vp.label}
                    type="button"
                    data-testid={`parallax-vp-${vp.w}x${vp.h}`}
                    onClick={() =>
                      updateConfig({
                        ...parallaxConfig,
                        viewportWidth: vp.w,
                        viewportHeight: vp.h,
                      })
                    }
                    className={`rounded px-2 py-0.5 tabular-nums ${
                      active
                        ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    {vp.label}
                  </button>
                );
              })}
            </div>

            <span
              data-testid="parallax-meta-badge"
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-0.5 font-mono text-[11px] text-slate-200 tabular-nums"
            >
              {parallaxConfig.layers.length} bands · {parallaxConfig.viewportWidth}×
              {parallaxConfig.viewportHeight}
            </span>
          </div>
        </div>

        {/* Canvas2D Viewport */}
        <div className="flex flex-1 flex-col items-center justify-center overflow-auto bg-[var(--bg-well)] p-3">
          <div className="relative w-full max-w-[600px] rounded-md border border-[var(--border-hairline)] bg-[#0b0b0d] p-1.5 shadow-2xl">
            <canvas
              ref={stageCanvasRef}
              data-testid="parallax-preview-canvas"
              className="aspect-video w-full rounded bg-black object-contain"
              style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
            />
            {parallaxConfig.layers.length === 0 && (
              <div className="pointer-events-none absolute inset-x-4 bottom-4 flex justify-center">
                <span className="rounded border border-white/10 bg-black/75 px-3 py-1 text-[11px] text-slate-300">
                  Pick a biome preset + Generate Matched Stack (AI/Mock), or add bands on the right.
                </span>
              </div>
            )}
          </div>

          <div className="mt-2 flex w-full max-w-[600px] flex-wrap items-center gap-3">
            <div className="min-w-[200px] flex-1">
              <ScrubInput
                label="Camera Scroll Speed"
                value={parallaxConfig.cameraSpeedPxPerSec}
                min={-400}
                max={400}
                step={8}
                decimals={0}
                unit="px/s"
                testId="parallax-camera-speed-scrub"
                onChange={(val) => updateConfig({ ...parallaxConfig, cameraSpeedPxPerSec: val })}
              />
            </div>
            <div className="min-w-[200px] flex-1">
              <ScrubInput
                label="Contrast Dampening"
                value={parallaxConfig.contrastDampening}
                min={0}
                max={1}
                step={0.05}
                decimals={2}
                testId="parallax-contrast-damp-scrub"
                onChange={(val) => updateConfig({ ...parallaxConfig, contrastDampening: val })}
              />
            </div>
          </div>
        </div>

        {/* Bottom Engine Preview Strip */}
        <div className="border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2.5">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
              <button
                type="button"
                data-testid="parallax-export-tab-godot"
                onClick={() => setExportTab('godot')}
                className={`rounded px-2.5 py-0.5 font-medium ${
                  exportTab === 'godot'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Godot 4 Parallax2D (.tscn)
              </button>
              <button
                type="button"
                data-testid="parallax-export-tab-json"
                onClick={() => setExportTab('json')}
                className={`rounded px-2.5 py-0.5 font-medium ${
                  exportTab === 'json'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                Phaser TileSprite / PixiJS JSON
              </button>
            </div>

            <button
              type="button"
              data-testid="parallax-copy-btn"
              onClick={() => void handleCopyPreview()}
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
          <pre
            data-testid="parallax-export-preview"
            className="max-h-28 overflow-auto rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2 font-mono text-[11px] leading-snug whitespace-pre text-slate-300"
          >
            {exportPreviewText}
          </pre>
        </div>
      </div>

      {/* Right Sidebar: AI Stack Generator, Layer Stack, Atmospheric Depth & Bundle Export */}
      <aside className="w-full shrink-0 space-y-3.5 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 lg:w-[360px] lg:border-t-0 lg:border-l">
        {/* 1. Generate Matched Stack (AI / Offline Mock) Card */}
        <section
          data-testid="parallax-ai-card"
          className="rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)]"
        >
          <button
            type="button"
            onClick={() => setAiExpanded((e) => !e)}
            className="flex w-full items-center justify-between px-3 py-2 text-left text-xs font-semibold tracking-wider text-slate-200 uppercase"
          >
            <span className="flex items-center gap-1.5">
              <Sparkles className="h-3.5 w-3.5 text-[#F5B82E]" />
              Generate Matched Stack (AI)
            </span>
            {aiExpanded ? (
              <ChevronUp className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </button>

          {aiExpanded && (
            <div className="space-y-2.5 border-t border-[var(--border-hairline)] p-3 text-xs">
              <label className="block space-y-1">
                <span className="text-[11px] text-[var(--text-muted)]">Provider</span>
                <select
                  data-testid="parallax-provider-select"
                  value={activeProvider?.id ?? OFFLINE_MOCK_PROVIDER_ID}
                  onChange={(e) => setSelectedProviderId(e.target.value)}
                  className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1.5 text-xs text-slate-100"
                >
                  {selectableProviders.map((prov) => (
                    <option key={prov.id} value={prov.id}>
                      {prov.displayName} ({prov.kind})
                    </option>
                  ))}
                </select>
              </label>

              <div className="space-y-1">
                <span className="text-[11px] text-[var(--text-muted)]">Biome Presets</span>
                <div className="grid grid-cols-2 gap-1.5">
                  {PARALLAX_BIOME_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      data-testid={`parallax-biome-${preset.id}`}
                      onClick={() => {
                        setThemePrompt(preset.themePrompt);
                        updateConfig({
                          ...parallaxConfig,
                          skyTopHex: preset.skyTopHex,
                          horizonHex: preset.horizonHex,
                        });
                      }}
                      className="truncate rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-left text-[11px] text-slate-200 hover:border-[#F5B82E]/60 hover:text-white"
                      title={preset.label}
                    >
                      {preset.label}
                    </button>
                  ))}
                </div>
              </div>

              <label className="block space-y-1">
                <span className="text-[11px] text-[var(--text-muted)]">Scene Theme</span>
                <textarea
                  data-testid="parallax-theme-input"
                  rows={2}
                  value={themePrompt}
                  onChange={(e) => setThemePrompt(e.target.value)}
                  className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-2 text-[11px] text-slate-100"
                />
              </label>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-0.5 text-[11px]">
                  <button
                    type="button"
                    data-testid="parallax-band-count-3"
                    onClick={() => setBandCount(3)}
                    className={`rounded px-2 py-0.5 font-medium ${
                      bandCount === 3
                        ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    3 Bands
                  </button>
                  <button
                    type="button"
                    data-testid="parallax-band-count-4"
                    onClick={() => setBandCount(4)}
                    className={`rounded px-2 py-0.5 font-medium ${
                      bandCount === 4
                        ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                        : 'text-slate-300 hover:text-white'
                    }`}
                  >
                    4 Bands
                  </button>
                </div>

                <label className="flex items-center gap-1.5 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    data-testid="parallax-master-toggle"
                    checked={includeMasterKeyframe}
                    onChange={(e) => setIncludeMasterKeyframe(e.target.checked)}
                    className="accent-[#F5B82E]"
                  />
                  Master Ref
                </label>
              </div>

              <div
                data-testid="parallax-cost-badge"
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2.5 py-1 font-mono text-[10px] text-slate-300 tabular-nums"
              >
                {costEstimate.label}
              </div>

              <div className="flex gap-1.5">
                <button
                  type="button"
                  data-testid="parallax-generate-stack-btn"
                  disabled={isGenerating || regenLayerId !== null}
                  onClick={() => void handleGenerateMatchedStack()}
                  className="flex flex-1 items-center justify-center gap-1.5 rounded bg-[#F5B82E] px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {isGenerating ? 'Generating...' : 'Generate Matched Stack'}
                </button>
                {isGenerating && (
                  <button
                    type="button"
                    data-testid="parallax-abort-btn"
                    onClick={() => aiAbortRef.current?.abort()}
                    className="rounded border border-rose-500/40 bg-rose-950/60 px-2.5 py-1.5 text-[11px] font-medium text-rose-200 hover:bg-rose-900/60"
                  >
                    Cancel
                  </button>
                )}
              </div>

              {aiStatus && (
                <p data-testid="parallax-ai-status" className="text-[11px] text-emerald-300">
                  {aiStatus}
                </p>
              )}

              {aiError && (
                <div
                  data-testid="parallax-ai-error"
                  className="rounded border border-rose-500/40 bg-rose-950/70 px-2.5 py-1.5 text-[11px] text-rose-200"
                >
                  {aiError}
                </div>
              )}
            </div>
          )}
        </section>

        {/* 2. Layer Stack */}
        <section className="space-y-2 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3">
          <div className="flex items-center justify-between">
            <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-slate-200 uppercase">
              <Layers className="h-3.5 w-3.5 text-[#F5B82E]" />
              Bands (Back → Front)
            </h3>
            <span className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
              {parallaxConfig.layers.length} / 6
            </span>
          </div>

          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              data-testid="parallax-add-current-btn"
              disabled={parallaxConfig.layers.length >= 6}
              onClick={handleAddCurrentSprite}
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              Current Sprite
            </button>
            <button
              type="button"
              data-testid="parallax-upload-band-btn"
              disabled={parallaxConfig.layers.length >= 6}
              onClick={() => uploadInputRef.current?.click()}
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <ImagePlus className="h-3 w-3" />
              Upload PNG
            </button>
            <input
              ref={uploadInputRef}
              type="file"
              data-testid="parallax-upload-input"
              accept="image/png,image/webp"
              onChange={(e) => void handleUploadBandFile(e)}
              className="hidden"
            />
          </div>

          {spriteNodes.length > 1 && (
            <div className="flex gap-1.5">
              <select
                value={addSpriteNodeId}
                onChange={(e) => setAddSpriteNodeId(e.target.value)}
                className="min-w-0 flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200"
              >
                {spriteNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    {n.kind} · seed #{n.generationMeta.seed}
                  </option>
                ))}
              </select>
              <button
                type="button"
                disabled={parallaxConfig.layers.length >= 6}
                onClick={() => void handleAddProjectSprite()}
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                Add
              </button>
            </div>
          )}

          <div data-testid="parallax-layers-list" className="space-y-1">
            {parallaxConfig.layers.map((layer, idx) => {
              const selected = layer.id === selectedLayerId;
              const isBandRegening = regenLayerId === layer.id;
              return (
                <div
                  key={layer.id}
                  data-testid={`parallax-layer-row-${idx}`}
                  data-layer-id={layer.id}
                  data-layer-rev={layerRevisions[layer.id] ?? 0}
                  onClick={() => setSelectedLayerId(layer.id)}
                  className={`flex cursor-pointer items-center justify-between gap-1.5 rounded border px-2 py-1.5 text-[11px] transition-colors ${
                    selected
                      ? 'border-[#F5B82E]/70 bg-[#F5B82E]/10 text-white'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-panel)] text-slate-300 hover:border-slate-600'
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{layer.name}</div>
                    <div className="font-mono text-[10px] text-[var(--text-muted)] tabular-nums">
                      scroll {layer.scrollRatioX.toFixed(2)}× · haze{' '}
                      {Math.round(layer.depthHaze * 100)}%
                    </div>
                  </div>

                  <div
                    className="flex shrink-0 items-center gap-0.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      type="button"
                      data-testid={`parallax-regen-band-${idx}`}
                      title="Regenerate this band only"
                      disabled={isGenerating || regenLayerId !== null}
                      onClick={() => void handleRegenerateBand(idx)}
                      className="rounded p-1 text-slate-300 hover:bg-slate-700 hover:text-[#F5B82E] disabled:opacity-40"
                    >
                      <RefreshCw className={`h-3 w-3 ${isBandRegening ? 'animate-spin' : ''}`} />
                    </button>
                    <button
                      type="button"
                      title={layer.visible ? 'Hide band' : 'Show band'}
                      onClick={() =>
                        updateConfig({
                          ...parallaxConfig,
                          layers: parallaxConfig.layers.map((l) =>
                            l.id === layer.id ? { ...l, visible: !l.visible } : l,
                          ),
                        })
                      }
                      className="rounded p-1 text-slate-300 hover:bg-slate-700"
                    >
                      {layer.visible ? (
                        <Eye className="h-3 w-3" />
                      ) : (
                        <EyeOff className="h-3 w-3 text-slate-500" />
                      )}
                    </button>
                    <button
                      type="button"
                      title="Move further back"
                      disabled={idx === 0}
                      onClick={() => moveLayer(idx, -1)}
                      className="rounded p-1 text-slate-300 hover:bg-slate-700 disabled:opacity-30"
                    >
                      <ArrowUp className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Move further forward"
                      disabled={idx === parallaxConfig.layers.length - 1}
                      onClick={() => moveLayer(idx, 1)}
                      className="rounded p-1 text-slate-300 hover:bg-slate-700 disabled:opacity-30"
                    >
                      <ArrowDown className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      title="Delete band"
                      onClick={() => removeLayer(layer.id)}
                      className="rounded p-1 text-slate-400 hover:bg-rose-950 hover:text-rose-300"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 3. Selected Layer Parameters */}
        {selectedLayer && (
          <section className="space-y-2.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
                Layer Settings
              </h3>
              <span className="max-w-[140px] truncate text-[11px] text-[#F5B82E]">
                {selectedLayer.name}
              </span>
            </div>

            <ScrubInput
              label="Scroll Ratio"
              value={selectedLayer.scrollRatioX}
              min={0.05}
              max={1.25}
              step={0.05}
              decimals={2}
              unit="×"
              testId="parallax-scroll-ratio-scrub"
              onChange={(val) => updateSelectedLayer({ scrollRatioX: val })}
            />

            <ScrubInput
              label="Depth Haze"
              value={selectedLayer.depthHaze}
              min={0}
              max={1}
              step={0.05}
              decimals={2}
              testId="parallax-depth-haze-scrub"
              onChange={(val) => updateSelectedLayer({ depthHaze: val })}
            />

            <ScrubInput
              label="Seam Blend Width"
              value={selectedLayer.seamBlendPx}
              min={0}
              max={64}
              step={2}
              decimals={0}
              unit="px"
              testId="parallax-seam-blend-scrub"
              onChange={(val) => updateSelectedLayer({ seamBlendPx: Math.round(val) })}
            />

            <ScrubInput
              label="Y-Offset"
              value={selectedLayer.yOffsetPx}
              min={-256}
              max={256}
              step={2}
              decimals={0}
              unit="px"
              testId="parallax-y-offset-scrub"
              onChange={(val) => updateSelectedLayer({ yOffsetPx: Math.round(val) })}
            />

            <label className="flex items-center justify-between text-[11px] text-slate-300">
              <span>Strip #FF00FF Chroma Key</span>
              <input
                type="checkbox"
                data-testid="parallax-chroma-toggle"
                checked={selectedLayer.stripChromaKey}
                onChange={(e) => updateSelectedLayer({ stripChromaKey: e.target.checked })}
                className="accent-[#F5B82E]"
              />
            </label>
          </section>
        )}

        {/* 4. Atmosphere, Sky & Palette */}
        <section className="space-y-2.5 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-3 text-xs">
          <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
            Sky &amp; Horizon Atmosphere
          </h3>

          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-[11px] text-slate-300">
              <span>Sky Top</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  data-testid="parallax-sky-top-color"
                  value={parallaxConfig.skyTopHex}
                  onChange={(e) =>
                    updateConfig({
                      ...parallaxConfig,
                      skyTopHex: e.target.value.toUpperCase(),
                    })
                  }
                  className="h-6 w-7 cursor-pointer rounded border border-[var(--border-hairline)] bg-transparent"
                />
                <span className="font-mono text-[10px] text-slate-300">
                  {parallaxConfig.skyTopHex}
                </span>
              </div>
            </label>

            <label className="space-y-1 text-[11px] text-slate-300">
              <span>Horizon Scatter</span>
              <div className="flex items-center gap-1.5">
                <input
                  type="color"
                  data-testid="parallax-horizon-color"
                  value={parallaxConfig.horizonHex}
                  onChange={(e) =>
                    updateConfig({
                      ...parallaxConfig,
                      horizonHex: e.target.value.toUpperCase(),
                    })
                  }
                  className="h-6 w-7 cursor-pointer rounded border border-[var(--border-hairline)] bg-transparent"
                />
                <span className="font-mono text-[10px] text-slate-300">
                  {parallaxConfig.horizonHex}
                </span>
              </div>
            </label>
          </div>

          {project.artBible.palette.length > 0 && (
            <div className="space-y-1">
              <span className="text-[10px] text-[var(--text-muted)]">
                Art Bible Swatches → Horizon
              </span>
              <div className="flex flex-wrap gap-1">
                {project.artBible.palette.slice(0, 12).map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    title={`Set horizon scatter to ${hex}`}
                    onClick={() => updateConfig({ ...parallaxConfig, horizonHex: hex })}
                    className="h-4 w-4 rounded border border-white/20 transition-transform hover:scale-110"
                    style={{ backgroundColor: hex }}
                  />
                ))}
              </div>
            </div>
          )}

          <label className="flex items-center justify-between text-[11px] text-slate-300">
            <span>Snap to Art Bible Palette</span>
            <input
              type="checkbox"
              data-testid="parallax-palette-snap-toggle"
              checked={parallaxConfig.snapToPalette}
              onChange={(e) => updateConfig({ ...parallaxConfig, snapToPalette: e.target.checked })}
              className="accent-[#F5B82E]"
            />
          </label>
        </section>

        {/* 5. Save & Bundle Export */}
        <section className="space-y-2 pt-1">
          <button
            type="button"
            data-testid="parallax-save-btn"
            disabled={saving || isGenerating}
            onClick={() => void handleSave()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving Scene...' : 'Save Parallax Scene'}
          </button>

          <button
            type="button"
            data-testid="parallax-download-zip-btn"
            disabled={parallaxConfig.layers.length === 0 || isGenerating}
            onClick={handleDownloadZip}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
          >
            <FileArchive className="h-3.5 w-3.5" />
            Download Parallax Bundle (.zip)
          </button>

          {saveNotice && (
            <p data-testid="parallax-save-notice" className="text-[11px] text-emerald-300">
              {saveNotice}
            </p>
          )}
        </section>
      </aside>
    </div>
  );
}
