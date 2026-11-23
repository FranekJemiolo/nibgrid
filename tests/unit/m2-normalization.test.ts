import { describe, expect, it } from 'vitest';
import { CanvasHistory } from '../../src/processing/history';
import {
  alignToSafeMargin,
  computeInkBoundingBox,
  extractLinesAndContrast,
  sha256Bytes,
} from '../../src/processing/normalize';
import { encodeRgbaToPngBytes } from '../../src/processing/png';

describe('M2 Pure-TS Image Normalization & Hashing', () => {
  it('extracts dark ink from noisy #C8C8C8 paper and centers silhouette within 10% safe margin', () => {
    const width = 100;
    const height = 100;
    const rgba = new Uint8ClampedArray(width * height * 4);

    // Fill with noisy #C8C8C8 paper background (luminance ~200 +/- 12)
    let prng = 12345;
    for (let i = 0; i < width * height; i++) {
      prng = (prng * 1664525 + 1013904223) >>> 0;
      const delta = (prng % 25) - 12;
      const val = Math.max(0, Math.min(255, 200 + delta));
      const px = i * 4;
      rgba[px] = val;
      rgba[px + 1] = val;
      rgba[px + 2] = val;
      rgba[px + 3] = 255;
    }

    // Draw an off-center dark rectangle: x in [5..24], y in [70..89] (20x20)
    for (let y = 70; y <= 89; y++) {
      for (let x = 5; x <= 24; x++) {
        const px = (y * width + x) * 4;
        rgba[px] = 24;
        rgba[px + 1] = 24;
        rgba[px + 2] = 24;
        rgba[px + 3] = 255;
      }
    }

    const contrast = extractLinesAndContrast(rgba, width, height);

    // Top-right corner background must be crisp pure white
    expect(contrast[0]).toBe(255);
    expect(contrast[1]).toBe(255);
    expect(contrast[2]).toBe(255);

    // Original rectangle interior must be pure black ink
    const inkOffset = (80 * width + 14) * 4;
    expect(contrast[inkOffset]).toBe(0);
    expect(contrast[inkOffset + 1]).toBe(0);
    expect(contrast[inkOffset + 2]).toBe(0);

    const aligned = alignToSafeMargin(contrast, width, height, 100, 0.1);
    const bbox = computeInkBoundingBox(aligned, 100, 100);
    expect(bbox).not.toBeNull();
    expect(bbox!.minX).toBeGreaterThanOrEqual(10);
    expect(bbox!.maxX).toBeLessThan(90);
    expect(bbox!.minY).toBeGreaterThanOrEqual(10);
    expect(bbox!.maxY).toBeLessThan(90);

    const centerX = (bbox!.minX + bbox!.maxX) / 2;
    const centerY = (bbox!.minY + bbox!.maxY) / 2;
    expect(Math.abs(centerX - 49.5)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(centerY - 49.5)).toBeLessThanOrEqual(1.5);
  });

  it('produces deterministic SHA-256 digests and detects 1-pixel mutations', async () => {
    const bufA = new Uint8ClampedArray(16 * 16 * 4).fill(255);
    bufA[0] = 10;
    const bufB = new Uint8ClampedArray(bufA);

    const pngA = encodeRgbaToPngBytes(bufA, 16, 16);
    const pngB = encodeRgbaToPngBytes(bufB, 16, 16);

    const digestA1 = await sha256Bytes(pngA);
    const digestA2 = await sha256Bytes(pngA);
    const digestB = await sha256Bytes(pngB);
    expect(digestA1).toMatch(/^[0-9a-f]{64}$/);
    expect(digestA1).toBe(digestA2);
    expect(digestA1).toBe(digestB);

    // Mutate 1 pixel
    bufB[4] = 9;
    const mutatedPng = encodeRgbaToPngBytes(bufB, 16, 16);
    const mutatedDigest = await sha256Bytes(mutatedPng);
    expect(mutatedDigest).not.toBe(digestA1);
  });

  it('enforces bounded CanvasHistory depth (20) and restores exact snapshots on undo/redo', () => {
    const initial = new Uint8ClampedArray([0, 0, 0, 255]);
    const history = new CanvasHistory(initial, 20);
    expect(history.size()).toBe(1);
    expect(history.canUndo()).toBe(false);

    // Push 25 distinct states -> total retained must be capped at 20 (values 6..25)
    for (let step = 1; step <= 25; step++) {
      history.push(new Uint8ClampedArray([step, 0, 0, 255]));
    }
    expect(history.size()).toBe(20);
    expect(history.current()?.[0]).toBe(25);

    const undone = history.undo();
    expect(undone?.[0]).toBe(24);
    expect(history.canRedo()).toBe(true);

    // Mutate returned buffer to verify internal snapshot isolation
    undone![0] = 255;
    expect(history.current()?.[0]).toBe(24);

    const redone = history.redo();
    expect(redone?.[0]).toBe(25);
    expect(history.canRedo()).toBe(false);

    // Walk back 19 times to reach oldest retained snapshot (step 6)
    let stepsBack = 0;
    while (history.canUndo()) {
      history.undo();
      stepsBack++;
    }
    expect(stepsBack).toBe(19);
    expect(history.current()?.[0]).toBe(6);
  });
});

