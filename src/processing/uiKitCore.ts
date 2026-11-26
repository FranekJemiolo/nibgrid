import { parseHexRgb } from './backgroundKey';
import type { RgbaBuffer } from './types';

export type UiWidgetSlot =
  | 'button_normal'
  | 'button_hover'
  | 'button_pressed'
  | 'button_disabled'
  | 'panel_bg'
  | 'bar_track'
  | 'bar_fill';

export const ALL_UI_WIDGET_SLOTS: readonly UiWidgetSlot[] = [
  'button_normal',
  'button_hover',
  'button_pressed',
  'button_disabled',
  'panel_bg',
  'bar_track',
  'bar_fill',
];

export interface NineSliceMargins {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

export interface UiKitStyleConfig {
  readonly slug: string;
  readonly tileSizePx: 24 | 32 | 48;
  readonly borderPx: 1 | 2 | 3;
  readonly cornerCutPx: 0 | 1 | 2;
  readonly baseRgb: readonly [number, number, number];
  readonly accentRgb: readonly [number, number, number];
  readonly fillBarRgb: readonly [number, number, number];
  readonly outlineRgb: readonly [number, number, number];
  readonly margins: NineSliceMargins;
  readonly contentMarginPx: number;
  readonly linkedBmFontId?: string;
}

export interface BakedUiKit {
  readonly slug: string;
  readonly slots: Readonly<Record<UiWidgetSlot, RgbaBuffer>>;
  readonly margins: NineSliceMargins;
  readonly contentMarginPx: number;
}

type RgbTriplet = readonly [number, number, number];

function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

function liftRgb(rgb: RgbTriplet, factor: number): RgbTriplet {
  const stepMin = factor > 0 ? Math.round(255 * factor * 0.45) : 0;
  return [
    clampByte(Math.max(rgb[0] + stepMin, rgb[0] * (1 + factor))),
    clampByte(Math.max(rgb[1] + stepMin, rgb[1] * (1 + factor))),
    clampByte(Math.max(rgb[2] + stepMin, rgb[2] * (1 + factor))),
  ];
}

function darkenRgb(rgb: RgbTriplet, factor: number): RgbTriplet {
  const scale = Math.max(0, 1 - factor);
  const stepMin = factor > 0 ? Math.round(255 * factor * 0.35) : 0;
  return [
    clampByte(Math.min(rgb[0] - stepMin, rgb[0] * scale)),
    clampByte(Math.min(rgb[1] - stepMin, rgb[1] * scale)),
    clampByte(Math.min(rgb[2] - stepMin, rgb[2] * scale)),
  ];
}

function mixRgb(a: RgbTriplet, b: RgbTriplet, t: number): RgbTriplet {
  const k = Math.max(0, Math.min(1, t));
  return [
    clampByte(a[0] + (b[0] - a[0]) * k),
    clampByte(a[1] + (b[1] - a[1]) * k),
    clampByte(a[2] + (b[2] - a[2]) * k),
  ];
}

function desaturateRgb(rgb: RgbTriplet, amount: number): RgbTriplet {
  const luma = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  const mid = luma * 0.55 + 128 * 0.45;
  return mixRgb(rgb, [mid, mid, mid], amount);
}

/**
 * Clamps 9-slice texture margins to safe integer bounds so `left + right < width`
 * and `top + bottom < height` (preventing Godot 4 StyleBoxTexture collapse).
 */
export function clampNineSliceMargins(
  margins: NineSliceMargins,
  width: number,
  height: number,
): NineSliceMargins {
  const w = Math.max(3, Math.floor(width));
  const h = Math.max(3, Math.floor(height));

  let left = Math.max(
    1,
    Math.min(w - 2, Math.round(Number.isFinite(margins.left) ? margins.left : 4)),
  );
  let right = Math.max(
    1,
    Math.min(w - 2, Math.round(Number.isFinite(margins.right) ? margins.right : 4)),
  );
  if (left + right >= w) {
    const budget = w - 1;
    const nextLeft = Math.max(1, Math.floor((left / Math.max(1, left + right)) * budget));
    const nextRight = Math.max(1, budget - nextLeft);
    left = Math.min(nextLeft, w - 2);
    right = Math.max(1, Math.min(nextRight, w - 1 - left));
  }

  let top = Math.max(
    1,
    Math.min(h - 2, Math.round(Number.isFinite(margins.top) ? margins.top : 4)),
  );
  let bottom = Math.max(
    1,
    Math.min(h - 2, Math.round(Number.isFinite(margins.bottom) ? margins.bottom : 4)),
  );
  if (top + bottom >= h) {
    const budget = h - 1;
    const nextTop = Math.max(1, Math.floor((top / Math.max(1, top + bottom)) * budget));
    const nextBottom = Math.max(1, budget - nextTop);
    top = Math.min(nextTop, h - 2);
    bottom = Math.max(1, Math.min(nextBottom, h - 1 - top));
  }

  return { left, top, right, bottom };
}

interface WidgetRenderSpec {
  outline: RgbTriplet;
  topBevel: RgbTriplet;
  bottomBevel: RgbTriplet;
  interior: RgbTriplet;
  innerRim?: RgbTriplet;
  pressedHighlightShift?: boolean;
  specularStreak?: RgbTriplet;
}

function renderFramedTile(
  size: number,
  borderPx: number,
  cornerCutPx: number,
  spec: WidgetRenderSpec,
): RgbaBuffer {
  const data = new Uint8ClampedArray(size * size * 4);
  const b = Math.max(1, Math.min(Math.floor(size / 4), Math.round(borderPx)));
  const cut = Math.max(0, Math.min(3, Math.round(cornerCutPx)));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Chamfer cut corners horizontally + vertically
      const distTL = x + y;
      const distTR = size - 1 - x + y;
      const distBL = x + (size - 1 - y);
      const distBR = size - 1 - x + (size - 1 - y);
      if (cut > 0 && (distTL < cut || distTR < cut || distBL < cut || distBR < cut)) {
        continue;
      }

      const dTop = y;
      const dBottom = size - 1 - y;
      const dLeft = x;
      const dRight = size - 1 - x;
      const minEdge = Math.min(dTop, dBottom, dLeft, dRight);

      let rgb: RgbTriplet = spec.interior;

      if (
        minEdge === 0 ||
        (cut > 0 && (distTL === cut || distTR === cut || distBL === cut || distBR === cut))
      ) {
        rgb = spec.outline;
      } else if (dTop <= b || dLeft <= b) {
        rgb = spec.topBevel;
      } else if (dBottom <= b || dRight <= b) {
        rgb = spec.bottomBevel;
      } else if (spec.innerRim && minEdge === b + 1) {
        rgb = spec.innerRim;
      } else if (spec.pressedHighlightShift && dTop === b + 2 && x > b + 1 && x < size - 2 - b) {
        rgb = liftRgb(spec.interior, 0.08);
      } else if (spec.specularStreak && y >= b + 2 && y <= b + 3) {
        rgb = spec.specularStreak;
      }

      const idx = (y * size + x) * 4;
      data[idx] = rgb[0];
      data[idx + 1] = rgb[1];
      data[idx + 2] = rgb[2];
      data[idx + 3] = 255;
    }
  }

  return { width: size, height: size, data };
}

/**
 * Deterministically synthesizes all 7 Godot 4 UI Kit widget 9-slice tiles from `UiKitStyleConfig`.
 */
export function bakeProceduralUiKit(config: UiKitStyleConfig): BakedUiKit {
  const size = config.tileSizePx;
  const margins = clampNineSliceMargins(config.margins, size, size);
  const contentMarginPx = Math.max(0, Math.min(24, Math.round(config.contentMarginPx)));

  const normalSpec: WidgetRenderSpec = {
    outline: config.outlineRgb,
    topBevel: liftRgb(config.baseRgb, 0.2),
    bottomBevel: darkenRgb(config.baseRgb, 0.25),
    interior: config.baseRgb,
    innerRim: mixRgb(config.baseRgb, config.accentRgb, 0.25),
  };

  const hoverInterior = liftRgb(config.baseRgb, 0.14);
  const hoverSpec: WidgetRenderSpec = {
    outline: config.outlineRgb,
    topBevel: mixRgb(liftRgb(normalSpec.topBevel, 0.14), config.accentRgb, 0.35),
    bottomBevel: mixRgb(normalSpec.bottomBevel, config.accentRgb, 0.2),
    interior: hoverInterior,
    innerRim: mixRgb(hoverInterior, config.accentRgb, 0.65),
  };

  const pressedInterior = darkenRgb(config.baseRgb, 0.12);
  const pressedSpec: WidgetRenderSpec = {
    outline: config.outlineRgb,
    topBevel: darkenRgb(config.baseRgb, 0.3),
    bottomBevel: liftRgb(config.baseRgb, 0.12),
    interior: pressedInterior,
    pressedHighlightShift: true,
  };

  const disabledBase = desaturateRgb(config.baseRgb, 0.65);
  const disabledSpec: WidgetRenderSpec = {
    outline: desaturateRgb(mixRgb(config.outlineRgb, disabledBase, 0.35), 0.65),
    topBevel: desaturateRgb(normalSpec.topBevel, 0.65),
    bottomBevel: desaturateRgb(normalSpec.bottomBevel, 0.65),
    interior: disabledBase,
  };

  const panelInterior = darkenRgb(config.baseRgb, 0.2);
  const panelSpec: WidgetRenderSpec = {
    outline: config.outlineRgb,
    topBevel: mixRgb(config.baseRgb, config.accentRgb, 0.45),
    bottomBevel: darkenRgb(config.baseRgb, 0.35),
    interior: panelInterior,
    innerRim: liftRgb(panelInterior, 0.18),
  };

  const trackInterior = darkenRgb(config.outlineRgb, 0.15);
  const trackSpec: WidgetRenderSpec = {
    outline: config.outlineRgb,
    topBevel: darkenRgb(trackInterior, 0.35),
    bottomBevel: liftRgb(config.baseRgb, 0.05),
    interior: trackInterior,
  };

  const fillSpec: WidgetRenderSpec = {
    outline: config.outlineRgb,
    topBevel: liftRgb(config.fillBarRgb, 0.22),
    bottomBevel: darkenRgb(config.fillBarRgb, 0.28),
    interior: config.fillBarRgb,
    specularStreak: liftRgb(config.fillBarRgb, 0.32),
  };

  return {
    slug: config.slug,
    slots: {
      button_normal: renderFramedTile(size, config.borderPx, config.cornerCutPx, normalSpec),
      button_hover: renderFramedTile(size, config.borderPx, config.cornerCutPx, hoverSpec),
      button_pressed: renderFramedTile(size, config.borderPx, config.cornerCutPx, pressedSpec),
      button_disabled: renderFramedTile(size, config.borderPx, config.cornerCutPx, disabledSpec),
      panel_bg: renderFramedTile(size, config.borderPx, config.cornerCutPx, panelSpec),
      bar_track: renderFramedTile(
        size,
        Math.max(1, config.borderPx - 1),
        config.cornerCutPx,
        trackSpec,
      ),
      bar_fill: renderFramedTile(size, 1, config.cornerCutPx, fillSpec),
    },
    margins,
    contentMarginPx,
  };
}

/**
 * Slices a generated `4×2` (or `2×3`) UI State Sheet on flat `#FF00FF` chroma into 7 widget slots
 * and computes safe clamped 9-slice margins.
 */
export function sliceUiStateSheet(
  sheet: RgbaBuffer,
  chromaRgb: readonly [number, number, number] = [255, 0, 255],
  slug = 'ui_kit',
): BakedUiKit {
  const cols = sheet.width >= sheet.height ? 4 : 2;
  const rows = cols === 4 ? 2 : 3;
  const cellW = Math.max(8, Math.floor(sheet.width / cols));
  const cellH = Math.max(8, Math.floor(sheet.height / rows));

  const extractCell = (idx: number): RgbaBuffer => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const sx0 = col * cellW;
    const sy0 = row * cellH;
    const data = new Uint8ClampedArray(cellW * cellH * 4);
    for (let y = 0; y < cellH; y++) {
      for (let x = 0; x < cellW; x++) {
        const sIdx = ((sy0 + y) * sheet.width + (sx0 + x)) * 4;
        const dIdx = (y * cellW + x) * 4;
        const r = sheet.data[sIdx] ?? 0;
        const g = sheet.data[sIdx + 1] ?? 0;
        const b = sheet.data[sIdx + 2] ?? 0;
        const a = sheet.data[sIdx + 3] ?? 255;
        const manhattan =
          Math.abs(r - chromaRgb[0]) + Math.abs(g - chromaRgb[1]) + Math.abs(b - chromaRgb[2]);
        if (a <= 16 || manhattan <= 48) {
          continue;
        }
        data[dIdx] = r;
        data[dIdx + 1] = g;
        data[dIdx + 2] = b;
        data[dIdx + 3] = a;
      }
    }
    return { width: cellW, height: cellH, data };
  };

  const barTrack = extractCell(5);
  const barFill =
    cols * rows >= 7
      ? extractCell(6)
      : {
          width: barTrack.width,
          height: barTrack.height,
          data: new Uint8ClampedArray(barTrack.data),
        };

  const rawMargins: NineSliceMargins = {
    left: Math.max(2, Math.round(cellW * 0.2)),
    top: Math.max(2, Math.round(cellH * 0.2)),
    right: Math.max(2, Math.round(cellW * 0.2)),
    bottom: Math.max(2, Math.round(cellH * 0.2)),
  };

  return {
    slug,
    slots: {
      button_normal: extractCell(0),
      button_hover: extractCell(1),
      button_pressed: extractCell(2),
      button_disabled: extractCell(3),
      panel_bg: extractCell(4),
      bar_track: barTrack,
      bar_fill: barFill,
    },
    margins: clampNineSliceMargins(rawMargins, cellW, cellH),
    contentMarginPx: 6,
  };
}

/**
 * Pure-TS nearest-neighbor 9-slice renderer so live button & HP-bar previews stretch
 * crisply without corner distortion.
 */
export function renderNineSliceToBuffer(
  src: RgbaBuffer,
  rawMargins: NineSliceMargins,
  targetW: number,
  targetH: number,
): RgbaBuffer {
  const dstW = Math.max(2, Math.round(targetW));
  const dstH = Math.max(2, Math.round(targetH));
  const m = clampNineSliceMargins(rawMargins, src.width, src.height);
  const out = new Uint8ClampedArray(dstW * dstH * 4);

  const srcCenterW = Math.max(1, src.width - m.left - m.right);
  const srcCenterH = Math.max(1, src.height - m.top - m.bottom);
  const dstCenterW = Math.max(0, dstW - m.left - m.right);
  const dstCenterH = Math.max(0, dstH - m.top - m.bottom);

  const mapAxis = (
    pos: number,
    dstLen: number,
    head: number,
    tail: number,
    srcCenter: number,
    srcLen: number,
    dstCenter: number,
  ) => {
    if (pos < head) return Math.min(head - 1, pos);
    if (pos >= dstLen - tail) return Math.max(srcLen - tail, srcLen - (dstLen - pos));
    const rel = dstCenter > 0 ? (pos - head) / dstCenter : 0;
    return Math.min(srcLen - tail - 1, head + Math.floor(rel * srcCenter));
  };

  for (let y = 0; y < dstH; y++) {
    const sy = mapAxis(y, dstH, m.top, m.bottom, srcCenterH, src.height, dstCenterH);
    for (let x = 0; x < dstW; x++) {
      const sx = mapAxis(x, dstW, m.left, m.right, srcCenterW, src.width, dstCenterW);
      const sIdx = (sy * src.width + sx) * 4;
      const dIdx = (y * dstW + x) * 4;
      out[dIdx] = src.data[sIdx] ?? 0;
      out[dIdx + 1] = src.data[sIdx + 1] ?? 0;
      out[dIdx + 2] = src.data[sIdx + 2] ?? 0;
      out[dIdx + 3] = src.data[sIdx + 3] ?? 0;
    }
  }

  return { width: dstW, height: dstH, data: out };
}

/** Derives a cohesive ArtBible default RGB palette tuple set for `UiKitStyleConfig`. */
export function pickUiKitColorsFromPalette(paletteHex: readonly string[]): {
  outlineRgb: RgbTriplet;
  baseRgb: RgbTriplet;
  accentRgb: RgbTriplet;
  fillBarRgb: RgbTriplet;
} {
  if (paletteHex.length === 0) {
    return {
      outlineRgb: [26, 28, 44],
      baseRgb: [72, 78, 108],
      accentRgb: [255, 205, 117],
      fillBarRgb: [177, 62, 83],
    };
  }
  const parsed = paletteHex.map((hex) => {
    const { r, g, b } = parseHexRgb(hex);
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return { rgb: [r, g, b] as RgbTriplet, luma };
  });
  parsed.sort((a, b) => a.luma - b.luma);

  const outlineRgb = parsed[0]!.rgb;
  const baseRgb = parsed[Math.min(parsed.length - 1, Math.floor(parsed.length * 0.35))]!.rgb;
  const accentRgb = parsed[parsed.length - 1]!.rgb;
  const fillBarRgb = parsed[Math.min(parsed.length - 1, Math.floor(parsed.length * 0.65))]!.rgb;
  return { outlineRgb, baseRgb, accentRgb, fillBarRgb };
}
