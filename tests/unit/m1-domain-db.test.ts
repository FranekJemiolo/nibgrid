import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  OFFLINE_MOCK_PROVIDER_ID,
} from '../../src/db/database';
import { normalizeHexColor, parseGplPalette, parseHexPalette } from '../../src/domain/palette';
import {
  ArtBibleSchema,
  DEFAULT_NEGATIVE_PROMPT,
  ProjectSchema,
  createDefaultArtBible,
} from '../../src/domain/schemas';
import { sha256Bytes } from '../../src/processing/hash';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-unit-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return { db, repo: new NibgridRepository(db) };
}

afterEach(async () => {
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

describe('M1 Domain Schemas & Validation', () => {
  it('validates ArtBible defaults and rejects invalid hex codes, dimensions, and >3 Golden Refs', () => {
    const valid = createDefaultArtBible();
    expect(valid.negativePrompt).toBe(DEFAULT_NEGATIVE_PROMPT);
    expect(ArtBibleSchema.safeParse(valid).success).toBe(true);

    expect(
      ArtBibleSchema.safeParse({
        ...valid,
        palette: ['#1a1c2c'],
      }).success,
    ).toBe(false);

    expect(
      ArtBibleSchema.safeParse({
        ...valid,
        palette: ['#GGGGGG'],
      }).success,
    ).toBe(false);

    expect(
      ArtBibleSchema.safeParse({
        ...valid,
        targetWidth: 15,
      }).success,
    ).toBe(false);

    expect(
      ArtBibleSchema.safeParse({
        ...valid,
        targetHeight: 2049,
      }).success,
    ).toBe(false);

    expect(
      ArtBibleSchema.safeParse({
        ...valid,
        goldenReferenceBlobIds: ['b1', 'b2', 'b3', 'b4'],
      }).success,
    ).toBe(false);

    expect(
      ProjectSchema.safeParse({
        id: 'p1',
        name: '   ',
        artBible: valid,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }).success,
    ).toBe(false);
  });
});

describe('M1 Palette Parsers (.gpl and .hex)', () => {
  it('normalizes hex colors and parses .hex palettes with comments and deduplication', () => {
    expect(normalizeHexColor('ff00aa')).toBe('#FF00AA');
    expect(normalizeHexColor('  #38b764  ')).toBe('#38B764');

    const hexContent = [
      '# Lospec sample palette',
      '// comment line',
      '; another comment',
      '1a1c2c',
      '#5d275d // inline comment',
      '#1A1C2C',
      'b13e53 ; trailing note',
      '',
    ].join('\n');

    expect(parseHexPalette(hexContent)).toEqual(['#1A1C2C', '#5D275D', '#B13E53']);
    expect(() => parseHexPalette('#1A1C2C\n#12345\n')).toThrow(/invalid hex color/i);
    expect(() => parseHexPalette('not-a-color')).toThrow(/invalid hex color/i);
  });

  it('parses GIMP .gpl palettes with headers, comments, RGB triplets, and rejects malformed lines', () => {
    const gplContent = [
      'GIMP Palette',
      'Name: Dungeon Quartet',
      'Columns: 4',
      '# Header comment',
      ' 26  28  44\tDeep Ink',
      '177  62  83\tCrimson Armor',
      '255 205 117\tGold Trim',
      ' 26  28  44\tDuplicate Ink',
      ' 56 183 100\tEmerald Gem',
    ].join('\n');

    expect(parseGplPalette(gplContent)).toEqual(['#1A1C2C', '#B13E53', '#FFCD75', '#38B764']);

    expect(() => parseGplPalette('Name: Missing Header\n255 0 0 Red')).toThrow(
      /missing "GIMP Palette" header/i,
    );
    expect(() => parseGplPalette('GIMP Palette\n256 0 0 Invalid')).toThrow(/out of range/i);
  });
});

describe('M1 Dexie Persistence & Cascade Cleanup', () => {
  it('registers Offline Mock Provider, persists projects/blobs, and cascade-deletes orphaned blobs', async () => {
    const { db, repo } = createTestRepo();

    const providers = await repo.listProviderConfigs();
    expect(providers.some((p) => p.id === OFFLINE_MOCK_PROVIDER_ID)).toBe(true);

    const projectA = await repo.createProject('Hero Knight');
    const projectB = await repo.createProject('Slime Enemy');

    const refBytesA = new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]);
    const refBlobA = new Blob([refBytesA], { type: 'image/png' });
    const updatedA = await repo.addGoldenReference(projectA.id, refBlobA);
    expect(updatedA.artBible.goldenReferenceBlobIds).toHaveLength(1);

    const refBlobIdA = updatedA.artBible.goldenReferenceBlobIds[0]!;
    const fetchedBlobA = await repo.getBlob(refBlobIdA);
    expect(fetchedBlobA).toBeDefined();
    expect(fetchedBlobA?.sha256).toBe(await sha256Bytes(refBytesA));
    const roundTripBytes = new Uint8Array(await fetchedBlobA!.bytes.arrayBuffer());
    expect(Array.from(roundTripBytes)).toEqual(Array.from(refBytesA));

    // Attach a blob & sprite node to Project B to ensure deleting A leaves B intact
    const refBlobB = new Blob([new Uint8Array([9, 8, 7, 6])], { type: 'image/png' });
    const updatedB = await repo.addGoldenReference(projectB.id, refBlobB);
    const sketchBlobB = await repo.storeBlob(
      new Blob([new Uint8Array([5, 5, 5])], { type: 'image/png' }),
    );
    await repo.saveSpriteNode({
      id: 'node-b-1',
      projectId: projectB.id,
      parentId: null,
      kind: 'sketch',
      imageBlobId: sketchBlobB.id,
      sketchSha256: sketchBlobB.sha256,
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'nibgrid-procedural-v1',
        seed: 1,
        adherence: 'balanced',
        promptDelta: '',
        compiledPrompt: 'sketch root',
        createdAt: new Date().toISOString(),
      },
    });

    const summariesBefore = await repo.listProjectsWithCounts();
    expect(summariesBefore.find((s) => s.project.id === projectB.id)?.spriteCount).toBe(1);

    // Cascade delete Project A -> its Golden Ref blob must be removed, B's blobs remain
    await repo.deleteProjectCascade(projectA.id);
    expect(await repo.getProject(projectA.id)).toBeUndefined();
    expect(await repo.getBlob(refBlobIdA)).toBeUndefined();

    const refBlobIdB = updatedB.artBible.goldenReferenceBlobIds[0]!;
    expect(await repo.getBlob(refBlobIdB)).toBeDefined();
    expect(await repo.getBlob(sketchBlobB.id)).toBeDefined();
    expect(await db.blobs.count()).toBe(2);

    // Removing B's Golden Ref also deletes its orphaned blob
    await repo.removeGoldenReference(projectB.id, refBlobIdB);
    expect(await repo.getBlob(refBlobIdB)).toBeUndefined();
    expect(await db.blobs.count()).toBe(1);
  });
});
