import { describe, expect, it } from 'vitest';
import {
  extractCollisionHull,
  traceMarchingSquaresContours,
} from '../../src/processing/collisionHull';
import type { RgbaBuffer } from '../../src/processing/types';

function createBuffer(width: number, height: number): RgbaBuffer {
  return {
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
}

function fillRect(
  buf: RgbaBuffer,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  alpha = 255,
): void {
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (x < 0 || y < 0 || x >= buf.width || y >= buf.height) continue;
      const idx = (y * buf.width + x) * 4;
      buf.data[idx] = 255;
      buf.data[idx + 1] = 255;
      buf.data[idx + 2] = 255;
      buf.data[idx + 3] = alpha;
    }
  }
}

describe('M16A Pure-TS Marching Squares, Closed RDP & Convex Hull', () => {
  it('traces exact 20x20 square with pivotPx at bottom center placing bottom edge at y === 0', () => {
    const buf = createBuffer(64, 64);
    fillRect(buf, 22, 22, 42, 42);

    const shape = extractCollisionHull(buf, {
      kind: 'convex-hull',
      epsilonPx: 1,
      pivotPx: { x: 32, y: 42 },
    });

    expect(shape.vertices).toHaveLength(4);
    expect(shape.isConvex).toBe(true);
    expect(shape.areaPx).toBeGreaterThanOrEqual(370);
    expect(shape.areaPx).toBeLessThanOrEqual(410);
    const maxY = Math.max(...shape.vertices.map((v) => v.y));
    expect(maxY).toBe(0);
  });

  it('distinguishes concave L-shape polygon from convex hull with larger hull area', () => {
    const buf = createBuffer(48, 48);
    // 32x32 L-shape occupying x in [8..40), y in [8..40)
    fillRect(buf, 8, 8, 20, 40);
    fillRect(buf, 8, 28, 40, 40);

    const poly = extractCollisionHull(buf, {
      kind: 'polygon',
      epsilonPx: 1.5,
    });
    const hull = extractCollisionHull(buf, {
      kind: 'convex-hull',
      epsilonPx: 1.5,
    });

    expect(poly.isConvex).toBe(false);
    expect(poly.vertices).toHaveLength(6);
    expect(hull.isConvex).toBe(true);
    expect(hull.vertices).toHaveLength(5);
    expect(hull.areaPx).toBeGreaterThan(poly.areaPx);
  });

  it('enforces maxVertices <= 8 budget on a 32-sided/circular mask while staying convex', () => {
    const buf = createBuffer(64, 64);
    const cx = 32;
    const cy = 32;
    const r = 22;
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r * r) {
          const idx = (y * 64 + x) * 4;
          buf.data[idx] = 200;
          buf.data[idx + 1] = 230;
          buf.data[idx + 2] = 255;
          buf.data[idx + 3] = 255;
        }
      }
    }

    const capped = extractCollisionHull(buf, {
      kind: 'convex-hull',
      epsilonPx: 0.75,
      maxVertices: 8,
    });

    expect(capped.vertices.length).toBeLessThanOrEqual(8);
    expect(capped.vertices.length).toBeGreaterThanOrEqual(3);
    expect(capped.isConvex).toBe(true);
  });

  it('handles edge-touching opaque buffer cleanly and empty transparent buffer without NaN', () => {
    const full = createBuffer(16, 16);
    fillRect(full, 0, 0, 16, 16);
    const contours = traceMarchingSquaresContours(full, 128);
    expect(contours).toHaveLength(1);

    const fullHull = extractCollisionHull(full, {
      kind: 'convex-hull',
      epsilonPx: 1,
    });
    expect(fullHull.vertices).toHaveLength(4);
    expect(fullHull.isConvex).toBe(true);
    expect(fullHull.areaPx).toBeGreaterThan(220);

    const empty = createBuffer(16, 16);
    const emptyHull = extractCollisionHull(empty, { kind: 'convex-hull' });
    expect(emptyHull.vertices).toEqual([]);
    expect(emptyHull.isConvex).toBe(false);
    expect(emptyHull.areaPx).toBe(0);
    expect(Number.isNaN(emptyHull.areaPx)).toBe(false);
  });

  it('computes tight vertical capsule dimensions for tall 16x40 sprite', () => {
    const buf = createBuffer(64, 64);
    fillRect(buf, 24, 12, 40, 52);

    const cap = extractCollisionHull(buf, {
      kind: 'capsule',
      pivotPx: { x: 32, y: 52 },
    });

    expect(cap.kind).toBe('capsule');
    expect(cap.capsule).toBeDefined();
    expect(cap.capsule?.orientation).toBe('vertical');
    expect(cap.capsule?.radius).toBeGreaterThanOrEqual(7.5);
    expect(cap.capsule?.radius).toBeLessThanOrEqual(8.5);
    expect(cap.capsule?.height).toBeGreaterThanOrEqual(39);
    expect(cap.capsule?.height).toBeLessThanOrEqual(41);
    expect(cap.capsule?.cx).toBeCloseTo(0, 0);
  });
});
