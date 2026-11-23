import type { ProviderConfig } from '../domain/schemas';
import { base64ToUint8 } from '../processing/png';
import { ProviderError, classifyProviderError } from '../providers/errors';
import { DEFAULT_GEMINI_BASE_URL } from '../providers/geminiProvider';
import { decodeWav16 } from './pcmPostProcess';
import { PROCEDURAL_SFX_RESPONSE_SCHEMA, parseAndClampSynthParams } from './synthResponseSchema';
import type { GoogleAudioRoute, PcmBuffer, ProceduralSfxParams } from './types';

export interface GoogleAudioCostEstimate {
  readonly estimatedUsd: number;
  readonly label: string;
}

export function estimateGoogleAudioCost(
  route: GoogleAudioRoute,
  modelId = '',
): GoogleAudioCostEstimate {
  switch (route) {
    case 'local-synth':
      return { estimatedUsd: 0, label: '$0.00 Local Synth' };
    case 'gemini-to-synth':
      return { estimatedUsd: 0.001, label: '~$0.001 Sprite-to-SFX' };
    case 'gemini-tts':
      return { estimatedUsd: 0.005, label: '~$0.005 Gemini TTS' };
    case 'lyria-clip':
      return { estimatedUsd: 0.04, label: '~$0.04 Lyria 3 Clip' };
    case 'lyria-full':
      return modelId === 'lyria-3-clip-preview'
        ? { estimatedUsd: 0.04, label: '~$0.04 Lyria 3 Clip' }
        : { estimatedUsd: 0.08, label: '~$0.08 Lyria 3.5' };
  }
}

export interface LyriaReferenceImage {
  readonly base64: string;
  readonly mimeType: string;
}

export function buildLyriaInteractionRequest(input: {
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly referenceImages?: readonly LyriaReferenceImage[];
}): { readonly url: string; readonly payload: Record<string, unknown> } {
  const base = (input.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const parts: Array<Record<string, unknown>> = [{ type: 'text', text: input.prompt }];

  const refs = (input.referenceImages ?? []).slice(0, input.modelId === 'lyria-3.5' ? 10 : 3);
  for (const ref of refs) {
    parts.push({
      type: 'image',
      data: ref.base64,
      mime_type: ref.mimeType || 'image/png',
    });
  }

  return {
    url: `${base}/interactions`,
    payload: {
      model: input.modelId,
      ...(input.modelId === 'lyria-3.5' ? { response_format: 'wav' } : {}),
      input: parts,
    },
  };
}

export function buildGeminiTtsRequest(input: {
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly voiceName: string;
  readonly styleDirection: string;
  readonly script: string;
}): { readonly url: string; readonly payload: Record<string, unknown> } {
  const base = (input.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
  const textPrompt = input.styleDirection.trim()
    ? `Style direction: ${input.styleDirection.trim()}\n\n${input.script}`
    : input.script;

  return {
    url: `${base}/models/${encodeURIComponent(input.modelId)}:generateContent`,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [{ text: textPrompt }],
        },
      ],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: input.voiceName || 'Fenrir',
            },
          },
        },
      },
    },
  };
}

export function buildGeminiToSynthRequest(input: {
  readonly baseUrl?: string;
  readonly modelId: string;
  readonly prompt: string;
  readonly spritePngBase64?: string;
}): { readonly url: string; readonly payload: Record<string, unknown> } {
  const base = baseUrlOrDefault(input.baseUrl).replace(/\/+$/, '');
  const parts: Array<Record<string, unknown>> = [
    {
      text: `${input.prompt}\n\nReturn ONLY JSON parameters conforming to ProceduralSfxParams.`,
    },
  ];
  if (input.spritePngBase64) {
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: input.spritePngBase64,
      },
    });
  }

  return {
    url: `${base}/models/${encodeURIComponent(input.modelId)}:generateContent`,
    payload: {
      contents: [{ role: 'user', parts }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: PROCEDURAL_SFX_RESPONSE_SCHEMA,
      },
    },
  };
}

function baseUrlOrDefault(url?: string): string {
  const trimmed = url?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_GEMINI_BASE_URL;
}

export function findGeminiAudioCredential(
  providers: readonly ProviderConfig[],
): { readonly providerId: string; readonly apiKey: string; readonly baseUrl: string } | null {
  const gemini = providers.find(
    (p) => p.kind === 'gemini' && p.enabled && p.apiKey.trim().length > 0,
  );
  if (gemini) {
    return {
      providerId: gemini.id,
      apiKey: gemini.apiKey.trim(),
      baseUrl: baseUrlOrDefault(gemini.endpointUrl),
    };
  }
  const anyGemini = providers.find((p) => p.kind === 'gemini' && p.apiKey.trim().length > 0);
  if (anyGemini) {
    return {
      providerId: anyGemini.id,
      apiKey: anyGemini.apiKey.trim(),
      baseUrl: baseUrlOrDefault(anyGemini.endpointUrl),
    };
  }
  return null;
}

function extractInlineAudioPart(
  payload: unknown,
): { readonly bytes: Uint8Array; readonly mimeType: string } | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;

  // 1. generateContent candidates format
  const candidates = Array.isArray(record.candidates) ? record.candidates : [];
  for (const cand of candidates) {
    const cObj = cand as { content?: { parts?: Array<Record<string, unknown>> } };
    for (const part of cObj.content?.parts ?? []) {
      const inline =
        (part.inlineData as { data?: string; mimeType?: string } | undefined) ??
        (part.inline_data as { data?: string; mime_type?: string } | undefined);
      if (inline?.data) {
        const mime =
          ('mimeType' in inline ? inline.mimeType : undefined) ??
          ('mime_type' in inline ? inline.mime_type : undefined) ??
          'audio/wav';
        return { bytes: base64ToUint8(inline.data), mimeType: mime };
      }
    }
  }

  // 2. interactions API outputs format
  const outputs = Array.isArray(record.outputs) ? record.outputs : [];
  for (const out of outputs) {
    const oObj = out as Record<string, unknown>;
    if (typeof oObj.data === 'string' && oObj.data.length > 0) {
      return {
        bytes: base64ToUint8(oObj.data),
        mimeType: typeof oObj.mime_type === 'string' ? oObj.mime_type : 'audio/mpeg',
      };
    }
    const contentArr = Array.isArray(oObj.content) ? oObj.content : [];
    for (const part of contentArr) {
      const pObj = part as Record<string, unknown>;
      if (typeof pObj.data === 'string' && pObj.data.length > 0) {
        return {
          bytes: base64ToUint8(pObj.data),
          mimeType: typeof pObj.mime_type === 'string' ? pObj.mime_type : 'audio/mpeg',
        };
      }
    }
  }

  return null;
}

export type GoogleAudioGenerationResult =
  | {
      readonly kind: 'synth-params';
      readonly params: ProceduralSfxParams;
      readonly modelId: string;
    }
  | {
      readonly kind: 'pcm';
      readonly pcm: PcmBuffer;
      readonly modelId: string;
    }
  | {
      readonly kind: 'encoded-bytes';
      readonly bytes: Uint8Array;
      readonly mimeType: string;
      readonly modelId: string;
    };

export async function invokeGoogleAudioRoute(input: {
  readonly route: Exclude<GoogleAudioRoute, 'local-synth'>;
  readonly modelId: string;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly providerId?: string;
  readonly prompt: string;
  readonly spritePngBase64?: string;
  readonly referenceImages?: readonly LyriaReferenceImage[];
  readonly voiceName?: string;
  readonly styleDirection?: string;
  readonly script?: string;
  readonly seed?: number;
  readonly signal?: AbortSignal;
}): Promise<GoogleAudioGenerationResult> {
  const providerId = input.providerId ?? 'gemini-audio';
  const baseUrl = baseUrlOrDefault(input.baseUrl);
  const secrets = [input.apiKey];

  let reqSpec: { readonly url: string; readonly payload: Record<string, unknown> };
  if (input.route === 'lyria-clip' || input.route === 'lyria-full') {
    reqSpec = buildLyriaInteractionRequest({
      baseUrl,
      modelId: input.modelId,
      prompt: input.prompt,
      referenceImages: input.referenceImages,
    });
  } else if (input.route === 'gemini-tts') {
    reqSpec = buildGeminiTtsRequest({
      baseUrl,
      modelId: input.modelId,
      voiceName: input.voiceName ?? 'Fenrir',
      styleDirection: input.styleDirection ?? '',
      script: input.script ?? input.prompt,
    });
  } else {
    reqSpec = buildGeminiToSynthRequest({
      baseUrl,
      modelId: input.modelId,
      prompt: input.prompt,
      spritePngBase64: input.spritePngBase64,
    });
  }

  let response: Response;
  try {
    response = await fetch(reqSpec.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': input.apiKey,
      },
      body: JSON.stringify(reqSpec.payload),
      signal: input.signal,
    });
  } catch (err) {
    throw classifyProviderError(err, {
      providerId,
      providerKind: 'gemini',
      endpointUrl: reqSpec.url,
      secrets,
    });
  }

  if (!response.ok) {
    const responseText = await response.text().catch(() => '');
    throw classifyProviderError(
      { status: response.status, responseText },
      {
        providerId,
        providerKind: 'gemini',
        endpointUrl: reqSpec.url,
        secrets,
      },
    );
  }

  const json = (await response.json()) as Record<string, unknown>;

  if (input.route === 'gemini-to-synth') {
    const candidates = Array.isArray(json.candidates) ? json.candidates : [];
    const firstPart = (
      candidates[0] as { content?: { parts?: Array<{ text?: string }> } } | undefined
    )?.content?.parts?.[0];
    if (!firstPart?.text) {
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        message: 'Gemini Sprite-to-SFX did not return ProceduralSfxParams JSON.',
        remediation: 'Verify model selection supports JSON responseSchema.',
        providerId,
        retryable: true,
      });
    }
    return {
      kind: 'synth-params',
      params: parseAndClampSynthParams(firstPart.text, input.seed ?? 1024),
      modelId: input.modelId,
    };
  }

  const audioPart = extractInlineAudioPart(json);
  if (!audioPart) {
    throw new ProviderError({
      code: 'INVALID_RESPONSE',
      message: `Google Audio route "${input.route}" returned no audio payload.`,
      remediation: 'Check API response payload format or retry with shorter prompt.',
      providerId,
      retryable: true,
    });
  }

  const isRiffWav =
    audioPart.bytes.byteLength >= 12 &&
    String.fromCharCode(...audioPart.bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...audioPart.bytes.slice(8, 12)) === 'WAVE';

  if (isRiffWav) {
    return {
      kind: 'pcm',
      pcm: decodeWav16(audioPart.bytes),
      modelId: input.modelId,
    };
  }

  return {
    kind: 'encoded-bytes',
    bytes: audioPart.bytes,
    mimeType: audioPart.mimeType,
    modelId: input.modelId,
  };
}
