import type { AudioPostProcessConfig, PcmBuffer } from './types';

export function dbToLinear(db: number): number {
  return Math.pow(10, db / 20);
}

export function linearToDb(linear: number): number {
  const abs = Math.abs(linear);
  if (abs <= 1e-12) return -Infinity;
  return 20 * Math.log10(abs);
}

export function measurePeakDb(buf: PcmBuffer): number {
  let maxAbs = 0;
  for (let i = 0; i < buf.samples.length; i++) {
    const a = Math.abs(buf.samples[i] ?? 0);
    if (a > maxAbs) maxAbs = a;
  }
  return linearToDb(maxAbs);
}

/**
 * Slices an exact `[startSec, endSec]` region from `buf`.
 */
export function cropRegionPcm(buf: PcmBuffer, startSec: number, endSec: number): PcmBuffer {
  const { samples, sampleRate, channels } = buf;
  const totalFrames = Math.floor(samples.length / channels);
  if (totalFrames === 0) {
    return { sampleRate, channels, samples: new Float32Array(0) };
  }

  const clampedStart = Math.max(0, Math.min(totalFrames - 1, Math.floor(startSec * sampleRate)));
  const requestedEnd =
    endSec > 0 ? Math.min(totalFrames, Math.ceil(endSec * sampleRate)) : totalFrames;
  const clampedEnd = Math.max(clampedStart + 1, requestedEnd);

  return {
    sampleRate,
    channels,
    samples: samples.slice(clampedStart * channels, clampedEnd * channels),
  };
}

/**
 * Auto-trims leading & trailing silence with 128-sample zero-crossing snapping
 * and anti-click linear fade-in / fade-out micro-ramps.
 */
export function trimSilencePcm(
  buf: PcmBuffer,
  thresholdDb = -48,
  fadeInMs = 2,
  fadeOutMs = 8,
): PcmBuffer {
  const { samples, sampleRate, channels } = buf;
  const totalFrames = Math.floor(samples.length / channels);
  if (totalFrames === 0) {
    return { sampleRate, channels, samples: new Float32Array(0) };
  }

  const thresh = dbToLinear(thresholdDb);
  const framePeak = (f: number): number => {
    let pk = 0;
    for (let c = 0; c < channels; c++) {
      const a = Math.abs(samples[f * channels + c] ?? 0);
      if (a > pk) pk = a;
    }
    return pk;
  };

  let startFrame = 0;
  let endFrame = totalFrames - 1;
  while (startFrame < totalFrames && framePeak(startFrame) < thresh) startFrame++;
  while (endFrame > startFrame && framePeak(endFrame) < thresh) endFrame--;

  if (startFrame >= endFrame) {
    const emptyLen = Math.min(totalFrames, 64) * channels;
    return { sampleRate, channels, samples: new Float32Array(emptyLen) };
  }

  // Snap start backward and end forward to nearest zero-crossing on channel 0 within 128 frames
  const snapWindow = 128;
  for (let f = startFrame; f > Math.max(0, startFrame - snapWindow); f--) {
    const cur = samples[f * channels] ?? 0;
    const prev = samples[(f - 1) * channels] ?? 0;
    if (cur * prev <= 0) {
      startFrame = f;
      break;
    }
  }
  for (let f = endFrame; f < Math.min(totalFrames - 1, endFrame + snapWindow); f++) {
    const cur = samples[f * channels] ?? 0;
    const next = samples[(f + 1) * channels] ?? 0;
    if (cur * next <= 0) {
      endFrame = f;
      break;
    }
  }

  const trimmed = samples.slice(startFrame * channels, (endFrame + 1) * channels);
  const outFrames = Math.floor(trimmed.length / channels);
  const fadeInFrames = Math.min(outFrames, Math.round((fadeInMs / 1000) * sampleRate));
  const fadeOutFrames = Math.min(outFrames, Math.round((fadeOutMs / 1000) * sampleRate));

  for (let f = 0; f < fadeInFrames; f++) {
    const gain = f / Math.max(1, fadeInFrames);
    for (let c = 0; c < channels; c++) {
      const idx = f * channels + c;
      trimmed[idx] = (trimmed[idx] ?? 0) * gain;
    }
  }
  for (let f = 0; f < fadeOutFrames; f++) {
    const frameIdx = outFrames - 1 - f;
    const gain = f / Math.max(1, fadeOutFrames);
    for (let c = 0; c < channels; c++) {
      const idx = frameIdx * channels + c;
      trimmed[idx] = (trimmed[idx] ?? 0) * gain;
    }
  }

  return { sampleRate, channels, samples: trimmed };
}

/**
 * Computes perceptual K-weighted integrated LUFS estimate (~100 Hz HP + BS.1770 scale).
 */
export function measureApproxLufs(buf: PcmBuffer): number {
  const { samples, sampleRate, channels } = buf;
  const totalFrames = Math.floor(samples.length / channels);
  if (totalFrames === 0) return -Infinity;

  const rc = 1 / (2 * Math.PI * 100);
  const alpha = rc / (rc + 1 / sampleRate);
  let prevIn = 0;
  let prevHp = 0;
  let energySum = 0;

  for (let f = 0; f < totalFrames; f++) {
    let mono = 0;
    for (let c = 0; c < channels; c++) {
      mono += samples[f * channels + c] ?? 0;
    }
    mono /= channels;
    const hp = alpha * (prevHp + mono - prevIn);
    prevIn = mono;
    prevHp = hp;
    energySum += hp * hp;
  }

  const meanSq = energySum / totalFrames;
  if (meanSq <= 1e-12) return -Infinity;
  return -0.691 + 10 * Math.log10(meanSq);
}

/**
 * Scales `buf` toward `targetLufs` while softly limiting peaks strictly below `ceilingDb`.
 */
export function normalizeLufsPcm(
  buf: PcmBuffer,
  targetLufs = -14,
  ceilingDb = -1.0,
): { buffer: PcmBuffer; inputLufs: number; outputLufs: number } {
  const inputLufs = measureApproxLufs(buf);
  if (!Number.isFinite(inputLufs)) {
    return {
      buffer: { ...buf, samples: new Float32Array(buf.samples) },
      inputLufs: -Infinity,
      outputLufs: -Infinity,
    };
  }

  const gain = dbToLinear(Math.max(-24, Math.min(30, targetLufs - inputLufs)));
  const ceiling = dbToLinear(ceilingDb);
  const knee = ceiling * 0.85;
  const headroom = Math.max(1e-6, ceiling - knee);
  const out = new Float32Array(buf.samples.length);

  for (let i = 0; i < buf.samples.length; i++) {
    const scaled = (buf.samples[i] ?? 0) * gain;
    const abs = Math.abs(scaled);
    if (abs > knee) {
      const excess = (abs - knee) / headroom;
      const limited = Math.min(ceiling, knee + Math.tanh(excess) * headroom);
      out[i] = scaled >= 0 ? limited : -limited;
    } else {
      out[i] = scaled;
    }
  }

  const nextBuf: PcmBuffer = { ...buf, samples: out };
  return { buffer: nextBuf, inputLufs, outputLufs: measureApproxLufs(nextBuf) };
}

/**
 * Equal-power sin/cos overlap-add crossfading `crossfadeMs` tail back over head
 * so looping ambience & engine hums maintain constant RMS with zero boundary clicks.
 */
export function makeSeamlessLoopPcm(buf: PcmBuffer, crossfadeMs = 120): PcmBuffer {
  const { samples, sampleRate, channels } = buf;
  const totalFrames = Math.floor(samples.length / channels);
  const fadeFrames = Math.min(
    Math.floor(totalFrames / 3),
    Math.max(16, Math.round((crossfadeMs / 1000) * sampleRate)),
  );
  const outFrames = totalFrames - fadeFrames;
  if (outFrames <= fadeFrames) {
    return { sampleRate, channels, samples: new Float32Array(samples) };
  }

  const out = new Float32Array(outFrames * channels);
  for (let f = 0; f < outFrames; f++) {
    if (f < fadeFrames) {
      const t = f / fadeFrames;
      const headWeight = Math.sin(t * Math.PI * 0.5);
      const tailWeight = Math.cos(t * Math.PI * 0.5);
      for (let c = 0; c < channels; c++) {
        const head = samples[f * channels + c] ?? 0;
        const tail = samples[(outFrames + f) * channels + c] ?? 0;
        out[f * channels + c] = head * headWeight + tail * tailWeight;
      }
    } else {
      for (let c = 0; c < channels; c++) {
        out[f * channels + c] = samples[f * channels + c] ?? 0;
      }
    }
  }

  return { sampleRate, channels, samples: out };
}

/**
 * Pure-TS 44-byte RIFF/WAVE 16-bit signed PCM encoder.
 */
export function encodeWav16(buf: PcmBuffer): Uint8Array {
  const { samples, sampleRate, channels } = buf;
  const dataBytes = samples.length * 2;
  const out = new Uint8Array(44 + dataBytes);
  const view = new DataView(out.buffer);

  const writeStr = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) out[offset + i] = str.charCodeAt(i);
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }

  return out;
}

/**
 * Pure-TS RIFF/WAVE 16-bit signed PCM decoder (handles extra metadata sub-chunks safely).
 */
export function decodeWav16(bytes: Uint8Array): PcmBuffer {
  if (bytes.byteLength < 44) {
    throw new Error('Invalid WAV buffer: shorter than 44-byte RIFF header.');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const readStr = (offset: number, len: number) => {
    let s = '';
    for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[offset + i] ?? 0);
    return s;
  };

  if (readStr(0, 4) !== 'RIFF' || readStr(8, 4) !== 'WAVE') {
    throw new Error('Invalid WAV header: missing RIFF/WAVE signature.');
  }

  let sampleRate = 44100;
  let channels: 1 | 2 = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const chunkId = readStr(offset, 4);
    const chunkSize = view.getUint32(offset + 4, true);
    const payloadStart = offset + 8;

    if (chunkId === 'fmt ' && payloadStart + 16 <= bytes.byteLength) {
      const ch = view.getUint16(payloadStart + 2, true);
      channels = ch >= 2 ? 2 : 1;
      sampleRate = view.getUint32(payloadStart + 4, true) || 44100;
      bitsPerSample = view.getUint16(payloadStart + 14, true) || 16;
    } else if (chunkId === 'data') {
      dataOffset = payloadStart;
      dataSize = Math.min(chunkSize, bytes.byteLength - payloadStart);
      break;
    }

    offset = payloadStart + chunkSize + (chunkSize & 1);
  }

  if (dataOffset < 0) {
    throw new Error('Invalid WAV file: missing data chunk.');
  }
  if (bitsPerSample !== 16) {
    throw new Error(`Unsupported WAV bit depth (${bitsPerSample}); only 16-bit PCM is supported.`);
  }

  const sampleCount = Math.floor(dataSize / 2);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    const raw = view.getInt16(dataOffset + i * 2, true);
    samples[i] = raw < 0 ? raw / 0x8000 : raw / 0x7fff;
  }

  return { sampleRate, channels, samples };
}

/**
 * Executes crop -> silence trim -> seamless loop crossfade -> LUFS normalization in order.
 */
export function runAudioPostProcessPipeline(
  raw: PcmBuffer,
  config: AudioPostProcessConfig,
): {
  readonly buffer: PcmBuffer;
  readonly inputLufs: number;
  readonly outputLufs: number;
  readonly peakDb: number;
} {
  let working = raw;
  const inputLufs = measureApproxLufs(working);

  if (config.cropStartSec > 0 || config.cropEndSec > 0) {
    working = cropRegionPcm(working, config.cropStartSec, config.cropEndSec);
  }

  if (config.trimSilence) {
    working = trimSilencePcm(working, config.silenceThresholdDb, config.fadeInMs, config.fadeOutMs);
  }

  if (config.seamlessLoop) {
    working = makeSeamlessLoopPcm(working, config.loopCrossfadeMs);
  }

  let outputLufs = measureApproxLufs(working);
  if (config.normalizeLufs) {
    const norm = normalizeLufsPcm(working, config.targetLufs, config.ceilingDb);
    working = norm.buffer;
    outputLufs = norm.outputLufs;
  }

  return {
    buffer: working,
    inputLufs,
    outputLufs,
    peakDb: measurePeakDb(working),
  };
}
