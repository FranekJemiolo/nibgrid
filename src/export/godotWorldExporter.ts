import { strToU8 } from 'fflate';
import { sanitizeRoomSlug } from '../processing/roomLayoutCore';
import type { MinimapAtlas } from '../world/minimapBaker';
import { normalizeWorldFlag, type WorldGraph, type WorldPortalEdge } from '../world/worldGraphCore';
import type { VirtualSyncFile } from './godotPrefabAssembler';

function sanitizeGodotIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (!cleaned) return fallback;
  return /^[0-9]/.test(cleaned) ? `N_${cleaned}` : cleaned;
}

function escapeGdString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function finiteCoord(value: number, fallback = 64): number {
  if (!Number.isFinite(value)) return fallback;
  const rounded = Number(value.toFixed(2));
  return Object.is(rounded, -0) ? 0 : rounded;
}

export interface RoomPortalDims {
  readonly cols: number;
  readonly rows: number;
  readonly tileSizePx: number;
}

/**
 * Generates Godot 4 `Area2D` portal triggers (`Portals/Portal_<edgeId>`) and `Marker2D`
 * spawn markers (`Spawns/Spawn_<spawnId>`) for a single M35 room scene `.tscn`.
 */
export function exportRoomPortalNodes(
  roomId: string,
  edges: readonly WorldPortalEdge[],
  roomSlugById?: ReadonlyMap<string, string>,
  roomDims: RoomPortalDims = { cols: 24, rows: 14, tileSizePx: 16 },
): string {
  const widthPx = Math.max(64, finiteCoord(roomDims.cols * roomDims.tileSizePx, 384));
  const heightPx = Math.max(64, finiteCoord(roomDims.rows * roomDims.tileSizePx, 224));

  const outgoing: Array<{
    nodeName: string;
    targetRoomId: string;
    targetSpawnName: string;
    requiredFlags: readonly string[];
    slotIndex: number;
  }> = [];

  const incoming: Array<{
    nodeName: string;
    slotIndex: number;
  }> = [];

  edges.forEach((edge, index) => {
    const cleanFlags = edge.requiredFlags.map(normalizeWorldFlag).filter(Boolean);
    if (edge.fromRoomId === roomId) {
      outgoing.push({
        nodeName: `Portal_${sanitizeGodotIdentifier(edge.id, `edge_${index + 1}`)}`,
        targetRoomId: edge.toRoomId,
        targetSpawnName: `Spawn_${sanitizeGodotIdentifier(edge.toSpawnId, 'entry')}`,
        requiredFlags: cleanFlags,
        slotIndex: outgoing.length,
      });
    }
    if (edge.toRoomId === roomId) {
      incoming.push({
        nodeName: `Spawn_${sanitizeGodotIdentifier(edge.toSpawnId, `entry_${index + 1}`)}`,
        slotIndex: incoming.length,
      });
      if (edge.bidirectional) {
        outgoing.push({
          nodeName: `Portal_${sanitizeGodotIdentifier(edge.id, `edge_${index + 1}`)}_Return`,
          targetRoomId: edge.fromRoomId,
          targetSpawnName: `Spawn_${sanitizeGodotIdentifier(edge.fromDoorId, 'return')}`,
          requiredFlags: cleanFlags,
          slotIndex: outgoing.length,
        });
      }
    }
    if (edge.fromRoomId === roomId && edge.bidirectional) {
      incoming.push({
        nodeName: `Spawn_${sanitizeGodotIdentifier(edge.fromDoorId, `return_${index + 1}`)}`,
        slotIndex: incoming.length,
      });
    }
  });

  if (outgoing.length === 0 && incoming.length === 0) {
    return '';
  }

  const lines: string[] = [];

  if (outgoing.length > 0) {
    lines.push('[node name="Portals" type="Node2D" parent="."]');
    const usedPortalNames = new Set<string>();
    for (const portal of outgoing) {
      let nodeName = portal.nodeName;
      let suffix = 2;
      while (usedPortalNames.has(nodeName)) {
        nodeName = `${portal.nodeName}_${suffix++}`;
      }
      usedPortalNames.add(nodeName);

      const rawTargetSlug = roomSlugById?.get(portal.targetRoomId) ?? portal.targetRoomId;
      const targetSlug = sanitizeRoomSlug(rawTargetSlug);
      const targetResPath = `res://levels/${targetSlug}.tscn`;
      const posX = finiteCoord(widthPx - Math.max(24, roomDims.tileSizePx * 1.5));
      const posY = finiteCoord(
        Math.min(
          heightPx - roomDims.tileSizePx,
          roomDims.tileSizePx * 2 + portal.slotIndex * roomDims.tileSizePx * 2,
        ),
      );
      const flagsExpr = portal.requiredFlags.map((f) => `"${escapeGdString(f)}"`).join(', ');

      lines.push(
        '',
        `[node name="${nodeName}" type="Area2D" parent="Portals"]`,
        `position = Vector2(${posX}, ${posY})`,
        `metadata/target_room_path = "${escapeGdString(targetResPath)}"`,
        `metadata/target_spawn_name = "${escapeGdString(portal.targetSpawnName)}"`,
        `metadata/required_flags = PackedStringArray(${flagsExpr})`,
        '',
        `[node name="CollisionShape2D" type="CollisionShape2D" parent="Portals/${nodeName}"]`,
        'debug_color = Color(0.96, 0.72, 0.18, 0.35)',
      );
    }
  }

  if (incoming.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('[node name="Spawns" type="Node2D" parent="."]');
    const usedSpawnNames = new Set<string>();
    for (const spawn of incoming) {
      let nodeName = spawn.nodeName;
      let suffix = 2;
      while (usedSpawnNames.has(nodeName)) {
        nodeName = `${spawn.nodeName}_${suffix++}`;
      }
      usedSpawnNames.add(nodeName);

      const posX = finiteCoord(Math.max(24, roomDims.tileSizePx * 1.5));
      const posY = finiteCoord(
        Math.min(
          heightPx - roomDims.tileSizePx,
          roomDims.tileSizePx * 2 + spawn.slotIndex * roomDims.tileSizePx * 2,
        ),
      );

      lines.push(
        '',
        `[node name="${nodeName}" type="Marker2D" parent="Spawns"]`,
        `position = Vector2(${posX}, ${posY})`,
      );
    }
  }

  return lines.join('\n');
}

/**
 * Generates a typed Godot 4 autoload script (`WorldTransitionManager.gd`) handling
 * fade transitions, target `Marker2D` placement, unlocked flags, and minimap discovery.
 */
export function exportWorldTransitionManagerGd(
  graph: WorldGraph,
  roomSlugById?: ReadonlyMap<string, string>,
): string {
  const roomEntries = graph.rooms.map((room) => {
    const rawSlug = roomSlugById?.get(room.roomId) ?? room.roomId;
    const slug = sanitizeRoomSlug(rawSlug);
    return `\t"${escapeGdString(room.roomId)}": "res://levels/${escapeGdString(slug)}.tscn",`;
  });

  return [
    'extends Node',
    'class_name WorldTransitionManager',
    '',
    '## Auto-generated by Nibgrid Milestone 45',
    'const MINIMAP_ATLAS_PATH: String = "res://world/minimap_atlas.json"',
    'const ROOM_SCENES: Dictionary = {',
    ...roomEntries,
    '}',
    '',
    'var unlocked_flags: Dictionary = {}',
    'var visited_rooms: Dictionary = {}',
    'var pending_spawn_name: String = "PlayerSpawn"',
    'var _transition_busy: bool = false',
    '',
    'signal flag_granted(flag_name: String)',
    'signal room_entered(room_id: String)',
    '',
    'func grant_flag(flag_name: String) -> void:',
    '\tvar clean := flag_name.strip_edges().to_lower()',
    '\tif clean.is_empty():',
    '\t\treturn',
    '\tif not unlocked_flags.has(clean):',
    '\t\tunlocked_flags[clean] = true',
    '\t\tflag_granted.emit(clean)',
    '',
    'func has_required_flags(required_flags: PackedStringArray) -> bool:',
    '\tfor req in required_flags:',
    '\t\tif not unlocked_flags.has(req.strip_edges().to_lower()):',
    '\t\t\treturn false',
    '\treturn true',
    '',
    'func mark_room_visited(room_id: String) -> void:',
    '\tif room_id.is_empty():',
    '\t\treturn',
    '\tvisited_rooms[room_id] = true',
    '\troom_entered.emit(room_id)',
    '',
    'func transition_to_room(target_room_path: String, target_spawn_name: String = "PlayerSpawn", required_flags: PackedStringArray = PackedStringArray()) -> bool:',
    '\tif _transition_busy:',
    '\t\treturn false',
    '\tif not has_required_flags(required_flags):',
    '\t\treturn false',
    '\t_transition_busy = true',
    '\tpending_spawn_name = target_spawn_name if not target_spawn_name.is_empty() else "PlayerSpawn"',
    '\tvar err := get_tree().change_scene_to_file(target_room_path)',
    '\t_transition_busy = false',
    '\tif err == OK:',
    '\t\tcall_deferred("_place_player_at_spawn", pending_spawn_name)',
    '\t\treturn true',
    '\treturn false',
    '',
    'func _place_player_at_spawn(spawn_name: String) -> void:',
    '\tvar root := get_tree().current_scene',
    '\tif root == null:',
    '\t\treturn',
    '\tvar marker := root.find_child(spawn_name, true, false)',
    '\tif marker == null:',
    '\t\tmarker = root.get_node_or_null("PlayerSpawn")',
    '\tvar player := root.find_child("Player", true, false)',
    '\tif marker is Node2D and player is Node2D:',
    '\t\t(player as Node2D).global_position = (marker as Node2D).global_position',
    '',
  ].join('\n');
}

export function exportMinimapImportFile(resPath = 'res://world/minimap.png'): string {
  return [
    '# Nibgrid Pixel-Art Minimap Import (texture_filter = 1 nearest-neighbor)',
    '[remap]',
    'importer="texture"',
    'type="CompressedTexture2D"',
    '',
    '[deps]',
    `source_file="${escapeGdString(resPath)}"`,
    '',
    '[params]',
    'compress/mode=0',
    'compress/high_quality=false',
    'mipmaps/generate=false',
    'process/fix_alpha_border=true',
    'svg/scale=1.0',
    '',
  ].join('\n');
}

/**
 * Emits all virtual `res://world/` files for M25 Live `res://` Sync and World bundles.
 */
export function assembleGodotWorldFiles(params: {
  readonly graph: WorldGraph;
  readonly roomSlugById: ReadonlyMap<string, string>;
  readonly minimapPngBytes: Uint8Array;
  readonly minimapAtlas: MinimapAtlas;
}): readonly VirtualSyncFile[] {
  const { graph, roomSlugById, minimapPngBytes, minimapAtlas } = params;
  const gdScript = exportWorldTransitionManagerGd(graph, roomSlugById);
  const minimapImport = exportMinimapImportFile('res://world/minimap.png');
  const atlasJson = `${JSON.stringify(minimapAtlas, null, 2)}\n`;
  const worldGraphJson = `${JSON.stringify(graph, null, 2)}\n`;

  return [
    {
      relativePath: 'world/WorldTransitionManager.gd',
      content: strToU8(gdScript),
    },
    {
      relativePath: 'world/minimap.png',
      content: minimapPngBytes,
    },
    {
      relativePath: 'world/minimap.png.import',
      content: strToU8(minimapImport),
    },
    {
      relativePath: 'world/minimap_atlas.json',
      content: strToU8(atlasJson),
    },
    {
      relativePath: 'world/world_graph.json',
      content: strToU8(worldGraphJson),
    },
  ];
}
