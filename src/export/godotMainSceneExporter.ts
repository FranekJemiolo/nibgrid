import type { VirtualSyncFile } from './godotPrefabAssembler';

export interface ExportGodotMainSceneInput {
  readonly levelResPath: string;
  readonly themeResPath?: string;
  readonly rootName?: string;
}

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sanitizeNodeName(raw: string | undefined, fallback: string): string {
  const cleaned = (raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * Generates a drop-in Godot 4.3+ `main.tscn` entry scene (`format=3`) mounting
 * the M35 `TileMapLayer` room scene and M33 HUD `Theme` + `ProgressBar`.
 */
export function exportGodotMainSceneTscn(input: ExportGodotMainSceneInput): string {
  const rootName = sanitizeNodeName(input.rootName, 'Main');
  const extLines: string[] = [
    `[ext_resource type="PackedScene" path="${escapeGodotString(input.levelResPath)}" id="1_lvl"]`,
  ];

  const hasTheme = Boolean(input.themeResPath?.trim());
  if (hasTheme) {
    extLines.push(
      `[ext_resource type="Theme" path="${escapeGodotString(input.themeResPath!.trim())}" id="2_thm"]`,
    );
  }

  const loadSteps = extLines.length + 1;
  const lines: string[] = [
    `[gd_scene load_steps=${loadSteps} format=3]`,
    '',
    ...extLines,
    '',
    `[node name="${rootName}" type="Node2D"]`,
    '',
    '[node name="Level" parent="." instance=ExtResource("1_lvl")]',
    '',
    '[node name="HudLayer" type="CanvasLayer" parent="."]',
    '',
    '[node name="HudRoot" type="Control" parent="HudLayer"]',
    'layout_mode = 3',
    'anchors_preset = 15',
    'anchor_right = 1.0',
    'anchor_bottom = 1.0',
    'grow_horizontal = 2',
    'grow_vertical = 2',
  ];

  if (hasTheme) {
    lines.push('theme = ExtResource("2_thm")');
  }

  lines.push(
    '',
    '[node name="HpBar" type="ProgressBar" parent="HudLayer/HudRoot"]',
    'offset_left = 16.0',
    'offset_top = 16.0',
    'offset_right = 176.0',
    'offset_bottom = 36.0',
    'value = 100.0',
    '',
  );

  return lines.join('\n');
}

export interface AssembleVerticalSliceFilesInput {
  readonly mainSceneTscn: string;
  readonly roomFiles?: readonly VirtualSyncFile[];
  readonly entityFiles?: readonly VirtualSyncFile[];
  readonly uiFiles?: readonly VirtualSyncFile[];
  readonly tileFiles?: readonly VirtualSyncFile[];
  readonly parallaxFiles?: readonly VirtualSyncFile[];
  readonly qaReportJson?: string;
}

/**
 * Aggregates `main.tscn` plus all M20, M23, M24, M25, M27, M32, M33, and M35
 * `VirtualSyncFile[]` artifacts into a deterministic, deduplicated `res://` tree.
 */
export function assembleVerticalSliceSyncFiles(
  input: AssembleVerticalSliceFilesInput,
): readonly VirtualSyncFile[] {
  const deduped = new Map<string, VirtualSyncFile>();

  const addAll = (list?: readonly VirtualSyncFile[]) => {
    for (const file of list ?? []) {
      deduped.set(file.relativePath, file);
    }
  };

  addAll(input.tileFiles);
  addAll(input.parallaxFiles);
  addAll(input.entityFiles);
  addAll(input.uiFiles);
  addAll(input.roomFiles);

  if (input.qaReportJson?.trim()) {
    deduped.set('qa_report.json', {
      relativePath: 'qa_report.json',
      content: input.qaReportJson,
    });
  }

  deduped.set('main.tscn', {
    relativePath: 'main.tscn',
    content: input.mainSceneTscn,
  });

  return Array.from(deduped.values()).sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}
