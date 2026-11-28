import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository } from '../../src/db/database';
import {
  EntityDefinitionSchema,
  type FileSystemDirectoryHandleLike,
  type FileSystemFileHandleLike,
} from '../../src/domain/entitySchema';
import {
  SpriteNodeSchema,
  createDefaultArtBible,
  createDefaultAutoTileConfig,
  createDefaultParallaxSceneConfig,
  createDefaultShaderConfig,
} from '../../src/domain/schemas';
import type { VirtualSyncFile } from '../../src/export/godotPrefabAssembler';
import {
  resolveEntityGameKitAssets,
  validateGodotSceneGraph,
} from '../../src/export/godotProjectCompiler';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import { generateMockRoomBlueprint } from '../../src/providers/roomPrototyperAdapter';
import {
  clearInMemorySyncHandles,
  collectAndValidateProjectGodotSyncFiles,
  setInMemoryDirectoryHandle,
  syncFilesToGodotDirectory,
} from '../../src/sync/fsaaSyncEngine';
import { computeSyncDiff } from '../../src/sync/syncDiff';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): NibgridDatabase {
  const db = new NibgridDatabase(`nibgrid-m51-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return db;
}

function makeSolidPng(width: number, height: number, r: number, g: number, b: number): Uint8Array {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return encodeRgbaToPngBytes(rgba, width, height);
}

function createDeletableMockDirectoryHandle() {
  const files = new Map<string, Uint8Array>();
  const removed: string[] = [];

  const makeDir = (prefix: string): FileSystemDirectoryHandleLike => ({
    name: prefix === '' ? 'mock_godot_res' : prefix.split('/').pop()!,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async (segment: string) =>
      makeDir(prefix === '' ? segment : `${prefix}/${segment}`),
    getFileHandle: async (filename: string): Promise<FileSystemFileHandleLike> => {
      const fullPath = prefix === '' ? filename : `${prefix}/${filename}`;
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
      };
    },
    removeEntry: async (name: string) => {
      const fullPath = prefix === '' ? name : `${prefix}/${name}`;
      files.delete(fullPath);
      removed.push(fullPath);
    },
  });

  return { files, removed, rootHandle: makeDir('') };
}

afterEach(async () => {
  clearInMemorySyncHandles();
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

describe('M51: Unified Canonical Godot 4 Compiler, Integrity Validator & Deletion-Aware Sync', () => {
  it('detects broken res:// ExtResource references and passes when all paths exist', () => {
    const brokenFiles: VirtualSyncFile[] = [
      {
        relativePath: 'levels/crypt.tscn',
        content: [
          '[gd_scene load_steps=2 format=3]',
          '[ext_resource type="TileSet" path="res://tiles/missing_tileset.tres" id="1_ts"]',
          '[node name="Crypt" type="Node2D"]',
        ].join('\n'),
      },
    ];
    const brokenReport = validateGodotSceneGraph(brokenFiles);
    expect(brokenReport.ok).toBe(false);
    expect(brokenReport.brokenReferences).toEqual([
      {
        filePath: 'levels/crypt.tscn',
        missingResPath: 'res://tiles/missing_tileset.tres',
      },
    ]);

    const cleanFiles: VirtualSyncFile[] = [
      ...brokenFiles,
      {
        relativePath: 'tiles/missing_tileset.tres',
        content: '[gd_resource type="TileSet" format=3]\n[resource]\n',
      },
    ];
    const cleanReport = validateGodotSceneGraph(cleanFiles);
    expect(cleanReport.ok).toBe(true);
    expect(cleanReport.checkedReferences).toBe(1);
    expect(cleanReport.brokenReferences).toEqual([]);
  });

  it('tracks removedPaths in computeSyncDiff and prunes orphaned files from disk on sync', async () => {
    const db = createTestDb();
    const mockFs = createDeletableMockDirectoryHandle();
    setInMemoryDirectoryHandle('proj-prune', mockFs.rootHandle);

    const f1: VirtualSyncFile = {
      relativePath: 'entities/a/a.tscn',
      content: '[gd_scene format=3]\n',
    };
    const f2: VirtualSyncFile = {
      relativePath: 'entities/b/b.tscn',
      content: '[gd_scene format=3]\n',
    };

    const sync1 = await syncFilesToGodotDirectory(db, 'proj-prune', [f1, f2]);
    expect(sync1.writtenCount).toBe(2);
    expect(mockFs.files.has('entities/b/b.tscn')).toBe(true);

    const diffCheck = await computeSyncDiff([f1], sync1.record.lastSyncedHashes);
    expect(diffCheck.plan.removedPaths).toEqual(['entities/b/b.tscn']);
    expect(diffCheck.nextHashes['entities/b/b.tscn']).toBeUndefined();

    const sync2 = await syncFilesToGodotDirectory(db, 'proj-prune', [f1]);
    expect(sync2.removedCount).toBe(1);
    expect(mockFs.removed).toEqual(['entities/b/b.tscn']);
    expect(mockFs.files.has('entities/b/b.tscn')).toBe(false);
    expect(sync2.record.lastSyncedHashes['entities/b/b.tscn']).toBeUndefined();
  });

  it('emits referenced tilesets + parallax stacks, wires real entity assets into GameKit prefabs, and validates 0 broken refs', async () => {
    const db = createTestDb();
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M51 Canonical Game', {
      ...createDefaultArtBible(),
      targetWidth: 32,
      targetHeight: 32,
    });

    const heroPng = makeSolidPng(32, 32, 220, 80, 60);
    const heroBlob = await repo.storeBlobDeduplicated(heroPng, 'image/png');
    const heroNode = SpriteNodeSchema.parse({
      id: 'node-hero',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      imageBlobId: heroBlob.id,
      sketchSha256: 'a'.repeat(64),
      shaderConfig: createDefaultShaderConfig('hit_flash'),
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-1',
        seed: 1,
        adherence: 'balanced',
        promptDelta: 'knight hero',
        compiledPrompt: 'knight hero',
        createdAt: '2026-11-28T12:00:00.000Z',
      },
      createdAt: 100,
    });

    const tilePng = makeSolidPng(32, 32, 90, 120, 70);
    const tileBlob = await repo.storeBlobDeduplicated(tilePng, 'image/png');
    const tileNode = SpriteNodeSchema.parse({
      id: 'node-tile',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'tile',
      imageBlobId: tileBlob.id,
      sketchSha256: 'b'.repeat(64),
      autoTile: createDefaultAutoTileConfig(),
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-1',
        seed: 2,
        adherence: 'balanced',
        promptDelta: 'crypt_stone',
        compiledPrompt: 'crypt stone',
        createdAt: '2026-11-28T12:00:00.000Z',
      },
      createdAt: 101,
    });

    const bgPng = makeSolidPng(64, 32, 30, 40, 80);
    const bgBlob = await repo.storeBlobDeduplicated(bgPng, 'image/png');
    const parallaxConfig = createDefaultParallaxSceneConfig();
    const parallaxNode = SpriteNodeSchema.parse({
      id: 'node-parallax',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'tile',
      imageBlobId: bgBlob.id,
      sketchSha256: 'c'.repeat(64),
      parallaxScene: {
        ...parallaxConfig,
        layers: [
          {
            id: 'layer-bg-1',
            name: 'Moonlit Horizon',
            sourceKind: 'blob',
            blobId: bgBlob.id,
            role: 'sky-far',
            scrollRatioX: 0.25,
            yOffsetPx: 0,
            seamBlendPx: 16,
            depthHaze: 0.35,
            stripChromaKey: true,
          },
        ],
      },
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-1',
        seed: 3,
        adherence: 'balanced',
        promptDelta: 'moonlit_sky',
        compiledPrompt: 'moonlit sky',
        createdAt: '2026-11-28T12:00:00.000Z',
      },
      createdAt: 102,
    });

    await repo.saveSpriteNode(heroNode);
    await repo.saveSpriteNode(tileNode);
    await repo.saveSpriteNode(parallaxNode);

    const heroEntity = EntityDefinitionSchema.parse({
      id: 'ent-hero',
      projectId: project.id,
      slug: 'knight_hero',
      displayName: 'Knight Hero',
      bodyType: 'CharacterBody2D',
      resSubpath: 'entities',
      primarySpriteNodeId: heroNode.id,
      clips: [{ name: 'idle', spriteNodeId: heroNode.id, fps: 8, loop: true }],
      audioAssetIds: [],
      includeNormalMap: true,
      updatedAt: 200,
    });
    await repo.saveEntity(heroEntity);

    const roomBlueprint = generateMockRoomBlueprint({
      prompt: 'Crypt arena',
      cols: 20,
      rows: 12,
      tileSizePx: 32,
      availableEntitySlugs: ['knight_hero'],
    });
    const room = await repo.saveRoom({
      id: 'room-1',
      projectId: project.id,
      slug: roomBlueprint.slug,
      tileSetNodeId: tileNode.id,
      tileSetMode: 'blob47',
      parallaxNodeId: parallaxNode.id,
      blueprint: roomBlueprint,
      updatedAt: 300,
    });

    const { files, validation } = await collectAndValidateProjectGodotSyncFiles(
      db,
      project,
      [heroEntity],
      [heroNode, tileNode, parallaxNode],
      [],
      [room],
      { gameKitTemplate: 'side-platformer' },
    );

    const paths = files.map((f) => f.relativePath);
    expect(paths.some((p) => p.startsWith('tiles/') && p.endsWith('_tileset.tres'))).toBe(true);
    expect(paths.some((p) => p.startsWith('parallax/') && p.endsWith('_parallax.tscn'))).toBe(true);
    expect(paths).toContain('entities/knight_hero/knight_hero_prefab.tscn');

    const resolvedAssets = resolveEntityGameKitAssets('knight_hero', 'entities', files);
    expect(resolvedAssets.canvasTextureResPath).toBe(
      'res://entities/knight_hero/knight_hero_canvas.tres',
    );
    expect(resolvedAssets.shaderMatResPath).toBe('res://entities/knight_hero/knight_hero_mat.tres');

    const prefabFile = files.find(
      (f) => f.relativePath === 'entities/knight_hero/knight_hero_prefab.tscn',
    );
    expect(typeof prefabFile?.content === 'string' ? prefabFile.content : '').toContain(
      'knight_hero_canvas.tres',
    );
    expect(typeof prefabFile?.content === 'string' ? prefabFile.content : '').toContain(
      'knight_hero_mat.tres',
    );

    expect(validation.brokenReferences).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
