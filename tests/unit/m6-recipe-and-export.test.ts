import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { OFFLINE_MOCK_PROVIDER_ID } from '../../src/db/database';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import { packageSpriteZip, toAssetSlug } from '../../src/export/zipPackager';
import { composeSpritesheetStrip, encodeAnimatedGif } from '../../src/processing/gif';
import { encodeRgbaToPngBytes } from '../../src/processing/png';

describe('M6 Reproducible Recipe Builder & ZIP Packager', () => {
  it('validates AssetRecipeSchema and ensures zero API keys or secret strings appear in recipe JSON', () => {
    const project: Project = {
      id: 'proj-m6',
      name: 'Paladin Sprite Pack',
      artBible: {
        ...createDefaultArtBible(),
        projection: 'top-down',
        palette: ['#1A1C2C', '#B13E53', '#FFCD75', '#38B764'],
      },
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:05:00.000Z',
    };

    const node: SpriteNode = {
      id: 'node-gen-1',
      projectId: project.id,
      parentId: 'node-root-0',
      kind: 'generation',
      imageBlobId: 'blob-img',
      sketchSha256: 'e'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'nibgrid-procedural-v1',
        seed: 2048,
        adherence: 'strict',
        promptDelta: 'golden helm trim',
        compiledPrompt: 'pixel-art; top-down; golden helm trim',
        createdAt: '2026-11-23T10:04:00.000Z',
      },
    };

    const postProcess = {
      ...createDefaultPostProcessConfig(64, 64),
      bgRemoval: 'color-key' as const,
      paletteSnap: true,
      resampleEnabled: true,
      pivotNorm: { x: 0.5, y: 1.0 },
    };

    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess,
      filename: 'paladin-sprite-pack.png',
      outputWidth: 64,
      outputHeight: 64,
      normalizedWidth: 128,
      normalizedHeight: 128,
    });

    expect(AssetRecipeSchema.parse(recipe)).toEqual(recipe);
    expect(recipe.output.pivotPx).toEqual({ x: 32, y: 64 });
    expect(recipe.output.pivotNorm).toEqual({ x: 0.5, y: 1.0 });
    expect(recipe.source.sketchSha256).toBe('e'.repeat(64));

    const json = JSON.stringify(recipe);
    expect(json).not.toMatch(/apiKey/i);
    expect(json).not.toMatch(/AIza/);
    expect(json).not.toMatch(/sk-[0-9A-Za-z]/);
  });

  it('packages valid PNG (8-byte magic header) and recipe.json via fflate zipSync', () => {
    const project: Project = {
      id: 'proj-zip',
      name: 'Slime Knight',
      artBible: createDefaultArtBible(),
      createdAt: '2026-11-23T10:00:00.000Z',
      updatedAt: '2026-11-23T10:00:00.000Z',
    };

    const node: SpriteNode = {
      id: 'node-zip',
      projectId: project.id,
      parentId: null,
      kind: 'inpaint',
      imageBlobId: 'blob-1',
      sketchSha256: 'f'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'nibgrid-procedural-v1',
        seed: 99,
        adherence: 'balanced',
        promptDelta: 'emerald visor',
        compiledPrompt: 'compiled prompt',
        createdAt: '2026-11-23T10:00:00.000Z',
      },
    };

    const slug = toAssetSlug(project.name);
    const pngBytes = encodeRgbaToPngBytes(new Uint8ClampedArray(64 * 64 * 4).fill(255), 64, 64);
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: {
        ...createDefaultPostProcessConfig(64, 64),
        pivotNorm: { x: 0.5, y: 1.0 },
      },
      filename: `${slug}.png`,
      outputWidth: 64,
      outputHeight: 64,
    });

    const zipBytes = packageSpriteZip({ slug, pngBytes, recipe });
    const unpacked = unzipSync(zipBytes);

    const extractedPng = unpacked[`${slug}.png`];
    const extractedRecipeBytes = unpacked[`${slug}.recipe.json`];

    expect(extractedPng).toBeDefined();
    expect(extractedRecipeBytes).toBeDefined();

    // Verify exact 8-byte PNG signature: 89 50 4E 47 0D 0A 1A 0A
    expect(Array.from(extractedPng!.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(Array.from(extractedPng!)).toEqual(Array.from(pngBytes));

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(extractedRecipeBytes!)));
    expect(parsedRecipe.output.width).toBe(64);
    expect(parsedRecipe.output.height).toBe(64);
    expect(parsedRecipe.output.pivotNorm).toEqual({ x: 0.5, y: 1 });
    expect(parsedRecipe.output.pivotPx).toEqual({ x: 32, y: 64 });
  });

  it('encodes looping animated GIF89a with LZW decompression integrity & composes spritesheet strips', () => {
    const makeFrame = (r: number, g: number, b: number, stripeOffset: number) => {
      const w = 16;
      const h = 16;
      const rgba = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = (y * w + x) * 4;
          if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
            // Transparent 1px outer frame border -> must map to index 0
            rgba[px + 3] = 0;
          } else {
            rgba[px] = (r + ((x + stripeOffset) % 4) * 15) & 0xff;
            rgba[px + 1] = g;
            rgba[px + 2] = b;
            rgba[px + 3] = 255;
          }
        }
      }
      return { rgba, width: w, height: h };
    };

    const frames = [
      makeFrame(200, 40, 60, 0),
      makeFrame(220, 60, 40, 1),
      makeFrame(40, 200, 240, 2),
    ];

    const strip = composeSpritesheetStrip(frames);
    expect(strip.width).toBe(48);
    expect(strip.height).toBe(16);
    expect(strip.rgba[(1 * 48 + 32 + 2) * 4 + 2]).toBe(240);

    const gif = encodeAnimatedGif(frames, { fps: 8, loop: true, pingPong: false });
    expect(String.fromCharCode(...gif.slice(0, 6))).toBe('GIF89a');
    expect(gif[6]! | (gif[7]! << 8)).toBe(16);
    expect(gif[8]! | (gif[9]! << 8)).toBe(16);
    expect(gif[gif.length - 1]).toBe(0x3b);
    expect(Buffer.from(gif).includes(Buffer.from('NETSCAPE2.0'))).toBe(true);

    // Count Graphic Control Extension blocks (0x21 0xF9 0x04 0x09)
    let gceCount = 0;
    for (let i = 0; i <= gif.length - 4; i++) {
      if (gif[i] === 0x21 && gif[i + 1] === 0xf9 && gif[i + 2] === 0x04 && gif[i + 3] === 0x09) {
        gceCount++;
      }
    }
    expect(gceCount).toBe(3);

    const pingPongGif = encodeAnimatedGif(frames, { fps: 8, loop: true, pingPong: true });
    let pingPongGceCount = 0;
    for (let i = 0; i <= pingPongGif.length - 4; i++) {
      if (
        pingPongGif[i] === 0x21 &&
        pingPongGif[i + 1] === 0xf9 &&
        pingPongGif[i + 2] === 0x04 &&
        pingPongGif[i + 3] === 0x09
      ) {
        pingPongGceCount++;
      }
    }
    expect(pingPongGceCount).toBe(4);

    // Decode first image frame LZW bitstream (Header 6 + LSD 7 + GCT 768 + Netscape 19 + GCE 8 = 808)
    const firstDesc = 6 + 7 + 768 + 19 + 8;
    expect(gif[firstDesc]).toBe(0x2c);
    expect(gif[firstDesc + 10]).toBe(8); // LZW minCodeSize
    let pos = firstDesc + 11;
    const rawLzw: number[] = [];
    while (pos < gif.length && gif[pos] !== 0) {
      const subLen = gif[pos++]!;
      for (let k = 0; k < subLen; k++) {
        rawLzw.push(gif[pos++]!);
      }
    }
    const decodedIndices: number[] = [];
    let bitPos = 0;
    let codeSize = 9;
    let nextCode = 258;
    const dict: number[][] = Array.from({ length: 256 }, (_, idx) => [idx]);
    dict[256] = [];
    dict[257] = [];
    const readCode = () => {
      let code = 0;
      for (let b = 0; b < codeSize; b++) {
        const byte = rawLzw[bitPos >> 3] ?? 0;
        if (((byte >> (bitPos & 7)) & 1) !== 0) code |= 1 << b;
        bitPos++;
      }
      return code;
    };
    let prevEntry: number[] = [];
    while (bitPos >> 3 < rawLzw.length) {
      const code = readCode();
      if (code === 256) {
        dict.length = 258;
        codeSize = 9;
        nextCode = 258;
        prevEntry = [];
        continue;
      }
      if (code === 257) break;
      const entry =
        code < dict.length
          ? dict[code]!
          : code === nextCode && prevEntry.length > 0
            ? [...prevEntry, prevEntry[0]!]
            : [];
      decodedIndices.push(...entry);
      if (prevEntry.length > 0 && nextCode < 4096) {
        dict[nextCode++] = [...prevEntry, entry[0]!];
        if (nextCode === 1 << codeSize && codeSize < 12) codeSize++;
      }
      prevEntry = entry;
    }
    expect(decodedIndices).toHaveLength(16 * 16);
    expect(decodedIndices[0]).toBe(0); // transparent border
    expect(decodedIndices[1 * 16 + 1]).toBeGreaterThan(0); // opaque interior
  });
});
