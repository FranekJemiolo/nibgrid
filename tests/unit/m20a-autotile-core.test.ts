import { describe, expect, it } from 'vitest';
import {
  BIT_E,
  BIT_N,
  BIT_NE,
  BIT_NW,
  BIT_S,
  BIT_SE,
  BIT_SW,
  BIT_W,
  composeAutoTileSheet,
  computeAutoTileGridMask,
  gateBlobMask,
  getCanonicalBlob47Masks,
} from '../../src/processing/autoTile';
import type { RgbaBuffer } from '../../src/processing/types';

function makeSolidTile(width: number, height: number, r = 90, g = 180, b = 110): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const p = i * 4;
    data[p] = r;
    data[p + 1] = g;
    data[p + 2] = b;
    data[p + 3] = 255;
  }
  return { width, height, data };
}

describe('M20A: Pure-TS Auto-Tile Bitmask Gating & SDF Compositor', () => {
  it('gates redundant diagonals strictly and yields exactly 47 canonical Blob masks', () => {
    expect(gateBlobMask(BIT_NE)).toBe(0);
    expect(gateBlobMask(BIT_N | BIT_NE)).toBe(BIT_N);
    expect(gateBlobMask(BIT_N | BIT_E | BIT_NE)).toBe(BIT_N | BIT_E | BIT_NE);
    expect(gateBlobMask(BIT_S | BIT_W | BIT_SW | BIT_NW)).toBe(BIT_S | BIT_W | BIT_SW);

    const masks = getCanonicalBlob47Masks();
    expect(masks).toHaveLength(47);
    expect(new Set(masks).size).toBe(47);
    expect(masks[0]).toBe(0);
    expect(masks[masks.length - 1]).toBe(
      BIT_N | BIT_NE | BIT_E | BIT_SE | BIT_S | BIT_SW | BIT_W | BIT_NW,
    );
  });

  it('packs 16x16 blob-47 into 128x96 with mask 255 100% opaque under organic-overhang jitter', () => {
    const fill = makeSolidTile(16, 16);
    const result = composeAutoTileSheet(fill, null, {
      mode: 'blob-47',
      edgeStyle: 'organic-overhang',
      borderWidthPx: 3,
      cornerRadiusPx: 4,
      jitterPx: 3,
      edgeTintHex: '#1A1C2C',
      seed: 1337,
    });

    expect(result.columns).toBe(8);
    expect(result.rows).toBe(6);
    expect(result.sheet.width).toBe(128);
    expect(result.sheet.height).toBe(96);
    expect(result.cells).toHaveLength(47);

    const solidIdx = result.maskToCellIndex[255];
    expect(solidIdx).toBeDefined();
    const solidCell = result.cells[solidIdx!]!;
    const ox = solidCell.col * 16;
    const oy = solidCell.row * 16;

    // Mask 255 (fully surrounded) must remain 100% opaque across every pixel
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const a = result.sheet.data[((oy + y) * 128 + (ox + x)) * 4 + 3];
        expect(a).toBe(255);
      }
    }

    // Isolated mask 0 must carve out outer border pixels cleanly (transparent corner without underlay)
    const isoCell = result.cells[result.maskToCellIndex[0]!]!;
    const cornerAlpha = result.sheet.data[(isoCell.row * 16 * 128 + isoCell.col * 16) * 4 + 3];
    expect(cornerAlpha).toBe(0);
  });

  it('packs 16x16 wang-16 into 64x64 with mask 0 transparent and mask 15 100% opaque', () => {
    const fill = makeSolidTile(16, 16, 60, 140, 210);
    const result = composeAutoTileSheet(fill, null, {
      mode: 'wang-16',
      edgeStyle: 'pixel-outline',
      borderWidthPx: 2,
      cornerRadiusPx: 3,
      jitterPx: 0,
      edgeTintHex: '#111113',
      seed: 42,
    });

    expect(result.columns).toBe(4);
    expect(result.rows).toBe(4);
    expect(result.sheet.width).toBe(64);
    expect(result.sheet.height).toBe(64);
    expect(result.cells).toHaveLength(16);

    const zeroCell = result.cells[result.maskToCellIndex[0]!]!;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const a =
          result.sheet.data[((zeroCell.row * 16 + y) * 64 + (zeroCell.col * 16 + x)) * 4 + 3];
        expect(a).toBe(0);
      }
    }

    const fullCell = result.cells[result.maskToCellIndex[15]!]!;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const a =
          result.sheet.data[((fullCell.row * 16 + y) * 64 + (fullCell.col * 16 + x)) * 4 + 3];
        expect(a).toBe(255);
      }
    }
  });

  it('throws descriptive error on non-square fill tile and is byte-identical deterministic', () => {
    expect(() =>
      composeAutoTileSheet(makeSolidTile(16, 24), null, {
        mode: 'blob-47',
        edgeStyle: 'crisp-bevel',
        borderWidthPx: 2,
        cornerRadiusPx: 3,
        jitterPx: 0,
        edgeTintHex: '#1A1C2C',
        seed: 7,
      }),
    ).toThrow(/square/i);

    const fill = makeSolidTile(16, 16);
    const underlay = makeSolidTile(8, 8, 40, 40, 50);
    const opts = {
      mode: 'blob-47' as const,
      edgeStyle: 'organic-overhang' as const,
      borderWidthPx: 3,
      cornerRadiusPx: 4,
      jitterPx: 1.5,
      edgeTintHex: '#1A1C2C',
      seed: 99,
    };
    const runA = composeAutoTileSheet(fill, underlay, opts);
    const runB = composeAutoTileSheet(fill, underlay, opts);
    expect(Buffer.compare(Buffer.from(runA.sheet.data), Buffer.from(runB.sheet.data))).toBe(0);
  });

  it('computes neighborhood masks accurately for boolean terrain grids', () => {
    const grid = [true, true, false, true, true, false, false, false, false];
    expect(computeAutoTileGridMask(grid, 3, 3, 0, 0, 'blob-47')).toBe(BIT_E | BIT_SE | BIT_S);
    expect(computeAutoTileGridMask(grid, 3, 3, 0, 0, 'wang-16')).toBe(15);
  });

  it('highlights top-exposed wang-16 crisp-bevel edges (mask = 3 has NW|NE open)', () => {
    const fill = makeSolidTile(16, 16, 100, 120, 140);
    const result = composeAutoTileSheet(fill, null, {
      mode: 'wang-16',
      edgeStyle: 'crisp-bevel',
      borderWidthPx: 2,
      cornerRadiusPx: 3,
      jitterPx: 0,
      edgeTintHex: '#101010',
      seed: 1,
    });
    // mask 3 = SE(2) | SW(1) -> top half is open so top bevel edge gets +28 highlight
    const cell = result.cells[result.maskToCellIndex[3]!]!;
    const ox = cell.col * 16;
    const oy = cell.row * 16;
    let foundHighlight = false;
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        const idx = ((oy + y) * result.sheet.width + (ox + x)) * 4;
        if ((result.sheet.data[idx + 3] ?? 0) > 0 && (result.sheet.data[idx] ?? 0) === 128) {
          foundHighlight = true;
        }
      }
    }
    expect(foundHighlight).toBe(true);
  });
});
