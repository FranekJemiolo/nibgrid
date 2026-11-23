import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlipHorizontal2, Pause, Play, Sparkles, Volume2, VolumeX, Zap } from 'lucide-react';
import { AudioPlaybackEngine } from '../../audio/playbackEngine';
import { repository } from '../../db/database';
import type { ArtMode, Projection, PuppetAnimConfig } from '../../domain/schemas';
import {
  clusterPaletteRamps,
  countUniqueOpaqueColors,
  decodeIndexedSprite,
  encodeLutBuffer,
  evaluatePaletteVariant,
  extractIndexedSprite,
  quantizeBufferToMaxColors,
  type PaletteVariant,
} from '../../processing/paletteLut';
import { BIOME_PRESETS, type BiomeId } from '../../processing/sandboxBiomes';
import type { BiomeContrastReport } from '../../processing/sandboxContrast';
import type {
  FlashColorMode,
  SandboxGridSize,
  SandboxLens,
  SandboxScale,
} from '../../processing/sandboxState';
import { buildAlphaClippedMesh } from '../../processing/spriteMesh';
import type { RgbaBuffer } from '../../processing/types';
import { useAppStore } from '../../store/useAppStore';
import { buildPuppetStripArtifacts } from '../../webgl/puppetRenderer';
import { SANDBOX_CAMERA_PRESETS, SandboxEngine, type SandboxEngineConfig } from './sandboxEngine';

export interface GameSandboxProps {
  sprite: RgbaBuffer;
  artMode: ArtMode;
  projection: Projection;
  pivotNorm: { readonly x: number; readonly y: number };
  paletteHex: readonly string[];
  puppetConfig: PuppetAnimConfig;
  lutVariants: readonly PaletteVariant[];
}

function isEditableEventTarget(el: EventTarget | null): boolean {
  const node = el instanceof HTMLElement ? el : null;
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  for (const candidate of [node, active]) {
    if (!candidate) continue;
    const tag = candidate.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (candidate.isContentEditable) return true;
  }
  return false;
}

export function GameSandbox({
  sprite,
  artMode,
  projection,
  pivotNorm,
  paletteHex,
  puppetConfig,
  lutVariants,
}: GameSandboxProps) {
  const { activeProject, audioAssets, patchProjectAudioBindings } = useAppStore();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<SandboxEngine | null>(null);
  const sfxPlayerRef = useRef<AudioPlaybackEngine | null>(null);
  const bgmPlayerRef = useRef<AudioPlaybackEngine | null>(null);

  const [biomeId, setBiomeId] = useState<BiomeId>('dark-dungeon');
  const [scale, setScale] = useState<SandboxScale>(2);
  const [cameraIdx, setCameraIdx] = useState<number>(0);
  const [lens, setLens] = useState<SandboxLens>('normal');
  const [flashColor, setFlashColor] = useState<FlashColorMode>('white');
  const [scrollSpeed, setScrollSpeed] = useState<number>(36);
  const [biomeDimmer, setBiomeDimmer] = useState<number>(1.0);
  const [gridSize, setGridSize] = useState<SandboxGridSize>(0);
  const [playing, setPlaying] = useState<boolean>(true);
  const [fps, setFps] = useState<number>(() => Math.max(4, Math.min(24, puppetConfig.fps)));
  const [selectedLutIdx, setSelectedLutIdx] = useState<number>(0);
  const [muted, setMuted] = useState<boolean>(false);
  const [audioTriggerCount, setAudioTriggerCount] = useState<number>(0);
  const [lastPlayedSfxId, setLastPlayedSfxId] = useState<string>('');
  const [contrastReport, setContrastReport] = useState<BiomeContrastReport>({
    edgePixelCount: 0,
    edgeLuminance: 0.5,
    biomeLuminance: 0.5,
    contrastRatio: 1,
    readableEdgePercent: 0,
    rating: 'weak',
    suggestion: 'Computing perimeter separation...',
  });

  const bindings = activeProject?.audioBindings;
  const latestAudioStateRef = useRef({
    muted,
    bindings,
    audioAssets,
    frameCount: puppetConfig.frameCount,
  });
  latestAudioStateRef.current = {
    muted,
    bindings,
    audioAssets,
    frameCount: puppetConfig.frameCount,
  };

  const triggerBoundSfx = useCallback((assetId?: string) => {
    const snap = latestAudioStateRef.current;
    if (snap.muted || !assetId) return;
    const asset = snap.audioAssets.find((a) => a.id === assetId);
    if (!asset) return;

    const pool = asset.variationBlobIds.length > 0 ? asset.variationBlobIds : [asset.wavBlobId];
    const pickedBlobId = pool[Math.floor(Math.random() * pool.length)] ?? asset.wavBlobId;
    setAudioTriggerCount((c) => c + 1);
    setLastPlayedSfxId(asset.id);
    void repository.getBlob(pickedBlobId).then((rec) => {
      if (rec && sfxPlayerRef.current) {
        void sfxPlayerRef.current.playWavBlob(rec.bytes, { loop: false });
      }
    });
  }, []);

  const cameraPreset = SANDBOX_CAMERA_PRESETS[cameraIdx] ?? SANDBOX_CAMERA_PRESETS[0]!;

  // Reset LUT index if variant list shrinks
  useEffect(() => {
    if (selectedLutIdx > lutVariants.length) {
      setSelectedLutIdx(0);
    }
  }, [lutVariants.length, selectedLutIdx]);

  // 1. Derive base animation frames (M9 Puppet-Warp strip when rigged, otherwise single sprite)
  const baseFrames: readonly RgbaBuffer[] = useMemo(() => {
    if (puppetConfig.pins.length > 0) {
      try {
        const mesh = buildAlphaClippedMesh(sprite, { artMode });
        const stripRes = buildPuppetStripArtifacts(sprite, mesh, 'sandbox', {
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
          paletteHex,
        });
        return stripRes.frames.length > 0 ? stripRes.frames : [sprite];
      } catch {
        return [sprite];
      }
    }
    return [sprite];
  }, [sprite, artMode, puppetConfig, pivotNorm, paletteHex]);

  // 2. Apply M12 Palette-Swap LUT variant to all active frames when selectedLutIdx > 0
  const activeFrames: readonly RgbaBuffer[] = useMemo(() => {
    const variant = selectedLutIdx > 0 ? lutVariants[selectedLutIdx - 1] : undefined;
    if (!variant) return baseFrames;

    const first = baseFrames[0] ?? sprite;
    const prepared =
      countUniqueOpaqueColors(first) > 256 ? quantizeBufferToMaxColors(first, 32) : first;
    const indexedBase = extractIndexedSprite(prepared);
    const ramps = clusterPaletteRamps(indexedBase.palette);
    const swappedPalette = evaluatePaletteVariant(indexedBase.palette, ramps, variant);
    const singleRowLut = encodeLutBuffer([swappedPalette]);

    return baseFrames.map((frameBuf) => {
      const { indexedBuffer } = extractIndexedSprite(frameBuf, indexedBase.palette);
      return decodeIndexedSprite(indexedBuffer, singleRowLut, 0);
    });
  }, [baseFrames, selectedLutIdx, lutVariants, sprite]);

  const engineConfig: SandboxEngineConfig = useMemo(
    () => ({
      biomeId,
      projection,
      artMode,
      cameraWidth: cameraPreset.width,
      cameraHeight: cameraPreset.height,
      scale,
      lens,
      flashColor,
      scrollSpeedPxPerSec: scrollSpeed,
      biomeDimmer,
      gridSize,
      playing,
      fps,
      pingPong: puppetConfig.pingPong,
      pivotNorm,
    }),
    [
      biomeId,
      projection,
      artMode,
      cameraPreset.width,
      cameraPreset.height,
      scale,
      lens,
      flashColor,
      scrollSpeed,
      biomeDimmer,
      gridSize,
      playing,
      fps,
      puppetConfig.pingPong,
      pivotNorm,
    ],
  );

  // Mount & dispose Canvas2D engine + AudioPlaybackEngines cleanly on unmount
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const sfxPlayer = new AudioPlaybackEngine();
    const bgmPlayer = new AudioPlaybackEngine();
    sfxPlayerRef.current = sfxPlayer;
    bgmPlayerRef.current = bgmPlayer;

    const handleHit = () => {
      triggerBoundSfx(latestAudioStateRef.current.bindings?.hitSfxId);
    };

    const handleFrameAdvance = (frameIdx: number) => {
      const snap = latestAudioStateRef.current;
      const mapped = snap.bindings?.frameSfxMap?.[String(frameIdx)];
      if (mapped) {
        triggerBoundSfx(mapped);
        return;
      }
      const midpoint = Math.max(1, Math.floor(snap.frameCount / 2));
      if (snap.bindings?.stepSfxId && (frameIdx === 0 || frameIdx === midpoint)) {
        triggerBoundSfx(snap.bindings.stepSfxId);
      }
    };

    const engine = new SandboxEngine(
      canvas,
      engineConfig,
      activeFrames,
      setContrastReport,
      handleHit,
      handleFrameAdvance,
    );
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
      void sfxPlayer.dispose();
      void bgmPlayer.dispose();
      sfxPlayerRef.current = null;
      bgmPlayerRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [triggerBoundSfx]);

  // Keep optional looping BGM synchronized with Play/Pause and Mute toggles
  useEffect(() => {
    const bgmPlayer = bgmPlayerRef.current;
    if (!bgmPlayer) return;
    const bgmId = bindings?.bgmLoopId;
    if (!playing || muted || !bgmId) {
      bgmPlayer.stop();
      return;
    }
    const asset = audioAssets.find((a) => a.id === bgmId);
    if (!asset) {
      bgmPlayer.stop();
      return;
    }
    let cancelled = false;
    void repository.getBlob(asset.wavBlobId).then((rec) => {
      if (!cancelled && rec) {
        void bgmPlayer.playWavBlob(rec.bytes, { loop: true });
      }
    });
    return () => {
      cancelled = true;
      bgmPlayer.stop();
    };
  }, [playing, muted, bindings?.bgmLoopId, audioAssets]);

  useEffect(() => {
    engineRef.current?.updateConfig(engineConfig);
  }, [engineConfig]);

  useEffect(() => {
    engineRef.current?.updateFrames(activeFrames);
  }, [activeFrames]);

  // Keyboard shortcuts strictly ignored when focus is inside inputs/textareas/selects/contenteditable
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableEventTarget(e.target)) return;
      const engine = engineRef.current;
      if (!engine) return;

      const k = e.key.toLowerCase();
      if (
        k === 'w' ||
        k === 'a' ||
        k === 's' ||
        k === 'd' ||
        k === 'arrowup' ||
        k === 'arrowdown' ||
        k === 'arrowleft' ||
        k === 'arrowright'
      ) {
        if (k.startsWith('arrow')) e.preventDefault();
        engine.setKeyPressed(k, true);
        return;
      }
      if (k === 'f' && !e.repeat) {
        e.preventDefault();
        engine.toggleFlip();
        return;
      }
      if (k === 'h' && !e.repeat) {
        e.preventDefault();
        engine.triggerHit();
        return;
      }
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        setPlaying((prev) => !prev);
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      engineRef.current?.setKeyPressed(k, false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, []);

  const ratingBadgeClass =
    contrastReport.rating === 'strong'
      ? 'border-emerald-500/40 bg-emerald-500/20 text-emerald-200'
      : contrastReport.rating === 'moderate'
        ? 'border-amber-500/40 bg-amber-500/20 text-amber-200'
        : 'border-rose-500/40 bg-rose-500/20 text-rose-200';

  const ratingLabel =
    contrastReport.rating === 'strong'
      ? 'Strong'
      : contrastReport.rating === 'moderate'
        ? 'Moderate'
        : 'Weak';

  const isPixelArt = artMode === 'pixel-art';

  return (
    <div
      data-testid="game-sandbox-panel"
      className="flex min-h-0 flex-1 flex-col overflow-hidden bg-slate-950"
    >
      {/* Top Toolbar: Biome, Scale, Camera, Lens, Flash & Hit Controls */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/75 px-4 py-2 text-xs">
        {/* Biome Pills */}
        <div className="flex flex-wrap items-center gap-1">
          {BIOME_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              data-testid={`sandbox-biome-${preset.id}`}
              onClick={() => setBiomeId(preset.id)}
              className={`rounded border px-2 py-1 text-[11px] font-medium transition-colors ${
                biomeId === preset.id
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
              title={`${preset.label} (${preset.targetLuminanceHint})`}
            >
              {preset.label}
            </button>
          ))}
        </div>

        {/* Scale, Camera, Lens & Combat Juice Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex overflow-hidden rounded border border-slate-700">
            {([1, 2, 3, 4] as const).map((s) => (
              <button
                key={s}
                type="button"
                data-testid={`sandbox-scale-${s}`}
                onClick={() => setScale(s)}
                className={`px-2 py-1 font-mono text-[11px] font-semibold ${
                  scale === s
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-900 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {s}×
              </button>
            ))}
          </div>

          <select
            data-testid="sandbox-camera-select"
            value={cameraIdx}
            onChange={(e) => setCameraIdx(Number(e.target.value))}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
            aria-label="Virtual camera resolution"
          >
            {SANDBOX_CAMERA_PRESETS.map((p, idx) => (
              <option key={p.label} value={idx}>
                {p.label}
              </option>
            ))}
          </select>

          <div className="inline-flex overflow-hidden rounded border border-slate-700">
            <button
              type="button"
              data-testid="sandbox-lens-normal"
              onClick={() => setLens('normal')}
              className={`px-2 py-1 text-[11px] ${
                lens === 'normal'
                  ? 'bg-indigo-600 font-semibold text-white'
                  : 'bg-slate-900 text-slate-300'
              }`}
            >
              Normal
            </button>
            <button
              type="button"
              data-testid="sandbox-lens-value"
              onClick={() => setLens('value')}
              className={`px-2 py-1 text-[11px] ${
                lens === 'value'
                  ? 'bg-indigo-600 font-semibold text-white'
                  : 'bg-slate-900 text-slate-300'
              }`}
            >
              Value Check
            </button>
            <button
              type="button"
              data-testid="sandbox-lens-silhouette"
              onClick={() => setLens('silhouette')}
              className={`px-2 py-1 text-[11px] ${
                lens === 'silhouette'
                  ? 'bg-indigo-600 font-semibold text-white'
                  : 'bg-slate-900 text-slate-300'
              }`}
            >
              Silhouette
            </button>
          </div>

          <div className="inline-flex overflow-hidden rounded border border-slate-700">
            <button
              type="button"
              data-testid="sandbox-flash-white"
              onClick={() => setFlashColor('white')}
              className={`px-2 py-1 text-[11px] ${
                flashColor === 'white'
                  ? 'bg-slate-200 font-semibold text-slate-950'
                  : 'bg-slate-900 text-slate-300'
              }`}
            >
              Flash White
            </button>
            <button
              type="button"
              data-testid="sandbox-flash-red"
              onClick={() => setFlashColor('red')}
              className={`px-2 py-1 text-[11px] ${
                flashColor === 'red'
                  ? 'bg-rose-600 font-semibold text-white'
                  : 'bg-slate-900 text-slate-300'
              }`}
            >
              Flash Red
            </button>
          </div>

          <button
            type="button"
            data-testid="sandbox-flip-btn"
            onClick={() => engineRef.current?.toggleFlip()}
            className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
          >
            <FlipHorizontal2 className="h-3.5 w-3.5" />
            Flip (F)
          </button>

          <button
            type="button"
            data-testid="sandbox-trigger-hit-btn"
            onClick={() => engineRef.current?.triggerHit()}
            className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30"
          >
            <Zap className="h-3.5 w-3.5" />
            Trigger Hit (H)
          </button>
        </div>
      </div>

      {/* Center Stage: True 1x..4x Integer Virtual Camera Canvas + Contrast HUD */}
      <div className="relative flex flex-1 items-center justify-center overflow-auto bg-slate-950 p-6">
        <div
          data-testid="sandbox-contrast-hud"
          className="absolute top-3 left-3 z-10 max-w-md space-y-1 rounded-lg border border-slate-800 bg-slate-950/90 px-3 py-2 text-xs shadow-lg backdrop-blur"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-slate-300">Perimeter Contrast:</span>
            <span data-testid="sandbox-contrast-ratio" className="font-mono font-bold text-white">
              {contrastReport.contrastRatio.toFixed(2)}:1
            </span>
            <span
              data-testid="sandbox-contrast-rating"
              className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${ratingBadgeClass}`}
            >
              {ratingLabel}
            </span>
            <span
              data-testid="sandbox-contrast-edge-pct"
              className="font-mono text-[11px] text-slate-400"
            >
              ({Math.round(contrastReport.readableEdgePercent)}% contour)
            </span>
          </div>
          <p data-testid="sandbox-contrast-suggestion" className="text-[11px] text-slate-400">
            {contrastReport.suggestion}
          </p>
        </div>

        <canvas
          ref={canvasRef}
          data-testid="sandbox-canvas"
          data-audio-trigger-count={audioTriggerCount}
          data-last-played-sfx={lastPlayedSfxId}
          className="rounded border border-slate-700 shadow-2xl"
          style={{
            width: `${cameraPreset.width * scale}px`,
            height: `${cameraPreset.height * scale}px`,
            imageRendering: isPixelArt ? 'pixelated' : 'auto',
          }}
        />

        <div className="pointer-events-none absolute right-3 bottom-3 rounded border border-slate-800 bg-slate-950/85 px-2.5 py-1 text-[11px] text-slate-400">
          WASD / Arrows Move • F Flip • H Hit-Flash • Space Play/Pause
        </div>
      </div>

      {/* Bottom Control Strip: Scroll, Dimmer, Grid, Anim Playback & M12 LUT Switcher */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-t border-slate-800 bg-slate-900/80 px-4 py-2.5 text-xs">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-slate-300">
            <span>Scroll {scrollSpeed} px/s</span>
            <input
              type="range"
              data-testid="sandbox-scroll-speed"
              min={0}
              max={120}
              step={4}
              value={scrollSpeed}
              onChange={(e) => setScrollSpeed(Number(e.target.value))}
              className="w-24 accent-indigo-500"
            />
          </label>

          <label className="flex items-center gap-2 text-slate-300">
            <span>Biome Dimmer {Math.round(biomeDimmer * 100)}%</span>
            <input
              type="range"
              data-testid="sandbox-biome-dimmer"
              min={50}
              max={100}
              step={5}
              value={Math.round(biomeDimmer * 100)}
              onChange={(e) => setBiomeDimmer(Number(e.target.value) / 100)}
              className="w-24 accent-indigo-500"
            />
          </label>

          <label className="flex items-center gap-1.5 text-slate-300">
            <span>Grid</span>
            <select
              data-testid="sandbox-grid-select"
              value={gridSize}
              onChange={(e) => setGridSize(Number(e.target.value) as SandboxGridSize)}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value={0}>Off</option>
              <option value={16}>16px Tiles</option>
              <option value={32}>32px Tiles</option>
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            data-testid="sandbox-play-toggle"
            onClick={() => setPlaying((p) => !p)}
            className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
          >
            {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {playing ? 'Pause' : 'Play'}
          </button>

          <label className="flex items-center gap-2 text-slate-300">
            <span>FPS {fps}</span>
            <input
              type="range"
              data-testid="sandbox-fps-slider"
              min={4}
              max={24}
              step={1}
              value={fps}
              onChange={(e) => setFps(Number(e.target.value))}
              className="w-20 accent-indigo-500"
            />
          </label>

          <label className="flex items-center gap-1.5 text-slate-300">
            <Sparkles className="h-3.5 w-3.5 text-indigo-400" />
            <span>M12 LUT</span>
            <select
              data-testid="sandbox-lut-variant-select"
              value={selectedLutIdx}
              onChange={(e) => setSelectedLutIdx(Number(e.target.value))}
              className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value={0}>Base Sprite</option>
              {lutVariants.map((v, idx) => (
                <option key={v.id} value={idx + 1}>
                  {v.name} (Row {idx + 1})
                </option>
              ))}
            </select>
          </label>

          {puppetConfig.pins.length > 0 && (
            <span className="rounded border border-emerald-500/30 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-medium text-emerald-200">
              M9 Puppet Loop Active ({puppetConfig.frameCount}f)
            </span>
          )}
        </div>
      </div>

      {/* M14C Audio Juice Binding Strip */}
      <div
        data-testid="sandbox-audio-juice-bar"
        className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 bg-slate-950/90 px-4 py-2 text-xs"
      >
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-semibold text-indigo-300">Audio Juice:</span>
          <label className="flex items-center gap-1.5 text-slate-300">
            <span>Hit SFX (H)</span>
            <select
              data-testid="sandbox-hit-sfx-select"
              value={bindings?.hitSfxId ?? ''}
              onChange={(e) =>
                void patchProjectAudioBindings({ hitSfxId: e.target.value || undefined })
              }
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value="">None</option>
              {audioAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-slate-300">
            <span>Step / Frame SFX</span>
            <select
              data-testid="sandbox-step-sfx-select"
              value={bindings?.stepSfxId ?? ''}
              onChange={(e) =>
                void patchProjectAudioBindings({ stepSfxId: e.target.value || undefined })
              }
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value="">None</option>
              {audioAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-slate-300">
            <span>BGM Loop</span>
            <select
              data-testid="sandbox-bgm-sfx-select"
              value={bindings?.bgmLoopId ?? ''}
              onChange={(e) =>
                void patchProjectAudioBindings({ bgmLoopId: e.target.value || undefined })
              }
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
            >
              <option value="">None</option>
              {audioAssets.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center gap-2">
          <span
            data-testid="sandbox-audio-trigger-badge"
            data-audio-trigger-count={audioTriggerCount}
            data-last-played-sfx={lastPlayedSfxId}
            className="font-mono text-[11px] text-slate-400"
          >
            SFX Triggers: {audioTriggerCount}
          </span>
          <button
            type="button"
            data-testid="sandbox-audio-mute-toggle"
            onClick={() => setMuted((m) => !m)}
            className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] font-medium ${
              muted
                ? 'border-rose-500/40 bg-rose-500/20 text-rose-200'
                : 'border-slate-700 bg-slate-800 text-slate-200'
            }`}
          >
            {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
            {muted ? 'Muted' : 'Audio On'}
          </button>
        </div>
      </div>
    </div>
  );
}
