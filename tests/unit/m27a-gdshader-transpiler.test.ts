import { describe, expect, it } from 'vitest';
import { GDSHADER_PRESETS, getGdShaderPreset } from '../../src/processing/gdshaderPresets';
import {
  stripShaderCodeFences,
  transpileGdShaderToWebGL2,
} from '../../src/processing/gdshaderTranspiler';
import { createDefaultShaderConfig, ShaderConfigSchema } from '../../src/domain/schemas';

describe('M27A Godot 4 canvas_item .gdshader transpiler & presets', () => {
  it('transpiles all 5 offline presets to #version 300 es without errors', () => {
    expect(GDSHADER_PRESETS).toHaveLength(5);

    for (const preset of GDSHADER_PRESETS) {
      const result = transpileGdShaderToWebGL2(preset.source);
      expect(result.ok, `Preset ${preset.id} errors: ${result.errors.join('; ')}`).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.vertexGlsl).toContain('#version 300 es');
      expect(result.fragmentGlsl).toContain('#version 300 es');
      expect(result.fragmentGlsl).toContain('outColor = COLOR;');
      expect(result.uniforms.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('extracts typed bounds, step, and source_color metadata for hit_flash and wind_sway', () => {
    const hitFlash = transpileGdShaderToWebGL2(getGdShaderPreset('hit_flash').source);
    expect(hitFlash.ok).toBe(true);

    const flashColor = hitFlash.uniforms.find((u) => u.name === 'flash_color');
    expect(flashColor).toBeDefined();
    expect(flashColor?.type).toBe('vec4');
    expect(flashColor?.isColor).toBe(true);
    expect(flashColor?.defaultValue).toEqual([1, 0.96, 0.85, 1]);

    const flashAmount = hitFlash.uniforms.find((u) => u.name === 'flash_amount');
    expect(flashAmount).toBeDefined();
    expect(flashAmount?.type).toBe('float');
    expect(flashAmount?.min).toBe(0);
    expect(flashAmount?.max).toBe(1);
    expect(flashAmount?.step).toBe(0.01);
    expect(flashAmount?.defaultValue).toBe(0.75);

    const windSway = transpileGdShaderToWebGL2(getGdShaderPreset('wind_sway').source);
    expect(windSway.ok).toBe(true);
    expect(windSway.vertexGlsl).toContain('VERTEX.x +=');
    const speed = windSway.uniforms.find((u) => u.name === 'speed');
    expect(speed?.min).toBe(0);
    expect(speed?.max).toBe(10);
    expect(speed?.step).toBe(0.1);
  });

  it('strips markdown code fences before transpiling', () => {
    const fenced = [
      '```gdshader',
      'shader_type canvas_item;',
      'uniform float amount : hint_range(0.0, 1.0, 0.1) = 0.5;',
      'void fragment() {',
      '  COLOR = texture(TEXTURE, UV) * amount;',
      '}',
      '```',
    ].join('\n');

    const stripped = stripShaderCodeFences(fenced);
    expect(stripped.startsWith('shader_type canvas_item;')).toBe(true);
    expect(stripped.endsWith('```')).toBe(false);

    const result = transpileGdShaderToWebGL2(fenced);
    expect(result.ok).toBe(true);
    expect(result.uniforms).toHaveLength(1);
    expect(result.uniforms[0]?.name).toBe('amount');
  });

  it('rejects shaders missing shader_type canvas_item, missing fragment(), or using Godot 3 hint_color', () => {
    const missingHeader = transpileGdShaderToWebGL2(
      'uniform float x = 1.0;\nvoid fragment() { COLOR = texture(TEXTURE, UV); }',
    );
    expect(missingHeader.ok).toBe(false);
    expect(missingHeader.errors.some((e) => e.includes('shader_type canvas_item'))).toBe(true);

    const missingFragment = transpileGdShaderToWebGL2(
      'shader_type canvas_item;\nvoid vertex() { VERTEX.x += 1.0; }',
    );
    expect(missingFragment.ok).toBe(false);
    expect(missingFragment.errors.some((e) => e.includes('void fragment()'))).toBe(true);

    const godot3HintColor = transpileGdShaderToWebGL2(
      'shader_type canvas_item;\nuniform vec4 tint : hint_color = vec4(1.0);\nvoid fragment() { COLOR = texture(TEXTURE, UV) * tint; }',
    );
    expect(godot3HintColor.ok).toBe(false);
    expect(godot3HintColor.errors.some((e) => e.includes('hint_color'))).toBe(true);
  });

  it('builds and validates ShaderConfigSchema via createDefaultShaderConfig', () => {
    const cfg = createDefaultShaderConfig();
    const parsed = ShaderConfigSchema.parse(cfg);
    expect(parsed.presetId).toBe('hit_flash');
    expect(parsed.gdshaderSource).toContain('shader_type canvas_item;');
    expect(parsed.uniformValues.flash_amount).toBe(0.75);
  });
});
