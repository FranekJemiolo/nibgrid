import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type CollisionLayerShape,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import {
  buildColliderExportFiles,
  exportCombinedAtlasPhysicsJson,
  exportGodotColliderTres,
  exportMatterPhysicsJson,
} from '../../src/export/colliderExporters';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import { packageSpriteZip } from '../../src/export/zipPackager';

const SAMPLE_SHAPES: readonly CollisionLayerShape[] = [
  {
    id: 'shape-col',
    name: 'collider',
    layer: 'collider',
    kind: 'convex-hull',
    isSensor: false,
    visible: true,
    vertices: [
      { x: -10, y: -20 },
      { x: 10, y: -20 },
      { x: 12, y: 0 },
      { x: -12, y: 0 },
    ],
    autoTraceMeta: { epsilonPx: 1.5, maxVertices: 8 },
  },
  {
    id: 'shape-hurt',
    name: 'hurtbox',
    layer: 'hurtbox',
    kind: 'aabb',
    isSensor: true,
    visible: true,
    vertices: [
      { x: -8, y: -22 },
      { x: 8, y: -22 },
      { x: 8, y: -2 },
      { x: -8, y: -2 },
    ],
  },
  {
    id: 'shape-hit',
    name: 'slash_hitbox',
    layer: 'hitbox',
    kind: 'aabb',
    isSensor: true,
    visible: true,
    vertices: [
      { x: 10, y: -24 },
      { x: 26, y: -24 },
      { x: 26, y: -6 },
      { x: 10, y: -6 },
    ],
    activeFrames: [2, 3],
  },
];

describe('M16B Godot 4 & Matter.js Physics Exporters + ZIP Bundling', () => {
  it('emits valid Godot 4 ConvexPolygonShape2D and CapsuleShape2D .tres resources', () => {
    const convexTres = exportGodotColliderTres(SAMPLE_SHAPES);
    expect(convexTres.startsWith('[gd_resource type="ConvexPolygonShape2D" format=3]')).toBe(true);
    expect(convexTres).toContain('points = PackedVector2Array(-10, -20, 10, -20, 12, 0, -12, 0)');
    expect(convexTres).toContain('layer=hitbox name="slash_hitbox" isSensor=true frames=[2,3]');

    const capsuleTres = exportGodotColliderTres({
      id: 'cap-1',
      name: 'capsule_body',
      layer: 'collider',
      kind: 'capsule',
      isSensor: false,
      visible: true,
      vertices: [
        { x: -8, y: -40 },
        { x: 8, y: -40 },
        { x: 8, y: 0 },
        { x: -8, y: 0 },
      ],
      capsule: { cx: 0, cy: -20, radius: 8, height: 40, orientation: 'vertical' },
    });
    expect(capsuleTres.startsWith('[gd_resource type="CapsuleShape2D" format=3]')).toBe(true);
    expect(capsuleTres).toContain('radius = 8');
    expect(capsuleTres).toContain('height = 40');
  });

  it('emits PhysicsEditor-compatible Matter.js / Phaser 3 fixtures with exact isSensor flags', () => {
    const manifest = exportMatterPhysicsJson('cat_warrior', SAMPLE_SHAPES) as {
      generator_info: string;
      cat_warrior: {
        type: string;
        label: string;
        fixtures: Array<{
          label: string;
          layer: string;
          isSensor: boolean;
          activeFrames?: number[];
          vertices: Array<Array<{ x: number; y: number }>>;
        }>;
      };
    };

    expect(manifest.generator_info).toBe('Nibgrid v1.0');
    expect(manifest.cat_warrior.type).toBe('fromPhysicsEditor');
    expect(manifest.cat_warrior.fixtures).toHaveLength(3);

    const colliderFix = manifest.cat_warrior.fixtures.find((f) => f.layer === 'collider')!;
    const hurtboxFix = manifest.cat_warrior.fixtures.find((f) => f.layer === 'hurtbox')!;
    const hitboxFix = manifest.cat_warrior.fixtures.find((f) => f.layer === 'hitbox')!;

    expect(colliderFix.isSensor).toBe(false);
    expect(hurtboxFix.isSensor).toBe(true);
    expect(hitboxFix.isSensor).toBe(true);
    expect(hitboxFix.activeFrames).toEqual([2, 3]);
    expect(colliderFix.vertices[0]).toEqual(SAMPLE_SHAPES[0]!.vertices);

    const combined = exportCombinedAtlasPhysicsJson([
      { slug: 'sprite_0_101', shapes: SAMPLE_SHAPES },
    ]);
    expect(combined).toHaveProperty('sprite_0_101');
  });

  it('bundles collider .tres, _matter.json, and Zod-valid recipe.json into sprite ZIP', () => {
    const now = '2026-11-23T12:00:00.000Z';
    const project: Project = {
      id: 'proj-1',
      name: 'Cat Warrior',
      artBible: createDefaultArtBible(),
      createdAt: now,
      updatedAt: now,
    };
    const node: SpriteNode = {
      id: 'node-1',
      projectId: 'proj-1',
      parentId: null,
      kind: 'generation',
      imageBlobId: 'blob-raw',
      collisionShapes: [...SAMPLE_SHAPES],
      sketchSha256: 'a'.repeat(64),
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-pixel-v1',
        seed: 42,
        adherence: 'strict',
        promptDelta: 'red cat warrior',
        compiledPrompt: 'red cat warrior',
        createdAt: now,
      },
    };
    const postProcess = createDefaultPostProcessConfig(64, 64);
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess,
      filename: 'cat-warrior.png',
      outputWidth: 64,
      outputHeight: 64,
      collisionShapes: SAMPLE_SHAPES,
    });

    const extraFiles = buildColliderExportFiles('cat-warrior', SAMPLE_SHAPES);
    const zipBytes = packageSpriteZip({
      slug: 'cat-warrior',
      pngBytes: new Uint8Array([137, 80, 78, 71]),
      recipe,
      extraFiles,
    });

    const unzipped = unzipSync(zipBytes);
    expect(unzipped['cat-warrior_collider.tres']).toBeDefined();
    expect(unzipped['cat-warrior_matter.json']).toBeDefined();
    expect(unzipped['cat-warrior.recipe.json']).toBeDefined();

    const parsedRecipe = AssetRecipeSchema.parse(
      JSON.parse(strFromU8(unzipped['cat-warrior.recipe.json']!)),
    );
    expect(parsedRecipe.collisionShapes).toHaveLength(3);
    expect(parsedRecipe.collisionShapes?.[2]?.activeFrames).toEqual([2, 3]);

    const tresText = strFromU8(unzipped['cat-warrior_collider.tres']!);
    expect(tresText).toContain('ConvexPolygonShape2D');

    const matterJson = JSON.parse(strFromU8(unzipped['cat-warrior_matter.json']!)) as {
      'cat-warrior': { fixtures: Array<{ isSensor: boolean }> };
    };
    expect(matterJson['cat-warrior'].fixtures).toHaveLength(3);
  });
});
