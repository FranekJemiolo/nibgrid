import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import { EntityDefinitionSchema } from '../../src/domain/entitySchema';
import { createDefaultPoseClip } from '../../src/domain/schemas';
import {
  exportCanvasTextureTres,
  exportEmissionOverlayShader,
  exportLightOccluderSubResource,
  exportNormalMapImportFile,
} from '../../src/export/godotLightingExporter';
import { assembleGodotEntityFiles } from '../../src/export/godotPrefabAssembler';
import {
  createDefaultEmissionBakeConfig,
  createDefaultNormalBakeConfig,
} from '../../src/processing/normalEmissionBaker';
import { rgbaToPngBlob } from '../../src/processing/png';
import { collectEntitySyncFiles } from '../../src/sync/fsaaSyncEngine';

describe('M44B: Godot 4 CanvasTexture, Normal .import, LightOccluder2D & Atomic Lighting Persistence', () => {
  it('serializes CanvasTexture .tres with exact load_steps and texture_filter parity', () => {
    const pixelTres = exportCanvasTextureTres({
      diffuseResPath: 'res://entities/knight/knight.png',
      normalResPath: 'res://entities/knight/knight_n.png',
      artMode: 'pixel-art',
    });

    const extCount = (pixelTres.match(/^\[ext_resource\b/gm) ?? []).length;
    expect(extCount).toBe(2);
    expect(pixelTres).toContain(
      `[gd_resource type="CanvasTexture" load_steps=${extCount + 1} format=3]`,
    );
    expect(pixelTres).toContain('diffuse_texture = ExtResource("1_diff")');
    expect(pixelTres).toContain('normal_texture = ExtResource("2_norm")');
    expect(pixelTres).toContain('texture_filter = 1');

    const hdWithSpec = exportCanvasTextureTres({
      diffuseResPath: 'res://entities/knight/knight.png',
      normalResPath: 'res://entities/knight/knight_n.png',
      specularResPath: 'res://entities/knight/knight_s.png',
      artMode: 'hd-handdrawn',
    });
    const hdExtCount = (hdWithSpec.match(/^\[ext_resource\b/gm) ?? []).length;
    expect(hdExtCount).toBe(3);
    expect(hdWithSpec).toContain(
      `[gd_resource type="CanvasTexture" load_steps=${hdExtCount + 1} format=3]`,
    );
    expect(hdWithSpec).toContain('specular_texture = ExtResource("3_spec")');
    expect(hdWithSpec).toContain('texture_filter = 2');
  });

  it('emits normal .png.import with compress/normal_map=1 and mipmaps disabled in pixel-art mode', () => {
    const importText = exportNormalMapImportFile({
      resPath: 'res://entities/knight/knight_n.png',
      artMode: 'pixel-art',
    });

    expect(importText).toContain('source_file="res://entities/knight/knight_n.png"');
    expect(importText).toContain('compress/mode=0');
    expect(importText).toContain('compress/normal_map=1');
    expect(importText).toContain('mipmaps/generate=false');
    expect(exportEmissionOverlayShader()).toContain('uniform sampler2D emission_texture');
  });

  it('generates valid LightOccluder2D OccluderPolygon2D sub_resource via M16 RDP hull with >= 3 finite vertices', () => {
    const size = 16;
    const rgba = new Uint8ClampedArray(size * size * 4);
    for (let y = 3; y <= 12; y++) {
      for (let x = 4; x <= 11; x++) {
        const idx = (y * size + x) * 4;
        rgba[idx] = 200;
        rgba[idx + 1] = 180;
        rgba[idx + 2] = 160;
        rgba[idx + 3] = 255;
      }
    }

    const occluder = exportLightOccluderSubResource({
      id: 'knight_occluder',
      rgba,
      width: size,
      height: size,
      epsilon: 1.5,
    });

    expect(occluder).toContain('[sub_resource type="OccluderPolygon2D" id="knight_occluder"]');
    expect(occluder).toContain('cull_mode = 0');
    const polyMatch = /polygon = PackedVector2Array\(([^)]+)\)/.exec(occluder);
    expect(polyMatch?.[1]).toBeTruthy();
    const nums = polyMatch![1]!.split(',').map((s) => Number(s.trim()));
    expect(nums.length).toBeGreaterThanOrEqual(6);
    expect(nums.length % 2).toBe(0);
    for (const val of nums) {
      expect(Number.isFinite(val)).toBe(true);
    }
  });

  it('persists baked lighting maps atomically in Dexie (0 orphan blobs) and includes them in M25 res:// sync', async () => {
    const testDb = new NibgridDatabase(`m44b-test-${Date.now()}-${Math.random()}`);
    const repo = new NibgridRepository(testDb);
    try {
      const project = await repo.createProject('M44B Lighting Test');
      const rgba = new Uint8ClampedArray(4 * 4 * 4);
      rgba.fill(255);
      const diffuseBlob = await rgbaToPngBlob(rgba, 4, 4);
      const normBlob1 = await rgbaToPngBlob(new Uint8ClampedArray(4 * 4 * 4).fill(128), 4, 4);
      const normBlob2 = await rgbaToPngBlob(new Uint8ClampedArray(4 * 4 * 4).fill(200), 4, 4);
      const emissBlob = await rgbaToPngBlob(new Uint8ClampedArray(4 * 4 * 4).fill(90), 4, 4);

      const storedDiff = await repo.storeBlobDeduplicated(diffuseBlob, 'image/png');
      const node = await repo.saveSpriteNode({
        id: 'node-m44b',
        projectId: project.id,
        parentId: null,
        kind: 'generation',
        imageBlobId: storedDiff.id,
        sketchSha256: 'a'.repeat(64),
        generationMeta: {
          providerId: 'offline-mock',
          modelId: 'nibgrid-procedural-v1',
          seed: 7,
          adherence: 'balanced',
          promptDelta: 'knight',
          compiledPrompt: 'knight',
          createdAt: new Date().toISOString(),
        },
      });

      await repo.commitSpriteLightingBake(node.id, {
        normalPngBlob: normBlob1,
        emissionPngBlob: emissBlob,
        normalConfig: createDefaultNormalBakeConfig(),
        emissionConfig: createDefaultEmissionBakeConfig(),
        emissivePixelCount: 2,
        occluderVertexCount: 4,
      });
      // Replace normal blob again to prove old normBlob1 is garbage-collected atomically
      const updatedNode = await repo.commitSpriteLightingBake(node.id, {
        normalPngBlob: normBlob2,
        emissionPngBlob: emissBlob,
        normalConfig: createDefaultNormalBakeConfig(),
        emissionConfig: createDefaultEmissionBakeConfig(),
        emissivePixelCount: 2,
        occluderVertexCount: 4,
      });

      expect(await findOrphanBlobIds(testDb)).toEqual([]);
      expect(updatedNode.lightingBake?.normalBlobId).toBeTruthy();
      expect(updatedNode.lightingBake?.emissionBlobId).toBeTruthy();

      const entity = EntityDefinitionSchema.parse({
        id: 'ent-knight',
        projectId: project.id,
        slug: 'knight',
        displayName: 'Knight',
        bodyType: 'CharacterBody2D',
        resSubpath: 'entities',
        primarySpriteNodeId: updatedNode.id,
        clips: [{ name: 'idle', spriteNodeId: updatedNode.id, fps: 8, loop: true }],
        audioAssetIds: [],
        includeNormalMap: false,
        updatedAt: Date.now(),
      });

      const syncedFiles = await collectEntitySyncFiles(testDb, project, entity, [updatedNode], []);
      const byPath = new Map(syncedFiles.map((f) => [f.relativePath, f]));

      expect(byPath.has('entities/knight/knight_n.png')).toBe(true);
      expect(byPath.has('entities/knight/knight_n.png.import')).toBe(true);
      expect(byPath.has('entities/knight/knight_e.png')).toBe(true);
      expect(byPath.has('entities/knight/knight_canvas.tres')).toBe(true);

      const importContent = String(byPath.get('entities/knight/knight_n.png.import')!.content);
      expect(importContent).toContain('compress/normal_map=1');

      const directAssembled = assembleGodotEntityFiles({
        entity,
        isPixelArt: true,
        spriteFiles: [
          {
            spriteNodeId: updatedNode.id,
            filename: 'knight.png',
            bytes: new Uint8Array([137, 80, 78, 71]),
            normalBytes: new Uint8Array([137, 80, 78, 72]),
            emissionBytes: new Uint8Array([137, 80, 78, 73]),
          },
        ],
        audioFiles: [],
        colliderPolygons: [],
        sockets: [],
      });
      expect(directAssembled.some((f) => f.relativePath === 'entities/knight/knight_e.png')).toBe(
        true,
      );
    } finally {
      testDb.close();
      await testDb.delete();
    }
  });

  it('atomically commits Pose Keyframer frame and strip blobs without leaving orphans', async () => {
    const testDb = new NibgridDatabase(`m44b-pose-atomic-${Date.now()}-${Math.random()}`);
    const repo = new NibgridRepository(testDb);
    try {
      const project = await repo.createProject('Pose Atomic Test');
      const baseBlob = await rgbaToPngBlob(new Uint8ClampedArray(4 * 4 * 4).fill(255), 4, 4);
      const storedBase = await repo.storeBlobDeduplicated(baseBlob, 'image/png');
      const node = await repo.saveSpriteNode({
        id: 'node-pose-atomic',
        projectId: project.id,
        parentId: null,
        kind: 'generation',
        imageBlobId: storedBase.id,
        sketchSha256: 'b'.repeat(64),
        generationMeta: {
          providerId: 'offline-mock',
          modelId: 'nibgrid-procedural-v1',
          seed: 9,
          adherence: 'balanced',
          promptDelta: 'hero',
          compiledPrompt: 'hero',
          createdAt: new Date().toISOString(),
        },
      });

      const clipBase = createDefaultPoseClip(4, 4);
      const frameBlobs = await Promise.all(
        [10, 20, 30, 40, 50, 60].map((v) =>
          rgbaToPngBlob(new Uint8ClampedArray(4 * 4 * 4).fill(v), 4, 4),
        ),
      );
      const stripBlob = await rgbaToPngBlob(new Uint8ClampedArray(24 * 4 * 4).fill(77), 24, 4);

      const committed = await repo.commitPoseClipFrames(node.id, clipBase, frameBlobs, stripBlob);

      expect(committed.poseClip.generatedFrameBlobIds).toHaveLength(6);
      expect(committed.poseClip.generatedStripBlobId).toBeTruthy();
      expect(await repo.cleanupOrphanedBlobs()).toBe(0);
      expect(await findOrphanBlobIds(testDb)).toEqual([]);

      for (const blobId of committed.poseClip.generatedFrameBlobIds ?? []) {
        const rec = await repo.getBlob(blobId);
        expect(rec).toBeDefined();
      }
      const stripRec = await repo.getBlob(committed.poseClip.generatedStripBlobId!);
      expect(stripRec).toBeDefined();
    } finally {
      testDb.close();
      await testDb.delete();
    }
  });
});
