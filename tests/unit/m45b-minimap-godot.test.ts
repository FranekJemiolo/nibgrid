import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import {
  exportMinimapImportFile,
  exportRoomPortalNodes,
  exportWorldTransitionManagerGd,
} from '../../src/export/godotWorldExporter';
import { parseAndClampRoomBlueprint } from '../../src/processing/roomLayoutCore';
import { rgbaToPngBlob } from '../../src/processing/png';
import { collectProjectGodotSyncFiles } from '../../src/sync/fsaaSyncEngine';
import {
  bakeWorldMinimapRgba,
  deriveMinimapPaletteFromArtBible,
  type RoomCellGrid,
} from '../../src/world/minimapBaker';
import type { WorldGraph } from '../../src/world/worldGraphCore';

describe('M45B: Pixel-Art Minimap Baker, Godot 4 Portal Exporter & M25 Sync', () => {
  it('bakes a crisp 2-room minimap RGBA buffer with matching minimap_atlas.json bounding boxes', () => {
    const graph: WorldGraph = {
      id: 'w-bake',
      projectId: 'p-bake',
      name: 'Two Rooms',
      updatedAt: 1,
      rooms: [
        {
          roomId: 'room-a',
          label: 'Crypt Entry',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: ['red_key'],
        },
        {
          roomId: 'room-b',
          label: 'Vault Boss',
          worldGridPos: { x: 1, y: 0 },
          isGoal: true,
          grantsFlags: [],
        },
      ],
      edges: [
        {
          id: 'edge-ab',
          fromRoomId: 'room-a',
          fromDoorId: 'east_door',
          toRoomId: 'room-b',
          toSpawnId: 'west_spawn',
          bidirectional: true,
          requiredFlags: ['red_key'],
        },
      ],
    };

    const gridA: RoomCellGrid = {
      cols: 12,
      rows: 8,
      cells: Array.from({ length: 8 }, (_, y) =>
        Array.from({ length: 12 }, (_, x) => (y === 0 || y === 7 || x === 0 || x === 11 ? 1 : 0)),
      ),
    };
    const gridB: RoomCellGrid = {
      cols: 12,
      rows: 8,
      cells: Array.from({ length: 8 }, (_, y) =>
        Array.from({ length: 12 }, (_, x) =>
          y === 0 || y === 7 || x === 0 || x === 11 ? 1 : y === 4 && x >= 4 && x <= 7 ? 2 : 0,
        ),
      ),
    };

    const grids = new Map<string, RoomCellGrid>([
      ['room-a', gridA],
      ['room-b', gridB],
    ]);

    const palette = deriveMinimapPaletteFromArtBible(['#1a1c2c', '#566c86', '#ffcd75', '#f4f4f4']);
    const baked = bakeWorldMinimapRgba(graph, grids, { pxPerTile: 2, palette });

    expect(baked.width).toBe(4 * 2 + (12 * 2 + 2) * 2 + 6);
    expect(baked.height).toBe(4 * 2 + (8 * 2 + 2));
    expect(baked.rgba.length).toBe(baked.width * baked.height * 4);

    const boxA = baked.atlas.rooms['room-a']!;
    const boxB = baked.atlas.rooms['room-b']!;
    expect(boxA).toEqual({
      x: 4,
      y: 4,
      width: 26,
      height: 18,
      label: 'Crypt Entry',
      isStart: true,
      isGoal: false,
    });
    expect(boxB).toEqual({
      x: 4 + (26 + 6),
      y: 4,
      width: 26,
      height: 18,
      label: 'Vault Boss',
      isStart: false,
      isGoal: true,
    });

    // Verify top-left corner border pixel of Room A is painted non-background
    const borderIdx = (boxA.y * baked.width + boxA.x) * 4;
    expect(baked.rgba[borderIdx + 3]).toBe(255);
    expect([baked.rgba[borderIdx], baked.rgba[borderIdx + 1], baked.rgba[borderIdx + 2]]).toEqual(
      palette.border.slice(0, 3),
    );

    // Verify connecting door pixel between boxA right edge and boxB left edge matches door palette
    const midY = boxA.y + Math.floor(boxA.height / 2);
    const gapX = boxA.x + boxA.width + 2;
    const gapIdx = (midY * baked.width + gapX) * 4;
    expect([baked.rgba[gapIdx], baked.rgba[gapIdx + 1], baked.rgba[gapIdx + 2]]).toEqual(
      palette.door.slice(0, 3),
    );
  });

  it('exports valid Area2D portals, Marker2D spawns, and typed WorldTransitionManager.gd with zero NaN', () => {
    const graph: WorldGraph = {
      id: 'w-exp',
      projectId: 'p-exp',
      name: 'World Export',
      updatedAt: 1,
      rooms: [
        {
          roomId: 'r1',
          label: 'Hub',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: [],
        },
        {
          roomId: 'r2',
          label: 'Boss',
          worldGridPos: { x: 1, y: 0 },
          isGoal: true,
          grantsFlags: [],
        },
      ],
      edges: [
        {
          id: 'hub-to-boss',
          fromRoomId: 'r1',
          fromDoorId: 'boss_gate',
          toRoomId: 'r2',
          toSpawnId: 'boss_west',
          bidirectional: true,
          requiredFlags: ['boss_key'],
        },
      ],
    };
    const slugMap = new Map([
      ['r1', 'hub_room'],
      ['r2', 'boss_room'],
    ]);

    const r1Nodes = exportRoomPortalNodes('r1', graph.edges, slugMap, {
      cols: 20,
      rows: 12,
      tileSizePx: 16,
    });
    const r2Nodes = exportRoomPortalNodes('r2', graph.edges, slugMap, {
      cols: 20,
      rows: 12,
      tileSizePx: 16,
    });
    const gd = exportWorldTransitionManagerGd(graph, slugMap);
    const imp = exportMinimapImportFile();

    expect(r1Nodes).toContain('[node name="Portal_hub_to_boss" type="Area2D" parent="Portals"]');
    expect(r1Nodes).toContain('metadata/target_room_path = "res://levels/boss_room.tscn"');
    expect(r1Nodes).toContain('metadata/target_spawn_name = "Spawn_boss_west"');
    expect(r1Nodes).toContain('metadata/required_flags = PackedStringArray("boss_key")');
    expect(r1Nodes).toContain('[node name="Spawn_boss_gate" type="Marker2D" parent="Spawns"]');

    expect(r2Nodes).toContain('[node name="Spawn_boss_west" type="Marker2D" parent="Spawns"]');
    expect(r2Nodes).toContain(
      '[node name="Portal_hub_to_boss_Return" type="Area2D" parent="Portals"]',
    );

    expect(gd).toContain('class_name WorldTransitionManager');
    expect(gd).toContain('"r2": "res://levels/boss_room.tscn"');
    expect(gd).toContain('func transition_to_room(');
    expect(imp).toContain('compress/mode=0');
    expect(r1Nodes + r2Nodes + gd).not.toContain('NaN');
    expect(r1Nodes + r2Nodes + gd).not.toContain('undefined');
  });

  it('commits WorldGraph + minimap blobs atomically with zero orphans and emits world sync files', async () => {
    const testDb = new NibgridDatabase(`m45b-test-${Date.now()}-${Math.random()}`);
    const repo = new NibgridRepository(testDb);
    try {
      const project = await repo.createProject('M45B World Sync');
      const bpA = parseAndClampRoomBlueprint(
        { slug: 'entry_hall', displayName: 'Entry Hall' },
        { fallbackPrompt: 'entry hall', cols: 16, rows: 10, tileSizePx: 16 },
      );
      const bpB = parseAndClampRoomBlueprint(
        { slug: 'sanctum', displayName: 'Sanctum' },
        { fallbackPrompt: 'sanctum boss', cols: 16, rows: 10, tileSizePx: 16 },
      );

      const roomA = await repo.saveRoom({
        id: 'room-1',
        projectId: project.id,
        slug: bpA.slug,
        tileSetNodeId: null,
        tileSetMode: 'blob47',
        parallaxNodeId: null,
        blueprint: bpA,
        updatedAt: 100,
      });
      const roomB = await repo.saveRoom({
        id: 'room-2',
        projectId: project.id,
        slug: bpB.slug,
        tileSetNodeId: null,
        tileSetMode: 'blob47',
        parallaxNodeId: null,
        blueprint: bpB,
        updatedAt: 101,
      });

      const graph: WorldGraph = {
        id: `world-${project.id}`,
        projectId: project.id,
        name: 'World Map',
        updatedAt: 200,
        rooms: [
          {
            roomId: roomA.id,
            label: 'Entry Hall',
            worldGridPos: { x: 0, y: 0 },
            isStart: true,
            grantsFlags: ['red_key'],
          },
          {
            roomId: roomB.id,
            label: 'Sanctum',
            worldGridPos: { x: 1, y: 0 },
            isGoal: true,
            grantsFlags: [],
          },
        ],
        edges: [
          {
            id: 'e-main',
            fromRoomId: roomA.id,
            fromDoorId: 'east_gate',
            toRoomId: roomB.id,
            toSpawnId: 'west_entry',
            bidirectional: true,
            requiredFlags: ['red_key'],
          },
        ],
      };

      const grids = new Map<string, RoomCellGrid>([
        [roomA.id, roomA.blueprint],
        [roomB.id, roomB.blueprint],
      ]);
      const baked1 = bakeWorldMinimapRgba(graph, grids, { pxPerTile: 1 });
      const blob1 = rgbaToPngBlob(baked1.rgba, baked1.width, baked1.height);
      const blob2 = rgbaToPngBlob(
        baked1.rgba.map((v, i) => (i % 4 === 3 ? 255 : (v + 1) % 255)),
        baked1.width,
        baked1.height,
      );

      await repo.commitWorldGraphWithMinimap(graph, blob1, JSON.stringify(baked1.atlas));
      const committed = await repo.commitWorldGraphWithMinimap(
        graph,
        blob2,
        JSON.stringify(baked1.atlas),
      );

      expect(committed.minimapBlobId).toBeTruthy();
      expect(await findOrphanBlobIds(testDb)).toEqual([]);

      const syncFiles = await collectProjectGodotSyncFiles(testDb, project, [], [], []);
      const paths = new Map(syncFiles.map((f) => [f.relativePath, f]));

      expect(paths.has('world/minimap.png')).toBe(true);
      expect(paths.has('world/minimap.png.import')).toBe(true);
      expect(paths.has('world/minimap_atlas.json')).toBe(true);
      expect(paths.has('world/WorldTransitionManager.gd')).toBe(true);
      expect(paths.has('world/world_graph.json')).toBe(true);
      expect(String(paths.get('levels/entry_hall.tscn')?.content)).toContain('Area2D');
      expect(String(paths.get('levels/sanctum.tscn')?.content)).toContain('Marker2D');
    } finally {
      testDb.close();
      await testDb.delete();
    }
  });
});
