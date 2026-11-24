import { strToU8, zipSync } from 'fflate';
import type { ArtMode, ParallaxBandRole, ParallaxSceneBlueprint } from '../domain/schemas';
import { hexToRgbTuple } from '../processing/parallaxCompositor';
import { encodeRgbaToPngBytes } from '../processing/png';
import type { RgbaBuffer } from '../processing/types';
import { AssetRecipeSchema, type AssetRecipe } from './recipeBuilder';

export interface ParallaxExportLayer {
  readonly id: string;
  readonly name: string;
  readonly role?: ParallaxBandRole;
  readonly scrollRatioX: number;
  readonly yOffsetPx: number;
  readonly seamBlendPx: number;
  readonly depthHaze: number;
  readonly buffer: RgbaBuffer;
}

export interface ParallaxExportOptions {
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly skyTopHex: string;
  readonly horizonHex: string;
  readonly contrastDampening: number;
  readonly cameraSpeedPxPerSec: number;
  readonly artMode: ArtMode;
  readonly blueprint?: ParallaxSceneBlueprint;
}

export function safeParallaxLayerSlug(name: string, index: number): string {
  const cleaned = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned : `band-${index}`;
}

function toGodotNodeName(name: string, fallback: string): string {
  const cleaned = name
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function resolveLayerFilename(slug: string, layer: ParallaxExportLayer, index: number): string {
  const safeSlug = slug || 'nibgrid-parallax';
  return `${safeSlug}_layer_${index}_${safeParallaxLayerSlug(layer.name, index)}.png`;
}

/**
 * Generates a Godot 4.3+ `Parallax2D` `.tscn` scene referencing each processed seamless band PNG
 * with exact `scroll_scale`, horizontal `repeat_size`, nearest pixel filtering, and Y offset.
 */
export function exportGodotParallaxTscn(
  slug: string,
  layers: readonly ParallaxExportLayer[],
  opts: ParallaxExportOptions,
): string {
  const safeSlug = slug || 'nibgrid-parallax';
  const loadSteps = Math.max(1, layers.length + 1);
  const lines: string[] = [`[gd_scene load_steps=${loadSteps} format=3]`, ''];

  layers.forEach((layer, idx) => {
    const filename = resolveLayerFilename(safeSlug, layer, idx);
    lines.push(
      `[ext_resource type="Texture2D" path="res://${escapeGodotString(filename)}" id="${idx + 1}_tex"]`,
    );
  });

  if (layers.length > 0) {
    lines.push('');
  }

  const rootName = toGodotNodeName(`${safeSlug}_ParallaxScene`, 'ParallaxScene');
  lines.push(`[node name="${rootName}" type="Node2D"]`, '');

  const [skyR, skyG, skyB] = hexToRgbTuple(opts.skyTopHex);
  lines.push(
    `[node name="SkyBackdrop" type="ColorRect" parent="."]`,
    `offset_right = ${Math.max(1, Math.round(opts.viewportWidth))}`,
    `offset_bottom = ${Math.max(1, Math.round(opts.viewportHeight))}`,
    `color = Color(${roundTo(skyR / 255, 4)}, ${roundTo(skyG / 255, 4)}, ${roundTo(skyB / 255, 4)}, 1)`,
    '',
  );

  layers.forEach((layer, idx) => {
    const nodeName = toGodotNodeName(`Layer${idx}_${layer.name}`, `Layer_${idx}`);
    const scrollScaleX = roundTo(Math.max(0.05, Math.min(1.25, layer.scrollRatioX)), 3);
    const repeatW = Math.max(1, layer.buffer.width);
    const offsetY = Math.round(
      opts.viewportHeight - layer.buffer.height + Math.round(layer.yOffsetPx),
    );

    lines.push(
      `[node name="${nodeName}" type="Parallax2D" parent="."]`,
      `scroll_scale = Vector2(${scrollScaleX}, 1)`,
      `repeat_size = Vector2(${repeatW}, 0)`,
      'repeat_times = 3',
      '',
      `[node name="Sprite2D" type="Sprite2D" parent="${nodeName}"]`,
      `texture = ExtResource("${idx + 1}_tex")`,
      'centered = false',
      `offset = Vector2(0, ${offsetY})`,
    );
    if (opts.artMode === 'pixel-art') {
      lines.push('texture_filter = 1');
    }
    lines.push('');
  });

  return lines.join('\n');
}

/**
 * Generates unified Phaser 3 `TileSprite` + PixiJS `TilingSprite` metadata JSON for all bands.
 */
export function exportParallaxManifestJson(
  slug: string,
  layers: readonly ParallaxExportLayer[],
  opts: ParallaxExportOptions,
): string {
  const safeSlug = slug || 'nibgrid-parallax';
  const manifest = {
    schema: 'nibgrid.parallax.v1' as const,
    sceneName: safeSlug,
    viewport: {
      width: Math.max(1, Math.round(opts.viewportWidth)),
      height: Math.max(1, Math.round(opts.viewportHeight)),
    },
    skyTopHex: opts.skyTopHex,
    horizonHex: opts.horizonHex,
    contrastDampening: roundTo(opts.contrastDampening, 3),
    cameraSpeedPxPerSec: roundTo(opts.cameraSpeedPxPerSec, 2),
    artMode: opts.artMode,
    ...(opts.blueprint ? { blueprint: opts.blueprint } : {}),
    layers: layers.map((layer, idx) => {
      const filename = resolveLayerFilename(safeSlug, layer, idx);
      const scrollRatioX = roundTo(layer.scrollRatioX, 3);
      const yOffsetPx = Math.round(
        opts.viewportHeight - layer.buffer.height + Math.round(layer.yOffsetPx),
      );
      return {
        index: idx,
        id: layer.id,
        name: layer.name,
        ...(layer.role ? { role: layer.role } : {}),
        filename,
        width: layer.buffer.width,
        height: layer.buffer.height,
        scrollRatioX,
        yOffsetPx,
        rawYOffsetPx: Math.round(layer.yOffsetPx),
        seamBlendPx: Math.round(layer.seamBlendPx),
        depthHaze: roundTo(layer.depthHaze, 3),
        repeatX: true,
        phaser: {
          type: 'TileSprite' as const,
          scrollFactorX: scrollRatioX,
          tilePositionScaleX: scrollRatioX,
        },
        pixi: {
          type: 'TilingSprite' as const,
          scrollRatioX,
        },
      };
    }),
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Encodes all processed seamless band PNGs alongside Godot 4 `.tscn` and Phaser/PixiJS `.json`.
 */
export function buildParallaxExportFiles(
  slug: string,
  layers: readonly ParallaxExportLayer[],
  opts: ParallaxExportOptions,
): Record<string, Uint8Array> {
  const safeSlug = slug || 'nibgrid-parallax';
  const files: Record<string, Uint8Array> = {
    [`${safeSlug}_parallax.tscn`]: strToU8(exportGodotParallaxTscn(safeSlug, layers, opts)),
    [`${safeSlug}_parallax.json`]: strToU8(exportParallaxManifestJson(safeSlug, layers, opts)),
  };

  layers.forEach((layer, idx) => {
    const filename = resolveLayerFilename(safeSlug, layer, idx);
    files[filename] = encodeRgbaToPngBytes(
      layer.buffer.data,
      layer.buffer.width,
      layer.buffer.height,
    );
  });

  return files;
}

export interface PackageParallaxZipParams {
  readonly slug: string;
  readonly layers: readonly ParallaxExportLayer[];
  readonly opts: ParallaxExportOptions;
  readonly recipe: AssetRecipe;
}

/**
 * Packages seamless parallax band PNGs, Godot 4 `Parallax2D` `.tscn`, Phaser/PixiJS `.json`,
 * and strictly Zod-validated `.recipe.json` into a ZIP archive.
 */
export function packageParallaxZip(params: PackageParallaxZipParams): Uint8Array {
  const safeSlug = params.slug || 'nibgrid-parallax';
  const validatedRecipe = AssetRecipeSchema.parse(params.recipe);
  const files: Record<string, Uint8Array> = {
    ...buildParallaxExportFiles(safeSlug, params.layers, params.opts),
    [`${safeSlug}.recipe.json`]: strToU8(`${JSON.stringify(validatedRecipe, null, 2)}\n`),
  };
  return zipSync(files, { level: 6 });
}
