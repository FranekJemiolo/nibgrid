import { strFromU8, strToU8, zlibSync } from 'fflate';
import { z } from 'zod';
import {
  DEFAULT_MAX_UNCOMPRESSED_BYTES,
  decodeBase64Url,
  encodeBase64Url,
  inflateWithLimit,
} from '../share/recipeUrlCodec';

export const SDP_OFFER_PREFIX = 'NIB-O1:' as const;
export const SDP_ANSWER_PREFIX = 'NIB-A1:' as const;

export const SdpPayloadSchema = z.object({
  type: z.enum(['offer', 'answer']),
  sdp: z.string().min(1),
});
export type SdpPayload = z.infer<typeof SdpPayloadSchema>;

export type DecodeSdpResult =
  | { readonly ok: true; readonly description: SdpPayload }
  | { readonly ok: false; readonly error: string };

/**
 * Compresses an SDP Offer/Answer into a compact copyable `NIB-O1:` or `NIB-A1:` string.
 */
export function encodeSdp(desc: { readonly type: string; readonly sdp?: string }): string {
  const validated = SdpPayloadSchema.parse({
    type: desc.type,
    sdp: desc.sdp ?? '',
  });
  const compressed = zlibSync(strToU8(JSON.stringify(validated)), { level: 9 });
  const prefix = validated.type === 'offer' ? SDP_OFFER_PREFIX : SDP_ANSWER_PREFIX;
  return `${prefix}${encodeBase64Url(compressed)}`;
}

/**
 * Decodes and validates a `NIB-O1:` or `NIB-A1:` SDP string with zip-bomb cap and prefix match check.
 */
export function decodeSdp(code: string): DecodeSdpResult {
  const trimmed = code.trim();
  let expectedType: 'offer' | 'answer' | null = null;
  let encodedPart = '';

  if (trimmed.startsWith(SDP_OFFER_PREFIX)) {
    expectedType = 'offer';
    encodedPart = trimmed.slice(SDP_OFFER_PREFIX.length);
  } else if (trimmed.startsWith(SDP_ANSWER_PREFIX)) {
    expectedType = 'answer';
    encodedPart = trimmed.slice(SDP_ANSWER_PREFIX.length);
  } else {
    return {
      ok: false,
      error: `Invalid SDP code prefix; expected "${SDP_OFFER_PREFIX}" or "${SDP_ANSWER_PREFIX}".`,
    };
  }

  const compressed = decodeBase64Url(encodedPart);
  if (!compressed) {
    return { ok: false, error: 'Corrupted Base64URL data in SDP code.' };
  }

  const inflated = inflateWithLimit(compressed, DEFAULT_MAX_UNCOMPRESSED_BYTES);
  if (!inflated) {
    return { ok: false, error: 'Failed to decompress SDP code or payload exceeded size limit.' };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(strFromU8(inflated));
  } catch {
    return { ok: false, error: 'Decompressed SDP payload is not valid JSON.' };
  }

  const res = SdpPayloadSchema.safeParse(parsedJson);
  if (!res.success) {
    return { ok: false, error: res.error.issues[0]?.message ?? 'Invalid SDP payload schema.' };
  }

  if (res.data.type !== expectedType) {
    return {
      ok: false,
      error: `SDP type "${res.data.type}" does not match prefix for "${expectedType}".`,
    };
  }

  return { ok: true, description: res.data };
}
