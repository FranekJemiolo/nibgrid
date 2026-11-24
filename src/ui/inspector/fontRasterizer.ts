import type { GlyphMask } from '../../processing/bitmapFont';

export const SYSTEM_FONT_PRESETS: readonly string[] = [
  'monospace',
  'Courier New',
  'Impact',
  'Arial Black',
  'Verdana',
];

export interface RasterizeFontOptions {
  readonly fontFamily: string;
  readonly fontSizePx: number;
  readonly alphaThreshold?: number;
}

function quoteCssFontFamily(family: string): string {
  const trimmed = family.trim() || 'monospace';
  if (
    trimmed === 'monospace' ||
    trimmed === 'sans-serif' ||
    trimmed === 'serif' ||
    trimmed.startsWith('"') ||
    trimmed.startsWith("'")
  ) {
    return trimmed;
  }
  return `"${trimmed.replace(/"/g, '\\"')}"`;
}

/**
 * Loads an uploaded `.ttf`, `.otf`, `.woff`, or `.woff2` file via the browser `FontFace` API
 * and returns a unique registered font-family name.
 */
export async function loadUploadedFontFace(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  const baseName =
    file.name.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]+/g, '') || 'UploadedFont';
  const familyName = `NibgridCustom_${baseName}_${Math.random().toString(36).slice(2, 7)}`;
  const face = new FontFace(familyName, bytes);
  const loaded = await face.load();
  document.fonts.add(loaded);
  return familyName;
}

/**
 * Rasterizes unique characters of `charset` via an offscreen Canvas2D into crisp binary `GlyphMask[]`
 * compatible with the pure-TS `bakeBitmapFontAtlas()` styler and shelf packer.
 */
export function rasterizeBrowserFontToMasks(
  charset: string,
  opts: RasterizeFontOptions,
): GlyphMask[] {
  const sizePx = Math.max(8, Math.min(64, Math.round(opts.fontSizePx)));
  const threshold = Math.max(16, Math.min(240, Math.round(opts.alphaThreshold ?? 96)));
  const boxSize = Math.max(24, Math.ceil(sizePx * 2.4));
  const baselineY = Math.ceil(sizePx * 1.35);
  const originX = Math.ceil(sizePx * 0.45);
  const fontSpec = `${sizePx}px ${quoteCssFontFamily(opts.fontFamily)}`;

  const canvas = document.createElement('canvas');
  canvas.width = boxSize;
  canvas.height = boxSize;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    canvas.width = 0;
    canvas.height = 0;
    return [];
  }

  const seen = new Set<number>();
  const masks: GlyphMask[] = [];

  try {
    for (const ch of Array.from(charset)) {
      const code = ch.charCodeAt(0);
      if (seen.has(code)) continue;
      seen.add(code);

      ctx.font = fontSpec;
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';

      const metrics = ctx.measureText(ch);
      const xadvance = Math.max(1, Math.round(metrics.width || sizePx * 0.5));

      if (ch === ' ') {
        const spaceW = Math.max(2, Math.min(xadvance, Math.round(sizePx * 0.4)));
        masks.push({
          charCode: 32,
          char: ' ',
          width: spaceW,
          height: Math.max(4, Math.round(sizePx * 0.6)),
          alpha: new Uint8Array(spaceW * Math.max(4, Math.round(sizePx * 0.6))),
          xoffset: 0,
          yoffset: 0,
          xadvance,
        });
        continue;
      }

      ctx.clearRect(0, 0, boxSize, boxSize);
      ctx.fillText(ch, originX, baselineY);
      const data = ctx.getImageData(0, 0, boxSize, boxSize).data;

      let minX = boxSize;
      let minY = boxSize;
      let maxX = -1;
      let maxY = -1;

      for (let y = 0; y < boxSize; y++) {
        for (let x = 0; x < boxSize; x++) {
          if ((data[(y * boxSize + x) * 4 + 3] ?? 0) >= threshold) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < minX || maxY < minY) {
        masks.push({
          charCode: code,
          char: ch,
          width: 2,
          height: 2,
          alpha: new Uint8Array(4),
          xoffset: 0,
          yoffset: 0,
          xadvance,
        });
        continue;
      }

      const gw = maxX - minX + 1;
      const gh = maxY - minY + 1;
      const alpha = new Uint8Array(gw * gh);
      for (let y = 0; y < gh; y++) {
        for (let x = 0; x < gw; x++) {
          const a = data[((minY + y) * boxSize + (minX + x)) * 4 + 3] ?? 0;
          alpha[y * gw + x] = a >= threshold ? 255 : 0;
        }
      }

      masks.push({
        charCode: code,
        char: ch,
        width: gw,
        height: gh,
        alpha,
        xoffset: Math.max(-4, minX - originX),
        yoffset: minY - Math.max(0, baselineY - sizePx),
        xadvance,
      });
    }
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }

  return masks;
}
