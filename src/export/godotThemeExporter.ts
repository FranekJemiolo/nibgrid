import { strToU8, zipSync } from 'fflate';
import { normalizeResSubpath, sanitizeEntitySlug } from '../domain/entitySchema';
import type { BitmapFontConfig } from '../domain/schemas';
import { parseHexRgb } from '../processing/backgroundKey';
import {
  CHARSET_PRESETS,
  bakeBitmapFontAtlas,
  buildBuiltInGlyphMasks,
  type BakedBitmapFont,
} from '../processing/bitmapFont';
import { encodeRgbaToPngBytes } from '../processing/png';
import {
  ALL_UI_WIDGET_SLOTS,
  clampNineSliceMargins,
  type BakedUiKit,
  type NineSliceMargins,
  type UiWidgetSlot,
} from '../processing/uiKitCore';
import { exportBmFontText } from './bmfontExporter';
import { generateGodotPngImport, type VirtualSyncFile } from './godotPrefabAssembler';
import { AssetRecipeSchema, type AssetRecipe } from './recipeBuilder';

export interface GodotThemeTresInput {
  readonly slug: string;
  readonly resSubpath?: string;
  readonly margins: NineSliceMargins;
  readonly contentMarginPx: number;
  readonly linkedFontFilename?: string;
  readonly referenceTileSize?: number;
}

const SLOT_EXT_IDS: Record<UiWidgetSlot, { readonly extId: string; readonly subId: string }> = {
  button_normal: { extId: '1_btn_n', subId: 'StyleBoxTexture_btn_n' },
  button_hover: { extId: '2_btn_h', subId: 'StyleBoxTexture_btn_h' },
  button_pressed: { extId: '3_btn_p', subId: 'StyleBoxTexture_btn_p' },
  button_disabled: { extId: '4_btn_d', subId: 'StyleBoxTexture_btn_d' },
  panel_bg: { extId: '5_pnl', subId: 'StyleBoxTexture_pnl' },
  bar_track: { extId: '6_bar_t', subId: 'StyleBoxTexture_bar_t' },
  bar_fill: { extId: '7_bar_f', subId: 'StyleBoxTexture_bar_f' },
};

function fmtFloat(n: number): string {
  const clean = Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  return `${clean}.0`;
}

/**
 * Pure-TS Godot 4 `Theme` (`.tres`, `format=3`) serializer with exact `load_steps`,
 * 7 `StyleBoxTexture` sub-resources, and optional M24 `FontFile` pairing.
 */
export function exportGodotThemeTres(input: GodotThemeTresInput): string {
  const safeSlug = sanitizeEntitySlug(input.slug || 'ui_rpg');
  const subpath = normalizeResSubpath(input.resSubpath ?? `assets/nibgrid/${safeSlug}`);
  const refSize = Math.max(8, Math.round(input.referenceTileSize ?? 32));
  const clampedMargins = clampNineSliceMargins(input.margins, refSize, refSize);
  const contentMargin = Math.max(0, Math.min(24, Math.round(input.contentMarginPx)));
  const linkedFont = input.linkedFontFilename?.trim() || undefined;

  const extCount = ALL_UI_WIDGET_SLOTS.length + (linkedFont ? 1 : 0);
  const subCount = ALL_UI_WIDGET_SLOTS.length;
  const loadSteps = extCount + subCount + 1;

  const lines: string[] = [`[gd_resource type="Theme" load_steps=${loadSteps} format=3]`, ''];

  for (const slot of ALL_UI_WIDGET_SLOTS) {
    const ids = SLOT_EXT_IDS[slot];
    lines.push(
      `[ext_resource type="Texture2D" path="res://${subpath}/${slot}.png" id="${ids.extId}"]`,
    );
  }
  if (linkedFont) {
    lines.push(`[ext_resource type="FontFile" path="res://${subpath}/${linkedFont}" id="8_font"]`);
  }
  lines.push('');

  for (const slot of ALL_UI_WIDGET_SLOTS) {
    const ids = SLOT_EXT_IDS[slot];
    lines.push(`[sub_resource type="StyleBoxTexture" id="${ids.subId}"]`);
    lines.push(`texture = ExtResource("${ids.extId}")`);
    lines.push(`texture_margin_left = ${fmtFloat(clampedMargins.left)}`);
    lines.push(`texture_margin_top = ${fmtFloat(clampedMargins.top)}`);
    lines.push(`texture_margin_right = ${fmtFloat(clampedMargins.right)}`);
    lines.push(`texture_margin_bottom = ${fmtFloat(clampedMargins.bottom)}`);
    lines.push(`content_margin_left = ${fmtFloat(contentMargin)}`);
    lines.push(`content_margin_top = ${fmtFloat(Math.max(2, contentMargin - 2))}`);
    lines.push(`content_margin_right = ${fmtFloat(contentMargin)}`);
    lines.push(`content_margin_bottom = ${fmtFloat(Math.max(2, contentMargin - 2))}`);
    lines.push('axis_stretch_horizontal = 1');
    lines.push('axis_stretch_vertical = 1');
    lines.push('');
  }

  lines.push('[resource]');
  if (linkedFont) {
    lines.push('default_font = ExtResource("8_font")');
  }
  lines.push(`Button/styles/normal = SubResource("${SLOT_EXT_IDS.button_normal.subId}")`);
  lines.push(`Button/styles/hover = SubResource("${SLOT_EXT_IDS.button_hover.subId}")`);
  lines.push(`Button/styles/pressed = SubResource("${SLOT_EXT_IDS.button_pressed.subId}")`);
  lines.push(`Button/styles/disabled = SubResource("${SLOT_EXT_IDS.button_disabled.subId}")`);
  lines.push(`PanelContainer/styles/panel = SubResource("${SLOT_EXT_IDS.panel_bg.subId}")`);
  lines.push(`ProgressBar/styles/background = SubResource("${SLOT_EXT_IDS.bar_track.subId}")`);
  lines.push(`ProgressBar/styles/fill = SubResource("${SLOT_EXT_IDS.bar_fill.subId}")`);
  lines.push('');

  return lines.join('\n');
}

export interface AssembleGodotUiKitOptions {
  readonly resSubpath?: string;
  readonly isPixelArt?: boolean;
  readonly linkedFont?: {
    readonly filenameBase: string;
    readonly font: BakedBitmapFont;
  };
}

/**
 * Emits all virtual sync files for a UI Kit (`7 PNGs`, `7 .png.import` sidecars,
 * optional linked M24 `.fnt` + `.png` + `.png.import`, and `<slug>_theme.tres`).
 */
export function assembleGodotUiKitFiles(
  kit: BakedUiKit,
  opts: AssembleGodotUiKitOptions = {},
): readonly VirtualSyncFile[] {
  const safeSlug = sanitizeEntitySlug(kit.slug || 'ui_rpg');
  const subpath = normalizeResSubpath(opts.resSubpath ?? `assets/nibgrid/${safeSlug}`);
  const isPixelArt = opts.isPixelArt ?? true;
  const files: VirtualSyncFile[] = [];

  for (const slot of ALL_UI_WIDGET_SLOTS) {
    const buf = kit.slots[slot];
    const pngRel = `${subpath}/${slot}.png`;
    files.push({
      relativePath: pngRel,
      content: encodeRgbaToPngBytes(buf.data, buf.width, buf.height),
    });
    files.push({
      relativePath: `${pngRel}.import`,
      content: generateGodotPngImport(`res://${pngRel}`, isPixelArt),
    });
  }

  let linkedFontFilename: string | undefined;
  if (opts.linkedFont) {
    const fontBase = sanitizeEntitySlug(
      opts.linkedFont.filenameBase || opts.linkedFont.font.fontName || 'hud_font',
    );
    const fontPngName = `${fontBase}.png`;
    const fontFntName = `${fontBase}.fnt`;
    const fontPngRel = `${subpath}/${fontPngName}`;
    files.push({
      relativePath: fontPngRel,
      content: encodeRgbaToPngBytes(
        opts.linkedFont.font.atlas.data,
        opts.linkedFont.font.atlas.width,
        opts.linkedFont.font.atlas.height,
      ),
    });
    files.push({
      relativePath: `${fontPngRel}.import`,
      content: generateGodotPngImport(`res://${fontPngRel}`, isPixelArt),
    });
    files.push({
      relativePath: `${subpath}/${fontFntName}`,
      content: exportBmFontText(opts.linkedFont.font, fontPngName),
    });
    linkedFontFilename = fontFntName;
  }

  files.push({
    relativePath: `${subpath}/${safeSlug}_theme.tres`,
    content: exportGodotThemeTres({
      slug: safeSlug,
      resSubpath: subpath,
      margins: kit.margins,
      contentMarginPx: kit.contentMarginPx,
      linkedFontFilename,
      referenceTileSize: kit.slots.button_normal.width,
    }),
  });

  return files;
}

/**
 * Deterministically bakes an M24 `BitmapFontConfig` on CPU so UI Kit ZIPs and M25 syncs
 * can bundle `<font>.fnt` + `<font>.png` directly from stored node config.
 */
export function bakeBitmapFontFromConfig(
  cfg: BitmapFontConfig,
  paletteHex: readonly string[] = [],
): BakedBitmapFont {
  const charset =
    cfg.charsetPreset === 'custom' ? cfg.customCharset : CHARSET_PRESETS[cfg.charsetPreset];
  const top = parseHexRgb(cfg.topHex);
  const bottom = parseHexRgb(cfg.bottomHex);
  const outline = parseHexRgb(cfg.outlineHex);
  const shadow = parseHexRgb(cfg.shadowHex);
  return bakeBitmapFontAtlas(buildBuiltInGlyphMasks(charset), {
    fontName: cfg.fontName,
    scale: cfg.scale,
    topRgb: [top.r, top.g, top.b],
    bottomRgb: [bottom.r, bottom.g, bottom.b],
    paletteHex,
    snapToPalette: cfg.snapToPalette,
    outlineMode: cfg.outlineMode,
    selOutDarken: cfg.selOutDarken,
    ...(cfg.useCustomOutline ? { outlineRgb: [outline.r, outline.g, outline.b] as const } : {}),
    shadowOffsetX: cfg.shadowOffsetX,
    shadowOffsetY: cfg.shadowOffsetY,
    shadowRgb: [shadow.r, shadow.g, shadow.b],
    shadowAlpha: cfg.shadowAlpha,
    letterSpacingPx: cfg.letterSpacingPx,
    paddingPx: cfg.paddingPx,
  });
}

export interface PackageUiKitThemeZipParams {
  readonly kit: BakedUiKit;
  readonly recipe: AssetRecipe;
  readonly isPixelArt?: boolean;
  readonly linkedFont?: {
    readonly filenameBase: string;
    readonly font: BakedBitmapFont;
  };
}

/**
 * Packages `<slug>` UI Kit PNGs, `.png.import` sidecars, optional linked `.fnt`+`.png`,
 * `<slug>_theme.tres`, and Zod-validated `<slug>.recipe.json` into one `.zip` archive.
 */
export function packageUiKitThemeZip(params: PackageUiKitThemeZipParams): Uint8Array {
  const safeSlug = sanitizeEntitySlug(params.kit.slug || 'ui_rpg');
  const validatedRecipe = AssetRecipeSchema.parse(params.recipe);
  const virtualFiles = assembleGodotUiKitFiles(params.kit, {
    resSubpath: `assets/nibgrid/${safeSlug}`,
    isPixelArt: params.isPixelArt ?? true,
    ...(params.linkedFont ? { linkedFont: params.linkedFont } : {}),
  });

  const zipMap: Record<string, Uint8Array> = {};
  for (const file of virtualFiles) {
    const filename = file.relativePath.split('/').pop() ?? file.relativePath;
    zipMap[filename] = typeof file.content === 'string' ? strToU8(file.content) : file.content;
  }
  zipMap[`${safeSlug}.recipe.json`] = strToU8(JSON.stringify(validatedRecipe, null, 2));

  return zipSync(zipMap, { level: 6 });
}
