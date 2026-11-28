import { describe, expect, it } from 'vitest';
import {
  exportDefaultAudioBusLayoutTres,
  exportPlayableMainTscn,
  exportProjectGodot,
} from '../../src/export/godotGameKitExporter';
import {
  assembleGodotGameKitFiles,
  exportNibgridSyncPlugin,
} from '../../src/export/godotPluginExporter';
import { exportComposableEntityTscn } from '../../src/export/godotPrefabBuilder';

describe('M50: Turnkey Godot 4 GameKit, Composable Prefab & addons/nibgrid_sync Exporter', () => {
  it('emits valid project.godot with InputMap, 2D layer names, integer pixel viewport & plugin enabled', () => {
    const ini = exportProjectGodot({
      projectName: 'Red Cat Chronicles',
      templateId: 'side-platformer',
      viewportWidth: 320,
      viewportHeight: 180,
      isPixelArt: true,
      includeWorldAutoload: true,
      includeDialogueAutoload: true,
    });

    expect(ini).toContain('config_version=5');
    expect(ini).toContain('run/main_scene="res://main.tscn"');
    expect(ini).toContain('[input]');
    expect(ini).toContain('move_left=');
    expect(ini).toContain('jump=');
    expect(ini).toContain('attack=');
    expect(ini).toContain('interact=');
    expect(ini).toContain('[layer_names]');
    expect(ini).toContain('2d_physics/layer_1="World"');
    expect(ini).toContain('2d_physics/layer_6="Portal"');
    expect(ini).toContain('window/stretch/scale_mode="integer"');
    expect(ini).toContain('default_texture_filter=0');
    expect(ini).toContain('res://addons/nibgrid_sync/plugin.cfg');

    const busTres = exportDefaultAudioBusLayoutTres();
    expect(busTres).toContain('[gd_resource type="AudioBusLayout" format=3]');
    expect(busTres).toContain('&"SFX"');
    expect(busTres).toContain('&"Music"');
    expect(busTres).toContain('&"Ambience"');

    const mainTscn = exportPlayableMainTscn({
      projectName: 'Red Cat Chronicles',
      templateId: 'side-platformer',
      levelResPath: 'res://levels/courtyard.tscn',
    });
    expect(mainTscn).toContain('[gd_scene load_steps=3 format=3]');
    expect(mainTscn).toContain('[node name="TitleScreen"');
    expect(mainTscn).toContain('[node name="HudRoot"');
    expect(mainTscn).toContain('[node name="PauseMenu"');
    expect(mainTscn).not.toContain('NaN');
  });

  it('builds composable Entity .tscn prefab with exact load_steps, AnimationPlayer tracks, HealthComponent & StateMachine', () => {
    const tscn = exportComposableEntityTscn({
      slug: 'goblin_scout',
      displayName: 'Goblin Scout',
      role: 'enemy',
      canvasTextureResPath: 'res://entities/goblin_scout/goblin_scout_canvas.tres',
      shaderMatResPath: 'res://entities/goblin_scout/goblin_scout_mat.tres',
      audioResPath: 'res://entities/goblin_scout/sfx_hit.wav',
      maxHp: 65,
      isPixelArt: true,
      activeAttackFrames: [1, 2],
    });

    // 1 header + 5 ext_resources + 5 sub_resources = 11
    expect(tscn).toContain('[gd_scene load_steps=11 format=3]');
    expect(tscn).toContain('type="CharacterBody2D"');
    expect(tscn).toContain('type="Sprite2D"');
    expect(tscn).toContain('type="LightOccluder2D"');
    expect(tscn).toContain('type="AnimationPlayer"');
    expect(tscn).toContain('HitboxComponent/HitShape:disabled');
    expect(tscn).toContain('shader_parameter/hit_flash');
    expect(tscn).toContain('[node name="HealthComponent"');
    expect(tscn).toContain('max_hp = 65.0');
    expect(tscn).toContain('[node name="HurtboxComponent"');
    expect(tscn).toContain('[node name="StateMachine"');
    expect(tscn).not.toContain('NaN');
    expect(tscn).not.toContain('undefined');
  });

  it('emits valid addons/nibgrid_sync EditorPlugin files and complete GameKit sync manifest', () => {
    const plugin = exportNibgridSyncPlugin();
    expect(plugin.pluginCfg).toContain('[plugin]');
    expect(plugin.pluginCfg).toContain('script="nibgrid_sync.gd"');
    expect(plugin.pluginGd).toContain('@tool');
    expect(plugin.pluginGd).toContain('extends EditorPlugin');
    expect(plugin.pluginGd).toContain('EditorInterface.get_resource_filesystem()');
    expect(plugin.pluginGd).toContain('efs.scan()');
    expect(plugin.pluginGd).toContain('Edit in Nibgrid');

    const bundle = assembleGodotGameKitFiles({
      projectName: 'Red Cat',
      templateId: 'side-platformer',
      isPixelArt: true,
      entities: [],
    });
    const paths = bundle.map((f) => f.relativePath);
    expect(paths).toContain('project.godot');
    expect(paths).toContain('main.tscn');
    expect(paths).toContain('default_bus_layout.tres');
    expect(paths).toContain('addons/nibgrid_sync/plugin.cfg');
    expect(paths).toContain('addons/nibgrid_sync/nibgrid_sync.gd');
    expect(paths).toContain('.nibgrid_sync_manifest.json');
    expect(paths.some((p) => p.endsWith('_prefab.tscn'))).toBe(true);
  });
});
