import { strToU8, zipSync } from 'fflate';
import type { ArtMode } from '../domain/schemas';
import type { ComposedAtlasResult } from '../processing/atlasCompositor';
import { encodeRgbaToPngBytes } from '../processing/png';

export type AtlasEngineTarget = 'godot' | 'phaser' | 'pixi';

/**
 * Generates PixiJS v8 JSON Hash manifest for a packed atlas page.
 */
export function exportPixiJson(
  atlas: ComposedAtlasResult,
  pageIndex: number,
  baseSlug = 'atlas',
): Record<string, unknown> {
  const page = atlas.pages[pageIndex];
  if (!page) {
    throw new Error(`Missing atlas page index ${pageIndex}`);
  }

  const pageFrames = atlas.frames.filter((f) => f.pageIndex === pageIndex);
  const framesMap: Record<string, unknown> = {};
  const animations: Record<string, string[]> = {};

  for (const frame of pageFrames) {
    framesMap[frame.id] = {
      frame: { x: frame.rect.x, y: frame.rect.y, w: frame.rect.width, h: frame.rect.height },
      rotated: frame.rect.rotated,
      trimmed: frame.trim.trimmed,
      spriteSourceSize: {
        x: frame.trim.trimX,
        y: frame.trim.trimY,
        w: frame.trim.trimW,
        h: frame.trim.trimH,
      },
      sourceSize: { w: frame.trim.sourceW, h: frame.trim.sourceH },
      anchor: { x: frame.pivotNorm.x, y: frame.pivotNorm.y },
    };

    if (frame.animationName) {
      const list = animations[frame.animationName] ?? [];
      list.push(frame.id);
      animations[frame.animationName] = list;
    }
  }

  return {
    frames: framesMap,
    ...(Object.keys(animations).length > 0 ? { animations } : {}),
    meta: {
      app: 'https://franekjemiolo.github.io/nibgrid/',
      version: '1.0',
      image: `${baseSlug}_${pageIndex}.png`,
      ...(page.normal ? { normal_map: `${baseSlug}_${pageIndex}_n.png` } : {}),
      format: 'RGBA8888',
      size: { w: page.width, h: page.height },
      scale: '1',
    },
  };
}

/**
 * Generates Phaser 3 Multiatlas JSON covering all packed pages.
 */
export function exportPhaserMultiatlasJson(
  atlas: ComposedAtlasResult,
  baseSlug = 'atlas',
): Record<string, unknown> {
  const textures = atlas.pages.map((page) => {
    const pageFrames = atlas.frames.filter((f) => f.pageIndex === page.pageIndex);
    return {
      image: `${baseSlug}_${page.pageIndex}.png`,
      ...(page.normal ? { normalMap: `${baseSlug}_${page.pageIndex}_n.png` } : {}),
      format: 'RGBA8888',
      size: { w: page.width, h: page.height },
      scale: 1,
      frames: pageFrames.map((f) => ({
        filename: f.id,
        rotated: f.rect.rotated,
        trimmed: f.trim.trimmed,
        sourceSize: { w: f.trim.sourceW, h: f.trim.sourceH },
        spriteSourceSize: {
          x: f.trim.trimX,
          y: f.trim.trimY,
          w: f.trim.trimW,
          h: f.trim.trimH,
        },
        frame: { x: f.rect.x, y: f.rect.y, w: f.rect.width, h: f.rect.height },
        anchor: { x: f.pivotNorm.x, y: f.pivotNorm.y },
      })),
    };
  });

  return {
    textures,
    meta: {
      app: 'nibgrid',
      version: '1.0',
    },
  };
}

export interface GodotTresExportResult {
  readonly framesTresFilename: string;
  readonly framesTresContent: string;
  readonly texturesTresFiles: Record<string, string>;
}

function toForwardSlash(path: string): string {
  return path.replace(/\\/g, '/');
}

function formatIntRect2(x: number, y: number, w: number, h: number): string {
  return `Rect2(${Math.round(x)}, ${Math.round(y)}, ${Math.round(w)}, ${Math.round(h)})`;
}

/**
 * Generates Godot 4 `.tres` (`format=3`) `SpriteFrames` + `AtlasTexture` + `CanvasTexture`
 * resources preserving trim margins and setting `texture_filter = 1` for pixel art.
 */
export function exportGodotTres(
  atlas: ComposedAtlasResult,
  baseSlug = 'atlas',
  artMode: ArtMode = 'pixel-art',
  fps = 8,
): GodotTresExportResult {
  const safeSlug = toForwardSlash(baseSlug);
  const textureFilter = artMode === 'pixel-art' ? 1 : 2;
  const extResources: string[] = [];
  const subResources: string[] = [];
  const texRefByPage = new Map<number, string>();
  let nextExtId = 1;

  for (const page of atlas.pages) {
    const albedoId = `${nextExtId++}_albedo_${page.pageIndex}`;
    extResources.push(
      `[ext_resource type="Texture2D" path="${safeSlug}_${page.pageIndex}.png" id="${albedoId}"]`,
    );

    const canvasId = `CanvasTexture_${page.pageIndex}`;
    const canvasLines = [
      `[sub_resource type="CanvasTexture" id="${canvasId}"]`,
      `diffuse_texture = ExtResource("${albedoId}")`,
    ];

    if (page.normal) {
      const normalId = `${nextExtId++}_normal_${page.pageIndex}`;
      extResources.push(
        `[ext_resource type="Texture2D" path="${safeSlug}_${page.pageIndex}_n.png" id="${normalId}"]`,
      );
      canvasLines.push(`normal_texture = ExtResource("${normalId}")`);
    }

    canvasLines.push(`texture_filter = ${textureFilter}`);
    subResources.push(canvasLines.join('\n'));
    texRefByPage.set(page.pageIndex, `SubResource("${canvasId}")`);
  }

  const atlasSubIdByFrameId = new Map<string, string>();
  const animGroups = new Map<string, string[]>();
  const texturesTresFiles: Record<string, string> = {};

  for (const frame of atlas.frames) {
    const safeId = frame.id.replace(/[^a-zA-Z0-9_]/g, '_');
    const subId = `AtlasTexture_${safeId}`;
    atlasSubIdByFrameId.set(frame.id, subId);

    const texRef = texRefByPage.get(frame.pageIndex) ?? 'ExtResource("1_albedo_0")';
    const marginW = Math.max(0, frame.trim.sourceW - frame.trim.trimW);
    const marginH = Math.max(0, frame.trim.sourceH - frame.trim.trimH);

    subResources.push(
      [
        `[sub_resource type="AtlasTexture" id="${subId}"]`,
        `atlas = ${texRef}`,
        `region = ${formatIntRect2(frame.rect.x, frame.rect.y, frame.rect.width, frame.rect.height)}`,
        `margin = ${formatIntRect2(frame.trim.trimX, frame.trim.trimY, marginW, marginH)}`,
      ].join('\n'),
    );

    // Individual static AtlasTexture .tres file for drop-in Sprite2D usage
    const singlePage = atlas.pages[frame.pageIndex]!;
    const singleExt: string[] = [
      `[ext_resource type="Texture2D" path="../${safeSlug}_${singlePage.pageIndex}.png" id="1_albedo"]`,
    ];
    const singleCanvasLines = [
      '[sub_resource type="CanvasTexture" id="CanvasTexture_1"]',
      'diffuse_texture = ExtResource("1_albedo")',
    ];
    if (singlePage.normal) {
      singleExt.push(
        `[ext_resource type="Texture2D" path="../${safeSlug}_${singlePage.pageIndex}_n.png" id="2_normal"]`,
      );
      singleCanvasLines.push('normal_texture = ExtResource("2_normal")');
    }
    singleCanvasLines.push(`texture_filter = ${textureFilter}`);
    const singleSub: string[] = [singleCanvasLines.join('\n')];
    const singleAtlasSource = 'SubResource("CanvasTexture_1")';
    const singleLoadSteps = 1 + singleExt.length + singleSub.length;
    const singleKey = toForwardSlash(`textures/${frame.id}.tres`);
    texturesTresFiles[singleKey] = [
      `[gd_resource type="AtlasTexture" load_steps=${singleLoadSteps} format=3]`,
      '',
      ...singleExt,
      ...(singleSub.length > 0 ? ['', ...singleSub] : []),
      '',
      '[resource]',
      `atlas = ${singleAtlasSource}`,
      `region = ${formatIntRect2(frame.rect.x, frame.rect.y, frame.rect.width, frame.rect.height)}`,
      `margin = ${formatIntRect2(frame.trim.trimX, frame.trim.trimY, marginW, marginH)}`,
      '',
    ].join('\n');

    const groupKey = frame.animationName ?? 'default';
    const arr = animGroups.get(groupKey) ?? [];
    arr.push(subId);
    animGroups.set(groupKey, arr);
  }

  const animationsEntries = Array.from(animGroups.entries()).map(([animName, subIds]) => {
    const framesBlock = subIds
      .map((sid) => `{\n"duration": 1.0,\n"texture": SubResource("${sid}")\n}`)
      .join(', ');
    return `{\n"frames": [${framesBlock}],\n"loop": true,\n"name": &"${animName}",\n"speed": ${fps.toFixed(1)}\n}`;
  });

  const loadSteps = 1 + extResources.length + subResources.length;
  const framesTresContent = [
    `[gd_resource type="SpriteFrames" load_steps=${loadSteps} format=3]`,
    '',
    ...extResources,
    '',
    ...subResources,
    '',
    '[resource]',
    `animations = [${animationsEntries.join(', ')}]`,
    '',
  ].join('\n');

  return {
    framesTresFilename: toForwardSlash(`${safeSlug}_frames.tres`),
    framesTresContent,
    texturesTresFiles,
  };
}

export interface PackageAtlasZipInput {
  readonly atlas: ComposedAtlasResult;
  readonly baseSlug?: string;
  readonly engines: readonly AtlasEngineTarget[];
  readonly artMode: ArtMode;
  readonly fps?: number;
}

/**
 * Packages packed atlas PNG pages, lockstep `_n.png` normal atlases, and
 * selected PixiJS v8 / Phaser 3 / Godot 4 manifests into a single ZIP bundle.
 */
export function packageAtlasZip(input: PackageAtlasZipInput): Uint8Array {
  const baseSlug = input.baseSlug ?? 'atlas';
  const files: Record<string, Uint8Array> = {};

  for (const page of input.atlas.pages) {
    files[`${baseSlug}_${page.pageIndex}.png`] = encodeRgbaToPngBytes(
      page.albedo.data,
      page.albedo.width,
      page.albedo.height,
    );
    if (page.normal) {
      files[`${baseSlug}_${page.pageIndex}_n.png`] = encodeRgbaToPngBytes(
        page.normal.data,
        page.normal.width,
        page.normal.height,
      );
    }
  }

  if (input.engines.includes('pixi')) {
    if (input.atlas.pages.length <= 1) {
      files[`${baseSlug}_pixi.json`] = strToU8(
        `${JSON.stringify(exportPixiJson(input.atlas, 0, baseSlug), null, 2)}\n`,
      );
    } else {
      for (const page of input.atlas.pages) {
        files[`${baseSlug}_${page.pageIndex}_pixi.json`] = strToU8(
          `${JSON.stringify(exportPixiJson(input.atlas, page.pageIndex, baseSlug), null, 2)}\n`,
        );
      }
    }
  }

  if (input.engines.includes('phaser')) {
    files[`${baseSlug}.json`] = strToU8(
      `${JSON.stringify(exportPhaserMultiatlasJson(input.atlas, baseSlug), null, 2)}\n`,
    );
  }

  if (input.engines.includes('godot')) {
    const godot = exportGodotTres(input.atlas, baseSlug, input.artMode, input.fps ?? 8);
    files[godot.framesTresFilename] = strToU8(godot.framesTresContent);
    for (const [relPath, text] of Object.entries(godot.texturesTresFiles)) {
      files[relPath] = strToU8(text);
    }
  }

  return zipSync(files, { level: 6 });
}
