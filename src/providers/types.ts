import type { AdherenceLevel, ArtBible, ProviderConfig } from '../domain/schemas';

export interface ProviderCapabilities {
  supportsInpaint: boolean;
  supportsMultiRef: boolean;
  supportsSeed: boolean;
  isLocal: boolean;
}

export interface ProviderTestResult {
  ok: boolean;
  latencyMs?: number;
  message: string;
}

export interface ProviderCostEstimate {
  estimatedUsd: number;
  label: string;
}

export interface ProviderGenerateRequest {
  config: ProviderConfig;
  artBible: ArtBible;
  sketchRgba: Uint8ClampedArray;
  sketchWidth: number;
  sketchHeight: number;
  sketchSha256: string;
  seed: number;
  adherence: AdherenceLevel;
  promptDelta: string;
  compiledPrompt: string;
  variantCount: number;
}

export interface ProviderInpaintRequest extends ProviderGenerateRequest {
  baseImageRgba: Uint8ClampedArray;
  mask: Uint8Array;
}

export interface ProviderOutput {
  variantIndex: number;
  seed: number;
  width: number;
  height: number;
  rgba: Uint8ClampedArray;
  pngBytes: Uint8Array;
  blob: Blob;
  sha256: string;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities;
  testConnection(config: ProviderConfig): Promise<ProviderTestResult>;
  estimateCost(request: ProviderGenerateRequest): ProviderCostEstimate;
  generate(request: ProviderGenerateRequest, signal?: AbortSignal): Promise<ProviderOutput[]>;
  inpaint(request: ProviderInpaintRequest, signal?: AbortSignal): Promise<ProviderOutput[]>;
}

