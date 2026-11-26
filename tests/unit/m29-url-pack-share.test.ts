import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultBitmapFontConfig,
  createDefaultShaderConfig,
  createDefaultVfxFlipbookConfig,
} from '../../src/domain/schemas';
import { sha256Bytes } from '../../src/processing/hash';
import {
  PackCatalogSchema,
  parseAndVerifyPackZip,
  resolvePackZipUrl,
} from '../../src/share/packFeedClient';
import {
  decodeRecipeFromHash,
  encodeBase64Url,
  encodeRecipeToHash,
  SHARE_HASH_PREFIX,
} from '../../src/share/recipeUrlCodec';

describe('M29 Zero-Server URL-Hash Recipe Sharing & Static Pack Feeds', () => {
  it('round-trips shader, vfx, bmfont, procedural-sfx, and art-bible recipes well below 2 KB', () => {
    const cases = [
      {
        kind: 'shader' as const,
        name: 'Golden Flash Shader',
        shaderConfig: createDefaultShaderConfig('hit_flash'),
      },
      {
        kind: 'vfx' as const,
        name: 'Spark Burst Flipbook',
        vfxFlipbook: createDefaultVfxFlipbookConfig(),
      },
      {
        kind: 'bmfont' as const,
        name: 'Crit Damage Font',
        bitmapFont: createDefaultBitmapFontConfig(),
      },
      {
        kind: 'procedural-sfx' as const,
        name: 'Laser Zap SFX',
        synthParams: {
          seed: 42,
          durationSec: 0.25,
          sampleRate: 44100,
          transientGain: 0.5,
          transientDecayMs: 12,
          transientFreqHz: 1400,
          bodyGain: 0.8,
          bodyShape: 'sawtooth' as const,
          bodyStartHz: 900,
          bodyEndHz: 180,
          bodyAttackMs: 2,
          bodyDecayMs: 160,
          fmRatio: 1.5,
          fmDepth: 120,
          noiseGain: 0.2,
          noiseDecayMs: 80,
          filterStartHz: 5000,
          filterEndHz: 800,
          filterQ: 2,
          bitDepth: 16,
          drive: 1.5,
        },
      },
      {
        kind: 'art-bible' as const,
        name: 'Masovian Dusk Art Bible',
        artBible: createDefaultArtBible(),
      },
    ];

    for (const payload of cases) {
      const hash = encodeRecipeToHash(payload);
      expect(hash.startsWith(SHARE_HASH_PREFIX)).toBe(true);
      expect(hash.length).toBeLessThan(2048);

      const decoded = decodeRecipeFromHash(hash);
      expect(decoded.ok).toBe(true);
      if (decoded.ok) {
        expect(decoded.recipe.kind).toBe(payload.kind);
        expect(decoded.recipe.name).toBe(payload.name);
      }
    }
  });

  it('rejects corrupted Base64URL, wrong prefixes, and oversized decompression payloads cleanly without throwing', () => {
    expect(decodeRecipeFromHash('#/project/123').ok).toBe(false);
    expect(decodeRecipeFromHash(`${SHARE_HASH_PREFIX}%%%not_valid%%%`).ok).toBe(false);

    // Oversized uncompressed JSON bomb simulation (> 64 KiB cap)
    const hugeComment = 'x'.repeat(70000);
    const fakePayload = new TextEncoder().encode(
      JSON.stringify({ kind: 'shader', pad: hugeComment }),
    );
    const compressedBomb = zlibSync(fakePayload, { level: 9 });
    const bombHash = `${SHARE_HASH_PREFIX}${encodeBase64Url(compressedBomb)}`;

    const decodedBomb = decodeRecipeFromHash(bombHash, { maxUncompressedBytes: 65536 });
    expect(decodedBomb.ok).toBe(false);

    // Encode oversize raw recipe rejects cleanly
    expect(() =>
      encodeRecipeToHash({
        kind: 'shader',
        name: 'Oversize',
        shaderConfig: {
          ...createDefaultShaderConfig('hit_flash'),
          gdshaderSource: Array.from({ length: 12000 }, () =>
            Math.random().toString(36).slice(2, 4),
          ).join(''),
        },
      }),
    ).toThrow(/limit/i);
  });

  it('validates starter-catalog.json and verifies starter .nibgrid-pack.zip SHA-256 integrity', async () => {
    expect(() =>
      PackCatalogSchema.parse({
        feedTitle: 'Invalid Catalog',
        packs: [{ id: 'p1', title: 'Missing Zip', author: 'Test', assetCount: 1 }],
      }),
    ).toThrow();

    const catalogPath = resolve(process.cwd(), 'public/packs/starter-catalog.json');
    const packZipPath = resolve(process.cwd(), 'public/packs/retro-rpg-starter.nibgrid-pack.zip');
    expect(existsSync(catalogPath)).toBe(true);
    expect(existsSync(packZipPath)).toBe(true);

    const catalog = PackCatalogSchema.parse(JSON.parse(readFileSync(catalogPath, 'utf8')));
    expect(catalog.packs.length).toBeGreaterThanOrEqual(1);
    const starterEntry = catalog.packs[0]!;
    expect(
      resolvePackZipUrl(
        starterEntry.zipUrl,
        'https://franekjemiolo.github.io/nibgrid/packs/starter-catalog.json',
      ),
    ).toBe('https://franekjemiolo.github.io/nibgrid/packs/retro-rpg-starter.nibgrid-pack.zip');

    const zipBytes = new Uint8Array(readFileSync(packZipPath));
    expect(await sha256Bytes(zipBytes)).toBe(starterEntry.sha256);

    const parsed = await parseAndVerifyPackZip(zipBytes, starterEntry.sha256);
    expect(parsed.kind).toBe('vault-pack');
    if (parsed.kind === 'vault-pack') {
      expect(parsed.manifest.items.length).toBe(3);
    }
  });
});
