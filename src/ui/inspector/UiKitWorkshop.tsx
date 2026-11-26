import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  Copy,
  FileArchive,
  FolderSync,
  Palette,
  Save,
  Sparkles,
  Sliders,
} from 'lucide-react';
import { db } from '../../db/database';
import { sanitizeEntitySlug } from '../../domain/entitySchema';
import {
  createDefaultBitmapFontConfig,
  type ArtMode,
  type PostProcessConfig,
  type Project,
  type ProviderConfig,
  type SpriteNode,
  type UiKitStyleConfigSchemaType,
} from '../../domain/schemas';
import {
  assembleGodotUiKitFiles,
  bakeBitmapFontFromConfig,
  exportGodotThemeTres,
  packageUiKitThemeZip,
} from '../../export/godotThemeExporter';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { parseHexRgb } from '../../processing/backgroundKey';
import type { BakedBitmapFont, PackedGlyphMetric } from '../../processing/bitmapFont';
import { computeArtBibleHash } from '../../processing/projectAudit';
import type { RgbaBuffer } from '../../processing/types';
import {
  ALL_UI_WIDGET_SLOTS,
  bakeProceduralUiKit,
  clampNineSliceMargins,
  pickUiKitColorsFromPalette,
  renderNineSliceToBuffer,
  type BakedUiKit,
  type NineSliceMargins,
  type UiWidgetSlot,
} from '../../processing/uiKitCore';
import { estimateUiKitCost, generateUiKitViaAi } from '../../providers/uiKitAdapter';
import { useAppStore } from '../../store/useAppStore';
import {
  bindGodotDirectory,
  downloadGodotSyncZip,
  isFsaaSupported,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';
import { ScrubInput } from '../primitives/ScrubInput';

export interface UiKitWorkshopProps {
  readonly artMode: ArtMode;
  readonly project: Project;
  readonly targetNode: SpriteNode;
  readonly spriteNodes: readonly SpriteNode[];
  readonly providers: readonly ProviderConfig[];
  readonly postProcessConfig: PostProcessConfig;
  readonly rawWidth: number;
  readonly rawHeight: number;
  readonly uiKitConfig: UiKitStyleConfigSchemaType;
  readonly onChangeConfig: (next: UiKitStyleConfigSchemaType) => void;
  readonly onSaveToProject: (saved: UiKitStyleConfigSchemaType) => Promise<void>;
}

const SLOT_LABELS: Record<UiWidgetSlot, string> = {
  button_normal: 'Normal',
  button_hover: 'Hover',
  button_pressed: 'Pressed',
  button_disabled: 'Disabled',
  panel_bg: 'Panel BG',
  bar_track: 'Bar Track',
  bar_fill: 'Bar Fill',
};

const BUILTIN_HUD_FONT_ID = '__builtin_hud__';

function rgbTupleToHex(rgb: readonly [number, number, number]): string {
  const byteHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${byteHex(rgb[0])}${byteHex(rgb[1])}${byteHex(rgb[2])}`;
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const { r, g, b } = parseHexRgb(hex);
  return [r, g, b];
}

function drawBitmapFontTextOnCanvas(
  ctx: CanvasRenderingContext2D,
  font: BakedBitmapFont,
  text: string,
  centerX: number,
  centerY: number,
  scaleFactor: number,
): void {
  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = font.atlas.width;
  atlasCanvas.height = font.atlas.height;
  const atlasCtx = atlasCanvas.getContext('2d');
  if (!atlasCtx) return;
  atlasCtx.putImageData(
    new ImageData(new Uint8ClampedArray(font.atlas.data), font.atlas.width, font.atlas.height),
    0,
    0,
  );

  const glyphMap = new Map<number, PackedGlyphMetric>();
  for (const glyph of font.glyphs) {
    glyphMap.set(glyph.id, glyph);
  }
  const spaceAdv = Math.max(4, Math.round(font.base * 0.45));
  const chars = Array.from(text);
  let totalW = 0;
  for (const ch of chars) {
    const code = ch.charCodeAt(0);
    const glyph = glyphMap.get(code) ?? glyphMap.get(63);
    if (code === 32) {
      totalW += spaceAdv * scaleFactor;
    } else if (glyph) {
      totalW += glyph.xadvance * scaleFactor;
    }
  }

  let cursorX = Math.round(centerX - totalW / 2);
  const startY = Math.round(centerY - (font.lineHeight * scaleFactor) / 2);
  for (const ch of chars) {
    const code = ch.charCodeAt(0);
    if (code === 32) {
      cursorX += spaceAdv * scaleFactor;
      continue;
    }
    const glyph = glyphMap.get(code) ?? glyphMap.get(63);
    if (!glyph) continue;
    if (glyph.width > 0 && glyph.height > 0) {
      ctx.drawImage(
        atlasCanvas,
        glyph.x,
        glyph.y,
        glyph.width,
        glyph.height,
        Math.round(cursorX + glyph.xoffset * scaleFactor),
        Math.round(startY + glyph.yoffset * scaleFactor),
        glyph.width * scaleFactor,
        glyph.height * scaleFactor,
      );
    }
    cursorX += glyph.xadvance * scaleFactor;
  }
}

interface RgbaCanvasProps {
  readonly buffer: RgbaBuffer;
  readonly artMode: ArtMode;
  readonly className?: string;
  readonly testId?: string;
  readonly guideMargins?: NineSliceMargins;
  readonly overlayFont?: BakedBitmapFont;
  readonly overlayLabel?: string;
}

function RgbaBufferCanvas({
  buffer,
  artMode,
  className,
  testId,
  guideMargins,
  overlayFont,
  overlayLabel,
}: RgbaCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = Math.max(1, buffer.width);
    canvas.height = Math.max(1, buffer.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = artMode !== 'pixel-art';
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height),
      0,
      0,
    );

    if (overlayFont && overlayLabel) {
      drawBitmapFontTextOnCanvas(
        ctx,
        overlayFont,
        overlayLabel,
        Math.round(buffer.width / 2),
        Math.round(buffer.height / 2),
        1,
      );
    }

    if (guideMargins) {
      const m = clampNineSliceMargins(guideMargins, buffer.width, buffer.height);
      ctx.save();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 1;
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(m.left + 0.5, 0);
      ctx.lineTo(m.left + 0.5, buffer.height);
      ctx.moveTo(buffer.width - m.right + 0.5, 0);
      ctx.lineTo(buffer.width - m.right + 0.5, buffer.height);
      ctx.moveTo(0, m.top + 0.5);
      ctx.lineTo(buffer.width, m.top + 0.5);
      ctx.moveTo(0, buffer.height - m.bottom + 0.5);
      ctx.lineTo(buffer.width, buffer.height - m.bottom + 0.5);
      ctx.stroke();
      ctx.restore();
    }
  }, [artMode, buffer, guideMargins, overlayFont, overlayLabel]);

  return (
    <canvas
      ref={canvasRef}
      data-testid={testId}
      className={className}
      style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
    />
  );
}

/**
 * Godot 4 `Theme` `.tres` UI Kit Builder (M33C):
 * dual-mode (Procedural / GenAI) 7-slot 9-slice synthesizer, live interactive widget sandbox,
 * M24 Bitmap Font pairing, 1-click FSAA `res://` sync, and zipped bundle exporter.
 */
export function UiKitWorkshop({
  artMode,
  project,
  targetNode,
  spriteNodes,
  providers,
  postProcessConfig,
  rawWidth,
  rawHeight,
  uiKitConfig,
  onChangeConfig,
  onSaveToProject,
}: UiKitWorkshopProps) {
  const { syncTarget, refreshSyncTarget } = useAppStore();
  const [mode, setMode] = useState<'procedural' | 'ai'>('procedural');
  const [aiPrompt, setAiPrompt] = useState('ornate gold-rimmed RPG frame and parchment panel');
  const [selectedProviderId, setSelectedProviderId] = useState<string>(() => {
    const preferred = providers.find((p) => p.enabled && p.kind !== 'comfyui') ?? providers[0];
    return preferred?.id ?? '';
  });
  const [aiKit, setAiKit] = useState<BakedUiKit | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  const [selectedSlot, setSelectedSlot] = useState<UiWidgetSlot>('button_normal');
  const [buttonHovered, setButtonHovered] = useState(false);
  const [buttonPressed, setButtonPressed] = useState(false);
  const [previewDisabled, setPreviewDisabled] = useState(false);
  const [progressPct, setProgressPct] = useState(72);

  const [saving, setSaving] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [copiedTres, setCopiedTres] = useState(false);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorNotice, setErrorNotice] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const progressCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  const activeProvider = useMemo(
    () => providers.find((p) => p.id === selectedProviderId) ?? providers[0],
    [providers, selectedProviderId],
  );
  const costEstimate = useMemo(
    () =>
      mode === 'procedural'
        ? estimateUiKitCost('mock')
        : estimateUiKitCost(activeProvider?.kind ?? 'mock'),
    [activeProvider?.kind, mode],
  );

  const safeSlug = useMemo(
    () => sanitizeEntitySlug(uiKitConfig.slug || 'ui_rpg'),
    [uiKitConfig.slug],
  );

  const clampedMargins = useMemo(
    () =>
      clampNineSliceMargins(uiKitConfig.margins, uiKitConfig.tileSizePx, uiKitConfig.tileSizePx),
    [uiKitConfig.margins, uiKitConfig.tileSizePx],
  );

  const activeKit: BakedUiKit = useMemo(() => {
    if (mode === 'ai' && aiKit) {
      const slotW = aiKit.slots.button_normal.width;
      const slotH = aiKit.slots.button_normal.height;
      return {
        ...aiKit,
        slug: safeSlug,
        margins: clampNineSliceMargins(uiKitConfig.margins, slotW, slotH),
        contentMarginPx: uiKitConfig.contentMarginPx,
      };
    }
    return bakeProceduralUiKit({
      ...uiKitConfig,
      slug: safeSlug,
      margins: clampedMargins,
    });
  }, [aiKit, clampedMargins, mode, safeSlug, uiKitConfig]);

  const fontNodes = useMemo(() => spriteNodes.filter((n) => Boolean(n.bitmapFont)), [spriteNodes]);

  const linkedFont = useMemo(() => {
    const linkId = uiKitConfig.linkedBmFontId;
    if (!linkId) return undefined;
    if (linkId === BUILTIN_HUD_FONT_ID) {
      const baseCfg = createDefaultBitmapFontConfig();
      const hudCfg = {
        ...baseCfg,
        fontName: `${safeSlug}_hud`,
        charsetPreset: 'hud-upper' as const,
        scale: 1 as const,
        topHex: rgbTupleToHex(uiKitConfig.accentRgb),
        bottomHex: '#FFFFFF',
        outlineHex: rgbTupleToHex(uiKitConfig.outlineRgb),
      };
      const font = bakeBitmapFontFromConfig(hudCfg, project.artBible.palette);
      return { filenameBase: `${safeSlug}_hud`, font };
    }
    const matched = fontNodes.find((n) => n.id === linkId);
    if (!matched?.bitmapFont) return undefined;
    const font = bakeBitmapFontFromConfig(matched.bitmapFont, project.artBible.palette);
    const base = sanitizeEntitySlug(matched.bitmapFont.fontName || 'ui_font');
    return { filenameBase: base, font };
  }, [
    fontNodes,
    project.artBible.palette,
    safeSlug,
    uiKitConfig.accentRgb,
    uiKitConfig.linkedBmFontId,
    uiKitConfig.outlineRgb,
  ]);

  const currentButtonSlot: UiWidgetSlot = previewDisabled
    ? 'button_disabled'
    : buttonPressed
      ? 'button_pressed'
      : buttonHovered
        ? 'button_hover'
        : 'button_normal';

  const currentButtonStateLabel = previewDisabled
    ? 'Disabled'
    : buttonPressed
      ? 'Pressed'
      : buttonHovered
        ? 'Hover'
        : 'Normal';

  const panelPreviewBuffer = useMemo(
    () => renderNineSliceToBuffer(activeKit.slots.panel_bg, activeKit.margins, 320, 176),
    [activeKit],
  );

  const buttonPreviewBuffer = useMemo(
    () => renderNineSliceToBuffer(activeKit.slots[currentButtonSlot], activeKit.margins, 180, 44),
    [activeKit, currentButtonSlot],
  );

  useEffect(() => {
    const canvas = progressCanvasRef.current;
    if (!canvas) return;
    const w = 220;
    const h = 24;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = artMode !== 'pixel-art';
    const trackBuf = renderNineSliceToBuffer(activeKit.slots.bar_track, activeKit.margins, w, h);
    ctx.putImageData(new ImageData(new Uint8ClampedArray(trackBuf.data), w, h), 0, 0);

    const fillW = Math.round((w * Math.max(0, Math.min(100, progressPct))) / 100);
    if (fillW >= 4) {
      const fillBuf = renderNineSliceToBuffer(
        activeKit.slots.bar_fill,
        activeKit.margins,
        fillW,
        h,
      );
      const off = document.createElement('canvas');
      off.width = fillW;
      off.height = h;
      const offCtx = off.getContext('2d');
      if (offCtx) {
        offCtx.putImageData(new ImageData(new Uint8ClampedArray(fillBuf.data), fillW, h), 0, 0);
        ctx.drawImage(off, 0, 0);
      }
    }
  }, [activeKit, artMode, progressPct]);

  const tresPreview = useMemo(
    () =>
      exportGodotThemeTres({
        slug: safeSlug,
        resSubpath: `assets/nibgrid/${safeSlug}`,
        margins: activeKit.margins,
        contentMarginPx: uiKitConfig.contentMarginPx,
        linkedFontFilename: linkedFont ? `${linkedFont.filenameBase}.fnt` : undefined,
        referenceTileSize: activeKit.slots.button_normal.width,
      }),
    [activeKit, linkedFont, safeSlug, uiKitConfig.contentMarginPx],
  );

  const updateConfig = (patch: Partial<UiKitStyleConfigSchemaType>) => {
    const nextSize = patch.tileSizePx ?? uiKitConfig.tileSizePx;
    const rawMargins = patch.margins ?? uiKitConfig.margins;
    onChangeConfig({
      ...uiKitConfig,
      ...patch,
      tileSizePx: nextSize,
      margins: clampNineSliceMargins(rawMargins, nextSize, nextSize),
    });
  };

  const handleSyncPalette = () => {
    const picked = pickUiKitColorsFromPalette(project.artBible.palette);
    updateConfig({
      baseRgb: [...picked.baseRgb],
      accentRgb: [...picked.accentRgb],
      fillBarRgb: [...picked.fillBarRgb],
      outlineRgb: [...picked.outlineRgb],
    });
    setStatusNotice('Applied active Art Bible palette colors to UI Kit.');
    setErrorNotice(null);
  };

  const handleGenerateAi = async () => {
    if (!activeProvider) {
      setAiError('No provider configured for AI UI Kit generation.');
      return;
    }
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setAiBusy(true);
    setAiError(null);
    setStatusNotice(null);

    try {
      const result = await generateUiKitViaAi(
        aiPrompt,
        {
          ...uiKitConfig,
          slug: safeSlug,
          margins: clampedMargins,
        },
        project.artBible,
        activeProvider,
        { signal: controller.signal },
      );
      setAiKit(result.kit);
      setMode('ai');
      setStatusNotice(`Generated 7-slot UI Kit via ${result.providerLabel}.`);
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setStatusNotice('UI Kit generation cancelled.');
      } else {
        setAiError(err instanceof Error ? err.message : 'Failed to generate AI UI Kit.');
      }
    } finally {
      setAiBusy(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setErrorNotice(null);
    setStatusNotice(null);
    try {
      await onSaveToProject({
        ...uiKitConfig,
        slug: safeSlug,
        margins: clampedMargins,
      });
      setStatusNotice(`Saved "${safeSlug}" UI Kit theme configuration to project.`);
    } catch (err) {
      setErrorNotice(err instanceof Error ? err.message : 'Failed to save UI Kit config.');
    } finally {
      setSaving(false);
    }
  };

  const handleSyncToGodot = async () => {
    setSyncing(true);
    setErrorNotice(null);
    setStatusNotice(null);
    try {
      const virtualFiles = assembleGodotUiKitFiles(activeKit, {
        resSubpath: `assets/nibgrid/${safeSlug}`,
        isPixelArt: artMode === 'pixel-art',
        ...(linkedFont ? { linkedFont } : {}),
      });
      if (!isFsaaSupported()) {
        downloadGodotSyncZip(`${project.name}_${safeSlug}_theme`, virtualFiles);
        setStatusNotice(
          `Downloaded ${virtualFiles.length}-file res://${safeSlug} sync ZIP (FSAA unsupported in browser).`,
        );
        return;
      }
      if (!syncTarget) {
        await bindGodotDirectory(db, project.id);
      }
      const res = await syncFilesToGodotDirectory(db, project.id, virtualFiles);
      await refreshSyncTarget(project.id);
      setStatusNotice(
        res.writtenCount === 0
          ? `0 files changed — res://${res.folderName}/assets/nibgrid/${safeSlug} is up to date.`
          : `Synced ${res.writtenCount} UI Kit files to res://${res.folderName}/assets/nibgrid/${safeSlug}.`,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setErrorNotice(err instanceof Error ? err.message : 'Failed to sync UI Kit to Godot folder.');
    } finally {
      setSyncing(false);
    }
  };

  const handleDownloadZip = () => {
    setErrorNotice(null);
    const tileW = activeKit.slots.button_normal.width;
    const tileH = activeKit.slots.button_normal.height;
    const recipe = buildAssetRecipe({
      project,
      node: targetNode,
      postProcess: postProcessConfig,
      filename: `${toAssetSlug(safeSlug)}.png`,
      outputWidth: tileW,
      outputHeight: tileH,
      normalizedWidth: rawWidth,
      normalizedHeight: rawHeight,
      uiKitConfig: {
        ...uiKitConfig,
        slug: safeSlug,
        margins: activeKit.margins,
      },
      recipeArtBibleHash: computeArtBibleHash(project.artBible),
      assetClass: targetNode.assetClass ?? 'ui-panel',
    });

    const zipBytes = packageUiKitThemeZip({
      kit: activeKit,
      recipe,
      isPixelArt: artMode === 'pixel-art',
      ...(linkedFont ? { linkedFont } : {}),
    });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'application/zip' }),
      `${safeSlug}_theme.zip`,
    );
    setStatusNotice(
      `Downloaded ${safeSlug}_theme.zip (7 PNGs + .import + ${safeSlug}_theme.tres).`,
    );
  };

  const handleCopyTres = async () => {
    try {
      await navigator.clipboard.writeText(tresPreview);
      setCopiedTres(true);
      window.setTimeout(() => setCopiedTres(false), 1600);
    } catch {
      setStatusNotice('Clipboard unavailable; select and copy from the .tres preview.');
    }
  };

  const colorControls: readonly {
    key: 'baseRgb' | 'accentRgb' | 'fillBarRgb' | 'outlineRgb';
    label: string;
    value: readonly [number, number, number];
  }[] = [
    { key: 'baseRgb', label: 'Base Fill', value: uiKitConfig.baseRgb },
    { key: 'accentRgb', label: 'Hover / Border', value: uiKitConfig.accentRgb },
    { key: 'fillBarRgb', label: 'Bar Fill', value: uiKitConfig.fillBarRgb },
    { key: 'outlineRgb', label: 'Sel-Out', value: uiKitConfig.outlineRgb },
  ];

  return (
    <div
      data-testid="uikit-workshop-panel"
      className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[310px_minmax(0,1fr)_310px]"
    >
      {/* Left: UI Kit Styling, Margins & Font Pairing */}
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-r border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <Sliders className="h-3.5 w-3.5 text-[#F5B82E]" />
            <h3 className="text-xs font-semibold tracking-wider text-slate-200 uppercase">
              UI Kit Foundry
            </h3>
          </div>
          <span
            data-testid="uikit-cost-badge"
            className="rounded border border-emerald-500/40 bg-emerald-500/15 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-300"
          >
            {costEstimate.label}
          </span>
        </div>

        {/* Generation Mode Switch */}
        <div className="grid grid-cols-2 gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] p-0.5 text-[11px]">
          <button
            type="button"
            data-testid="uikit-mode-procedural"
            onClick={() => setMode('procedural')}
            className={`rounded px-2 py-1.5 font-medium ${
              mode === 'procedural'
                ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            Procedural ($0)
          </button>
          <button
            type="button"
            data-testid="uikit-mode-ai"
            onClick={() => setMode('ai')}
            className={`rounded px-2 py-1.5 font-medium ${
              mode === 'ai'
                ? 'bg-[#F5B82E] font-semibold text-zinc-950'
                : 'text-slate-300 hover:text-white'
            }`}
          >
            GenAI Sheet
          </button>
        </div>

        {mode === 'ai' && (
          <div className="space-y-2 rounded-md border border-indigo-500/35 bg-indigo-950/20 p-2.5">
            <label className="block space-y-1">
              <span className="text-[11px] font-medium text-slate-300">Theme Style Prompt</span>
              <textarea
                data-testid="uikit-ai-prompt-input"
                rows={2}
                value={aiPrompt}
                onChange={(e) => setAiPrompt(e.target.value)}
                className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1.5 text-xs text-slate-100 focus:border-[#F5B82E] focus:outline-none"
              />
            </label>
            <div className="flex items-center gap-1.5">
              <select
                data-testid="uikit-ai-provider-select"
                value={activeProvider?.id ?? ''}
                onChange={(e) => setSelectedProviderId(e.target.value)}
                className="min-w-0 flex-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200"
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.displayName}
                  </option>
                ))}
              </select>
              <button
                type="button"
                data-testid="uikit-ai-generate-btn"
                disabled={aiBusy}
                onClick={() => void handleGenerateAi()}
                className="inline-flex shrink-0 items-center gap-1 rounded bg-indigo-600 px-2.5 py-1.5 text-[11px] font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3" />
                {aiBusy ? 'Baking...' : 'Generate'}
              </button>
            </div>
            {aiError && (
              <p data-testid="uikit-ai-error" className="text-[11px] text-rose-300">
                {aiError}
              </p>
            )}
          </div>
        )}

        {/* Kit Slug & Reference Tile Size */}
        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-slate-300">
              Theme Slug (res:// folder)
            </span>
            <input
              type="text"
              data-testid="uikit-slug-input"
              value={uiKitConfig.slug}
              onChange={(e) => updateConfig({ slug: e.target.value })}
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 font-mono text-xs text-slate-100 focus:border-[#F5B82E] focus:outline-none"
            />
          </label>

          <div className="space-y-1">
            <span className="block text-[11px] font-medium text-slate-300">Tile Resolution</span>
            <div className="grid grid-cols-3 gap-1">
              {([24, 32, 48] as const).map((sz) => (
                <button
                  key={sz}
                  type="button"
                  data-testid={`uikit-size-${sz}`}
                  onClick={() => updateConfig({ tileSizePx: sz })}
                  className={`rounded border px-2 py-1 font-mono text-[11px] font-medium ${
                    uiKitConfig.tileSizePx === sz
                      ? 'border-[#F5B82E] bg-[#F5B82E]/15 text-[#F5B82E]'
                      : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:text-white'
                  }`}
                >
                  {sz}×{sz}
                </button>
              ))}
            </div>
          </div>
        </div>

        {/* Geometry & Margin ScrubInputs */}
        <div className="space-y-1.5 border-t border-[var(--border-hairline)] pt-2.5">
          <ScrubInput
            label="Border Thickness"
            value={uiKitConfig.borderPx}
            min={1}
            max={3}
            step={1}
            unit="px"
            testId="uikit-border-scrub"
            onChange={(val) =>
              updateConfig({ borderPx: Math.max(1, Math.min(3, Math.round(val))) as 1 | 2 | 3 })
            }
          />
          <ScrubInput
            label="Corner Cut"
            value={uiKitConfig.cornerCutPx}
            min={0}
            max={2}
            step={1}
            unit="px"
            testId="uikit-corner-scrub"
            onChange={(val) =>
              updateConfig({ cornerCutPx: Math.max(0, Math.min(2, Math.round(val))) as 0 | 1 | 2 })
            }
          />
          <ScrubInput
            label="Content Padding"
            value={uiKitConfig.contentMarginPx}
            min={0}
            max={24}
            step={1}
            unit="px"
            testId="uikit-content-margin-scrub"
            onChange={(val) => updateConfig({ contentMarginPx: Math.round(val) })}
          />
          <div className="grid grid-cols-2 gap-1.5 pt-1">
            <ScrubInput
              label="Margin L"
              value={clampedMargins.left}
              min={1}
              max={uiKitConfig.tileSizePx - 2}
              step={1}
              unit="px"
              testId="uikit-margin-left-scrub"
              onChange={(val) =>
                updateConfig({ margins: { ...clampedMargins, left: Math.round(val) } })
              }
            />
            <ScrubInput
              label="Margin R"
              value={clampedMargins.right}
              min={1}
              max={uiKitConfig.tileSizePx - 2}
              step={1}
              unit="px"
              testId="uikit-margin-right-scrub"
              onChange={(val) =>
                updateConfig({ margins: { ...clampedMargins, right: Math.round(val) } })
              }
            />
            <ScrubInput
              label="Margin T"
              value={clampedMargins.top}
              min={1}
              max={uiKitConfig.tileSizePx - 2}
              step={1}
              unit="px"
              testId="uikit-margin-top-scrub"
              onChange={(val) =>
                updateConfig({ margins: { ...clampedMargins, top: Math.round(val) } })
              }
            />
            <ScrubInput
              label="Margin B"
              value={clampedMargins.bottom}
              min={1}
              max={uiKitConfig.tileSizePx - 2}
              step={1}
              unit="px"
              testId="uikit-margin-bottom-scrub"
              onChange={(val) =>
                updateConfig({ margins: { ...clampedMargins, bottom: Math.round(val) } })
              }
            />
          </div>
        </div>

        {/* Art Bible Palette Swatches */}
        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-2.5">
          <div className="flex items-center justify-between">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-slate-300">
              <Palette className="h-3 w-3 text-[#F5B82E]" />
              Theme Colors
            </span>
            <button
              type="button"
              data-testid="uikit-sync-palette-btn"
              onClick={handleSyncPalette}
              className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-0.5 text-[10px] font-medium text-slate-200 hover:border-[#F5B82E]/50"
            >
              Sync Art Bible
            </button>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            {colorControls.map((ctrl) => {
              const hex = rgbTupleToHex(ctrl.value);
              return (
                <label
                  key={ctrl.key}
                  className="flex items-center justify-between rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[10px] text-slate-300"
                >
                  <span>{ctrl.label}</span>
                  <input
                    type="color"
                    data-testid={`uikit-color-${ctrl.key}`}
                    value={hex}
                    onChange={(e) => updateConfig({ [ctrl.key]: hexToRgbTuple(e.target.value) })}
                    className="h-4 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </label>
              );
            })}
          </div>
        </div>

        {/* M24 Bitmap Font Pairing */}
        <div className="space-y-1.5 border-t border-[var(--border-hairline)] pt-2.5">
          <label className="block space-y-1">
            <span className="text-[11px] font-medium text-slate-300">
              Paired M24 Bitmap Font (.fnt)
            </span>
            <select
              data-testid="uikit-font-select"
              value={uiKitConfig.linkedBmFontId ?? ''}
              onChange={(e) =>
                updateConfig({ linkedBmFontId: e.target.value ? e.target.value : undefined })
              }
              className="w-full rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1.5 text-xs text-slate-100 focus:border-[#F5B82E] focus:outline-none"
            >
              <option value="">None (Godot Default Font)</option>
              <option value={BUILTIN_HUD_FONT_ID}>Built-in M24 HUD Font (5×7 Pixel)</option>
              {fontNodes.map((fn) => (
                <option key={fn.id} value={fn.id}>
                  {fn.bitmapFont?.fontName ?? fn.kind} ({fn.bitmapFont?.charsetPreset})
                </option>
              ))}
            </select>
          </label>
        </div>
      </aside>

      {/* Center: Interactive 9-Slice Widget Stage + 7-Slot Strip + Zoomed Guide Canvas */}
      <section className="flex min-h-0 flex-col gap-3 overflow-y-auto bg-[var(--bg-well)] p-4">
        {/* Interactive Godot Widget Sandbox */}
        <div
          data-testid="uikit-live-stage"
          className="flex flex-col items-center justify-center rounded-lg border border-[var(--border-hairline)] bg-[#141418] p-4"
        >
          <div className="mb-3 flex w-full items-center justify-between text-[11px] text-slate-300">
            <span className="font-semibold tracking-wider text-slate-200 uppercase">
              Interactive Godot Theme Sandbox
            </span>
            <div className="flex items-center gap-3">
              <label className="inline-flex cursor-pointer items-center gap-1.5">
                <input
                  type="checkbox"
                  data-testid="uikit-preview-disabled-toggle"
                  checked={previewDisabled}
                  onChange={(e) => setPreviewDisabled(e.target.checked)}
                  className="accent-[#F5B82E]"
                />
                <span>Simulate Disabled</span>
              </label>
              <span
                data-testid="uikit-button-state-badge"
                className="rounded border border-sky-500/40 bg-sky-500/15 px-2 py-0.5 font-mono text-[10px] text-sky-200"
              >
                State: {currentButtonStateLabel}
              </span>
            </div>
          </div>

          <div className="relative flex w-full max-w-[340px] flex-col items-center justify-center p-2">
            <RgbaBufferCanvas
              buffer={panelPreviewBuffer}
              artMode={artMode}
              testId="uikit-panel-canvas"
              className="w-full rounded shadow-lg"
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6">
              <button
                type="button"
                data-testid="uikit-preview-button"
                disabled={previewDisabled}
                onMouseEnter={() => setButtonHovered(true)}
                onMouseLeave={() => {
                  setButtonHovered(false);
                  setButtonPressed(false);
                }}
                onMouseDown={() => !previewDisabled && setButtonPressed(true)}
                onMouseUp={() => setButtonPressed(false)}
                className="relative flex cursor-pointer items-center justify-center rounded focus:outline-none disabled:cursor-not-allowed"
                aria-label="Test 9-slice theme button"
              >
                <RgbaBufferCanvas
                  buffer={buttonPreviewBuffer}
                  artMode={artMode}
                  testId="uikit-button-canvas"
                  overlayFont={linkedFont?.font}
                  overlayLabel={linkedFont ? 'PLAY GAME' : undefined}
                  className="h-[44px] w-[180px]"
                />
                {!linkedFont && (
                  <span
                    className={`pointer-events-none absolute font-mono text-xs font-bold tracking-wider ${
                      previewDisabled ? 'text-slate-400' : 'text-white drop-shadow'
                    }`}
                  >
                    PLAY GAME
                  </span>
                )}
              </button>

              <div data-testid="uikit-preview-progress-wrap" className="w-[220px] space-y-1">
                <div className="flex items-center justify-between font-mono text-[10px] text-slate-200">
                  <span>HP</span>
                  <span>{progressPct}%</span>
                </div>
                <canvas
                  ref={progressCanvasRef}
                  data-testid="uikit-progress-canvas"
                  className="h-[24px] w-[220px]"
                  style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
                />
              </div>
            </div>
          </div>

          <div className="mt-3 w-full max-w-[320px]">
            <ScrubInput
              label="Progress Bar Fill"
              value={progressPct}
              min={0}
              max={100}
              step={1}
              unit="%"
              testId="uikit-progress-scrub"
              onChange={(val) => setProgressPct(Math.round(val))}
            />
          </div>
        </div>

        {/* 7-Slot Atlas Strip & 9-Slice Margin Guide Canvas */}
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_180px]">
          <div className="rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
            <div className="mb-2 flex items-center justify-between text-[11px] text-slate-300">
              <span className="font-semibold text-slate-200">Generated 7-Slot Kit</span>
              <span className="font-mono text-[10px] text-slate-400">
                {activeKit.slots.button_normal.width}×{activeKit.slots.button_normal.height} px
              </span>
            </div>
            <div data-testid="uikit-slot-strip" className="grid grid-cols-4 gap-2 sm:grid-cols-7">
              {ALL_UI_WIDGET_SLOTS.map((slot) => {
                const isSelected = selectedSlot === slot;
                return (
                  <button
                    key={slot}
                    type="button"
                    data-testid={`uikit-slot-${slot}`}
                    onClick={() => setSelectedSlot(slot)}
                    className={`flex flex-col items-center gap-1 rounded border p-1.5 text-[10px] ${
                      isSelected
                        ? 'border-[#F5B82E] bg-[#F5B82E]/10 text-[#F5B82E]'
                        : 'border-[var(--border-hairline)] bg-[var(--bg-well)] text-slate-300 hover:border-slate-500'
                    }`}
                  >
                    <RgbaBufferCanvas
                      buffer={activeKit.slots[slot]}
                      artMode={artMode}
                      className="h-10 w-10"
                    />
                    <span className="truncate font-medium">{SLOT_LABELS[slot]}</span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-col items-center justify-center rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3">
            <span className="mb-1.5 font-mono text-[10px] text-sky-300">
              9-Slice Guides ({SLOT_LABELS[selectedSlot]})
            </span>
            <RgbaBufferCanvas
              buffer={activeKit.slots[selectedSlot]}
              artMode={artMode}
              guideMargins={activeKit.margins}
              testId="uikit-margin-overlay-canvas"
              className="h-28 w-28 rounded border border-[var(--border-hairline)] bg-checkerboard"
            />
          </div>
        </div>
      </section>

      {/* Right: Godot 4 Theme .tres Inspector & 1-Click Sync / ZIP Export */}
      <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto border-l border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3.5">
        <div className="flex items-center justify-between">
          <h4 className="font-mono text-xs font-semibold text-slate-200">{safeSlug}_theme.tres</h4>
          <button
            type="button"
            data-testid="uikit-copy-tres-btn"
            onClick={() => void handleCopyTres()}
            className="inline-flex items-center gap-1 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] font-medium text-slate-200 hover:border-[#F5B82E]/50"
          >
            {copiedTres ? (
              <>
                <Check className="h-3 w-3 text-emerald-400" />
                Copied
              </>
            ) : (
              <>
                <Copy className="h-3 w-3" />
                Copy .tres
              </>
            )}
          </button>
        </div>

        <pre
          data-testid="uikit-tres-preview"
          className="min-h-0 flex-1 overflow-auto rounded-md border border-[var(--border-hairline)] bg-[var(--bg-well)] p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre text-slate-200"
        >
          {tresPreview}
        </pre>

        <div className="space-y-2 border-t border-[var(--border-hairline)] pt-3">
          <button
            type="button"
            data-testid="uikit-save-btn"
            disabled={saving}
            onClick={() => void handleSave()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving Theme...' : 'Save UI Kit to Project'}
          </button>

          <button
            type="button"
            data-testid="uikit-sync-godot-btn"
            disabled={syncing}
            onClick={() => void handleSyncToGodot()}
            className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[#F5B82E]/45 bg-[#F5B82E]/10 px-3 py-2 text-xs font-semibold text-[#F5B82E] hover:bg-[#F5B82E]/20 disabled:opacity-50"
          >
            <FolderSync className="h-3.5 w-3.5" />
            {syncing ? 'Syncing...' : 'Sync to Godot (res://)'}
          </button>

          <button
            type="button"
            data-testid="uikit-download-zip-btn"
            onClick={handleDownloadZip}
            className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#F5B82E] px-3 py-2 text-xs font-semibold text-zinc-950 hover:bg-[#fbcb57]"
          >
            <FileArchive className="h-3.5 w-3.5" />
            Download Theme Bundle (.zip)
          </button>

          {statusNotice && (
            <p data-testid="uikit-status-notice" className="text-[11px] text-emerald-300">
              {statusNotice}
            </p>
          )}
          {errorNotice && (
            <p data-testid="uikit-error-notice" className="text-[11px] text-rose-300">
              {errorNotice}
            </p>
          )}
        </div>
      </aside>
    </div>
  );
}
