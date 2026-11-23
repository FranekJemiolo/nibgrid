import type { ProviderConfig } from '../domain/schemas';
import { DEFAULT_NEGATIVE_PROMPT } from '../domain/schemas';
import { sha256Bytes } from '../processing/hash';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../processing/png';
import { injectComfyUiWorkflow, type ComfyUiWorkflowGraph } from './comfyuiWorkflows';
import { classifyProviderError } from './errors';
import type {
  ProviderAdapter,
  ProviderCapabilities,
  ProviderCostEstimate,
  ProviderGenerateRequest,
  ProviderInpaintRequest,
  ProviderOutput,
  ProviderTestResult,
} from './types';

export const DEFAULT_COMFYUI_BASE_URL = 'http://127.0.0.1:8188';

interface ComfyUploadResponse {
  name: string;
  subfolder?: string;
  type?: string;
}

interface ComfyPromptResponse {
  prompt_id: string;
}

interface ComfyHistoryImageRef {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyHistoryEntry {
  outputs?: Record<
    string,
    {
      images?: ComfyHistoryImageRef[];
    }
  >;
}

function resolveComfyBaseUrl(endpointUrl: string): string {
  const trimmed = endpointUrl.trim().replace(/\/+$/, '');
  return trimmed.length > 0 ? trimmed : DEFAULT_COMFYUI_BASE_URL;
}

function buildComfyWebSocketUrl(baseUrl: string, clientId: string): string {
  const wsBase = baseUrl.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return `${wsBase}/ws?clientId=${encodeURIComponent(clientId)}`;
}

function extractNegativePrompt(compiledPrompt: string): string {
  const marker = '| Negative:';
  const idx = compiledPrompt.indexOf(marker);
  if (idx === -1) return DEFAULT_NEGATIVE_PROMPT;
  const extracted = compiledPrompt.slice(idx + marker.length).trim();
  return extracted || DEFAULT_NEGATIVE_PROMPT;
}

function extractPositivePrompt(compiledPrompt: string): string {
  const marker = '| Negative:';
  const idx = compiledPrompt.indexOf(marker);
  return idx === -1 ? compiledPrompt : compiledPrompt.slice(0, idx).trim();
}

export class ComfyUiProvider implements ProviderAdapter {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: ProviderCapabilities = {
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: true,
    isLocal: true,
  };

  private readonly config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.id = config.id;
    this.displayName = config.displayName;
    this.config = config;
  }

  async testConnection(config: ProviderConfig): Promise<ProviderTestResult> {
    const baseUrl = resolveComfyBaseUrl(config.endpointUrl);
    const start = performance.now();

    try {
      const response = await fetch(`${baseUrl}/system_stats`, { method: 'GET' });
      const latencyMs = Math.round(performance.now() - start);
      if (!response.ok) {
        const body = await response.text().catch(() => '');
        const err = classifyProviderError(
          { status: response.status, responseText: body },
          {
            providerId: config.id,
            providerKind: 'comfyui',
            endpointUrl: baseUrl,
          },
        );
        return { ok: false, latencyMs, message: err.message };
      }
      return {
        ok: true,
        latencyMs,
        message: `Connected to ComfyUI at ${baseUrl} (${latencyMs}ms)`,
      };
    } catch (error) {
      const err = classifyProviderError(error, {
        providerId: config.id,
        providerKind: 'comfyui',
        endpointUrl: baseUrl,
      });
      return { ok: false, message: err.message };
    }
  }

  estimateCost(_request: ProviderGenerateRequest): ProviderCostEstimate {
    return {
      estimatedUsd: 0,
      label: '$0.00 — Local ComfyUI',
    };
  }

  private async uploadPng(
    baseUrl: string,
    pngBytes: Uint8Array,
    filename: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const form = new FormData();
    const copy = new Uint8Array(pngBytes.byteLength);
    copy.set(pngBytes);
    form.append('image', new Blob([copy.buffer], { type: 'image/png' }), filename);
    form.append('type', 'input');
    form.append('overwrite', 'true');

    const response = await fetch(`${baseUrl}/upload/image`, {
      method: 'POST',
      body: form,
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw { status: response.status, responseText: body };
    }
    const json = (await response.json()) as ComfyUploadResponse;
    return json.name;
  }

  private async queueWorkflow(
    baseUrl: string,
    clientId: string,
    workflow: ComfyUiWorkflowGraph,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(`${baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: clientId, prompt: workflow }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw { status: response.status, responseText: body };
    }
    const json = (await response.json()) as ComfyPromptResponse;
    return json.prompt_id;
  }

  private async waitForOutputs(
    baseUrl: string,
    clientId: string,
    promptId: string,
    signal?: AbortSignal,
  ): Promise<ComfyHistoryImageRef[]> {
    let ws: WebSocket | null = null;
    let wsSignaledDone = false;

    if (typeof WebSocket !== 'undefined') {
      try {
        ws = new WebSocket(buildComfyWebSocketUrl(baseUrl, clientId));
        ws.onmessage = (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const msg = JSON.parse(event.data) as {
              type?: string;
              data?: { prompt_id?: string; node?: string | null };
            };
            if (
              msg.data?.prompt_id === promptId &&
              (msg.type === 'execution_success' ||
                msg.type === 'executed' ||
                (msg.type === 'executing' && msg.data.node === null))
            ) {
              wsSignaledDone = true;
            }
          } catch {
            // Ignore non-JSON binary preview frames
          }
        };
      } catch {
        ws = null;
      }
    }

    try {
      const maxAttempts = 120;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        if (signal?.aborted) {
          throw new DOMException('Aborted', 'AbortError');
        }

        const histRes = await fetch(`${baseUrl}/history/${encodeURIComponent(promptId)}`, {
          method: 'GET',
          signal,
        });
        if (histRes.ok) {
          const histJson = (await histRes.json()) as Record<string, ComfyHistoryEntry>;
          const entry = histJson[promptId];
          if (entry?.outputs) {
            const refs: ComfyHistoryImageRef[] = [];
            for (const nodeOut of Object.values(entry.outputs)) {
              for (const img of nodeOut.images ?? []) {
                refs.push(img);
              }
            }
            if (refs.length > 0) {
              return refs;
            }
          }
        }

        await new Promise<void>((resolve, reject) => {
          const delayMs = wsSignaledDone ? 25 : 150;
          const timer = globalThis.setTimeout(resolve, delayMs);
          signal?.addEventListener(
            'abort',
            () => {
              globalThis.clearTimeout(timer);
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        });
      }

      throw new Error(`Timed out waiting for ComfyUI prompt "${promptId}".`);
    } finally {
      ws?.close();
    }
  }

  private async fetchViewImage(
    baseUrl: string,
    ref: ComfyHistoryImageRef,
    variantIndex: number,
    seed: number,
    signal?: AbortSignal,
  ): Promise<ProviderOutput> {
    const params = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? '',
      type: ref.type ?? 'output',
    });
    const response = await fetch(`${baseUrl}/view?${params.toString()}`, {
      method: 'GET',
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw { status: response.status, responseText: body };
    }
    const pngBytes = new Uint8Array(await response.arrayBuffer());
    const decoded = await decodePngBytesToRgba(pngBytes);
    const canonicalPng = encodeRgbaToPngBytes(decoded.rgba, decoded.width, decoded.height);
    const sha256 = await sha256Bytes(canonicalPng);
    const copy = new Uint8Array(canonicalPng.byteLength);
    copy.set(canonicalPng);

    return {
      variantIndex,
      seed,
      width: decoded.width,
      height: decoded.height,
      rgba: decoded.rgba,
      pngBytes: canonicalPng,
      blob: new Blob([copy.buffer], { type: 'image/png' }),
      sha256,
    };
  }

  private async runComfyPipeline(
    request: ProviderGenerateRequest,
    baseRgba: Uint8ClampedArray,
    maskRgba: Uint8ClampedArray | null,
    signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    const cfg = request.config ?? this.config;
    const baseUrl = resolveComfyBaseUrl(cfg.endpointUrl);
    const count = Math.max(1, Math.min(4, request.variantCount));

    try {
      const basePng = encodeRgbaToPngBytes(baseRgba, request.sketchWidth, request.sketchHeight);
      const uploadedSketch = await this.uploadPng(
        baseUrl,
        basePng,
        `nibgrid_sketch_${Date.now()}.png`,
        signal,
      );

      let uploadedMask: string | undefined;
      if (maskRgba) {
        const maskPng = encodeRgbaToPngBytes(maskRgba, request.sketchWidth, request.sketchHeight);
        uploadedMask = await this.uploadPng(
          baseUrl,
          maskPng,
          `nibgrid_mask_${Date.now()}.png`,
          signal,
        );
      }

      const outputs: ProviderOutput[] = [];
      for (let i = 0; i < count; i++) {
        const variantSeed = request.seed + i;
        const clientId = globalThis.crypto.randomUUID();
        const injected = injectComfyUiWorkflow({
          customTemplateJson: cfg.customWorkflowJson,
          prompt: extractPositivePrompt(request.compiledPrompt),
          negativePrompt: extractNegativePrompt(request.compiledPrompt),
          seed: variantSeed,
          adherence: request.adherence,
          sketchFilename: uploadedSketch,
          maskFilename: uploadedMask,
        });

        const promptId = await this.queueWorkflow(baseUrl, clientId, injected.prompt, signal);
        const imageRefs = await this.waitForOutputs(baseUrl, clientId, promptId, signal);
        const firstRef = imageRefs[0];
        if (!firstRef) {
          throw new Error(`ComfyUI prompt "${promptId}" completed with zero output images.`);
        }
        outputs.push(await this.fetchViewImage(baseUrl, firstRef, i, variantSeed, signal));
      }

      return outputs;
    } catch (error) {
      throw classifyProviderError(error, {
        providerId: cfg.id,
        providerKind: 'comfyui',
        endpointUrl: baseUrl,
      });
    }
  }

  async generate(
    request: ProviderGenerateRequest,
    signal?: AbortSignal,
  ): Promise<ProviderOutput[]> {
    return this.runComfyPipeline(request, request.sketchRgba, null, signal);
  }

  async inpaint(request: ProviderInpaintRequest, signal?: AbortSignal): Promise<ProviderOutput[]> {
    const maskRgba = new Uint8ClampedArray(request.sketchWidth * request.sketchHeight * 4);
    for (let i = 0; i < request.mask.length; i++) {
      const val = (request.mask[i] ?? 0) === 1 ? 255 : 0;
      const px = i * 4;
      maskRgba[px] = val;
      maskRgba[px + 1] = val;
      maskRgba[px + 2] = val;
      maskRgba[px + 3] = 255;
    }
    return this.runComfyPipeline(request, request.baseImageRgba, maskRgba, signal);
  }
}
