import { describe, expect, it } from 'vitest';
import { strFromU8, unzipSync } from 'fflate';
import {
  createDefaultArtBible,
  createDefaultAutoTileConfig,
  createDefaultPostProcessConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import {
  exportGodotTileSetTres,
  exportTiledTsx,
  packageAutoTileZip,
} from '../../src/export/autoTileExporters';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  BIT_N,
  composeAutoTileSheet,
  getCanonicalBlob47Masks,
  getCanonicalWang16Masks,
} from '../../src/processing/autoTile';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import type { RgbaBuffer } from '../../src/processing/types';
import { composeAutoTileInWorker } from '../../src/workers/postprocessClient';

function makeSolidTile(size: number): RgbaBuffer {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const p = i * 4;
    data[p] = 110;
    data[p + 1] = 180;
    data[p + 2] = 95;
    data[p + 3] = 255;
  }
  return { width: size, height: size, data };
}

describe('M20B: Godot 4 .tres, Tiled .tsx Exporters & Worker Offloading', () => {
  it('exports valid Godot 4 TileSet .tres for Blob-47 and Wang-16 terrains', () => {
    const blobCells = getCanonicalBlob47Masks().map((mask, index) => ({
      index,
      mask,
      col: index % 8,
      row: Math.floor(index / 8),
    }));

    const tresBlob = exportGodotTileSetTres({
      assetName: 'forest_turf',
      textureFilename: 'forest_turf_autotile_blob-47.png',
      tileSize: 32,
      mode: 'blob-47',
      cells: blobCells,
    });

    expect(tresBlob).toContain('format=3');
    expect(tresBlob).toContain('terrain_set_0/mode = 0');
    expect(tresBlob).toContain('Vector2i(32, 32)');

    const firstBitNCell = blobCells.find((c) => (c.mask & BIT_N) !== 0)!;
    expect(tresBlob).toContain(
      `${firstBitNCell.col}:${firstBitNCell.row}/0/terrains_peering_bit/top_side = 0`,
    );
    expect(tresBlob).not.toContain('0:0/0/terrains_peering_bit/top_side = 0');

    const wangCells = getCanonicalWang16Masks().map((mask, index) => ({
      index,
      mask,
      col: index % 4,
      row: Math.floor(index / 4),
    }));
    const tresWang = exportGodotTileSetTres({
      assetName: 'wang_stone',
      textureFilename: 'wang_stone_autotile_wang-16.png',
      tileSize: 16,
      mode: 'wang-16',
      cells: wangCells,
    });
    expect(tresWang).toContain('terrain_set_0/mode = 1');
    expect(tresWang).toContain('3:3/0/terrains_peering_bit/top_left_corner = 0');
    expect(tresWang).toContain('3:3/0/terrains_peering_bit/top_right_corner = 0');
  });

  it('exports valid Tiled .tsx XML with exact clockwise 8-slot wangid attributes', () => {
    const blobCells = getCanonicalBlob47Masks().map((mask, index) => ({
      index,
      mask,
      col: index % 8,
      row: Math.floor(index / 8),
    }));
    const tsxBlob = exportTiledTsx({
      assetName: 'forest_turf',
      textureFilename: 'forest_turf_autotile_blob-47.png',
      tileSize: 32,
      columns: 8,
      rows: 6,
      mode: 'blob-47',
      cells: blobCells,
    });

    expect(tsxBlob).toContain('tilecount="47"');
    expect(tsxBlob).toContain('columns="8"');
    expect(tsxBlob).toContain('type="mixed"');
    expect(tsxBlob.match(/<wangtile /g)).toHaveLength(47);
    expect(tsxBlob).toContain('wangid="1,1,1,1,1,1,1,1"');

    const wangCells = getCanonicalWang16Masks().map((mask, index) => ({
      index,
      mask,
      col: index % 4,
      row: Math.floor(index / 4),
    }));
    const tsxWang = exportTiledTsx({
      assetName: 'wang_stone',
      textureFilename: 'wang_stone_autotile_wang-16.png',
      tileSize: 16,
      columns: 4,
      rows: 4,
      mode: 'wang-16',
      cells: wangCells,
    });
    expect(tsxWang).toContain('tilecount="16"');
    expect(tsxWang).toContain('columns="4"');
    expect(tsxWang).toContain('type="corner"');
    // NE (4) | NW (8) = 12 -> clockwise N,NE,E,SE,S,SW,W,NW = 0,1,0,0,0,0,0,1
    expect(tsxWang).toContain('<wangtile tileid="12" wangid="0,1,0,0,0,0,0,1"/>');
  });

  it('packages valid PNG + .tres + .tsx + recipe.json ZIP bundle and runs worker helper', async () => {
    const fill = makeSolidTile(16);
    const options = {
      mode: 'blob-47' as const,
      edgeStyle: 'organic-overhang' as const,
      borderWidthPx: 3,
      cornerRadiusPx: 4,
      jitterPx: 1.5,
      edgeTintHex: '#1A1C2C',
      seed: 1337,
    };

    const direct = composeAutoTileSheet(fill, null, options);
    const viaWorker = await composeAutoTileInWorker({
      fill: { rgba: fill.data, width: fill.width, height: fill.height },
      underlay: null,
      options,
    });
    expect(
      Buffer.compare(Buffer.from(viaWorker.result.sheet.data), Buffer.from(direct.sheet.data)),
    ).toBe(0);

    const pngBytes = encodeRgbaToPngBytes(
      viaWorker.result.sheet.data,
      viaWorker.result.sheet.width,
      viaWorker.result.sheet.height,
    );

    const artBible = createDefaultArtBible();
    const project: Project = {
      id: 'proj-m20b',
      name: 'Terrain Demo',
      artBible,
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    };
    const node: SpriteNode = {
      id: 'node-tile-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'tile',
      autoTile: createDefaultAutoTileConfig(),
      imageBlobId: 'blob-1',
      sketchSha256: 'a'.repeat(64),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'nibgrid-procedural-v1',
        seed: 7,
        adherence: 'balanced',
        promptDelta: 'grass tile',
        compiledPrompt: 'grass tile',
        createdAt: '2026-11-24T00:00:00.000Z',
      },
    };
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: createDefaultPostProcessConfig(16, 16),
      filename: 'grass_tile.png',
      outputWidth: 16,
      outputHeight: 16,
      assetClass: 'tile',
      autoTile: node.autoTile,
    });

    const zipBytes = packageAutoTileZip({
      assetSlug: 'grass_tile',
      sheetPngBytes: pngBytes,
      tileSize: viaWorker.result.tileSize,
      columns: viaWorker.result.columns,
      rows: viaWorker.result.rows,
      mode: 'blob-47',
      cells: viaWorker.result.cells,
      recipe,
    });

    const entries = unzipSync(zipBytes);
    const outPng = entries['grass_tile_autotile_blob-47.png'];
    expect(outPng).toBeDefined();
    expect(Array.from(outPng!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    expect(strFromU8(entries['grass_tile_tileset.tres']!)).toContain('terrain_set_0/mode = 0');
    expect(strFromU8(entries['grass_tile.tsx']!)).toContain('tilecount="47"');

    const parsedRecipe = AssetRecipeSchema.parse(
      JSON.parse(strFromU8(entries['grass_tile.recipe.json']!)),
    );
    expect(parsedRecipe.autoTile?.mode).toBe('blob-47');
    expect(parsedRecipe.assetClass).toBe('tile');
  });
});
