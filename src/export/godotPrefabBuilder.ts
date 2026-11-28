export interface ComposableEntityInput {
  readonly slug: string;
  readonly displayName: string;
  readonly role?: 'player' | 'enemy' | 'npc' | 'prop';
  readonly spriteResPath?: string;
  readonly canvasTextureResPath?: string;
  readonly shaderMatResPath?: string;
  readonly audioResPath?: string;
  readonly maxHp?: number;
  readonly moveSpeedPx?: number;
  readonly isPixelArt?: boolean;
  readonly activeAttackFrames?: readonly number[];
  readonly colliderHalfSizePx?: { readonly x: number; readonly y: number };
}

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function toPascalCase(slug: string): string {
  const clean = slug
    .replace(/[^a-zA-Z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join('');
  return clean.length > 0 ? clean : 'NibgridEntity';
}

function finiteFloat(v: number | undefined, fallback: number): string {
  const num = Number.isFinite(v) ? (v as number) : fallback;
  const rounded = Number(num.toFixed(3));
  return Number.isInteger(rounded) ? `${rounded}.0` : String(rounded);
}

/**
 * Generates shared modular GDScript components (`HealthComponent.gd`, `StateMachine.gd`) used by
 * M50 turnkey entity `.tscn` scenes.
 */
export function exportEntityComponentScripts(): readonly {
  readonly relativePath: string;
  readonly content: string;
}[] {
  const healthGd = [
    'extends Node',
    'class_name HealthComponent',
    '',
    '@export var max_hp: float = 100.0',
    'var current_hp: float = 100.0',
    '',
    'signal damaged(amount: float, remaining_hp: float)',
    'signal died',
    '',
    'func _ready() -> void:',
    '\tcurrent_hp = max_hp',
    '',
    'func take_damage(amount: float) -> void:',
    '\tvar dmg := maxf(0.0, amount)',
    '\tcurrent_hp = maxf(0.0, current_hp - dmg)',
    '\tdamaged.emit(dmg, current_hp)',
    '\tif current_hp <= 0.0:',
    '\t\tdied.emit()',
    '',
  ].join('\n');

  const stateMachineGd = [
    'extends Node',
    'class_name NibgridStateMachine',
    '',
    '@export var initial_state: StringName = &"Idle"',
    'var current_state: StringName = &"Idle"',
    '',
    'signal state_changed(prev_state: StringName, next_state: StringName)',
    '',
    'func _ready() -> void:',
    '\tcurrent_state = initial_state',
    '',
    'func transition_to(next_state: StringName) -> void:',
    '\tif current_state == next_state:',
    '\t\treturn',
    '\tvar prev := current_state',
    '\tcurrent_state = next_state',
    '\tstate_changed.emit(prev, next_state)',
    '',
  ].join('\n');

  return [
    { relativePath: 'scripts/components/HealthComponent.gd', content: healthGd },
    { relativePath: 'scripts/components/StateMachine.gd', content: stateMachineGd },
  ];
}

/**
 * Builds a modular, F5-ready Godot 4.3+ composable Entity `.tscn` prefab (`CharacterBody2D`,
 * `CollisionShape2D`, `Sprite2D` wired to M44 `CanvasTexture`, `LightOccluder2D`, `AnimationPlayer`
 * driving frames + `HitboxComponent` `activeFrames` + `hit_flash` + SFX cue, `HealthComponent`,
 * `HurtboxComponent`, and `StateMachine`).
 */
export function exportComposableEntityTscn(input: ComposableEntityInput): string {
  const slug = input.slug.trim().replace(/[^a-zA-Z0-9_-]+/g, '_') || 'entity';
  const rootName = toPascalCase(slug);
  const role = input.role ?? 'enemy';
  const maxHp = Math.max(1, Math.round(input.maxHp ?? 100));
  const halfX = Math.max(4, input.colliderHalfSizePx?.x ?? 10);
  const halfY = Math.max(4, input.colliderHalfSizePx?.y ?? 14);
  const filter = input.isPixelArt === false ? 1 : 0;
  const activeFrames = input.activeAttackFrames ?? [1, 2];
  const firstActiveSec = ((activeFrames[0] ?? 1) * 0.1).toFixed(2);
  const endActiveSec = (((activeFrames[activeFrames.length - 1] ?? 2) + 1) * 0.1).toFixed(2);

  // Layer bits: Player=2 (mask World 1 + Portal 6 + Interactable 7), Enemy=3 (mask World 1)
  const collisionLayer = role === 'player' ? 2 : 4;
  const collisionMask = role === 'player' ? 1 | 32 | 64 : 1;

  const extResources: string[] = [
    '[ext_resource type="Script" path="res://scripts/components/HealthComponent.gd" id="1_health"]',
    '[ext_resource type="Script" path="res://scripts/components/StateMachine.gd" id="2_fsm"]',
  ];
  let nextExt = 3;

  const texResPath = input.canvasTextureResPath ?? input.spriteResPath;
  let texExtId: string | null = null;
  if (texResPath?.trim()) {
    texExtId = `${nextExt++}_tex`;
    extResources.push(
      `[ext_resource type="Texture2D" path="${escapeGodotString(texResPath.trim())}" id="${texExtId}"]`,
    );
  }

  let matExtId: string | null = null;
  if (input.shaderMatResPath?.trim()) {
    matExtId = `${nextExt++}_mat`;
    extResources.push(
      `[ext_resource type="Material" path="${escapeGodotString(input.shaderMatResPath.trim())}" id="${matExtId}"]`,
    );
  }

  let audioExtId: string | null = null;
  if (input.audioResPath?.trim()) {
    audioExtId = `${nextExt++}_sfx`;
    extResources.push(
      `[ext_resource type="AudioStream" path="${escapeGodotString(input.audioResPath.trim())}" id="${audioExtId}"]`,
    );
  }

  const subResources: string[] = [
    [
      '[sub_resource type="RectangleShape2D" id="BodyShape_1"]',
      `size = Vector2(${finiteFloat(halfX * 2, 20)}, ${finiteFloat(halfY * 2, 28)})`,
    ].join('\n'),
    [
      '[sub_resource type="OccluderPolygon2D" id="Occluder_1"]',
      `polygon = PackedVector2Array(${-halfX}, ${-halfY}, ${halfX}, ${-halfY}, ${halfX}, ${halfY}, ${-halfX}, ${halfY})`,
    ].join('\n'),
    [
      '[sub_resource type="Animation" id="Anim_idle"]',
      'resource_name = "idle"',
      'length = 0.6',
      'loop_mode = 1',
      'tracks/0/type = "value"',
      'tracks/0/imported = false',
      'tracks/0/enabled = true',
      'tracks/0/path = NodePath("Sprite2D:frame")',
      'tracks/0/interp = 1',
      'tracks/0/keys = {\n"times": PackedFloat32Array(0, 0.3),\n"transitions": PackedFloat32Array(1, 1),\n"update": 1,\n"values": [0, 0]\n}',
    ].join('\n'),
    [
      '[sub_resource type="Animation" id="Anim_attack"]',
      'resource_name = "attack"',
      'length = 0.45',
      'tracks/0/type = "value"',
      'tracks/0/imported = false',
      'tracks/0/enabled = true',
      'tracks/0/path = NodePath("Sprite2D:frame")',
      'tracks/0/interp = 1',
      'tracks/0/keys = {\n"times": PackedFloat32Array(0, 0.1, 0.25),\n"transitions": PackedFloat32Array(1, 1, 1),\n"update": 1,\n"values": [0, 1, 0]\n}',
      'tracks/1/type = "value"',
      'tracks/1/imported = false',
      'tracks/1/enabled = true',
      'tracks/1/path = NodePath("HitboxComponent/HitShape:disabled")',
      'tracks/1/interp = 1',
      `tracks/1/keys = {\n"times": PackedFloat32Array(0, ${firstActiveSec}, ${endActiveSec}),\n"transitions": PackedFloat32Array(1, 1, 1),\n"update": 1,\n"values": [true, false, true]\n}`,
      'tracks/2/type = "value"',
      'tracks/2/imported = false',
      'tracks/2/enabled = true',
      'tracks/2/path = NodePath("Sprite2D:material:shader_parameter/hit_flash")',
      'tracks/2/interp = 1',
      'tracks/2/keys = {\n"times": PackedFloat32Array(0, 0.15),\n"transitions": PackedFloat32Array(1, 1),\n"update": 0,\n"values": [0.0, 0.0]\n}',
      ...(audioExtId
        ? [
            'tracks/3/type = "method"',
            'tracks/3/imported = false',
            'tracks/3/enabled = true',
            'tracks/3/path = NodePath("AudioStreamPlayer2D")',
            'tracks/3/keys = {\n"times": PackedFloat32Array(0.05),\n"transitions": PackedFloat32Array(1),\n"values": [{"args": [0.0], "method": &"play"}]\n}',
          ]
        : []),
    ].join('\n'),
    [
      '[sub_resource type="AnimationLibrary" id="AnimLib_1"]',
      '_data = {\n&"attack": SubResource("Anim_attack"),\n&"idle": SubResource("Anim_idle")\n}',
    ].join('\n'),
  ];

  const loadSteps = 1 + extResources.length + subResources.length;

  return [
    `[gd_scene load_steps=${loadSteps} format=3]`,
    '',
    ...extResources,
    '',
    ...subResources.map((s) => `${s}\n`),
    `[node name="${rootName}" type="CharacterBody2D"]`,
    `collision_layer = ${collisionLayer}`,
    `collision_mask = ${collisionMask}`,
    `metadata/nibgrid_entity_slug = "${escapeGodotString(slug)}"`,
    '',
    '[node name="CollisionShape2D" type="CollisionShape2D" parent="."]',
    'shape = SubResource("BodyShape_1")',
    '',
    '[node name="Sprite2D" type="Sprite2D" parent="."]',
    `texture_filter = ${filter}`,
    ...(texExtId ? [`texture = ExtResource("${texExtId}")`] : []),
    ...(matExtId ? [`material = ExtResource("${matExtId}")`] : []),
    '',
    '[node name="LightOccluder2D" type="LightOccluder2D" parent="Sprite2D"]',
    'occluder = SubResource("Occluder_1")',
    '',
    '[node name="AnimationPlayer" type="AnimationPlayer" parent="."]',
    'libraries = {\n&"": SubResource("AnimLib_1")\n}',
    '',
    '[node name="HealthComponent" type="Node" parent="."]',
    'script = ExtResource("1_health")',
    `max_hp = ${finiteFloat(maxHp, 100)}`,
    '',
    '[node name="HurtboxComponent" type="Area2D" parent="."]',
    'collision_layer = 16',
    'collision_mask = 8',
    '',
    '[node name="HurtShape" type="CollisionShape2D" parent="HurtboxComponent"]',
    'shape = SubResource("BodyShape_1")',
    '',
    '[node name="HitboxComponent" type="Area2D" parent="."]',
    'collision_layer = 8',
    'collision_mask = 16',
    '',
    '[node name="HitShape" type="CollisionShape2D" parent="HitboxComponent"]',
    'disabled = true',
    'shape = SubResource("BodyShape_1")',
    '',
    '[node name="AudioStreamPlayer2D" type="AudioStreamPlayer2D" parent="."]',
    ...(audioExtId ? [`stream = ExtResource("${audioExtId}")`] : []),
    'bus = &"SFX"',
    '',
    '[node name="StateMachine" type="Node" parent="."]',
    'script = ExtResource("2_fsm")',
    '',
    '[node name="Idle" type="Node" parent="StateMachine"]',
    '[node name="Move" type="Node" parent="StateMachine"]',
    '[node name="Attack" type="Node" parent="StateMachine"]',
    '[node name="Hurt" type="Node" parent="StateMachine"]',
    '[node name="Dead" type="Node" parent="StateMachine"]',
    '',
  ].join('\n');
}
