import { strToU8, zipSync } from 'fflate';
import type { VfxFlipbookOptions } from '../processing/vfxFlipbook';
import { AssetRecipeSchema, type AssetRecipe } from './recipeBuilder';

export type VfxExportMetaOpts = Pick<
  VfxFlipbookOptions,
  'archetype' | 'frameSizePx' | 'cols' | 'rows'
>;

export interface GodotVfxBundle {
  readonly textureFilename: string;
  readonly materialFilename: string;
  readonly sceneFilename: string;
  readonly materialTres: string;
  readonly sceneTscn: string;
}

export interface PackageVfxFlipbookZipParams {
  readonly slug: string;
  readonly sheetPngBytes: Uint8Array;
  readonly opts: VfxExportMetaOpts;
  readonly fps?: number;
  readonly recipe: AssetRecipe;
}

function normalizePositiveInt(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.round(value));
}

function normalizeFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 16;
  return Number(Math.max(1, Math.min(60, fps)).toFixed(2));
}

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toGodotNodeName(slug: string): string {
  const cleaned = slug
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'VfxBurst';
}

function isAdditiveArchetype(archetype: VfxExportMetaOpts['archetype']): boolean {
  return archetype === 'sparks' || archetype === 'hit-ring';
}

/**
 * Generates a Godot 4 `CanvasItemMaterial` `.tres` + `GPUParticles2D` `.tscn` bundle
 * configured for flipbook spritesheet animation (`h_frames = cols`, `v_frames = rows`).
 */
export function exportGodotVfxBundle(
  slug: string,
  opts: VfxExportMetaOpts,
  fps = 16,
): GodotVfxBundle {
  const safeSlug = slug || 'nibgrid-vfx';
  const cols = normalizePositiveInt(opts.cols, 4);
  const rows = normalizePositiveInt(opts.rows, 4);
  const frameCount = Math.max(1, cols * rows);
  const safeFps = normalizeFps(fps);
  const lifetime = roundTo(frameCount / safeFps, 3);
  const additive = isAdditiveArchetype(opts.archetype);

  const textureFilename = `${safeSlug}_vfx_sheet.png`;
  const materialFilename = `${safeSlug}_vfx_godot.tres`;
  const sceneFilename = `${safeSlug}_vfx_godot.tscn`;

  const materialLines = ['[gd_resource type="CanvasItemMaterial" format=3]', '', '[resource]'];
  if (additive) {
    materialLines.push('blend_mode = 1');
  }
  materialLines.push(
    'particles_animation = true',
    `particles_anim_h_frames = ${cols}`,
    `particles_anim_v_frames = ${rows}`,
    'particles_anim_loop = false',
    '',
  );

  const sceneLines = [
    '[gd_scene load_steps=4 format=3]',
    '',
    `[ext_resource type="Texture2D" path="res://${escapeGodotString(textureFilename)}" id="1_tex"]`,
    `[ext_resource type="Material" path="res://${escapeGodotString(materialFilename)}" id="2_mat"]`,
    '',
    '[sub_resource type="ParticleProcessMaterial" id="ParticleProcessMaterial_1"]',
    'particle_flag_disable_z = true',
    'gravity = Vector3(0, 0, 0)',
    'anim_speed_min = 1.0',
    'anim_speed_max = 1.0',
    '',
    `[node name="${toGodotNodeName(safeSlug)}" type="GPUParticles2D"]`,
    'material = ExtResource("2_mat")',
    'amount = 1',
    'process_material = SubResource("ParticleProcessMaterial_1")',
    'texture = ExtResource("1_tex")',
    `lifetime = ${lifetime}`,
    'one_shot = true',
    'explosiveness = 1.0',
    '',
  ];

  return {
    textureFilename,
    materialFilename,
    sceneFilename,
    materialTres: materialLines.join('\n'),
    sceneTscn: sceneLines.join('\n'),
  };
}

/**
 * Generates a PixiJS flipbook / particle layer JSON specification with exact per-cell
 * rectangles, frame count, FPS, lifetime, and recommended blend mode.
 */
export function exportPixiVfxJson(slug: string, opts: VfxExportMetaOpts, fps = 16): string {
  const safeSlug = slug || 'nibgrid-vfx';
  const cols = normalizePositiveInt(opts.cols, 4);
  const rows = normalizePositiveInt(opts.rows, 4);
  const frameSizePx = normalizePositiveInt(opts.frameSizePx, 64);
  const frameCount = Math.max(1, cols * rows);
  const safeFps = normalizeFps(fps);
  const lifetimeSec = roundTo(frameCount / safeFps, 3);
  const blendMode = isAdditiveArchetype(opts.archetype) ? 'add' : 'normal';

  const frames = Array.from({ length: frameCount }, (_, idx) => {
    const col = idx % cols;
    const row = Math.floor(idx / cols);
    return {
      frame: idx,
      x: col * frameSizePx,
      y: row * frameSizePx,
      w: frameSizePx,
      h: frameSizePx,
    };
  });

  return `${JSON.stringify(
    {
      app: 'nibgrid',
      engine: 'pixijs',
      sprite: safeSlug,
      texture: `${safeSlug}_vfx_sheet.png`,
      archetype: opts.archetype,
      cols,
      rows,
      frameSizePx,
      sheetWidth: cols * frameSizePx,
      sheetHeight: rows * frameSizePx,
      frameCount,
      fps: safeFps,
      lifetimeSec,
      blendMode,
      frames,
    },
    null,
    2,
  )}\n`;
}

/**
 * Builds the VFX flipbook file map (`<slug>_vfx_sheet.png`, `_vfx_godot.tres`,
 * `_vfx_godot.tscn`, and `_vfx_pixi.json`) ready for ZIP packaging.
 */
export function buildVfxExportFiles(
  slug: string,
  sheetPngBytes: Uint8Array,
  opts: VfxExportMetaOpts,
  fps = 16,
): Record<string, Uint8Array> {
  const safeSlug = slug || 'nibgrid-vfx';
  const godot = exportGodotVfxBundle(safeSlug, opts, fps);
  const pixiJson = exportPixiVfxJson(safeSlug, opts, fps);

  return {
    [godot.textureFilename]: sheetPngBytes,
    [godot.materialFilename]: strToU8(godot.materialTres),
    [godot.sceneFilename]: strToU8(godot.sceneTscn),
    [`${safeSlug}_vfx_pixi.json`]: strToU8(pixiJson),
  };
}

/**
 * Packages a baked VFX spritesheet, Godot 4 `.tres`/`.tscn`, PixiJS JSON, and
 * Zod-validated `<slug>.recipe.json` into a ZIP archive via `fflate`.
 */
export function packageVfxFlipbookZip(params: PackageVfxFlipbookZipParams): Uint8Array {
  const safeSlug = params.slug || 'nibgrid-vfx';
  const validatedRecipe = AssetRecipeSchema.parse(params.recipe);
  const files: Record<string, Uint8Array> = {
    ...buildVfxExportFiles(safeSlug, params.sheetPngBytes, params.opts, params.fps ?? 16),
    [`${safeSlug}.recipe.json`]: strToU8(`${JSON.stringify(validatedRecipe, null, 2)}\n`),
  };
  return zipSync(files, { level: 6 });
}
