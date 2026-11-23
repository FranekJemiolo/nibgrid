const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    const entry = CRC_TABLE[(c ^ (bytes[i] ?? 0)) & 0xff] ?? 0;
    c = entry ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let s1 = 1;
  let s2 = 0;
  const mod = 65521;
  for (let i = 0; i < bytes.length; i++) {
    s1 = (s1 + (bytes[i] ?? 0)) % mod;
    s2 = (s2 + s1) % mod;
  }
  return ((s2 << 16) | s1) >>> 0;
}

function writeU32BE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function makeChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(4 + 4 + data.length + 4);
  writeU32BE(chunk, 0, data.length);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  writeU32BE(chunk, 8 + data.length, crc32(crcInput));
  return chunk;
}

function deflateStoredZlib(rawScanlines: Uint8Array): Uint8Array {
  const maxBlock = 65535;
  const blockCount = Math.max(1, Math.ceil(rawScanlines.length / maxBlock));
  const totalSize = 2 + rawScanlines.length + blockCount * 5 + 4;
  const out = new Uint8Array(totalSize);

  // Zlib header: CM=8 (deflate), CINFO=7 (32K window), FCHECK bits for 0x7801
  out[0] = 0x78;
  out[1] = 0x01;

  let pos = 2;
  let offset = 0;
  for (let blockIdx = 0; blockIdx < blockCount; blockIdx++) {
    const remaining = rawScanlines.length - offset;
    const len = Math.min(maxBlock, remaining);
    const isFinal = blockIdx === blockCount - 1 ? 1 : 0;

    out[pos++] = isFinal;
    out[pos++] = len & 0xff;
    out[pos++] = (len >>> 8) & 0xff;
    const nlen = ~len & 0xffff;
    out[pos++] = nlen & 0xff;
    out[pos++] = (nlen >>> 8) & 0xff;

    if (len > 0) {
      out.set(rawScanlines.subarray(offset, offset + len), pos);
      pos += len;
      offset += len;
    }
  }

  writeU32BE(out, pos, adler32(rawScanlines));
  return out;
}

/**
 * Deterministically encodes an RGBA pixel buffer into a valid PNG byte stream
 * without browser canvas dependencies, producing byte-identical outputs in Node and Browser.
 */
export function encodeRgbaToPngBytes(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array {
  if (width <= 0 || height <= 0 || !Number.isInteger(width) || !Number.isInteger(height)) {
    throw new Error(`Invalid PNG dimensions: ${width}x${height}`);
  }
  if (rgba.length !== width * height * 4) {
    throw new Error(
      `RGBA buffer length mismatch: expected ${width * height * 4}, got ${rgba.length}`,
    );
  }

  const rowStride = width * 4;
  const rawScanlines = new Uint8Array(height * (1 + rowStride));
  for (let y = 0; y < height; y++) {
    const dstRow = y * (1 + rowStride);
    rawScanlines[dstRow] = 0; // Filter type 0 (None)
    const srcStart = y * rowStride;
    rawScanlines.set(rgba.subarray(srcStart, srcStart + rowStride), dstRow + 1);
  }

  const ihdrData = new Uint8Array(13);
  writeU32BE(ihdrData, 0, width);
  writeU32BE(ihdrData, 4, height);
  ihdrData[8] = 8; // Bit depth
  ihdrData[9] = 6; // Color type: RGBA
  ihdrData[10] = 0; // Compression method
  ihdrData[11] = 0; // Filter method
  ihdrData[12] = 0; // Interlace method

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrChunk = makeChunk('IHDR', ihdrData);
  const idatChunk = makeChunk('IDAT', deflateStoredZlib(rawScanlines));
  const iendChunk = makeChunk('IEND', new Uint8Array(0));

  const png = new Uint8Array(
    signature.length + ihdrChunk.length + idatChunk.length + iendChunk.length,
  );
  let cursor = 0;
  png.set(signature, cursor);
  cursor += signature.length;
  png.set(ihdrChunk, cursor);
  cursor += ihdrChunk.length;
  png.set(idatChunk, cursor);
  cursor += idatChunk.length;
  png.set(iendChunk, cursor);
  return png;
}

export function rgbaToPngBlob(rgba: Uint8ClampedArray, width: number, height: number): Blob {
  const bytes = encodeRgbaToPngBytes(rgba, width, height);
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return new Blob([copy.buffer], { type: 'image/png' });
}

export function uint8ToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

export function base64ToUint8(base64: string): Uint8Array {
  const cleaned = base64.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '');
  const binary = atob(cleaned);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    (((bytes[offset] ?? 0) << 24) |
      ((bytes[offset + 1] ?? 0) << 16) |
      ((bytes[offset + 2] ?? 0) << 8) |
      (bytes[offset + 3] ?? 0)) >>>
    0
  );
}

async function inflateZlibStream(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const copy = new Uint8Array(compressed.byteLength);
  copy.set(compressed);
  const writePromise = writer.write(copy).then(() => writer.close());
  const readPromise = new Response(ds.readable).arrayBuffer();
  const [, arrayBuffer] = await Promise.all([writePromise, readPromise]);
  return new Uint8Array(arrayBuffer);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Pure-TS PNG decoder supporting standard 8-bit non-interlaced PNG images
 * (Grayscale 0, RGB 2, Grayscale+Alpha 4, RGBA 6) in both Node and Browser.
 */
export async function decodePngBytesToRgba(
  pngBytes: Uint8Array,
): Promise<{ rgba: Uint8ClampedArray; width: number; height: number }> {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (pngBytes.length < 24 || sig.some((b, idx) => pngBytes[idx] !== b)) {
    throw new Error('Invalid PNG signature');
  }

  let cursor = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];

  while (cursor + 12 <= pngBytes.length) {
    const length = readU32BE(pngBytes, cursor);
    const type = String.fromCharCode(
      pngBytes[cursor + 4] ?? 0,
      pngBytes[cursor + 5] ?? 0,
      pngBytes[cursor + 6] ?? 0,
      pngBytes[cursor + 7] ?? 0,
    );
    const dataStart = cursor + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > pngBytes.length) {
      throw new Error(`Truncated PNG chunk "${type}"`);
    }

    const data = pngBytes.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = readU32BE(data, 0);
      height = readU32BE(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      interlace = data[12] ?? 0;
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
    cursor = dataEnd + 4;
  }

  if (width <= 0 || height <= 0) {
    throw new Error('PNG missing valid IHDR dimensions');
  }
  if (bitDepth !== 8 || interlace !== 0) {
    throw new Error(`Unsupported PNG format (bitDepth=${bitDepth}, interlace=${interlace})`);
  }

  const channels =
    colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (channels === 0) {
    throw new Error(`Unsupported PNG colorType=${colorType}`);
  }

  const totalIdatLen = idatChunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const compressed = new Uint8Array(totalIdatLen);
  let idatPos = 0;
  for (const chunk of idatChunks) {
    compressed.set(chunk, idatPos);
    idatPos += chunk.length;
  }

  const rawScanlines = await inflateZlibStream(compressed);
  const stride = width * channels;
  if (rawScanlines.length < height * (1 + stride)) {
    throw new Error('PNG IDAT stream shorter than expected scanline data');
  }

  const reconstructed = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const srcRow = y * (1 + stride);
    const filterType = rawScanlines[srcRow] ?? 0;
    const dstRow = y * stride;
    const prevRow = (y - 1) * stride;

    for (let x = 0; x < stride; x++) {
      const rawByte = rawScanlines[srcRow + 1 + x] ?? 0;
      const a = x >= channels ? (reconstructed[dstRow + x - channels] ?? 0) : 0;
      const b = y > 0 ? (reconstructed[prevRow + x] ?? 0) : 0;
      const c = y > 0 && x >= channels ? (reconstructed[prevRow + x - channels] ?? 0) : 0;

      let recon = rawByte;
      if (filterType === 1) {
        recon = (rawByte + a) & 0xff;
      } else if (filterType === 2) {
        recon = (rawByte + b) & 0xff;
      } else if (filterType === 3) {
        recon = (rawByte + ((a + b) >> 1)) & 0xff;
      } else if (filterType === 4) {
        recon = (rawByte + paethPredictor(a, b, c)) & 0xff;
      } else if (filterType !== 0) {
        throw new Error(`Unsupported PNG scanline filter type ${filterType}`);
      }
      reconstructed[dstRow + x] = recon;
    }
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const outIdx = i * 4;
    const srcIdx = i * channels;
    if (channels === 4) {
      rgba[outIdx] = reconstructed[srcIdx] ?? 0;
      rgba[outIdx + 1] = reconstructed[srcIdx + 1] ?? 0;
      rgba[outIdx + 2] = reconstructed[srcIdx + 2] ?? 0;
      rgba[outIdx + 3] = reconstructed[srcIdx + 3] ?? 255;
    } else if (channels === 3) {
      rgba[outIdx] = reconstructed[srcIdx] ?? 0;
      rgba[outIdx + 1] = reconstructed[srcIdx + 1] ?? 0;
      rgba[outIdx + 2] = reconstructed[srcIdx + 2] ?? 0;
      rgba[outIdx + 3] = 255;
    } else if (channels === 2) {
      const gray = reconstructed[srcIdx] ?? 0;
      rgba[outIdx] = gray;
      rgba[outIdx + 1] = gray;
      rgba[outIdx + 2] = gray;
      rgba[outIdx + 3] = reconstructed[srcIdx + 1] ?? 255;
    } else {
      const gray = reconstructed[srcIdx] ?? 0;
      rgba[outIdx] = gray;
      rgba[outIdx + 1] = gray;
      rgba[outIdx + 2] = gray;
      rgba[outIdx + 3] = 255;
    }
  }

  return { rgba, width, height };
}
