import { describe, expect, it } from 'vitest';
import {
  compileDeterministicGdScript,
  validateAndCompileGdScript,
  validateGdScript,
} from '../../src/export/gdscriptGenerator';
import {
  computeOpaqueBounds,
  parseAndClampDirectorBlueprint,
  resolveSocketHintsToPixels,
} from '../../src/processing/entityDirectorBlueprint';

describe('M26A: Pure-TS EntityDirectorBlueprint, Socket Snapper & Godot 4.3+ GDScript Validator', () => {
  it('sanitizes malformed LLM slugs, clamps normalized coordinates/stats, and resolves sockets strictly within opaque bounds', () => {
    const blueprint = parseAndClampDirectorBlueprint(
      {
        slug: 'Goblin King!! 99',
        displayName: '   Goblin King   ',
        bodyType: 'CharacterBody2D',
        spritePrompt: 'armored goblin king with crown and rusty cleaver',
        turnaroundLayout: 'single',
        generateNormalMap: true,
        colliderMode: 'convex-hull',
        includeHitbox: true,
        includeHurtbox: true,
        sockets: [
          { name: 'Hand R!', normX: 1.4, normY: -0.25, baseAngleDeg: 540 },
          { name: 'muzzle', normX: 0.25, normY: 0.5, baseAngleDeg: -15 },
          { name: 'Hand R!', normX: 0.5, normY: 0.5, baseAngleDeg: 0 }, // duplicate dropped
        ],
        sfxSpecs: [
          {
            cueName: 'Sword Slash!',
            category: 'sfx',
            prompt: 'heavy steel slash',
            engine: 'procedural',
            proceduralPreset: 'hit',
          },
        ],
        behavior: {
          archetype: 'melee-enemy',
          moveSpeed: -20,
          maxHealth: 0,
          attackDamage: -5,
          states: ['idle', '1bad', 'PATROL', 'idle'],
        },
      },
      'fallback prompt',
      'side-platformer',
    );

    expect(blueprint.slug).toBe('goblin_king_99');
    expect(blueprint.displayName).toBe('Goblin King');
    expect(blueprint.sockets).toHaveLength(2);
    expect(blueprint.sockets[0]).toMatchObject({
      name: 'hand_r',
      normX: 1,
      normY: 0,
      baseAngleDeg: 360,
    });
    expect(blueprint.behavior.moveSpeed).toBe(0);
    expect(blueprint.behavior.maxHealth).toBe(1);
    expect(blueprint.behavior.attackDamage).toBe(0);
    expect(blueprint.behavior.states).toEqual(['IDLE', 'STATE_1BAD', 'PATROL']);

    // Build 32x32 synthetic sprite with opaque block in [8..23] x [10..29]
    const w = 32;
    const h = 32;
    const rgba = new Uint8ClampedArray(w * h * 4);
    for (let y = 10; y <= 29; y++) {
      for (let x = 8; x <= 23; x++) {
        rgba[(y * w + x) * 4 + 3] = 255;
      }
    }

    const bounds = computeOpaqueBounds(rgba, w, h, 16);
    expect(bounds).toEqual({ minX: 8, minY: 10, maxX: 23, maxY: 29, width: 16, height: 20 });

    const placed = resolveSocketHintsToPixels(bounds, blueprint.sockets);
    expect(placed).toHaveLength(2);
    for (const sock of placed) {
      expect(sock.restPosPx.x).toBeGreaterThanOrEqual(bounds.minX);
      expect(sock.restPosPx.x).toBeLessThanOrEqual(bounds.maxX);
      expect(sock.restPosPx.y).toBeGreaterThanOrEqual(bounds.minY);
      expect(sock.restPosPx.y).toBeLessThanOrEqual(bounds.maxY);
    }
    expect(placed[0]!.restPosPx).toEqual({ x: 23, y: 10 }); // normX=1, normY=0 -> top-right of opaque bounds
  });

  it('validates Godot 4.3+ GDScript verbatim and falls back cleanly on deprecated Godot 3 syntax', () => {
    const bp = parseAndClampDirectorBlueprint(
      {
        slug: 'goblin_scout',
        displayName: 'Goblin Scout',
        bodyType: 'CharacterBody2D',
        spritePrompt: 'armored goblin scout',
        sockets: [{ name: 'hand_r', normX: 0.8, normY: 0.5, baseAngleDeg: 0 }],
        sfxSpecs: [
          { cueName: 'slash', category: 'sfx', prompt: 'sword slash', engine: 'procedural' },
        ],
        behavior: {
          archetype: 'melee-enemy',
          moveSpeed: 95,
          maxHealth: 40,
          attackDamage: 12,
          states: ['IDLE', 'PATROL', 'ATTACK', 'HURT'],
        },
      },
      'goblin',
      'side-platformer',
    );

    const validAiScript = [
      '```gdscript',
      'class_name GoblinScout',
      'extends CharacterBody2D',
      '@export var move_speed: float = 95.0',
      '@onready var sprite: AnimatedSprite2D = $AnimatedSprite2D',
      'func _physics_process(_delta: float) -> void:',
      '\tmove_and_slide()',
      '```',
    ].join('\n');

    const okRes = validateAndCompileGdScript(validAiScript, bp);
    expect(okRes.usedFallback).toBe(false);
    expect(okRes.reasons).toEqual([]);
    expect(okRes.code).toContain('extends CharacterBody2D');
    expect(okRes.code).not.toContain('```');

    const badGodot3Script = [
      'extends KinematicBody2D',
      'export var speed = 100',
      'onready var spr = $Sprite',
      'func _physics_process(_delta):',
      '\tmove_and_slide(velocity)',
      '\tyield(get_tree(), "idle_frame")',
    ].join('\n');

    const badCheck = validateGdScript(badGodot3Script, 'CharacterBody2D');
    expect(badCheck.valid).toBe(false);
    expect(badCheck.reasons.length).toBeGreaterThanOrEqual(4);

    const fallbackRes = validateAndCompileGdScript(badGodot3Script, bp);
    expect(fallbackRes.usedFallback).toBe(true);
    expect(fallbackRes.code).toContain('class_name GoblinScout');
    expect(fallbackRes.code).toContain('extends CharacterBody2D');
    expect(fallbackRes.code).toContain('@onready var socket_hand_r: Marker2D = $Sockets/hand_r');
    expect(fallbackRes.code).toContain(
      '@onready var sfx_player: AudioStreamPlayer2D = $Audio/SfxPlayer',
    );
    expect(fallbackRes.code).not.toContain('KinematicBody2D');
    expect(fallbackRes.code).not.toContain('yield(');

    expect(compileDeterministicGdScript(bp)).toBe(fallbackRes.code);
  });
});
