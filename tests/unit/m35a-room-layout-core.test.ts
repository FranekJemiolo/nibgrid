import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import {
  BIT_E,
  BIT_S,
  BIT_SE,
  getCanonicalBlob47Masks,
  getCanonicalWang16Masks,
} from '../../src/processing/autoTile';
import {
  RoomLayoutBlueprintSchema,
  StoredRoomRecordSchema,
  decodeGodotTileMapData,
  encodeGodotTileMapData,
  parseAndClampRoomBlueprint,
  resolveRoomAutoTileCells,
  sanitizeRoomPlacements,
  type RoomCellKind,
  type RoomLayoutBlueprint,
} from '../../src/processing/roomLayoutCore';

function buildEmptyGrid(cols: number, rows: number, borderSolid = false): RoomCellKind[][] {
  return Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => {
      if (borderSolid && (x === 0 || y === 0 || x === cols - 1 || y === rows - 1)) {
        return 1;
      }
      return 0;
    }),
  );
}

describe('M35A Room Layout Core, Auto-Tile Resolution, TileMapData Binary Codec & Dexie v6', () => {
  it('validates room dimensions strictly with RoomLayoutBlueprintSchema and rejects ragged grids', () => {
    const valid: RoomLayoutBlueprint = {
      slug: 'crypt_arena',
      displayName: 'Crypt Arena',
      prompt: 'Dungeon boss room',
      cols: 12,
      rows: 8,
      tileSizePx: 32,
      cells: buildEmptyGrid(12, 8, true),
      playerSpawn: { cellX: 2, cellY: 6 },
      entities: [
        {
          id: 'goblin_1',
          entitySlug: 'goblin_scout',
          cellX: 9,
          cellY: 6,
          patrolSpanCells: 3,
          facing: 'left',
        },
      ],
    };

    expect(RoomLayoutBlueprintSchema.parse(valid).slug).toBe('crypt_arena');

    const badRows = { ...valid, cells: valid.cells.slice(0, 5) };
    expect(() => RoomLayoutBlueprintSchema.parse(badRows)).toThrow();

    const badCols = {
      ...valid,
      cells: valid.cells.map((row, idx) => (idx === 2 ? row.slice(0, 6) : row)),
    };
    expect(() => RoomLayoutBlueprintSchema.parse(badCols)).toThrow();
  });

  it('sanitizeRoomPlacements relocates solid-overlapping playerSpawn and entities to walkable non-solid cells', () => {
    const cells = buildEmptyGrid(12, 8, true);
    // Floor slab across bottom rows y=6, y=7 at column 4 and 8
    cells[6]![4] = 1;
    cells[6]![8] = 1;

    const dirty: RoomLayoutBlueprint = {
      slug: 'Relocate Test!',
      displayName: 'Relocate Room',
      prompt: 'test',
      cols: 12,
      rows: 8,
      tileSizePx: 32,
      cells,
      playerSpawn: { cellX: 4, cellY: 6 }, // overlaps solid (1)
      entities: [
        {
          id: 'dup',
          entitySlug: 'Goblin Scout',
          cellX: 8,
          cellY: 6, // overlaps solid (1)
        },
        {
          id: 'dup',
          entitySlug: 'Treasure Chest',
          cellX: 0,
          cellY: 0, // top-left corner border solid (1)
        },
      ],
    };

    const sanitized = sanitizeRoomPlacements(dirty);
    expect(sanitized.slug).toBe('relocate_test');
    expect(sanitized.cells[sanitized.playerSpawn.cellY]![sanitized.playerSpawn.cellX]).not.toBe(1);
    expect(sanitized.playerSpawn).toEqual({ cellX: 4, cellY: 5 });

    for (const ent of sanitized.entities) {
      expect(sanitized.cells[ent.cellY]![ent.cellX]).not.toBe(1);
    }
    expect(sanitized.entities[0]!.entitySlug).toBe('goblin_scout');
    expect(sanitized.entities[0]!.cellX).toBe(8);
    expect(sanitized.entities[0]!.cellY).toBe(5);
    expect(new Set(sanitized.entities.map((e) => e.id)).size).toBe(2);
  });

  it('parseAndClampRoomBlueprint converts Gemini gridRows strings into clamped dimensions and safe spawns', () => {
    const parsed = parseAndClampRoomBlueprint(
      {
        slug: 'boss-room',
        displayName: 'Boss Room',
        gridRows: ['############', '#..........#', '#...----...#', '#..........#', '############'],
        playerSpawn: { cellX: 99, cellY: 99 },
        entities: [{ entitySlug: 'goblin_scout', cellX: 0, cellY: 0, facing: 'left' }],
      },
      {
        fallbackPrompt: 'Boss room',
        cols: 12,
        rows: 8,
        tileSizePx: 32,
      },
    );

    expect(parsed.cols).toBe(12);
    expect(parsed.rows).toBe(8);
    expect(parsed.cells[2]![4]).toBe(2); // platform '-'
    expect(parsed.cells[0]![0]).toBe(1); // solid '#'
    expect(parsed.cells[parsed.playerSpawn.cellY]![parsed.playerSpawn.cellX]).toBe(0);
    expect(parsed.cells[parsed.entities[0]!.cellY]![parsed.entities[0]!.cellX]).toBe(0);
  });

  it('resolveRoomAutoTileCells computes M20 Blob-47 (8-col) and Wang-16 (4-col) atlas coords', () => {
    const cells = buildEmptyGrid(12, 8, false);
    // 2x2 solid block at (2,2)..(3,3) plus a 2-cell one-way platform at (6,4)..(7,4)
    cells[2]![2] = 1;
    cells[2]![3] = 1;
    cells[3]![2] = 1;
    cells[3]![3] = 1;
    cells[4]![6] = 2;
    cells[4]![7] = 2;

    const blueprint: RoomLayoutBlueprint = {
      slug: 'autotile_test',
      displayName: 'AutoTile Test',
      prompt: 'test',
      cols: 12,
      rows: 8,
      tileSizePx: 32,
      cells,
      playerSpawn: { cellX: 1, cellY: 1 },
      entities: [],
    };

    const blobCells = resolveRoomAutoTileCells(blueprint, 'blob47');
    expect(blobCells).toHaveLength(6);
    const topLeft = blobCells.find((c) => c.x === 2 && c.y === 2)!;
    const expectedTopLeftMask = BIT_E | BIT_S | BIT_SE;
    const blobMasks = getCanonicalBlob47Masks();
    const expectedIdx = blobMasks.indexOf(expectedTopLeftMask);
    expect(topLeft.mask).toBe(expectedTopLeftMask);
    expect(topLeft.atlasX).toBe(expectedIdx % 8);
    expect(topLeft.atlasY).toBe(Math.floor(expectedIdx / 8));

    const wangCells = resolveRoomAutoTileCells(blueprint, 'wang16');
    expect(wangCells).toHaveLength(6);
    const wangMasks = getCanonicalWang16Masks();
    for (const c of wangCells) {
      expect(c.mask).toBeGreaterThan(0);
      expect(wangMasks).toContain(c.mask);
      expect(c.atlasX).toBeGreaterThanOrEqual(0);
      expect(c.atlasX).toBeLessThan(4);
      expect(c.atlasY).toBeGreaterThanOrEqual(0);
      expect(c.atlasY).toBeLessThan(4);
    }
  });

  it('encodeGodotTileMapData and decodeGodotTileMapData preserve 2 + 12*N little-endian layout losslessly', () => {
    const input = [
      { x: 0, y: 0, sourceId: 0, atlasX: 3, atlasY: 2, altTile: 0 },
      { x: 23, y: 13, sourceId: 0, atlasX: 7, atlasY: 5, altTile: 1 },
      { x: -2, y: -4, sourceId: 1, atlasX: 1, atlasY: 0, altTile: 0 },
    ];

    const encoded = encodeGodotTileMapData(input);
    expect(encoded.length).toBe(2 + input.length * 12);

    const view = new DataView(encoded.buffer);
    expect(view.getUint16(0, true)).toBe(0);

    const decoded = decodeGodotTileMapData(encoded);
    expect(decoded.version).toBe(0);
    expect(decoded.cells).toEqual(input);
  });

  it('persists rooms in Dexie v6 and cascades cleanly on deleteProjectCascade with zero orphan blobs', async () => {
    const db = new NibgridDatabase(`nibgrid-m35a-${Date.now()}-${Math.random()}`);
    const repo = new NibgridRepository(db);

    const project = await repo.createProject('M35A Room Project');
    const room = StoredRoomRecordSchema.parse({
      id: 'room-1',
      projectId: project.id,
      slug: 'crypt_boss_arena',
      tileSetNodeId: null,
      tileSetMode: 'blob47',
      parallaxNodeId: null,
      blueprint: {
        slug: 'crypt_boss_arena',
        displayName: 'Crypt Boss Arena',
        prompt: 'Boss arena with pillars',
        cols: 24,
        rows: 14,
        tileSizePx: 32,
        cells: buildEmptyGrid(24, 14, true),
        playerSpawn: { cellX: 2, cellY: 12 },
        entities: [],
      },
      updatedAt: 1700000000000,
    });

    await repo.saveRoom(room);
    const listed = await repo.listRooms(project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.slug).toBe('crypt_boss_arena');

    await repo.deleteProjectCascade(project.id);
    expect(await repo.listRooms(project.id)).toHaveLength(0);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    await db.delete();
  });
});
