import { strToU8, zipSync } from 'fflate';
import type { BakedBitmapFont } from '../processing/bitmapFont';
import { encodeRgbaToPngBytes } from '../processing/png';
import { AssetRecipeSchema, type AssetRecipe } from './recipeBuilder';

export interface BmFontExportOptions {
  readonly paddingPx?: number;
  readonly sizePx?: number;
}

function escapeFntQuoted(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function sanitizeInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.round(value);
}

/**
 * Serializes a baked bitmap font atlas and glyph metrics into standard AngelCode `.fnt` text format,
 * directly importable by Godot 4 (`FontFile`) and PixiJS.
 */
export function exportBmFontText(
  font: BakedBitmapFont,
  pngFilename: string,
  opts: BmFontExportOptions = {},
): string {
  const pad = Math.max(0, sanitizeInt(opts.paddingPx ?? 1, 1));
  const size = Math.max(1, sanitizeInt(opts.sizePx ?? font.base, font.base));
  const face = escapeFntQuoted(font.fontName || 'nibgrid_font');
  const file = escapeFntQuoted(pngFilename);

  const lines: string[] = [
    `info face="${face}" size=${size} bold=0 italic=0 charset="" unicode=1 stretchH=100 smooth=0 aa=1 padding=${pad},${pad},${pad},${pad} spacing=1,1`,
    `common lineHeight=${Math.max(1, sanitizeInt(font.lineHeight, size + 2))} base=${Math.max(1, sanitizeInt(font.base, size))} scaleW=${font.atlas.width} scaleH=${font.atlas.height} pages=1 packed=0`,
    `page id=0 file="${file}"`,
    `chars count=${font.glyphs.length}`,
  ];

  for (const g of font.glyphs) {
    lines.push(
      `char id=${g.id} x=${g.x} y=${g.y} width=${g.width} height=${g.height} xoffset=${g.xoffset} yoffset=${g.yoffset} xadvance=${g.xadvance} page=0 chnl=15`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Serializes a baked bitmap font atlas and glyph metrics into standard AngelCode `.xml` format
 * for Phaser 3 (`this.load.bitmapFont`) and PixiJS.
 */
export function exportBmFontXml(
  font: BakedBitmapFont,
  pngFilename: string,
  opts: BmFontExportOptions = {},
): string {
  const pad = Math.max(0, sanitizeInt(opts.paddingPx ?? 1, 1));
  const size = Math.max(1, sanitizeInt(opts.sizePx ?? font.base, font.base));
  const face = escapeXmlAttr(font.fontName || 'nibgrid_font');
  const file = escapeXmlAttr(pngFilename);

  const lines: string[] = [
    '<?xml version="1.0"?>',
    '<font>',
    `  <info face="${face}" size="${size}" bold="0" italic="0" charset="" unicode="1" stretchH="100" smooth="0" aa="1" padding="${pad},${pad},${pad},${pad}" spacing="1,1"/>`,
    `  <common lineHeight="${Math.max(1, sanitizeInt(font.lineHeight, size + 2))}" base="${Math.max(1, sanitizeInt(font.base, size))}" scaleW="${font.atlas.width}" scaleH="${font.atlas.height}" pages="1" packed="0"/>`,
    '  <pages>',
    `    <page id="0" file="${file}"/>`,
    '  </pages>',
    `  <chars count="${font.glyphs.length}">`,
  ];

  for (const g of font.glyphs) {
    lines.push(
      `    <char id="${g.id}" x="${g.x}" y="${g.y}" width="${g.width}" height="${g.height}" xoffset="${g.xoffset}" yoffset="${g.yoffset}" xadvance="${g.xadvance}" page="0" chnl="15"/>`,
    );
  }

  lines.push('  </chars>', '</font>', '');
  return lines.join('\n');
}

/**
 * Encodes `<slug>.png`, `<slug>.fnt`, and `<slug>.xml` ready for ZIP packaging or disk export.
 */
export function buildBmFontExportFiles(
  slug: string,
  font: BakedBitmapFont,
  opts: BmFontExportOptions = {},
): Record<string, Uint8Array> {
  const safeSlug = slug || 'nibgrid_font';
  const pngFilename = `${safeSlug}.png`;
  return {
    [pngFilename]: encodeRgbaToPngBytes(font.atlas.data, font.atlas.width, font.atlas.height),
    [`${safeSlug}.fnt`]: strToU8(exportBmFontText(font, pngFilename, opts)),
    [`${safeSlug}.xml`]: strToU8(exportBmFontXml(font, pngFilename, opts)),
  };
}

export interface PackageBmFontZipParams {
  readonly slug: string;
  readonly font: BakedBitmapFont;
  readonly recipe: AssetRecipe;
  readonly paddingPx?: number;
  readonly sizePx?: number;
}

/**
 * Packages `<slug>.png`, `<slug>.fnt`, `<slug>.xml`, and strictly Zod-validated `<slug>.recipe.json`.
 */
export function packageBmFontZip(params: PackageBmFontZipParams): Uint8Array {
  const safeSlug = params.slug || 'nibgrid_font';
  const validatedRecipe = AssetRecipeSchema.parse(params.recipe);
  const files: Record<string, Uint8Array> = {
    ...buildBmFontExportFiles(safeSlug, params.font, {
      paddingPx: params.paddingPx,
      sizePx: params.sizePx,
    }),
    [`${safeSlug}.recipe.json`]: strToU8(`${JSON.stringify(validatedRecipe, null, 2)}\n`),
  };
  return zipSync(files, { level: 6 });
}
