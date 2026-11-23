import { OFFLINE_MOCK_PROVIDER_ID } from '../db/database';
import { sha256Bytes } from '../processing/hash';
import { encodeRgbaToPngBytes } from '../processing/png';
import {
  inpaintProceduralRegion,
  synthesizeProceduralSprite,
} from '../processing/proceduralSprite';
import type { ProviderConfig } from '../domain/schemas';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCostEstimate,
  ProviderGenerateRequest,
  ProviderInpaintRequest,
  ProviderOutput,
  ProviderTestResult,
} from './types';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Provider operation was aborted', 'AbortError');
  }
}

function toBlob(pngBytes: Uint8Array): Blob {
  const copy = new Uint8Array(pngBytes.byteLength);
  copy.set(pngBytes);
  return new Blob([copy.buffer], { type: 'image/png' });
}

export class OfflineMockProvider implements ProviderAdapter {
  readonly id = OFFLINE_MOCK_PROVIDER_ID;
  readonly displayName = 'Offline Mock Provider';
  readonly capabilities: ProviderCapabilities = {
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: true,
    isLocal: true,
  };

  async testConnection(_config: ProviderConfig): Promise<ProviderTestResult> {
    return {
      ok: true,
      latencyMs: 0,
      message: 'Offline procedural sprite engine ready (zero network calls)',
    };
  }

  estimateCost(_request: ProviderGenerateRequest): ProviderCostEstimate {
    return {
      estimatedUsd: 0,
      label: '$0.00 — Local Mock',
    };
  }

  async generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    throwIfAborted(signal);
    const count = Math.max(1, Math.min(4, request.variantCount));
    const outputs: ProviderOutput[] = [];

    for (let variantIndex = 0; variantIndex < count; variantIndex++) {
      throwIfAborted(signal);
      const variantSeed = request.seed + variantIndex;
      const seedKey = [
        request.sketchSha256,
        String(variantSeed),
        request.adherence,
        request.promptDelta,
        String(variantIndex),
      ].join('|');

      const rgba = synthesizeProceduralSprite({
        sketchRgba: request.sketchRgba,
        width: request.sketchWidth,
        height: request.sketchHeight,
        palette: request.artBible.palette,
        lighting: request.artBible.lighting,
        artMode: request.artBible.artMode,
        adherence: request.adherence,
        seedKey,
        variantIndex,
      });

      const pngBytes = encodeRgbaToPngBytes(rgba, request.sketchWidth, request.sketchHeight);
      const sha256 = await sha256Bytes(pngBytes);

      outputs.push({
        variantIndex,
        seed: variantSeed,
        width: request.sketchWidth,
        height: request.sketchHeight,
        rgba,
        pngBytes,
        blob: toBlob(pngBytes),
        sha256,
      });
    }

    return outputs;
  }

  async inpaint(request: ProviderInpaintRequest, signal?: AbortSignal): Promise<ProviderOutput[]> {
    throwIfAborted(signal);
    const seedKey = [
      'inpaint',
      request.sketchSha256,
      String(request.seed),
      request.adherence,
      request.promptDelta,
    ].join('|');

    const rgba = inpaintProceduralRegion({
      baseImageRgba: request.baseImageRgba,
      mask: request.mask,
      width: request.sketchWidth,
      height: request.sketchHeight,
      palette: request.artBible.palette,
      lighting: request.artBible.lighting,
      seedKey,
    });

    const pngBytes = encodeRgbaToPngBytes(rgba, request.sketchWidth, request.sketchHeight);
    const sha256 = await sha256Bytes(pngBytes);

    return [
      {
        variantIndex: 0,
        seed: request.seed,
        width: request.sketchWidth,
        height: request.sketchHeight,
        rgba,
        pngBytes,
        blob: toBlob(pngBytes),
        sha256,
      },
    ];
  }
}

export const offlineMockProvider = new OfflineMockProvider();
