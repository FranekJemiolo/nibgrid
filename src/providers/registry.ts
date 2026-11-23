import type { ProviderConfig } from '../domain/schemas';
import { antigravityAgentProvider } from './antigravityProvider';
import { ComfyUiProvider } from './comfyuiProvider';
import { GeminiProvider } from './geminiProvider';
import { offlineMockProvider } from './mockProvider';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCostEstimate,
  ProviderGenerateRequest,
  ProviderInpaintRequest,
  ProviderOutput,
  ProviderTestResult,
} from './types';

class UnconfiguredHttpAdapter implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.capabilities = config.capabilities;
  }

  async testConnection(config: ProviderConfig): Promise<ProviderTestResult> {
    if (!config.endpointUrl.trim()) {
      return { ok: false, message: 'Missing endpoint URL in Provider Vault.' };
    }
    return {
      ok: true,
      message: `Configured endpoint: ${config.endpointUrl}`,
    };
  }

  estimateCost(request: ProviderGenerateRequest): ProviderCostEstimate {
    if (request.config.capabilities.isLocal) {
      return { estimatedUsd: 0, label: '$0.00 — Local Endpoint' };
    }
    const perVariant = 0.04;
    const total = perVariant * Math.max(1, request.variantCount);
    return {
      estimatedUsd: total,
      label: `~$${total.toFixed(2)} — BYOK API`,
    };
  }

  async generate(
    request: ProviderGenerateRequest,
    _signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    throw new Error(
      `Remote/local HTTP generation for "${request.config.displayName}" requires a live endpoint at ${request.config.endpointUrl}. Switch to Offline Mock Provider, Gemini BYOK, or Local ComfyUI.`,
    );
  }

  async inpaint(request: ProviderInpaintRequest, _signal?: AbortSignal): Promise<ProviderOutput[]> {
    throw new Error(
      `Remote/local HTTP inpainting for "${request.config.displayName}" requires a live endpoint at ${request.config.endpointUrl}. Switch to Offline Mock Provider, Gemini BYOK, or Local ComfyUI.`,
    );
  }
}

export function resolveProviderAdapter(config: ProviderConfig): ProviderAdapter {
  if (config.kind === 'mock') {
    return offlineMockProvider;
  }
  if (config.kind === 'antigravity-agent') {
    return antigravityAgentProvider;
  }
  if (config.kind === 'gemini') {
    return new GeminiProvider(config);
  }
  if (config.kind === 'comfyui') {
    return new ComfyUiProvider(config);
  }
  return new UnconfiguredHttpAdapter(config);
}
