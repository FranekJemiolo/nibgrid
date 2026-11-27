import 'fake-indexeddb/auto';
import { unzipSync, strFromU8 } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NibgridDatabase, NibgridRepository } from '../../src/db/database';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type ProviderConfig,
} from '../../src/domain/schemas';
import {
  assembleGodotRoomFiles,
  exportGodotRoomTscn,
  packageRoomBundleZip,
} from '../../src/export/godotRoomExporter';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  decodeGodotTileMapData,
  resolveRoomAutoTileCells,
  StoredRoomRecordSchema,
  type RoomCellKind,
  type RoomLayoutBlueprint,
} from '../../src/processing/roomLayoutCore';
import { ProviderError } from '../../src/providers/errors';
import {
  estimateRoomPrototyperCost,
  generateRoomBlueprint,
} from '../../src/providers/roomPrototyperAdapter';
import { collectProjectGodotSyncFiles } from '../../src/sync/fsaaSyncEngine';

function makeBossArenaBlueprint(): RoomLayoutBlueprint {
  const cols = 24;
  const rows = 14;
  const cells: RoomCellKind[][] = Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => {
      if (x === 0 || y === 0 || x === cols - 1 || y === rows - 1) return 1;
      return 0;
    }),
  );
  // Two raised platforms and two pillars
  for (let x = 3; x <= 7; x++) cells[9]![x] = 2;
  for (let x = 16; x <= 20; x++) cells[9]![x] = 2;
  cells[11]![9] = 1;
  cells[12]![9] = 1;
  cells[11]![14] = 1;
  cells[12]![14] = 1;

  return {
    slug: 'boss_sanctum',
    displayName: 'Boss Sanctum',
    prompt: 'Dungeon boss arena with stone pillars',
    cols,
    rows,
    tileSizePx: 32,
    cells,
    playerSpawn: { cellX: 2, cellY: 12 },
    entities: [
      {
        id: 'goblin_1',
        entitySlug: 'goblin_scout',
        cellX: 11,
        cellY: 12,
        patrolSpanCells: 4,
        facing: 'left',
      },
      {
        id: 'chest_1',
        entitySlug: 'treasure_chest',
        cellX: 18,
        cellY: 8,
        facing: 'right',
      },
    ],
  };
}

describe('M35B GenAI Room Director Adapter, Godot 4.3 .tscn Exporter & Sync Wiring', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exports a valid Godot 4.3+ .tscn with exact load_steps, TileMapLayer binary data, Background Parallax2D, Camera2D limits, PlayerSpawn, and Entities', () => {
    const blueprint = makeBossArenaBlueprint();
    const tscn = exportGodotRoomTscn({
      blueprint,
      tileSetMode: 'blob47',
      tileSetResPath: 'res://tilesets/dungeon_stone_tileset.tres',
      parallaxResPath: 'res://parallax/crypt_dusk_parallax.tscn',
      entityResPaths: {
        goblin_scout: 'res://assets/nibgrid/goblin_scout/goblin_scout.tscn',
        treasure_chest: 'res://assets/nibgrid/treasure_chest/treasure_chest.tscn',
      },
      isPixelArt: true,
    });

    // 1 TileSet + 1 Parallax + 2 unique Entity PackedScenes + 1 scene = load_steps=5
    expect(tscn).toContain('[gd_scene load_steps=5 format=3]');
    expect(tscn).toContain(
      '[node name="Background" parent="." instance=ExtResource("2_parallax")]',
    );
    expect(tscn).toContain('[node name="Terrain" type="TileMapLayer" parent="."]');
    expect(tscn).toContain('texture_filter = 1');
    expect(tscn).toContain('[node name="PlayerSpawn" type="Marker2D" parent="."]');
    expect(tscn).toContain('position = Vector2(80, 400)');
    expect(tscn).toContain('limit_left = 0');
    expect(tscn).toContain('limit_top = 0');
    expect(tscn).toContain(`limit_right = ${24 * 32}`);
    expect(tscn).toContain(`limit_bottom = ${14 * 32}`);
    expect(tscn).toContain('instance=ExtResource("3_entity_goblin_scout")');
    expect(tscn).toContain('instance=ExtResource("4_entity_treasure_chest")');
    expect(tscn).toContain('scale = Vector2(-1, 1)');

    const packedMatch = /tile_map_data = PackedByteArray\(([^)]+)\)/.exec(tscn);
    expect(packedMatch?.[1]).toBeTruthy();
    const byteNums = packedMatch![1]!.split(',').map((s) => Number(s.trim()));
    const decoded = decodeGodotTileMapData(new Uint8Array(byteNums));
    const expectedCells = resolveRoomAutoTileCells(blueprint, 'blob47');
    expect(decoded.version).toBe(0);
    expect(decoded.cells).toHaveLength(expectedCells.length);

    const files = assembleGodotRoomFiles({
      blueprint,
      tileSetMode: 'blob47',
    });
    expect(files.map((f) => f.relativePath)).toEqual(['levels/boss_sanctum.tscn']);
  });

  it('packages Level Bundle ZIP cleanly without sensitive key leakage', async () => {
    const db = new NibgridDatabase(`nibgrid-m35b-zip-${Date.now()}`);
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M35B Zip Project');
    const blob = await repo.storeBlob(
      new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }),
    );
    const node = {
      id: 'node-1',
      projectId: project.id,
      kind: 'generation' as const,
      parentId: null,
      sketchSha256: 'a'.repeat(64),
      imageBlobId: blob.id,
      postProcessConfig: createDefaultPostProcessConfig(),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'nibgrid-procedural-v1',
        seed: 7,
        adherence: 'balanced' as const,
        promptDelta: 'stone tile',
        compiledPrompt: 'stone tile',
        createdAt: new Date().toISOString(),
      },
    };
    const blueprint = makeBossArenaBlueprint();
    const tscnContent = exportGodotRoomTscn({ blueprint, tileSetMode: 'blob47' });
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: node.postProcessConfig,
      filename: 'levels/boss_sanctum.tscn',
      outputWidth: blueprint.cols * blueprint.tileSizePx,
      outputHeight: blueprint.rows * blueprint.tileSizePx,
      roomLayout: blueprint,
    });

    const zipBytes = packageRoomBundleZip({
      slug: blueprint.slug,
      tscnContent,
      recipe,
    });
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).sort()).toEqual(['levels/boss_sanctum.tscn', 'recipe.json']);
    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(unzipped['recipe.json']!)));
    expect(parsedRecipe.roomLayout?.cols).toBe(24);
    expect(parsedRecipe.roomLayout?.rows).toBe(14);
    await db.delete();
  });

  it('generates rooms via Gemini Flash JSON responseSchema and strips API keys on HTTP 401/429', async () => {
    const secretKey = 'AIzaSyROOM999SECRETKEY';
    const geminiConfig: ProviderConfig = {
      id: 'gemini-byok',
      kind: 'gemini',
      displayName: 'Google Gemini Flash',
      modelId: 'gemini-2.5-flash',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: secretKey,
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    };

    expect(estimateRoomPrototyperCost('gemini').label).toBe('~$0.001');
    expect(estimateRoomPrototyperCost('mock').usd).toBe(0);

    const gridRows = Array.from({ length: 14 }, (_, y) =>
      y === 0 || y === 13 ? '1'.repeat(24) : `1${'0'.repeat(22)}1`,
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      slug: 'boss_hall',
                      displayName: 'Boss Hall',
                      gridRows,
                      playerSpawn: { cellX: 0, cellY: 0 }, // inside solid wall -> must relocate
                      entities: [
                        { entitySlug: 'goblin_scout', cellX: 12, cellY: 11, facing: 'left' },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      })),
    );

    const res = await generateRoomBlueprint({
      prompt: 'Dungeon boss hall',
      cols: 24,
      rows: 14,
      tileSizePx: 32,
      artBible: createDefaultArtBible(),
      availableEntitySlugs: ['goblin_scout'],
      providerConfig: geminiConfig,
    });
    expect(res.usedMock).toBe(false);
    expect(res.blueprint.cols).toBe(24);
    expect(res.blueprint.rows).toBe(14);
    expect(
      res.blueprint.cells[res.blueprint.playerSpawn.cellY]![res.blueprint.playerSpawn.cellX],
    ).not.toBe(1);

    for (const status of [401, 429]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status,
          text: async () => `Upstream error with key ${secretKey} on ${status}`,
        })),
      );
      let caught: unknown;
      try {
        await generateRoomBlueprint({
          prompt: 'Dungeon boss hall',
          cols: 24,
          rows: 14,
          tileSizePx: 32,
          artBible: createDefaultArtBible(),
          availableEntitySlugs: [],
          providerConfig: geminiConfig,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      const pe = caught as ProviderError;
      expect(pe.message).not.toContain(secretKey);
      expect(pe.remediation).not.toContain(secretKey);
    }
  });

  it('includes saved Dexie rooms in collectProjectGodotSyncFiles for M25 res:// sync', async () => {
    const db = new NibgridDatabase(`nibgrid-m35b-sync-${Date.now()}`);
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M35B Sync Project');
    const room = StoredRoomRecordSchema.parse({
      id: 'room-sync-1',
      projectId: project.id,
      slug: 'crypt_arena',
      tileSetNodeId: null,
      tileSetMode: 'blob47',
      parallaxNodeId: null,
      blueprint: makeBossArenaBlueprint(),
      updatedAt: Date.now(),
    });
    await repo.saveRoom(room);

    const files = await collectProjectGodotSyncFiles(db, project, [], [], []);
    expect(files.some((f) => f.relativePath === 'levels/boss_sanctum.tscn')).toBe(true);
    await db.delete();
  });
});
