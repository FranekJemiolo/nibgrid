import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  buildSocketExportFiles,
  buildUnifiedSocketsJson,
  exportGodotSocketsTscnSnippet,
  exportPhaserSocketsJson,
  exportPixiSocketsJson,
} from '../../src/export/socketExporters';
import { packageSpriteZip } from '../../src/export/zipPackager';
import type {
  EvaluatedSocketFrame,
  SocketDefinition,
} from '../../src/processing/attachmentSockets';

const SAMPLE_SOCKETS: SocketDefinition[] = [
  {
    id: 'sock-muzzle',
    name: 'muzzle',
    restPosPx: { x: 52, y: 24 },
    baseAngleDeg: 0,
    colorHex: '#EF4444',
  },
  {
    id: 'sock-hand',
    name: 'hand_r',
    restPosPx: { x: 40, y: 40 },
    baseAngleDeg: 30,
    colorHex: '#F59E0B',
  },
];

const SAMPLE_EVALUATED_FRAMES: EvaluatedSocketFrame[][] = [
  [
    {
      socketId: 'sock-muzzle',
      name: 'muzzle',
      frameIndex: 0,
      posPx: { x: 52, y: 24 },
      pivotRelativePx: { x: 20, y: -40 },
      angleDeg: 0,
      boundToMesh: true,
    },
    {
      socketId: 'sock-hand',
      name: 'hand_r',
      frameIndex: 0,
      posPx: { x: 40, y: 40 },
      pivotRelativePx: { x: 8, y: -24 },
      angleDeg: 30,
      boundToMesh: true,
    },
  ],
  [
    {
      socketId: 'sock-muzzle',
      name: 'muzzle',
      frameIndex: 1,
      posPx: { x: 54.5, y: 21.25 },
      pivotRelativePx: { x: 22.5, y: -42.75 },
      angleDeg: 15,
      boundToMesh: true,
    },
    {
      socketId: 'sock-hand',
      name: 'hand_r',
      frameIndex: 1,
      posPx: { x: 41.2, y: 38.4 },
      pivotRelativePx: { x: 9.2, y: -25.6 },
      angleDeg: 45,
      boundToMesh: true,
    },
  ],
];

function createRecipeWithSockets(sockets: SocketDefinition[]) {
  const project: Project = {
    id: 'proj-m21b',
    name: 'Mecha Turret',
    artBible: createDefaultArtBible(),
    createdAt: '2026-11-24T00:00:00.000Z',
    updatedAt: '2026-11-24T00:00:00.000Z',
  };
  const node: SpriteNode = {
    id: 'node-m21b',
    projectId: project.id,
    parentId: null,
    kind: 'generation',
    sockets,
    imageBlobId: 'blob-m21b',
    sketchSha256: 'b'.repeat(64),
    generationMeta: {
      providerId: 'offline-mock',
      modelId: 'nibgrid-procedural-v1',
      seed: 7,
      adherence: 'balanced',
      promptDelta: 'mecha turret',
      compiledPrompt: 'mecha turret',
      createdAt: '2026-11-24T00:00:00.000Z',
    },
  };
  return buildAssetRecipe({
    project,
    node,
    postProcess: createDefaultPostProcessConfig(64, 64),
    filename: 'mecha-turret.png',
    outputWidth: 64,
    outputHeight: 64,
    sockets,
  });
}

describe('M21B: Godot 4, Phaser 3 & PixiJS Socket Exporters + ZIP Integration', () => {
  it('emits Godot 4 Marker2D snippet with Vector2, radians rotation, and AnimationPlayer keyframes', () => {
    const tscn = exportGodotSocketsTscnSnippet(
      'mecha-turret',
      SAMPLE_SOCKETS,
      SAMPLE_EVALUATED_FRAMES,
    );

    expect(tscn).toContain('[node name="muzzle" type="Marker2D" parent="."]');
    expect(tscn).toContain('position = Vector2(20, -40)');
    expect(tscn).toContain('rotation = 0');
    expect(tscn).toContain('[node name="hand_r" type="Marker2D" parent="."]');
    expect(tscn).toContain('position = Vector2(8, -24)');
    expect(tscn).toContain('rotation = 0.5236');
    expect(tscn).toContain('# AnimationPlayer Keyframes (2 frames):');
    expect(tscn).toContain('# frame 1: muzzle -> Vector2(22.5, -42.75), rotation=0.2618 (15 deg)');

    // Rest-pose fallback when no evaluated frames are provided
    const restFallback = exportGodotSocketsTscnSnippet(
      'mecha-turret',
      SAMPLE_SOCKETS.slice(0, 1),
      [],
    );
    expect(restFallback).toContain('position = Vector2(52, 24)');
    expect(restFallback).not.toContain('AnimationPlayer Keyframes');

    // Empty socket list emits clean comment header
    const emptyTscn = exportGodotSocketsTscnSnippet('mecha-turret', [], []);
    expect(emptyTscn).toContain('No attachment sockets defined');
  });

  it('emits Phaser 3 and PixiJS JSON payloads with accurate per-frame coordinates and angles', () => {
    const phaser = JSON.parse(
      exportPhaserSocketsJson('mecha-turret', 12, SAMPLE_SOCKETS, SAMPLE_EVALUATED_FRAMES),
    );
    expect(phaser.app).toBe('nibgrid');
    expect(phaser.engine).toBe('phaser3');
    expect(phaser.sprite).toBe('mecha-turret');
    expect(phaser.fps).toBe(12);
    expect(phaser.frameCount).toBe(2);
    expect(phaser.sockets.muzzle.frames).toEqual([
      { x: 20, y: -40, angleDeg: 0 },
      { x: 22.5, y: -42.75, angleDeg: 15 },
    ]);

    const pixi = JSON.parse(
      exportPixiSocketsJson('mecha-turret', 16, SAMPLE_SOCKETS, SAMPLE_EVALUATED_FRAMES),
    );
    expect(pixi.engine).toBe('pixijs');
    expect(pixi.fps).toBe(16);
    expect(pixi.sockets.hand_r.frames[0]).toEqual({
      x: 8,
      y: -24,
      rotationRad: 0.5236,
      angleDeg: 30,
      scaleX: 1,
      scaleY: 1,
    });
    expect(pixi.sockets.hand_r.frames[1].scaleX).toBe(1);
    expect(pixi.sockets.hand_r.frames[1].scaleY).toBe(1);
  });

  it('packages <slug>_sockets.json inside sprite ZIPs and round-trips recipe.json via AssetRecipeSchema', () => {
    const recipe = createRecipeWithSockets(SAMPLE_SOCKETS);
    const dummyPng = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

    // Case 1: Evaluated multi-frame tracks supplied explicitly
    const zipWithFrames = packageSpriteZip({
      slug: 'mecha-turret',
      pngBytes: dummyPng,
      recipe,
      evaluatedSocketsByFrame: SAMPLE_EVALUATED_FRAMES,
      socketFps: 15,
    });
    const unzippedWithFrames = unzipSync(zipWithFrames);
    const socketsEntry = unzippedWithFrames['mecha-turret_sockets.json'];
    const recipeEntry = unzippedWithFrames['mecha-turret.recipe.json'];
    expect(socketsEntry).toBeDefined();
    expect(recipeEntry).toBeDefined();

    const socketsJson = JSON.parse(strFromU8(socketsEntry!));
    expect(socketsJson.app).toBe('nibgrid');
    expect(socketsJson.fps).toBe(15);
    expect(socketsJson.frameCount).toBe(2);
    expect(socketsJson.sockets.muzzle.frames[1].x).toBe(22.5);
    expect(socketsJson.sockets.muzzle.frames[1].y).toBe(-42.75);

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(recipeEntry!)));
    expect(parsedRecipe.sockets).toHaveLength(2);
    expect(parsedRecipe.sockets?.[0]?.name).toBe('muzzle');

    // Case 2: Static sprite export without evaluatedSocketsByFrame falls back to output.pivotPx (32, 64)
    const staticZip = packageSpriteZip({
      slug: 'mecha-turret',
      pngBytes: dummyPng,
      recipe,
    });
    const unzippedStatic = unzipSync(staticZip);
    const staticEntry = unzippedStatic['mecha-turret_sockets.json'];
    expect(staticEntry).toBeDefined();
    const staticSockets = JSON.parse(strFromU8(staticEntry!));
    expect(recipe.output.pivotPx).toEqual({ x: 32, y: 32 });
    expect(staticSockets.frameCount).toBe(1);
    expect(staticSockets.sockets.muzzle.frames[0]).toMatchObject({
      x: 20, // 52 - 32
      y: -8, // 24 - 32
      angleDeg: 0,
      boundToMesh: false,
    });

    // Case 3: No sockets -> does not include *_sockets.json
    const recipeNoSockets = createRecipeWithSockets([]);
    const zipEmpty = packageSpriteZip({
      slug: 'mecha-turret',
      pngBytes: dummyPng,
      recipe: recipeNoSockets,
    });
    expect(Object.keys(unzipSync(zipEmpty))).not.toContain('mecha-turret_sockets.json');

    // Direct helper check
    const unified = JSON.parse(
      buildUnifiedSocketsJson('mecha-turret', 12, SAMPLE_SOCKETS, SAMPLE_EVALUATED_FRAMES),
    );
    expect(unified.sockets.hand_r.restPosPx).toEqual({ x: 40, y: 40 });
    expect(Object.keys(buildSocketExportFiles('mecha-turret', 12, [], []))).toEqual([]);
  });
});
