/**
 * Computes a lowercase hexadecimal SHA-256 digest for the provided raw byte buffer.
 * Uses the standard Web Crypto API available in browsers, Web Workers, and Node 20+.
 */
export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    const byte = view[i] ?? 0;
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}
