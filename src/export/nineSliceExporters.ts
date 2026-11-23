import { strToU8 } from 'fflate';
import type { NineSliceConfig } from '../domain/schemas';

function sanitizeForwardPath(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\/+/, '');
}

/**
 * Generates a Godot 4 `StyleBoxTexture` (`format=3`) resource matching configured margins,
 * stretch/tile axis mode, and `draw_center`.
 */
export function exportGodotStyleBoxTres(slug: string, cfg: NineSliceConfig): string {
  const safeSlug = sanitizeForwardPath(slug);
  const stretchInt = cfg.edgeMode === 'tile' ? 1 : 0;
  const drawCenter = cfg.centerMode !== 'transparent';

  return [
    '[gd_resource type="StyleBoxTexture" load_steps=2 format=3]',
    '',
    `[ext_resource type="Texture2D" path="${safeSlug}.png" id="1_panel"]`,
    '',
    '[resource]',
    'texture = ExtResource("1_panel")',
    `texture_margin_left = ${cfg.left.toFixed(1)}`,
    `texture_margin_top = ${cfg.top.toFixed(1)}`,
    `texture_margin_right = ${cfg.right.toFixed(1)}`,
    `texture_margin_bottom = ${cfg.bottom.toFixed(1)}`,
    `axis_stretch_horizontal = ${stretchInt}`,
    `axis_stretch_vertical = ${stretchInt}`,
    `draw_center = ${drawCenter ? 'true' : 'false'}`,
    '',
  ].join('\n');
}

export interface PhaserNineSliceMetadata {
  readonly key: string;
  readonly frame: string;
  readonly leftWidth: number;
  readonly rightWidth: number;
  readonly topHeight: number;
  readonly bottomHeight: number;
}

export function exportPhaserNineSliceJson(
  slug: string,
  cfg: NineSliceConfig,
): PhaserNineSliceMetadata {
  const safeSlug = sanitizeForwardPath(slug);
  return {
    key: safeSlug,
    frame: `${safeSlug}.png`,
    leftWidth: cfg.left,
    rightWidth: cfg.right,
    topHeight: cfg.top,
    bottomHeight: cfg.bottom,
  };
}

export interface PixiNineSliceMetadata {
  readonly texture: string;
  readonly leftWidth: number;
  readonly topHeight: number;
  readonly rightWidth: number;
  readonly bottomHeight: number;
  readonly edgeMode: NineSliceConfig['edgeMode'];
  readonly centerMode: NineSliceConfig['centerMode'];
}

export function exportPixiNineSliceJson(slug: string, cfg: NineSliceConfig): PixiNineSliceMetadata {
  const safeSlug = sanitizeForwardPath(slug);
  return {
    texture: `${safeSlug}.png`,
    leftWidth: cfg.left,
    topHeight: cfg.top,
    rightWidth: cfg.right,
    bottomHeight: cfg.bottom,
    edgeMode: cfg.edgeMode,
    centerMode: cfg.centerMode,
  };
}

/**
 * Produces Godot 4 `.tres` StyleBoxTexture + Phaser 3 & PixiJS v8 9-slice manifests
 * ready for `packageSpriteZip` extraFiles.
 */
export function buildNineSliceExportFiles(
  slug: string,
  cfg: NineSliceConfig,
): Record<string, Uint8Array> {
  const safeSlug = sanitizeForwardPath(slug);
  return {
    [`${safeSlug}_stylebox.tres`]: strToU8(exportGodotStyleBoxTres(safeSlug, cfg)),
    [`${safeSlug}_nineslice_phaser.json`]: strToU8(
      `${JSON.stringify(exportPhaserNineSliceJson(safeSlug, cfg), null, 2)}\n`,
    ),
    [`${safeSlug}_nineslice_pixi.json`]: strToU8(
      `${JSON.stringify(exportPixiNineSliceJson(safeSlug, cfg), null, 2)}\n`,
    ),
  };
}
