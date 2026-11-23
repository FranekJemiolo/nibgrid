import { quantizeToPaletteOklab } from './paletteQuantize';

export interface GifFrameInput {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  delayMs?: number;
}

export interface EncodeGifOptions {
  fps?: number;
  loop?: boolean;
  pingPong?: boolean;
}

const GIF_LZW_HASH_SIZE = 16381;

class ByteWriter {
  private buf: Uint8Array;
  private len = 0;

  constructor(initialCapacity = 8192) {
    this.buf = new Uint8Array(initialCapacity);
  }

  private ensureCapacity(extra: number): void {
    const required = this.len + extra;
    if (required <= this.buf.length) return;
    let nextCap = this.buf.length * 2;
    while (nextCap < required) {
      nextCap *= 2;
    }
    const next = new Uint8Array(nextCap);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  writeByte(b: number): void {
    this.ensureCapacity(1);
    this.buf[this.len++] = b & 0xff;
  }

  writeBytes(bytes: readonly number[] | Uint8Array): void {
    this.ensureCapacity(bytes.length);
    for (let i = 0; i < bytes.length; i++) {
      this.buf[this.len++] = (bytes[i] ?? 0) & 0xff;
    }
  }

  writeUint16LE(value: number): void {
    this.ensureCapacity(2);
    this.buf[this.len++] = value & 0xff;
    this.buf[this.len++] = (value >>> 8) & 0xff;
  }

  writeAscii(text: string): void {
    this.ensureCapacity(text.length);
    for (let i = 0; i < text.length; i++) {
      this.buf[this.len++] = text.charCodeAt(i) & 0xff;
    }
  }

  toUint8Array(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

interface GlobalColorTable {
  gctBytes: Uint8Array;
  colorLookup: Map<number, number>;
  paletteRgb: Uint8Array;
  opaqueCount: number;
}

function buildFallbackCubePalette(): Uint8Array {
  // 255 opaque colors: 6x7x6 uniform RGB cube (252) + 3 mid-gray shades; index 0 reserved for transparency
  const table = new Uint8Array(256 * 3);
  let idx = 1;
  for (let r = 0; r < 6; r++) {
    const rv = Math.round((r / 5) * 255);
    for (let g = 0; g < 7; g++) {
      const gv = Math.round((g / 6) * 255);
      for (let b = 0; b < 6; b++) {
        const bv = Math.round((b / 5) * 255);
        const off = idx * 3;
        table[off] = rv;
        table[off + 1] = gv;
        table[off + 2] = bv;
        idx++;
      }
    }
  }
  const grays = [64, 128, 192];
  for (const g of grays) {
    const off = idx * 3;
    table[off] = g;
    table[off + 1] = g;
    table[off + 2] = g;
    idx++;
  }
  return table;
}

function buildGlobalColorTable(frames: readonly GifFrameInput[]): GlobalColorTable {
  const uniqueRgb = new Map<number, number>();
  for (const frame of frames) {
    const d = frame.rgba;
    for (let i = 0; i < d.length; i += 4) {
      if ((d[i + 3] ?? 0) < 128) continue;
      const key = ((d[i] ?? 0) << 16) | ((d[i + 1] ?? 0) << 8) | (d[i + 2] ?? 0);
      if (!uniqueRgb.has(key)) {
        uniqueRgb.set(key, uniqueRgb.size + 1);
      }
    }
  }

  if (uniqueRgb.size <= 255) {
    const gctBytes = new Uint8Array(256 * 3);
    for (const [key, idx] of uniqueRgb.entries()) {
      const off = idx * 3;
      gctBytes[off] = (key >>> 16) & 0xff;
      gctBytes[off + 1] = (key >>> 8) & 0xff;
      gctBytes[off + 2] = key & 0xff;
    }
    return {
      gctBytes,
      colorLookup: uniqueRgb,
      paletteRgb: gctBytes,
      opaqueCount: uniqueRgb.size,
    };
  }

  // > 255 opaque colors: quantize cleanly into 6x7x6 cube + grays
  const paletteRgb = buildFallbackCubePalette();
  return {
    gctBytes: paletteRgb,
    colorLookup: new Map<number, number>(),
    paletteRgb,
    opaqueCount: 255,
  };
}

function mapFrameToColorIndices(
  rgba: Uint8ClampedArray,
  pixelCount: number,
  table: GlobalColorTable,
): Uint8Array {
  const indexed = new Uint8Array(pixelCount);
  const { colorLookup, paletteRgb, opaqueCount } = table;

  for (let i = 0; i < pixelCount; i++) {
    const px = i * 4;
    if ((rgba[px + 3] ?? 0) < 128) {
      indexed[i] = 0;
      continue;
    }
    const r = rgba[px] ?? 0;
    const g = rgba[px + 1] ?? 0;
    const b = rgba[px + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;

    const cached = colorLookup.get(key);
    if (cached !== undefined) {
      indexed[i] = cached;
      continue;
    }

    let bestIdx = 1;
    let bestDist = Number.POSITIVE_INFINITY;
    for (let c = 1; c <= opaqueCount; c++) {
      const off = c * 3;
      const dr = r - (paletteRgb[off] ?? 0);
      const dg = g - (paletteRgb[off + 1] ?? 0);
      const db = b - (paletteRgb[off + 2] ?? 0);
      const dist = dr * dr + dg * dg + db * db;
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = c;
        if (dist === 0) break;
      }
    }
    colorLookup.set(key, bestIdx);
    indexed[i] = bestIdx;
  }

  return indexed;
}

function writeLzwImageData(writer: ByteWriter, indexedPixels: Uint8Array): void {
  const minCodeSize = 8;
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;

  writer.writeByte(minCodeSize);

  const subBlock = new Uint8Array(255);
  let subLen = 0;
  let bitBuffer = 0;
  let bitCount = 0;

  const flushSubBlock = () => {
    if (subLen === 0) return;
    writer.writeByte(subLen);
    writer.writeBytes(subBlock.subarray(0, subLen));
    subLen = 0;
  };

  const emitCode = (code: number, size: number) => {
    bitBuffer |= (code & ((1 << size) - 1)) << bitCount;
    bitCount += size;
    while (bitCount >= 8) {
      subBlock[subLen++] = bitBuffer & 0xff;
      if (subLen === 255) {
        flushSubBlock();
      }
      bitBuffer >>>= 8;
      bitCount -= 8;
    }
  };

  const keys = new Int32Array(GIF_LZW_HASH_SIZE);
  const codes = new Uint16Array(GIF_LZW_HASH_SIZE);
  keys.fill(-1);

  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;

  emitCode(clearCode, codeSize);

  let prefix = indexedPixels[0] ?? 0;
  for (let i = 1; i < indexedPixels.length; i++) {
    const pixel = indexedPixels[i] ?? 0;
    const key = (prefix << 8) | pixel;
    let slot = ((key * 2654435761) >>> 0) % GIF_LZW_HASH_SIZE;

    let found = -1;
    while (keys[slot] !== -1) {
      if (keys[slot] === key) {
        found = codes[slot] ?? -1;
        break;
      }
      slot = (slot + 1) % GIF_LZW_HASH_SIZE;
    }

    if (found !== -1) {
      prefix = found;
      continue;
    }

    emitCode(prefix, codeSize);

    if (nextCode < 4096) {
      keys[slot] = key;
      codes[slot] = nextCode;
      nextCode += 1;
      if (nextCode > 1 << codeSize && codeSize < 12) {
        codeSize += 1;
      }
    } else {
      emitCode(clearCode, codeSize);
      keys.fill(-1);
      codeSize = minCodeSize + 1;
      nextCode = eoiCode + 1;
    }

    prefix = pixel;
  }

  emitCode(prefix, codeSize);
  if (nextCode >= 1 << codeSize && codeSize < 12) {
    codeSize += 1;
  }
  emitCode(eoiCode, codeSize);

  if (bitCount > 0) {
    subBlock[subLen++] = bitBuffer & 0xff;
  }
  flushSubBlock();
  writer.writeByte(0); // Image data terminator
}

function expandPingPongFrames(frames: readonly GifFrameInput[]): readonly GifFrameInput[] {
  if (frames.length <= 2) return frames;
  const sequence = [...frames];
  for (let i = frames.length - 2; i >= 1; i--) {
    const mirror = frames[i];
    if (mirror) {
      sequence.push(mirror);
    }
  }
  return sequence;
}

/**
 * Pure-TS deterministic Animated GIF89a encoder with per-frame transparency (index 0),
 * disposal method 2 (no ghosting), and Netscape 2.0 infinite-loop extension.
 */
export function encodeAnimatedGif(
  frames: readonly GifFrameInput[],
  options: EncodeGifOptions = {},
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('Cannot encode GIF: at least one frame is required.');
  }

  const first = frames[0]!;
  const { width, height } = first;
  if (width <= 0 || height <= 0 || width > 65535 || height > 65535) {
    throw new Error(`Invalid GIF dimensions: ${width}x${height}`);
  }

  const expectedLen = width * height * 4;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.width !== width || f.height !== height) {
      throw new Error(
        `All GIF frames must match ${width}x${height}; frame ${i} is ${f.width}x${f.height}`,
      );
    }
    if (f.rgba.length !== expectedLen) {
      throw new Error(
        `Frame ${i} RGBA length mismatch: expected ${expectedLen}, got ${f.rgba.length}`,
      );
    }
  }

  const sequence = options.pingPong ? expandPingPongFrames(frames) : frames;
  const fps = Math.max(1, Math.min(50, options.fps ?? 6));
  const defaultDelayMs = Math.round(1000 / fps);

  const colorTable = buildGlobalColorTable(sequence);
  const writer = new ByteWriter(Math.max(4096, sequence.length * width * height));

  // Header & Logical Screen Descriptor
  writer.writeAscii('GIF89a');
  writer.writeUint16LE(width);
  writer.writeUint16LE(height);
  writer.writeByte(0xf7); // 256-entry GCT, 8-bit color resolution
  writer.writeByte(0); // Background color index 0
  writer.writeByte(0); // Pixel aspect ratio
  writer.writeBytes(colorTable.gctBytes);

  // Netscape 2.0 looping application extension
  if (options.loop !== false) {
    writer.writeBytes([0x21, 0xff, 0x0b]);
    writer.writeAscii('NETSCAPE2.0');
    writer.writeBytes([0x03, 0x01, 0x00, 0x00, 0x00]);
  }

  const pixelCount = width * height;
  for (const frame of sequence) {
    const delayCs = Math.max(2, Math.round((frame.delayMs ?? defaultDelayMs) / 10));

    // Graphic Control Extension: disposal=2 (restore bg), transparent flag=1, index=0
    writer.writeBytes([0x21, 0xf9, 0x04, 0x09]);
    writer.writeUint16LE(delayCs);
    writer.writeByte(0); // Transparent index 0
    writer.writeByte(0); // Terminator

    // Image Descriptor
    writer.writeByte(0x2c);
    writer.writeUint16LE(0);
    writer.writeUint16LE(0);
    writer.writeUint16LE(width);
    writer.writeUint16LE(height);
    writer.writeByte(0); // Use Global Color Table, non-interlaced

    const indexed = mapFrameToColorIndices(frame.rgba, pixelCount, colorTable);
    writeLzwImageData(writer, indexed);
  }

  writer.writeByte(0x3b); // GIF trailer
  return writer.toUint8Array();
}

export function gifBytesToBlob(bytes: Uint8Array): Blob {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: 'image/gif' });
}

/**
 * Composites N same-sized RGBA animation frames side-by-side into a horizontal
 * `(N * width) x height` spritesheet strip buffer.
 */
export function composeSpritesheetStrip(frames: readonly GifFrameInput[]): {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
} {
  if (frames.length === 0) {
    throw new Error('Cannot compose spritesheet: at least one frame is required.');
  }
  const first = frames[0]!;
  const { width, height } = first;
  const expectedLen = width * height * 4;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    if (f.width !== width || f.height !== height || f.rgba.length !== expectedLen) {
      throw new Error(`Spritesheet frame ${i} dimension or buffer mismatch.`);
    }
  }

  const stripWidth = width * frames.length;
  const strip = new Uint8ClampedArray(stripWidth * height * 4);

  for (let fIdx = 0; fIdx < frames.length; fIdx++) {
    const frameRgba = frames[fIdx]!.rgba;
    const xOffset = fIdx * width;
    for (let y = 0; y < height; y++) {
      const srcStart = y * width * 4;
      const dstStart = (y * stripWidth + xOffset) * 4;
      strip.set(frameRgba.subarray(srcStart, srcStart + width * 4), dstStart);
    }
  }

  return { rgba: strip, width: stripWidth, height };
}

export function applyPaletteSnapIfNeeded(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  paletteHex: readonly string[],
): Uint8ClampedArray {
  return quantizeToPaletteOklab(rgba, width, height, paletteHex);
}
