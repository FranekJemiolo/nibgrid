import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository } from '../../src/db/database';
import {
  EntityDefinitionSchema,
  type FileSystemDirectoryHandleLike,
  type FileSystemFileHandleLike,
} from '../../src/domain/entitySchema';
import { validateGdScript } from '../../src/export/gdscriptGenerator';
import { exportProjectGodot } from '../../src/export/godotGameKitExporter';
import { assembleGodotGameKitFiles } from '../../src/export/godotPluginExporter';
import { validateGodotSceneGraph } from '../../src/export/godotProjectCompiler';
import { exportGameKitRuntimeScripts } from '../../src/export/godotRuntimeScripts';
import { generateMockRoomBlueprint } from '../../src/providers/roomPrototyperAdapter';
import {
  clearInMemorySyncHandles,
  pullGodotEditorDeltaFromDirectory,
  setInMemoryDirectoryHandle,
  syncFilesToGodotDirectory,
} from '../../src/sync/fsaaSyncEngine';
import { classifySyncFileOwnership } from '../../src/sync/syncOwnership';
import {
  WORKSPACE_SHELL_ITEMS,
  resolveWorkspaceForScreen,
} from '../../src/ui/layout/workspaceShell';

const dbs: NibgridDatabase[] = [];

function createTestDb(): NibgridDatabase {
  const db = new NibgridDatabase(`nibgrid-m56-${globalThis.crypto.randomUUID()}`);
  dbs.push(db);
  return db;
}

function createReadableMockFs() {
  const files = new Map<string, Uint8Array>();

  const makeDir = (prefix: string): FileSystemDirectoryHandleLike => ({
    name: prefix === '' ? 'm56_godot_res' : prefix.split('/').pop()!,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async (segment: string) =>
      makeDir(prefix === '' ? segment : `${prefix}/${segment}`),
    getFileHandle: async (
      filename: string,
      opts?: { create?: boolean },
    ): Promise<FileSystemFileHandleLike> => {
      const fullPath = prefix === '' ? filename : `${prefix}/${filename}`;
      if (opts?.create === false && !files.has(fullPath)) {
        throw new Error(`File not found: ${fullPath}`);
      }
      let chunks: Uint8Array[] = [];
      return {
        name: filename,
        createWritable: async () => {
          chunks = [];
          return {
            write: async (data: BufferSource | Blob | string) => {
              if (typeof data === 'string') {
                chunks.push(new TextEncoder().encode(data));
              } else if (data instanceof Blob) {
                chunks.push(new Uint8Array(await data.arrayBuffer()));
              } else if (ArrayBuffer.isView(data)) {
                chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
              } else {
                chunks.push(new Uint8Array(data));
              }
            },
            close: async () => {
              const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
              const combined = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                combined.set(c, off);
                off += c.byteLength;
              }
              files.set(fullPath, combined);
            },
          };
        },
        getFile: async () => {
          const buf = files.get(fullPath) ?? new Uint8Array();
          return {
            size: buf.byteLength,
            text: async () => new TextDecoder().decode(buf),
          };
        },
      };
    },
    removeEntry: async (name: string) => {
      const fullPath = prefix === '' ? name : `${prefix}/${name}`;
      files.delete(fullPath);
    },
  });

  return { files, rootHandle: makeDir('') };
}

afterEach(async () => {
  clearInMemorySyncHandles();
  await Promise.all(dbs.splice(0).map((d) => d.delete()));
});

describe('M56–M59: Playable F5 Runtime, Ownership Sync, Delta Pull & Director-First UX', () => {
  it('emits valid Godot 4.3+ runtime controllers for all 3 GameKit templates with 0 broken res:// refs', () => {
    for (const templateId of ['side-platformer', 'top-down-action', 'cozy-rpg'] as const) {
      const scripts = exportGameKitRuntimeScripts(templateId);
      expect(scripts.map((s) => s.relativePath)).toEqual([
        'scripts/runtime/PlayerController.gd',
        'scripts/runtime/EnemyAiController.gd',
        'scripts/runtime/NpcController.gd',
        'scripts/runtime/SaveManager.gd',
      ]);

      for (const s of scripts) {
        if (s.relativePath.endsWith('SaveManager.gd')) {
          expect(s.content).toContain('extends Node');
          expect(s.content).not.toMatch(/\bKinematicBody2D\b|\byield\s*\(/);
        } else {
          const res = validateGdScript(s.content, 'CharacterBody2D');
          expect(res.valid, `${s.relativePath}: ${res.reasons.join('; ')}`).toBe(true);
        }
      }

      const bundle = assembleGodotGameKitFiles({
        projectName: 'Playable Saga',
        templateId,
        entities: [
          EntityDefinitionSchema.parse({
            id: 'ent-hero',
            projectId: 'p1',
            slug: 'red_cat_hero',
            displayName: 'Red Cat Hero',
            bodyType: 'CharacterBody2D',
            resSubpath: 'entities',
            primarySpriteNodeId: 'sp1',
            updatedAt: 1,
          }),
          EntityDefinitionSchema.parse({
            id: 'ent-slime',
            projectId: 'p1',
            slug: 'moss_slime',
            displayName: 'Moss Slime',
            bodyType: 'CharacterBody2D',
            resSubpath: 'entities',
            primarySpriteNodeId: 'sp2',
            updatedAt: 1,
          }),
        ],
      });

      const validation = validateGodotSceneGraph(bundle);
      expect(validation.brokenReferences).toEqual([]);
      expect(validation.ok).toBe(true);

      const heroTscn = bundle.find((f) => f.relativePath.endsWith('red_cat_hero_prefab.tscn'))
        ?.content as string;
      const slimeTscn = bundle.find((f) => f.relativePath.endsWith('moss_slime_prefab.tscn'))
        ?.content as string;
      expect(heroTscn).toContain('res://scripts/runtime/PlayerController.gd');
      expect(slimeTscn).toContain('res://scripts/runtime/EnemyAiController.gd');
    }

    const ini = exportProjectGodot({
      projectName: 'Playable Saga',
      templateId: 'side-platformer',
      includeWorldAutoload: true,
      includeDialogueAutoload: true,
      includeSaveAutoload: true,
    });
    expect(ini).toContain('SaveManager="*res://scripts/runtime/SaveManager.gd"');
  });

  it('preserves user-modified scaffold-once files by default and overwrites only when preserveUserScaffolds is false', async () => {
    expect(classifySyncFileOwnership('scripts/GameShell.gd')).toBe('scaffold-once');
    expect(classifySyncFileOwnership('scripts/runtime/PlayerController.gd')).toBe('scaffold-once');
    expect(classifySyncFileOwnership('project.godot')).toBe('scaffold-once');
    expect(classifySyncFileOwnership('sprites/hero.png')).toBe('nibgrid-managed');

    const db = createTestDb();
    const mockFs = createReadableMockFs();
    setInMemoryDirectoryHandle('proj-own', mockFs.rootHandle);

    const v1 = [
      { relativePath: 'scripts/GameShell.gd', content: 'extends Node2D\n# v1' },
      { relativePath: 'sprites/hero.png', content: 'png-v1' },
    ];
    const sync1 = await syncFilesToGodotDirectory(db, 'proj-own', v1);
    expect(sync1.writtenCount).toBe(2);
    expect(sync1.preservedCount).toBe(0);

    // User customizes GameShell.gd on disk in Godot
    mockFs.files.set(
      'scripts/GameShell.gd',
      new TextEncoder().encode('extends Node2D\n# USER CUSTOM LOGIC'),
    );

    // Second sync with updated GameShell.gd + updated sprite + removed sprite
    const v2 = [
      { relativePath: 'scripts/GameShell.gd', content: 'extends Node2D\n# v2 from nibgrid' },
      { relativePath: 'sprites/hero.png', content: 'png-v2' },
    ];
    const sync2 = await syncFilesToGodotDirectory(db, 'proj-own', v2);
    expect(sync2.preservedCount).toBe(1);
    expect(sync2.preservedPaths).toEqual(['scripts/GameShell.gd']);
    expect(new TextDecoder().decode(mockFs.files.get('scripts/GameShell.gd'))).toContain(
      'USER CUSTOM LOGIC',
    );
    expect(new TextDecoder().decode(mockFs.files.get('sprites/hero.png'))).toBe('png-v2');

    // Explicit opt-out overwrites user scaffold cleanly
    const sync3 = await syncFilesToGodotDirectory(db, 'proj-own', v2, {
      preserveUserScaffolds: false,
    });
    expect(sync3.preservedCount).toBe(0);
    expect(new TextDecoder().decode(mockFs.files.get('scripts/GameShell.gd'))).toContain(
      'v2 from nibgrid',
    );
  });

  it('pulls .nibgrid_sync_delta.json from bound directory into Dexie entities & rooms', async () => {
    const db = createTestDb();
    const repo = new NibgridRepository(db);
    const mockFs = createReadableMockFs();
    setInMemoryDirectoryHandle('proj-delta', mockFs.rootHandle);

    const entity = EntityDefinitionSchema.parse({
      id: 'ent-1',
      projectId: 'proj-delta',
      slug: 'red_cat',
      displayName: 'Red Cat',
      bodyType: 'CharacterBody2D',
      resSubpath: 'entities',
      primarySpriteNodeId: 'sp-1',
      updatedAt: 1,
    });
    const roomBp = generateMockRoomBlueprint({
      prompt: 'courtyard stone tiles',
      cols: 24,
      rows: 14,
      tileSizePx: 16,
      availableEntitySlugs: ['red_cat'],
    });
    const room = {
      id: 'room-1',
      projectId: 'proj-delta',
      slug: roomBp.slug,
      tileSetNodeId: null,
      tileSetMode: 'blob47' as const,
      parallaxNodeId: null,
      blueprint: roomBp,
      updatedAt: 1,
    };
    await repo.saveEntity(entity);
    await repo.saveRoom(room);

    mockFs.files.set(
      '.nibgrid_sync_delta.json',
      new TextEncoder().encode(
        JSON.stringify({
          version: 1,
          updatedAt: 99,
          entityStatOverrides: [{ slug: 'red_cat', moveSpeedPx: 235, attackDamage: 40 }],
          roomSpawnOverrides: [{ roomSlug: room.slug, playerSpawnX: 5, playerSpawnY: 7 }],
        }),
      ),
    );

    const res = await pullGodotEditorDeltaFromDirectory(db, 'proj-delta', [entity], [room]);
    expect(res.updatedEntityCount).toBe(1);
    expect(res.updatedRoomCount).toBe(1);
    expect(res.unmatchedSlugs).toEqual([]);

    const savedEntities = await repo.listEntities('proj-delta');
    expect(savedEntities[0]?.playtestConfig?.moveSpeedPx).toBe(235);
    expect(savedEntities[0]?.playtestConfig?.attackDamage).toBe(40);

    const savedRooms = await repo.listRooms('proj-delta');
    expect(savedRooms[0]?.blueprint.playerSpawn).toEqual({ cellX: 5, cellY: 7 });
  });

  it('defaults Workspace 1 (Style & Vision) to Director Studio while keeping bible mapped cleanly', () => {
    const ws1 = WORKSPACE_SHELL_ITEMS.find((w) => w.id === 'style-vision');
    expect(ws1?.defaultScreen).toBe('director');
    expect(resolveWorkspaceForScreen('director')).toBe('style-vision');
    expect(resolveWorkspaceForScreen('bible')).toBe('style-vision');
  });
});
