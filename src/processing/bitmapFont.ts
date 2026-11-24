import { parseHexRgb } from './backgroundKey';
import {
  CHARSET_PRESETS,
  buildBuiltInGlyphMasks,
  getBuiltInGlyphMask,
  type FontCharsetPreset,
  type GlyphMask,
} from './pixelGlyphTable';
import { oklabToRgb, rgbToOklab } from './selOut';
import type { Oklab, Rgb, RgbaBuffer } from './types';

export {
  CHARSET_PRESETS,
  buildBuiltInGlyphMasks,
  getBuiltInGlyphMask,
  type FontCharsetPreset,
  type GlyphMask,
};

export interface BitmapFontStyleOptions {
  readonly fontName: string;
  /** Integer pixel scale multiplier (1..4, default 2) */
  readonly scale: number;
  readonly topRgb: readonly [number, number, number];
  readonly bottomRgb: readonly [number, number, number];
  /** Optional Art Bible palette hexes to snap fill colors */
  readonly paletteHex?: readonly string[];
  readonly snapToPalette?: boolean;
  /** 0 = none, 1 = 4-connected outline, 2 = 8-connected bold outline */
  readonly outlineMode: 0 | 1 | 2;
  /** OKLab darken factor for Sel-Out outline (0.1..0.95, default 0.55) */
  readonly selOutDarken: number;
  /** Optional explicit outline RGB (overrides Sel-Out if provided) */
  readonly outlineRgb?: readonly [number, number, number];
  readonly shadowOffsetX: number;
  readonly shadowOffsetY: number;
  readonly shadowRgb: readonly [number, number, number];
  readonly shadowAlpha: number; // 0..255
  readonly letterSpacingPx: number;
  readonly paddingPx: number;
}

export interface PackedGlyphMetric {
  readonly id: number;
  readonly char: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly xoffset: number;
  readonly yoffset: number;
  readonly xadvance: number;
}

export interface BakedBitmapFont {
  readonly fontName: string;
  readonly lineHeight: number;
  readonly base: number;
  readonly atlas: RgbaBuffer;
  readonly glyphs: readonly PackedGlyphMetric[];
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function rec709Luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

interface PaletteLabEntry {
  readonly rgb: Rgb;
  readonly lab: Oklab;
  readonly luma: number;
}

function buildPaletteLabEntries(paletteHex?: readonly string[]): PaletteLabEntry[] {
  if (!paletteHex || paletteHex.length === 0) return [];
  return paletteHex.map((hex) => {
    const rgb = parseHexRgb(hex);
    return {
      rgb,
      lab: rgbToOklab(rgb),
      luma: rec709Luma(rgb.r, rgb.g, rgb.b),
    };
  });
}

function snapRgbToPalette(
  r: number,
  g: number,
  b: number,
  entries: readonly PaletteLabEntry[],
): Rgb {
  if (entries.length === 0) return { r, g, b };
  const targetLab = rgbToOklab({ r, g, b });
  let best = entries[0]!;
  let bestDist = Infinity;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i]!;
    const dL = targetLab.L - e.lab.L;
    const da = targetLab.a - e.lab.a;
    const db = targetLab.b - e.lab.b;
    const dist = dL * dL + da * da + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = e;
    }
  }
  return best.rgb;
}

function computeSelOutRgb(
  fillR: number,
  fillG: number,
  fillB: number,
  selOutDarken: number,
): readonly [number, number, number] {
  const darken = clampFloat(selOutDarken, 0.1, 0.95, 0.55);
  const fillLuma = rec709Luma(fillR, fillG, fillB);
  if (fillLuma <= 0) {
    return [0, 0, 0];
  }

  const lab = rgbToOklab({ r: fillR, g: fillG, b: fillB });
  const shifted = oklabToRgb({
    L: Math.max(0.015, lab.L * (1 - darken)),
    a: lab.a,
    b: lab.b - 0.012 * darken,
  });

  let or = shifted.r;
  let og = shifted.g;
  let ob = shifted.b;

  // Ensure Sel-Out outline stays strictly darker than adjacent fill after 8-bit quantization
  if (rec709Luma(or, og, ob) >= fillLuma) {
    const scale = Math.max(0.1, 1 - darken);
    or = Math.min(fillR > 0 ? fillR - 1 : 0, Math.round(fillR * scale));
    og = Math.min(fillG > 0 ? fillG - 1 : 0, Math.round(fillG * scale));
    ob = Math.min(fillB > 0 ? fillB - 1 : 0, Math.round(fillB * scale));
  }

  return [clampInt(or, 0, 255, 0), clampInt(og, 0, 255, 0), clampInt(ob, 0, 255, 0)];
}

/**
 * Scales a glyph mask by an integer factor, applies vertical gradient fill (with optional
 * Art Bible palette quantization), 4- or 8-connected OKLab Sel-Out outline, and drop shadow.
 */
export function styleGlyphMask(
  mask: GlyphMask,
  opts: BitmapFontStyleOptions,
  precomputedPalette?: readonly PaletteLabEntry[],
): { readonly buffer: RgbaBuffer; readonly padLeft: number; readonly padTop: number } {
  const s = clampInt(opts.scale, 1, 4, 2);
  const outlineMode = opts.outlineMode === 2 ? 2 : opts.outlineMode === 1 ? 1 : 0;
  const outlinePad = outlineMode > 0 ? 1 : 0;

  const shadowOffX = clampInt(opts.shadowOffsetX, -8, 8, 0);
  const shadowOffY = clampInt(opts.shadowOffsetY, -8, 8, 0);
  const shadowAlpha = clampInt(opts.shadowAlpha, 0, 255, 180);

  const shadowLeft = Math.max(0, -shadowOffX);
  const shadowRight = Math.max(0, shadowOffX);
  const shadowTop = Math.max(0, -shadowOffY);
  const shadowBottom = Math.max(0, shadowOffY);

  const safeW = Math.max(1, mask.width);
  const safeH = Math.max(1, mask.height);
  const scaledW = safeW * s;
  const scaledH = safeH * s;
  const padLeft = outlinePad + shadowLeft;
  const padTop = outlinePad + shadowTop;
  const outW = scaledW + outlinePad * 2 + shadowLeft + shadowRight;
  const outH = scaledH + outlinePad * 2 + shadowTop + shadowBottom;

  const solid = new Uint8Array(outW * outH);
  const out = new Uint8ClampedArray(outW * outH * 4);

  // 1. Rasterize scaled solid interior
  for (let sy = 0; sy < scaledH; sy++) {
    const my = Math.floor(sy / s);
    const dstRow = (padTop + sy) * outW + padLeft;
    const srcRow = my * mask.width;
    for (let sx = 0; sx < scaledW; sx++) {
      const mx = Math.floor(sx / s);
      if ((mask.alpha[srcRow + mx] ?? 0) >= 128) {
        solid[dstRow + sx] = 1;
      }
    }
  }

  // 2. Compute outline mask (4-connected or 8-connected)
  const outline = new Uint8Array(outW * outH);
  if (outlineMode > 0) {
    const dirs: readonly (readonly [number, number])[] =
      outlineMode === 1
        ? [
            [0, -1],
            [1, 0],
            [0, 1],
            [-1, 0],
          ]
        : [
            [-1, -1],
            [0, -1],
            [1, -1],
            [-1, 0],
            [1, 0],
            [-1, 1],
            [0, 1],
            [1, 1],
          ];

    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        if (solid[y * outW + x]) continue;
        for (const [dx, dy] of dirs) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && nx < outW && ny >= 0 && ny < outH && solid[ny * outW + nx]) {
            outline[y * outW + x] = 1;
            break;
          }
        }
      }
    }
  }

  // 3. Stamp hard-pixel drop shadow underneath (solid | outline shifted by shadowOffset)
  if (shadowAlpha > 0 && (shadowOffX !== 0 || shadowOffY !== 0)) {
    const sr = clampInt(opts.shadowRgb[0], 0, 255, 0);
    const sg = clampInt(opts.shadowRgb[1], 0, 255, 0);
    const sb = clampInt(opts.shadowRgb[2], 0, 255, 0);
    for (let y = 0; y < outH; y++) {
      for (let x = 0; x < outW; x++) {
        const idx = y * outW + x;
        if (!solid[idx] && !outline[idx]) continue;
        const tx = x + shadowOffX;
        const ty = y + shadowOffY;
        if (tx < 0 || tx >= outW || ty < 0 || ty >= outH) continue;
        const di = (ty * outW + tx) * 4;
        out[di] = sr;
        out[di + 1] = sg;
        out[di + 2] = sb;
        out[di + 3] = shadowAlpha;
      }
    }
  }

  // 4. Stamp outline (OKLab Sel-Out or explicit outlineRgb) & gradient fill (optionally palette-snapped)
  const paletteEntries =
    opts.snapToPalette === false
      ? []
      : (precomputedPalette ?? buildPaletteLabEntries(opts.paletteHex));
  const useSnap = paletteEntries.length > 0 && opts.snapToPalette !== false;

  const topR = clampInt(opts.topRgb[0], 0, 255, 255);
  const topG = clampInt(opts.topRgb[1], 0, 255, 255);
  const topB = clampInt(opts.topRgb[2], 0, 255, 255);
  const botR = clampInt(opts.bottomRgb[0], 0, 255, 255);
  const botG = clampInt(opts.bottomRgb[1], 0, 255, 255);
  const botB = clampInt(opts.bottomRgb[2], 0, 255, 255);

  const explicitOutline: readonly [number, number, number] | null = opts.outlineRgb
    ? [
        clampInt(opts.outlineRgb[0], 0, 255, 0),
        clampInt(opts.outlineRgb[1], 0, 255, 0),
        clampInt(opts.outlineRgb[2], 0, 255, 0),
      ]
    : null;

  for (let y = 0; y < outH; y++) {
    const gradT = scaledH > 1 ? Math.max(0, Math.min(1, (y - padTop) / (scaledH - 1))) : 0;
    let fillR = Math.round(topR + (botR - topR) * gradT);
    let fillG = Math.round(topG + (botG - topG) * gradT);
    let fillB = Math.round(topB + (botB - topB) * gradT);

    if (useSnap) {
      const snapped = snapRgbToPalette(fillR, fillG, fillB, paletteEntries);
      fillR = snapped.r;
      fillG = snapped.g;
      fillB = snapped.b;
    }

    const [outR, outG, outB] =
      explicitOutline ?? computeSelOutRgb(fillR, fillG, fillB, opts.selOutDarken);

    for (let x = 0; x < outW; x++) {
      const idx = y * outW + x;
      const di = idx * 4;
      if (solid[idx]) {
        out[di] = fillR;
        out[di + 1] = fillG;
        out[di + 2] = fillB;
        out[di + 3] = 255;
      } else if (outline[idx]) {
        out[di] = outR;
        out[di + 1] = outG;
        out[di + 2] = outB;
        out[di + 3] = 255;
      }
    }
  }

  return { buffer: { width: outW, height: outH, data: out }, padLeft, padTop };
}

function packShelves(
  styled: ReadonlyArray<{
    readonly mask: GlyphMask;
    readonly buffer: RgbaBuffer;
    readonly padLeft: number;
    readonly padTop: number;
  }>,
  atlasW: number,
  pad: number,
): {
  readonly placements: Array<{
    readonly x: number;
    readonly y: number;
    readonly item: (typeof styled)[number];
  }>;
  readonly neededH: number;
} {
  let cursorX = pad;
  let cursorY = pad;
  let shelfH = 0;
  const placements: Array<{ x: number; y: number; item: (typeof styled)[number] }> = [];

  for (const item of styled) {
    if (cursorX + item.buffer.width + pad > atlasW && cursorX > pad) {
      cursorX = pad;
      cursorY += shelfH + pad;
      shelfH = 0;
    }
    placements.push({ x: cursorX, y: cursorY, item });
    cursorX += item.buffer.width + pad;
    if (item.buffer.height > shelfH) shelfH = item.buffer.height;
  }

  return { placements, neededH: cursorY + shelfH + pad };
}

/**
 * Packs styled glyphs into a compact power-of-two RGBA atlas using deterministic shelf packing.
 */
export function bakeBitmapFontAtlas(
  masks: readonly GlyphMask[],
  opts: BitmapFontStyleOptions,
): BakedBitmapFont {
  const s = clampInt(opts.scale, 1, 4, 2);
  const pad = clampInt(opts.paddingPx, 1, 16, 2);
  const paletteEntries =
    opts.snapToPalette === false ? [] : buildPaletteLabEntries(opts.paletteHex);

  const styled = masks.map((mask) => ({
    mask,
    ...styleGlyphMask(mask, opts, paletteEntries),
  }));

  const maxGlyphW = styled.reduce((max, g) => Math.max(max, g.buffer.width), 1);
  const totalArea = styled.reduce(
    (sum, g) => sum + (g.buffer.width + pad) * (g.buffer.height + pad),
    0,
  );

  let atlasW = 64;
  while (atlasW < maxGlyphW + pad * 2 && atlasW < 2048) atlasW *= 2;
  while (atlasW * atlasW < totalArea * 1.35 && atlasW < 2048) atlasW *= 2;

  let packed = packShelves(styled, atlasW, pad);
  while (packed.neededH > atlasW * 2 && atlasW < 2048) {
    atlasW *= 2;
    packed = packShelves(styled, atlasW, pad);
  }

  let atlasH = 64;
  while (atlasH < packed.neededH && atlasH < 4096) atlasH *= 2;

  const atlasData = new Uint8ClampedArray(atlasW * atlasH * 4);
  const glyphs: PackedGlyphMetric[] = [];
  let maxLineH = 0;

  for (const { x, y, item } of packed.placements) {
    const { width: gw, height: gh, data: gd } = item.buffer;
    for (let py = 0; py < gh; py++) {
      const dstY = y + py;
      if (dstY >= atlasH) break;
      const srcStart = py * gw * 4;
      const copyW = Math.min(gw, atlasW - x);
      if (copyW <= 0) continue;
      atlasData.set(gd.subarray(srcStart, srcStart + copyW * 4), (dstY * atlasW + x) * 4);
    }

    if (gh > maxLineH) maxLineH = gh;
    glyphs.push({
      id: item.mask.charCode,
      char: item.mask.char,
      x,
      y,
      width: gw,
      height: gh,
      xoffset: item.mask.xoffset * s - item.padLeft,
      yoffset: item.mask.yoffset * s - item.padTop,
      xadvance: item.mask.xadvance * s + opts.letterSpacingPx,
    });
  }

  const safeBase = Math.max(1, maxLineH);
  return {
    fontName: opts.fontName.trim() || 'nibgrid_font',
    lineHeight: safeBase + 2,
    base: safeBase,
    atlas: { width: atlasW, height: atlasH, data: atlasData },
    glyphs,
  };
}

/**
 * Computes deterministic pixel bounds for a rendered line of bitmap text.
 */
export function measureBitmapFontText(
  font: BakedBitmapFont,
  text: string,
): { readonly width: number; readonly height: number } {
  const byId = new Map<number, PackedGlyphMetric>();
  for (const g of font.glyphs) {
    byId.set(g.id, g);
  }
  const fallback = byId.get(63);
  const spaceAdvance = Math.max(4, Math.round(font.base * 0.45));
  let cursorX = 0;
  let maxW = 0;
  for (const ch of Array.from(text)) {
    const code = ch.charCodeAt(0);
    let glyph = byId.get(code);
    if (!glyph) {
      if (code === 32) {
        cursorX += spaceAdvance;
        if (cursorX > maxW) maxW = cursorX;
        continue;
      }
      glyph = fallback;
    }
    if (!glyph) continue;
    const right = cursorX + glyph.xoffset + glyph.width;
    if (right > maxW) maxW = right;
    cursorX += glyph.xadvance;
    if (cursorX > maxW) maxW = cursorX;
  }
  return { width: Math.max(1, Math.ceil(maxW)), height: Math.max(1, font.lineHeight) };
}
