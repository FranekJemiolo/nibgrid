import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { Check, Copy, FileArchive, Grid, Play, Save, Sparkles, Type, Upload } from 'lucide-react';
import type {
  ArtMode,
  BitmapFontConfig,
  BitmapFontOutlineMode,
  PostProcessConfig,
  Project,
  SpriteNode,
} from '../../domain/schemas';
import { exportBmFontText, exportBmFontXml, packageBmFontZip } from '../../export/bmfontExporter';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import {
  CHARSET_PRESETS,
  buildBuiltInGlyphMasks,
  measureBitmapFontText,
  type BakedBitmapFont,
  type GlyphMask,
  type PackedGlyphMetric,
} from '../../processing/bitmapFont';
import { hexToRgbTuple } from '../../processing/parallaxCompositor';
import { computeArtBibleHash } from '../../processing/projectAudit';
import { BIOME_PRESETS, generateBiomeTile, type BiomeId } from '../../processing/sandboxBiomes';
import type { RgbaBuffer } from '../../processing/types';
import {
  bakeBitmapFontInWorker,
  createMonotonicRequestGuard,
} from '../../workers/postprocessClient';
import { ScrubInput } from '../primitives/ScrubInput';
import {
  SYSTEM_FONT_PRESETS,
  loadUploadedFontFace,
  rasterizeBrowserFontToMasks,
} from './fontRasterizer';

export interface BitmapFontWorkshopProps {
  readonly sprite: RgbaBuffer;
  readonly artMode: ArtMode;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly bitmapConfig: BitmapFontConfig;
  readonly onChangeConfig: (next: BitmapFontConfig) => void;
  readonly onSaveToProject: (saved: BitmapFontConfig) => Promise<void>;
}

interface FloatingCritPop {
  readonly id: number;
  readonly text: string;
  readonly xOffset: number;
  readonly startMs: number;
  readonly durationMs: number;
}

const CRIT_SAMPLES = ['CRIT 128!', '-42', 'MISS!', '+999!'] as const;
const LIVE_STAGE_W = 480;
const LIVE_STAGE_H = 260;

function makeOffscreenFromRgba(
  buf: RgbaBuffer,
  prev?: HTMLCanvasElement | null,
): HTMLCanvasElement {
  const c = prev ?? document.createElement('canvas');
  c.width = Math.max(1, buf.width);
  c.height = Math.max(1, buf.height);
  const ctx = c.getContext('2d');
  if (ctx && buf.width > 0 && buf.height > 0) {
    ctx.putImageData(new ImageData(new Uint8ClampedArray(buf.data), buf.width, buf.height), 0, 0);
  }
  return c;
}

function resolveActiveCharset(cfg: BitmapFontConfig): string {
  if (cfg.charsetPreset === 'damage-numerals') return CHARSET_PRESETS['damage-numerals'];
  if (cfg.charsetPreset === 'hud-upper') return CHARSET_PRESETS['hud-upper'];
  if (cfg.charsetPreset === 'ascii-basic') return CHARSET_PRESETS['ascii-basic'];
  return cfg.customCharset || CHARSET_PRESETS['damage-numerals'];
}

function drawBitmapLine(
  ctx: CanvasRenderingContext2D,
  atlasCanvas: HTMLCanvasElement,
  font: BakedBitmapFont,
  glyphMap: ReadonlyMap<number, PackedGlyphMetric>,
  text: string,
  startX: number,
  startY: number,
  scaleFactor: number,
): void {
  const fallback = glyphMap.get(63);
  const spaceAdvance = Math.max(4, Math.round(font.base * 0.45));
  let cursorX = startX;
  for (const ch of Array.from(text)) {
    const code = ch.charCodeAt(0);
    let glyph = glyphMap.get(code);
    if (!glyph) {
      if (code === 32) {
        cursorX += spaceAdvance * scaleFactor;
        continue;
      }
      glyph = fallback;
    }
    if (!glyph) continue;
    if (glyph.width > 0 && glyph.height > 0) {
      const dx = Math.round(cursorX + glyph.xoffset * scaleFactor);
      const dy = Math.round(startY + glyph.yoffset * scaleFactor);
      ctx.drawImage(
        atlasCanvas,
        glyph.x,
        glyph.y,
        glyph.width,
        glyph.height,
        dx,
        dy,
        glyph.width * scaleFactor,
        glyph.height * scaleFactor,
      );
    }
    cursorX += glyph.xadvance * scaleFactor;
  }
}

export function BitmapFontWorkshop({
  project,
  targetNode,
  postProcessConfig,
  rawWidth,
  rawHeight,
  bitmapConfig,
  onChangeConfig,
  onSaveToProject,
}: BitmapFontWorkshopProps) {
  const [bakedFont, setBakedFont] = useState<BakedBitmapFont | null>(null);
  const [isBaking, setIsBaking] = useState(false);
  const [bakeError, setBakeError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'live' | 'atlas'>('live');
  const [biomeId, setBiomeId] = useState<BiomeId>('dark-dungeon');
  const [previewZoom, setPreviewZoom] = useState<1 | 2 | 3>(2);
  const [paletteTarget, setPaletteTarget] = useState<'top' | 'bottom'>('top');
  const [exportTab, setExportTab] = useState<'fnt' | 'xml'>('fnt');
  const [copied, setCopied] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [customFontError, setCustomFontError] = useState<string | null>(null);
  const [docHidden, setDocHidden] = useState<boolean>(
    () => typeof document !== 'undefined' && document.hidden,
  );
  const [popRev, setPopRev] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const atlasOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const biomeOffscreenRef = useRef<HTMLCanvasElement | null>(null);
  const requestGuardRef = useRef(createMonotonicRequestGuard());
  const critPopsRef = useRef<FloatingCritPop[]>([]);
  const nextPopIdRef = useRef(1);
  const uploadFontInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const guard = requestGuardRef.current;
    return () => {
      guard.invalidate();
      if (atlasOffscreenRef.current) {
        atlasOffscreenRef.current.width = 0;
        atlasOffscreenRef.current.height = 0;
        atlasOffscreenRef.current = null;
      }
      if (biomeOffscreenRef.current) {
        biomeOffscreenRef.current.width = 0;
        biomeOffscreenRef.current.height = 0;
        biomeOffscreenRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const onVisibility = () => setDocHidden(document.hidden);
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const activeCharset = useMemo(() => resolveActiveCharset(bitmapConfig), [bitmapConfig]);
  const biomeTile = useMemo(() => generateBiomeTile(biomeId, 64), [biomeId]);

  // Debounced Worker bake using built-in 5x7 masks OR browser-rasterized TTF/WOFF2 masks
  useEffect(() => {
    const guard = requestGuardRef.current;
    const token = guard.next();
    let cancelled = false;
    setIsBaking(true);
    setBakeError(null);

    const timer = window.setTimeout(() => {
      let masks: GlyphMask[];
      try {
        masks =
          bitmapConfig.sourceKind === 'custom-font'
            ? rasterizeBrowserFontToMasks(activeCharset, {
                fontFamily: bitmapConfig.customFontFamily || 'monospace',
                fontSizePx: bitmapConfig.rasterSizePx,
              })
            : buildBuiltInGlyphMasks(activeCharset);
      } catch (err) {
        if (!cancelled) {
          setBakeError(err instanceof Error ? err.message : 'Font rasterization failed.');
          setIsBaking(false);
        }
        return;
      }

      void bakeBitmapFontInWorker({
        masks,
        options: {
          fontName: bitmapConfig.fontName || 'nibgrid_damage',
          scale: bitmapConfig.scale,
          topRgb: hexToRgbTuple(bitmapConfig.topHex),
          bottomRgb: hexToRgbTuple(bitmapConfig.bottomHex),
          paletteHex: bitmapConfig.snapToPalette ? project.artBible.palette : [],
          snapToPalette: bitmapConfig.snapToPalette,
          outlineMode: bitmapConfig.outlineMode,
          selOutDarken: bitmapConfig.selOutDarken,
          ...(bitmapConfig.useCustomOutline
            ? { outlineRgb: hexToRgbTuple(bitmapConfig.outlineHex) }
            : {}),
          shadowOffsetX: bitmapConfig.shadowOffsetX,
          shadowOffsetY: bitmapConfig.shadowOffsetY,
          shadowRgb: hexToRgbTuple(bitmapConfig.shadowHex),
          shadowAlpha: bitmapConfig.shadowAlpha,
          letterSpacingPx: bitmapConfig.letterSpacingPx,
          paddingPx: bitmapConfig.paddingPx,
        },
      })
        .then((res) => {
          if (cancelled || !guard.isCurrent(token)) return;
          atlasOffscreenRef.current = makeOffscreenFromRgba(
            res.result.atlas,
            atlasOffscreenRef.current,
          );
          setBakedFont(res.result);
          setIsBaking(false);
        })
        .catch((err: unknown) => {
          if (cancelled || !guard.isCurrent(token)) return;
          setBakeError(err instanceof Error ? err.message : 'Bitmap font bake failed.');
          setIsBaking(false);
        });
    }, 30);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      guard.invalidate();
    };
  }, [
    activeCharset,
    bitmapConfig.fontName,
    bitmapConfig.sourceKind,
    bitmapConfig.customFontFamily,
    bitmapConfig.rasterSizePx,
    bitmapConfig.scale,
    bitmapConfig.topHex,
    bitmapConfig.bottomHex,
    bitmapConfig.snapToPalette,
    bitmapConfig.outlineMode,
    bitmapConfig.selOutDarken,
    bitmapConfig.useCustomOutline,
    bitmapConfig.outlineHex,
    bitmapConfig.shadowOffsetX,
    bitmapConfig.shadowOffsetY,
    bitmapConfig.shadowHex,
    bitmapConfig.shadowAlpha,
    bitmapConfig.letterSpacingPx,
    bitmapConfig.paddingPx,
    project.artBible.palette,
  ]);

  const glyphMap = useMemo(() => {
    const map = new Map<number, PackedGlyphMetric>();
    if (!bakedFont) return map;
    for (const g of bakedFont.glyphs) {
      map.set(g.id, g);
    }
    return map;
  }, [bakedFont]);

  const renderCanvas = useCallback(
    (nowMs: number) => {
      const canvas = canvasRef.current;
      const atlasCanvas = atlasOffscreenRef.current;
      if (!canvas || !bakedFont || !atlasCanvas) return;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      if (viewMode === 'atlas') {
        if (canvas.width !== bakedFont.atlas.width || canvas.height !== bakedFont.atlas.height) {
          canvas.width = bakedFont.atlas.width;
          canvas.height = bakedFont.atlas.height;
        }
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(atlasCanvas, 0, 0);
        return;
      }

      if (canvas.width !== LIVE_STAGE_W || canvas.height !== LIVE_STAGE_H) {
        canvas.width = LIVE_STAGE_W;
        canvas.height = LIVE_STAGE_H;
      }
      ctx.imageSmoothingEnabled = false;

      // Tile 64x64 biome backdrop seamlessly across viewport
      const biomeCanvas = biomeOffscreenRef.current;
      if (biomeCanvas) {
        const bw = biomeCanvas.width;
        const bh = biomeCanvas.height;
        for (let y = 0; y < LIVE_STAGE_H; y += bh) {
          for (let x = 0; x < LIVE_STAGE_W; x += bw) {
            ctx.drawImage(biomeCanvas, x, y);
          }
        }
      } else {
        ctx.fillStyle = '#121214';
        ctx.fillRect(0, 0, LIVE_STAGE_W, LIVE_STAGE_H);
      }

      // Draw static HUD / combat text sample at integer scale
      const text = bitmapConfig.previewText || '-42 CRIT 128!';
      const measured = measureBitmapFontText(bakedFont, text);
      const textW = measured.width * previewZoom;
      const textH = measured.height * previewZoom;
      const originX = Math.round((LIVE_STAGE_W - textW) / 2);
      const originY = Math.round(LIVE_STAGE_H * 0.62 - textH / 2);

      drawBitmapLine(ctx, atlasCanvas, bakedFont, glyphMap, text, originX, originY, previewZoom);

      // Draw spawned floating Crit Pops along crisp arc
      const alive: FloatingCritPop[] = [];
      for (const pop of critPopsRef.current) {
        const age = nowMs - pop.startMs;
        if (age >= pop.durationMs) continue;
        alive.push(pop);
        const t = Math.max(0, Math.min(1, age / pop.durationMs));
        const liftY = Math.round(Math.sin(t * Math.PI * 0.85) * 64 + t * 24);
        const popScale = t < 0.18 ? previewZoom + 1 : previewZoom;
        const m = measureBitmapFontText(bakedFont, pop.text);
        const px = Math.round(LIVE_STAGE_W / 2 + pop.xOffset - (m.width * popScale) / 2);
        const py = Math.round(LIVE_STAGE_H * 0.44 - liftY);
        ctx.save();
        ctx.globalAlpha = t > 0.72 ? Math.max(0, 1 - (t - 0.72) / 0.28) : 1;
        drawBitmapLine(ctx, atlasCanvas, bakedFont, glyphMap, pop.text, px, py, popScale);
        ctx.restore();
      }
      critPopsRef.current = alive;
    },
    [bakedFont, bitmapConfig.previewText, glyphMap, previewZoom, viewMode],
  );

  // Redraw immediately on state changes + run rAF only while floating Crit Pops are active & visible
  useEffect(() => {
    biomeOffscreenRef.current = makeOffscreenFromRgba(biomeTile, biomeOffscreenRef.current);
    renderCanvas(performance.now());

    if (docHidden || viewMode !== 'live' || critPopsRef.current.length === 0) {
      return;
    }

    let rafId = 0;
    const tick = (now: number) => {
      renderCanvas(now);
      if (critPopsRef.current.length > 0) {
        rafId = window.requestAnimationFrame(tick);
      } else {
        setPopRev((r) => r + 1);
      }
    };

    rafId = window.requestAnimationFrame(tick);
    return () => {
      window.cancelAnimationFrame(rafId);
    };
  }, [biomeTile, renderCanvas, docHidden, viewMode, popRev]);

  const slug = toAssetSlug(
    bitmapConfig.fontName || `${project.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`,
  );

  const exportPreview = useMemo(() => {
    if (!bakedFont) return '';
    const pngName = `${slug}.png`;
    return exportTab === 'fnt'
      ? exportBmFontText(bakedFont, pngName, { paddingPx: bitmapConfig.paddingPx })
      : exportBmFontXml(bakedFont, pngName, { paddingPx: bitmapConfig.paddingPx });
  }, [bakedFont, exportTab, slug, bitmapConfig.paddingPx]);

  const updateConfig = (patch: Partial<BitmapFontConfig>) => {
    setSaveNotice(null);
    onChangeConfig({ ...bitmapConfig, ...patch });
  };

  const handleUploadFont = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setCustomFontError(null);
    try {
      const familyName = await loadUploadedFontFace(file);
      updateConfig({ sourceKind: 'custom-font', customFontFamily: familyName });
    } catch (error) {
      setCustomFontError(error instanceof Error ? error.message : 'Failed to load font file.');
    }
  };

  const handleSpawnCritPop = () => {
    const idx = nextPopIdRef.current++;
    const sample = CRIT_SAMPLES[idx % CRIT_SAMPLES.length]!;
    const offset = ((idx % 5) - 2) * 34;
    critPopsRef.current = [
      ...critPopsRef.current,
      {
        id: idx,
        text: sample,
        xOffset: offset,
        startMs: performance.now(),
        durationMs: 1100,
      },
    ];
    setViewMode('live');
    setPopRev((r) => r + 1);
  };

  const handleCopyPreview = async () => {
    if (!exportPreview) return;
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
      await onSaveToProject(bitmapConfig);
      setSaveNotice(
        `Saved ${bitmapConfig.fontName} (${bakedFont?.glyphs.length ?? 0} glyphs) to IndexedDB.`,
      );
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : 'Failed to save bitmap font.');
    } finally {
      setSaving(false);
    }
  };

  const handleDownloadZip = () => {
    if (!bakedFont) return;
    try {
      const recipe = buildAssetRecipe({
        project,
        node: targetNode,
        postProcess: postProcessConfig,
        filename: `${slug}.png`,
        outputWidth: bakedFont.atlas.width,
        outputHeight: bakedFont.atlas.height,
        normalizedWidth: rawWidth,
        normalizedHeight: rawHeight,
        recipeArtBibleHash: computeArtBibleHash(project.artBible),
        assetClass: targetNode.assetClass ?? 'ui-panel',
        bitmapFont: bitmapConfig,
      });

      const zipBytes = packageBmFontZip({
        slug,
        font: bakedFont,
        recipe,
        paddingPx: bitmapConfig.paddingPx,
      });
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      triggerBlobDownload(
        new Blob([copy.buffer], { type: 'application/zip' }),
        `${slug}_bmfont.zip`,
      );
      setSaveNotice(`Exported ${slug}_bmfont.zip (.png + .fnt + .xml + .recipe.json).`);
    } catch (error) {
      setSaveNotice(error instanceof Error ? error.message : 'Failed to export BMFont ZIP.');
    }
  };

  return (
    <div
      data-testid="bmfont-workshop-panel"
      className="flex flex-1 flex-col overflow-hidden bg-[var(--bg-well)] lg:flex-row"
    >
      {/* Left Pane: Glyph Source, Gradient, OKLab Sel-Out & Drop Shadow */}
      <aside className="w-full shrink-0 space-y-3 overflow-y-auto border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 lg:w-72 lg:border-r lg:border-b-0">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-slate-200 uppercase">
            <Type className="h-3.5 w-3.5 text-[#F5B82E]" />
            Glyph Source
          </h3>

          <label className="mt-2 block space-y-1 text-[11px] text-slate-300">
            <span>Font Face Name</span>
            <input
              type="text"
              data-testid="bmfont-name-input"
              value={bitmapConfig.fontName}
              onChange={(e) => updateConfig({ fontName: e.target.value })}
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-slate-100"
            />
          </label>

          <div className="mt-2 grid grid-cols-2 gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
            <button
              type="button"
              data-testid="bmfont-source-builtin"
              onClick={() => updateConfig({ sourceKind: 'builtin-5x7' })}
              className={`rounded px-2 py-1 font-medium ${
                bitmapConfig.sourceKind === 'builtin-5x7'
                  ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              5×7 Pixel
            </button>
            <button
              type="button"
              data-testid="bmfont-source-custom"
              onClick={() => updateConfig({ sourceKind: 'custom-font' })}
              className={`rounded px-2 py-1 font-medium ${
                bitmapConfig.sourceKind === 'custom-font'
                  ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              .TTF / System
            </button>
          </div>

          {bitmapConfig.sourceKind === 'custom-font' && (
            <div className="mt-2 space-y-2 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2">
              <div className="flex gap-1.5">
                <select
                  data-testid="bmfont-system-font-select"
                  value={bitmapConfig.customFontFamily}
                  onChange={(e) => updateConfig({ customFontFamily: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200"
                >
                  {SYSTEM_FONT_PRESETS.map((fam) => (
                    <option key={fam} value={fam}>
                      {fam}
                    </option>
                  ))}
                  {!SYSTEM_FONT_PRESETS.includes(bitmapConfig.customFontFamily) &&
                    bitmapConfig.customFontFamily && (
                      <option value={bitmapConfig.customFontFamily}>
                        Uploaded: {bitmapConfig.customFontFamily}
                      </option>
                    )}
                </select>
                <button
                  type="button"
                  onClick={() => uploadFontInputRef.current?.click()}
                  className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-panel)] px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                >
                  <Upload className="h-3 w-3" />
                  .TTF
                </button>
                <input
                  ref={uploadFontInputRef}
                  type="file"
                  data-testid="bmfont-upload-font-input"
                  accept=".ttf,.otf,.woff,.woff2"
                  onChange={(e) => void handleUploadFont(e)}
                  className="hidden"
                />
              </div>

              <ScrubInput
                label="Raster Size"
                value={bitmapConfig.rasterSizePx}
                min={10}
                max={48}
                step={1}
                decimals={0}
                unit="px"
                testId="bmfont-raster-size-scrub"
                onChange={(val) => updateConfig({ rasterSizePx: Math.round(val) })}
              />

              {customFontError && <p className="text-[10px] text-rose-300">{customFontError}</p>}
            </div>
          )}
        </div>

        {/* Charset Preset */}
        <div className="space-y-1.5 border-t border-[var(--border-hairline)] pt-2.5">
          <span className="text-[11px] font-semibold tracking-wider text-slate-300 uppercase">
            Charset
          </span>
          <div className="grid grid-cols-3 gap-1 text-[10px]">
            {(
              [
                { id: 'damage-numerals', label: 'Damage (23)' },
                { id: 'hud-upper', label: 'HUD Upper' },
                { id: 'ascii-basic', label: 'ASCII (95)' },
              ] as const
            ).map((preset) => (
              <button
                key={preset.id}
                type="button"
                data-testid={`bmfont-charset-${preset.id}`}
                onClick={() => updateConfig({ charsetPreset: preset.id })}
                className={`rounded border px-1.5 py-1 font-medium ${
                  bitmapConfig.charsetPreset === preset.id
                    ? 'border-[#F5B82E]/80 bg-[#F5B82E]/15 text-[#F5B82E]'
                    : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:text-white'
                }`}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <input
            type="text"
            data-testid="bmfont-custom-chars-input"
            value={activeCharset}
            onChange={(e) =>
              updateConfig({
                charsetPreset: 'custom',
                customCharset: e.target.value || '0123456789',
              })
            }
            className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-[11px] text-slate-200"
            title="Custom character set"
          />
        </div>

        {/* Scale, Outline & Sel-Out */}
        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5">
          <ScrubInput
            label="Integer Scale"
            value={bitmapConfig.scale}
            min={1}
            max={4}
            step={1}
            decimals={0}
            unit="×"
            testId="bmfont-scale-scrub"
            onChange={(val) => updateConfig({ scale: Math.round(val) })}
          />

          <div className="space-y-1">
            <span className="text-[11px] text-[var(--text-muted)]">OKLab Sel-Out Outline</span>
            <div className="grid grid-cols-3 gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
              {(
                [
                  { mode: 0 as BitmapFontOutlineMode, label: 'None' },
                  { mode: 1 as BitmapFontOutlineMode, label: '4-Way' },
                  { mode: 2 as BitmapFontOutlineMode, label: '8-Way' },
                ] as const
              ).map((item) => (
                <button
                  key={item.mode}
                  type="button"
                  data-testid={`bmfont-outline-${item.mode}`}
                  onClick={() => updateConfig({ outlineMode: item.mode })}
                  className={`rounded px-2 py-1 font-medium ${
                    bitmapConfig.outlineMode === item.mode
                      ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>

          <ScrubInput
            label="Sel-Out Darken"
            value={bitmapConfig.selOutDarken}
            min={0.1}
            max={0.9}
            step={0.05}
            decimals={2}
            testId="bmfont-selout-scrub"
            onChange={(val) => updateConfig({ selOutDarken: val })}
          />

          <div className="grid grid-cols-2 gap-1.5">
            <ScrubInput
              label="Shadow X"
              value={bitmapConfig.shadowOffsetX}
              min={-4}
              max={4}
              step={1}
              decimals={0}
              unit="px"
              testId="bmfont-shadow-x-scrub"
              onChange={(val) => updateConfig({ shadowOffsetX: Math.round(val) })}
            />
            <ScrubInput
              label="Shadow Y"
              value={bitmapConfig.shadowOffsetY}
              min={-4}
              max={4}
              step={1}
              decimals={0}
              unit="px"
              testId="bmfont-shadow-y-scrub"
              onChange={(val) => updateConfig({ shadowOffsetY: Math.round(val) })}
            />
          </div>

          <div className="grid grid-cols-2 gap-1.5">
            <ScrubInput
              label="Spacing"
              value={bitmapConfig.letterSpacingPx}
              min={-4}
              max={16}
              step={1}
              decimals={0}
              unit="px"
              testId="bmfont-spacing-scrub"
              onChange={(val) => updateConfig({ letterSpacingPx: Math.round(val) })}
            />
            <ScrubInput
              label="Padding"
              value={bitmapConfig.paddingPx}
              min={1}
              max={16}
              step={1}
              decimals={0}
              unit="px"
              testId="bmfont-padding-scrub"
              onChange={(val) => updateConfig({ paddingPx: Math.round(val) })}
            />
          </div>
        </div>

        {/* Gradient Fill & Art Bible Palette */}
        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5 text-xs">
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setPaletteTarget('top')}
              className={`flex items-center justify-between rounded border px-2 py-1 text-[11px] ${
                paletteTarget === 'top'
                  ? 'border-[#F5B82E] bg-[#F5B82E]/10 text-white'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300'
              }`}
            >
              <span>Top</span>
              <input
                type="color"
                aria-label="Gradient top color"
                value={bitmapConfig.topHex}
                onChange={(e) => updateConfig({ topHex: e.target.value.toUpperCase() })}
                onClick={(e) => e.stopPropagation()}
                className="h-4 w-5 cursor-pointer bg-transparent"
              />
            </button>

            <button
              type="button"
              onClick={() => setPaletteTarget('bottom')}
              className={`flex items-center justify-between rounded border px-2 py-1 text-[11px] ${
                paletteTarget === 'bottom'
                  ? 'border-[#F5B82E] bg-[#F5B82E]/10 text-white'
                  : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300'
              }`}
            >
              <span>Bottom</span>
              <input
                type="color"
                aria-label="Gradient bottom color"
                value={bitmapConfig.bottomHex}
                onChange={(e) => updateConfig({ bottomHex: e.target.value.toUpperCase() })}
                onClick={(e) => e.stopPropagation()}
                className="h-4 w-5 cursor-pointer bg-transparent"
              />
            </button>
          </div>

          {project.artBible.palette.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {project.artBible.palette.slice(0, 12).map((hex) => (
                <button
                  key={hex}
                  type="button"
                  title={`Apply ${hex} to ${paletteTarget}`}
                  onClick={() =>
                    updateConfig(paletteTarget === 'top' ? { topHex: hex } : { bottomHex: hex })
                  }
                  className="h-4 w-4 rounded border border-white/20 transition-transform hover:scale-110"
                  style={{ backgroundColor: hex }}
                />
              ))}
            </div>
          )}

          <label className="flex items-center justify-between text-[11px] text-slate-300">
            <span>Snap Fill to Art Bible Palette</span>
            <input
              type="checkbox"
              data-testid="bmfont-palette-snap-toggle"
              checked={bitmapConfig.snapToPalette}
              onChange={(e) => updateConfig({ snapToPalette: e.target.checked })}
              className="accent-[#F5B82E]"
            />
          </label>
        </div>
      </aside>

      {/* Center Pane: Live Combat Text Over Biome Backdrop / Packed PoT Atlas */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <div className="flex rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5">
              <button
                type="button"
                data-testid="bmfont-view-live"
                onClick={() => setViewMode('live')}
                className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium ${
                  viewMode === 'live'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Play className="h-3 w-3" />
                Live Combat
              </button>
              <button
                type="button"
                data-testid="bmfont-view-atlas"
                onClick={() => setViewMode('atlas')}
                className={`inline-flex items-center gap-1 rounded px-2.5 py-1 text-[11px] font-medium ${
                  viewMode === 'atlas'
                    ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                    : 'text-slate-300 hover:text-white'
                }`}
              >
                <Grid className="h-3 w-3" />
                Packed Atlas
              </button>
            </div>

            <button
              type="button"
              data-testid="bmfont-spawn-crit-btn"
              onClick={handleSpawnCritPop}
              className="inline-flex items-center gap-1 rounded border border-[#F5B82E]/50 bg-[#F5B82E]/15 px-2.5 py-1 text-[11px] font-semibold text-[#F5B82E] hover:bg-[#F5B82E]/25"
            >
              <Sparkles className="h-3 w-3" />
              Spawn Crit Pop
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {viewMode === 'live' && (
              <>
                <select
                  data-testid="bmfont-biome-select"
                  value={biomeId}
                  onChange={(e) => setBiomeId(e.target.value as BiomeId)}
                  className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200"
                >
                  {BIOME_PRESETS.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                    </option>
                  ))}
                </select>
                <div className="flex rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
                  {([1, 2, 3] as const).map((z) => (
                    <button
                      key={z}
                      type="button"
                      onClick={() => setPreviewZoom(z)}
                      className={`rounded px-2 py-0.5 tabular-nums ${
                        previewZoom === z
                          ? 'bg-slate-700 font-semibold text-white'
                          : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {z}×
                    </button>
                  ))}
                </div>
              </>
            )}

            <span
              data-testid="bmfont-meta-badge"
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2.5 py-0.5 font-mono text-[11px] text-slate-200 tabular-nums"
            >
              {bakedFont
                ? `${bakedFont.glyphs.length} glyphs · ${bakedFont.atlas.width}×${bakedFont.atlas.height} PoT`
                : 'Baking...'}
            </span>
          </div>
        </div>

        {bakeError && (
          <div className="border-b border-rose-500/40 bg-rose-950/60 px-4 py-1.5 text-xs text-rose-200">
            {bakeError}
          </div>
        )}

        <div className="flex flex-1 items-center justify-center overflow-auto bg-[var(--bg-well)] p-4">
          <div className="relative flex items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[#0b0b0d] p-2 shadow-2xl">
            <canvas
              ref={canvasRef}
              data-testid={viewMode === 'atlas' ? 'bmfont-atlas-canvas' : 'bmfont-preview-canvas'}
              className={
                viewMode === 'atlas'
                  ? 'max-h-[340px] max-w-full bg-checkerboard object-contain'
                  : 'h-[260px] w-[480px] max-w-full object-contain'
              }
              style={{ imageRendering: 'pixelated' }}
            />
            {isBaking && (
              <span className="absolute right-3 bottom-3 rounded bg-black/75 px-2 py-0.5 text-[10px] text-[#F5B82E]">
                Baking Font...
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] px-4 py-2 text-xs">
          <span className="shrink-0 text-[11px] text-[var(--text-muted)]">Preview String</span>
          <input
            type="text"
            data-testid="bmfont-preview-text-input"
            value={bitmapConfig.previewText}
            onChange={(e) => updateConfig({ previewText: e.target.value })}
            className="min-w-0 flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1 font-mono text-xs text-slate-100"
          />
        </div>
      </div>

      {/* Right Pane: AngelCode .fnt / .xml Preview, Save & ZIP Bundle */}
      <aside className="w-full shrink-0 space-y-3 overflow-y-auto border-t border-[var(--border-hairline)] bg-[var(--bg-panel)] p-3.5 lg:w-80 lg:border-t-0 lg:border-l">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
              AngelCode BMFont
            </h3>
            <button
              type="button"
              data-testid="bmfont-copy-btn"
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

          <div className="grid grid-cols-2 gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
            <button
              type="button"
              data-testid="bmfont-export-tab-fnt"
              onClick={() => setExportTab('fnt')}
              className={`rounded px-2 py-1 font-medium ${
                exportTab === 'fnt'
                  ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Godot 4 (.fnt)
            </button>
            <button
              type="button"
              data-testid="bmfont-export-tab-xml"
              onClick={() => setExportTab('xml')}
              className={`rounded px-2 py-1 font-medium ${
                exportTab === 'xml'
                  ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                  : 'text-slate-300 hover:text-white'
              }`}
            >
              Phaser / Pixi (.xml)
            </button>
          </div>

          <pre
            data-testid="bmfont-export-preview"
            className="max-h-60 overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre text-slate-200"
          >
            {exportPreview}
          </pre>
        </div>

        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <button
            type="button"
            data-testid="bmfont-save-btn"
            disabled={saving}
            onClick={() => void handleSave()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving Font...' : 'Save Font to Project'}
          </button>

          <button
            type="button"
            data-testid="bmfont-download-zip-btn"
            disabled={!bakedFont}
            onClick={handleDownloadZip}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57] disabled:opacity-50"
          >
            <FileArchive className="h-3.5 w-3.5" />
            Download BMFont ZIP
          </button>

          {saveNotice && (
            <p data-testid="bmfont-save-notice" className="text-[11px] text-emerald-300">
              {saveNotice}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
