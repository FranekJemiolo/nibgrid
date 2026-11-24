import { strToU8, zipSync } from 'fflate';
import {
  BIT_E,
  BIT_N,
  BIT_NE,
  BIT_NW,
  BIT_S,
  BIT_SE,
  BIT_SW,
  BIT_W,
  type AutoTileAtlasCell,
  type AutoTileMode,
} from '../processing/autoTile';
import { AssetRecipeSchema, type AssetRecipe } from './recipeBuilder';

export interface ExportGodotTileSetParams {
  readonly assetName: string;
  readonly textureFilename: string;
  readonly tileSize: number;
  readonly mode: AutoTileMode;
  readonly cells: readonly AutoTileAtlasCell[];
}

export interface ExportTiledTsxParams {
  readonly assetName: string;
  readonly textureFilename: string;
  readonly tileSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly mode: AutoTileMode;
  readonly cells: readonly AutoTileAtlasCell[];
}

export interface PackageAutoTileZipParams {
  readonly assetSlug: string;
  readonly sheetPngBytes: Uint8Array;
  readonly tileSize: number;
  readonly columns: number;
  readonly rows: number;
  readonly mode: AutoTileMode;
  readonly cells: readonly AutoTileAtlasCell[];
  readonly recipe: AssetRecipe;
}

function escapeTresString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generates a Godot 4 `TileSet` `.tres` (`format=3`) with Terrain Set peering bits
 * matching Nibgrid's packed Blob-47 (`mode = 0`) or Wang-16 (`mode = 1`) atlas grid.
 */
export function exportGodotTileSetTres(params: ExportGodotTileSetParams): string {
  const name = escapeTresString(params.assetName);
  const tex = escapeTresString(params.textureFilename);
  const tileSize = Math.max(1, Math.round(params.tileSize));
  const terrainMode = params.mode === 'blob-47' ? 0 : 1;

  const lines: string[] = [
    '[gd_resource type="TileSet" load_steps=3 format=3]',
    '',
    `[ext_resource type="Texture2D" path="res://${tex}" id="1_tex"]`,
    '',
    '[sub_resource type="TileSetAtlasSource" id="TileSetAtlasSource_1"]',
    `resource_name = "${name}"`,
    'texture = ExtResource("1_tex")',
    `texture_region_size = Vector2i(${tileSize}, ${tileSize})`,
  ];

  for (const cell of params.cells) {
    const coord = `${cell.col}:${cell.row}/0`;
    lines.push(`${coord} = 0`);

    if (params.mode === 'wang-16' && cell.mask === 0) {
      continue;
    }

    lines.push(`${coord}/terrain_set = 0`);
    lines.push(`${coord}/terrain = 0`);

    if (params.mode === 'blob-47') {
      if ((cell.mask & BIT_N) !== 0) lines.push(`${coord}/terrains_peering_bit/top_side = 0`);
      if ((cell.mask & BIT_NE) !== 0) {
        lines.push(`${coord}/terrains_peering_bit/top_right_corner = 0`);
      }
      if ((cell.mask & BIT_E) !== 0) lines.push(`${coord}/terrains_peering_bit/right_side = 0`);
      if ((cell.mask & BIT_SE) !== 0) {
        lines.push(`${coord}/terrains_peering_bit/bottom_right_corner = 0`);
      }
      if ((cell.mask & BIT_S) !== 0) lines.push(`${coord}/terrains_peering_bit/bottom_side = 0`);
      if ((cell.mask & BIT_SW) !== 0) {
        lines.push(`${coord}/terrains_peering_bit/bottom_left_corner = 0`);
      }
      if ((cell.mask & BIT_W) !== 0) lines.push(`${coord}/terrains_peering_bit/left_side = 0`);
      if ((cell.mask & BIT_NW) !== 0) {
        lines.push(`${coord}/terrains_peering_bit/top_left_corner = 0`);
      }
    } else {
      if ((cell.mask & 4) !== 0) lines.push(`${coord}/terrains_peering_bit/top_right_corner = 0`);
      if ((cell.mask & 2) !== 0) {
        lines.push(`${coord}/terrains_peering_bit/bottom_right_corner = 0`);
      }
      if ((cell.mask & 1) !== 0) lines.push(`${coord}/terrains_peering_bit/bottom_left_corner = 0`);
      if ((cell.mask & 8) !== 0) lines.push(`${coord}/terrains_peering_bit/top_left_corner = 0`);
    }
  }

  lines.push(
    '',
    '[resource]',
    `tile_size = Vector2i(${tileSize}, ${tileSize})`,
    `terrain_set_0/mode = ${terrainMode}`,
    `terrain_set_0/terrain_0/name = "${name}"`,
    'terrain_set_0/terrain_0/color = Color(0.898, 0.627, 0.051, 1)',
    'sources/0 = SubResource("TileSetAtlasSource_1")',
    '',
  );

  return lines.join('\n');
}

/**
 * Exports a Tiled `.tsx` tileset XML containing `<wangsets>` in Tiled's clockwise 8-slot `wangid`
 * convention (`N, NE, E, SE, S, SW, W, NW`).
 */
export function exportTiledTsx(params: ExportTiledTsxParams): string {
  const name = escapeXmlAttr(params.assetName);
  const tex = escapeXmlAttr(params.textureFilename);
  const tileSize = Math.max(1, Math.round(params.tileSize));
  const columns = Math.max(1, Math.round(params.columns));
  const rows = Math.max(1, Math.round(params.rows));
  const sheetW = columns * tileSize;
  const sheetH = rows * tileSize;
  const wangType = params.mode === 'blob-47' ? 'mixed' : 'corner';
  const solidMask = params.mode === 'blob-47' ? 255 : 15;
  const solidCell =
    params.cells.find((c) => c.mask === solidMask) ?? params.cells[params.cells.length - 1];
  const solidTileId = solidCell ? solidCell.row * columns + solidCell.col : 0;

  const wangTileLines = params.cells.map((cell) => {
    const tileId = cell.row * columns + cell.col;
    let slots: readonly number[];
    if (params.mode === 'blob-47') {
      slots = [
        (cell.mask & BIT_N) !== 0 ? 1 : 0,
        (cell.mask & BIT_NE) !== 0 ? 1 : 0,
        (cell.mask & BIT_E) !== 0 ? 1 : 0,
        (cell.mask & BIT_SE) !== 0 ? 1 : 0,
        (cell.mask & BIT_S) !== 0 ? 1 : 0,
        (cell.mask & BIT_SW) !== 0 ? 1 : 0,
        (cell.mask & BIT_W) !== 0 ? 1 : 0,
        (cell.mask & BIT_NW) !== 0 ? 1 : 0,
      ];
    } else {
      slots = [
        0,
        (cell.mask & 4) !== 0 ? 1 : 0,
        0,
        (cell.mask & 2) !== 0 ? 1 : 0,
        0,
        (cell.mask & 1) !== 0 ? 1 : 0,
        0,
        (cell.mask & 8) !== 0 ? 1 : 0,
      ];
    }
    return `      <wangtile tileid="${tileId}" wangid="${slots.join(',')}"/>`;
  });

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<tileset version="1.10" tiledversion="1.11.0" name="${name}" tilewidth="${tileSize}" tileheight="${tileSize}" tilecount="${params.cells.length}" columns="${columns}">`,
    `  <image source="${tex}" width="${sheetW}" height="${sheetH}"/>`,
    '  <wangsets>',
    `    <wangset name="${name}" type="${wangType}" tile="${solidTileId}">`,
    `      <wangcolor name="${name}" color="#e5a00d" tile="${solidTileId}" probability="1"/>`,
    ...wangTileLines,
    '    </wangset>',
    '  </wangsets>',
    '</tileset>',
    '',
  ].join('\n');
}

/**
 * Packages the packed auto-tile PNG, Godot 4 `.tres`, Tiled `.tsx`, and validated `.recipe.json` into a deterministic ZIP archive.
 */
export function packageAutoTileZip(params: PackageAutoTileZipParams): Uint8Array {
  const validatedRecipe = AssetRecipeSchema.parse(params.recipe);
  const textureFilename = `${params.assetSlug}_autotile_${params.mode}.png`;

  const tresContent = exportGodotTileSetTres({
    assetName: params.assetSlug,
    textureFilename,
    tileSize: params.tileSize,
    mode: params.mode,
    cells: params.cells,
  });

  const tsxContent = exportTiledTsx({
    assetName: params.assetSlug,
    textureFilename,
    tileSize: params.tileSize,
    columns: params.columns,
    rows: params.rows,
    mode: params.mode,
    cells: params.cells,
  });

  return zipSync({
    [textureFilename]: params.sheetPngBytes,
    [`${params.assetSlug}_tileset.tres`]: strToU8(tresContent),
    [`${params.assetSlug}.tsx`]: strToU8(tsxContent),
    [`${params.assetSlug}.recipe.json`]: strToU8(JSON.stringify(validatedRecipe, null, 2)),
  });
}
