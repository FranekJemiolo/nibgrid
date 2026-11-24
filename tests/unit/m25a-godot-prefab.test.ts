import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  OFFLINE_MOCK_PROVIDER_ID,
  findOrphanBlobIds,
} from '../../src/db/database';
import {
  EntityDefinitionSchema,
  normalizeResSubpath,
  sanitizeEntitySlug,
  type EntityDefinition,
} from '../../src/domain/entitySchema';
import {
  assembleGodotEntityFiles,
  generateCanvasTextureTres,
  generateGodotPngImport,
  type EntityAssemblyInput,
} from '../../src/export/godotPrefabAssembler';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m25a-${globalThis.crypto.randomUUID()}`);
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

function readText(content: Uint8Array | string): string {
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

function makeEntityInput(isPixelArt: boolean): EntityAssemblyInput {
  const entity: EntityDefinition = EntityDefinitionSchema.parse({
    id: 'ent-goblin-1',
    projectId: 'proj-1',
    slug: 'goblin_scout',
    displayName: 'Goblin Scout',
    bodyType: 'CharacterBody2D',
    resSubpath: 'assets/nibgrid',
    primarySpriteNodeId: 'sprite-idle',
    clips: [
      {
        name: 'idle',
        spriteNodeId: 'sprite-idle',
        fps: 8,
        loop: true,
      },
      {
        name: 'slash',
        spriteNodeId: 'sprite-slash',
        fps: 12,
        loop: false,
        frameAudioTriggers: { '1': 'audio-slash' },
      },
    ],
    audioAssetIds: ['audio-slash'],
    includeNormalMap: true,
    updatedAt: 1700000000000,
  });

  return {
    entity,
    isPixelArt,
    spriteFiles: [
      {
        spriteNodeId: 'sprite-idle',
        filename: 'goblin_idle.png',
        bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3, 4]),
        normalBytes: new Uint8Array([137, 80, 78, 71, 9, 8, 7, 6]),
      },
      {
        spriteNodeId: 'sprite-slash',
        filename: 'goblin_slash.png',
        bytes: new Uint8Array([137, 80, 78, 71, 5, 6, 7, 8]),
      },
    ],
    audioFiles: [
      {
        audioAssetId: 'audio-slash',
        filename: 'slash.wav',
        bytes: new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]),
      },
    ],
    colliderPolygons: [
      {
        layer: 'collider',
        points: [
          { x: -10, y: -16 },
          { x: 10, y: -16 },
          { x: 10, y: 16 },
          { x: -10, y: 16 },
        ],
      },
      {
        layer: 'hitbox',
        points: [
          { x: 8, y: -12 },
          { x: 24, y: -12 },
          { x: 24, y: 4 },
          { x: 8, y: 4 },
        ],
        activeFrames: [1, 2],
      },
    ],
    sockets: [
      { name: 'hand_r', x: 9.5, y: -3.25, angleDeg: 45 },
      { name: 'muzzle', x: 18, y: -6, angleDeg: 0 },
    ],
  };
}

describe('M25A: Entity Domain Schema & Pure-TS Godot 4 Prefab Assembler', () => {
  it('assembles goblin_scout with valid .tscn load_steps, ExtResources, M16 collider/hitbox, M21 sockets, CanvasTexture & lossless .import sidecars', () => {
    const files = assembleGodotEntityFiles(makeEntityInput(true));
    const byPath = new Map(files.map((f) => [f.relativePath, f]));

    const expectedPaths = [
      'assets/nibgrid/goblin_scout/goblin_idle.png',
      'assets/nibgrid/goblin_scout/goblin_idle.png.import',
      'assets/nibgrid/goblin_scout/goblin_idle_n.png',
      'assets/nibgrid/goblin_scout/goblin_idle_n.png.import',
      'assets/nibgrid/goblin_scout/goblin_idle_canvas.tres',
      'assets/nibgrid/goblin_scout/goblin_slash.png',
      'assets/nibgrid/goblin_scout/goblin_slash.png.import',
      'assets/nibgrid/goblin_scout/slash.wav',
      'assets/nibgrid/goblin_scout/goblin_scout_frames.tres',
      'assets/nibgrid/goblin_scout/goblin_scout_anims.tres',
      'assets/nibgrid/goblin_scout/goblin_scout.tscn',
    ];
    for (const path of expectedPaths) {
      expect(byPath.has(path)).toBe(true);
    }

    // Verify lossless pixel-art .png.import sidecar
    const importText = readText(
      byPath.get('assets/nibgrid/goblin_scout/goblin_idle.png.import')!.content,
    );
    expect(importText).toContain('source_file="res://assets/nibgrid/goblin_scout/goblin_idle.png"');
    expect(importText).toContain('compress/mode=0');
    expect(importText).toContain('mipmaps/generate=false');
    expect(importText).toContain('process/fix_alpha_border=true');

    // Verify CanvasTexture pairs diffuse + _n.png with Nearest filter
    const canvasTres = readText(
      byPath.get('assets/nibgrid/goblin_scout/goblin_idle_canvas.tres')!.content,
    );
    expect(canvasTres).toContain('[gd_resource type="CanvasTexture" load_steps=3 format=3]');
    expect(canvasTres).toContain('diffuse_texture = ExtResource("1_diff")');
    expect(canvasTres).toContain('normal_texture = ExtResource("2_norm")');
    expect(canvasTres).toContain('texture_filter = 1');

    // Verify SpriteFrames references CanvasTexture and clips
    const framesTres = readText(
      byPath.get('assets/nibgrid/goblin_scout/goblin_scout_frames.tres')!.content,
    );
    expect(framesTres).toContain('[gd_resource type="SpriteFrames" load_steps=3 format=3]');
    expect(framesTres).toContain('res://assets/nibgrid/goblin_scout/goblin_idle_canvas.tres');
    expect(framesTres).toContain('"name": &"idle"');
    expect(framesTres).toContain('"name": &"slash"');

    // Verify AnimationLibrary syncs Hitbox, Sockets & SFX
    const animsTres = readText(
      byPath.get('assets/nibgrid/goblin_scout/goblin_scout_anims.tres')!.content,
    );
    expect(animsTres).toContain('[gd_resource type="AnimationLibrary" load_steps=3 format=3]');
    expect(animsTres).toContain('NodePath("Hitbox/CollisionPolygon2D:disabled")');
    expect(animsTres).toContain('NodePath("Sockets/hand_r:position")');
    expect(animsTres).toContain('NodePath("Sockets/muzzle:position")');
    expect(animsTres).toContain('NodePath("Audio/SfxPlayer")');
    expect(animsTres).toContain('"method": &"play"');

    // Verify .tscn load_steps, ExtResources, and scene tree nodes
    const tscn = readText(byPath.get('assets/nibgrid/goblin_scout/goblin_scout.tscn')!.content);
    const loadStepsMatch = /\[gd_scene load_steps=(\d+) format=3\]/.exec(tscn);
    expect(loadStepsMatch).not.toBeNull();
    const extMatches = [...tscn.matchAll(/\[ext_resource [^\]]*id="([^"]+)"\]/g)];
    const subMatches = [...tscn.matchAll(/\[sub_resource [^\]]*id="([^"]+)"\]/g)];
    expect(Number(loadStepsMatch![1])).toBe(extMatches.length + subMatches.length + 1);

    const declaredIds = new Set(extMatches.map((m) => m[1]));
    for (const refMatch of tscn.matchAll(/ExtResource\("([^"]+)"\)/g)) {
      expect(declaredIds.has(refMatch[1]!)).toBe(true);
    }

    expect(tscn).toContain('[node name="GoblinScout" type="CharacterBody2D"]');
    expect(tscn).toContain('[node name="AnimatedSprite2D" type="AnimatedSprite2D" parent="."]');
    expect(tscn).toContain('[node name="CollisionPolygon2D" type="CollisionPolygon2D" parent="."]');
    expect(tscn).toContain('[node name="Hitbox" type="Area2D" parent="."]');
    expect(tscn).toContain('[node name="hand_r" type="Marker2D" parent="Sockets"]');
    expect(tscn).toContain('position = Vector2(9.5, -3.25)');
    expect(tscn).toContain('[node name="muzzle" type="Marker2D" parent="Sockets"]');
    expect(tscn).toContain('position = Vector2(18, -6)');
    expect(tscn).toContain('[node name="SfxPlayer" type="AudioStreamPlayer2D" parent="Audio"]');
    expect(tscn).toContain('[node name="AnimationPlayer" type="AnimationPlayer" parent="."]');
  });

  it('produces deterministic sorted VirtualSyncFile output and adapts texture flags when isPixelArt is false', () => {
    const a = assembleGodotEntityFiles(makeEntityInput(true));
    const b = assembleGodotEntityFiles(makeEntityInput(true));
    expect(a.map((f) => f.relativePath)).toEqual(b.map((f) => f.relativePath));
    for (let i = 0; i < a.length; i++) {
      expect(readText(a[i]!.content)).toBe(readText(b[i]!.content));
    }

    const hdImport = generateGodotPngImport('res://assets/hero.png', false);
    expect(hdImport).toContain('compress/mode=2');
    expect(hdImport).toContain('mipmaps/generate=true');

    const hdCanvas = generateCanvasTextureTres('res://a.png', 'res://a_n.png', false);
    expect(hdCanvas).toContain('texture_filter = 2');

    expect(sanitizeEntitySlug('  Goblin Scout #01!! ')).toBe('goblin_scout_01');
    expect(normalizeResSubpath('res://assets/../sprites//enemies/')).toBe('assets/sprites/enemies');
  });

  it('persists entities and syncTargets cleanly in Dexie v3 without duplicating blobs or leaving orphans on cascade delete', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('Godot Foundry Test');
    const blob = await repo.storeBlob(
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }),
    );

    await repo.saveSpriteNode({
      id: 'node-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      imageBlobId: blob.id,
      sketchSha256: 'a'.repeat(64),
      generationMeta: {
        providerId: OFFLINE_MOCK_PROVIDER_ID,
        modelId: 'mock',
        seed: 101,
        adherence: 'balanced',
        promptDelta: '',
        compiledPrompt: 'goblin scout',
        createdAt: new Date().toISOString(),
      },
    });

    const entity = EntityDefinitionSchema.parse({
      id: 'entity-1',
      projectId: project.id,
      slug: 'goblin_scout',
      displayName: 'Goblin Scout',
      bodyType: 'CharacterBody2D',
      resSubpath: 'assets/nibgrid',
      primarySpriteNodeId: 'node-1',
      clips: [{ name: 'idle', spriteNodeId: 'node-1', fps: 8, loop: true }],
      audioAssetIds: [],
      updatedAt: Date.now(),
    });
    await repo.saveEntity(entity);

    const listed = await repo.listEntities(project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.slug).toBe('goblin_scout');
    expect(await findOrphanBlobIds(db)).toEqual([]);

    await repo.saveSyncTarget({
      projectId: project.id,
      folderName: 'my_rpg',
      lastSyncedHashes: { 'assets/nibgrid/goblin_scout/goblin_scout.tscn': 'abc' },
      lastSyncedAt: Date.now(),
      directoryHandle: null,
    });
    const target = await repo.getSyncTarget(project.id);
    expect(target?.folderName).toBe('my_rpg');

    await repo.deleteEntity(entity.id);
    expect(await repo.listEntities(project.id)).toEqual([]);
    // Linked SpriteNode still owns blob -> 0 orphans
    expect(await findOrphanBlobIds(db)).toEqual([]);

    await repo.deleteProjectCascade(project.id);
    expect(await repo.getSyncTarget(project.id)).toBeUndefined();
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });
});
