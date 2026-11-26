import { Unzlib, strFromU8, strToU8, zlibSync } from 'fflate';
import { z } from 'zod';
import {
  ArtBibleSchema,
  BitmapFontConfigSchema,
  ProceduralSfxParamsSchema,
  ShaderConfigSchema,
  VfxFlipbookConfigSchema,
} from '../domain/schemas';

export const SHARE_HASH_PREFIX = '#share=v1.' as const;
export const MAX_SHARE_HASH_CHARS = 8192;
export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 65536;

export const ShareableShaderRecipeSchema = z.object({
  kind: z.literal('shader'),
  name: z.string().trim().min(1).max(120),
  shaderConfig: ShaderConfigSchema,
});

export const ShareableVfxRecipeSchema = z.object({
  kind: z.literal('vfx'),
  name: z.string().trim().min(1).max(120),
  vfxFlipbook: VfxFlipbookConfigSchema,
});

export const ShareableBmfontRecipeSchema = z.object({
  kind: z.literal('bmfont'),
  name: z.string().trim().min(1).max(120),
  bitmapFont: BitmapFontConfigSchema,
});

export const ShareableProceduralSfxRecipeSchema = z.object({
  kind: z.literal('procedural-sfx'),
  name: z.string().trim().min(1).max(120),
  synthParams: ProceduralSfxParamsSchema,
});

export const ShareableArtBibleRecipeSchema = z.object({
  kind: z.literal('art-bible'),
  name: z.string().trim().min(1).max(120),
  artBible: ArtBibleSchema,
});

export const ShareableRecipeSchema = z.discriminatedUnion('kind', [
  ShareableShaderRecipeSchema,
  ShareableVfxRecipeSchema,
  ShareableBmfontRecipeSchema,
  ShareableProceduralSfxRecipeSchema,
  ShareableArtBibleRecipeSchema,
]);
export type ShareableRecipe = z.infer<typeof ShareableRecipeSchema>;

export type DecodeRecipeResult =
  | { readonly ok: true; readonly recipe: ShareableRecipe; readonly hashLength: number }
  | { readonly ok: false; readonly error: string };

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64_LOOKUP = (() => {
  const table = new Int16Array(256).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

export function encodeBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;

    out += B64_ALPHABET.charAt((b0 >> 2) & 0x3f);
    out += B64_ALPHABET.charAt(((b0 & 0x03) << 4) | ((b1 >> 4) & 0x0f));
    if (hasB1) {
      out += B64_ALPHABET.charAt(((b1 & 0x0f) << 2) | ((b2 >> 6) & 0x03));
    }
    if (hasB2) {
      out += B64_ALPHABET.charAt(b2 & 0x3f);
    }
  }
  return out;
}

export function decodeBase64Url(encoded: string): Uint8Array | null {
  const clean = encoded.replace(/=+$/, '');
  if (clean.length === 0 || clean.length % 4 === 1) {
    return null;
  }
  const byteLen = Math.floor((clean.length * 3) / 4);
  const out = new Uint8Array(byteLen);
  let outIdx = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = clean.charCodeAt(i);
    const c1 = clean.charCodeAt(i + 1);
    const c2 = i + 2 < clean.length ? clean.charCodeAt(i + 2) : -1;
    const c3 = i + 3 < clean.length ? clean.charCodeAt(i + 3) : -1;

    const v0 = c0 < 256 ? (B64_LOOKUP[c0] ?? -1) : -1;
    const v1 = c1 < 256 ? (B64_LOOKUP[c1] ?? -1) : -1;
    const v2 = c2 >= 0 && c2 < 256 ? (B64_LOOKUP[c2] ?? -1) : c2 === -1 ? -2 : -1;
    const v3 = c3 >= 0 && c3 < 256 ? (B64_LOOKUP[c3] ?? -1) : c3 === -1 ? -2 : -1;

    if (v0 < 0 || v1 < 0 || v2 === -1 || v3 === -1) {
      return null;
    }

    out[outIdx++] = (v0 << 2) | (v1 >> 4);
    if (v2 >= 0) {
      out[outIdx++] = ((v1 & 0x0f) << 4) | (v2 >> 2);
      if (v3 >= 0) {
        out[outIdx++] = ((v2 & 0x03) << 6) | v3;
      }
    }
  }

  return out;
}

/**
 * Pure-TS bounded zlib inflation guard preventing oversized / zip-bomb hash payloads.
 */
export function inflateWithLimit(
  compressed: Uint8Array,
  maxUncompressedBytes = DEFAULT_MAX_UNCOMPRESSED_BYTES,
): Uint8Array | null {
  let totalBytes = 0;
  let exceeded = false;
  let failed = false;
  const chunks: Uint8Array[] = [];

  try {
    const stream = new Unzlib((chunk, _final) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxUncompressedBytes) {
        exceeded = true;
        return;
      }
      chunks.push(chunk);
    });
    stream.push(compressed, true);
  } catch {
    failed = true;
  }

  if (failed || exceeded || totalBytes === 0) {
    return null;
  }

  const out = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/**
 * Compresses and encodes a deterministic zero-blob recipe into `#share=v1.<base64url>`.
 * Enforces an 8192-char URL safety budget.
 */
export function encodeRecipeToHash(payload: ShareableRecipe): string {
  const validated = ShareableRecipeSchema.parse(payload);
  const jsonBytes = strToU8(JSON.stringify(validated));
  const compressed = zlibSync(jsonBytes, { level: 9 });
  const encoded = `${SHARE_HASH_PREFIX}${encodeBase64Url(compressed)}`;
  if (encoded.length > MAX_SHARE_HASH_CHARS) {
    throw new Error(
      `Shared recipe hash is ${encoded.length} chars (exceeds ${MAX_SHARE_HASH_CHARS}-char URL limit). Trim oversized comments or palettes.`,
    );
  }
  return encoded;
}

/**
 * Decodes and Zod-validates a `#share=v1.<base64url>` hash safely with zip-bomb caps
 * and without throwing unhandled exceptions on malformed input.
 */
export function decodeRecipeFromHash(
  hash: string,
  options?: { readonly maxUncompressedBytes?: number },
): DecodeRecipeResult {
  const trimmed = hash.trim();
  if (!trimmed.startsWith(SHARE_HASH_PREFIX)) {
    return { ok: false, error: `Hash must start with "${SHARE_HASH_PREFIX}".` };
  }
  if (trimmed.length > MAX_SHARE_HASH_CHARS * 2) {
    return { ok: false, error: 'Share link exceeds safe URL length limit.' };
  }

  const encodedPart = trimmed.slice(SHARE_HASH_PREFIX.length);
  const compressed = decodeBase64Url(encodedPart);
  if (!compressed) {
    return { ok: false, error: 'Corrupted or invalid Base64URL share payload.' };
  }

  const inflated = inflateWithLimit(
    compressed,
    options?.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES,
  );
  if (!inflated) {
    return {
      ok: false,
      error: 'Failed to decompress share payload or payload exceeded size limit.',
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(strFromU8(inflated));
  } catch {
    return { ok: false, error: 'Decompressed share payload is not valid JSON.' };
  }

  const result = ShareableRecipeSchema.safeParse(parsedJson);
  if (!result.success) {
    return { ok: false, error: result.error.issues[0]?.message ?? 'Invalid shared recipe schema.' };
  }

  return {
    ok: true,
    recipe: result.data,
    hashLength: trimmed.length,
  };
}
