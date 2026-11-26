import type { ArtBible, ProviderConfig, ProviderKind } from '../domain/schemas';
import {
  base64ToUint8,
  decodePngBytesToRgba,
  encodeRgbaToPngBytes,
  uint8ToBase64,
} from '../processing/png';
import {
  bakeProceduralUiKit,
  sliceUiStateSheet,
  type BakedUiKit,
  type UiKitStyleConfig,
} from '../processing/uiKitCore';
import { getBridgeSessionToken, resolveBridgeBaseUrl } from './antigravityBridgeProvider';
import { BridgeGenerateResponseSchema } from './bridgeContract';
import { classifyProviderError, ProviderError } from './errors';
import {
  extractImageBase64FromGeminiResponse,
  resolveGeminiBaseUrl,
  type GeminiGenerateContentPayload,
  type GeminiGenerateContentResponse,
} from './geminiProvider';

export interface UiKitCostEstimate {
  readonly estimatedUsd: number;
  readonly label: string;
}

export function estimateUiKitCost(kind: ProviderKind): UiKitCostEstimate {
  switch (kind) {
    case 'mock':
    case 'antigravity-agent':
    case 'comfyui':
      return { estimatedUsd: 0, label: '$0.00 (Offline Procedural)' };
    case 'antigravity-bridge':
      return { estimatedUsd: 0, label: '$0.00 (Bridge)' };
    case 'gemini':
      return { estimatedUsd: 0.039, label: '~$0.04 (Gemini UI Sheet)' };
    default:
      return { estimatedUsd: 0.039, label: '~$0.04' };
  }
}

/**
 * Pure request builder compiling a `4×2` UI State Sheet prompt on flat `#FF00FF` chroma
 * locked to the active `ArtBible` palette and `artMode`.
 */
export function buildGeminiUiKitRequest(
  prompt: string,
  artBible: ArtBible,
): GeminiGenerateContentPayload {
  const palette = artBible.palette.length > 0 ? artBible.palette.join(', ') : '#1A1C2C, #FFCD75';
  const text = [
    'Generate a clean 4x2 grid UI widget sprite sheet on a solid flat #FF00FF magenta chroma background.',
    'Top row left-to-right (4 square cells): (1) button_normal, (2) button_hover (brighter highlight rim), (3) button_pressed (inset shifted bevel), (4) button_disabled (muted low-contrast).',
    'Bottom row left-to-right (4 square cells): (5) panel_bg (framed dialog panel), (6) bar_track (dark progress trough), (7) bar_fill (vibrant HP/XP fill strip), (8) blank #FF00FF.',
    `THEME PROMPT: ${prompt.trim() || 'fantasy RPG ornate crisp game UI buttons and panels'}.`,
    `ART BIBLE LOCK: artMode=${artBible.artMode}, projection=${artBible.projection}, lighting=${artBible.lighting}, style="${artBible.stylePrompt}", palette=[${palette}].`,
    'NO text labels inside widgets, NO drop shadows outside crisp outlines, flat #FF00FF empty space between cells.',
  ].join('\n');

  return {
    contents: [{ role: 'user', parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

/**
 * Generates or synthesizes a complete 7-slot `BakedUiKit` via Gemini BYOK, Antigravity Bridge,
 * or Offline Mock (`$0.00`), stripping all secrets from any thrown `ProviderError`.
 */
export async function generateUiKitViaAi(
  prompt: string,
  config: UiKitStyleConfig,
  artBible: ArtBible,
  providerConfig: ProviderConfig,
  options: { signal?: AbortSignal } = {},
): Promise<{ kit: BakedUiKit; providerLabel: string; costEstimate: UiKitCostEstimate }> {
  const costEstimate = estimateUiKitCost(providerConfig.kind);

  if (
    providerConfig.kind === 'mock' ||
    providerConfig.kind === 'antigravity-agent' ||
    providerConfig.kind === 'comfyui'
  ) {
    return {
      kit: bakeProceduralUiKit(config),
      providerLabel: 'Offline Procedural ($0.00)',
      costEstimate,
    };
  }

  if (providerConfig.kind === 'antigravity-bridge') {
    const baseUrl = resolveBridgeBaseUrl(providerConfig.endpointUrl);
    const token = getBridgeSessionToken(providerConfig.id, providerConfig.apiKey);
    if (!token) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: providerConfig.id,
        retryable: false,
        message: 'Bridge token missing for UI State Sheet generation.',
        remediation: 'Open Provider Vault and configure the nbg_ bridge bearer token.',
      });
    }

    try {
      const dummyPng = encodeRgbaToPngBytes(new Uint8ClampedArray(64 * 64 * 4), 64, 64);
      const res = await fetch(`${baseUrl}/v1/generate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          requestId: globalThis.crypto.randomUUID(),
          modelId: providerConfig.modelId,
          compiledPrompt: (
            buildGeminiUiKitRequest(prompt, artBible).contents[0].parts[0] as { text: string }
          ).text,
          promptDelta: prompt.trim() || 'ui kit state sheet',
          negativePrompt: artBible.negativePrompt,
          adherence: 'strict',
          variants: 1,
          sketchPngBase64: uint8ToBase64(dummyPng),
          artBibleSnapshot: {
            projection: artBible.projection,
            lighting: artBible.lighting,
            artMode: artBible.artMode,
            palette: [...artBible.palette],
          },
        }),
        signal: options.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw classifyProviderError(
          { status: res.status, responseText: text },
          {
            providerId: providerConfig.id,
            providerKind: 'antigravity-bridge',
            endpointUrl: baseUrl,
            secrets: [token],
          },
        );
      }
      const parsed = BridgeGenerateResponseSchema.parse(await res.json());
      const first = parsed.variants[0];
      if (!first) throw new Error('Bridge returned zero UI kit images.');
      const decoded = await decodePngBytesToRgba(base64ToUint8(first.pngBase64));
      return {
        kit: sliceUiStateSheet(
          { width: decoded.width, height: decoded.height, data: decoded.rgba },
          [255, 0, 255],
          config.slug,
        ),
        providerLabel: providerConfig.displayName,
        costEstimate,
      };
    } catch (err) {
      throw classifyProviderError(err, {
        providerId: providerConfig.id,
        providerKind: 'antigravity-bridge',
        endpointUrl: baseUrl,
        secrets: [token],
      });
    }
  }

  // Gemini BYOK
  const apiKey = providerConfig.apiKey.trim();
  if (!apiKey) {
    throw new ProviderError({
      code: 'UNAUTHORIZED',
      status: 401,
      providerId: providerConfig.id,
      retryable: false,
      message: 'Gemini API key is required for GenAI UI State Sheet generation.',
      remediation:
        'Add a Gemini API key in Provider Vault or switch to Offline Procedural ($0.00).',
    });
  }

  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const url = `${baseUrl}/models/${encodeURIComponent(providerConfig.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const payload = buildGeminiUiKitRequest(prompt, artBible);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw classifyProviderError(
        { status: res.status, responseText: text },
        {
          providerId: providerConfig.id,
          providerKind: providerConfig.kind,
          endpointUrl: baseUrl,
          secrets: [apiKey],
        },
      );
    }
    const json = (await res.json()) as GeminiGenerateContentResponse;
    const { base64 } = extractImageBase64FromGeminiResponse(json);
    const decoded = await decodePngBytesToRgba(base64ToUint8(base64));
    return {
      kit: sliceUiStateSheet(
        { width: decoded.width, height: decoded.height, data: decoded.rgba },
        [255, 0, 255],
        config.slug,
      ),
      providerLabel: providerConfig.displayName,
      costEstimate,
    };
  } catch (err) {
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: baseUrl,
      secrets: [apiKey],
    });
  }
}
