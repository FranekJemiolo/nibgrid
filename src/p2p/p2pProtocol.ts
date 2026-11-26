import { z } from 'zod';
import { sha256Bytes } from '../processing/hash';

export const P2P_CHUNK_BYTES = 16384;

export const P2pMetaMessageSchema = z.object({
  type: z.literal('META'),
  filename: z.string().min(1).max(200),
  totalBytes: z.number().int().nonnegative(),
  totalChunks: z.number().int().positive(),
  sha256Hex: z.string().regex(/^[0-9a-f]{64}$/),
});

export const P2pCompleteMessageSchema = z.object({
  type: z.literal('COMPLETE'),
  sha256Hex: z.string().regex(/^[0-9a-f]{64}$/),
});

export const P2pAckMessageSchema = z.object({
  type: z.literal('ACK'),
  verified: z.boolean(),
});

export const P2pErrorMessageSchema = z.object({
  type: z.literal('ERROR'),
  reason: z.string().min(1).max(400),
});

export const P2pControlMessageSchema = z.discriminatedUnion('type', [
  P2pMetaMessageSchema,
  P2pCompleteMessageSchema,
  P2pAckMessageSchema,
  P2pErrorMessageSchema,
]);
export type P2pControlMessage = z.infer<typeof P2pControlMessageSchema>;

export interface P2pProgress {
  readonly receivedChunks: number;
  readonly totalChunks: number;
  readonly receivedBytes: number;
  readonly totalBytes: number;
  readonly percent: number;
}

export type P2pVerifyResult =
  | {
      readonly ok: true;
      readonly filename: string;
      readonly bytes: Uint8Array;
      readonly sha256Hex: string;
    }
  | {
      readonly ok: false;
      readonly reason: string;
    };

/**
 * Encodes a single binary frame with a 4-byte big-endian `Uint32` `chunkIndex` header.
 */
export function encodeChunkFrame(chunkIndex: number, slice: Uint8Array): Uint8Array {
  const frame = new Uint8Array(4 + slice.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint32(0, chunkIndex >>> 0, false);
  frame.set(slice, 4);
  return frame;
}

/**
 * Decodes a 4-byte big-endian `chunkIndex` frame back into index + payload slice.
 */
export function decodeChunkFrame(frame: Uint8Array): {
  readonly chunkIndex: number;
  readonly data: Uint8Array;
} {
  if (frame.byteLength < 4) {
    throw new Error(`Invalid P2P chunk frame length: ${frame.byteLength} bytes (expected >= 4).`);
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const chunkIndex = view.getUint32(0, false);
  return {
    chunkIndex,
    data: frame.subarray(4),
  };
}

/**
 * Splits a binary payload into deterministic framed chunks of at most `chunkSize` (16 KiB default).
 */
export function slicePayloadIntoFrames(
  bytes: Uint8Array,
  chunkSize = P2P_CHUNK_BYTES,
): Uint8Array[] {
  const effectiveSize = Math.max(1, Math.floor(chunkSize));
  if (bytes.byteLength === 0) {
    return [encodeChunkFrame(0, new Uint8Array(0))];
  }
  const totalChunks = Math.ceil(bytes.byteLength / effectiveSize);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < totalChunks; i += 1) {
    const start = i * effectiveSize;
    const end = Math.min(bytes.byteLength, start + effectiveSize);
    frames.push(encodeChunkFrame(i, bytes.subarray(start, end)));
  }
  return frames;
}

/**
 * Deterministic stateful receiver reassembling 16 KiB P2P frames into a single `Uint8Array`
 * and verifying exact SHA-256 integrity prior to committing.
 */
export class P2pReassembler {
  private meta: z.infer<typeof P2pMetaMessageSchema> | null = null;
  private chunks: (Uint8Array | null)[] = [];
  private receivedChunkCount = 0;
  private receivedByteCount = 0;

  acceptMeta(rawMeta: z.infer<typeof P2pMetaMessageSchema>): void {
    const validated = P2pMetaMessageSchema.parse(rawMeta);
    this.meta = validated;
    this.chunks = Array.from({ length: validated.totalChunks }, () => null);
    this.receivedChunkCount = 0;
    this.receivedByteCount = 0;
  }

  ingestFrame(frameBytes: Uint8Array): P2pProgress {
    if (!this.meta) {
      throw new Error('Cannot ingest P2P chunk before receiving META header.');
    }
    const { chunkIndex, data } = decodeChunkFrame(frameBytes);
    if (chunkIndex >= this.meta.totalChunks) {
      throw new Error(
        `Chunk index ${chunkIndex} out of bounds (expected < ${this.meta.totalChunks}).`,
      );
    }
    const prev = this.chunks[chunkIndex];
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    this.chunks[chunkIndex] = copy;

    if (prev === null || prev === undefined) {
      this.receivedChunkCount += 1;
      this.receivedByteCount += copy.byteLength;
    } else {
      this.receivedByteCount += copy.byteLength - prev.byteLength;
    }

    return this.getProgress();
  }

  getProgress(): P2pProgress {
    if (!this.meta) {
      return {
        receivedChunks: 0,
        totalChunks: 0,
        receivedBytes: 0,
        totalBytes: 0,
        percent: 0,
      };
    }
    const total = this.meta.totalBytes;
    const percent =
      total === 0
        ? this.receivedChunkCount === this.meta.totalChunks
          ? 100
          : 0
        : Math.min(100, Math.round((this.receivedByteCount / total) * 100));
    return {
      receivedChunks: this.receivedChunkCount,
      totalChunks: this.meta.totalChunks,
      receivedBytes: this.receivedByteCount,
      totalBytes: total,
      percent,
    };
  }

  async finalizeAndVerify(completeSha256Hex?: string): Promise<P2pVerifyResult> {
    if (!this.meta) {
      return { ok: false, reason: 'No META header was received.' };
    }
    if (completeSha256Hex && completeSha256Hex !== this.meta.sha256Hex) {
      return {
        ok: false,
        reason: `COMPLETE digest (${completeSha256Hex.slice(0, 12)}) does not match META digest (${this.meta.sha256Hex.slice(0, 12)}).`,
      };
    }
    if (this.receivedChunkCount !== this.meta.totalChunks) {
      return {
        ok: false,
        reason: `Incomplete transfer: received ${this.receivedChunkCount} of ${this.meta.totalChunks} chunks.`,
      };
    }
    if (this.receivedByteCount !== this.meta.totalBytes) {
      return {
        ok: false,
        reason: `Byte length mismatch: received ${this.receivedByteCount} bytes, expected ${this.meta.totalBytes}.`,
      };
    }

    const assembled = new Uint8Array(this.meta.totalBytes);
    let offset = 0;
    for (let i = 0; i < this.chunks.length; i += 1) {
      const chunk = this.chunks[i];
      if (!chunk) {
        return { ok: false, reason: `Missing chunk #${i} during assembly.` };
      }
      assembled.set(chunk, offset);
      offset += chunk.byteLength;
    }

    const actualSha = await sha256Bytes(assembled);
    if (actualSha !== this.meta.sha256Hex) {
      return {
        ok: false,
        reason: `SHA-256 verification failed (expected ${this.meta.sha256Hex.slice(0, 12)}, got ${actualSha.slice(0, 12)}).`,
      };
    }

    return {
      ok: true,
      filename: this.meta.filename,
      bytes: assembled,
      sha256Hex: actualSha,
    };
  }
}
