import { parseHexRgb } from './backgroundKey';
import type { RgbaBuffer } from './types';

export type VfxArchetype = 'sparks' | 'dust-puff' | 'smoke' | 'hit-ring' | 'noise-dissolve';

export interface VfxFlipbookOptions {
  readonly archetype: VfxArchetype;
  readonly frameSizePx: number;
  readonly cols: number;
  readonly rows: number;
  readonly seed: number;
  /** Expansion / travel radius in normalized cell units (0.1..0.48) */
  readonly spread: number;
  /** Noise turbulence & erosion strength (0..1) */
  readonly turbulence: number;
  /** Core & edge colors in [R, G, B] */
  readonly coreRgb: readonly [number, number, number];
  readonly outerRgb: readonly [number, number, number];
  /** Optional source sprite (used by 'noise-dissolve' or fallback synthesis) */
  readonly sourceSprite?: RgbaBuffer | null;
  /** Optional Art Bible hex palette used when snapToPalette is enabled */
  readonly paletteHex?: readonly string[];
  readonly snapToPalette?: boolean;
}

export interface VfxFlipbookResult {
  readonly frameSizePx: number;
  readonly cols: number;
  readonly rows: number;
  readonly frameCount: number;
  readonly sheet: RgbaBuffer;
  readonly frames: readonly RgbaBuffer[];
}

export function hexToRgbTuple(hex: string): [number, number, number] {
  const { r, g, b } = parseHexRgb(hex);
  return [
    Math.max(0, Math.min(255, Math.round(r))),
    Math.max(0, Math.min(255, Math.round(g))),
    Math.max(0, Math.min(255, Math.round(b))),
  ];
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, value));
}

function sanitizeRgb(rgb: readonly [number, number, number]): [number, number, number] {
  return [
    clampInt(rgb[0], 0, 255, 255),
    clampInt(rgb[1], 0, 255, 255),
    clampInt(rgb[2], 0, 255, 255),
  ];
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(ix: number, iy: number, seed: number): number {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth 2D value noise in [0, 1]. */
export function valueNoise2d(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);

  const n00 = hash2(x0, y0, seed);
  const n10 = hash2(x0 + 1, y0, seed);
  const n01 = hash2(x0, y0 + 1, seed);
  const n11 = hash2(x0 + 1, y0 + 1, seed);

  const nx0 = n00 + (n10 - n00) * ux;
  const nx1 = n01 + (n11 - n01) * ux;
  return nx0 + (nx1 - nx0) * uy;
}

/** 3-octave FBM noise in [0, 1]. */
export function fbm2d(x: number, y: number, seed: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 3; o++) {
    sum += amp * valueNoise2d(x * freq, y * freq, seed + o * 101);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm > 0 ? sum / norm : 0;
}

interface SparkStreak {
  readonly angle: number;
  readonly speed: number;
  readonly length: number;
  readonly thickness: number;
}

interface PuffBlob {
  readonly angle: number;
  readonly distRatio: number;
  readonly radiusRatio: number;
  readonly riseRatio: number;
}

interface SanitizedFlipbookParams {
  readonly archetype: VfxArchetype;
  readonly size: number;
  readonly cols: number;
  readonly rows: number;
  readonly seed: number;
  readonly spread: number;
  readonly turbulence: number;
  readonly coreRgb: readonly [number, number, number];
  readonly outerRgb: readonly [number, number, number];
  readonly sourceSprite: RgbaBuffer | null;
  readonly paletteTuples: readonly (readonly [number, number, number])[];
}

interface HitRingPrecomp {
  readonly radialDist: Float64Array;
  readonly fbmField: Float64Array;
  readonly breakNoise: Float64Array;
}

interface DissolvePrecomp {
  readonly sourcePixels: Uint8ClampedArray;
  readonly noiseField: Float64Array;
  readonly bestEmberIdx: number;
  readonly bestEmberAlpha: number;
}

interface ActivePuff {
  readonly px: number;
  readonly py: number;
  readonly rad: number;
  readonly radSq: number;
}

function snapRgbToPalette(
  r: number,
  g: number,
  b: number,
  palette: readonly (readonly [number, number, number])[],
): readonly [number, number, number] {
  let best = palette[0] ?? [r, g, b];
  let bestDistSq = Number.POSITIVE_INFINITY;
  for (const cand of palette) {
    const dr = r - cand[0];
    const dg = g - cand[1];
    const db = b - cand[2];
    const dSq = dr * dr + dg * dg + db * db;
    if (dSq < bestDistSq) {
      bestDistSq = dSq;
      best = cand;
    }
  }
  return best;
}

function applyPaletteSnapInPlace(
  data: Uint8ClampedArray,
  palette: readonly (readonly [number, number, number])[],
): void {
  if (palette.length === 0) return;
  for (let i = 0; i < data.length; i += 4) {
    if ((data[i + 3] ?? 0) === 0) continue;
    const snapped = snapRgbToPalette(data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0, palette);
    data[i] = snapped[0];
    data[i + 1] = snapped[1];
    data[i + 2] = snapped[2];
  }
}

function sampleOrSynthesizeDissolveSource(
  size: number,
  cx: number,
  cy: number,
  maxR: number,
  coreRgb: readonly [number, number, number],
  outerRgb: readonly [number, number, number],
  sourceSprite: RgbaBuffer | null,
  x: number,
  y: number,
): readonly [number, number, number, number] {
  if (
    sourceSprite &&
    sourceSprite.width > 0 &&
    sourceSprite.height > 0 &&
    sourceSprite.data.length >= sourceSprite.width * sourceSprite.height * 4
  ) {
    const sx = Math.min(sourceSprite.width - 1, Math.floor((x / size) * sourceSprite.width));
    const sy = Math.min(sourceSprite.height - 1, Math.floor((y / size) * sourceSprite.height));
    const si = (sy * sourceSprite.width + sx) * 4;
    return [
      sourceSprite.data[si] ?? 0,
      sourceSprite.data[si + 1] ?? 0,
      sourceSprite.data[si + 2] ?? 0,
      sourceSprite.data[si + 3] ?? 0,
    ];
  }

  // Synthesize centered radial orb when no source sprite is supplied
  const dist = Math.hypot(x - cx, y - cy);
  if (dist > maxR) return [0, 0, 0, 0];
  const radial = Math.max(0, 1 - dist / Math.max(1, maxR));
  const alpha = Math.min(255, Math.round(Math.pow(radial, 0.55) * 255));
  const r = Math.round(outerRgb[0] + (coreRgb[0] - outerRgb[0]) * radial);
  const g = Math.round(outerRgb[1] + (coreRgb[1] - outerRgb[1]) * radial);
  const b = Math.round(outerRgb[2] + (coreRgb[2] - outerRgb[2]) * radial);
  return [r, g, b, alpha];
}

function precomputeHitRingFields(size: number, seed: number): HitRingPrecomp {
  const total = size * size;
  const radialDist = new Float64Array(total);
  const fbmField = new Float64Array(total);
  const breakNoise = new Float64Array(total);
  const cx = (size - 1) * 0.5;
  const cy = (size - 1) * 0.5;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = y * size + x;
      const angle = Math.atan2(y - cy, x - cx);
      radialDist[idx] = Math.hypot(x - cx, y - cy);
      fbmField[idx] = fbm2d((x / size) * 5, (y / size) * 5, seed);
      breakNoise[idx] = valueNoise2d(Math.cos(angle) * 3 + 4, Math.sin(angle) * 3 + 4, seed + 31);
    }
  }
  return { radialDist, fbmField, breakNoise };
}

function precomputeDissolveFields(params: SanitizedFlipbookParams): DissolvePrecomp {
  const { size, seed, spread, coreRgb, outerRgb, sourceSprite } = params;
  const total = size * size;
  const sourcePixels = new Uint8ClampedArray(total * 4);
  const noiseField = new Float64Array(total);
  const cx = (size - 1) * 0.5;
  const cy = (size - 1) * 0.5;
  const maxR = size * spread;

  let bestEmberIdx = -1;
  let bestEmberNoise = -1;
  let bestEmberAlpha = 0;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const pixelIdx = y * size + x;
      const p4 = pixelIdx * 4;
      const [sr, sg, sb, saByte] = sampleOrSynthesizeDissolveSource(
        size,
        cx,
        cy,
        maxR,
        coreRgb,
        outerRgb,
        sourceSprite,
        x,
        y,
      );
      sourcePixels[p4] = sr;
      sourcePixels[p4 + 1] = sg;
      sourcePixels[p4 + 2] = sb;
      sourcePixels[p4 + 3] = saByte;
      if (saByte <= 2) continue;

      const rawFbm = fbm2d((x / size) * 6, (y / size) * 6, seed);
      const n = Math.max(0, Math.min(1, (rawFbm - 0.18) / 0.64));
      noiseField[pixelIdx] = n;
      if (n > bestEmberNoise) {
        bestEmberNoise = n;
        bestEmberIdx = p4;
        bestEmberAlpha = saByte;
      }
    }
  }

  return { sourcePixels, noiseField, bestEmberIdx, bestEmberAlpha };
}

function renderSingleFrame(
  params: SanitizedFlipbookParams,
  t: number,
  sparks: readonly SparkStreak[],
  puffs: readonly PuffBlob[],
  hitPrecomp: HitRingPrecomp | null,
  dissolvePrecomp: DissolvePrecomp | null,
): RgbaBuffer {
  const { size, seed, spread, turbulence, coreRgb, outerRgb, archetype } = params;
  const out = new Uint8ClampedArray(size * size * 4);
  const cx = (size - 1) * 0.5;
  const cy = (size - 1) * 0.5;
  const maxR = size * spread;

  // Keep a visible trailing glow on the final frame (never dropping to 0)
  const lifeFade = t <= 0.72 ? 1 : Math.max(0.14, 1 - ((t - 0.72) / 0.28) * 0.86);

  if (archetype === 'sparks') {
    const easeOut = 1 - (1 - t) * (1 - t);
    for (const s of sparks) {
      const headDist = s.speed * maxR * easeOut;
      const tailDist = Math.max(0, headDist - s.length * maxR * (1 - t * 0.5));
      const hx = cx + Math.cos(s.angle) * headDist;
      const hy = cy + Math.sin(s.angle) * headDist;
      const tx = cx + Math.cos(s.angle) * tailDist;
      const ty = cy + Math.sin(s.angle) * tailDist;
      const dx = hx - tx;
      const dy = hy - ty;
      const lenSq = dx * dx + dy * dy;

      const minX = Math.max(0, Math.floor(Math.min(hx, tx) - s.thickness - 1));
      const maxX = Math.min(size - 1, Math.ceil(Math.max(hx, tx) + s.thickness + 1));
      const minY = Math.max(0, Math.floor(Math.min(hy, ty) - s.thickness - 1));
      const maxY = Math.min(size - 1, Math.ceil(Math.max(hy, ty) + s.thickness + 1));

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const u =
            lenSq > 1e-6 ? Math.max(0, Math.min(1, ((x - tx) * dx + (y - ty) * dy) / lenSq)) : 1;
          const px = tx + u * dx;
          const py = ty + u * dy;
          const halfW = s.thickness * (0.35 + 0.65 * u) * (1 - t * 0.4);
          const rx = x - px;
          const ry = y - py;
          const distSq = rx * rx + ry * ry;
          if (distSq <= halfW * halfW) {
            const dist = Math.sqrt(distSq);
            const alpha = Math.min(
              1,
              (1 - dist / Math.max(0.25, halfW)) * (0.35 + 0.65 * u) * lifeFade,
            );
            const idx = (y * size + x) * 4;
            const mixCore = u * (1 - t * 0.5);
            const r = Math.round(outerRgb[0] + (coreRgb[0] - outerRgb[0]) * mixCore);
            const g = Math.round(outerRgb[1] + (coreRgb[1] - outerRgb[1]) * mixCore);
            const b = Math.round(outerRgb[2] + (coreRgb[2] - outerRgb[2]) * mixCore);
            const aByte = Math.round(alpha * 255);
            if (aByte > (out[idx + 3] ?? 0)) {
              out[idx] = r;
              out[idx + 1] = g;
              out[idx + 2] = b;
              out[idx + 3] = aByte;
            }
          }
        }
      }
    }
    applyPaletteSnapInPlace(out, params.paletteTuples);
    return { width: size, height: size, data: out };
  }

  if (archetype === 'hit-ring' && hitPrecomp) {
    const ringRadius = maxR * (0.18 + 0.82 * Math.pow(t, 0.55));
    const ringThickness = Math.max(1.2, size * 0.14 * (1 - t * 0.75));
    const radModScale = size * 0.12 * turbulence;
    const heatScale = Math.max(0, 1 - t * 1.2);
    for (let pixelIdx = 0; pixelIdx < size * size; pixelIdx++) {
      const modR = ringRadius + (hitPrecomp.fbmField[pixelIdx]! - 0.5) * radModScale;
      const dist = Math.abs(hitPrecomp.radialDist[pixelIdx]! - modR);
      if (dist <= ringThickness) {
        const edgeFactor = 1 - dist / ringThickness;
        const alpha = Math.max(
          0,
          Math.min(
            1,
            edgeFactor * lifeFade * (1 - t * turbulence * 0.45 * hitPrecomp.breakNoise[pixelIdx]!),
          ),
        );
        if (alpha > 0.02) {
          const idx = pixelIdx * 4;
          const heat = heatScale * edgeFactor;
          out[idx] = Math.round(outerRgb[0] + (coreRgb[0] - outerRgb[0]) * heat);
          out[idx + 1] = Math.round(outerRgb[1] + (coreRgb[1] - outerRgb[1]) * heat);
          out[idx + 2] = Math.round(outerRgb[2] + (coreRgb[2] - outerRgb[2]) * heat);
          out[idx + 3] = Math.round(alpha * 255);
        }
      }
    }
    applyPaletteSnapInPlace(out, params.paletteTuples);
    return { width: size, height: size, data: out };
  }

  if (archetype === 'noise-dissolve' && dissolvePrecomp) {
    const threshold = t * 0.94;
    const burnBand = 0.14;
    const { sourcePixels, noiseField, bestEmberIdx, bestEmberAlpha } = dissolvePrecomp;
    let nonEmptyPixels = 0;

    for (let pixelIdx = 0; pixelIdx < size * size; pixelIdx++) {
      const di = pixelIdx * 4;
      const saByte = sourcePixels[di + 3] ?? 0;
      if (saByte <= 2) continue;

      const n = noiseField[pixelIdx]!;
      if (n < threshold - burnBand) {
        out[di + 3] = 0;
      } else if (n < threshold) {
        const rim = 1 - (threshold - n) / burnBand;
        out[di] = Math.round(coreRgb[0] * rim + (sourcePixels[di] ?? 0) * (1 - rim));
        out[di + 1] = Math.round(coreRgb[1] * rim + (sourcePixels[di + 1] ?? 0) * (1 - rim));
        out[di + 2] = Math.round(coreRgb[2] * rim + (sourcePixels[di + 2] ?? 0) * (1 - rim));
        out[di + 3] = saByte;
        nonEmptyPixels++;
      } else {
        out[di] = sourcePixels[di] ?? 0;
        out[di + 1] = sourcePixels[di + 1] ?? 0;
        out[di + 2] = sourcePixels[di + 2] ?? 0;
        out[di + 3] = saByte;
        nonEmptyPixels++;
      }
    }

    // Preserve at least a glowing ember on the peak noise pixel if every pixel dissolved
    if (nonEmptyPixels === 0 && bestEmberIdx >= 0) {
      out[bestEmberIdx] = coreRgb[0];
      out[bestEmberIdx + 1] = coreRgb[1];
      out[bestEmberIdx + 2] = coreRgb[2];
      out[bestEmberIdx + 3] = Math.max(64, bestEmberAlpha);
    }

    applyPaletteSnapInPlace(out, params.paletteTuples);
    return { width: size, height: size, data: out };
  }

  // 'dust-puff' and 'smoke' cloud cluster
  const isSmoke = archetype === 'smoke';
  const expand = isSmoke ? 0.25 + 0.75 * Math.pow(t, 0.65) : 1 - Math.pow(1 - t, 2.2);
  const driftY = isSmoke ? -maxR * 0.55 * t : -maxR * 0.12 * t;
  const radScale = isSmoke
    ? 0.65 + 0.75 * t
    : 0.5 + 0.65 * Math.sin(Math.min(1, t) * Math.PI * 0.75);
  const activePuffs: ActivePuff[] = puffs.map((p) => {
    const rad = Math.max(1.5, p.radiusRatio * maxR * radScale);
    return {
      px: cx + Math.cos(p.angle) * p.distRatio * maxR * expand,
      py: cy + driftY + Math.sin(p.angle) * p.distRatio * maxR * expand + p.riseRatio * maxR * t,
      rad,
      radSq: rad * rad,
    };
  });

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let density = 0;
      for (const p of activePuffs) {
        const dx = x - p.px;
        const dy = y - p.py;
        const distSq = dx * dx + dy * dy;
        if (distSq < p.radSq) {
          const blob = 1 - Math.sqrt(distSq) / p.rad;
          density = Math.max(density, blob * blob);
        }
      }

      if (density > 0.01) {
        const n = fbm2d((x / size) * 5 + t * 1.4, (y / size) * 5 - t * 1.4, seed);
        const eroded = density * (1 - turbulence * 0.55 * (1 - n)) * lifeFade;
        if (eroded > 0.03) {
          const di = (y * size + x) * 4;
          const coreWeight = Math.min(1, eroded * 1.35);
          out[di] = Math.round(outerRgb[0] + (coreRgb[0] - outerRgb[0]) * coreWeight);
          out[di + 1] = Math.round(outerRgb[1] + (coreRgb[1] - outerRgb[1]) * coreWeight);
          out[di + 2] = Math.round(outerRgb[2] + (coreRgb[2] - outerRgb[2]) * coreWeight);
          out[di + 3] = Math.min(255, Math.round(eroded * 255));
        }
      }
    }
  }

  applyPaletteSnapInPlace(out, params.paletteTuples);
  return { width: size, height: size, data: out };
}

/**
 * Bakes a deterministic `cols × rows` 2D VFX flipbook spritesheet across `t in [0, 1]`.
 */
export function bakeVfxFlipbook(opts: VfxFlipbookOptions): VfxFlipbookResult {
  const size = clampInt(opts.frameSizePx, 8, 256, 64);
  const cols = clampInt(opts.cols, 1, 16, 4);
  const rows = clampInt(opts.rows, 1, 16, 4);
  const seed = Number.isFinite(opts.seed) ? Math.floor(opts.seed) >>> 0 : 101;
  const spread = clampFloat(opts.spread, 0.1, 0.48, 0.42);
  const turbulence = clampFloat(opts.turbulence, 0, 1, 0.35);
  const coreRgb = sanitizeRgb(opts.coreRgb);
  const outerRgb = sanitizeRgb(opts.outerRgb);
  const paletteTuples =
    opts.snapToPalette && opts.paletteHex && opts.paletteHex.length > 0
      ? opts.paletteHex.map(hexToRgbTuple)
      : [];

  const params: SanitizedFlipbookParams = {
    archetype: opts.archetype,
    size,
    cols,
    rows,
    seed,
    spread,
    turbulence,
    coreRgb,
    outerRgb,
    sourceSprite: opts.sourceSprite ?? null,
    paletteTuples,
  };

  const rng = mulberry32(seed);
  const sparks: SparkStreak[] = Array.from({ length: 12 }, (_, i) => ({
    angle: (i / 12) * Math.PI * 2 + (rng() - 0.5) * 0.45,
    speed: 0.55 + rng() * 0.45,
    length: 0.22 + rng() * 0.25,
    thickness: 1.0 + rng() * 1.8,
  }));
  const puffs: PuffBlob[] = Array.from({ length: 7 }, (_, i) => ({
    angle: (i / 7) * Math.PI * 2 + (rng() - 0.5) * 0.35,
    distRatio: i === 0 ? 0 : 0.35 + rng() * 0.45,
    radiusRatio: i === 0 ? 0.45 : 0.25 + rng() * 0.22,
    riseRatio: (rng() - 0.5) * 0.2,
  }));

  const hitPrecomp = params.archetype === 'hit-ring' ? precomputeHitRingFields(size, seed) : null;
  const dissolvePrecomp =
    params.archetype === 'noise-dissolve' ? precomputeDissolveFields(params) : null;

  const totalFrames = Math.max(1, cols * rows);
  const frames: RgbaBuffer[] = [];

  for (let f = 0; f < totalFrames; f++) {
    const t = totalFrames > 1 ? f / (totalFrames - 1) : 0;
    frames.push(renderSingleFrame(params, t, sparks, puffs, hitPrecomp, dissolvePrecomp));
  }

  const sheetW = cols * size;
  const sheetH = rows * size;
  const sheetData = new Uint8ClampedArray(sheetW * sheetH * 4);
  const rowStride = size * 4;

  frames.forEach((frame, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    const ox = col * size;
    const oy = row * size;

    for (let y = 0; y < size; y++) {
      const srcRow = frame.data.subarray(y * rowStride, (y + 1) * rowStride);
      sheetData.set(srcRow, ((oy + y) * sheetW + ox) * 4);
    }
  });

  return {
    frameSizePx: size,
    cols,
    rows,
    frameCount: totalFrames,
    sheet: { width: sheetW, height: sheetH, data: sheetData },
    frames,
  };
}
