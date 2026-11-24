import type { ProviderConfig } from '../domain/schemas';
import { sha256Bytes } from '../processing/hash';
import {
  base64ToUint8,
  decodePngBytesToRgba,
  encodeRgbaToPngBytes,
  uint8ToBase64,
} from '../processing/png';
import { ProviderError, classifyProviderError } from './errors';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCostEstimate,
  ProviderGenerateRequest,
  ProviderInpaintRequest,
  ProviderOutput,
  ProviderTestResult,
} from './types';

export const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export interface GeminiInlineDataPart {
  inlineData: {
    mimeType: string;
    data: string;
  };
}

export interface GeminiTextPart {
  text: string;
}

export type GeminiRequestPart = GeminiTextPart | GeminiInlineDataPart;

export interface GeminiGenerateContentPayload {
  contents: [
    {
      role: 'user';
      parts: GeminiRequestPart[];
    },
  ];
  generationConfig: {
    responseModalities: ['IMAGE'];
  };
}

interface GeminiResponseCandidate {
  content?: {
    parts?: Array<{
      text?: string;
      inlineData?: { mimeType?: string; data?: string };
      inline_data?: { mime_type?: string; data?: string };
    }>;
  };
}

export interface GeminiGenerateContentResponse {
  candidates?: GeminiResponseCandidate[];
  error?: { message?: string };
}

export function resolveGeminiBaseUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : DEFAULT_GEMINI_BASE_URL;
}

function buildBinaryMaskPngBytes(mask: Uint8Array, width: number, height: number): Uint8Array {
  const maskRgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const val = (mask[i] ?? 0) === 1 ? 255 : 0;
    const px = i * 4;
    maskRgba[px] = val;
    maskRgba[px + 1] = val;
    maskRgba[px + 2] = val;
    maskRgba[px + 3] = 255;
  }
  return encodeRgbaToPngBytes(maskRgba, width, height);
}

/**
 * Pure request builder serializing the compiled Art Bible prompt, normalized sketch,
 * and up to 3 Golden Reference blobs into Gemini Multimodal `inlineData` parts.
 */
export function buildGeminiGeneratePayload(
  request: ProviderGenerateRequest,
): GeminiGenerateContentPayload {
  const sketchPng = encodeRgbaToPngBytes(
    request.sketchRgba,
    request.sketchWidth,
    request.sketchHeight,
  );
  const parts: GeminiRequestPart[] = [
    {
      text: `${request.compiledPrompt}\nUse the first image as the structural sprite sketch and any subsequent images as Golden Style References.`,
    },
    {
      inlineData: {
        mimeType: 'image/png',
        data: uint8ToBase64(sketchPng),
      },
    },
  ];

  const refs = (request.goldenReferenceImages ?? []).slice(0, 3);
  for (const ref of refs) {
    parts.push({
      inlineData: {
        mimeType: ref.mimeType || 'image/png',
        data: uint8ToBase64(ref.bytes),
      },
    });
  }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

/**
 * Pure request builder for Gemini multimodal masked inpainting.
 * Sends the parent render, binary mask PNG (white=editable, black=locked),
 * Golden References, and region-locked editing instructions.
 */
export function buildGeminiInpaintPayload(
  request: ProviderInpaintRequest,
): GeminiGenerateContentPayload {
  const basePng = encodeRgbaToPngBytes(
    request.baseImageRgba,
    request.sketchWidth,
    request.sketchHeight,
  );
  const maskPng = buildBinaryMaskPngBytes(request.mask, request.sketchWidth, request.sketchHeight);

  const parts: GeminiRequestPart[] = [
    {
      text: `INPAINT REGION LOCK: Modify ONLY the white pixels in the second mask image and preserve all black-masked background/unmasked areas identically. Subject edit: ${request.compiledPrompt}`,
    },
    {
      inlineData: {
        mimeType: 'image/png',
        data: uint8ToBase64(basePng),
      },
    },
    {
      inlineData: {
        mimeType: 'image/png',
        data: uint8ToBase64(maskPng),
      },
    },
  ];

  const refs = (request.goldenReferenceImages ?? []).slice(0, 3);
  for (const ref of refs) {
    parts.push({
      inlineData: {
        mimeType: ref.mimeType || 'image/png',
        data: uint8ToBase64(ref.bytes),
      },
    });
  }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

export function extractImageBase64FromGeminiResponse(json: GeminiGenerateContentResponse): {
  base64: string;
  mimeType: string;
} {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.inlineData?.data) {
      return {
        base64: part.inlineData.data,
        mimeType: part.inlineData.mimeType ?? 'image/png',
      };
    }
    if (part.inline_data?.data) {
      return {
        base64: part.inline_data.data,
        mimeType: part.inline_data.mime_type ?? 'image/png',
      };
    }
  }
  throw new Error(json.error?.message || 'Gemini response did not include an image part.');
}

async function decodeToProviderOutput(
  base64Data: string,
  variantIndex: number,
  seed: number,
): Promise<ProviderOutput> {
  const rawBytes = base64ToUint8(base64Data);
  const decoded = await decodePngBytesToRgba(rawBytes);
  const canonicalPng = encodeRgbaToPngBytes(decoded.rgba, decoded.width, decoded.height);
  const sha256 = await sha256Bytes(canonicalPng);
  const blobCopy = new Uint8Array(canonicalPng.byteLength);
  blobCopy.set(canonicalPng);

  return {
    variantIndex,
    seed,
    width: decoded.width,
    height: decoded.height,
    rgba: decoded.rgba,
    pngBytes: canonicalPng,
    blob: new Blob([blobCopy.buffer], { type: 'image/png' }),
    sha256,
  };
}

export class GeminiProvider implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities = {
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: false,
    isLocal: false,
  };

  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.config = config;
  }

  async testConnection(config: ProviderConfig): Promise<ProviderTestResult> {
    const apiKey = config.apiKey.trim();
    if (!apiKey) {
      return {
        ok: false,
        message: 'API key is missing. Add your Gemini API key in Provider Vault.',
      };
    }

    const baseUrl = resolveGeminiBaseUrl(config.endpointUrl);
    const url = `${baseUrl}/models/${encodeURIComponent(config.modelId)}?key=${encodeURIComponent(apiKey)}`;
    const start = performance.now();

    try {
      const response = await fetch(url, { method: 'GET' });
      const latencyMs = Math.round(performance.now() - start);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = classifyProviderError(
          { status: response.status, responseText: body },
          {
            providerId: config.id,
            providerKind: 'gemini',
            endpointUrl: baseUrl,
            secrets: [apiKey],
          },
        );
        return { ok: false, latencyMs, message: err.message };
      }
      return {
        ok: true,
        latencyMs,
        message: `Connected to Gemini model "${config.modelId}" (${latencyMs}ms)`,
      };
    } catch (error) {
      const classified = classifyProviderError(error, {
        providerId: config.id,
        providerKind: 'gemini',
        endpointUrl: baseUrl,
        secrets: [apiKey],
      });
      return { ok: false, message: classified.message };
    }
  }

  estimateCost(request: ProviderGenerateRequest): ProviderCostEstimate {
    const count = Math.max(1, request.variantCount);
    const usd = 0.039 * count;
    return {
      estimatedUsd: usd,
      label: `~$${usd.toFixed(2)} — Gemini BYOK`,
    };
  }

  private async invokeGenerateContent(
    payload: GeminiGenerateContentPayload,
    config: ProviderConfig,
    signal?: AbortSignal,
  ): Promise<{ base64: string; mimeType: string }> {
    const apiKey = config.apiKey.trim();
    if (!apiKey) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        providerId: config.id,
        retryable: false,
        message: 'Gemini API key is required. Configure it in Provider Vault.',
        remediation: 'Open Provider Vault and enter a valid Gemini API key.',
      });
    }

    const baseUrl = resolveGeminiBaseUrl(config.endpointUrl);
    const url = `${baseUrl}/models/${encodeURIComponent(config.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal,
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw classifyProviderError(
          { status: response.status, responseText },
          {
            providerId: config.id,
            providerKind: 'gemini',
            endpointUrl: baseUrl,
            secrets: [apiKey],
          },
        );
      }

      const json = (await response.json()) as GeminiGenerateContentResponse;
      return extractImageBase64FromGeminiResponse(json);
    } catch (error) {
      throw classifyProviderError(error, {
        providerId: config.id,
        providerKind: 'gemini',
        endpointUrl: baseUrl,
        secrets: [apiKey],
      });
    }
  }

  async generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    const cfg = request.config ?? this.config;
    const count = Math.max(1, Math.min(4, request.variantCount));
    const payload = buildGeminiGeneratePayload(request);
    const outputs: ProviderOutput[] = [];

    for (let i = 0; i < count; i++) {
      const { base64 } = await this.invokeGenerateContent(payload, cfg, signal);
      outputs.push(await decodeToProviderOutput(base64, i, request.seed + i));
    }
    return outputs;
  }

  async inpaint(request: ProviderInpaintRequest, signal?: AbortSignal): Promise<ProviderOutput[]> {
    const cfg = request.config ?? this.config;
    const payload = buildGeminiInpaintPayload(request);
    const { base64 } = await this.invokeGenerateContent(payload, cfg, signal);
    return [await decodeToProviderOutput(base64, 0, request.seed)];
  }
}
