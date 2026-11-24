import type { GodotBodyType } from '../domain/entitySchema';
import type { EntityDirectorBlueprint } from '../processing/entityDirectorBlueprint';

function toPascalCase(slug: string): string {
  const parts = slug
    .split(/[^a-zA-Z0-9]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'NibgridEntity';
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `Entity${joined}` : joined;
}

/**
 * Strips optional markdown code fences (` ```gdscript ... ``` ` or ` ``` ... ``` `) from LLM output.
 */
export function stripGdScriptFences(raw: string): string {
  const trimmed = raw.trim();
  const fenceMatch = /^```(?:gd|gdscript|txt)?\s*\n([\s\S]*?)\n```$/i.exec(trimmed);
  return fenceMatch?.[1] ? fenceMatch[1].trim() : trimmed;
}

export interface GdScriptValidationResult {
  readonly valid: boolean;
  readonly reasons: readonly string[];
}

/**
 * Validates that generated GDScript matches Godot 4.3+ typed syntax, extends the exact
 * expected `GodotBodyType`, and contains zero Godot 3 deprecated tokens.
 */
export function validateGdScript(
  code: string,
  expectedBodyType: GodotBodyType,
): GdScriptValidationResult {
  const cleaned = stripGdScriptFences(code);
  const reasons: string[] = [];

  if (!cleaned) {
    reasons.push('Generated GDScript is empty.');
    return { valid: false, reasons };
  }

  const extendsPattern = new RegExp(`^\\s*extends\\s+${expectedBodyType}\\b`, 'm');
  if (!extendsPattern.test(cleaned)) {
    reasons.push(`Missing required "extends ${expectedBodyType}" declaration.`);
  }

  if (/\bKinematicBody2D\b/.test(cleaned)) {
    reasons.push('Contains deprecated Godot 3 node type "KinematicBody2D".');
  }
  if (/\byield\s*\(/.test(cleaned)) {
    reasons.push('Contains deprecated Godot 3 "yield(" coroutine syntax.');
  }
  if (/^\s*export\s+(?:var|\()/m.test(cleaned)) {
    reasons.push('Contains deprecated Godot 3 "export var" syntax (must use @export).');
  }
  if (/^\s*onready\s+var\b/m.test(cleaned)) {
    reasons.push('Contains deprecated Godot 3 "onready var" syntax (must use @onready).');
  }
  if (/\bmove_and_slide\s*\([^)\s]/.test(cleaned)) {
    reasons.push(
      'Contains Godot 3 "move_and_slide(...)" with arguments (Godot 4 takes zero args).',
    );
  }

  return {
    valid: reasons.length === 0,
    reasons,
  };
}

/**
 * Compiles a deterministic, strictly typed Godot 4.3+ GDScript controller matching the
 * exact node tree emitted by M25's `assembleGodotEntityFiles()`.
 */
export function compileDeterministicGdScript(blueprint: EntityDirectorBlueprint): string {
  const className = toPascalCase(blueprint.slug);
  const statesList =
    blueprint.behavior.states.length > 0 ? blueprint.behavior.states.join(', ') : 'IDLE';
  const initialState = blueprint.behavior.states[0] ?? 'IDLE';

  const lines: string[] = [
    `class_name ${className}`,
    `extends ${blueprint.bodyType}`,
    '',
    `signal state_changed(new_state: State)`,
    `signal defeated()`,
    '',
    `enum State { ${statesList} }`,
    '',
    `@export var move_speed: float = ${blueprint.behavior.moveSpeed.toFixed(1)}`,
    `@export var max_health: int = ${blueprint.behavior.maxHealth}`,
    `@export var attack_damage: int = ${blueprint.behavior.attackDamage}`,
    '',
    `@onready var sprite: AnimatedSprite2D = $AnimatedSprite2D`,
    `@onready var anim_player: AnimationPlayer = $AnimationPlayer`,
  ];

  if (blueprint.sfxSpecs.length > 0) {
    lines.push(`@onready var sfx_player: AudioStreamPlayer2D = $Audio/SfxPlayer`);
  }

  for (const sock of blueprint.sockets) {
    lines.push(`@onready var socket_${sock.name}: Marker2D = $Sockets/${sock.name}`);
  }

  if (blueprint.includeHitbox) {
    lines.push(`@onready var hitbox: Area2D = $Hitbox`);
  }
  if (blueprint.includeHurtbox) {
    lines.push(`@onready var hurtbox: Area2D = $Hurtbox`);
  }

  lines.push(
    '',
    `var current_state: State = State.${initialState}`,
    `var health: int = max_health`,
    '',
    `func _ready() -> void:`,
    `\thealth = max_health`,
    `\tif anim_player and anim_player.has_animation("idle"):`,
    `\t\tanim_player.play("idle")`,
    '',
  );

  if (blueprint.bodyType === 'CharacterBody2D') {
    lines.push(
      `func _physics_process(delta: float) -> void:`,
      `\tmatch current_state:`,
      `\t\tState.${initialState}:`,
      `\t\t\tvelocity = velocity.move_toward(Vector2.ZERO, move_speed * 6.0 * delta)`,
      `\t\t_:`,
      `\t\t\tvelocity = velocity.limit_length(move_speed)`,
      `\tmove_and_slide()`,
      '',
    );
  } else {
    lines.push(`func _physics_process(_delta: float) -> void:`, `\tpass`, '');
  }

  lines.push(
    `func set_state(next_state: State) -> void:`,
    `\tif current_state == next_state:`,
    `\t\treturn`,
    `\tcurrent_state = next_state`,
    `\tstate_changed.emit(current_state)`,
    '',
    `func take_damage(amount: int) -> void:`,
    `\thealth = maxi(0, health - maxi(0, amount))`,
  );

  if (blueprint.behavior.states.includes('HURT')) {
    lines.push(`\tset_state(State.HURT)`);
  }
  if (blueprint.sfxSpecs.length > 0) {
    lines.push(`\tif sfx_player and not sfx_player.playing:`, `\t\tsfx_player.play()`);
  }

  lines.push(`\tif health == 0:`, `\t\tdefeated.emit()`, `\t\tqueue_free()`, '');

  return lines.join('\n');
}

export interface CompiledGdScriptResult {
  readonly code: string;
  readonly usedFallback: boolean;
  readonly reasons: readonly string[];
}

/**
 * Validates AI-authored GDScript against Godot 4.3+ rules and cleanly falls back to the
 * deterministic typed controller template when offline or validation fails.
 */
export function validateAndCompileGdScript(
  aiCode: string | null | undefined,
  blueprint: EntityDirectorBlueprint,
): CompiledGdScriptResult {
  if (!aiCode || !aiCode.trim()) {
    return {
      code: compileDeterministicGdScript(blueprint),
      usedFallback: true,
      reasons: ['No AI script provided; used deterministic Godot 4.3+ controller template.'],
    };
  }

  const cleaned = stripGdScriptFences(aiCode);
  const check = validateGdScript(cleaned, blueprint.bodyType);
  if (check.valid) {
    return {
      code: `${cleaned}\n`,
      usedFallback: false,
      reasons: [],
    };
  }

  return {
    code: compileDeterministicGdScript(blueprint),
    usedFallback: true,
    reasons: check.reasons,
  };
}
