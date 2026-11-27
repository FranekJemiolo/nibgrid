import { strToU8, zipSync } from 'fflate';
import type { VirtualSyncFile } from './godotPrefabAssembler';
import { AssetRecipeSchema, type AssetRecipe } from './recipeBuilder';
import {
  encodeGodotTileMapData,
  resolveRoomAutoTileCells,
  sanitizeRoomSlug,
  type RoomLayoutBlueprint,
  type RoomTileSetMode,
} from '../processing/roomLayoutCore';

export interface ExportGodotRoomTscnParams {
  readonly blueprint: RoomLayoutBlueprint;
  readonly tileSetMode: RoomTileSetMode;
  readonly tileSetResPath?: string;
  readonly parallaxResPath?: string;
  readonly entityResPaths?: Readonly<Record<string, string>>;
  readonly isPixelArt?: boolean;
  readonly portalNodesSnippet?: string;
}

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toPascalCase(raw: string, fallback: string): string {
  const parts = raw
    .split(/[^a-zA-Z0-9]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return fallback;
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `Room${joined}` : joined;
}

function roundTo(value: number, decimals = 2): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Generates a valid Godot 4.3+ `.tscn` level scene combining a `TileMapLayer` (`tile_map_data`),
 * optional M23 `Parallax2D` background instance, `PlayerSpawn` `Marker2D`, clamped `Camera2D`,
 * and instanced M25 Entity `.tscn` prefabs.
 */
export function exportGodotRoomTscn(params: ExportGodotRoomTscnParams): string {
  const { blueprint, tileSetMode } = params;
  const isPixelArt = params.isPixelArt ?? true;
  const slug = sanitizeRoomSlug(blueprint.slug || blueprint.displayName);
  const rootName = toPascalCase(slug, 'NibgridRoom');
  const tileSize = blueprint.tileSizePx;

  const extLines: string[] = [];
  let nextExtCounter = 1;

  let tileSetExtId: string | null = null;
  if (params.tileSetResPath?.trim()) {
    tileSetExtId = `${nextExtCounter++}_tileset`;
    extLines.push(
      `[ext_resource type="TileSet" path="${escapeGodotString(params.tileSetResPath.trim())}" id="${tileSetExtId}"]`,
    );
  }

  let parallaxExtId: string | null = null;
  if (params.parallaxResPath?.trim()) {
    parallaxExtId = `${nextExtCounter++}_parallax`;
    extLines.push(
      `[ext_resource type="PackedScene" path="${escapeGodotString(params.parallaxResPath.trim())}" id="${parallaxExtId}"]`,
    );
  }

  const entityExtIdBySlug = new Map<string, string>();
  for (const placement of blueprint.entities) {
    const entSlug = sanitizeRoomSlug(placement.entitySlug);
    if (entityExtIdBySlug.has(entSlug)) continue;
    const extId = `${nextExtCounter++}_entity_${entSlug}`;
    const resolvedPath =
      params.entityResPaths?.[entSlug]?.trim() || `res://entities/${entSlug}/${entSlug}.tscn`;
    entityExtIdBySlug.set(entSlug, extId);
    extLines.push(
      `[ext_resource type="PackedScene" path="${escapeGodotString(resolvedPath)}" id="${extId}"]`,
    );
  }

  const loadSteps = extLines.length + 1;
  const resolvedCells = resolveRoomAutoTileCells(blueprint, tileSetMode);
  const packedBytes = encodeGodotTileMapData(resolvedCells);
  const packedByteStr = Array.from(packedBytes).join(', ');

  const lines: string[] = [`[gd_scene load_steps=${loadSteps} format=3]`];
  if (extLines.length > 0) {
    lines.push('', ...extLines);
  }

  lines.push('', `[node name="${rootName}" type="Node2D"]`);

  if (parallaxExtId) {
    lines.push('', `[node name="Background" parent="." instance=ExtResource("${parallaxExtId}")]`);
  }

  const terrainBlock = [
    '',
    '[node name="Terrain" type="TileMapLayer" parent="."]',
    `tile_map_data = PackedByteArray(${packedByteStr})`,
  ];
  if (tileSetExtId) {
    terrainBlock.push(`tile_set = ExtResource("${tileSetExtId}")`);
  }
  if (isPixelArt) {
    terrainBlock.push('texture_filter = 1');
  }
  lines.push(...terrainBlock);

  const spawnX = roundTo((blueprint.playerSpawn.cellX + 0.5) * tileSize);
  const spawnY = roundTo((blueprint.playerSpawn.cellY + 0.5) * tileSize);
  lines.push(
    '',
    '[node name="PlayerSpawn" type="Marker2D" parent="."]',
    `position = Vector2(${spawnX}, ${spawnY})`,
  );

  lines.push(
    '',
    '[node name="Camera2D" type="Camera2D" parent="."]',
    'limit_left = 0',
    'limit_top = 0',
    `limit_right = ${blueprint.cols * tileSize}`,
    `limit_bottom = ${blueprint.rows * tileSize}`,
  );

  lines.push('', '[node name="Entities" type="Node2D" parent="."]');
  blueprint.entities.forEach((placement, idx) => {
    const entSlug = sanitizeRoomSlug(placement.entitySlug);
    const extId = entityExtIdBySlug.get(entSlug);
    if (!extId) return;
    const nodeName = `${toPascalCase(entSlug, 'Entity')}_${idx + 1}`;
    const posX = roundTo((placement.cellX + 0.5) * tileSize);
    const posY = roundTo((placement.cellY + 0.5) * tileSize);
    lines.push(
      '',
      `[node name="${nodeName}" parent="Entities" instance=ExtResource("${extId}")]`,
      `position = Vector2(${posX}, ${posY})`,
    );
    if (placement.facing === 'left') {
      lines.push('scale = Vector2(-1, 1)');
    }
  });

  if (params.portalNodesSnippet?.trim()) {
    lines.push('', params.portalNodesSnippet.trimEnd());
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * Produces virtual `levels/<slug>.tscn` files for M25 Live `res://` Sync and standalone exports.
 */
export function assembleGodotRoomFiles(
  params: ExportGodotRoomTscnParams,
): readonly VirtualSyncFile[] {
  const slug = sanitizeRoomSlug(params.blueprint.slug || params.blueprint.displayName);
  const tscn = exportGodotRoomTscn(params);
  return [
    {
      relativePath: `levels/${slug}.tscn`,
      content: tscn,
    },
  ];
}

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{8,}/,
  /(^|[^A-Za-z0-9_-])sk-[0-9A-Za-z_-]{12,}/,
  /(^|[^A-Za-z0-9_-])nbg_[0-9A-Za-z_-]{6,}/,
  /"apiKey"\s*:/i,
];

/**
 * Packages `levels/<slug>.tscn` alongside a strictly schema-validated, secret-free `recipe.json`.
 */
export function packageRoomBundleZip(params: {
  readonly slug: string;
  readonly tscnContent: string;
  readonly recipe: AssetRecipe;
}): Uint8Array {
  const safeSlug = sanitizeRoomSlug(params.slug);
  const validatedRecipe = AssetRecipeSchema.parse(params.recipe);
  const recipeJson = `${JSON.stringify(validatedRecipe, null, 2)}\n`;

  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (pattern.test(recipeJson) || pattern.test(params.tscnContent)) {
      throw new Error('Refusing to package room bundle containing sensitive key material.');
    }
  }

  return zipSync(
    {
      [`levels/${safeSlug}.tscn`]: strToU8(params.tscnContent),
      'recipe.json': strToU8(recipeJson),
    },
    { level: 6 },
  );
}
