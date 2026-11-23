import { describe, expect, it } from 'vitest';
import { BIOME_PRESETS, generateBiomeTile, type BiomeId } from '../../src/processing/sandboxBiomes';
import { computeBiomeContrast, relativeLuminance } from '../../src/processing/sandboxContrast';
import {
  createInitialSandboxState,
  FLASH_DECAY_DURATION_MS,
  HITSTOP_DURATION_MS,
  stepSandboxState,
  triggerHit,
  type SandboxInputState,
} from '../../src/processing/sandboxState';
import type { RgbaBuffer } from '../../src/processing/types';

function meanTileLuminance(buf: RgbaBuffer): number {
  let sum = 0;
  const total = buf.width * buf.height;
  for (let i = 0; i < buf.data.length; i += 4) {
    sum += relativeLuminance(buf.data[i] ?? 0, buf.data[i + 1] ?? 0, buf.data[i + 2] ?? 0);
  }
  return sum / Math.max(1, total);
}

function makeSolidSquare(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
  a: number,
): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { width, height, data };
}

describe('M13 1x Game Scale Sandbox Core Invariants', () => {
  it('generates byte-identical deterministic 64x64 biomes with alpha=255 and ordered luminance', () => {
    const lumByBiome: Record<BiomeId, number> = {
      'dark-dungeon': 0,
      'urban-asphalt': 0,
      'sunlit-meadow': 0,
      'neutral-checker': 0,
      'bright-snow': 0,
    };

    for (const preset of BIOME_PRESETS) {
      const a = generateBiomeTile(preset.id, 64);
      const b = generateBiomeTile(preset.id, 64);

      expect(a.width).toBe(64);
      expect(a.height).toBe(64);
      expect(a.data).toEqual(b.data);

      for (let i = 3; i < a.data.length; i += 4) {
        expect(a.data[i]).toBe(255);
      }
      lumByBiome[preset.id] = meanTileLuminance(a);
    }

    expect(lumByBiome['dark-dungeon']).toBeLessThan(lumByBiome['sunlit-meadow']);
    expect(lumByBiome['sunlit-meadow']).toBeLessThan(lumByBiome['bright-snow']);
    expect(lumByBiome['dark-dungeon']).toBeLessThan(lumByBiome['urban-asphalt']);
    expect(lumByBiome['urban-asphalt']).toBeLessThan(lumByBiome['neutral-checker']);
    expect(lumByBiome['neutral-checker']).toBeLessThan(lumByBiome['bright-snow']);
  });

  it('scores extreme perimeter contrast accurately and avoids NaN on empty sprites', () => {
    const dungeon = generateBiomeTile('dark-dungeon', 64);

    // 1. Bright white sprite over dark dungeon => Strong >= 8.0:1
    const whiteSquare = makeSolidSquare(16, 16, 255, 255, 255, 255);
    const whiteReport = computeBiomeContrast(whiteSquare, dungeon);
    expect(whiteReport.rating).toBe('strong');
    expect(whiteReport.contrastRatio).toBeGreaterThanOrEqual(8.0);
    expect(whiteReport.readableEdgePercent).toBe(100);

    // 2. Near-black #141414 sprite over dark dungeon => Weak < 2.0:1 + rim-light suggestion
    const darkSquare = makeSolidSquare(16, 16, 20, 20, 20, 255);
    const darkReport = computeBiomeContrast(darkSquare, dungeon);
    expect(darkReport.rating).toBe('weak');
    expect(darkReport.contrastRatio).toBeLessThan(2.0);
    expect(darkReport.suggestion).toMatch(/rim-light|Inner Sel-Out/i);

    // 3. Fully transparent buffer => safe weak fallback with zero NaN values
    const transparent = makeSolidSquare(16, 16, 0, 0, 0, 0);
    const emptyReport = computeBiomeContrast(transparent, dungeon);
    expect(emptyReport.edgePixelCount).toBe(0);
    expect(emptyReport.rating).toBe('weak');
    expect(emptyReport.contrastRatio).toBe(1);
    expect(Number.isNaN(emptyReport.edgeLuminance)).toBe(false);
    expect(Number.isNaN(emptyReport.biomeLuminance)).toBe(false);
    expect(Number.isNaN(emptyReport.contrastRatio)).toBe(false);
    expect(Number.isNaN(emptyReport.readableEdgePercent)).toBe(false);
  });

  it('enforces 40ms hitstop freeze followed by 110ms monotonic linear flash decay and shake settle', () => {
    const input: SandboxInputState = {
      moveX: 1,
      moveY: 0,
      moveSpeedPxPerSec: 100,
      scrollSpeedPxPerSec: 60,
      cameraWidth: 320,
      cameraHeight: 180,
      playing: true,
      fps: 12,
      frameCount: 6,
      pingPong: false,
    };

    const hit0 = triggerHit(
      createInitialSandboxState({ posX: 120, posY: 110, scrollOffsetX: 25, frameIndex: 2 }),
    );
    expect(hit0.hitstopRemainingMs).toBe(HITSTOP_DURATION_MS);
    expect(hit0.flashRemainingMs).toBe(FLASH_DECAY_DURATION_MS);
    expect(hit0.flashAlpha).toBe(1);

    // Advance 20ms + 20ms = 40ms hitstop: movement, scroll, and anim must remain frozen
    const hit20 = stepSandboxState(hit0, input, 20);
    const hit40 = stepSandboxState(hit20, input, 20);
    expect(hit40.hitstopRemainingMs).toBe(0);
    expect(hit40.posX).toBe(120);
    expect(hit40.scrollOffsetX).toBe(25);
    expect(hit40.frameIndex).toBe(2);
    expect(hit40.flashAlpha).toBe(1);

    // Advance through 110ms post-hitstop flash decay (35ms + 40ms + 35ms)
    const decay1 = stepSandboxState(hit40, input, 35);
    const decay2 = stepSandboxState(decay1, input, 40);
    const decay3 = stepSandboxState(decay2, input, 35);

    expect(decay1.flashAlpha).toBeGreaterThan(decay2.flashAlpha);
    expect(decay2.flashAlpha).toBeGreaterThan(decay3.flashAlpha);
    expect(decay3.flashAlpha).toBe(0);
    expect(decay3.flashRemainingMs).toBe(0);

    // Scroll & movement resume after hitstop and camera shake / knockback settle cleanly to 0
    expect(decay3.scrollOffsetX).toBeGreaterThan(25);
    expect(decay3.posX).toBeGreaterThan(120);
    expect(decay3.shakeOffsetX).toBe(0);
    expect(decay3.shakeOffsetY).toBe(0);
    expect(decay3.knockbackOffsetX).toBe(0);
  });
});
