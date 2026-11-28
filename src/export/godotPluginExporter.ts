import { sanitizeEntitySlug, type EntityDefinition } from '../domain/entitySchema';
import {
  exportDefaultAudioBusLayoutTres,
  exportGameShellGd,
  exportPlayableMainTscn,
  exportProjectGodot,
  type GameKitTemplateId,
} from './godotGameKitExporter';
import { exportComposableEntityTscn, exportEntityComponentScripts } from './godotPrefabBuilder';
import type { VirtualSyncFile } from './godotPrefabAssembler';

export interface NibgridSyncPluginFiles {
  readonly pluginCfg: string;
  readonly pluginGd: string;
}

/**
 * Emits Godot 4 `addons/nibgrid_sync/plugin.cfg` and `addons/nibgrid_sync/nibgrid_sync.gd` (`@tool extends EditorPlugin`):
 * - Polls `.nibgrid_sync_manifest.json` on a lightweight timer to call `EditorInterface.get_resource_filesystem().scan()`.
 * - Contributes an Inspector "Edit in Nibgrid" button opening `nibgrid://open?assetId=<id>` (Desktop)
 *   with PWA fallback URL (`https://franekjemiolo.github.io/nibgrid/`).
 */
export function exportNibgridSyncPlugin(opts?: {
  readonly pwaBaseUrl?: string;
}): NibgridSyncPluginFiles {
  const pwaUrl = opts?.pwaBaseUrl ?? 'https://franekjemiolo.github.io/nibgrid/';

  const pluginCfg = [
    '[plugin]',
    'name="Nibgrid Live Sync"',
    'description="Auto-scans res:// assets when Nibgrid syncs changes and adds Edit in Nibgrid inspector shortcut."',
    'author="Nibgrid Studio"',
    'version="0.1.0"',
    'script="nibgrid_sync.gd"',
    '',
  ].join('\n');

  const pluginGd = [
    '@tool',
    'extends EditorPlugin',
    '',
    'const MANIFEST_PATH := "res://.nibgrid_sync_manifest.json"',
    `const PWA_FALLBACK_URL := "${pwaUrl}"`,
    '',
    'var _poll_timer: Timer = null',
    'var _last_mtime: int = -1',
    'var _inspector_plugin: EditorInspectorPlugin = null',
    '',
    'class NibgridInspectorPlugin extends EditorInspectorPlugin:',
    '\tfunc _can_handle(object: Object) -> bool:',
    '\t\treturn object is Node or object is Resource',
    '',
    '\tfunc _parse_begin(object: Object) -> void:',
    '\t\tif object == null:',
    '\t\t\treturn',
    '\t\tvar asset_id := ""',
    '\t\tif object.has_meta("nibgrid_entity_slug"):',
    '\t\t\tasset_id = String(object.get_meta("nibgrid_entity_slug"))',
    '\t\telif object is Resource and not (object as Resource).resource_path.is_empty():',
    '\t\t\tasset_id = (object as Resource).resource_path.get_file().get_basename()',
    '\t\tif asset_id.is_empty():',
    '\t\t\treturn',
    '\t\tvar btn := Button.new()',
    '\t\tbtn.text = "Edit in Nibgrid"',
    '\t\tbtn.pressed.connect(func():',
    '\t\t\tvar deep_link := "nibgrid://open?assetId=%s" % asset_id.uri_encode()',
    '\t\t\tvar err := OS.shell_open(deep_link)',
    '\t\t\tif err != OK:',
    '\t\t\t\tOS.shell_open(PWA_FALLBACK_URL)',
    '\t\t)',
    '\t\tadd_custom_control(btn)',
    '',
    'func _enter_tree() -> void:',
    '\t_inspector_plugin = NibgridInspectorPlugin.new()',
    '\tadd_inspector_plugin(_inspector_plugin)',
    '\t_poll_timer = Timer.new()',
    '\t_poll_timer.wait_time = 2.0',
    '\t_poll_timer.autostart = true',
    '\t_poll_timer.timeout.connect(_check_manifest)',
    '\tadd_child(_poll_timer)',
    '',
    'func _exit_tree() -> void:',
    '\tif _poll_timer != null:',
    '\t\t_poll_timer.queue_free()',
    '\t\t_poll_timer = null',
    '\tif _inspector_plugin != null:',
    '\t\tremove_inspector_plugin(_inspector_plugin)',
    '\t\t_inspector_plugin = null',
    '',
    'func _check_manifest() -> void:',
    '\tif not FileAccess.file_exists(MANIFEST_PATH):',
    '\t\treturn',
    '\tvar mtime := int(FileAccess.get_modified_time(MANIFEST_PATH))',
    '\tif _last_mtime == -1:',
    '\t\t_last_mtime = mtime',
    '\t\treturn',
    '\tif mtime != _last_mtime:',
    '\t\t_last_mtime = mtime',
    '\t\tvar efs := EditorInterface.get_resource_filesystem()',
    '\t\tif efs != null:',
    '\t\t\tefs.scan()',
    '',
  ].join('\n');

  return { pluginCfg, pluginGd };
}

export interface AssembleGameKitInput {
  readonly projectName: string;
  readonly templateId: GameKitTemplateId;
  readonly viewportWidth?: number;
  readonly viewportHeight?: number;
  readonly isPixelArt?: boolean;
  readonly entities: readonly EntityDefinition[];
  readonly levelResPath?: string;
  readonly themeResPath?: string;
  readonly minimapResPath?: string;
  readonly hasWorldGraph?: boolean;
  readonly hasDialogue?: boolean;
}

/**
 * Assembles turnkey F5-ready Godot 4 files (`project.godot`, `main.tscn`, `default_bus_layout.tres`,
 * `GameShell.gd`, component scripts, composable entity `.tscn` prefabs, `.nibgrid_sync_manifest.json`,
 * and `addons/nibgrid_sync/` EditorPlugin).
 */
export function assembleGodotGameKitFiles(input: AssembleGameKitInput): VirtualSyncFile[] {
  const files: VirtualSyncFile[] = [];

  files.push({
    relativePath: 'project.godot',
    content: exportProjectGodot({
      projectName: input.projectName,
      templateId: input.templateId,
      ...(input.viewportWidth !== undefined ? { viewportWidth: input.viewportWidth } : {}),
      ...(input.viewportHeight !== undefined ? { viewportHeight: input.viewportHeight } : {}),
      ...(input.isPixelArt !== undefined ? { isPixelArt: input.isPixelArt } : {}),
      includeWorldAutoload: input.hasWorldGraph,
      includeDialogueAutoload: input.hasDialogue,
    }),
  });

  files.push({
    relativePath: 'default_bus_layout.tres',
    content: exportDefaultAudioBusLayoutTres(),
  });

  files.push({
    relativePath: 'scripts/GameShell.gd',
    content: exportGameShellGd(input.templateId, input.projectName),
  });

  files.push({
    relativePath: 'main.tscn',
    content: exportPlayableMainTscn({
      projectName: input.projectName,
      templateId: input.templateId,
      ...(input.levelResPath ? { levelResPath: input.levelResPath } : {}),
      ...(input.themeResPath ? { themeResPath: input.themeResPath } : {}),
      ...(input.minimapResPath ? { minimapResPath: input.minimapResPath } : {}),
    }),
  });

  for (const comp of exportEntityComponentScripts()) {
    files.push(comp);
  }

  const targetEntities =
    input.entities.length > 0
      ? input.entities
      : [
          {
            slug: 'hero',
            displayName: 'Hero',
            role: 'player' as const,
            resSubpath: 'entities',
            stats: { maxHp: 120, moveSpeedPx: 140 },
          },
        ];

  for (const ent of targetEntities) {
    const slug = sanitizeEntitySlug(ent.slug || ent.displayName);
    const subpath =
      (ent.resSubpath || 'entities').replace(/^res:\/\//i, '').replace(/^\/+|\/+$/g, '') ||
      'entities';
    const maxHp =
      'stats' in ent && ent.stats && typeof ent.stats === 'object' && 'maxHp' in ent.stats
        ? Number(ent.stats.maxHp)
        : 100;
    const inferredRole: 'player' | 'npc' | 'enemy' =
      'role' in ent
        ? ent.role
        : slug.includes('hero') || slug.includes('player')
          ? 'player'
          : slug.includes('npc') || slug.includes('guard')
            ? 'npc'
            : 'enemy';
    const moveSpeedPx =
      'playtestConfig' in ent && ent.playtestConfig ? ent.playtestConfig.moveSpeedPx : undefined;
    files.push({
      relativePath: `${subpath}/${slug}/${slug}_prefab.tscn`,
      content: exportComposableEntityTscn({
        slug,
        displayName: ent.displayName,
        role: inferredRole,
        maxHp,
        ...(moveSpeedPx !== undefined ? { moveSpeedPx } : {}),
        isPixelArt: input.isPixelArt,
      }),
    });
  }

  const plugin = exportNibgridSyncPlugin();
  files.push({
    relativePath: 'addons/nibgrid_sync/plugin.cfg',
    content: plugin.pluginCfg,
  });
  files.push({
    relativePath: 'addons/nibgrid_sync/nibgrid_sync.gd',
    content: plugin.pluginGd,
  });

  files.push({
    relativePath: '.nibgrid_sync_manifest.json',
    content: `${JSON.stringify(
      {
        generator: 'nibgrid-m50',
        templateId: input.templateId,
        projectName: input.projectName,
        entityCount: targetEntities.length,
      },
      null,
      2,
    )}\n`,
  });

  return files;
}
