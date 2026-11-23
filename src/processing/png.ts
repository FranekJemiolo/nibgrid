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
