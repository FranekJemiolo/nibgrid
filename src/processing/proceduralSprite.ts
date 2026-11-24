import type { AdherenceLevel, ArtMode, Lighting, TurnaroundLayout } from '../domain/schemas';
import { computeInkBoundingBox } from './normalize';

export interface RgbColor {
  r: number;
  g: number;
  b: number;
}

const FALLBACK_PALETTE: readonly RgbColor[] = [
  { r: 26, g: 28, b: 44 },
  { r: 93, g: 39, b: 93 },
  { r: 177, g: 62, b: 83 },
  { r: 239, g: 125, b: 87 },
  { r: 255, g: 205, b: 117 },
  { r: 56, g: 183, b: 100 },
];

export function hashString32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function parseHexToRgb(hex: string): RgbColor {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return {
    r: Number.isNaN(r) ? 128 : r,
    g: Number.isNaN(g) ? 128 : g,
    b: Number.isNaN(b) ? 128 : b,
  };
}

function colorLuminance(c: RgbColor): number {
  return 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
}

function resolveSpritePalette(hexPalette: readonly string[]): RgbColor[] {
  const parsed = hexPalette.length > 0 ? hexPalette.map(parseHexToRgb) : [...FALLBACK_PALETTE];
  return parsed.sort((a, b) => colorLuminance(a) - colorLuminance(b));
}

function adjustRgb(c: RgbColor, factor: number): RgbColor {
  return {
    r: Math.max(0, Math.min(255, Math.round(c.r * factor))),
    g: Math.max(0, Math.min(255, Math.round(c.g * factor))),
    b: Math.max(0, Math.min(255, Math.round(c.b * factor))),
  };
}

function lightingVector(lighting: Lighting): { lx: number; ly: number } {
  switch (lighting) {
    case 'top-left':
      return { lx: -0.7, ly: -0.7 };
    case 'top-right':
      return { lx: 0.7, ly: -0.7 };
    case 'overhead':
      return { lx: 0, ly: -1 };
    case 'flat':
      return { lx: 0, ly: 0 };
  }
}

export interface ProceduralSpriteOptions {
  sketchRgba: Uint8ClampedArray;
  width: number;
  height: number;
  palette: readonly string[];
  lighting: Lighting;
  artMode: ArtMode;
  adherence: AdherenceLevel;
  seedKey: string;
  variantIndex: number;
}

/**
 * Generates a deterministic procedural 2D game sprite on a solid flat contrasting background
 * using the input sketch's silhouette cues, Art Bible palette, lighting, and seeded Mulberry32 PRNG.
 */
export function synthesizeProceduralSprite(options: ProceduralSpriteOptions): Uint8ClampedArray {
  const { width, height, sketchRgba, adherence, artMode, lighting, seedKey, variantIndex } =
    options;
  const rng = mulberry32(hashString32(seedKey));
  const sortedPalette = resolveSpritePalette(options.palette);

  const outline = sortedPalette[0] ?? { r: 22, g: 24, b: 36 };
  const darkest = outline;
  const brightest = sortedPalette[sortedPalette.length - 1] ?? { r: 244, g: 244, b: 244 };
  const midColors =
    sortedPalette.length >= 3 ? sortedPalette.slice(1, sortedPalette.length - 1) : sortedPalette;

  const primaryIdx = Math.floor(rng() * midColors.length) % midColors.length;
  const secondaryIdx = (primaryIdx + 1 + variantIndex) % midColors.length;
  const primary = midColors[primaryIdx] ?? { r: 177, g: 62, b: 83 };
  const accent = midColors[secondaryIdx] ?? { r: 255, g: 205, b: 117 };
  const highlight = brightest;

  // Contrasting solid flat background (never clashes with silhouette tones)
  const avgLum =
    sortedPalette.reduce((sum, c) => sum + colorLuminance(c), 0) / sortedPalette.length;
  const background: RgbColor = avgLum > 120 ? { r: 24, g: 30, b: 44 } : { r: 226, g: 234, b: 244 };

  const cellSize =
    artMode === 'pixel-art' ? Math.max(2, Math.round(Math.min(width, height) / 32)) : 1;
  const gridW = Math.ceil(width / cellSize);
  const gridH = Math.ceil(height / cellSize);

  const bbox = computeInkBoundingBox(sketchRgba, width, height);
  const fallbackBbox = {
    minX: Math.floor(width * 0.22),
    maxX: Math.floor(width * 0.78),
    minY: Math.floor(height * 0.16),
    maxY: Math.floor(height * 0.84),
  };
  const box = bbox ?? {
    ...fallbackBbox,
    width: fallbackBbox.maxX - fallbackBbox.minX + 1,
    height: fallbackBbox.maxY - fallbackBbox.minY + 1,
    inkCount: 0,
  };

  // Sample coarse occupancy grid from sketch ink
  const rawOcc = new Uint8Array(gridW * gridH);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      let inkHits = 0;
      let totalHits = 0;
      const yStart = gy * cellSize;
      const yEnd = Math.min(height, yStart + cellSize);
      const xStart = gx * cellSize;
      const xEnd = Math.min(width, xStart + cellSize);

      for (let py = yStart; py < yEnd; py++) {
        for (let px = xStart; px < xEnd; px++) {
          const offset = (py * width + px) * 4;
          const lum =
            0.299 * (sketchRgba[offset] ?? 255) +
            0.587 * (sketchRgba[offset + 1] ?? 255) +
            0.114 * (sketchRgba[offset + 2] ?? 255);
          totalHits++;
          if (lum < 165 && (sketchRgba[offset + 3] ?? 255) >= 128) {
            inkHits++;
          }
        }
      }

      const cx = xStart + cellSize * 0.5;
      const cy = yStart + cellSize * 0.5;
      if (bbox) {
        const hasInk = inkHits > 0 && inkHits / Math.max(1, totalHits) >= 0.12;
        if (hasInk) {
          rawOcc[gy * gridW + gx] = 1;
        } else if (adherence !== 'strict') {
          // Synthesize coherent core silhouette inside the sketch bounding box
          const nx = (cx - (box.minX + box.width / 2)) / Math.max(1, box.width / 2);
          const ny = (cy - (box.minY + box.height / 2)) / Math.max(1, box.height / 2);
          const radius = adherence === 'loose' ? 0.85 : 0.65;
          if (nx * nx + ny * ny <= radius * radius && rng() > 0.28) {
            rawOcc[gy * gridW + gx] = 1;
          }
        }
      } else {
        // Fallback procedural RPG crest/knight silhouette when sketch is blank
        const nx = (cx - width / 2) / Math.max(1, width * 0.28);
        const ny = (cy - height / 2) / Math.max(1, height * 0.34);
        const inTorso = Math.abs(nx) < 0.72 && ny > -0.25 && ny < 0.75;
        const inHead = nx * nx + (ny + 0.58) * (ny + 0.58) * 1.4 < 0.28;
        if (inTorso || inHead) {
          rawOcc[gy * gridW + gx] = 1;
        }
      }
    }
  }

  // Span-fill interior gaps horizontally and vertically so outlined sketches become solid sprites
  const filled = new Uint8Array(rawOcc);
  for (let gy = 0; gy < gridH; gy++) {
    let first = -1;
    let last = -1;
    for (let gx = 0; gx < gridW; gx++) {
      if (rawOcc[gy * gridW + gx] === 1) {
        if (first === -1) first = gx;
        last = gx;
      }
    }
    if (first !== -1 && last - first >= 2) {
      const spanLimit = adherence === 'strict' ? Math.max(8, Math.floor(gridW * 0.65)) : gridW;
      if (last - first <= spanLimit) {
        for (let gx = first; gx <= last; gx++) {
          filled[gy * gridW + gx] = 1;
        }
      }
    }
  }

  // Lightly expand silhouette on balanced/loose modes or keep exact in strict
  const silhouette = new Uint8Array(filled);
  if (adherence !== 'strict') {
    for (let gy = 1; gy < gridH - 1; gy++) {
      for (let gx = 1; gx < gridW - 1; gx++) {
        if (
          filled[gy * gridW + gx] === 0 &&
          (filled[gy * gridW + gx - 1] === 1 ||
            filled[gy * gridW + gx + 1] === 1 ||
            filled[(gy - 1) * gridW + gx] === 1 ||
            filled[(gy + 1) * gridW + gx] === 1)
        ) {
          if (rng() > 0.35) {
            silhouette[gy * gridW + gx] = 1;
          }
        }
      }
    }
  }

  const lightDir = lightingVector(lighting);
  const bandFreq = 0.25 + rng() * 0.35;
  const trimRow = Math.floor((box.minY + box.height * (0.38 + rng() * 0.22)) / cellSize);

  const out = new Uint8ClampedArray(width * height * 4);
  for (let gy = 0; gy < gridH; gy++) {
    for (let gx = 0; gx < gridW; gx++) {
      const active = silhouette[gy * gridW + gx] === 1;
      let cellColor: RgbColor;

      if (!active) {
        cellColor = background;
      } else {
        const isBorder =
          gx === 0 ||
          gy === 0 ||
          gx === gridW - 1 ||
          gy === gridH - 1 ||
          silhouette[gy * gridW + gx - 1] === 0 ||
          silhouette[gy * gridW + gx + 1] === 0 ||
          silhouette[(gy - 1) * gridW + gx] === 0 ||
          silhouette[(gy + 1) * gridW + gx] === 0;

        if (isBorder) {
          cellColor = darkest;
        } else {
          const cx = gx * cellSize + cellSize * 0.5;
          const cy = gy * cellSize + cellSize * 0.5;
          const nx = (cx - (box.minX + box.width / 2)) / Math.max(1, box.width / 2);
          const ny = (cy - (box.minY + box.height / 2)) / Math.max(1, box.height / 2);
          const shade = nx * lightDir.lx + ny * lightDir.ly;
          const jitter = (rng() - 0.5) * 0.18;

          const isBeltOrTrim = Math.abs(gy - trimRow) <= 1 || (Math.abs(nx) < 0.22 && ny < -0.1);
          const isRivetPattern = Math.sin(gx * bandFreq + gy * 0.4) > 0.78;

          if (isBeltOrTrim) {
            cellColor = shade + jitter > 0.25 ? highlight : accent;
          } else if (shade + jitter > 0.38 || isRivetPattern) {
            cellColor = highlight;
          } else if (shade + jitter < -0.25) {
            cellColor = adjustRgb(primary, 0.72);
          } else {
            cellColor = primary;
          }
        }
      }

      const yStart = gy * cellSize;
      const yEnd = Math.min(height, yStart + cellSize);
      const xStart = gx * cellSize;
      const xEnd = Math.min(width, xStart + cellSize);

      for (let py = yStart; py < yEnd; py++) {
        for (let px = xStart; px < xEnd; px++) {
          const offset = (py * width + px) * 4;
          out[offset] = cellColor.r;
          out[offset + 1] = cellColor.g;
          out[offset + 2] = cellColor.b;
          out[offset + 3] = 255;
        }
      }
    }
  }

  return out;
}

export interface ProceduralInpaintOptions {
  baseImageRgba: Uint8ClampedArray;
  mask: Uint8Array;
  width: number;
  height: number;
  palette: readonly string[];
  lighting: Lighting;
  seedKey: string;
}

/**
 * Deterministically inpaints strictly inside the binary mask (mask[i] === 1),
 * guaranteeing 100% byte-identical preservation of all unmasked pixels (mask[i] === 0).
 */
export function inpaintProceduralRegion(options: ProceduralInpaintOptions): Uint8ClampedArray {
  const { baseImageRgba, mask, width, height, palette, lighting, seedKey } = options;
  if (baseImageRgba.length !== width * height * 4) {
    throw new Error('Base image RGBA length does not match dimensions.');
  }
  if (mask.length !== width * height) {
    throw new Error('Mask length does not match dimensions.');
  }

  const rng = mulberry32(hashString32(seedKey));
  const sortedPalette = resolveSpritePalette(palette);
  const accentA = sortedPalette[Math.max(0, sortedPalette.length - 2)] ?? {
    r: 255,
    g: 205,
    b: 117,
  };
  const accentB = sortedPalette[Math.min(sortedPalette.length - 1, 1)] ?? {
    r: 177,
    g: 62,
    b: 83,
  };
  const lightDir = lightingVector(lighting);

  const out = new Uint8ClampedArray(baseImageRgba);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      if ((mask[idx] ?? 0) === 0) {
        continue;
      }

      const isMaskBoundary =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        (mask[idx - 1] ?? 0) === 0 ||
        (mask[idx + 1] ?? 0) === 0 ||
        (mask[idx - width] ?? 0) === 0 ||
        (mask[idx + width] ?? 0) === 0;

      const offset = idx * 4;
      const baseR = baseImageRgba[offset] ?? 0;
      const baseG = baseImageRgba[offset + 1] ?? 0;
      const baseB = baseImageRgba[offset + 2] ?? 0;

      const nx = (x / Math.max(1, width)) * 2 - 1;
      const ny = (y / Math.max(1, height)) * 2 - 1;
      const shade = nx * lightDir.lx + ny * lightDir.ly;
      const noise = rng();

      let chosen: RgbColor;
      if (isMaskBoundary) {
        chosen = sortedPalette[0] ?? { r: 26, g: 28, b: 44 };
      } else if (shade + (noise - 0.5) * 0.4 > 0.1) {
        chosen = accentA;
      } else {
        chosen = accentB;
      }

      // Guarantee masked pixel visibly diverges from original pixel if colors happen to collide
      if (chosen.r === baseR && chosen.g === baseG && chosen.b === baseB) {
        chosen = {
          r: (chosen.r + 64) % 256,
          g: (chosen.g + 96) % 256,
          b: (chosen.b + 128) % 256,
        };
      }

      out[offset] = chosen.r;
      out[offset + 1] = chosen.g;
      out[offset + 2] = chosen.b;
      out[offset + 3] = 255;
    }
  }

  return out;
}

export interface ProceduralTurnaroundOptions {
  layout: TurnaroundLayout;
  palette: readonly string[];
  seedKey: string;
  variantIndex: number;
}

function drawFilledBox(
  buf: Uint8ClampedArray,
  canvasW: number,
  canvasH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: RgbColor,
): void {
  for (let py = y; py < y + h; py++) {
    if (py < 0 || py >= canvasH) continue;
    for (let px = x; px < x + w; px++) {
      if (px < 0 || px >= canvasW) continue;
      const off = (py * canvasW + px) * 4;
      buf[off] = color.r;
      buf[off + 1] = color.g;
      buf[off + 2] = color.b;
      buf[off + 3] = 255;
    }
  }
}

/**
 * Synthesizes an orthographic 4-view turnaround test sheet (`128x128` for `2x2` or
 * `256x64` for `1x4`) with flat contrasting background, detached floating crown accessory,
 * distinct directional silhouettes, and intentional 10% height drift in Slot 1 (East).
 */
export function synthesizeProceduralTurnaroundSheet(options: ProceduralTurnaroundOptions): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  const { layout, palette, seedKey, variantIndex } = options;
  const width = layout === '2x2' ? 128 : 256;
  const height = layout === '2x2' ? 128 : 64;
  const rgba = new Uint8ClampedArray(width * height * 4);

  const sorted = resolveSpritePalette(palette);
  const darkInk = sorted[0] ?? { r: 26, g: 28, b: 44 };
  const primary = sorted[Math.min(sorted.length - 1, 2)] ?? { r: 177, g: 62, b: 83 };
  const secondary = sorted[Math.min(sorted.length - 1, 3)] ?? { r: 239, g: 125, b: 87 };
  const highlight = sorted[sorted.length - 1] ?? { r: 255, g: 205, b: 117 };
  const rng = mulberry32(hashString32(`${seedKey}|turnaround|${variantIndex}`));

  // Contrast backdrop guaranteed distinct from character colors (corner sample safe for color-key)
  const bgColor: RgbColor = { r: 16, g: 24, b: 40 };
  drawFilledBox(rgba, width, height, 0, 0, width, height, bgColor);

  const tintShift = variantIndex % 2 === 1 ? 1.08 : 1.0;
  const bodyTone = adjustRgb(primary, tintShift);
  const capeTone = adjustRgb(secondary, 0.92 + rng() * 0.08);
  const eyeTone: RgbColor = { r: 244, g: 244, b: 244 };
  const goldCrown: RgbColor = highlight;

  for (let slot = 0; slot < 4; slot++) {
    const slotX = layout === '2x2' ? (slot % 2) * 64 : slot * 64;
    const slotY = layout === '2x2' && slot >= 2 ? 64 : 0;

    // Slot 1 (East) is intentionally 10% taller (44px vs 40px) so height normalization works visually
    const charH = slot === 1 ? 44 : 40;
    const baselineY = slotY + 54;
    const topY = baselineY - charH;
    const centerX = slotX + 32;

    if (slot === 0) {
      // South (Front): detached 6x4 floating crown (24px >= 16) 2px above head + symmetric front body
      drawFilledBox(rgba, width, height, centerX - 3, topY, 6, 4, goldCrown);
      drawFilledBox(rgba, width, height, centerX - 8, topY + 6, 16, 12, darkInk);
      drawFilledBox(rgba, width, height, centerX - 6, topY + 8, 12, 8, bodyTone);
      drawFilledBox(rgba, width, height, centerX - 4, topY + 10, 2, 3, eyeTone);
      drawFilledBox(rgba, width, height, centerX + 2, topY + 10, 2, 3, eyeTone);
      drawFilledBox(rgba, width, height, centerX - 10, topY + 18, 20, 14, capeTone);
      drawFilledBox(rgba, width, height, centerX - 7, baselineY - 8, 5, 8, darkInk);
      drawFilledBox(rgba, width, height, centerX + 2, baselineY - 8, 5, 8, darkInk);
    } else if (slot === 1) {
      // East (Right): taller 44px profile facing +X with golden blade extended to the right
      drawFilledBox(rgba, width, height, centerX - 7, topY, 14, 15, darkInk);
      drawFilledBox(rgba, width, height, centerX - 4, topY + 2, 9, 10, bodyTone);
      drawFilledBox(rgba, width, height, centerX + 2, topY + 5, 3, 3, eyeTone);
      drawFilledBox(rgba, width, height, centerX - 8, topY + 15, 16, 19, bodyTone);
      drawFilledBox(rgba, width, height, centerX + 8, topY + 17, 10, 4, goldCrown);
      drawFilledBox(rgba, width, height, centerX - 4, baselineY - 10, 8, 10, darkInk);
    } else if (slot === 2) {
      // North (Back): covered silhouette by cape + darker hood
      drawFilledBox(rgba, width, height, centerX - 8, topY, 16, 13, darkInk);
      drawFilledBox(rgba, width, height, centerX - 11, topY + 13, 22, 20, capeTone);
      drawFilledBox(rgba, width, height, centerX - 4, topY + 15, 8, 10, darkInk);
      drawFilledBox(rgba, width, height, centerX - 7, baselineY - 7, 5, 7, darkInk);
      drawFilledBox(rgba, width, height, centerX + 2, baselineY - 7, 5, 7, darkInk);
    } else {
      // West (Left): intentionally distinct un-mirrored blue/silver shield so Mirror East->West visibly flips
      drawFilledBox(rgba, width, height, centerX - 7, topY, 14, 13, darkInk);
      drawFilledBox(rgba, width, height, centerX - 5, topY + 2, 9, 9, bodyTone);
      drawFilledBox(rgba, width, height, centerX - 5, topY + 5, 3, 3, eyeTone);
      drawFilledBox(rgba, width, height, centerX - 8, topY + 13, 16, 19, capeTone);
      drawFilledBox(rgba, width, height, centerX - 16, topY + 14, 8, 14, {
        r: 90,
        g: 170,
        b: 250,
      });
      drawFilledBox(rgba, width, height, centerX - 4, baselineY - 8, 8, 8, darkInk);
    }
  }

  return { rgba, width, height };
}
