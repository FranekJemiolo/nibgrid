import { sha256Bytes } from './hash';
import { getBuiltInGlyphMask } from './pixelGlyphTable';
import type { RgbaBuffer } from './types';

export interface QaSpriteEntry {
  readonly spriteId: string;
  readonly slug: string;
  readonly isGoldenRef?: boolean;
  readonly buffer: RgbaBuffer;
}

export interface QaContactSheetCell {
  readonly indexLabel: string; // "REF" or "01", "02", ...
  readonly spriteId: string;
  readonly slug: string;
  readonly cellX: number;
  readonly cellY: number;
  readonly cellSizePx: number;
}

export interface QaContactSheetResult {
  readonly sheet: RgbaBuffer;
  readonly cells: readonly QaContactSheetCell[];
  /** Deterministic manifest mapping indexLabel -> spriteId */
  readonly indexToSpriteId: Readonly<Record<string, string>>;
}

export interface QaContactSheetOptions {
  readonly cellSizePx?: number; // default 128
  readonly cols?: number; // default 4
  readonly paddingPx?: number; // default 8
  /** Neutral mid-gray backdrop so both dark and light outlines read clearly */
  readonly bgRgb?: readonly [number, number, number]; // default [128, 128, 128]
}

function blendPixelOver(
  dst: Uint8ClampedArray,
  dstIdx: number,
  sr: number,
  sg: number,
  sb: number,
  sa: number,
): void {
  if (sa <= 0) return;
  if (sa >= 255) {
    dst[dstIdx] = sr;
    dst[dstIdx + 1] = sg;
    dst[dstIdx + 2] = sb;
    dst[dstIdx + 3] = 255;
    return;
  }
  const a = sa / 255;
  const invA = 1 - a;
  dst[dstIdx] = Math.round(sr * a + (dst[dstIdx] ?? 0) * invA);
  dst[dstIdx + 1] = Math.round(sg * a + (dst[dstIdx + 1] ?? 0) * invA);
  dst[dstIdx + 2] = Math.round(sb * a + (dst[dstIdx + 2] ?? 0) * invA);
  dst[dstIdx + 3] = 255;
}

function fillRect(
  buf: RgbaBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: readonly [number, number, number, number],
): void {
  const x0 = Math.max(0, Math.floor(x));
  const y0 = Math.max(0, Math.floor(y));
  const x1 = Math.min(buf.width, Math.floor(x + w));
  const y1 = Math.min(buf.height, Math.floor(y + h));
  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const idx = (py * buf.width + px) * 4;
      buf.data[idx] = rgba[0];
      buf.data[idx + 1] = rgba[1];
      buf.data[idx + 2] = rgba[2];
      buf.data[idx + 3] = rgba[3];
    }
  }
}

function strokeRectBorder(
  buf: RgbaBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
  rgba: readonly [number, number, number, number],
): void {
  fillRect(buf, x, y, w, 1, rgba);
  fillRect(buf, x, y + h - 1, w, 1, rgba);
  fillRect(buf, x, y, 1, h, rgba);
  fillRect(buf, x + w - 1, y, 1, h, rgba);
}

/** Stamps crisp pure-TS 5x7 monochrome badge text (`REF`, `01`..`15`) using M24's glyph table. */
function stampBadgeText(
  sheet: RgbaBuffer,
  cellX: number,
  cellY: number,
  label: string,
  isRef: boolean,
): void {
  const scale = 1;
  const textWidth = Math.max(0, label.length * 6 * scale - 1);
  const badgeW = textWidth + 6;
  const badgeH = 7 * scale + 4;
  const bx = cellX + 2;
  const by = cellY + 2;

  fillRect(
    sheet,
    bx,
    by,
    badgeW,
    badgeH,
    isRef ? ([245, 184, 46, 255] as const) : ([24, 24, 27, 255] as const),
  );

  const fg = isRef ? ([18, 18, 20, 255] as const) : ([244, 244, 245, 255] as const);
  let cursorX = bx + 3;
  const cursorY = by + 2;

  for (const ch of label) {
    const mask = getBuiltInGlyphMask(ch);
    for (let gy = 0; gy < mask.height; gy++) {
      for (let gx = 0; gx < mask.width; gx++) {
        if ((mask.alpha[gy * mask.width + gx] ?? 0) === 0) continue;
        const px = cursorX + gx;
        const py = cursorY + gy;
        if (px < 0 || px >= sheet.width || py < 0 || py >= sheet.height) continue;
        const idx = (py * sheet.width + px) * 4;
        sheet.data[idx] = fg[0];
        sheet.data[idx + 1] = fg[1];
        sheet.data[idx + 2] = fg[2];
        sheet.data[idx + 3] = fg[3];
      }
    }
    cursorX += mask.xadvance * scale;
  }
}

function blitSpriteFit(
  sheet: RgbaBuffer,
  sprite: RgbaBuffer,
  dstX: number,
  dstY: number,
  dstW: number,
  dstH: number,
): void {
  if (sprite.width <= 0 || sprite.height <= 0 || dstW <= 0 || dstH <= 0) return;
  const scale = Math.min(dstW / sprite.width, dstH / sprite.height);
  const intScale = scale >= 1 ? Math.max(1, Math.floor(scale)) : scale;
  const renderW = Math.max(1, Math.round(sprite.width * intScale));
  const renderH = Math.max(1, Math.round(sprite.height * intScale));
  const offsetX = dstX + Math.floor((dstW - renderW) / 2);
  const offsetY = dstY + Math.floor((dstH - renderH) / 2);

  for (let ry = 0; ry < renderH; ry++) {
    const py = offsetY + ry;
    if (py < 0 || py >= sheet.height) continue;
    const sy = Math.min(sprite.height - 1, Math.floor((ry * sprite.height) / renderH));
    for (let rx = 0; rx < renderW; rx++) {
      const px = offsetX + rx;
      if (px < 0 || px >= sheet.width) continue;
      const sx = Math.min(sprite.width - 1, Math.floor((rx * sprite.width) / renderW));
      const sIdx = (sy * sprite.width + sx) * 4;
      const dIdx = (py * sheet.width + px) * 4;
      blendPixelOver(
        sheet.data,
        dIdx,
        sprite.data[sIdx] ?? 0,
        sprite.data[sIdx + 1] ?? 0,
        sprite.data[sIdx + 2] ?? 0,
        sprite.data[sIdx + 3] ?? 0,
      );
    }
  }
}

function blitSilhouetteCorner(
  sheet: RgbaBuffer,
  sprite: RgbaBuffer,
  cellX: number,
  cellY: number,
  cellSizePx: number,
): void {
  if (sprite.width <= 0 || sprite.height <= 0) return;
  const thumbSize = Math.max(14, Math.min(28, Math.floor(cellSizePx * 0.22)));
  const boxX = cellX + cellSizePx - thumbSize - 3;
  const boxY = cellY + cellSizePx - thumbSize - 3;
  fillRect(sheet, boxX, boxY, thumbSize, thumbSize, [228, 228, 231, 255]);
  strokeRectBorder(sheet, boxX, boxY, thumbSize, thumbSize, [39, 39, 42, 255]);

  const inner = Math.max(4, thumbSize - 4);
  const scale = Math.min(inner / sprite.width, inner / sprite.height);
  const renderW = Math.max(1, Math.round(sprite.width * scale));
  const renderH = Math.max(1, Math.round(sprite.height * scale));
  const offX = boxX + Math.floor((thumbSize - renderW) / 2);
  const offY = boxY + Math.floor((thumbSize - renderH) / 2);

  for (let ry = 0; ry < renderH; ry++) {
    const py = offY + ry;
    if (py < 0 || py >= sheet.height) continue;
    const sy = Math.min(sprite.height - 1, Math.floor((ry * sprite.height) / renderH));
    for (let rx = 0; rx < renderW; rx++) {
      const px = offX + rx;
      if (px < 0 || px >= sheet.width) continue;
      const sx = Math.min(sprite.width - 1, Math.floor((rx * sprite.width) / renderW));
      const alpha = sprite.data[(sy * sprite.width + sx) * 4 + 3] ?? 0;
      if (alpha > 16) {
        const dIdx = (py * sheet.width + px) * 4;
        sheet.data[dIdx] = 24;
        sheet.data[dIdx + 1] = 24;
        sheet.data[dIdx + 2] = 27;
        sheet.data[dIdx + 3] = 255;
      }
    }
  }
}

/**
 * Pure-TS deterministic QA contact sheet packer:
 * - Places `isGoldenRef === true` in cell 0 (`REF`) on every paginated sheet.
 * - Sorts remaining sprites by `slug`, then `spriteId`.
 * - Packs up to `16` cells per sheet (`cols` default 4, `cellSizePx` default 128, `#808080` mid-gray).
 * - Stamps `REF` / `01`..`15` index badges via M24's 5x7 glyph table and renders bottom-right silhouette previews.
 */
export function packQaContactSheets(
  entries: readonly QaSpriteEntry[],
  opts: QaContactSheetOptions = {},
): readonly QaContactSheetResult[] {
  const cellSizePx = Math.max(32, Math.min(256, Math.round(opts.cellSizePx ?? 128)));
  const cols = Math.max(1, Math.min(8, Math.round(opts.cols ?? 4)));
  const paddingPx = Math.max(2, Math.min(32, Math.round(opts.paddingPx ?? 8)));
  const bgRgb = opts.bgRgb ?? ([128, 128, 128] as const);

  if (entries.length === 0) return [];

  const goldenRef = entries.find((e) => e.isGoldenRef);
  const projectSprites = entries
    .filter((e) => e !== goldenRef)
    .slice()
    .sort((a, b) => a.slug.localeCompare(b.slug) || a.spriteId.localeCompare(b.spriteId));

  const spritesPerPage = goldenRef ? 15 : 16;
  const pageCount = Math.max(1, Math.ceil(projectSprites.length / spritesPerPage));
  const pages: QaContactSheetResult[] = [];

  for (let p = 0; p < pageCount; p++) {
    const slice = projectSprites.slice(p * spritesPerPage, (p + 1) * spritesPerPage);
    const pageItems: Array<{ label: string; entry: QaSpriteEntry; isRef: boolean }> = [];

    if (goldenRef) {
      pageItems.push({ label: 'REF', entry: goldenRef, isRef: true });
    }
    slice.forEach((entry, idx) => {
      const label = String(idx + 1).padStart(2, '0');
      pageItems.push({ label, entry, isRef: false });
    });

    const totalCells = pageItems.length;
    const rows = Math.max(1, Math.ceil(totalCells / cols));
    const sheetW = paddingPx + cols * (cellSizePx + paddingPx);
    const sheetH = paddingPx + rows * (cellSizePx + paddingPx);
    const sheetData = new Uint8ClampedArray(sheetW * sheetH * 4);
    for (let i = 0; i < sheetW * sheetH; i++) {
      const px = i * 4;
      sheetData[px] = bgRgb[0];
      sheetData[px + 1] = bgRgb[1];
      sheetData[px + 2] = bgRgb[2];
      sheetData[px + 3] = 255;
    }

    const sheet: RgbaBuffer = { width: sheetW, height: sheetH, data: sheetData };
    const cells: QaContactSheetCell[] = [];
    const indexToSpriteId: Record<string, string> = {};

    pageItems.forEach((item, cellIdx) => {
      const col = cellIdx % cols;
      const row = Math.floor(cellIdx / cols);
      const cellX = paddingPx + col * (cellSizePx + paddingPx);
      const cellY = paddingPx + row * (cellSizePx + paddingPx);

      strokeRectBorder(
        sheet,
        cellX,
        cellY,
        cellSizePx,
        cellSizePx,
        item.isRef ? ([245, 184, 46, 255] as const) : ([42, 42, 46, 255] as const),
      );

      const spriteAreaPadTop = 14;
      const spriteAreaPadSide = 6;
      const fitW = Math.max(8, cellSizePx - spriteAreaPadSide * 2);
      const fitH = Math.max(8, cellSizePx - spriteAreaPadTop - spriteAreaPadSide);
      blitSpriteFit(
        sheet,
        item.entry.buffer,
        cellX + spriteAreaPadSide,
        cellY + spriteAreaPadTop,
        fitW,
        fitH,
      );

      blitSilhouetteCorner(sheet, item.entry.buffer, cellX, cellY, cellSizePx);
      stampBadgeText(sheet, cellX, cellY, item.label, item.isRef);

      indexToSpriteId[item.label] = item.entry.spriteId;
      cells.push({
        indexLabel: item.label,
        spriteId: item.entry.spriteId,
        slug: item.entry.slug,
        cellX,
        cellY,
        cellSizePx,
      });
    });

    pages.push({ sheet, cells, indexToSpriteId });
  }

  return pages;
}

/** Computes a deterministic SHA-256 cache digest across all packed QA contact sheets + ArtBible hash. */
export async function computeQaSheetHash(
  sheets: readonly QaContactSheetResult[],
  artBibleHash: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const metaChunks: Uint8Array[] = [encoder.encode(`bible:${artBibleHash}|pages:${sheets.length}`)];
  for (let i = 0; i < sheets.length; i++) {
    const page = sheets[i]!;
    const cellManifest = page.cells.map((c) => `${c.indexLabel}:${c.spriteId}:${c.slug}`).join(',');
    metaChunks.push(
      encoder.encode(`|p${i}:${page.sheet.width}x${page.sheet.height}:${cellManifest}|`),
    );
    metaChunks.push(
      new Uint8Array(
        page.sheet.data.buffer,
        page.sheet.data.byteOffset,
        page.sheet.data.byteLength,
      ),
    );
  }
  const totalBytes = metaChunks.reduce((acc, part) => acc + part.byteLength, 0);
  const combined = new Uint8Array(totalBytes);
  let offset = 0;
  for (const part of metaChunks) {
    combined.set(part, offset);
    offset += part.byteLength;
  }
  return sha256Bytes(combined);
}
