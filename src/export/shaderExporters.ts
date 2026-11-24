import { strToU8, zipSync } from 'fflate';
import type { ShaderConfig, ShaderUniformValue } from '../domain/schemas';
import {
  parseGdShaderUniforms,
  stripShaderCodeFences,
  type GdShaderUniform,
} from '../processing/gdshaderTranspiler';
import type { AssetRecipe } from './recipeBuilder';

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatFloat(value: number): string {
  if (!Number.isFinite(value)) return '0.0';
  const rounded = Number(value.toFixed(4));
  const clean = Object.is(rounded, -0) ? 0 : rounded;
  return Number.isInteger(clean) ? `${clean}.0` : String(clean);
}

function formatGodotUniformValue(
  uniform: GdShaderUniform,
  value: ShaderUniformValue | undefined,
): string | null {
  const effective = value ?? uniform.defaultValue;
  switch (uniform.type) {
    case 'bool':
      return effective ? 'true' : 'false';
    case 'int': {
      const n = typeof effective === 'number' ? effective : Number(effective);
      return String(Number.isFinite(n) ? Math.round(n) : 0);
    }
    case 'float': {
      const n = typeof effective === 'number' ? effective : Number(effective);
      return formatFloat(Number.isFinite(n) ? n : 0);
    }
    case 'vec2': {
      const arr = Array.isArray(effective) ? effective : [0, 0];
      return `Vector2(${formatFloat(arr[0] ?? 0)}, ${formatFloat(arr[1] ?? 0)})`;
    }
    case 'vec3': {
      const arr = Array.isArray(effective) ? effective : [0, 0, 0];
      if (uniform.isColor) {
        return `Color(${formatFloat(arr[0] ?? 0)}, ${formatFloat(arr[1] ?? 0)}, ${formatFloat(arr[2] ?? 0)}, 1.0)`;
      }
      return `Vector3(${formatFloat(arr[0] ?? 0)}, ${formatFloat(arr[1] ?? 0)}, ${formatFloat(arr[2] ?? 0)})`;
    }
    case 'vec4': {
      const arr = Array.isArray(effective) ? effective : [1, 1, 1, 1];
      if (uniform.isColor) {
        return `Color(${formatFloat(arr[0] ?? 1)}, ${formatFloat(arr[1] ?? 1)}, ${formatFloat(arr[2] ?? 1)}, ${formatFloat(arr[3] ?? 1)})`;
      }
      return `Vector4(${formatFloat(arr[0] ?? 0)}, ${formatFloat(arr[1] ?? 0)}, ${formatFloat(arr[2] ?? 0)}, ${formatFloat(arr[3] ?? 1)})`;
    }
  }
}

/**
 * Generates a Godot 4.3+ `ShaderMaterial` `.tres` resource referencing a `.gdshader` file
 * and serializing current uniform values (including `Color(...)` for `source_color`).
 */
export function exportGodotShaderMaterialTres(
  shaderResPath: string,
  shaderSource: string,
  uniformValues: Record<string, ShaderUniformValue>,
): string {
  const cleanedSource = stripShaderCodeFences(shaderSource);
  const { uniforms } = parseGdShaderUniforms(cleanedSource);
  const normalizedRes = shaderResPath.startsWith('res://')
    ? shaderResPath
    : `res://${shaderResPath.replace(/^\/+/, '')}`;

  const paramLines: string[] = [];
  for (const uniform of uniforms) {
    const formatted = formatGodotUniformValue(uniform, uniformValues[uniform.name]);
    if (formatted !== null) {
      paramLines.push(`shader_parameter/${uniform.name} = ${formatted}`);
    }
  }

  return (
    [
      '[gd_resource type="ShaderMaterial" load_steps=2 format=3]',
      '',
      `[ext_resource type="Shader" path="${escapeGodotString(normalizedRes)}" id="1_shader"]`,
      '',
      '[resource]',
      'shader = ExtResource("1_shader")',
      ...paramLines,
    ].join('\n') + '\n'
  );
}

/**
 * Emits `<slug>.gdshader` and `<slug>_mat.tres` bytes for ZIP bundling or project export.
 */
export function buildShaderExportFiles(
  slug: string,
  shaderConfig: ShaderConfig,
  options?: { readonly shaderResPath?: string },
): Record<string, Uint8Array> {
  const cleanedSource = stripShaderCodeFences(shaderConfig.gdshaderSource);
  const normalizedSource = cleanedSource.endsWith('\n') ? cleanedSource : `${cleanedSource}\n`;
  const shaderResPath = options?.shaderResPath ?? `res://${slug}.gdshader`;
  const matTres = exportGodotShaderMaterialTres(
    shaderResPath,
    normalizedSource,
    shaderConfig.uniformValues,
  );

  return {
    [`${slug}.gdshader`]: strToU8(normalizedSource),
    [`${slug}_mat.tres`]: strToU8(matTres),
  };
}

export interface PackageShaderZipInput {
  readonly slug: string;
  readonly shaderConfig: ShaderConfig;
  readonly recipe: AssetRecipe;
  readonly spritePngBytes?: Uint8Array;
}

/**
 * Packages `<slug>.gdshader`, `<slug>_mat.tres`, `<slug>.recipe.json`, and optional `<slug>.png`.
 */
export function packageShaderZip(input: PackageShaderZipInput): Uint8Array {
  const files: Record<string, Uint8Array> = {
    ...buildShaderExportFiles(input.slug, input.shaderConfig),
    [`${input.slug}.recipe.json`]: strToU8(`${JSON.stringify(input.recipe, null, 2)}\n`),
  };
  if (input.spritePngBytes) {
    files[`${input.slug}.png`] = input.spritePngBytes;
  }
  return zipSync(files, { level: 6 });
}
