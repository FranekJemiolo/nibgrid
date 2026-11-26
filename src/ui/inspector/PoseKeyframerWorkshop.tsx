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
  FileArchive,
  GitBranch,
  Layers,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Save,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { repository } from '../../db/database';
import { sanitizeEntitySlug, type EntityDefinition } from '../../domain/entitySchema';
import type {
  ArtMode,
  PoseClipDefinitionSchemaType,
  PostProcessConfig,
  Project,
  ProviderConfig,
  SpriteNode,
} from '../../domain/schemas';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { packageSpriteZip, toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { decodePngBytesToRgba, encodeRgbaToPngBytes, rgbaToPngBlob } from '../../processing/png';
import {
  POSE_CYCLE_PRESETS,
  createPoseClipFromPreset,
  type PoseCyclePresetId,
} from '../../processing/posePresets';
import {
  ALL_POSE_JOINT_IDS,
  POSE_BONES,
  POSE_JOINT_COLORS,
  applyJointDragWithIk,
  interpolatePoseFrames,
  packFramesToHorizontalStrip,
  renderOpenPoseFrame,
  renderOpenPoseStrip,
  type PoseKeyframe,
  type PoseJointId,
  type RgbTriplet,
  type Vec2,
} from '../../processing/poseRigCore';
import { computeArtBibleHash } from '../../processing/projectAudit';
import type { RgbaBuffer } from '../../processing/types';
import {
  estimatePoseCycleCost,
  generatePoseSpriteCycle,
  regenerateSinglePoseFrame,
} from '../../providers/poseAnimationAdapter';
import { useAppStore } from '../../store/useAppStore';
import {
  createMonotonicRequestGuard,
  sliceAndAlignPoseStripInWorker,
} from '../../workers/postprocessClient';
import { ScrubInput } from '../primitives/ScrubInput';

export interface PoseKeyframerWorkshopProps {
  readonly sprite: RgbaBuffer;
  readonly artMode: ArtMode;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly providers: readonly ProviderConfig[];
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly poseClip: PoseClipDefinitionSchemaType;
  readonly onChangeClip: (next: PoseClipDefinitionSchemaType) => void;
  readonly onSaveToProject: (saved: PoseClipDefinitionSchemaType) => Promise<void>;
}

const PRESET_ORDER: readonly PoseCyclePresetId[] = [
  'run_6f',
  'melee_slash_5f',
  'jump_4f',
  'idle_4f',
];

function drawRgbaToCanvas(
  canvas: HTMLCanvasElement | null,
  buf: RgbaBuffer,
  artMode: ArtMode,
  overlays?: readonly {
    readonly buf: RgbaBuffer;
    readonly tintRgb: RgbTriplet;
    readonly alpha: number;
  }[],
): void {
  if (!canvas) return;
  const w = Math.max(1, buf.width);
  const h = Math.max(1, buf.height);
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = artMode !== 'pixel-art';
  ctx.clearRect(0, 0, w, h);

  if (overlays && overlays.length > 0) {
    for (const ov of overlays) {
      const tinted = new Uint8ClampedArray(ov.buf.data.length);
      for (let i = 0; i < ov.buf.data.length; i += 4) {
        const a = ov.buf.data[i + 3] ?? 0;
        if (a <= 8) continue;
        tinted[i] = Math.round((ov.buf.data[i] ?? 0) * 0.35 + ov.tintRgb[0] * 0.65);
        tinted[i + 1] = Math.round((ov.buf.data[i + 1] ?? 0) * 0.35 + ov.tintRgb[1] * 0.65);
        tinted[i + 2] = Math.round((ov.buf.data[i + 2] ?? 0) * 0.35 + ov.tintRgb[2] * 0.65);
        tinted[i + 3] = Math.round(a * ov.alpha);
      }
      const off = document.createElement('canvas');
      off.width = Math.max(1, ov.buf.width);
      off.height = Math.max(1, ov.buf.height);
      const offCtx = off.getContext('2d');
      if (offCtx) {
        offCtx.putImageData(new ImageData(tinted, off.width, off.height), 0, 0);
        ctx.drawImage(off, 0, 0, w, h);
      }
    }
  }

  const mainOff = document.createElement('canvas');
  mainOff.width = w;
  mainOff.height = h;
  const mainCtx = mainOff.getContext('2d');
  if (mainCtx) {
    mainCtx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), w, h), 0, 0);
    ctx.drawImage(mainOff, 0, 0, w, h);
  }
}

function FrameThumb({
  buffer,
  openPoseFrame,
  artMode,
}: {
  readonly buffer?: RgbaBuffer;
  readonly openPoseFrame: PoseKeyframe;
  readonly artMode: ArtMode;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const displayBuf = useMemo(
    () => buffer ?? renderOpenPoseFrame(openPoseFrame, 48, 48),
    [buffer, openPoseFrame],
  );
  useEffect(() => {
    drawRgbaToCanvas(ref.current, displayBuf, artMode);
  }, [artMode, displayBuf]);
  return (
    <canvas
      ref={ref}
      className="h-11 w-11 rounded border border-[var(--border-hairline)] bg-[#111115]"
      style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
    />
  );
}

/**
 * Screen 4O: 2D Stick-Figure Pose Keyframer with 2-Bone IK, OpenPose Strip Conditioning,
 * Red/Cyan Onion-Skinning, Timeline Playback & M25 EntityAnimationClip Commit.
 */
export function PoseKeyframerWorkshop({
  sprite,
  artMode,
  project,
  targetNode,
  providers,
  postProcessConfig,
  rawWidth,
  rawHeight,
  poseClip,
  onChangeClip,
  onSaveToProject,
}: PoseKeyframerWorkshopProps) {
  const { entities, saveEntityRecord } = useAppStore();

  const [selectedFrameIdx, setSelectedFrameIdx] = useState(0);
  const [useIk, setUseIk] = useState(true);
  const [mirrorLimbs, setMirrorLimbs] = useState(false);
  const [showPropArc, setShowPropArc] = useState(() =>
    poseClip.frames.some((f) => Boolean(f.propLine)),
  );
  const [onionPrev, setOnionPrev] = useState(true);
  const [onionNext, setOnionNext] = useState(true);
  const [viewOpenPoseGuide, setViewOpenPoseGuide] = useState(false);
  const [lockPalette, setLockPalette] = useState(true);

  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const preferred = providers.find((p) => p.enabled && p.kind === 'gemini') ?? providers[0];
    return preferred?.id ?? '';
  });
  const [selectedEntityId, setSelectedEntityId] = useState<string>(() => entities[0]?.id ?? '');

  const [generatedFrames, setGeneratedFrames] = useState<readonly RgbaBuffer[]>([]);
  const [generating, setGenerating] = useState(false);
  const [rerollingIdx, setRerollingIdx] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [docHidden, setDocHidden] = useState(() =>
    typeof document !== 'undefined' ? document.hidden : false,
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const stageCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingJointRef = useRef<PoseJointId | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const guardRef = useRef(createMonotonicRequestGuard());

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? providers[0],
    [providers, selectedProviderId],
  );
  const costEstimate = useMemo(
    () => estimatePoseCycleCost(activeProvider?.kind ?? 'mock', poseClip.frames.length),
    [activeProvider?.kind, poseClip.frames.length],
  );

  // Sync entity selection when entities change
  useEffect(() => {
    if (!selectedEntityId && entities.length > 0) {
      setSelectedEntityId(entities[0]!.id);
    }
  }, [entities, selectedEntityId]);

  // Hydrate persisted generated frame blobs from IndexedDB on mount / reload
  useEffect(() => {
    const blobIds = poseClip.generatedFrameBlobIds;
    if (!blobIds || blobIds.length === 0) {
      setGeneratedFrames([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      const loaded: RgbaBuffer[] = [];
      for (const blobId of blobIds) {
        const rec = await repository.getBlob(blobId);
        if (!rec || cancelled) continue;
        const bytes = new Uint8Array(await rec.bytes.arrayBuffer());
        const decoded = await decodePngBytesToRgba(bytes);
        loaded.push({ width: decoded.width, height: decoded.height, data: decoded.rgba });
      }
      if (!cancelled && loaded.length > 0) {
        setGeneratedFrames(loaded);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [poseClip.generatedFrameBlobIds]);

  useEffect(() => {
    const guard = guardRef.current;
    return () => {
      abortRef.current?.abort();
      guard.invalidate();
    };
  }, []);

  useEffect(() => {
    const onVis = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Safe frame index clamp
  const safeIdx = Math.max(0, Math.min(poseClip.frames.length - 1, selectedFrameIdx));
  const activeKeyframe = poseClip.frames[safeIdx]!;
  const prevIdx =
    safeIdx > 0 ? safeIdx - 1 : poseClip.loop ? Math.max(0, poseClip.frames.length - 1) : -1;
  const nextIdx =
    safeIdx < poseClip.frames.length - 1
      ? safeIdx + 1
      : poseClip.loop && poseClip.frames.length > 1
        ? 0
        : -1;
  const prevKeyframe = prevIdx >= 0 && prevIdx !== safeIdx ? poseClip.frames[prevIdx] : undefined;
  const nextKeyframe = nextIdx >= 0 && nextIdx !== safeIdx ? poseClip.frames[nextIdx] : undefined;

  // Visibility-aware FPS playback loop
  useEffect(() => {
    if (!playing || docHidden || poseClip.frames.length < 2) return;
    let rafId = 0;
    let lastTick = performance.now();
    const intervalMs = 1000 / Math.max(4, Math.min(24, poseClip.fps));
    const step = (now: number) => {
      if (now - lastTick >= intervalMs) {
        lastTick = now;
        setSelectedFrameIdx((cur) => {
          const next = cur + 1;
          if (next >= poseClip.frames.length) {
            if (!poseClip.loop) {
              setPlaying(false);
              return cur;
            }
            return 0;
          }
          return next;
        });
      }
      rafId = window.requestAnimationFrame(step);
    };
    rafId = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(rafId);
  }, [docHidden, playing, poseClip.fps, poseClip.frames.length, poseClip.loop]);

  // Stage canvas rendering (Active Sprite / OpenPose Guide + Red/Cyan Onion-Skin sprite frames)
  useEffect(() => {
    const activeGen = generatedFrames[safeIdx];
    const baseBuf = viewOpenPoseGuide
      ? renderOpenPoseFrame(activeKeyframe, poseClip.frameWidthPx, poseClip.frameHeightPx)
      : (activeGen ?? {
          width: poseClip.frameWidthPx,
          height: poseClip.frameHeightPx,
          data: new Uint8ClampedArray(poseClip.frameWidthPx * poseClip.frameHeightPx * 4),
        });

    const overlays: Array<{ buf: RgbaBuffer; tintRgb: RgbTriplet; alpha: number }> = [];
    if (!viewOpenPoseGuide) {
      if (onionPrev && prevIdx >= 0 && generatedFrames[prevIdx]) {
        overlays.push({
          buf: generatedFrames[prevIdx]!,
          tintRgb: [244, 63, 94],
          alpha: 0.35,
        });
      }
      if (onionNext && nextIdx >= 0 && generatedFrames[nextIdx]) {
        overlays.push({
          buf: generatedFrames[nextIdx]!,
          tintRgb: [6, 182, 212],
          alpha: 0.35,
        });
      }
    }

    drawRgbaToCanvas(stageCanvasRef.current, baseBuf, artMode, overlays);
  }, [
    activeKeyframe,
    artMode,
    generatedFrames,
    nextIdx,
    onionNext,
    onionPrev,
    poseClip.frameHeightPx,
    poseClip.frameWidthPx,
    prevIdx,
    safeIdx,
    viewOpenPoseGuide,
  ]);

  const mapPointerToNorm = useCallback((clientX: number, clientY: number): Vec2 => {
    const svg = svgRef.current;
    if (!svg) return { x: 0.5, y: 0.5 };
    const rect = svg.getBoundingClientRect();
    const x = Math.max(0.02, Math.min(0.98, (clientX - rect.left) / Math.max(1, rect.width)));
    const y = Math.max(0.02, Math.min(0.98, (clientY - rect.top) / Math.max(1, rect.height)));
    return { x, y };
  }, []);

  const handleJointPointerDown = (jointId: PoseJointId, e: ReactPointerEvent<SVGCircleElement>) => {
    e.stopPropagation();
    draggingJointRef.current = jointId;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  };

  const handleSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const jointId = draggingJointRef.current;
    if (!jointId) return;
    const nextPt = mapPointerToNorm(e.clientX, e.clientY);
    const updatedJoints = applyJointDragWithIk(activeKeyframe.joints, jointId, nextPt, {
      useIk,
      mirrorLimbs,
    });
    const nextFrames = poseClip.frames.map((frame, i) =>
      i === safeIdx ? { ...frame, joints: updatedJoints } : frame,
    );
    onChangeClip({ ...poseClip, frames: nextFrames });
  };

  const handleSvgPointerUp = () => {
    draggingJointRef.current = null;
  };

  const persistGeneratedFrames = async (
    clipBase: PoseClipDefinitionSchemaType,
    frames: readonly RgbaBuffer[],
    strip: RgbaBuffer,
  ): Promise<PoseClipDefinitionSchemaType> => {
    const frameBlobIds: string[] = [];
    for (const frame of frames) {
      const stored = await repository.storeBlob(
        rgbaToPngBlob(frame.data, frame.width, frame.height),
        'image/png',
      );
      frameBlobIds.push(stored.id);
    }
    const stripStored = await repository.storeBlob(
      rgbaToPngBlob(strip.data, strip.width, strip.height),
      'image/png',
    );
    const nextClip: PoseClipDefinitionSchemaType = {
      ...clipBase,
      generatedFrameBlobIds: frameBlobIds,
      generatedStripBlobId: stripStored.id,
    };
    onChangeClip(nextClip);
    await onSaveToProject(nextClip);
    return nextClip;
  };

  const toSchemaFrame = (frame: PoseKeyframe): PoseClipDefinitionSchemaType['frames'][number] => ({
    id: frame.id,
    joints: { ...frame.joints },
    ...(frame.propLine
      ? {
          propLine: [{ ...frame.propLine[0] }, { ...frame.propLine[1] }] as [
            { x: number; y: number },
            { x: number; y: number },
          ],
        }
      : {}),
  });

  const handleSelectPreset = (presetId: PoseCyclePresetId) => {
    setPlaying(false);
    const next = createPoseClipFromPreset(presetId, poseClip.frameWidthPx, poseClip.frameHeightPx);
    onChangeClip({
      slug: next.slug,
      fps: next.fps,
      loop: next.loop,
      frameWidthPx: next.frameWidthPx,
      frameHeightPx: next.frameHeightPx,
      frames: next.frames.map(toSchemaFrame),
    });
    setSelectedFrameIdx(0);
    setGeneratedFrames([]);
    setShowPropArc(next.frames.some((f) => Boolean(f.propLine)));
    setStatusNotice(
      `Loaded "${POSE_CYCLE_PRESETS[presetId].label}" preset (${next.frames.length} frames).`,
    );
    setErrorMsg(null);
  };

  const handleTogglePropArc = (checked: boolean) => {
    setShowPropArc(checked);
    const nextFrames = poseClip.frames.map((f) => {
      if (checked && !f.propLine) {
        const w = f.joints.r_wrist;
        return {
          ...f,
          propLine: [
            { x: w.x, y: w.y },
            { x: Math.min(0.95, w.x + 0.16), y: Math.max(0.05, w.y - 0.14) },
          ] as [{ x: number; y: number }, { x: number; y: number }],
        };
      }
      if (!checked && f.propLine) {
        const copy = { ...f };
        delete copy.propLine;
        return copy;
      }
      return toSchemaFrame(f);
    });
    onChangeClip({ ...poseClip, frames: nextFrames });
  };

  const handleAddFrame = () => {
    if (poseClip.frames.length >= 24) return;
    const cloned = toSchemaFrame({
      id: `pose-${Date.now()}`,
      joints: { ...activeKeyframe.joints },
      ...(activeKeyframe.propLine ? { propLine: activeKeyframe.propLine } : {}),
    });
    const nextFrames = [
      ...poseClip.frames.slice(0, safeIdx + 1).map(toSchemaFrame),
      cloned,
      ...poseClip.frames.slice(safeIdx + 1).map(toSchemaFrame),
    ];
    onChangeClip({ ...poseClip, frames: nextFrames });
    setSelectedFrameIdx(safeIdx + 1);
  };

  const handleInterpolateNext = () => {
    if (poseClip.frames.length >= 24 || poseClip.frames.length < 2) return;
    const neighborIdx = (safeIdx + 1) % poseClip.frames.length;
    const mid = toSchemaFrame(
      interpolatePoseFrames(
        poseClip.frames[safeIdx]!,
        poseClip.frames[neighborIdx]!,
        0.5,
        `pose-mid-${Date.now()}`,
      ),
    );
    const nextFrames = [
      ...poseClip.frames.slice(0, safeIdx + 1).map(toSchemaFrame),
      mid,
      ...poseClip.frames.slice(safeIdx + 1).map(toSchemaFrame),
    ];
    onChangeClip({ ...poseClip, frames: nextFrames });
    setSelectedFrameIdx(safeIdx + 1);
    setStatusNotice('Inserted interpolated midpoint keyframe.');
  };

  const handleDeleteFrame = () => {
    if (poseClip.frames.length <= 1) return;
    const nextFrames = poseClip.frames.filter((_, i) => i !== safeIdx);
    const nextGen = generatedFrames.filter((_, i) => i !== safeIdx);
    setGeneratedFrames(nextGen);
    onChangeClip({ ...poseClip, frames: nextFrames });
    setSelectedFrameIdx(Math.max(0, safeIdx - 1));
  };

  const handleGenerateCycle = async () => {
    if (!activeProvider) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const token = guardRef.current.next();
    setGenerating(true);
    setErrorMsg(null);
    setStatusNotice(null);

    try {
      const res = await generatePoseSpriteCycle(
        sprite,
        poseClip,
        project.artBible,
        activeProvider,
        {
          lockPalette,
          signal: controller.signal,
          sliceInWorker: sliceAndAlignPoseStripInWorker,
        },
      );
      if (!guardRef.current.isCurrent(token)) return;
      setGeneratedFrames(res.frames);
      await persistGeneratedFrames(poseClip, res.frames, res.generatedStrip);
      setStatusNotice(
        `Generated ${res.frames.length} aligned ${poseClip.frameWidthPx}×${poseClip.frameHeightPx} frames via ${res.providerLabel}.`,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatusNotice('Pose generation cancelled.');
      } else {
        setErrorMsg(err instanceof Error ? err.message : 'Pose cycle generation failed.');
      }
    } finally {
      if (guardRef.current.isCurrent(token)) {
        setGenerating(false);
      }
    }
  };

  const handleRerollFrame = async (idx: number) => {
    if (!activeProvider) return;
    setRerollingIdx(idx);
    setErrorMsg(null);
    try {
      const prevFrame = generatedFrames[Math.max(0, idx - 1)] ?? sprite;
      const frame = await regenerateSinglePoseFrame(
        sprite,
        prevFrame,
        poseClip.frames[idx]!,
        poseClip.frameWidthPx,
        poseClip.frameHeightPx,
        project.artBible,
        activeProvider,
        { lockPalette },
      );
      const nextFrames = poseClip.frames.map((_, fi) =>
        fi === idx ? frame : (generatedFrames[fi] ?? sprite),
      );
      setGeneratedFrames(nextFrames);
      const strip = packFramesToHorizontalStrip(nextFrames);
      await persistGeneratedFrames(poseClip, nextFrames, strip);
      setStatusNotice(`Re-rolled Frame ${idx + 1} cleanly.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Frame re-roll failed.');
    } finally {
      setRerollingIdx(null);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorMsg(null);
    try {
      if (generatedFrames.length > 0) {
        const strip = packFramesToHorizontalStrip(generatedFrames);
        await persistGeneratedFrames(poseClip, generatedFrames, strip);
      } else {
        await onSaveToProject(poseClip);
      }
      setStatusNotice(`Saved "${poseClip.slug}" pose clip (${poseClip.frames.length} keyframes).`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save pose clip.');
    } finally {
      setSaving(false);
    }
  };

  const handleCommitToEntity = async () => {
    setCommitting(true);
    setErrorMsg(null);
    try {
      let currentClip = poseClip;
      if (generatedFrames.length > 0) {
        const strip = packFramesToHorizontalStrip(generatedFrames);
        currentClip = await persistGeneratedFrames(poseClip, generatedFrames, strip);
      } else {
        await onSaveToProject(poseClip);
      }

      const clipName = sanitizeEntitySlug(currentClip.slug || 'run');
      const existing = entities.find((e) => e.id === selectedEntityId) ?? entities[0];

      if (existing) {
        const nextClips = [
          ...existing.clips.filter((c) => sanitizeEntitySlug(c.name) !== clipName),
          {
            name: clipName,
            spriteNodeId: targetNode.id,
            fps: currentClip.fps,
            loop: currentClip.loop,
          },
        ];
        const savedEnt = await saveEntityRecord({
          ...existing,
          clips: nextClips,
          updatedAt: Date.now(),
        });
        setSelectedEntityId(savedEnt.id);
        setStatusNotice(`Committed "${clipName}" clip to entity "${savedEnt.displayName}".`);
      } else {
        const newEntity: EntityDefinition = {
          id: globalThis.crypto.randomUUID(),
          projectId: project.id,
          slug: sanitizeEntitySlug(project.name || 'hero'),
          displayName: project.name.trim() || 'Hero Entity',
          bodyType: 'CharacterBody2D',
          resSubpath: 'assets/nibgrid',
          primarySpriteNodeId: targetNode.id,
          clips: [
            {
              name: clipName,
              spriteNodeId: targetNode.id,
              fps: currentClip.fps,
              loop: currentClip.loop,
            },
          ],
          audioAssetIds: [],
          includeNormalMap: false,
          updatedAt: Date.now(),
        };
        const savedEnt = await saveEntityRecord(newEntity);
        setSelectedEntityId(savedEnt.id);
        setStatusNotice(`Created entity "${savedEnt.displayName}" with "${clipName}" clip.`);
      }
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to commit pose clip to entity.');
    } finally {
      setCommitting(false);
    }
  };

  const handleDownloadZip = () => {
    const slug = toAssetSlug(
      `${project.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`,
    );
    const openPoseStrip = renderOpenPoseStrip(
      poseClip.frames,
      poseClip.frameWidthPx,
      poseClip.frameHeightPx,
    );
    const framesForStrip = generatedFrames.length > 0 ? generatedFrames : [sprite];
    const stripBuf = packFramesToHorizontalStrip(framesForStrip);
    const stripPngBytes = encodeRgbaToPngBytes(stripBuf.data, stripBuf.width, stripBuf.height);
    const openPoseStripPngBytes = encodeRgbaToPngBytes(
      openPoseStrip.data,
      openPoseStrip.width,
      openPoseStrip.height,
    );
    const recipe = buildAssetRecipe({
      project,
      node: targetNode,
      postProcess: postProcessConfig,
      filename: `${slug}.png`,
      outputWidth: sprite.width,
      outputHeight: sprite.height,
      normalizedWidth: rawWidth,
      normalizedHeight: rawHeight,
      poseClip,
      recipeArtBibleHash: computeArtBibleHash(project.artBible),
      assetClass: targetNode.assetClass ?? 'character',
    });

    const zipBytes = packageSpriteZip({
      slug,
      pngBytes: encodeRgbaToPngBytes(sprite.data, sprite.width, sprite.height),
      recipe,
      poseClipBundle: {
        stripPngBytes,
        openPoseStripPngBytes,
        clipName: poseClip.slug,
      },
    });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'application/zip' }),
      `${slug}_${sanitizeEntitySlug(poseClip.slug)}.zip`,
    );
    setStatusNotice(
      `Downloaded ${slug}_${sanitizeEntitySlug(poseClip.slug)}.zip (strip + OpenPose guide + recipe).`,
    );
  };

  const renderSkeletonLines = (
    kf: PoseKeyframe,
    opts: { colorOverride?: string; opacity?: number; testIdPrefix?: string },
  ) => (
    <g opacity={opts.opacity ?? 1} pointerEvents="none">
      {POSE_BONES.map((bone) => {
        const a = kf.joints[bone.from];
        const b = kf.joints[bone.to];
        const stroke = opts.colorOverride ?? `rgb(${bone.rgb[0]}, ${bone.rgb[1]}, ${bone.rgb[2]})`;
        return (
          <line
            key={`${opts.testIdPrefix ?? 'bone'}-${bone.from}-${bone.to}`}
            x1={a.x * 100}
            y1={a.y * 100}
            x2={b.x * 100}
            y2={b.y * 100}
            stroke={stroke}
            strokeWidth={2.4}
            strokeLinecap="round"
          />
        );
      })}
      {kf.propLine && (
        <line
          x1={kf.propLine[0].x * 100}
          y1={kf.propLine[0].y * 100}
          x2={kf.propLine[1].x * 100}
          y2={kf.propLine[1].y * 100}
          stroke={opts.colorOverride ?? '#00FFFF'}
          strokeWidth={2.0}
          strokeLinecap="round"
        />
      )}
    </g>
  );

  return (
    <div
      data-testid="pose-keyframer-panel"
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[300px_minmax(0,1fr)_290px]"
    >
      {/* Left Pane: Presets, Rig & AI Generation */}
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <GitBranch className="h-3.5 w-3.5 text-[#F5B82E]" />
            <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
              Pose Keyframer
            </h3>
          </div>
          <span
            data-testid="pose-cost-badge"
            className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-300"
          >
            {costEstimate.label}
          </span>
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-slate-300">Clip Name</span>
          <input
            type="text"
            data-testid="pose-clip-slug-input"
            value={poseClip.slug}
            onChange={(e) => onChangeClip({ ...poseClip, slug: e.target.value })}
            className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-slate-100 focus:border-[#F5B82E] focus:outline-none"
          />
        </label>

        {/* Built-In Presets */}
        <div className="space-y-1.5">
          <span className="block text-[11px] font-medium text-slate-300">Cycle Presets</span>
          <div className="grid grid-cols-2 gap-1.5">
            {PRESET_ORDER.map((pid) => {
              const preset = POSE_CYCLE_PRESETS[pid];
              const active =
                poseClip.slug === preset.slug && poseClip.frames.length === preset.frames.length;
              return (
                <button
                  key={pid}
                  type="button"
                  data-testid={`pose-preset-${pid}`}
                  onClick={() => handleSelectPreset(pid)}
                  className={`rounded border px-2 py-1.5 text-left text-[11px] font-medium ${
                    active
                      ? 'border-[#F5B82E] bg-[#F5B82E]/15 text-[#F5B82E]'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:text-white'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Rig Toggles */}
        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5 text-xs text-slate-200">
          <label className="flex cursor-pointer items-center justify-between">
            <span>2-Bone IK (Wrists / Ankles)</span>
            <input
              type="checkbox"
              data-testid="pose-ik-toggle"
              checked={useIk}
              onChange={(e) => setUseIk(e.target.checked)}
              className="accent-[#F5B82E]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between">
            <span>Auto-Mirror Limbs</span>
            <input
              type="checkbox"
              data-testid="pose-mirror-toggle"
              checked={mirrorLimbs}
              onChange={(e) => setMirrorLimbs(e.target.checked)}
              className="accent-[#F5B82E]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between">
            <span>Show Weapon / Prop Arc</span>
            <input
              type="checkbox"
              data-testid="pose-prop-toggle"
              checked={showPropArc}
              onChange={(e) => handleTogglePropArc(e.target.checked)}
              className="accent-[#F5B82E]"
            />
          </label>
          <label className="flex cursor-pointer items-center justify-between">
            <span>Lock to Art Bible Palette</span>
            <input
              type="checkbox"
              data-testid="pose-lock-palette-toggle"
              checked={lockPalette}
              onChange={(e) => setLockPalette(e.target.checked)}
              className="accent-[#F5B82E]"
            />
          </label>
        </div>

        {/* Generation Controls */}
        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-slate-300">Conditioning Provider</span>
            <select
              data-testid="pose-provider-select"
              value={activeProvider?.id ?? ''}
              onChange={(e) => setSelectedProviderId(e.target.value)}
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1.5 text-xs text-slate-100 focus:border-[#F5B82E] focus:outline-none"
            >
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.displayName}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            data-testid="pose-generate-btn"
            disabled={generating}
            onClick={() => void handleGenerateCycle()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {generating ? 'Generating Cycle...' : 'Generate Sprite Cycle (AI)'}
          </button>

          {errorMsg && (
            <p data-testid="pose-error-banner" className="text-[11px] text-rose-300">
              {errorMsg}
            </p>
          )}
        </div>
      </aside>

      {/* Center Pane: Interactive Onion-Skin Canvas + Timeline */}
      <section className="flex min-h-0 flex-col overflow-hidden bg-[var(--bg-well)]">
        {/* Top Stage Controls Bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[11px] text-slate-200">
          <div className="flex items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="pose-onion-prev-toggle"
                checked={onionPrev}
                onChange={(e) => setOnionPrev(e.target.checked)}
                className="accent-rose-500"
              />
              <span className="text-rose-300">Prev Frame (Red)</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="pose-onion-next-toggle"
                checked={onionNext}
                onChange={(e) => setOnionNext(e.target.checked)}
                className="accent-cyan-400"
              />
              <span className="text-cyan-300">Next Frame (Cyan)</span>
            </label>
            <label className="inline-flex cursor-pointer items-center gap-1.5">
              <input
                type="checkbox"
                data-testid="pose-view-guide-toggle"
                checked={viewOpenPoseGuide}
                onChange={(e) => setViewOpenPoseGuide(e.target.checked)}
                className="accent-[#F5B82E]"
              />
              <span>OpenPose Guide</span>
            </label>
          </div>
          <span className="font-mono text-[10px] text-slate-400">
            Frame {safeIdx + 1}/{poseClip.frames.length} · {poseClip.frameWidthPx}×
            {poseClip.frameHeightPx}
          </span>
        </div>

        {/* Interactive Canvas + Draggable SVG Rig */}
        <div className="flex min-h-0 flex-1 items-center justify-center p-4">
          <div className="bg-checkerboard relative h-[288px] w-[288px] rounded-lg border border-[var(--border-hairline)] shadow-xl">
            <canvas
              ref={stageCanvasRef}
              data-testid="pose-stage-canvas"
              className="block h-full w-full rounded-lg"
              style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
            />
            <svg
              ref={svgRef}
              data-testid="pose-rig-svg"
              viewBox="0 0 100 100"
              onPointerMove={handleSvgPointerMove}
              onPointerUp={handleSvgPointerUp}
              onPointerLeave={handleSvgPointerUp}
              className="absolute inset-0 h-full w-full select-none overflow-visible"
              style={{ touchAction: 'none' }}
            >
              {onionPrev && prevKeyframe && (
                <g data-testid="pose-onion-prev-rig">
                  {renderSkeletonLines(prevKeyframe, {
                    colorOverride: '#f43f5e',
                    opacity: 0.35,
                    testIdPrefix: 'prev',
                  })}
                </g>
              )}
              {onionNext && nextKeyframe && (
                <g data-testid="pose-onion-next-rig">
                  {renderSkeletonLines(nextKeyframe, {
                    colorOverride: '#06b6d4',
                    opacity: 0.35,
                    testIdPrefix: 'next',
                  })}
                </g>
              )}
              {renderSkeletonLines(activeKeyframe, { opacity: 0.95, testIdPrefix: 'active' })}
              {ALL_POSE_JOINT_IDS.map((jointId) => {
                const pt = activeKeyframe.joints[jointId];
                const rgb = POSE_JOINT_COLORS[jointId];
                return (
                  <circle
                    key={jointId}
                    data-testid={`pose-joint-${jointId}`}
                    data-x={pt.x.toFixed(4)}
                    data-y={pt.y.toFixed(4)}
                    cx={pt.x * 100}
                    cy={pt.y * 100}
                    r={3.1}
                    fill={`rgb(${rgb[0]}, ${rgb[1]}, ${rgb[2]})`}
                    stroke="#111113"
                    strokeWidth={0.9}
                    className="cursor-grab active:cursor-grabbing"
                    onPointerDown={(e) => handleJointPointerDown(jointId, e)}
                  />
                );
              })}
            </svg>
          </div>
        </div>

        {/* Bottom Timeline Strip & Playback */}
        <div
          data-testid="pose-timeline-strip"
          className="space-y-2 border-t border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3"
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                data-testid="pose-play-btn"
                onClick={() => setPlaying((p) => !p)}
                className="inline-flex items-center gap-1 rounded bg-[#F5B82E] px-2.5 py-1 text-[11px] font-semibold text-zinc-950 hover:bg-[#fbcb57]"
              >
                {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                {playing ? 'Pause' : 'Play'}
              </button>
              <button
                type="button"
                data-testid="pose-add-frame-btn"
                onClick={handleAddFrame}
                className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200 hover:border-[#F5B82E]/50"
              >
                <Plus className="h-3 w-3" />
                Add
              </button>
              <button
                type="button"
                data-testid="pose-dup-frame-btn"
                onClick={handleAddFrame}
                className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200 hover:border-[#F5B82E]/50"
              >
                <Copy className="h-3 w-3" />
                Dup
              </button>
              <button
                type="button"
                data-testid="pose-interp-frame-btn"
                onClick={handleInterpolateNext}
                className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200 hover:border-[#F5B82E]/50"
              >
                <Layers className="h-3 w-3" />
                Interp
              </button>
              <button
                type="button"
                data-testid="pose-del-frame-btn"
                disabled={poseClip.frames.length <= 1}
                onClick={handleDeleteFrame}
                className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200 hover:border-rose-500/50 disabled:opacity-40"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-slate-300">
                <input
                  type="checkbox"
                  data-testid="pose-loop-toggle"
                  checked={poseClip.loop}
                  onChange={(e) => onChangeClip({ ...poseClip, loop: e.target.checked })}
                  className="accent-[#F5B82E]"
                />
                Loop
              </label>
              <div className="w-32">
                <ScrubInput
                  label="FPS"
                  value={poseClip.fps}
                  min={4}
                  max={24}
                  step={1}
                  testId="pose-fps-scrub"
                  onChange={(v) => onChangeClip({ ...poseClip, fps: Math.round(v) })}
                />
              </div>
            </div>
          </div>

          <div className="flex gap-2 overflow-x-auto pb-1">
            {poseClip.frames.map((kf, idx) => (
              <div
                key={kf.id}
                className={`flex shrink-0 flex-col items-center gap-1 rounded border p-1 ${
                  idx === safeIdx
                    ? 'border-[#F5B82E] bg-[#F5B82E]/10'
                    : 'border-[var(--border-hairline)] bg-[var(--bg-well)]'
                }`}
              >
                <button
                  type="button"
                  data-testid={`pose-frame-thumb-${idx}`}
                  onClick={() => setSelectedFrameIdx(idx)}
                  className="focus:outline-none"
                >
                  <FrameThumb buffer={generatedFrames[idx]} openPoseFrame={kf} artMode={artMode} />
                </button>
                <div className="flex w-full items-center justify-between px-0.5 text-[10px] font-mono text-slate-300">
                  <span>F{idx + 1}</span>
                  <button
                    type="button"
                    data-testid={`pose-reroll-frame-${idx}`}
                    disabled={rerollingIdx === idx}
                    title={`Regenerate Frame ${idx + 1}`}
                    onClick={() => void handleRerollFrame(idx)}
                    className="rounded p-0.5 text-slate-300 hover:bg-slate-700 hover:text-[#F5B82E] disabled:opacity-40"
                  >
                    <RefreshCw
                      className={`h-2.5 w-2.5 ${rerollingIdx === idx ? 'animate-spin' : ''}`}
                    />
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Right Pane: Save, Commit to M25 Entity & Export */}
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5">
        <h4 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
          M25 Entity & Export
        </h4>

        <div className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5 text-[11px] text-slate-300">
          <div className="flex justify-between">
            <span>Clip Slug</span>
            <span className="font-mono text-slate-100">{sanitizeEntitySlug(poseClip.slug)}</span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>Keyframes</span>
            <span data-testid="pose-frame-count" className="font-mono text-slate-100">
              {poseClip.frames.length} frames
            </span>
          </div>
          <div className="mt-1 flex justify-between">
            <span>Generated Cells</span>
            <span data-testid="pose-generated-count" className="font-mono text-emerald-300">
              {generatedFrames.length}/{poseClip.frames.length}
            </span>
          </div>
        </div>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-slate-300">Target M25 Entity</span>
          <select
            data-testid="pose-entity-select"
            value={selectedEntityId}
            onChange={(e) => setSelectedEntityId(e.target.value)}
            className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1.5 text-xs text-slate-100 focus:border-[#F5B82E] focus:outline-none"
          >
            {entities.length === 0 ? (
              <option value="">Create New Entity ({project.name || 'Hero'})</option>
            ) : (
              entities.map((ent) => (
                <option key={ent.id} value={ent.id}>
                  {ent.displayName} ({ent.slug})
                </option>
              ))
            )}
          </select>
        </label>

        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <button
            type="button"
            data-testid="pose-save-btn"
            disabled={saving}
            onClick={() => void handleSave()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving Clip...' : 'Save Pose Clip'}
          </button>

          <button
            type="button"
            data-testid="pose-commit-entity-btn"
            disabled={committing}
            onClick={() => void handleCommitToEntity()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[#F5B82E]/50 bg-[#F5B82E]/15 px-3 py-2 text-xs font-semibold text-[#F5B82E] hover:bg-[#F5B82E]/25 disabled:opacity-50"
          >
            <Layers className="h-3.5 w-3.5" />
            {committing ? 'Committing...' : 'Commit Clip to Active M25 Entity'}
          </button>

          <button
            type="button"
            data-testid="pose-download-zip-btn"
            onClick={handleDownloadZip}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
          >
            <FileArchive className="h-3.5 w-3.5" />
            Download Sprite Sheet ZIP
          </button>

          {statusNotice && (
            <p data-testid="pose-status-notice" className="text-[11px] text-emerald-300">
              {statusNotice}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
