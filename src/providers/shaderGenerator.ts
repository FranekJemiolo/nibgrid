import type { ArtBible, ProviderConfig, ProviderKind } from '../domain/schemas';
import { getGdShaderPreset, type GdShaderPresetId } from '../processing/gdshaderPresets';
import {
  stripShaderCodeFences,
  transpileGdShaderToWebGL2,
  type TranspiledShaderResult,
} from '../processing/gdshaderTranspiler';
import { classifyProviderError, ProviderError } from './errors';
import { resolveGeminiBaseUrl, type GeminiGenerateContentResponse } from './geminiProvider';
import { resolveParallaxTextModelId } from './parallaxGenerator';

export interface ShaderCostEstimate {
  readonly estimatedUsd: number;
  readonly label: string;
}

export interface GenerateGdShaderInput {
  readonly prompt: string;
  readonly artBible: ArtBible;
  readonly providerConfig: ProviderConfig;
  readonly signal?: AbortSignal;
}

export interface GeneratedShaderOutcome {
  readonly gdshaderSource: string;
  readonly transpiled: TranspiledShaderResult;
  readonly usedPresetFallback: boolean;
  readonly presetId?: GdShaderPresetId;
  readonly providerLabel: string;
  readonly costEstimate: ShaderCostEstimate;
}

export function estimateShaderGenerationCost(kind: ProviderKind): ShaderCostEstimate {
  switch (kind) {
    case 'mock':
      return { estimatedUsd: 0, label: '$0.00 (Offline)' };
    case 'antigravity-bridge':
      return { estimatedUsd: 0, label: '$0.00 (Bridge)' };
    case 'gemini':
      return { estimatedUsd: 0.001, label: '~$0.001 (Gemini Flash)' };
    default:
      return { estimatedUsd: 0.001, label: '~$0.001' };
  }
}

export function matchPresetForShaderPrompt(prompt: string): GdShaderPresetId {
  const normalized = prompt.toLowerCase();
  if (/\b(wind|sway|foliage|leaf|leaves|grass|cape|cloak|banner|tree)\b/.test(normalized)) {
    return 'wind_sway';
  }
  if (/\b(metal|metallic|sheen|shine|glint|armor|sword|blade|gold|chrome)\b/.test(normalized)) {
    return 'metallic_sheen';
  }
  if (/\b(outline|border|contour|rim|stroke)\b/.test(normalized)) {
    return 'pixel_outline';
  }
  if (/\b(water|ripple|wave|pond|river|ocean|liquid|caustic)\b/.test(normalized)) {
    return 'water_ripple';
  }
  return 'hit_flash';
}

function buildShaderSystemPrompt(userPrompt: string, artBible: ArtBible): string {
  const paletteHint =
    artBible.palette.length > 0 ? artBible.palette.join(', ') : '#FFCD75, #1A1C2C';
  return [
    'Generate a clean, production-ready Godot 4.3+ 2D canvas_item shader (`.gdshader`).',
    `EFFECT REQUEST: ${userPrompt.trim()}`,
    `ART DIRECTION: artMode=${artBible.artMode}, lighting=${artBible.lighting}, palette=[${paletteHint}].`,
    'STRICT GODOT 4.3+ RULES:',
    '- First line MUST be `shader_type canvas_item;`',
    '- Declare adjustable parameters as `uniform` with Godot 4 hints: `hint_range(min, max, step)` on float/int or `source_color` on color vec4/vec3 (NEVER Godot 3 `hint_color`).',
    '- Assign sensible defaults matching the Art Bible palette where appropriate.',
    '- Implement `void fragment()` (and optional `void vertex()` if vertex deformation is needed) using standard Godot 4 built-ins (`TEXTURE`, `TEXTURE_PIXEL_SIZE`, `UV`, `TIME`, `VERTEX`, `COLOR`).',
    '- Do NOT use deprecated Godot 3 keywords (`hint_color`, `varying` without type, or spatial built-ins).',
    '- Return ONLY raw `.gdshader` source code without extra prose.',
  ].join('\n');
}

function buildOfflineOutcome(
  prompt: string,
  providerLabel: string,
  usedPresetFallback: boolean,
  costEstimate: ShaderCostEstimate,
): GeneratedShaderOutcome {
  const presetId = matchPresetForShaderPrompt(prompt);
  const preset = getGdShaderPreset(presetId);
  const transpiled = transpileGdShaderToWebGL2(preset.source);
  return {
    gdshaderSource: preset.source,
    transpiled,
    usedPresetFallback,
    presetId,
    providerLabel,
    costEstimate,
  };
}

/**
 * Generates and transpiles a Godot 4 `canvas_item` `.gdshader` via Gemini BYOK,
 * Antigravity Bridge, or deterministic offline preset matching.
 */
export async function generateGdShader(
  input: GenerateGdShaderInput,
): Promise<GeneratedShaderOutcome> {
  const { prompt, artBible, providerConfig, signal } = input;
  const trimmedPrompt = prompt.trim() || 'hit flash';
  const costEstimate = estimateShaderGenerationCost(providerConfig.kind);

  if (providerConfig.kind === 'mock' || providerConfig.kind === 'comfyui') {
    return buildOfflineOutcome(
      trimmedPrompt,
      providerConfig.kind === 'mock' ? 'Offline Preset Matcher' : 'Preset Fallback',
      false,
      costEstimate,
    );
  }

  if (providerConfig.kind === 'antigravity-bridge') {
    return buildOfflineOutcome(trimmedPrompt, 'Antigravity Bridge Preset', false, costEstimate);
  }

  // Gemini Flash BYOK
  if (!providerConfig.apiKey.trim()) {
    return buildOfflineOutcome(trimmedPrompt, 'Offline Preset Matcher (No API Key)', true, {
      estimatedUsd: 0,
      label: '$0.00 (Offline)',
    });
  }

  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const textModel = resolveParallaxTextModelId(providerConfig.modelId);
  const url = `${baseUrl}/models/${encodeURIComponent(textModel)}:generateContent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': providerConfig.apiKey.trim(),
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: buildShaderSystemPrompt(trimmedPrompt, artBible) }],
          },
        ],
        generationConfig: {
          temperature: 0.2,
        },
      }),
      signal,
    });

    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      throw { status: res.status, responseText };
    }

    const json = (await res.json()) as GeminiGenerateContentResponse;
    const rawText =
      json.candidates?.[0]?.content?.parts
        ?.map((part) => part.text ?? '')
        .join('\n')
        .trim() ?? '';

    const cleaned = stripShaderCodeFences(rawText);
    const transpiled = transpileGdShaderToWebGL2(cleaned);

    return {
      gdshaderSource: cleaned,
      transpiled,
      usedPresetFallback: false,
      providerLabel: `Gemini (${textModel})`,
      costEstimate,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof ProviderError) throw err;
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: providerConfig.endpointUrl,
      secrets: [providerConfig.apiKey],
    });
  }
}
