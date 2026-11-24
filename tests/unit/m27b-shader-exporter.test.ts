import { strFromU8, unzipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  createDefaultShaderConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import type { EntityDefinition } from '../../src/domain/entitySchema';
import { assembleGodotEntityFiles } from '../../src/export/godotPrefabAssembler';
import { buildAssetRecipe } from '../../src/export/recipeBuilder';
import { exportGodotShaderMaterialTres, packageShaderZip } from '../../src/export/shaderExporters';
import { packageSpriteZip } from '../../src/export/zipPackager';
import { generateGdShader } from '../../src/providers/shaderGenerator';
import { getGdShaderPreset } from '../../src/processing/gdshaderPresets';

describe('M27B ShaderMaterial .tres exporter, M25 prefab wiring, ZIP bundle & GenAI generator', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits valid Godot 4 ShaderMaterial .tres with Color(...) and uniform parameters', () => {
    const preset = getGdShaderPreset('hit_flash');
    const tres = exportGodotShaderMaterialTres(
      'res://assets/nibgrid/goblin.gdshader',
      preset.source,
      {
        flash_color: [1, 0.5, 0.25, 0.9],
        flash_amount: 0.82,
      },
    );

    expect(tres).toContain('[gd_resource type="ShaderMaterial" load_steps=2 format=3]');
    expect(tres).toContain(
      '[ext_resource type="Shader" path="res://assets/nibgrid/goblin.gdshader" id="1_shader"]',
    );
    expect(tres).toContain('shader = ExtResource("1_shader")');
    expect(tres).toContain('shader_parameter/flash_color = Color(1.0, 0.5, 0.25, 0.9)');
    expect(tres).toContain('shader_parameter/flash_amount = 0.82');
  });

  it('wires .gdshader and _mat.tres into M25 assembleGodotEntityFiles() with matching load_steps', () => {
    const shaderConfig = createDefaultShaderConfig('metallic_sheen');
    const entity: EntityDefinition = {
      id: 'ent-1',
      projectId: 'proj-1',
      slug: 'cat_knight',
      displayName: 'Cat Knight',
      bodyType: 'CharacterBody2D',
      resSubpath: 'assets/nibgrid',
      clips: [{ name: 'idle', spriteNodeId: 'node-1', fps: 8, loop: true }],
      primarySpriteNodeId: 'node-1',
      audioAssetIds: [],
      includeNormalMap: false,
      shaderConfig,
      updatedAt: 1700000000000,
    };

    const files = assembleGodotEntityFiles({
      entity,
      isPixelArt: true,
      spriteFiles: [
        {
          filename: 'cat_knight.png',
          bytes: new Uint8Array([137, 80, 78, 71]),
          spriteNodeId: 'node-1',
        },
      ],
      audioFiles: [],
      colliderPolygons: [],
      sockets: [],
    });

    const shaderFile = files.find(
      (f) => f.relativePath === 'assets/nibgrid/cat_knight/cat_knight.gdshader',
    );
    const matFile = files.find(
      (f) => f.relativePath === 'assets/nibgrid/cat_knight/cat_knight_mat.tres',
    );
    const tscnFile = files.find(
      (f) => f.relativePath === 'assets/nibgrid/cat_knight/cat_knight.tscn',
    );

    expect(shaderFile).toBeDefined();
    expect(matFile).toBeDefined();
    expect(tscnFile).toBeDefined();

    const matText = String(matFile!.content);
    expect(matText).toContain('path="res://assets/nibgrid/cat_knight/cat_knight.gdshader"');

    const tscnText = String(tscnFile!.content);
    // 1_frames, 2_anims, 3_mat => 3 ext_resources + 1 = load_steps=4
    expect(tscnText).toContain('[gd_scene load_steps=4 format=3]');
    expect(tscnText).toContain(
      '[ext_resource type="Material" path="res://assets/nibgrid/cat_knight/cat_knight_mat.tres" id="3_mat"]',
    );
    expect(tscnText).toContain('material = ExtResource("3_mat")');
  });

  it('packages <slug>.gdshader, <slug>_mat.tres, and recipe cleanly inside ZIP bundles', () => {
    const project: Project = {
      id: 'proj-1',
      name: 'Shader Test',
      artBible: createDefaultArtBible(),
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const shaderConfig = createDefaultShaderConfig('wind_sway');
    const postProcess = createDefaultPostProcessConfig();
    const sketchSha256 = 'a'.repeat(64);
    const node: SpriteNode = {
      id: 'node-1',
      projectId: 'proj-1',
      parentId: null,
      kind: 'generation',
      imageBlobId: 'blob-1',
      postProcessConfig: postProcess,
      shaderConfig,
      sketchSha256,
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-v1',
        seed: 42,
        adherence: 'balanced',
        promptDelta: 'hero',
        compiledPrompt: 'hero sprite',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    };
    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess,
      filename: 'oak_banner.png',
      outputWidth: 64,
      outputHeight: 64,
    });

    const shaderZipBytes = packageShaderZip({
      slug: 'oak_banner',
      shaderConfig,
      recipe,
      spritePngBytes: new Uint8Array([137, 80, 78, 71]),
    });
    const unpacked = unzipSync(shaderZipBytes);
    expect(Object.keys(unpacked)).toEqual(
      expect.arrayContaining([
        'oak_banner.gdshader',
        'oak_banner_mat.tres',
        'oak_banner.recipe.json',
        'oak_banner.png',
      ]),
    );
    expect(strFromU8(unpacked['oak_banner.gdshader']!)).toContain('void vertex()');
    expect(strFromU8(unpacked['oak_banner_mat.tres']!)).toContain('shader_parameter/speed = 2.5');

    const fullZipBytes = packageSpriteZip({
      slug: 'oak_banner',
      pngBytes: new Uint8Array([137, 80, 78, 71]),
      recipe,
      shaderBundle: shaderConfig,
    });
    const fullUnpacked = unzipSync(fullZipBytes);
    expect(fullUnpacked['oak_banner.gdshader']).toBeDefined();
    expect(fullUnpacked['oak_banner_mat.tres']).toBeDefined();
  });

  it('generates shader offline by keyword and redacts Gemini API keys on HTTP 401', async () => {
    const artBible = createDefaultArtBible();

    const defaultCaps = {
      supportsInpaint: false,
      supportsMultiRef: false,
      supportsSeed: true,
      isLocal: true,
    };

    const offline = await generateGdShader({
      prompt: 'swaying grass wind foliage',
      artBible,
      providerConfig: {
        id: 'mock',
        displayName: 'Offline Mock',
        kind: 'mock',
        endpointUrl: 'mock://local',
        apiKey: '',
        modelId: 'mock-v1',
        enabled: true,
        capabilities: defaultCaps,
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    });
    expect(offline.transpiled.ok).toBe(true);
    expect(offline.presetId).toBe('wind_sway');
    expect(offline.gdshaderSource).toContain('shader_type canvas_item;');

    const secretKey = 'AIzaSyFakeSecretShaderTestKey12345';
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: `Invalid key ${secretKey}` } }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(
      generateGdShader({
        prompt: 'cyberpunk glitch dissolve',
        artBible,
        providerConfig: {
          id: 'gem-1',
          displayName: 'Gemini BYOK',
          kind: 'gemini',
          endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
          apiKey: secretKey,
          modelId: 'gemini-2.5-flash',
          enabled: true,
          capabilities: { ...defaultCaps, isLocal: false },
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      }),
    ).rejects.toMatchObject({
      message: expect.not.stringContaining(secretKey),
    });
  });
});
