import { parseGdShaderUniforms, type GdShaderUniform } from './gdshaderTranspiler';

export type GdShaderPresetId =
  'hit_flash' | 'wind_sway' | 'metallic_sheen' | 'pixel_outline' | 'water_ripple';

export interface GdShaderPreset {
  id: GdShaderPresetId;
  label: string;
  description: string;
  source: string;
}

export const GDSHADER_PRESETS: readonly GdShaderPreset[] = [
  {
    id: 'hit_flash',
    label: 'Hit Flash',
    description: 'Additive impact flash preserving sprite alpha for damage frames.',
    source: `shader_type canvas_item;

uniform vec4 flash_color : source_color = vec4(1.0, 0.96, 0.85, 1.0);
uniform float flash_amount : hint_range(0.0, 1.0, 0.01) = 0.75;

void fragment() {
  vec4 base_tex = texture(TEXTURE, UV);
  vec3 flashed = mix(base_tex.rgb, flash_color.rgb, clamp(flash_amount, 0.0, 1.0));
  COLOR = vec4(flashed, base_tex.a * flash_color.a);
}`,
  },
  {
    id: 'wind_sway',
    label: 'Wind Sway',
    description: 'Root-anchored vertex sway for pixel foliage, banners, and cloaks.',
    source: `shader_type canvas_item;

uniform float speed : hint_range(0.0, 10.0, 0.1) = 2.5;
uniform float strength : hint_range(0.0, 12.0, 0.25) = 3.0;
uniform float min_height : hint_range(0.0, 1.0, 0.05) = 0.15;

void vertex() {
  float anchor = clamp((1.0 - UV.y) - min_height, 0.0, 1.0);
  VERTEX.x += sin(TIME * speed + UV.y * 3.14) * strength * anchor;
}

void fragment() {
  COLOR = texture(TEXTURE, UV);
}`,
  },
  {
    id: 'metallic_sheen',
    label: 'Metallic Sheen',
    description: 'Diagonal specular glint sweep across armor, blades, and loot.',
    source: `shader_type canvas_item;

uniform vec4 shine_color : source_color = vec4(1.0, 0.98, 0.88, 1.0);
uniform float shine_speed : hint_range(0.0, 6.0, 0.1) = 1.6;
uniform float shine_width : hint_range(0.02, 0.5, 0.01) = 0.14;
uniform float shine_angle : hint_range(-3.14, 3.14, 0.05) = 0.6;

void fragment() {
  vec4 base_tex = texture(TEXTURE, UV);
  float sweep = fract(TIME * shine_speed * 0.35) * 2.4 - 0.7;
  float proj = (UV.x - 0.5) * cos(shine_angle) + (UV.y - 0.5) * sin(shine_angle);
  float band = smoothstep(shine_width, 0.0, abs(proj - sweep));
  COLOR = vec4(mix(base_tex.rgb, shine_color.rgb, band * 0.7), base_tex.a);
}`,
  },
  {
    id: 'pixel_outline',
    label: 'Pixel Outline',
    description: 'Crisp 4-neighbor pixel-art outline with optional pulse.',
    source: `shader_type canvas_item;

uniform vec4 outline_color : source_color = vec4(0.12, 0.09, 0.18, 1.0);
uniform float outline_thickness : hint_range(0.0, 4.0, 1.0) = 1.0;
uniform float pulse_speed : hint_range(0.0, 8.0, 0.1) = 0.0;

void fragment() {
  vec4 base_tex = texture(TEXTURE, UV);
  vec2 step_uv = TEXTURE_PIXEL_SIZE * outline_thickness;
  float n_up = texture(TEXTURE, UV + vec2(0.0, -step_uv.y)).a;
  float n_down = texture(TEXTURE, UV + vec2(0.0, step_uv.y)).a;
  float n_left = texture(TEXTURE, UV + vec2(-step_uv.x, 0.0)).a;
  float n_right = texture(TEXTURE, UV + vec2(step_uv.x, 0.0)).a;
  float neighbor_alpha = max(max(n_up, n_down), max(n_left, n_right));
  float pulse = 0.75 + 0.25 * cos(TIME * pulse_speed);
  float edge_mask = neighbor_alpha * (1.0 - step(0.1, base_tex.a));
  vec4 edge_col = vec4(outline_color.rgb, outline_color.a * pulse);
  COLOR = mix(base_tex, edge_col, edge_mask);
}`,
  },
  {
    id: 'water_ripple',
    label: 'Water Ripple',
    description: 'Horizontal sine-wave UV distortion with aquatic depth tint.',
    source: `shader_type canvas_item;

uniform vec4 tint_color : source_color = vec4(0.45, 0.85, 1.0, 1.0);
uniform float wave_speed : hint_range(0.0, 8.0, 0.1) = 2.4;
uniform float wave_amplitude : hint_range(0.0, 0.08, 0.002) = 0.015;
uniform float wave_frequency : hint_range(1.0, 40.0, 1.0) = 14.0;

void fragment() {
  vec2 rippled_uv = UV;
  rippled_uv.x += sin(UV.y * wave_frequency + TIME * wave_speed) * wave_amplitude;
  vec4 base_tex = texture(TEXTURE, rippled_uv);
  COLOR = vec4(mix(base_tex.rgb, base_tex.rgb * tint_color.rgb, 0.35), base_tex.a);
}`,
  },
];

export function getGdShaderPreset(id: string): GdShaderPreset {
  return GDSHADER_PRESETS.find((preset) => preset.id === id) ?? GDSHADER_PRESETS[0]!;
}

export function extractDefaultUniformValues(
  source: string,
): Record<string, number | number[] | boolean> {
  const { uniforms } = parseGdShaderUniforms(source);
  return defaultUniformRecordFromList(uniforms);
}

export function defaultUniformRecordFromList(
  uniforms: readonly GdShaderUniform[],
): Record<string, number | number[] | boolean> {
  const record: Record<string, number | number[] | boolean> = {};
  for (const uniform of uniforms) {
    record[uniform.name] = Array.isArray(uniform.defaultValue)
      ? [...uniform.defaultValue]
      : uniform.defaultValue;
  }
  return record;
}
