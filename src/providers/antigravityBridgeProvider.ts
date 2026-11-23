import type { ArtBible, ProviderConfig, SpriteNode } from '../domain/schemas';
import { sha256Bytes } from '../processing/hash';
import {
  base64ToUint8,
  decodePngBytesToRgba,
  encodeRgbaToPngBytes,
  uint8ToBase64,
} from '../processing/png';
import {
  BRIDGE_MIN_TTL_MS,
  BridgeCritiqueResponseSchema,
  BridgeGenerateResponseSchema,
  BridgeHealthResponseSchema,
  DEFAULT_ANTIGRAVITY_BRIDGE_URL,
  type BridgeCritiqueResponse,
  type BridgeGenerateRequest,
} from './bridgeContract';
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

export interface StatefulChainDecision {
  readonly previousInteractionId?: string;
  readonly usedStatefulChain: boolean;
  readonly reAnchoredReason?: string;
}

const SESSION_TOKEN_PREFIX = 'nibgrid.bridge.token.';

export function setBridgeSessionToken(providerId: string, token: string): void {
  if (typeof sessionStorage === 'undefined') return;
  const trimmed = token.trim();
  if (!trimmed) {
    sessionStorage.removeItem(`${SESSION_TOKEN_PREFIX}${providerId}`);
    return;
  }
  sessionStorage.setItem(`${SESSION_TOKEN_PREFIX}${providerId}`, trimmed);
}

export function getBridgeSessionToken(providerId: string, fallbackApiKey = ''): string {
  const fromVault = fallbackApiKey.trim();
  if (fromVault) return fromVault;
  if (typeof sessionStorage === 'undefined') return '';
  return (sessionStorage.getItem(`${SESSION_TOKEN_PREFIX}${providerId}`) ?? '').trim();
}

export function clearBridgeSessionToken(providerId: string): void {
  if (typeof sessionStorage === 'undefined') return;
  sessionStorage.removeItem(`${SESSION_TOKEN_PREFIX}${providerId}`);
}

/**
 * Pure decision helper selecting stateful `previousInteractionId` continuation vs. stateless re-anchoring.
 */
export function selectStatefulInteractionChain(
  parentNode: SpriteNode | null | undefined,
  activeProviderId: string,
  nowMs = Date.now(),
): StatefulChainDecision {
  if (!parentNode?.generationMeta.interactionId) {
    return { usedStatefulChain: false };
  }
  if (parentNode.generationMeta.providerId !== activeProviderId) {
    return {
      usedStatefulChain: false,
      reAnchoredReason: 'Cross-provider branch — re-anchored from parent sprite',
    };
  }
  const expiresAt = parentNode.generationMeta.interactionExpiresAt;
  if (expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs - nowMs < BRIDGE_MIN_TTL_MS) {
      return {
        usedStatefulChain: false,
        reAnchoredReason: 'Session expired — re-anchored from parent sprite',
      };
    }
  }
  return {
    previousInteractionId: parentNode.generationMeta.interactionId,
    usedStatefulChain: true,
  };
}

function resolveBridgeBaseUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : DEFAULT_ANTIGRAVITY_BRIDGE_URL;
}

function buildMaskPngBase64(mask: Uint8Array, width: number, height: number): string {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const v = (mask[i] ?? 0) === 1 ? 255 : 0;
    rgba[i * 4] = v;
    rgba[i * 4 + 1] = v;
    rgba[i * 4 + 2] = v;
    rgba[i * 4 + 3] = 255;
  }
  return uint8ToBase64(encodeRgbaToPngBytes(rgba, width, height));
}

export class AntigravityBridgeProvider implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.capabilities = {
      supportsInpaint: true,
      supportsMultiRef: true,
      supportsSeed: true,
      isLocal: true,
    };
  }

  private resolveToken(config: ProviderConfig): string {
    return getBridgeSessionToken(config.id, config.apiKey);
  }

  async testConnection(config: ProviderConfig): Promise<ProviderTestResult> {
    const baseUrl = resolveBridgeBaseUrl(config.endpointUrl);
    const token = this.resolveToken(config);
    if (!token) {
      return {
        ok: false,
        message:
          'Missing ephemeral bridge bearer token (nbg_...). Start nibgrid_bridge.py and paste token.',
      };
    }

    const start = performance.now();
    try {
      const response = await fetch(`${baseUrl}/v1/health`, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw { status: response.status, responseText: errText };
      }
      const parsed = BridgeHealthResponseSchema.parse(await response.json());
      const latencyMs = Math.round(performance.now() - start);
      return {
        ok: parsed.ok,
        latencyMs,
        message: `Connected to Antigravity Bridge v${parsed.version} (${
          parsed.supportsStatefulInteractions ? 'Stateful Chains ON' : 'Stateless'
        })`,
      };
    } catch (error) {
      const classified = classifyProviderError(error, {
        providerId: config.id,
        providerKind: 'antigravity-bridge',
        endpointUrl: baseUrl,
        secrets: [token],
      });
      return {
        ok: false,
        message: `${classified.message} ${classified.remediation}`,
      };
    }
  }

  estimateCost(_request: ProviderGenerateRequest): ProviderCostEstimate {
    return {
      estimatedUsd: 0,
      label: '$0.00 — Antigravity Bridge Quota',
    };
  }

  public buildRequestPayload(
    request: ProviderGenerateRequest,
    maskPngBase64?: string,
    nowMs = Date.now(),
  ): { payload: BridgeGenerateRequest; decision: StatefulChainDecision } {
    const decision = selectStatefulInteractionChain(request.parentNode, request.config.id, nowMs);
    const requestId = globalThis.crypto.randomUUID();
    const variants: 1 | 2 = request.variantCount >= 2 ? 2 : 1;

    const payload: BridgeGenerateRequest = {
      requestId,
      modelId: request.config.modelId,
      ...(decision.previousInteractionId
        ? { previousInteractionId: decision.previousInteractionId }
        : {}),
      compiledPrompt: request.compiledPrompt,
      promptDelta: request.promptDelta,
      negativePrompt: request.artBible.negativePrompt,
      adherence: request.adherence,
      variants,
      // When stateful interaction chain is valid, server/API retains visual state; omit redundant image uploads
      ...(!decision.usedStatefulChain
        ? {
            sketchPngBase64: uint8ToBase64(
              encodeRgbaToPngBytes(request.sketchRgba, request.sketchWidth, request.sketchHeight),
            ),
            ...(request.goldenReferenceImages && request.goldenReferenceImages.length > 0
              ? {
                  goldenRefsPngBase64: request.goldenReferenceImages.map((r) =>
                    uint8ToBase64(r.bytes),
                  ),
                }
              : {}),
          }
        : {}),
      ...(maskPngBase64 ? { maskPngBase64 } : {}),
      artBibleSnapshot: {
        projection: request.artBible.projection,
        lighting: request.artBible.lighting,
        artMode: request.artBible.artMode,
        palette: [...request.artBible.palette],
      },
    };

    return { payload, decision };
  }

  private async executeBridgeCall(
    endpointPath: '/v1/generate' | '/v1/inpaint',
    request: ProviderGenerateRequest,
    maskPngBase64?: string,
    signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    const baseUrl = resolveBridgeBaseUrl(request.config.endpointUrl);
    const token = this.resolveToken(request.config);
    if (!token) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: request.config.id,
        retryable: false,
        message: 'Bridge session token is missing.',
        remediation: 'Run nibgrid_bridge.py and paste the nbg_... token into Provider Vault.',
      });
    }

    const { payload, decision } = this.buildRequestPayload(request, maskPngBase64);

    const onAbort = () => {
      void fetch(`${baseUrl}/v1/cancel/${payload.requestId}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(`${baseUrl}${endpointPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(payload),
        signal: signal ?? AbortSignal.timeout(45_000),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw { status: response.status, responseText: text };
      }

      const parsed = BridgeGenerateResponseSchema.parse(await response.json());
      const outputs: ProviderOutput[] = [];

      for (let i = 0; i < parsed.variants.length; i++) {
        const variant = parsed.variants[i]!;
        const pngBytes = base64ToUint8(variant.pngBase64);
        const decoded = await decodePngBytesToRgba(pngBytes);
        const sha256 = await sha256Bytes(pngBytes);
        const bufferCopy = new Uint8Array(pngBytes.byteLength);
        bufferCopy.set(pngBytes);

        outputs.push({
          variantIndex: i,
          seed: request.seed + i,
          width: decoded.width,
          height: decoded.height,
          rgba: decoded.rgba,
          pngBytes,
          blob: new Blob([bufferCopy.buffer], { type: 'image/png' }),
          sha256,
          interactionId: variant.interactionId,
          ...(decision.previousInteractionId
            ? { parentInteractionId: decision.previousInteractionId }
            : {}),
          interactionExpiresAt: variant.interactionExpiresAt,
          usedStatefulChain: parsed.usedStatefulChain && decision.usedStatefulChain,
        });
      }
      return outputs;
    } catch (error) {
      throw classifyProviderError(error, {
        providerId: request.config.id,
        providerKind: 'antigravity-bridge',
        endpointUrl: baseUrl,
        secrets: [token],
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    return this.executeBridgeCall('/v1/generate', request, undefined, signal);
  }

  async inpaint(request: ProviderInpaintRequest, signal?: AbortSignal): Promise<ProviderOutput[]> {
    const maskB64 = buildMaskPngBase64(request.mask, request.sketchWidth, request.sketchHeight);
    return this.executeBridgeCall('/v1/inpaint', request, maskB64, signal);
  }

  async critiqueSprite(
    config: ProviderConfig,
    spritePngBytes: Uint8Array,
    artBible: ArtBible,
    promptDelta: string,
    signal?: AbortSignal,
  ): Promise<BridgeCritiqueResponse> {
    const baseUrl = resolveBridgeBaseUrl(config.endpointUrl);
    const token = this.resolveToken(config);
    if (!token) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: config.id,
        retryable: false,
        message: 'Bridge token missing for Art Bible critique.',
        remediation: 'Open Provider Vault to configure the ephemeral nbg_ token.',
      });
    }

    try {
      const res = await fetch(`${baseUrl}/v1/critique`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          candidatePngBase64: uint8ToBase64(spritePngBytes),
          promptDelta,
          artBibleSnapshot: {
            projection: artBible.projection,
            lighting: artBible.lighting,
            artMode: artBible.artMode,
            palette: [...artBible.palette],
            stylePrompt: artBible.stylePrompt,
            negativePrompt: artBible.negativePrompt,
          },
        }),
        signal: signal ?? AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw { status: res.status, responseText: txt };
      }
      return BridgeCritiqueResponseSchema.parse(await res.json());
    } catch (error) {
      throw classifyProviderError(error, {
        providerId: config.id,
        providerKind: 'antigravity-bridge',
        endpointUrl: baseUrl,
        secrets: [token],
      });
    }
  }
}
