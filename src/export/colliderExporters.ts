import { strToU8 } from 'fflate';
import type { CollisionLayerShape } from '../domain/schemas';
import { isPolygonConvex } from '../processing/collisionHull';

function formatNum(n: number): string {
  const rounded = Number(n.toFixed(2));
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function formatPackedVector2Array(vertices: ReadonlyArray<{ x: number; y: number }>): string {
  const coords = vertices.flatMap((v) => [formatNum(v.x), formatNum(v.y)]);
  return `PackedVector2Array(${coords.join(', ')})`;
}

/**
 * Generates a Godot 4 `.tres` (`format=3`) CapsuleShape2D or ConvexPolygonShape2D
 * resource from pivot-relative collision layers, plus ready-to-paste comments
 * for concave CollisionPolygon2D or secondary sensor layers.
 */
export function exportGodotColliderTres(
  shapeOrShapes: CollisionLayerShape | readonly CollisionLayerShape[],
): string {
  const shapes = Array.isArray(shapeOrShapes)
    ? shapeOrShapes
    : [shapeOrShapes as CollisionLayerShape];
  if (shapes.length === 0) {
    return [
      '[gd_resource type="ConvexPolygonShape2D" format=3]',
      '',
      '[resource]',
      'points = PackedVector2Array()',
      '',
    ].join('\n');
  }

  const primary = shapes.find((s) => s.layer === 'collider') ?? shapes[0]!;
  const lines: string[] = [];

  if (primary.kind === 'capsule' && primary.capsule) {
    lines.push('[gd_resource type="CapsuleShape2D" format=3]');
    lines.push('');
    lines.push('[resource]');
    lines.push(`radius = ${formatNum(primary.capsule.radius)}`);
    lines.push(`height = ${formatNum(primary.capsule.height)}`);
    lines.push(
      `; center_offset = Vector2(${formatNum(primary.capsule.cx)}, ${formatNum(primary.capsule.cy)}) orientation=${primary.capsule.orientation}`,
    );
  } else {
    const convex = isPolygonConvex(primary.vertices);
    lines.push('[gd_resource type="ConvexPolygonShape2D" format=3]');
    lines.push('');
    lines.push('[resource]');
    lines.push(`points = ${formatPackedVector2Array(primary.vertices)}`);
    if (!convex) {
      lines.push(
        `; NOTE: "${primary.name}" is concave — for CollisionPolygon2D / Area2D use: polygon = ${formatPackedVector2Array(primary.vertices)}`,
      );
    }
  }

  for (const layer of shapes) {
    if (layer.id === primary.id && shapes.length === 1) continue;
    const framesLabel =
      layer.activeFrames && layer.activeFrames.length > 0
        ? ` frames=[${layer.activeFrames.join(',')}]`
        : '';
    lines.push(
      `; layer=${layer.layer} name="${layer.name}" isSensor=${String(layer.isSensor)}${framesLabel}: polygon = ${formatPackedVector2Array(layer.vertices)}`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export interface MatterFixtureEntry {
  readonly label: string;
  readonly layer: string;
  readonly kind: string;
  readonly isSensor: boolean;
  readonly activeFrames?: readonly number[];
  readonly capsule?: CollisionLayerShape['capsule'];
  readonly vertices: ReadonlyArray<ReadonlyArray<{ readonly x: number; readonly y: number }>>;
}

export interface MatterBodyEntry {
  readonly type: 'fromPhysicsEditor';
  readonly label: string;
  readonly isStatic: boolean;
  readonly density: number;
  readonly restitution: number;
  readonly friction: number;
  readonly fixtures: readonly MatterFixtureEntry[];
}

function buildMatterBody(
  spriteSlug: string,
  shapes: readonly CollisionLayerShape[],
): MatterBodyEntry {
  return {
    type: 'fromPhysicsEditor',
    label: spriteSlug,
    isStatic: false,
    density: 0.001,
    restitution: 0.0,
    friction: 0.1,
    fixtures: shapes.map((s) => ({
      label: s.name || s.layer,
      layer: s.layer,
      kind: s.kind,
      isSensor: s.layer === 'collider' ? s.isSensor : true,
      ...(s.activeFrames ? { activeFrames: [...s.activeFrames] } : {}),
      ...(s.capsule ? { capsule: s.capsule } : {}),
      vertices: [s.vertices.map((v) => ({ x: v.x, y: v.y }))],
    })),
  };
}

/**
 * Emits PhysicsEditor-compatible JSON directly consumable by Phaser 3 Matter
 * (`this.matter.add.sprite(x, y, key, 0, { shape })`) and Matter.js.
 */
export function exportMatterPhysicsJson(
  spriteSlug: string,
  shapes: readonly CollisionLayerShape[],
): Record<string, unknown> {
  return {
    generator_info: 'Nibgrid v1.0',
    [spriteSlug]: buildMatterBody(spriteSlug, shapes),
  };
}

/**
 * Generates `<slug>_collider.tres` and `<slug>_matter.json` extra archive entries.
 */
export function buildColliderExportFiles(
  slug: string,
  shapes: readonly CollisionLayerShape[],
): Record<string, Uint8Array> {
  if (shapes.length === 0) return {};
  return {
    [`${slug}_collider.tres`]: strToU8(exportGodotColliderTres(shapes)),
    [`${slug}_matter.json`]: strToU8(
      `${JSON.stringify(exportMatterPhysicsJson(slug, shapes), null, 2)}\n`,
    ),
  };
}

/**
 * Combines multiple sprites' Matter.js / Phaser 3 fixture sets into a single atlas physics manifest.
 */
export function exportCombinedAtlasPhysicsJson(
  entries: ReadonlyArray<{
    readonly slug: string;
    readonly shapes: readonly CollisionLayerShape[];
  }>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    generator_info: 'Nibgrid v1.0',
  };
  for (const entry of entries) {
    if (entry.shapes.length === 0) continue;
    out[entry.slug] = buildMatterBody(entry.slug, entry.shapes);
  }
  return out;
}
