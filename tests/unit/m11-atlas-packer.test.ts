import { describe, expect, it } from 'vitest';
import {
  exportGodotTres,
  exportPhaserMultiatlasJson,
  exportPixiJson,
} from '../../src/export/atlasExporters';
import { composeAtlasPages, type AtlasFrameInput } from '../../src/processing/atlasCompositor';
import { packMaxRects, type PackInputItem } from '../../src/processing/maxRects';
import type { RgbaBuffer } from '../../src/processing/types';

function makeSolidSprite(
  width: number,
  height: number,
  r: number,
  g: number,
  b: number,
): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r;
    data[i * 4 + 1] = g;
    data[i * 4 + 2] = b;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function makeNormalBlock(width: number, height: number, nx = 140, ny = 200): RgbaBuffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = nx;
    data[i * 4 + 1] = ny;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

describe('M11 MaxRects Atlas Packer, Extrusion & Engine Exporters', () => {
  it('packs 40 mixed sprites with zero pairwise envelope overlaps and valid bounds', () => {
    const items: PackInputItem[] = Array.from({ length: 40 }, (_, i) => ({
      id: `sprite_${i}`,
      width: 16 + ((i * 19) % 113), // 16..128
      height: 16 + ((i * 23) % 81), // 16..96
    }));

    const padding = 2;
    const extrude = 1;
    const pages = packMaxRects(items, {
      maxWidth: 1024,
      maxHeight: 1024,
      padding,
      extrude,
      powerOfTwo: true,
      allowRotation: true,
    });

    expect(pages.length).toBeGreaterThanOrEqual(1);
    const placedIds = new Set<string>();

    for (const page of pages) {
      for (let i = 0; i < page.rects.length; i++) {
        const a = page.rects[i]!;
        placedIds.add(a.id);

        // Bounds invariant incl. extrusion margin
        expect(a.x - extrude).toBeGreaterThanOrEqual(0);
        expect(a.y - extrude).toBeGreaterThanOrEqual(0);
        expect(a.x + a.width + extrude).toBeLessThanOrEqual(page.width);
        expect(a.y + a.height + extrude).toBeLessThanOrEqual(page.height);

        // Zero pairwise overlap including extrude + padding gap
        const ax0 = a.x - extrude;
        const ay0 = a.y - extrude;
        const ax1 = a.x + a.width + extrude + padding;
        const ay1 = a.y + a.height + extrude + padding;

        for (let j = i + 1; j < page.rects.length; j++) {
          const b = page.rects[j]!;
          const bx0 = b.x - extrude;
          const by0 = b.y - extrude;
          const bx1 = b.x + b.width + extrude + padding;
          const by1 = b.y + b.height + extrude + padding;
          const overlaps = ax0 < bx1 && ax1 > bx0 && ay0 < by1 && ay1 > by0;
          expect(overlaps).toBe(false);
        }
      }
    }

    expect(placedIds.size).toBe(40);
  });

  it('deterministically deduplicates identical frames across 5 input shuffles', () => {
    const dupSprite = makeSolidSprite(16, 16, 220, 40, 60);
    const otherSpriteA = makeSolidSprite(24, 16, 40, 200, 100);
    const otherSpriteB = makeSolidSprite(12, 20, 40, 120, 240);

    const baseInputs: AtlasFrameInput[] = [
      { id: 'hero_idle_0', sprite: dupSprite, animationName: 'hero_idle' },
      {
        id: 'hero_idle_1',
        sprite: makeSolidSprite(16, 16, 220, 40, 60),
        animationName: 'hero_idle',
      },
      {
        id: 'hero_idle_2',
        sprite: makeSolidSprite(16, 16, 220, 40, 60),
        animationName: 'hero_idle',
      },
      { id: 'prop_chest', sprite: otherSpriteA },
      { id: 'prop_gem', sprite: otherSpriteB },
    ];

    const opts = {
      maxWidth: 256,
      maxHeight: 256,
      padding: 2,
      extrude: 1,
      powerOfTwo: true,
      allowRotation: false,
    };

    const baseline = composeAtlasPages(baseInputs, opts);
    expect(baseline.totalInputCount).toBe(5);
    expect(baseline.uniquePackedCount).toBe(3);
    expect(baseline.deduplicatedCount).toBe(2);

    const idleFrames = baseline.frames.filter((f) => f.id.startsWith('hero_idle_'));
    expect(idleFrames).toHaveLength(3);
    expect(idleFrames[1]!.rect).toEqual(idleFrames[0]!.rect);
    expect(idleFrames[2]!.rect).toEqual(idleFrames[0]!.rect);

    // Shuffle 5 times and verify identical coordinates for every frame ID
    const baselineCoords = new Map(baseline.frames.map((f) => [f.id, f.rect]));
    for (let s = 0; s < 5; s++) {
      const shuffled = [...baseInputs].reverse().sort((_, __) => (s % 2 === 0 ? 1 : -1));
      const res = composeAtlasPages(shuffled, opts);
      for (const f of res.frames) {
        const expected = baselineCoords.get(f.id)!;
        expect(f.rect.x).toBe(expected.x);
        expect(f.rect.y).toBe(expected.y);
        expect(f.rect.width).toBe(expected.width);
        expect(f.rect.height).toBe(expected.height);
      }
    }
  });

  it('preserves exact pixels, 1px clamped extrusion, neutral normal gutters, and exporter schemas', () => {
    const inputs: AtlasFrameInput[] = [
      {
        id: 'f0',
        sprite: makeSolidSprite(12, 12, 200, 30, 50),
        normalMap: makeNormalBlock(12, 12, 150, 190),
      },
      {
        id: 'f1',
        sprite: makeSolidSprite(10, 14, 30, 200, 90),
        normalMap: makeNormalBlock(10, 14, 110, 170),
      },
      {
        id: 'f2',
        sprite: makeSolidSprite(14, 10, 40, 90, 210),
        normalMap: makeNormalBlock(14, 10, 128, 220),
      },
      {
        id: 'f3',
        sprite: makeSolidSprite(8, 8, 240, 210, 60),
        normalMap: makeNormalBlock(8, 8, 200, 128),
      },
    ];

    const atlas = composeAtlasPages(inputs, {
      maxWidth: 256,
      maxHeight: 256,
      padding: 2,
      extrude: 1,
      powerOfTwo: true,
      allowRotation: true, // should lock to false automatically because normalMap is present
      disableRotationForEngine: false,
    });

    const page = atlas.pages[0]!;
    expect(page.normal).toBeDefined();

    for (const frame of atlas.frames) {
      expect(frame.rect.rotated).toBe(false);
      const src = inputs.find((i) => i.id === frame.id)!.sprite;

      // Interior RGBA round-trip check
      for (let y = 0; y < frame.rect.height; y++) {
        for (let x = 0; x < frame.rect.width; x++) {
          const dIdx = ((frame.rect.y + y) * page.width + (frame.rect.x + x)) * 4;
          const sIdx = (y * src.width + x) * 4;
          expect(page.albedo.data[dIdx]).toBe(src.data[sIdx]);
          expect(page.albedo.data[dIdx + 1]).toBe(src.data[sIdx + 1]);
          expect(page.albedo.data[dIdx + 2]).toBe(src.data[sIdx + 2]);
          expect(page.albedo.data[dIdx + 3]).toBe(src.data[sIdx + 3]);
        }
      }

      // 1px extruded left border matches adjacent edge column x=0
      const extLeftIdx = (frame.rect.y * page.width + (frame.rect.x - 1)) * 4;
      expect(page.albedo.data[extLeftIdx]).toBe(src.data[0]);
      expect(page.albedo.data[extLeftIdx + 3]).toBe(255);
    }

    // Empty gutter pixel at bottom-right corner must be neutral normal (128, 128, 255, 0)
    const gutterIdx = (page.width * page.height - 1) * 4;
    expect(Array.from(page.normal!.data.slice(gutterIdx, gutterIdx + 4))).toEqual([
      128, 128, 255, 0,
    ]);

    // Validate PixiJS, Phaser 3, and Godot 4 exporters
    const pixi = exportPixiJson(atlas, 0, 'characters') as {
      frames: Record<string, { frame: { x: number; y: number; w: number; h: number } }>;
      meta: { normal_map?: string };
    };
    expect(pixi.meta.normal_map).toBe('characters_0_n.png');
    expect(pixi.frames.f0!.frame.x).toBe(atlas.frames[0]!.rect.x);

    const phaser = exportPhaserMultiatlasJson(atlas, 'characters') as {
      textures: Array<{ image: string; normalMap?: string; frames: Array<{ filename: string }> }>;
    };
    expect(phaser.textures[0]!.normalMap).toBe('characters_0_n.png');
    expect(phaser.textures[0]!.frames).toHaveLength(4);

    const godot = exportGodotTres(atlas, 'characters', 'pixel-art', 8);
    expect(godot.framesTresContent).toContain('texture_filter = 1');
    expect(godot.framesTresContent).toContain(
      `Rect2(${atlas.frames[0]!.rect.x}, ${atlas.frames[0]!.rect.y}, ${atlas.frames[0]!.rect.width}, ${atlas.frames[0]!.rect.height})`,
    );
    // Validate exact Godot load_steps count
    const loadStepsMatch = /load_steps=(\d+)/.exec(godot.framesTresContent);
    const extCount = (godot.framesTresContent.match(/\[ext_resource /g) ?? []).length;
    const subCount = (godot.framesTresContent.match(/\[sub_resource /g) ?? []).length;
    expect(Number(loadStepsMatch?.[1])).toBe(1 + extCount + subCount);
  });
});
