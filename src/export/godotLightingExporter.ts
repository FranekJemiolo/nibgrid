import { extractCollisionHull, type Vec2 } from '../processing/collisionHull';

export type GodotLightingArtMode = 'pixel-art' | 'hd-handdrawn' | 'hd-2d';

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function sanitizeGodotId(raw: string, fallback = 'occluder_poly'): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

function roundFinite(n: number, decimals = 2): number {
  if (!Number.isFinite(n)) return 0;
  const rounded = Number(n.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Extracts simplified RDP `OccluderPolygon2D` hull vertices from an RGBA silhouette
 * (reusing M16's Marching Squares + RDP hull pipeline).
 */
export function extractLightOccluderVertices(opts: {
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly epsilon?: number;
  readonly pivotPx?: Vec2;
}): readonly Vec2[] {
  const { width, height, rgba } = opts;
  const pivot = opts.pivotPx ?? { x: width * 0.5, y: height * 0.5 };
  const hull = extractCollisionHull(
    { width, height, data: rgba },
    {
      kind: 'polygon',
      epsilonPx: opts.epsilon ?? 1.5,
      alphaThreshold: 128,
      pivotPx: pivot,
    },
  );

  if (hull.vertices.length >= 3) {
    return hull.vertices.map((pt) => ({
      x: roundFinite(pt.x, 2),
      y: roundFinite(pt.y, 2),
    }));
  }

  // Fallback closed bounds around pivot so empty/tiny sprites remain valid in Godot
  const hw = roundFinite(Math.max(1, width * 0.5), 2);
  const hh = roundFinite(Math.max(1, height * 0.5), 2);
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ];
}

/**
 * Serializes a Godot 4 `format=3` `CanvasTexture` `.tres` resource binding diffuse,
 * normal (`_n.png`), and optional specular textures with deterministic filtering.
 */
export function exportCanvasTextureTres(opts: {
  readonly diffuseResPath: string;
  readonly normalResPath: string;
  readonly specularResPath?: string;
  readonly artMode: GodotLightingArtMode;
}): string {
  const extLines = [
    `[ext_resource type="Texture2D" path="${escapeGodotString(opts.diffuseResPath)}" id="1_diff"]`,
    `[ext_resource type="Texture2D" path="${escapeGodotString(opts.normalResPath)}" id="2_norm"]`,
  ];
  if (opts.specularResPath) {
    extLines.push(
      `[ext_resource type="Texture2D" path="${escapeGodotString(opts.specularResPath)}" id="3_spec"]`,
    );
  }

  const loadSteps = extLines.length + 1;
  const textureFilter = opts.artMode === 'pixel-art' ? 1 : 2;

  return [
    `[gd_resource type="CanvasTexture" load_steps=${loadSteps} format=3]`,
    '',
    ...extLines,
    '',
    '[resource]',
    'diffuse_texture = ExtResource("1_diff")',
    'normal_texture = ExtResource("2_norm")',
    ...(opts.specularResPath ? ['specular_texture = ExtResource("3_spec")'] : []),
    `texture_filter = ${textureFilter}`,
    '',
  ].join('\n');
}

/**
 * Serializes a Godot 4 `.png.import` sidecar configured specifically for tangent-space
 * normal maps (`compress/normal_map=1`) without sRGB gamma distortion.
 */
export function exportNormalMapImportFile(opts: {
  readonly resPath: string;
  readonly artMode: GodotLightingArtMode;
}): string {
  const isPixelArt = opts.artMode === 'pixel-art';
  return [
    '[remap]',
    'importer="texture"',
    'type="CompressedTexture2D"',
    '',
    '[deps]',
    `source_file="${escapeGodotString(opts.resPath)}"`,
    '',
    '[params]',
    `compress/mode=${isPixelArt ? 0 : 2}`,
    'compress/high_quality=false',
    'compress/normal_map=1',
    `mipmaps/generate=${isPixelArt ? 'false' : 'true'}`,
    'process/fix_alpha_border=true',
    'process/premult_alpha=false',
    '',
  ].join('\n');
}

/**
 * Emits a Godot 4 `[sub_resource type="OccluderPolygon2D"]` block with `cull_mode = 0`
 * and closed `PackedVector2Array(...)` coordinates derived from M16's RDP hull extractor.
 */
export function exportLightOccluderSubResource(opts: {
  readonly id: string;
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly epsilon?: number;
  readonly pivotPx?: Vec2;
}): string {
  const vertices = extractLightOccluderVertices(opts);
  const packedNums = vertices.flatMap((v) => [String(roundFinite(v.x)), String(roundFinite(v.y))]);
  return [
    `[sub_resource type="OccluderPolygon2D" id="${sanitizeGodotId(opts.id)}"]`,
    'closed = true',
    'cull_mode = 0',
    `polygon = PackedVector2Array(${packedNums.join(', ')})`,
    '',
  ].join('\n');
}

/**
 * Emits an optional Godot 4 CanvasItem `.gdshader` mixing additive `_e.png` emission glow.
 */
export function exportEmissionOverlayShader(glowStrength = 1.6): string {
  const clampedGlow = roundFinite(Math.max(0.1, Math.min(8, glowStrength)), 2);
  return [
    'shader_type canvas_item;',
    '',
    'uniform sampler2D emission_texture : source_color, filter_nearest;',
    `uniform float emission_strength : hint_range(0.0, 8.0) = ${clampedGlow};`,
    '',
    'void fragment() {',
    '  vec4 base_col = texture(TEXTURE, UV);',
    '  vec4 glow_col = texture(emission_texture, UV);',
    '  COLOR = vec4(base_col.rgb + glow_col.rgb * glow_col.a * emission_strength, base_col.a);',
    '}',
    '',
  ].join('\n');
}
