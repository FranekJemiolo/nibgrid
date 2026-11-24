export type GdUniformType = 'float' | 'int' | 'vec2' | 'vec3' | 'vec4' | 'bool';

export interface GdShaderUniform {
  name: string;
  type: GdUniformType;
  defaultValue: number | number[] | boolean;
  min?: number;
  max?: number;
  step?: number;
  isColor: boolean;
  hintRaw?: string;
}

export interface TranspiledShaderResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  uniforms: GdShaderUniform[];
  vertexGlsl: string;
  fragmentGlsl: string;
  cleanedSource: string;
}

const VALID_UNIFORM_TYPES = new Set<GdUniformType>([
  'float',
  'int',
  'vec2',
  'vec3',
  'vec4',
  'bool',
]);

/**
 * Removes surrounding Markdown code fences (e.g., ```gdshader or ```) emitted by LLMs.
 */
export function stripShaderCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fencedMatch = trimmed.match(/^```(?:gdshader|glsl|shader|txt)?\s*\n([\s\S]*?)\n```$/i);
  if (fencedMatch && fencedMatch[1] !== undefined) {
    return fencedMatch[1].trim();
  }
  return trimmed
    .replace(/^```(?:gdshader|glsl|shader|txt)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
}

function stripCommentsPreserveLines(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

function defaultForType(type: GdUniformType, isColor: boolean): number | number[] | boolean {
  switch (type) {
    case 'float':
      return 0;
    case 'int':
      return 0;
    case 'bool':
      return false;
    case 'vec2':
      return [0, 0];
    case 'vec3':
      return isColor ? [1, 1, 1] : [0, 0, 0];
    case 'vec4':
      return isColor ? [1, 1, 1, 1] : [0, 0, 0, 1];
  }
}

function parseVectorNumbers(expr: string, expectedLen: number): number[] | null {
  const match = expr.match(new RegExp(`^vec${expectedLen}\\s*\\(([^)]*)\\)$`, 'i'));
  if (!match || match[1] === undefined) {
    const singleNum = Number(expr.trim());
    if (Number.isFinite(singleNum)) {
      return Array.from({ length: expectedLen }, () => singleNum);
    }
    return null;
  }
  const parts = match[1]
    .split(',')
    .map((p) => Number(p.trim()))
    .filter((n) => Number.isFinite(n));
  if (parts.length === 1 && expectedLen > 1) {
    return Array.from({ length: expectedLen }, () => parts[0] ?? 0);
  }
  if (parts.length !== expectedLen) {
    return null;
  }
  return parts;
}

function parseUniformDefault(
  type: GdUniformType,
  rawExpr: string | undefined,
  isColor: boolean,
): number | number[] | boolean {
  if (!rawExpr) {
    return defaultForType(type, isColor);
  }
  const cleaned = rawExpr.trim();
  if (type === 'float') {
    const val = Number(cleaned);
    return Number.isFinite(val) ? val : 0;
  }
  if (type === 'int') {
    const val = Number.parseInt(cleaned, 10);
    return Number.isFinite(val) ? val : 0;
  }
  if (type === 'bool') {
    return cleaned.toLowerCase() === 'true';
  }
  if (type === 'vec2') {
    return parseVectorNumbers(cleaned, 2) ?? defaultForType('vec2', isColor);
  }
  if (type === 'vec3') {
    return parseVectorNumbers(cleaned, 3) ?? defaultForType('vec3', isColor);
  }
  return parseVectorNumbers(cleaned, 4) ?? defaultForType('vec4', isColor);
}

/**
 * Extracts typed Godot 4 `uniform` declarations and range/color hints from `.gdshader` source.
 */
export function parseGdShaderUniforms(cleanedSource: string): {
  uniforms: GdShaderUniform[];
  errors: string[];
  warnings: string[];
} {
  const sourceNoComments = stripCommentsPreserveLines(cleanedSource);
  const uniforms: GdShaderUniform[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (/\bhint_color\b/.test(sourceNoComments)) {
    errors.push('Godot 3 "hint_color" is not valid in Godot 4.3+; replace it with "source_color".');
  }

  const uniformRegex =
    /(?:^|\n)\s*(?:instance\s+)?uniform\s+(float|int|vec2|vec3|vec4|bool|sampler2D)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*([^=;]+?))?(?:\s*=\s*([^;]+?))?\s*;/g;

  for (const match of sourceNoComments.matchAll(uniformRegex)) {
    const rawType = match[1];
    const name = match[2];
    const hintRaw = match[3]?.trim();
    const defaultRaw = match[4]?.trim();

    if (!rawType || !name) {
      continue;
    }

    if (rawType === 'sampler2D') {
      warnings.push(
        `Extra sampler2D uniform "${name}" is exported in .gdshader but only the primary sprite TEXTURE is bound in the live WebGL2 preview.`,
      );
      continue;
    }

    if (!VALID_UNIFORM_TYPES.has(rawType as GdUniformType)) {
      continue;
    }

    const type = rawType as GdUniformType;
    const isColor = Boolean(hintRaw && /\bsource_color\b/.test(hintRaw));

    let min: number | undefined;
    let max: number | undefined;
    let step: number | undefined;

    if (hintRaw) {
      const rangeMatch = hintRaw.match(
        /hint_range\s*\(\s*([-+]?\d*\.?\d+)\s*,\s*([-+]?\d*\.?\d+)(?:\s*,\s*([-+]?\d*\.?\d+))?\s*\)/,
      );
      if (rangeMatch) {
        const parsedMin = Number(rangeMatch[1]);
        const parsedMax = Number(rangeMatch[2]);
        const parsedStep = rangeMatch[3] !== undefined ? Number(rangeMatch[3]) : undefined;
        if (Number.isFinite(parsedMin) && Number.isFinite(parsedMax)) {
          min = parsedMin;
          max = parsedMax;
        }
        if (parsedStep !== undefined && Number.isFinite(parsedStep) && parsedStep > 0) {
          step = parsedStep;
        }
      }
    }

    if (type === 'float' && min === undefined && max === undefined) {
      min = 0;
      max = 2;
      step = 0.01;
    } else if (type === 'int' && min === undefined && max === undefined) {
      min = 0;
      max = 16;
      step = 1;
    }

    const defaultValue = parseUniformDefault(type, defaultRaw, isColor);
    uniforms.push({
      name,
      type,
      defaultValue,
      ...(min !== undefined ? { min } : {}),
      ...(max !== undefined ? { max } : {}),
      ...(step !== undefined ? { step } : {}),
      isColor,
      ...(hintRaw ? { hintRaw } : {}),
    });
  }

  return { uniforms, errors, warnings };
}

interface ExtractedFunction {
  name: string;
  body: string;
  fullText: string;
}

function findMatchingBrace(source: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function extractFunction(source: string, returnTypeAndNameRegex: RegExp): ExtractedFunction | null {
  const match = returnTypeAndNameRegex.exec(source);
  if (!match || match.index === undefined) {
    return null;
  }
  const openBraceIndex = source.indexOf('{', match.index + match[0].length - 1);
  if (openBraceIndex < 0) {
    return null;
  }
  const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
  if (closeBraceIndex < 0) {
    return null;
  }
  return {
    name: match[1] ?? '',
    body: source.slice(openBraceIndex + 1, closeBraceIndex).trim(),
    fullText: source.slice(match.index, closeBraceIndex + 1),
  };
}

function mapBuiltinsToGlsl(snippet: string): string {
  return snippet
    .replace(/\bTEXTURE_PIXEL_SIZE\b/g, 'nb_tex_pixel_size')
    .replace(/\bTEXTURE\b/g, 'u_texture')
    .replace(/\bSCREEN_TEXTURE\b/g, 'u_texture')
    .replace(/\bSCREEN_PIXEL_SIZE\b/g, 'nb_tex_pixel_size')
    .replace(/\bUV\b/g, 'nb_uv')
    .replace(/\bFRAGCOORD\b/g, 'gl_FragCoord')
    .replace(/\bPI\b/g, '3.14159265359')
    .replace(/\bTAU\b/g, '6.28318530718');
}

function formatUniformDeclaration(uniform: GdShaderUniform): string {
  return `uniform ${uniform.type} ${uniform.name};`;
}

/**
 * Validates and transpiles a Godot 4 `shader_type canvas_item;` shader into paired
 * WebGL2 `#version 300 es` vertex + fragment shaders for live preview.
 */
export function transpileGdShaderToWebGL2(rawSource: string): TranspiledShaderResult {
  const cleanedSource = stripShaderCodeFences(rawSource);
  const sourceNoComments = stripCommentsPreserveLines(cleanedSource);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!cleanedSource) {
    errors.push('Shader source is empty.');
  }

  const shaderTypeMatch = sourceNoComments.match(/\bshader_type\s+([a-zA-Z0-9_]+)\s*;/);
  if (!shaderTypeMatch) {
    errors.push('Missing required "shader_type canvas_item;" header.');
  } else if (shaderTypeMatch[1] !== 'canvas_item') {
    errors.push(
      `Unsupported shader_type "${shaderTypeMatch[1]}"; Shader Studio only supports "shader_type canvas_item;".`,
    );
  }

  const parsedUniforms = parseGdShaderUniforms(cleanedSource);
  errors.push(...parsedUniforms.errors);
  warnings.push(...parsedUniforms.warnings);

  const fragmentFn = extractFunction(sourceNoComments, /\bvoid\s+(fragment)\s*\(\s*\)\s*\{/);
  if (!fragmentFn) {
    errors.push('Missing required "void fragment()" function.');
  }

  const vertexFn = extractFunction(sourceNoComments, /\bvoid\s+(vertex)\s*\(\s*\)\s*\{/);

  // Extract custom helper functions (anything other than vertex() / fragment())
  let remainder = sourceNoComments
    .replace(/\bshader_type\s+[a-zA-Z0-9_]+\s*;/g, '')
    .replace(/\brender_mode\s+[^;]+;/g, '')
    .replace(
      /(?:^|\n)\s*(?:instance\s+)?uniform\s+[A-Za-z0-9_]+\s+[A-Za-z_][A-Za-z0-9_]*[^;]*;/g,
      '',
    );

  if (vertexFn) {
    remainder = remainder.replace(vertexFn.fullText, '');
  }
  if (fragmentFn) {
    remainder = remainder.replace(fragmentFn.fullText, '');
  }

  // Convert remaining const/function definitions with built-in mappings
  const helperBlock = mapBuiltinsToGlsl(remainder.trim());
  const uniformDecls = parsedUniforms.uniforms.map(formatUniformDeclaration).join('\n');

  const vertexBodyGlsl = vertexFn
    ? mapBuiltinsToGlsl(vertexFn.body)
    : '// default canvas_item vertex pass-through';

  const fragmentBodyGlsl = fragmentFn
    ? mapBuiltinsToGlsl(fragmentFn.body)
    : '// empty fragment body';

  const vertexGlsl = `#version 300 es
precision highp float;

layout(location = 0) in vec2 a_pos;
layout(location = 1) in vec2 a_uv;

uniform float TIME;
uniform vec2 u_tex_size;
${uniformDecls}

out vec2 v_uv;

${helperBlock ? `${helperBlock}\n` : ''}
void main() {
  vec2 nb_uv = a_uv;
  vec2 nb_tex_pixel_size = 1.0 / max(u_tex_size, vec2(1.0));
  vec2 VERTEX = (a_pos * 0.5 + 0.5) * max(u_tex_size, vec2(1.0));
  ${vertexBodyGlsl}
  v_uv = nb_uv;
  vec2 clip = (VERTEX / max(u_tex_size, vec2(1.0))) * 2.0 - 1.0;
  gl_Position = vec4(clip, 0.0, 1.0);
}
`.trim();

  const fragmentGlsl = `#version 300 es
precision highp float;

in vec2 v_uv;

uniform sampler2D u_texture;
uniform float TIME;
uniform vec2 u_tex_size;
${uniformDecls}

out vec4 outColor;

${helperBlock ? `${helperBlock}\n` : ''}
void main() {
  vec2 nb_uv = v_uv;
  vec2 nb_tex_pixel_size = 1.0 / max(u_tex_size, vec2(1.0));
  vec4 COLOR = texture(u_texture, nb_uv);
  ${fragmentBodyGlsl}
  outColor = COLOR;
}
`.trim();

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    uniforms: parsedUniforms.uniforms,
    vertexGlsl,
    fragmentGlsl,
    cleanedSource,
  };
}
