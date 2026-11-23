import { base64ToUint8, uint8ToBase64 } from '../processing/png';
import { ProviderError, classifyProviderError } from '../providers/errors';
import { DEFAULT_GEMINI_BASE_URL } from '../providers/geminiProvider';
import {
  CONTOUR_TIMBRE_RESPONSE_SCHEMA,
  type ContourTimbrePatch,
  parseAndClampContourPatch,
} from './contourPatchSchema';
import { buildGeminiTtsRequest } from './googleAudioProvider';
import { decodeWav16 } from './pcmPostProcess';
import type { PcmBuffer } from './types';
import type { MelodySummary } from './vocalAnalyzer';

export type HumToSoundRoute = 'local-contour' | 'hum-to-timbre' | 'hum-to-lyria' | 'hum-to-tts';

export function estimateHumRouteCost(route: HumToSoundRoute): {
  readonly estimatedUsd: number;
  readonly label: string;
} {
  switch (route) {
    case 'local-contour':
      return { estimatedUsd: 0, label: '$0.00 Local Follow' };
    case 'hum-to-timbre':
      return { estimatedUsd: 0.001, label: '~$0.001 Gemini Timbre' };
    case 'hum-to-lyria':
      return { estimatedUsd: 0.04, label: '~$0.04 Lyria 3 Clip' };
    case 'hum-to-tts':
      return { estimatedUsd: 0.005, label: '~$0.005 Gemini TTS' };
  }
}

function normalizeBaseUrl(baseUrl?: string): string {
  const trimmed = baseUrl?.trim();
  return (trimmed && trimmed.length > 0 ? trimmed : DEFAULT_GEMINI_BASE_URL).replace(/\/+$/, '');
}

/**
 * Route A builder: sends trimmed hum.wav + prompt to Gemini Flash returning ContourTimbrePatch JSON.
 */
export function buildHumToTimbreRequest(input: {
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly prompt: string;
  readonly humWavBase64: string;
}): { readonly url: string; readonly payload: Record<string, unknown> } {
  const base = normalizeBaseUrl(input.baseUrl);
  const model = input.modelId?.trim() || 'gemini-2.5-flash';

  return {
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `Listen to this vocal/mouth-foley audio sketch and design a ContourTimbrePatch JSON matching "${input.prompt.trim() || 'retro game sound'}". ` +
                'Preserve the vocal contour timing via local pitch/amplitude following; choose oscShape, octaveShift (-3..+3), scaleQuantize, FM grit, and unvoicedNoiseGain for mouth noise bursts.',
            },
            {
              inlineData: {
                mimeType: 'audio/wav',
                data: input.humWavBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: CONTOUR_TIMBRE_RESPONSE_SCHEMA,
      },
    },
  };
}

/**
 * Route B builder: compiles extracted melody BPM + key into Lyria 3 / 3.5 Interactions payload.
 */
export function buildHumToLyriaInteractionRequest(input: {
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly prompt: string;
  readonly melodySummary: MelodySummary;
  readonly humWavBase64?: string;
}): { readonly url: string; readonly payload: Record<string, unknown> } {
  const base = normalizeBaseUrl(input.baseUrl);
  const model = input.modelId?.trim() || 'lyria-3-clip-preview';
  const compiledPrompt =
    `${input.prompt.trim() || 'Retro 2D game soundtrack loop'}. ` +
    `Target ${input.melodySummary.detectedBpm} BPM, key of ${input.melodySummary.dominantKey}, steady quantized rhythm, instrumental only, no vocals, seamless game loop without fade-out.`;

  const inputs: Array<Record<string, unknown>> = [{ type: 'text', text: compiledPrompt }];
  if (input.humWavBase64) {
    inputs.push({
      type: 'audio',
      data: input.humWavBase64,
      mime_type: 'audio/wav',
    });
  }

  return {
    url: `${base}/interactions`,
    payload: {
      model,
      input: inputs,
    },
  };
}

export const CADENCE_TO_TTS_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    voiceName: { type: 'STRING' },
    styleDirection: { type: 'STRING' },
    script: { type: 'STRING' },
  },
  required: ['voiceName', 'styleDirection', 'script'],
} as const;

export function buildHumCadenceTranscribeRequest(input: {
  readonly baseUrl?: string;
  readonly modelId?: string;
  readonly prompt: string;
  readonly humWavBase64: string;
}): { readonly url: string; readonly payload: Record<string, unknown> } {
  const base = normalizeBaseUrl(input.baseUrl);
  const model = input.modelId?.trim() || 'gemini-2.5-flash';

  return {
    url: `${base}/models/${encodeURIComponent(model)}:generateContent`,
    payload: {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text:
                `Analyze this vocal cadence / mumble sketch and transform it into a studio character voice direction and short script matching "${input.prompt.trim() || 'gritty warrior combat bark'}". ` +
                'Only use allowed vocal tags (<grunt>, <gasp>, <chuckle>, <sigh>, <pause>) and pick voiceName from [Fenrir, Puck, Charon, Kore, Aoede].',
            },
            {
              inlineData: {
                mimeType: 'audio/wav',
                data: input.humWavBase64,
              },
            },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: CADENCE_TO_TTS_RESPONSE_SCHEMA,
      },
    },
  };
}

export interface CadenceTtsExtraction {
  readonly voiceName: string;
  readonly styleDirection: string;
  readonly script: string;
}

export function buildHumToTtsStepRequest(input: {
  readonly baseUrl?: string;
  readonly ttsModelId?: string;
  readonly cadence: CadenceTtsExtraction;
}) {
  return buildGeminiTtsRequest({
    baseUrl: input.baseUrl,
    modelId: input.ttsModelId || 'gemini-3.8-flash-tts',
    voiceName: input.cadence.voiceName || 'Fenrir',
    styleDirection: input.cadence.styleDirection || 'Expressive game character exertion',
    script: input.cadence.script || '<grunt> Hmph!',
  });
}

export type HumRouteExecutionResult =
  | {
      readonly kind: 'timbre-patch';
      readonly patch: ContourTimbrePatch;
      readonly modelId: string;
    }
  | {
      readonly kind: 'pcm';
      readonly pcm: PcmBuffer;
      readonly modelId: string;
      readonly ttsMeta?: CadenceTtsExtraction;
    }
  | {
      readonly kind: 'encoded-bytes';
      readonly bytes: Uint8Array;
      readonly mimeType: string;
      readonly modelId: string;
    };

async function postGeminiJson(
  url: string,
  payload: Record<string, unknown>,
  apiKey: string,
  providerId: string,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const secrets = [apiKey];
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify(payload),
      signal,
    });
  } catch (err) {
    throw classifyProviderError(err, {
      providerId,
      providerKind: 'gemini',
      endpointUrl: url,
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
        endpointUrl: url,
        secrets,
      },
    );
  }

  return (await response.json()) as Record<string, unknown>;
}

function extractFirstTextPart(json: Record<string, unknown>): string | null {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
  const parts = (candidates[0] as { content?: { parts?: Array<{ text?: string }> } } | undefined)
    ?.content?.parts;
  return parts?.[0]?.text ?? null;
}

function extractInlineAudioBytes(
  json: Record<string, unknown>,
): { readonly bytes: Uint8Array; readonly mimeType: string } | null {
  const candidates = Array.isArray(json.candidates) ? json.candidates : [];
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

  const outputs = Array.isArray(json.outputs) ? json.outputs : [];
  for (const out of outputs) {
    const oObj = out as Record<string, unknown>;
    if (typeof oObj.data === 'string' && oObj.data.length > 0) {
      return {
        bytes: base64ToUint8(oObj.data),
        mimeType: typeof oObj.mime_type === 'string' ? oObj.mime_type : 'audio/mpeg',
      };
    }
  }

  return null;
}

export async function invokeHumToSoundRoute(input: {
  readonly route: Exclude<HumToSoundRoute, 'local-contour'>;
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly providerId?: string;
  readonly prompt: string;
  readonly humWavBytes: Uint8Array;
  readonly melodySummary: MelodySummary;
  readonly signal?: AbortSignal;
}): Promise<HumRouteExecutionResult> {
  const providerId = input.providerId ?? 'gemini-hum-audio';
  const humWavBase64 = uint8ToBase64(input.humWavBytes);

  if (input.route === 'hum-to-timbre') {
    const modelId = 'gemini-2.5-flash';
    const req = buildHumToTimbreRequest({
      baseUrl: input.baseUrl,
      modelId,
      prompt: input.prompt,
      humWavBase64,
    });
    const json = await postGeminiJson(req.url, req.payload, input.apiKey, providerId, input.signal);
    const text = extractFirstTextPart(json);
    if (!text) {
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        message: 'Gemini Timbre design returned no JSON patch.',
        remediation: 'Retry with a clearer sound design prompt.',
        providerId,
        retryable: true,
      });
    }
    return {
      kind: 'timbre-patch',
      patch: parseAndClampContourPatch(text),
      modelId,
    };
  }

  if (input.route === 'hum-to-lyria') {
    const modelId = 'lyria-3-clip-preview';
    const req = buildHumToLyriaInteractionRequest({
      baseUrl: input.baseUrl,
      modelId,
      prompt: input.prompt,
      melodySummary: input.melodySummary,
      humWavBase64,
    });
    const json = await postGeminiJson(req.url, req.payload, input.apiKey, providerId, input.signal);
    const audio = extractInlineAudioBytes(json);
    if (!audio) {
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        message: 'Lyria returned no audio payload for vocal melody sketch.',
        remediation: 'Check Lyria interaction quota or switch to Local Follow.',
        providerId,
        retryable: true,
      });
    }
    const isWav =
      audio.bytes.byteLength >= 44 &&
      String.fromCharCode(...audio.bytes.slice(0, 4)) === 'RIFF' &&
      String.fromCharCode(...audio.bytes.slice(8, 12)) === 'WAVE';
    return isWav
      ? { kind: 'pcm', pcm: decodeWav16(audio.bytes), modelId }
      : { kind: 'encoded-bytes', bytes: audio.bytes, mimeType: audio.mimeType, modelId };
  }

  // Route C: Hum Cadence -> Gemini Flash cadence extraction -> Gemini 3.8 TTS
  const cadenceReq = buildHumCadenceTranscribeRequest({
    baseUrl: input.baseUrl,
    modelId: 'gemini-2.5-flash',
    prompt: input.prompt,
    humWavBase64,
  });
  const cadenceJson = await postGeminiJson(
    cadenceReq.url,
    cadenceReq.payload,
    input.apiKey,
    providerId,
    input.signal,
  );
  const cadenceText = extractFirstTextPart(cadenceJson);
  let cadence: CadenceTtsExtraction = {
    voiceName: 'Fenrir',
    styleDirection: 'Short punchy game warrior vocal exertion',
    script: '<grunt> Agh!',
  };
  if (cadenceText) {
    try {
      const parsed = JSON.parse(cadenceText) as Partial<CadenceTtsExtraction>;
      cadence = {
        voiceName:
          typeof parsed.voiceName === 'string' && parsed.voiceName ? parsed.voiceName : 'Fenrir',
        styleDirection:
          typeof parsed.styleDirection === 'string' && parsed.styleDirection
            ? parsed.styleDirection
            : cadence.styleDirection,
        script: typeof parsed.script === 'string' && parsed.script ? parsed.script : cadence.script,
      };
    } catch {
      // Fall back to default stylized script
    }
  }

  const ttsModelId = 'gemini-3.8-flash-tts';
  const ttsReq = buildHumToTtsStepRequest({
    baseUrl: input.baseUrl,
    ttsModelId,
    cadence,
  });
  const ttsJson = await postGeminiJson(
    ttsReq.url,
    ttsReq.payload,
    input.apiKey,
    providerId,
    input.signal,
  );
  const ttsAudio = extractInlineAudioBytes(ttsJson);
  if (!ttsAudio) {
    throw new ProviderError({
      code: 'INVALID_RESPONSE',
      message: 'Gemini 3.8 TTS returned no audio payload for vocal cadence.',
      remediation: 'Retry with a simpler vocal script.',
      providerId,
      retryable: true,
    });
  }
  const isWav =
    ttsAudio.bytes.byteLength >= 44 &&
    String.fromCharCode(...ttsAudio.bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...ttsAudio.bytes.slice(8, 12)) === 'WAVE';
  return isWav
    ? { kind: 'pcm', pcm: decodeWav16(ttsAudio.bytes), modelId: ttsModelId, ttsMeta: cadence }
    : {
        kind: 'encoded-bytes',
        bytes: ttsAudio.bytes,
        mimeType: ttsAudio.mimeType,
        modelId: ttsModelId,
      };
}
