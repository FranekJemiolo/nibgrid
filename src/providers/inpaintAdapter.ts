import type { ArtBible, ProviderConfig, ProviderKind } from '../domain/schemas';
import { sha256Bytes } from '../processing/hash';
import {
  compositeInpaintResult,
  countMaskedPixels,
  maskToRgbaBuffer,
  snapMaskedPixelsToPalette,
} from '../processing/inpaintMask';
import { hexToRgbaColor } from '../processing/pixelEditorCore';
import {
  base64ToUint8,
  decodePngBytesToRgba,
  encodeRgbaToPngBytes,
  uint8ToBase64,
} from '../processing/png';
import type { RgbaBuffer } from '../processing/types';
import { AntigravityBridgeProvider } from './antigravityBridgeProvider';
import { ComfyUiProvider } from './comfyuiProvider';
import { classifyProviderError, ProviderError } from './errors';
import {
  extractImageBase64FromGeminiResponse,
  resolveGeminiBaseUrl,
  type GeminiGenerateContentPayload,
  type GeminiGenerateContentResponse,
  type GeminiInlineDataPart,
  type GeminiRequestPart,
} from './geminiProvider';
import type { ProviderInpaintRequest } from './types';

export interface InpaintCostEstimate {
  readonly estimatedUsd: number;
  readonly label: string;
}

export interface RegionInpaintOptions {
  readonly snapToPalette?: boolean;
  readonly seed?: number;
  readonly signal?: AbortSignal;
  readonly goldenReferencePngs?: readonly {
    readonly mimeType: string;
    readonly bytes: Uint8Array;
  }[];
}

export interface RegionInpaintResult {
  readonly buffer: RgbaBuffer;
  readonly maskedPixels: number;
  readonly providerLabel: string;
  readonly costEstimate: InpaintCostEstimate;
}

export function estimateInpaintCost(kind: ProviderKind): InpaintCostEstimate {
  switch (kind) {
    case 'mock':
    case 'antigravity-agent':
      return { estimatedUsd: 0, label: '$0.00 (Offline Mock)' };
    case 'antigravity-bridge':
      return { estimatedUsd: 0, label: '$0.00 (Bridge)' };
    case 'comfyui':
      return { estimatedUsd: 0, label: '$0.00 (Local ComfyUI)' };
    case 'gemini':
      return { estimatedUsd: 0.039, label: '~$0.04 (Gemini BYOK)' };
    default:
      return { estimatedUsd: 0.039, label: '~$0.04' };
  }
}

/** Nearest-neighbor resize so any live model output aligns 1:1 with sprite bounds before mask compositing. */
function resampleRgbaNearest(src: RgbaBuffer, dstWidth: number, dstHeight: number): RgbaBuffer {
  if (src.width === dstWidth && src.height === dstHeight) {
    return src;
  }
  const out = new Uint8ClampedArray(dstWidth * dstHeight * 4);
  for (let y = 0; y < dstHeight; y++) {
    const sy = Math.min(src.height - 1, Math.floor((y * src.height) / Math.max(1, dstHeight)));
    for (let x = 0; x < dstWidth; x++) {
      const sx = Math.min(src.width - 1, Math.floor((x * src.width) / Math.max(1, dstWidth)));
      const srcIdx = (sy * src.width + sx) * 4;
      const dstIdx = (y * dstWidth + x) * 4;
      out[dstIdx] = src.data[srcIdx] ?? 0;
      out[dstIdx + 1] = src.data[srcIdx + 1] ?? 0;
      out[dstIdx + 2] = src.data[srcIdx + 2] ?? 0;
      out[dstIdx + 3] = src.data[srcIdx + 3] ?? 0;
    }
  }
  return { width: dstWidth, height: dstHeight, data: out };
}

function hashPromptDeterministic(prompt: string): number {
  let h = 2166136261;
  for (let i = 0; i < prompt.length; i++) {
    h ^= prompt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function renderOfflineMockInpaint(
  original: RgbaBuffer,
  mask: Uint8Array,
  localPrompt: string,
  artBible: ArtBible,
): RgbaBuffer {
  const seedHash = hashPromptDeterministic(localPrompt);
  const palette =
    artBible.palette.length > 0 ? artBible.palette : ['#FFCD75', '#EF7D57', '#B13E53'];
  const primaryHex = palette[(seedHash + palette.length - 1) % palette.length] ?? '#FFCD75';
  const secondaryHex = palette[seedHash % palette.length] ?? '#EF7D57';
  const primary = hexToRgbaColor(primaryHex, 255);
  const secondary = hexToRgbaColor(secondaryHex, 255);

  const generated = new Uint8ClampedArray(original.data);
  for (let y = 0; y < original.height; y++) {
    for (let x = 0; x < original.width; x++) {
      const p = y * original.width + x;
      if ((mask[p] ?? 0) === 0) continue;
      const checker = ((x + y + (seedHash & 1)) & 1) === 0;
      const col = checker ? primary : secondary;
      const i = p * 4;
      generated[i] = col[0];
      generated[i + 1] = col[1];
      generated[i + 2] = col[2];
      generated[i + 3] = col[3];
    }
  }

  return compositeInpaintResult(
    original,
    { width: original.width, height: original.height, data: generated },
    mask,
  );
}

/**
 * Pure request builder compiling original PNG, white-on-black binary mask PNG,
 * and active ArtBible style lock into a Gemini multimodal inpaint payload.
 */
export function buildGeminiInpaintRequest(
  originalPngBase64: string,
  maskPngBase64: string,
  localPrompt: string,
  artBible: ArtBible,
  goldenRefs: readonly GeminiInlineDataPart[] = [],
): GeminiGenerateContentPayload {
  const paletteList =
    artBible.palette.length > 0 ? artBible.palette.join(', ') : '#1A1C2C, #FFCD75';
  const parts: GeminiRequestPart[] = [
    {
      text: [
        'SURGICAL INPAINT REGION LOCK:',
        'Image 1 is the original game sprite.',
        'Image 2 is a binary edit mask (PURE WHITE = editable region, PURE BLACK = locked untouched pixels).',
        'Regenerate ONLY inside the white-masked area while keeping every black-masked pixel, silhouette boundary, camera projection, lighting, and pixel density identical.',
        `LOCAL EDIT INSTRUCTION: ${localPrompt.trim()}`,
        `ART BIBLE LOCK: artMode=${artBible.artMode}, projection=${artBible.projection}, lighting=${artBible.lighting}, style="${artBible.stylePrompt}", negative="${artBible.negativePrompt}", palette=[${paletteList}].`,
      ].join('\n'),
    },
    {
      inlineData: {
        mimeType: 'image/png',
        data: originalPngBase64,
      },
    },
    {
      inlineData: {
        mimeType: 'image/png',
        data: maskPngBase64,
      },
    },
    ...goldenRefs.slice(0, 3),
  ];

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

/**
 * Executes region-masked AI (or deterministic offline mock) inpainting strictly within `mask`,
 * guaranteeing 100% byte-identical preservation of all unmasked pixels and redacting API secrets.
 */
export async function runRegionInpaint(
  originalBuf: RgbaBuffer,
  mask: Uint8Array,
  localPrompt: string,
  artBible: ArtBible,
  providerConfig: ProviderConfig,
  options: RegionInpaintOptions = {},
): Promise<RegionInpaintResult> {
  const maskedPixels = countMaskedPixels(mask);
  if (maskedPixels === 0) {
    throw new Error('Paint at least one pixel on the Inpaint Mask before running Region Inpaint.');
  }

  const effectivePrompt =
    localPrompt.trim() || 'refine painted area cleanly matching Art Bible style';
  const costEstimate = estimateInpaintCost(providerConfig.kind);
  const snapToPalette = options.snapToPalette ?? false;
  const seed = options.seed ?? 1337;

  if (providerConfig.kind === 'mock' || providerConfig.kind === 'antigravity-agent') {
    const merged = renderOfflineMockInpaint(originalBuf, mask, effectivePrompt, artBible);
    return {
      buffer: snapToPalette ? snapMaskedPixelsToPalette(merged, mask, artBible.palette) : merged,
      maskedPixels,
      providerLabel: 'Offline Mock ($0.00)',
      costEstimate,
    };
  }

  let candidateBuf: RgbaBuffer;
  let providerLabel: string = providerConfig.displayName;

  if (providerConfig.kind === 'antigravity-bridge' || providerConfig.kind === 'comfyui') {
    const compiledPrompt = `${effectivePrompt} | ArtMode: ${artBible.artMode} | Lighting: ${artBible.lighting} | ${artBible.stylePrompt}`;
    const originalPngForHash = encodeRgbaToPngBytes(
      originalBuf.data,
      originalBuf.width,
      originalBuf.height,
    );
    const sketchSha256 = await sha256Bytes(originalPngForHash);
    const adapterRequest: ProviderInpaintRequest = {
      compiledPrompt,
      promptDelta: effectivePrompt,
      adherence: 'strict',
      seed,
      variantCount: 1,
      sketchRgba: originalBuf.data,
      sketchSha256,
      baseImageRgba: originalBuf.data,
      mask,
      sketchWidth: originalBuf.width,
      sketchHeight: originalBuf.height,
      artBible,
      config: providerConfig,
      goldenReferenceImages: (options.goldenReferencePngs ?? []).slice(0, 3).map((ref) => ({
        mimeType: ref.mimeType,
        bytes: ref.bytes,
      })),
    };

    const adapter =
      providerConfig.kind === 'antigravity-bridge'
        ? new AntigravityBridgeProvider(providerConfig)
        : new ComfyUiProvider(providerConfig);

    const outputs = await adapter.inpaint(adapterRequest, options.signal);
    const first = outputs[0];
    if (!first) {
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        providerId: providerConfig.id,
        retryable: false,
        message: 'Provider returned zero inpainted images.',
        remediation: 'Retry with a clearer region prompt or switch to Offline Mock.',
      });
    }
    candidateBuf = { width: first.width, height: first.height, data: first.rgba };
  } else {
    // Gemini BYOK (or custom-http compatible Gemini endpoint)
    const apiKey = providerConfig.apiKey.trim();
    if (!apiKey) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: providerConfig.id,
        retryable: false,
        message: 'Gemini API key is required for Region Inpainting.',
        remediation: 'Add a Gemini API key in Provider Vault or select Offline Mock ($0.00).',
      });
    }

    const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
    const originalPng = encodeRgbaToPngBytes(
      originalBuf.data,
      originalBuf.width,
      originalBuf.height,
    );
    const maskRgba = maskToRgbaBuffer(mask, originalBuf.width, originalBuf.height);
    const maskPng = encodeRgbaToPngBytes(maskRgba.data, maskRgba.width, maskRgba.height);
    const goldenParts: GeminiInlineDataPart[] = (options.goldenReferencePngs ?? [])
      .slice(0, 3)
      .map((ref) => ({
        inlineData: {
          mimeType: ref.mimeType || 'image/png',
          data: uint8ToBase64(ref.bytes),
        },
      }));

    const payload = buildGeminiInpaintRequest(
      uint8ToBase64(originalPng),
      uint8ToBase64(maskPng),
      effectivePrompt,
      artBible,
      goldenParts,
    );

    const url = `${baseUrl}/models/${encodeURIComponent(providerConfig.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });

      if (!response.ok) {
        const responseText = await response.text().catch(() => '');
        throw classifyProviderError(
          { status: response.status, responseText },
          {
            providerId: providerConfig.id,
            providerKind: providerConfig.kind,
            endpointUrl: baseUrl,
            secrets: [apiKey],
          },
        );
      }

      const json = (await response.json()) as GeminiGenerateContentResponse;
      const { base64 } = extractImageBase64FromGeminiResponse(json);
      const decoded = await decodePngBytesToRgba(base64ToUint8(base64));
      candidateBuf = { width: decoded.width, height: decoded.height, data: decoded.rgba };
      providerLabel = providerConfig.displayName;
    } catch (error) {
      throw classifyProviderError(error, {
        providerId: providerConfig.id,
        providerKind: providerConfig.kind,
        endpointUrl: baseUrl,
        secrets: [apiKey],
      });
    }
  }

  const aligned = resampleRgbaNearest(candidateBuf, originalBuf.width, originalBuf.height);
  const merged = compositeInpaintResult(originalBuf, aligned, mask);
  return {
    buffer: snapToPalette ? snapMaskedPixelsToPalette(merged, mask, artBible.palette) : merged,
    maskedPixels,
    providerLabel,
    costEstimate,
  };
}
