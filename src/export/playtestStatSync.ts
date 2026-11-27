import { sanitizeEntitySlug, type EntityDefinition } from '../domain/entitySchema';

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
 * Updates `@export var move_speed: float = ...` and `@export var attack_damage: int = ...`
 * inside an M26 GDScript controller without modifying surrounding code or comments.
 */
export function applyPlaytestStatsToGdScript(
  gdscript: string,
  stats: { readonly moveSpeedPx: number; readonly attackDamage: number },
): string {
  const safeSpeed = Math.max(0, Number.isFinite(stats.moveSpeedPx) ? stats.moveSpeedPx : 140);
  const safeDamage = Math.max(
    1,
    Math.round(Number.isFinite(stats.attackDamage) ? stats.attackDamage : 12),
  );

  let updated = gdscript.replace(
    /^([ \t]*@export\s+var\s+move_speed\s*:\s*float\s*=\s*)([-+]?\d+(?:\.\d+)?)(.*)$/gm,
    `$1${safeSpeed.toFixed(1)}$3`,
  );
  updated = updated.replace(
    /^([ \t]*@export\s+var\s+attack_damage\s*:\s*int\s*=\s*)([-+]?\d+)(.*)$/gm,
    `$1${safeDamage}$3`,
  );
  return updated;
}

/**
 * Updates an entity's existing `.gd` script with tuned playtest stats, or emits a clean
 * typed Godot 4.3+ starter controller when no script exists yet.
 */
export function ensureEntityPlaytestGdScript(
  entity: Pick<EntityDefinition, 'slug' | 'displayName' | 'bodyType' | 'scriptContent'>,
  stats: { readonly moveSpeedPx: number; readonly attackDamage: number },
): string {
  if (entity.scriptContent && entity.scriptContent.trim().length > 0) {
    return applyPlaytestStatsToGdScript(entity.scriptContent, stats);
  }

  const slug = sanitizeEntitySlug(entity.slug || entity.displayName);
  const className = toPascalCase(slug);
  const safeSpeed = Math.max(0, Number.isFinite(stats.moveSpeedPx) ? stats.moveSpeedPx : 140);
  const safeDamage = Math.max(
    1,
    Math.round(Number.isFinite(stats.attackDamage) ? stats.attackDamage : 12),
  );

  const lines = [
    `class_name ${className}`,
    `extends ${entity.bodyType}`,
    '',
    `@export var move_speed: float = ${safeSpeed.toFixed(1)}`,
    `@export var attack_damage: int = ${safeDamage}`,
    '',
    'func _physics_process(_delta: float) -> void:',
  ];

  if (entity.bodyType === 'CharacterBody2D') {
    lines.push('\tmove_and_slide()', '');
  } else {
    lines.push('\tpass', '');
  }

  return lines.join('\n');
}

/**
 * Computes normalized `[0, 1]` M27 `flash_amount` shader uniform from remaining hit-flash duration.
 */
export function computeHitFlashUniform(flashRemainingMs: number, flashDurationMs: number): number {
  if (
    !Number.isFinite(flashRemainingMs) ||
    !Number.isFinite(flashDurationMs) ||
    flashDurationMs <= 0 ||
    flashRemainingMs <= 0
  ) {
    return 0;
  }
  return Math.max(0, Math.min(1, flashRemainingMs / flashDurationMs));
}

export interface FixedTimestepRunner {
  reset(): void;
  advance(rawDeltaMs: number, onStep: (dtMs: number) => void): number;
}

/**
 * Creates a spiral-of-death-safe fixed-timestep accumulator capping each raw frame delta
 * (`<= maxFrameDeltaMs`, default `100ms`) and stepping strictly in `fixedStepMs` (`60 Hz`) slices.
 */
export function createFixedTimestepRunner(
  fixedStepMs = 1000 / 60,
  maxFrameDeltaMs = 100,
): FixedTimestepRunner {
  let accumulatorMs = 0;

  return {
    reset() {
      accumulatorMs = 0;
    },
    advance(rawDeltaMs: number, onStep: (dtMs: number) => void): number {
      const clamped = Math.max(
        0,
        Math.min(maxFrameDeltaMs, Number.isFinite(rawDeltaMs) ? rawDeltaMs : 0),
      );
      accumulatorMs += clamped;
      let steps = 0;
      while (accumulatorMs + 1e-6 >= fixedStepMs) {
        accumulatorMs = Math.max(0, accumulatorMs - fixedStepMs);
        onStep(fixedStepMs);
        steps++;
      }
      return steps;
    },
  };
}
