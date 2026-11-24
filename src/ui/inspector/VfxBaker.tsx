import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  Dices,
  FileArchive,
  Grid,
  Pause,
  Play,
  Repeat,
  Save,
  Sparkles,
} from 'lucide-react';
import type {
  ArtMode,
  PostProcessConfig,
  Project,
  SpriteNode,
  VfxArchetype,
  VfxFlipbookConfig,
} from '../../domain/schemas';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import {
  exportGodotVfxBundle,
  exportPixiVfxJson,
  packageVfxFlipbookZip,
} from '../../export/vfxExporters';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { encodeRgbaToPngBytes } from '../../processing/png';
import { computeArtBibleHash } from '../../processing/projectAudit';
import type { RgbaBuffer } from '../../processing/types';
import { hexToRgbTuple, type VfxFlipbookResult } from '../../processing/vfxFlipbook';
import {
  bakeVfxFlipbookInWorker,
  createMonotonicRequestGuard,
} from '../../workers/postprocessClient';
import { ScrubInput } from '../primitives/ScrubInput';

export interface VfxBakerProps {
  readonly sprite: RgbaBuffer;
  readonly artMode: ArtMode;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly vfxConfig: VfxFlipbookConfig;
  readonly onChangeConfig: (next: VfxFlipbookConfig) => void;
  readonly onSaveToProject: (saved: VfxFlipbookConfig) => Promise<void>;
}

type ViewMode = 'live' | 'sheet';
type StageBackdrop = 'checker' | 'dark' | 'light';
type ExportTab = 'tres' | 'tscn' | 'pixi';

const ARCHETYPE_OPTIONS: readonly { readonly id: VfxArchetype; readonly label: string }[] = [
  { id: 'sparks', label: 'Sparks' },
  { id: 'dust-puff', label: 'Dust Puff' },
  { id: 'smoke', label: 'Smoke' },
  { id: 'hit-ring', label: 'Hit Ring' },
  { id: 'noise-dissolve', label: 'Noise Dissolve' },
];

const GRID_PRESETS: readonly {
  readonly cols: number;
  readonly rows: number;
  readonly label: string;
}[] = [
  { cols: 4, rows: 4, label: '4×4' },
  { cols: 8, rows: 2, label: '8×2' },
  { cols: 4, rows: 2, label: '4×2' },
];

const CELL_SIZES = [32, 64] as const;

export function VfxBaker({
  sprite,
  artMode,
  project,
  targetNode,
  postProcessConfig,
  rawWidth,
  rawHeight,
  vfxConfig,
  onChangeConfig,
  onSaveToProject,
}: VfxBakerProps) {
  const [bakedResult, setBakedResult] = useState<VfxFlipbookResult | null>(null);
  const [isBaking, setIsBaking] = useState(false);
  const [bakeError, setBakeError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('live');
  const [backdrop, setBackdrop] = useState<StageBackdrop>('dark');
  const [playing, setPlaying] = useState(true);
  const [pingPong, setPingPong] = useState(false);
  const [frameIndex, setFrameIndex] = useState(0);
  const [exportTab, setExportTab] = useState<ExportTab>('tres');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [paletteTarget, setPaletteTarget] = useState<'core' | 'outer'>('core');
  const [docHidden, setDocHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.hidden,
  );

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const requestGuardRef = useRef(createMonotonicRequestGuard());
  const pingPongDirRef = useRef<1 | -1>(1);

  useEffect(() => {
    const guard = requestGuardRef.current;
    return () => guard.invalidate();
  }, []);

  useEffect(() => {
    const onVisibility = () => {
      setDocHidden(document.hidden);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const needsSourceSprite = vfxConfig.archetype === 'noise-dissolve' && vfxConfig.useSourceSprite;
  const effectivePalette = useMemo(
    () => (vfxConfig.snapToPalette ? project.artBible.palette : []),
    [vfxConfig.snapToPalette, project.artBible.palette],
  );

  // Debounced off-main-thread Worker bake using transferable buffers & monotonic cancellation
  useEffect(() => {
    const guard = requestGuardRef.current;
    const token = guard.next();
    let cancelled = false;
    setIsBaking(true);
    setBakeError(null);

    const timer = window.setTimeout(() => {
      void bakeVfxFlipbookInWorker({
        options: {
          archetype: vfxConfig.archetype,
          frameSizePx: vfxConfig.frameSizePx,
          cols: vfxConfig.cols,
          rows: vfxConfig.rows,
          seed: vfxConfig.seed,
          spread: vfxConfig.spread,
          turbulence: vfxConfig.turbulence,
          coreRgb: hexToRgbTuple(vfxConfig.coreHex),
          outerRgb: hexToRgbTuple(vfxConfig.outerHex),
          paletteHex: effectivePalette,
          snapToPalette: vfxConfig.snapToPalette,
        },
        sourceSprite: needsSourceSprite
          ? { rgba: sprite.data, width: sprite.width, height: sprite.height }
          : null,
      })
        .then((res) => {
          if (cancelled || !guard.isCurrent(token)) return;
          setBakedResult(res.result);
          setIsBaking(false);
        })
        .catch((err: unknown) => {
          if (cancelled || !guard.isCurrent(token)) return;
          setBakeError(err instanceof Error ? err.message : 'VFX flipbook bake failed.');
          setIsBaking(false);
        });
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      guard.invalidate();
    };
  }, [
    vfxConfig.archetype,
    vfxConfig.frameSizePx,
    vfxConfig.cols,
    vfxConfig.rows,
    vfxConfig.seed,
    vfxConfig.spread,
    vfxConfig.turbulence,
    vfxConfig.coreHex,
    vfxConfig.outerHex,
    vfxConfig.snapToPalette,
    needsSourceSprite,
    sprite,
    effectivePalette,
  ]);

  const frameCount = bakedResult?.frameCount ?? vfxConfig.cols * vfxConfig.rows;
  const clampedFrameIndex = Math.min(frameIndex, Math.max(0, frameCount - 1));

  useEffect(() => {
    if (frameIndex >= frameCount) {
      setFrameIndex(Math.max(0, frameCount - 1));
    }
  }, [frameIndex, frameCount]);

  // Strict rAF playback loop: pauses on document.hidden, tab switch, or unmount
  useEffect(() => {
    if (!playing || viewMode !== 'live' || frameCount <= 1 || docHidden) {
      return;
    }

    let rafId = 0;
    let lastTick = performance.now();
    const intervalMs = 1000 / Math.max(1, Math.min(60, vfxConfig.fps));

    const tick = (now: number) => {
      if (now - lastTick >= intervalMs) {
        lastTick = now - ((now - lastTick) % intervalMs);
        setFrameIndex((prev) => {
          if (!pingPong) {
            return (prev + 1) % frameCount;
          }
          let next = prev + pingPongDirRef.current;
          if (next >= frameCount) {
            pingPongDirRef.current = -1;
            next = Math.max(0, frameCount - 2);
          } else if (next < 0) {
            pingPongDirRef.current = 1;
            next = Math.min(frameCount - 1, 1);
          }
          return next;
        });
      }
      rafId = window.requestAnimationFrame(tick);
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [playing, viewMode, frameCount, vfxConfig.fps, pingPong, docHidden]);

  // Draw active live frame or packed full sheet onto Canvas2D
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !bakedResult) return;

    const targetBuf =
      viewMode === 'sheet'
        ? bakedResult.sheet
        : (bakedResult.frames[clampedFrameIndex] ?? bakedResult.frames[0] ?? bakedResult.sheet);

    canvas.width = targetBuf.width;
    canvas.height = targetBuf.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = artMode !== 'pixel-art';
    ctx.clearRect(0, 0, targetBuf.width, targetBuf.height);
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(targetBuf.data), targetBuf.width, targetBuf.height),
      0,
      0,
    );
  }, [bakedResult, viewMode, clampedFrameIndex, artMode]);

  const slug = toAssetSlug(`${project.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`);

  const exportPreview = useMemo(() => {
    const meta = {
      archetype: vfxConfig.archetype,
      frameSizePx: vfxConfig.frameSizePx,
      cols: vfxConfig.cols,
      rows: vfxConfig.rows,
    };
    if (exportTab === 'pixi') {
      return exportPixiVfxJson(slug, meta, vfxConfig.fps);
    }
    const godot = exportGodotVfxBundle(slug, meta, vfxConfig.fps);
    return exportTab === 'tres' ? godot.materialTres : godot.sceneTscn;
  }, [
    slug,
    vfxConfig.archetype,
    vfxConfig.frameSizePx,
    vfxConfig.cols,
    vfxConfig.rows,
    vfxConfig.fps,
    exportTab,
  ]);

  const handleCopyPreview = async () => {
    try {
      await navigator.clipboard.writeText(exportPreview);
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
      await onSaveToProject(vfxConfig);
      setSaveNotice(
        `Saved VFX (${vfxConfig.archetype} · ${vfxConfig.cols}×${vfxConfig.rows}) to IndexedDB.`,
      );
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : 'Failed to save VFX config.');
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadZip = () => {
    if (!bakedResult) return;
    const sheetPngBytes = encodeRgbaToPngBytes(
      bakedResult.sheet.data,
      bakedResult.sheet.width,
      bakedResult.sheet.height,
    );
    const recipe = buildAssetRecipe({
      project,
      node: targetNode,
      postProcess: postProcessConfig,
      filename: `${slug}_vfx_sheet.png`,
      outputWidth: bakedResult.sheet.width,
      outputHeight: bakedResult.sheet.height,
      normalizedWidth: rawWidth,
      normalizedHeight: rawHeight,
      recipeArtBibleHash: computeArtBibleHash(project.artBible),
      assetClass: 'vfx',
      vfxFlipbook: vfxConfig,
    });
    const zipBytes = packageVfxFlipbookZip({
      slug,
      sheetPngBytes,
      opts: {
        archetype: vfxConfig.archetype,
        frameSizePx: vfxConfig.frameSizePx,
        cols: vfxConfig.cols,
        rows: vfxConfig.rows,
      },
      fps: vfxConfig.fps,
      recipe,
    });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'application/zip' }),
      `${slug}_vfx_${vfxConfig.archetype}.zip`,
    );
  };

  const updateConfig = (patch: Partial<VfxFlipbookConfig>) => {
    setSaveNotice(null);
    onChangeConfig({ ...vfxConfig, ...patch });
  };

  const backdropStyle =
    backdrop === 'dark'
      ? { backgroundColor: '#111113' }
      : backdrop === 'light'
        ? { backgroundColor: '#E4E4E7' }
        : undefined;
  const backdropClass = backdrop === 'checker' ? 'bg-checkerboard' : '';
  const sheetWidth = bakedResult?.sheet.width ?? vfxConfig.cols * vfxConfig.frameSizePx;
  const sheetHeight = bakedResult?.sheet.height ?? vfxConfig.rows * vfxConfig.frameSizePx;
  const archetypeLabel =
    ARCHETYPE_OPTIONS.find((a) => a.id === vfxConfig.archetype)?.label ?? vfxConfig.archetype;

  return (
    <div
      data-testid="vfx-baker-panel"
      className="flex flex-1 flex-col overflow-hidden bg-[var(--bg-well)] lg:flex-row"
    >
      {/* Left Pane: Archetype, Grid Layout & Procedural Noise Parameters */}
      <div className="w-full shrink-0 space-y-3.5 overflow-y-auto border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 lg:w-72 lg:border-r lg:border-b-0">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-slate-200 uppercase">
            <Sparkles className="h-3.5 w-3.5 text-[#F5B82E]" />
            VFX Archetype
          </h3>
          <div className="mt-2 grid grid-cols-2 gap-1.5">
            {ARCHETYPE_OPTIONS.map((opt) => {
              const active = vfxConfig.archetype === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  data-testid={`vfx-archetype-${opt.id}`}
                  onClick={() => updateConfig({ archetype: opt.id })}
                  className={`rounded border px-2.5 py-1.5 text-left text-xs font-medium transition-colors ${
                    active
                      ? 'border-[#F5B82E] bg-[#F5B82E]/15 font-semibold text-[#F5B82E]'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:bg-slate-800 hover:text-white'
                  } ${opt.id === 'noise-dissolve' ? 'col-span-2' : ''}`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
              Grid Layout
            </span>
            <div className="mt-1 grid grid-cols-3 gap-1">
              {GRID_PRESETS.map((preset) => {
                const active = vfxConfig.cols === preset.cols && vfxConfig.rows === preset.rows;
                return (
                  <button
                    key={preset.label}
                    type="button"
                    data-testid={`vfx-grid-${preset.cols}x${preset.rows}`}
                    onClick={() => updateConfig({ cols: preset.cols, rows: preset.rows })}
                    className={`rounded border py-1 font-mono text-[11px] ${
                      active
                        ? 'border-[#F5B82E] bg-[#F5B82E] font-semibold text-zinc-950'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {preset.label}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <span className="block text-[10px] font-semibold tracking-wider text-[var(--text-muted)] uppercase">
              Cell Size
            </span>
            <div className="mt-1 grid grid-cols-2 gap-1">
              {CELL_SIZES.map((sz) => {
                const active = vfxConfig.frameSizePx === sz;
                return (
                  <button
                    key={sz}
                    type="button"
                    data-testid={`vfx-size-${sz}`}
                    onClick={() => updateConfig({ frameSizePx: sz })}
                    className={`rounded border py-1 font-mono text-[11px] ${
                      active
                        ? 'border-[#F5B82E] bg-[#F5B82E] font-semibold text-zinc-950'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {sz}px
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <div className="flex items-end gap-1.5">
            <div className="min-w-0 flex-1">
              <ScrubInput
                label="Seed"
                value={vfxConfig.seed}
                min={1}
                max={999999}
                step={1}
                decimals={0}
                testId="vfx-seed-scrub"
                onChange={(seed) => updateConfig({ seed: Math.max(0, Math.round(seed)) })}
              />
            </div>
            <button
              type="button"
              data-testid="vfx-seed-random-btn"
              onClick={() =>
                updateConfig({ seed: Math.max(1, Math.floor(Math.random() * 999999)) })
              }
              title="Randomize Seed"
              aria-label="Randomize Seed"
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] p-2 text-slate-200 hover:bg-slate-700"
            >
              <Dices className="h-3.5 w-3.5" />
            </button>
          </div>

          <ScrubInput
            label="Spread"
            value={vfxConfig.spread}
            min={0.1}
            max={0.48}
            step={0.02}
            decimals={2}
            testId="vfx-spread-scrub"
            onChange={(spread) => updateConfig({ spread })}
          />

          <ScrubInput
            label="Turbulence"
            value={vfxConfig.turbulence}
            min={0}
            max={1}
            step={0.05}
            decimals={2}
            testId="vfx-turbulence-scrub"
            onChange={(turbulence) => updateConfig({ turbulence })}
          />

          <ScrubInput
            label="Playback FPS"
            value={vfxConfig.fps}
            min={1}
            max={60}
            step={1}
            unit="fps"
            decimals={0}
            testId="vfx-fps-scrub"
            onChange={(fps) => updateConfig({ fps: Math.max(1, Math.round(fps)) })}
          />
        </div>

        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1.5 text-[11px] text-slate-300">
              <span>Core</span>
              <input
                type="color"
                data-testid="vfx-core-color"
                value={vfxConfig.coreHex}
                onChange={(e) => updateConfig({ coreHex: e.target.value.toUpperCase() })}
                className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </label>
            <label className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1.5 text-[11px] text-slate-300">
              <span>Outer</span>
              <input
                type="color"
                data-testid="vfx-outer-color"
                value={vfxConfig.outerHex}
                onChange={(e) => updateConfig({ outerHex: e.target.value.toUpperCase() })}
                className="h-5 w-7 cursor-pointer rounded border-0 bg-transparent p-0"
              />
            </label>
          </div>

          {project.artBible.palette.length > 0 && (
            <div className="space-y-1">
              <div className="flex items-center justify-between text-[10px] text-[var(--text-muted)]">
                <span>Art Bible Pick Target</span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => setPaletteTarget('core')}
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      paletteTarget === 'core'
                        ? 'bg-[#F5B82E] text-zinc-950'
                        : 'bg-[var(--bg-well)] text-slate-300'
                    }`}
                  >
                    Core
                  </button>
                  <button
                    type="button"
                    onClick={() => setPaletteTarget('outer')}
                    className={`rounded px-1.5 py-0.5 font-medium ${
                      paletteTarget === 'outer'
                        ? 'bg-[#F5B82E] text-zinc-950'
                        : 'bg-[var(--bg-well)] text-slate-300'
                    }`}
                  >
                    Outer
                  </button>
                </div>
              </div>
              <div className="flex flex-wrap gap-1">
                {project.artBible.palette.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    title={`Set ${paletteTarget} color to ${hex}`}
                    onClick={() =>
                      updateConfig(
                        paletteTarget === 'core'
                          ? { coreHex: hex.toUpperCase() }
                          : { outerHex: hex.toUpperCase() },
                      )
                    }
                    className="h-5 w-5 rounded border border-white/20 transition-transform hover:scale-110"
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
              data-testid="vfx-palette-snap-toggle"
              checked={vfxConfig.snapToPalette}
              onChange={(e) => updateConfig({ snapToPalette: e.target.checked })}
              className="accent-[#F5B82E]"
            />
          </label>

          <label className="flex items-center justify-between text-[11px] text-slate-300">
            <span>Use Active Sprite (Dissolve)</span>
            <input
              type="checkbox"
              data-testid="vfx-source-sprite-toggle"
              checked={vfxConfig.useSourceSprite}
              onChange={(e) => updateConfig({ useSourceSprite: e.target.checked })}
              className="accent-[#F5B82E]"
            />
          </label>
        </div>
      </div>

      {/* Center Pane: Animated Flipbook Preview & Full Sheet Inspector */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)]/70 px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5">
              <button
                type="button"
                data-testid="vfx-view-live"
                onClick={() => setViewMode('live')}
                className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium ${
                  viewMode === 'live'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Play className="h-3 w-3" />
                Live Flipbook
              </button>
              <button
                type="button"
                data-testid="vfx-view-sheet"
                onClick={() => setViewMode('sheet')}
                className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium ${
                  viewMode === 'sheet'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Grid className="h-3 w-3" />
                Full Sheet
              </button>
            </div>

            {viewMode === 'live' && (
              <>
                <button
                  type="button"
                  data-testid="vfx-play-toggle"
                  onClick={() => setPlaying((p) => !p)}
                  className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700"
                >
                  {playing ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
                  {playing ? 'Pause' : 'Play'}
                </button>
                <button
                  type="button"
                  data-testid="vfx-pingpong-toggle"
                  onClick={() => setPingPong((p) => !p)}
                  className={`inline-flex items-center gap-1 rounded border px-2 py-1 text-[11px] ${
                    pingPong
                      ? 'border-cyan-500/60 bg-cyan-500/15 text-cyan-200'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-slate-300 hover:bg-slate-700'
                  }`}
                >
                  <Repeat className="h-3 w-3" />
                  Ping-Pong
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
              {(
                [
                  { id: 'checker', label: 'Checker' },
                  { id: 'dark', label: 'Dark' },
                  { id: 'light', label: 'Light' },
                ] as const
              ).map((bg) => (
                <button
                  key={bg.id}
                  type="button"
                  data-testid={`vfx-backdrop-${bg.id}`}
                  onClick={() => setBackdrop(bg.id)}
                  className={`rounded px-2 py-0.5 ${
                    backdrop === bg.id
                      ? 'bg-slate-700 font-semibold text-white'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {bg.label}
                </button>
              ))}
            </div>

            <span
              data-testid="vfx-meta-badge"
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-0.5 font-mono text-[11px] text-slate-200 tabular-nums"
            >
              {archetypeLabel} · {vfxConfig.cols}×{vfxConfig.rows} ({frameCount}f) · {sheetWidth}×
              {sheetHeight}
            </span>
          </div>
        </div>

        {bakeError && (
          <div className="border-b border-rose-500/40 bg-rose-950/60 px-4 py-1.5 text-xs text-rose-200">
            {bakeError}
          </div>
        )}

        <div className="flex flex-1 items-center justify-center overflow-auto bg-[var(--bg-well)] p-6">
          <div
            className={`relative flex items-center justify-center rounded-md border border-[var(--border-hairline)] p-3 shadow-2xl ${backdropClass}`}
            style={backdropStyle}
          >
            <canvas
              ref={canvasRef}
              data-testid={viewMode === 'sheet' ? 'vfx-sheet-canvas' : 'vfx-preview-canvas'}
              className={
                viewMode === 'sheet'
                  ? 'max-h-[420px] max-w-full object-contain'
                  : 'h-64 w-64 object-contain'
              }
              style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
            />
            {isBaking && (
              <span className="absolute right-2 bottom-2 rounded bg-black/75 px-2 py-0.5 text-[10px] text-[#F5B82E]">
                Baking...
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2 text-xs">
          <span className="shrink-0 font-mono text-[11px] text-slate-300 tabular-nums">
            Frame {clampedFrameIndex + 1} / {frameCount}
          </span>
          <input
            type="range"
            data-testid="vfx-frame-slider"
            min={0}
            max={Math.max(0, frameCount - 1)}
            value={clampedFrameIndex}
            disabled={frameCount <= 1}
            onChange={(e) => {
              setPlaying(false);
              setFrameIndex(Number(e.target.value));
            }}
            className="h-1.5 flex-1 accent-[#F5B82E] disabled:opacity-40"
          />
          <span className="shrink-0 font-mono text-[11px] text-[var(--text-muted)] tabular-nums">
            {(frameCount / Math.max(1, vfxConfig.fps)).toFixed(2)}s
          </span>
        </div>
      </div>

      {/* Right Pane: Godot 4 / PixiJS Code Preview & VFX Bundle ZIP */}
      <div className="w-full shrink-0 space-y-3 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 lg:w-80 lg:border-t-0 lg:border-l">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
              Particle Config Export
            </h3>
            <button
              type="button"
              data-testid="vfx-copy-btn"
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

          <div className="grid grid-cols-3 gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
            {(
              [
                { id: 'tres', label: 'Godot .tres' },
                { id: 'tscn', label: 'Godot .tscn' },
                { id: 'pixi', label: 'PixiJS JSON' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                data-testid={`vfx-export-tab-${tab.id}`}
                onClick={() => setExportTab(tab.id)}
                className={`rounded px-1.5 py-1 font-medium transition-colors ${
                  exportTab === tab.id
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <pre
            data-testid="vfx-export-preview"
            className="max-h-56 overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre text-slate-200"
          >
            {exportPreview}
          </pre>
        </div>

        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <button
            type="button"
            data-testid="vfx-save-btn"
            disabled={saving}
            onClick={() => void handleSave()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving VFX...' : 'Save VFX to Project'}
          </button>

          <button
            type="button"
            data-testid="vfx-download-zip-btn"
            disabled={!bakedResult}
            onClick={handleDownloadZip}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
          >
            <FileArchive className="h-3.5 w-3.5" />
            Download VFX ZIP
          </button>

          {saveNotice && (
            <p data-testid="vfx-save-notice" className="text-[11px] text-emerald-300">
              {saveNotice}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
