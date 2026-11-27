import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bug, Play, RotateCcw, Save, Volume2, VolumeX, X } from 'lucide-react';
import { AudioPlaybackEngine, decodeAudioBytesToPcm } from '../../audio/playbackEngine';
import { synthesizeProceduralSfx } from '../../audio/proceduralSynth';
import type { PcmBuffer } from '../../audio/types';
import { repository } from '../../db/database';
import type { EntityDefinition } from '../../domain/entitySchema';
import type { AudioAsset, Project, SpriteNode } from '../../domain/schemas';
import {
  computeHitFlashUniform,
  createFixedTimestepRunner,
  ensureEntityPlaytestGdScript,
} from '../../export/playtestStatSync';
import { getBuiltInGlyphMask } from '../../processing/pixelGlyphTable';
import {
  DEFAULT_PLAYTEST_STAGE_BOUNDS,
  aabbsOverlap,
  computeAabbFromCollisionShapes,
  createDefaultPlaytestJuiceConfig,
  createInitialPlaytestWorld,
  resetPlaytestDummy,
  stepPlaytestSimulation,
  transformLocalAabbToWorld,
  type PlaytestClipMeta,
  type PlaytestEntityMeta,
  type PlaytestInputState,
  type PlaytestJuiceConfig,
  type PlaytestWorldState,
} from '../../processing/playtestEngineCore';
import { decodePngBytesToRgba } from '../../processing/png';
import { generateBiomeTile } from '../../processing/sandboxBiomes';
import { ScrubInput } from '../primitives/ScrubInput';

export interface EntityPlaytestStageProps {
  readonly entity: EntityDefinition;
  readonly project: Project;
  readonly spriteNodes: readonly SpriteNode[];
  readonly audioAssets: readonly AudioAsset[];
  readonly onApplyStats: (updated: EntityDefinition) => Promise<void>;
  readonly onClose: () => void;
}

interface FloatingDamageNumeral {
  id: number;
  x: number;
  y: number;
  value: number;
  ageMs: number;
}

interface FloatingImpactBurst {
  id: number;
  x: number;
  y: number;
  ageMs: number;
}

const LOGICAL_WIDTH = DEFAULT_PLAYTEST_STAGE_BOUNDS.width;
const LOGICAL_HEIGHT = DEFAULT_PLAYTEST_STAGE_BOUNDS.height;
const FLOOR_Y = DEFAULT_PLAYTEST_STAGE_BOUNDS.floorY;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}

function drawBitmapNumeral(
  ctx: CanvasRenderingContext2D,
  text: string,
  centerX: number,
  topY: number,
  fillColor: string,
): void {
  const glyphs = Array.from(text).map((ch) => getBuiltInGlyphMask(ch));
  const totalWidth = glyphs.reduce((acc, g) => acc + g.xadvance, 0);
  let cursorX = Math.round(centerX - totalWidth * 0.5);
  const startY = Math.round(topY);

  for (const glyph of glyphs) {
    // 1px dark outline for crisp readability over any backdrop
    ctx.fillStyle = '#090d16';
    for (let gy = 0; gy < glyph.height; gy++) {
      for (let gx = 0; gx < glyph.width; gx++) {
        if ((glyph.alpha[gy * glyph.width + gx] ?? 0) > 127) {
          ctx.fillRect(cursorX + gx - 1, startY + gy, 3, 1);
          ctx.fillRect(cursorX + gx, startY + gy - 1, 1, 3);
        }
      }
    }
    ctx.fillStyle = fillColor;
    for (let gy = 0; gy < glyph.height; gy++) {
      for (let gx = 0; gx < glyph.width; gx++) {
        if ((glyph.alpha[gy * glyph.width + gx] ?? 0) > 127) {
          ctx.fillRect(cursorX + gx, startY + gy, 1, 1);
        }
      }
    }
    cursorX += glyph.xadvance;
  }
}

async function blobToOffscreenCanvas(blob: Blob): Promise<HTMLCanvasElement | null> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const canvas = document.createElement('canvas');
  try {
    const decoded = await decodePngBytesToRgba(bytes);
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(decoded.rgba), decoded.width, decoded.height),
      0,
      0,
    );
    return canvas;
  } catch {
    try {
      const bitmap = await createImageBitmap(blob);
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close();
        return null;
      }
      ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      return canvas;
    } catch {
      return null;
    }
  }
}

export function EntityPlaytestStage({
  entity,
  project,
  spriteNodes,
  audioAssets,
  onApplyStats,
  onClose,
}: EntityPlaytestStageProps) {
  const initialMode =
    entity.playtestConfig?.mode ??
    (project.artBible.projection === 'top-down' ? 'top-down' : 'side-platformer');

  const [config, setConfig] = useState<PlaytestJuiceConfig>(() =>
    createDefaultPlaytestJuiceConfig({
      ...(entity.playtestConfig ?? {}),
      mode: initialMode,
    }),
  );
  const [stageScale, setStageScale] = useState<2 | 3>(2);
  const [muted, setMuted] = useState(false);
  const [debugOverlay, setDebugOverlay] = useState(false);
  const [dummyHp, setDummyHp] = useState(100);
  const [dummyMaxHp, setDummyMaxHp] = useState(100);
  const [lastSfxCue, setLastSfxCue] = useState<string>('—');
  const [savingStats, setSavingStats] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const configRef = useRef(config);
  configRef.current = config;
  const mutedRef = useRef(muted);
  mutedRef.current = muted;
  const debugRef = useRef(debugOverlay);
  debugRef.current = debugOverlay;

  const worldRef = useRef<PlaytestWorldState>(
    createInitialPlaytestWorld(config, DEFAULT_PLAYTEST_STAGE_BOUNDS),
  );
  const heldKeysRef = useRef<{
    left: boolean;
    right: boolean;
    up: boolean;
    down: boolean;
    jumpQueued: boolean;
    attackQueued: boolean;
  }>({
    left: false,
    right: false,
    up: false,
    down: false,
    jumpQueued: false,
    attackQueued: false,
  });

  const primaryNode = useMemo(
    () => spriteNodes.find((n) => n.id === entity.primarySpriteNodeId) ?? spriteNodes[0],
    [spriteNodes, entity.primarySpriteNodeId],
  );

  const entityMeta = useMemo<PlaytestEntityMeta>(() => {
    const shapes = primaryNode?.collisionShapes ?? [];
    const collider = computeAabbFromCollisionShapes(shapes, 'collider', {
      minX: -12,
      minY: -28,
      maxX: 12,
      maxY: 0,
    });
    const hurtbox = computeAabbFromCollisionShapes(shapes, 'hurtbox', {
      minX: -14,
      minY: -30,
      maxX: 14,
      maxY: 0,
    });
    const hitbox = computeAabbFromCollisionShapes(shapes, 'hitbox', {
      minX: 2,
      minY: -28,
      maxX: 52,
      maxY: 0,
    });

    const clips: PlaytestClipMeta[] =
      entity.clips.length > 0
        ? entity.clips.map((c) => {
            const node = spriteNodes.find((n) => n.id === c.spriteNodeId);
            const frameCount = node?.puppetAnim?.frameCount ?? node?.poseClip?.frames.length ?? 4;
            return {
              name: c.name,
              fps: c.fps || 8,
              frameCount: Math.max(1, frameCount),
              loop: c.loop,
              ...(c.name.toLowerCase().includes('attack') || c.name.toLowerCase().includes('slash')
                ? { activeFrames: hitbox.activeFrames }
                : {}),
              ...(c.frameAudioTriggers ? { frameAudioTriggers: c.frameAudioTriggers } : {}),
            };
          })
        : [
            { name: 'idle', fps: 8, frameCount: 4, loop: true },
            { name: 'run', fps: 12, frameCount: 4, loop: true },
            { name: 'jump', fps: 8, frameCount: 2, loop: false },
            {
              name: 'attack',
              fps: 12,
              frameCount: 4,
              loop: false,
              activeFrames: hitbox.activeFrames,
            },
          ];

    return {
      clips,
      colliderBox: collider.aabb,
      hurtbox: hurtbox.aabb,
      hitbox: hitbox.aabb,
      hitboxActiveFrames: hitbox.activeFrames.length > 0 ? hitbox.activeFrames : [1, 2],
      stageWidth: LOGICAL_WIDTH,
      stageHeight: LOGICAL_HEIGHT,
      floorY: FLOOR_Y,
    };
  }, [entity.clips, primaryNode, spriteNodes]);

  const entityMetaRef = useRef(entityMeta);
  entityMetaRef.current = entityMeta;

  const audioEngineRef = useRef<AudioPlaybackEngine | null>(null);
  const audioCueMapRef = useRef<Map<string, PcmBuffer>>(new Map());
  const defaultHitPcmRef = useRef<PcmBuffer | null>(null);
  const spriteCanvasesRef = useRef<{
    player: HTMLCanvasElement | null;
    dummyWhite: HTMLCanvasElement | null;
    biomeTile: HTMLCanvasElement | null;
  }>({
    player: null,
    dummyWhite: null,
    biomeTile: null,
  });

  const floatingNumbersRef = useRef<FloatingDamageNumeral[]>([]);
  const floatingBurstsRef = useRef<FloatingImpactBurst[]>([]);
  const nextParticleIdRef = useRef(1);

  // Decode primary sprite, white hit-flash silhouette, procedural biome tile, and M14/M15 audio blobs
  useEffect(() => {
    let cancelled = false;
    const engine = new AudioPlaybackEngine();
    audioEngineRef.current = engine;

    // Synthesize procedural biome floor & fallback hit impact thud
    const biomeId = project.artBible.lighting === 'flat' ? 'sunlit-meadow' : 'dark-dungeon';
    const tileBuf = generateBiomeTile(biomeId, 64);
    const tileCanvas = document.createElement('canvas');
    tileCanvas.width = tileBuf.width;
    tileCanvas.height = tileBuf.height;
    const tileCtx = tileCanvas.getContext('2d');
    if (tileCtx) {
      tileCtx.putImageData(
        new ImageData(new Uint8ClampedArray(tileBuf.data), tileBuf.width, tileBuf.height),
        0,
        0,
      );
      spriteCanvasesRef.current.biomeTile = tileCanvas;
    }

    defaultHitPcmRef.current = synthesizeProceduralSfx({
      seed: 1337,
      durationSec: 0.14,
      sampleRate: 22050,
      transientGain: 0.85,
      transientDecayMs: 12,
      transientFreqHz: 1100,
      bodyGain: 0.7,
      bodyShape: 'triangle',
      bodyStartHz: 260,
      bodyEndHz: 70,
      bodyAttackMs: 1,
      bodyDecayMs: 80,
      fmRatio: 0,
      fmDepth: 0,
      noiseGain: 0.45,
      noiseDecayMs: 60,
      filterStartHz: 3200,
      filterEndHz: 420,
      filterQ: 1.4,
      bitDepth: 16,
      drive: 1.5,
    });

    void (async () => {
      if (primaryNode) {
        const blobRec = await repository.getBlob(
          primaryNode.processedBlobId ?? primaryNode.imageBlobId,
        );
        if (!cancelled && blobRec) {
          const spriteCanvas = await blobToOffscreenCanvas(blobRec.bytes);
          if (!cancelled && spriteCanvas) {
            spriteCanvasesRef.current.player = spriteCanvas;
            // Pre-bake white silhouette cutout for M27 hit-flash overlay
            const whiteCanvas = document.createElement('canvas');
            whiteCanvas.width = spriteCanvas.width;
            whiteCanvas.height = spriteCanvas.height;
            const wctx = whiteCanvas.getContext('2d');
            if (wctx) {
              wctx.drawImage(spriteCanvas, 0, 0);
              wctx.globalCompositeOperation = 'source-in';
              wctx.fillStyle = '#ffffff';
              wctx.fillRect(0, 0, whiteCanvas.width, whiteCanvas.height);
              spriteCanvasesRef.current.dummyWhite = whiteCanvas;
            }
          }
        }
      }

      const cueMap = new Map<string, PcmBuffer>();
      const entityAssets = audioAssets.filter((a) => entity.audioAssetIds.includes(a.id));
      for (const asset of entityAssets) {
        const wavRec = await repository.getBlob(asset.wavBlobId);
        if (!wavRec || cancelled) continue;
        try {
          const bytes = new Uint8Array(await wavRec.bytes.arrayBuffer());
          const pcm = await decodeAudioBytesToPcm(bytes);
          if (cancelled) return;
          cueMap.set(asset.name.toLowerCase(), pcm);
          if (!cueMap.has('__default__')) {
            cueMap.set('__default__', pcm);
          }
        } catch {
          // Ignore malformed blobs cleanly
        }
      }
      if (!cancelled) {
        audioCueMapRef.current = cueMap;
      }
    })();

    return () => {
      cancelled = true;
      void engine.dispose();
      audioEngineRef.current = null;
      audioCueMapRef.current.clear();
    };
  }, [entity.audioAssetIds, primaryNode, project.artBible.lighting, audioAssets]);

  const handleResetDummy = useCallback(() => {
    worldRef.current = resetPlaytestDummy(
      worldRef.current,
      DEFAULT_PLAYTEST_STAGE_BOUNDS,
      configRef.current.mode,
    );
    floatingNumbersRef.current = [];
    floatingBurstsRef.current = [];
    setDummyHp(worldRef.current.dummy.hp);
    setDummyMaxHp(worldRef.current.dummy.maxHp);
  }, []);

  // Keyboard bindings (ignored when typing inside inputs/textareas/selects)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;

      const k = e.code;
      const keyLower = e.key.toLowerCase();

      if (
        k === 'ArrowLeft' ||
        k === 'ArrowRight' ||
        k === 'ArrowUp' ||
        k === 'ArrowDown' ||
        k === 'Space'
      ) {
        e.preventDefault();
      }

      if (k === 'ArrowLeft' || keyLower === 'a') heldKeysRef.current.left = true;
      if (k === 'ArrowRight' || keyLower === 'd') heldKeysRef.current.right = true;
      if (k === 'ArrowUp' || keyLower === 'w') {
        heldKeysRef.current.up = true;
        if (configRef.current.mode === 'side-platformer') {
          heldKeysRef.current.jumpQueued = true;
        }
      }
      if (k === 'ArrowDown' || keyLower === 's') heldKeysRef.current.down = true;
      if (keyLower === 'k') heldKeysRef.current.jumpQueued = true;
      if (k === 'Space' || keyLower === 'j') heldKeysRef.current.attackQueued = true;
      if (keyLower === 'h') setDebugOverlay((v) => !v);
      if (keyLower === 'r') handleResetDummy();
      if (k === 'Escape') onClose();
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const k = e.code;
      const keyLower = e.key.toLowerCase();
      if (k === 'ArrowLeft' || keyLower === 'a') heldKeysRef.current.left = false;
      if (k === 'ArrowRight' || keyLower === 'd') heldKeysRef.current.right = false;
      if (k === 'ArrowUp' || keyLower === 'w') heldKeysRef.current.up = false;
      if (k === 'ArrowDown' || keyLower === 's') heldKeysRef.current.down = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [handleResetDummy, onClose]);

  // Fixed-timestep 60 Hz RAF loop pausing cleanly on document.hidden and unmount
  useEffect(() => {
    const runner = createFixedTimestepRunner(1000 / 60, 100);
    let rafId = 0;
    let lastTs = performance.now();
    let isPaused = typeof document !== 'undefined' && document.hidden;

    const handleVisibility = () => {
      isPaused = document.hidden;
      if (isPaused) {
        heldKeysRef.current = {
          left: false,
          right: false,
          up: false,
          down: false,
          jumpQueued: false,
          attackQueued: false,
        };
        runner.reset();
      } else {
        lastTs = performance.now();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const drawFrame = (world: PlaytestWorldState) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const cfg = configRef.current;
      const meta = entityMetaRef.current;
      const isPixel = project.artBible.artMode === 'pixel-art';
      ctx.imageSmoothingEnabled = !isPixel;

      const shakeAmp = world.shakeTrauma * cfg.screenShakePx;
      const shakeX = shakeAmp > 0.05 ? Math.round(Math.sin(world.tick * 1.9) * shakeAmp) : 0;
      const shakeY = shakeAmp > 0.05 ? Math.round(Math.cos(world.tick * 2.7) * shakeAmp * 0.7) : 0;

      ctx.save();
      ctx.clearRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

      // Sky gradient
      const skyGrad = ctx.createLinearGradient(0, 0, 0, LOGICAL_HEIGHT);
      skyGrad.addColorStop(0, '#0f172a');
      skyGrad.addColorStop(1, '#1e293b');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);

      ctx.translate(shakeX, shakeY);

      // Floor / ground plane
      const biomeTile = spriteCanvasesRef.current.biomeTile;
      if (cfg.mode === 'side-platformer') {
        if (biomeTile) {
          for (let tx = 0; tx < LOGICAL_WIDTH; tx += 32) {
            ctx.drawImage(biomeTile, 0, 0, biomeTile.width, biomeTile.height, tx, FLOOR_Y, 32, 32);
          }
        } else {
          ctx.fillStyle = '#334155';
          ctx.fillRect(0, FLOOR_Y, LOGICAL_WIDTH, LOGICAL_HEIGHT - FLOOR_Y);
        }
        ctx.fillStyle = '#94a3b8';
        ctx.fillRect(0, FLOOR_Y, LOGICAL_WIDTH, 1);
      } else if (biomeTile) {
        for (let ty = 0; ty < LOGICAL_HEIGHT; ty += 32) {
          for (let tx = 0; tx < LOGICAL_WIDTH; tx += 32) {
            ctx.drawImage(biomeTile, 0, 0, biomeTile.width, biomeTile.height, tx, ty, 32, 32);
          }
        }
      }

      // Draw Target Dummy with M27 hit-flash intensity
      const dummyW = 28;
      const dummyH = 34;
      const dummyX = Math.round(world.dummy.x);
      const dummyY = Math.round(world.dummy.y);
      const flashAmount = computeHitFlashUniform(world.dummy.flashRemainingMs, cfg.flashDurationMs);

      // Shadow
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(dummyX - 10, dummyY - 2, 20, 4);

      if (spriteCanvasesRef.current.player) {
        const sp = spriteCanvasesRef.current.player;
        const scale = Math.min(dummyH / Math.max(1, sp.height), 1);
        const dw = Math.max(16, Math.round(sp.width * scale));
        const dh = Math.max(16, Math.round(sp.height * scale));
        ctx.save();
        ctx.translate(dummyX, dummyY);
        ctx.scale(-1, 1);
        ctx.filter = 'hue-rotate(155deg) saturate(0.85)';
        ctx.drawImage(sp, -dw * 0.5, -dh, dw, dh);
        ctx.filter = 'none';
        if (flashAmount > 0 && spriteCanvasesRef.current.dummyWhite) {
          ctx.globalAlpha = flashAmount;
          ctx.drawImage(spriteCanvasesRef.current.dummyWhite, -dw * 0.5, -dh, dw, dh);
          ctx.globalAlpha = 1;
        }
        ctx.restore();
      } else {
        ctx.fillStyle = flashAmount > 0.25 ? '#ffffff' : '#64748b';
        ctx.fillRect(dummyX - dummyW * 0.5, dummyY - dummyH, dummyW, dummyH);
        ctx.strokeStyle = '#f8fafc';
        ctx.strokeRect(dummyX - dummyW * 0.5, dummyY - dummyH, dummyW, dummyH);
      }

      // Mini HP bar above dummy
      const hpPct = Math.max(0, Math.min(1, world.dummy.hp / Math.max(1, world.dummy.maxHp)));
      ctx.fillStyle = '#090d16';
      ctx.fillRect(dummyX - 15, dummyY - dummyH - 7, 30, 4);
      ctx.fillStyle = hpPct > 0.35 ? '#10b981' : '#f43f5e';
      ctx.fillRect(dummyX - 14, dummyY - dummyH - 6, Math.round(28 * hpPct), 2);

      // Draw Player Actor
      const px = Math.round(world.player.x);
      const py = Math.round(world.player.y);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
      ctx.fillRect(px - 10, py - 2, 20, 4);

      const walkBob =
        world.player.activeClip === 'run' ? (world.player.frameIndex % 2 === 0 ? 0 : -2) : 0;
      const lungeX = world.player.activeClip === 'attack' ? world.player.facing * 4 : 0;

      if (spriteCanvasesRef.current.player) {
        const sp = spriteCanvasesRef.current.player;
        const targetH = 36;
        const scale = Math.min(targetH / Math.max(1, sp.height), 1);
        const dw = Math.max(18, Math.round(sp.width * scale));
        const dh = Math.max(18, Math.round(sp.height * scale));
        ctx.save();
        ctx.translate(px + lungeX, py + walkBob);
        ctx.scale(world.player.facing, 1);
        ctx.drawImage(sp, -dw * 0.5, -dh, dw, dh);
        ctx.restore();
      } else {
        ctx.fillStyle = world.player.activeClip === 'attack' ? '#fbbf24' : '#38bdf8';
        ctx.fillRect(px + lungeX - 12, py + walkBob - 32, 24, 32);
      }

      // Attack slash arc indicator
      if (world.player.activeClip === 'attack') {
        const hb = transformLocalAabbToWorld(meta.hitbox, px, py, world.player.facing);
        ctx.fillStyle = 'rgba(253, 224, 71, 0.35)';
        ctx.fillRect(hb.minX, hb.minY, hb.maxX - hb.minX, hb.maxY - hb.minY);
      }

      // Debug Overlay (H): Collider (green), Hurtbox (blue), Hitbox (red), M21 Sockets (yellow)
      if (debugRef.current) {
        const playerCol = transformLocalAabbToWorld(meta.colliderBox, px, py, world.player.facing);
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 1;
        ctx.strokeRect(
          playerCol.minX,
          playerCol.minY,
          playerCol.maxX - playerCol.minX,
          playerCol.maxY - playerCol.minY,
        );

        const dummyHurt = transformLocalAabbToWorld(meta.hurtbox, dummyX, dummyY, 1);
        ctx.strokeStyle = '#38bdf8';
        ctx.strokeRect(
          dummyHurt.minX,
          dummyHurt.minY,
          dummyHurt.maxX - dummyHurt.minX,
          dummyHurt.maxY - dummyHurt.minY,
        );

        const playerHit = transformLocalAabbToWorld(meta.hitbox, px, py, world.player.facing);
        const overlapsNow = aabbsOverlap(playerHit, dummyHurt);
        ctx.fillStyle =
          world.player.activeClip === 'attack' || overlapsNow
            ? 'rgba(239, 68, 68, 0.25)'
            : 'rgba(239, 68, 68, 0.08)';
        ctx.fillRect(
          playerHit.minX,
          playerHit.minY,
          playerHit.maxX - playerHit.minX,
          playerHit.maxY - playerHit.minY,
        );
        ctx.strokeStyle = '#ef4444';
        ctx.strokeRect(
          playerHit.minX,
          playerHit.minY,
          playerHit.maxX - playerHit.minX,
          playerHit.maxY - playerHit.minY,
        );

        // M21 Sockets
        const refW = project.artBible.targetWidth || 64;
        const refH = project.artBible.targetHeight || 64;
        const pivotNorm = primaryNode?.postProcessConfig?.pivotNorm ?? { x: 0.5, y: 0.5 };
        for (const sock of primaryNode?.sockets ?? []) {
          const sx = px + (sock.restPosPx.x - pivotNorm.x * refW) * 0.5 * world.player.facing;
          const sy = py - 18 + (sock.restPosPx.y - pivotNorm.y * refH) * 0.5;
          ctx.fillStyle = '#facc15';
          ctx.fillRect(sx - 2, sy, 5, 1);
          ctx.fillRect(sx, sy - 2, 1, 5);
        }
      }

      // Floating impact bursts
      for (const burst of floatingBurstsRef.current) {
        const radius = 4 + (burst.ageMs / 240) * 14;
        ctx.strokeStyle = `rgba(251, 191, 36, ${Math.max(0, 1 - burst.ageMs / 240)})`;
        ctx.beginPath();
        ctx.arc(burst.x, burst.y, radius, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Floating M24 pixel bitmap damage numbers
      for (const num of floatingNumbersRef.current) {
        const riseY = num.y - (num.ageMs / 650) * 18;
        drawBitmapNumeral(ctx, `-${num.value}`, num.x, riseY, '#ffdd57');
      }

      ctx.restore();
    };

    const tickLoop = (now: number) => {
      if (!isPaused) {
        const rawDelta = Math.max(0, now - lastTs);
        lastTs = now;

        let hpChanged = false;
        runner.advance(rawDelta, (stepMs) => {
          const input: PlaytestInputState = {
            left: heldKeysRef.current.left,
            right: heldKeysRef.current.right,
            up: heldKeysRef.current.up,
            down: heldKeysRef.current.down,
            jumpPressed: heldKeysRef.current.jumpQueued,
            attackPressed: heldKeysRef.current.attackQueued,
          };
          heldKeysRef.current.jumpQueued = false;
          heldKeysRef.current.attackQueued = false;

          const prevHp = worldRef.current.dummy.hp;
          const res = stepPlaytestSimulation(
            worldRef.current,
            input,
            entityMetaRef.current,
            configRef.current,
            stepMs,
          );
          worldRef.current = res.nextState;
          if (res.nextState.dummy.hp !== prevHp) {
            hpChanged = true;
          }

          for (const ev of res.events) {
            if (ev.kind === 'damage-number' && ev.value !== undefined) {
              floatingNumbersRef.current.push({
                id: nextParticleIdRef.current++,
                x: ev.x,
                y: ev.y,
                value: ev.value,
                ageMs: 0,
              });
            } else if (ev.kind === 'spawn-vfx') {
              floatingBurstsRef.current.push({
                id: nextParticleIdRef.current++,
                x: ev.x,
                y: ev.y,
                ageMs: 0,
              });
            } else if (ev.kind === 'play-sfx') {
              const cue = ev.cueName ?? 'sfx';
              setLastSfxCue(cue);
              if (!mutedRef.current && audioEngineRef.current) {
                const map = audioCueMapRef.current;
                const pcm =
                  map.get(cue.toLowerCase()) ??
                  map.get('__default__') ??
                  (cue === 'hit_impact' ? defaultHitPcmRef.current : null);
                if (pcm) {
                  void audioEngineRef.current.playPcm(pcm);
                }
              }
            }
          }
        });

        floatingNumbersRef.current = floatingNumbersRef.current
          .map((n) => ({ ...n, ageMs: n.ageMs + rawDelta }))
          .filter((n) => n.ageMs < 650);
        floatingBurstsRef.current = floatingBurstsRef.current
          .map((b) => ({ ...b, ageMs: b.ageMs + rawDelta }))
          .filter((b) => b.ageMs < 240);

        if (hpChanged) {
          setDummyHp(worldRef.current.dummy.hp);
        }

        drawFrame(worldRef.current);
      } else {
        lastTs = now;
      }

      rafId = window.requestAnimationFrame(tickLoop);
    };

    rafId = window.requestAnimationFrame(tickLoop);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
      window.cancelAnimationFrame(rafId);
    };
  }, [
    project.artBible.artMode,
    project.artBible.targetWidth,
    project.artBible.targetHeight,
    primaryNode,
  ]);

  const handleApplyStats = async () => {
    setSavingStats(true);
    setStatusNotice(null);
    try {
      const nextScript = ensureEntityPlaytestGdScript(entity, {
        moveSpeedPx: config.moveSpeedPx,
        attackDamage: config.attackDamage,
      });
      await onApplyStats({
        ...entity,
        playtestConfig: config,
        scriptContent: nextScript,
        updatedAt: Date.now(),
      });
      setStatusNotice(
        `Applied move_speed=${config.moveSpeedPx.toFixed(1)}, attack_damage=${config.attackDamage} to ${entity.slug}.gd`,
      );
    } finally {
      setSavingStats(false);
    }
  };

  return (
    <div
      data-testid="playtest-stage-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] shadow-2xl">
        {/* Modal Header */}
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border-hairline)] bg-[var(--bg-well)] px-4 py-3">
          <div className="flex items-center gap-3">
            <Play className="h-4 w-4 text-emerald-400" />
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Mini-Playtest Stage · {entity.displayName}{' '}
                <span className="font-mono text-xs text-slate-400">({entity.slug})</span>
              </h3>
              <p className="text-[11px] text-slate-400">
                Move: WASD / Arrows · Attack: Space / J · Jump: W / K · Debug: H · Reset: R
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              data-testid="playtest-dummy-hp"
              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 font-mono text-[11px] font-semibold text-emerald-200 tabular-nums"
            >
              Dummy HP: {dummyHp} / {dummyMaxHp}
            </span>
            <button
              type="button"
              data-testid="playtest-debug-badge"
              onClick={() => setDebugOverlay((v) => !v)}
              className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium ${
                debugOverlay
                  ? 'border-amber-400/60 bg-amber-500/20 text-amber-200'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-panel)] text-slate-300'
              }`}
            >
              <Bug className="h-3 w-3" />
              {debugOverlay ? 'Debug: ON' : 'Debug: OFF'}
            </button>
            <button
              type="button"
              data-testid="playtest-mute-btn"
              onClick={() => setMuted((m) => !m)}
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
            >
              {muted ? (
                <VolumeX className="h-3.5 w-3.5 text-rose-300" />
              ) : (
                <Volume2 className="h-3.5 w-3.5 text-emerald-300" />
              )}
              {muted ? 'Muted' : 'Audio ON'}
            </button>
            <button
              type="button"
              data-testid="playtest-reset-btn"
              onClick={handleResetDummy}
              className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
            >
              <RotateCcw className="h-3 w-3" />
              Reset (R)
            </button>
            <button
              type="button"
              data-testid="playtest-close-btn"
              onClick={onClose}
              aria-label="Close playtest stage"
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-1 text-slate-300 hover:text-white"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* Body: Stage Canvas + Live Juice Tuning Sidebar */}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden md:flex-row">
          <div className="flex flex-1 flex-col items-center justify-center gap-3 overflow-auto bg-slate-950 p-4">
            <canvas
              ref={canvasRef}
              width={LOGICAL_WIDTH}
              height={LOGICAL_HEIGHT}
              data-testid="playtest-stage-canvas"
              style={{
                width: `${LOGICAL_WIDTH * stageScale}px`,
                height: `${LOGICAL_HEIGHT * stageScale}px`,
                imageRendering: project.artBible.artMode === 'pixel-art' ? 'pixelated' : 'auto',
              }}
              className="rounded border border-slate-700 shadow-xl"
            />
            <div className="flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
              <span>Last SFX Cue: {lastSfxCue}</span>
              <span>·</span>
              <div className="flex items-center gap-1">
                <span>Scale:</span>
                {([2, 3] as const).map((s) => (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setStageScale(s)}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${
                      stageScale === s
                        ? 'bg-indigo-600 text-white'
                        : 'border border-slate-700 bg-slate-900 text-slate-300'
                    }`}
                  >
                    {s}×
                  </button>
                ))}
              </div>
            </div>
          </div>

          <aside className="flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] p-4 text-xs md:w-72 md:border-t-0 md:border-l">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-semibold tracking-wide text-slate-300 uppercase">
                Live Game Juice
              </span>
              <select
                data-testid="playtest-mode-select"
                value={config.mode}
                onChange={(e) =>
                  setConfig((prev) => ({
                    ...prev,
                    mode: e.target.value as PlaytestJuiceConfig['mode'],
                  }))
                }
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-0.5 text-[11px] text-slate-200"
              >
                <option value="side-platformer">Side-Platformer</option>
                <option value="top-down">Top-Down (8-Way)</option>
              </select>
            </div>

            <div className="space-y-2">
              <ScrubInput
                label="Move Speed"
                testId="playtest-scrub-move-speed"
                value={config.moveSpeedPx}
                min={20}
                max={400}
                step={5}
                unit="px/s"
                onChange={(moveSpeedPx) => setConfig((prev) => ({ ...prev, moveSpeedPx }))}
              />
              <ScrubInput
                label="Gravity"
                testId="playtest-scrub-gravity"
                value={config.gravityPx}
                min={100}
                max={2000}
                step={20}
                disabled={config.mode === 'top-down'}
                onChange={(gravityPx) => setConfig((prev) => ({ ...prev, gravityPx }))}
              />
              <ScrubInput
                label="Hitstop"
                testId="playtest-scrub-hitstop"
                value={config.hitstopMs}
                min={0}
                max={250}
                step={5}
                unit="ms"
                onChange={(hitstopMs) => setConfig((prev) => ({ ...prev, hitstopMs }))}
              />
              <ScrubInput
                label="Screen Shake"
                testId="playtest-scrub-shake"
                value={config.screenShakePx}
                min={0}
                max={24}
                step={1}
                unit="px"
                onChange={(screenShakePx) => setConfig((prev) => ({ ...prev, screenShakePx }))}
              />
              <ScrubInput
                label="Knockback"
                testId="playtest-scrub-knockback"
                value={config.knockbackPx}
                min={0}
                max={320}
                step={10}
                unit="px"
                onChange={(knockbackPx) => setConfig((prev) => ({ ...prev, knockbackPx }))}
              />
              <ScrubInput
                label="Flash"
                testId="playtest-scrub-flash"
                value={config.flashDurationMs}
                min={0}
                max={400}
                step={10}
                unit="ms"
                onChange={(flashDurationMs) => setConfig((prev) => ({ ...prev, flashDurationMs }))}
              />
              <ScrubInput
                label="Attack Damage"
                testId="playtest-scrub-damage"
                value={config.attackDamage}
                min={1}
                max={100}
                step={1}
                onChange={(attackDamage) =>
                  setConfig((prev) => ({ ...prev, attackDamage: Math.round(attackDamage) }))
                }
              />
            </div>

            {statusNotice && (
              <div
                data-testid="playtest-status-notice"
                className="rounded border border-emerald-500/40 bg-emerald-500/15 p-2 text-[11px] text-emerald-200"
              >
                {statusNotice}
              </div>
            )}

            <button
              type="button"
              data-testid="playtest-apply-stats-btn"
              disabled={savingStats}
              onClick={() => void handleApplyStats()}
              className="mt-auto flex items-center justify-center gap-1.5 rounded bg-[#F5B82E] px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
            >
              <Save className="h-3.5 w-3.5" />
              {savingStats ? 'Applying...' : 'Apply Stats to Entity .gd'}
            </button>
          </aside>
        </div>
      </div>
    </div>
  );
}
