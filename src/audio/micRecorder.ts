import { sha256Bytes } from '../processing/hash';
import { decodeWav16, encodeWav16, trimSilencePcm } from './pcmPostProcess';
import { decodeAudioBytesToPcm } from './playbackEngine';
import type { PcmBuffer } from './types';
import {
  analyzeVocalSketch,
  extractMelodySummary,
  type MelodySummary,
  type VocalContour,
} from './vocalAnalyzer';

export type MicRecorderErrorCode =
  'PermissionDenied' | 'NoMicrophone' | 'UnsupportedContext' | 'WorkletUnavailable';

export class MicRecorderError extends Error {
  readonly code: MicRecorderErrorCode;
  readonly remediation: string;

  constructor(code: MicRecorderErrorCode, message: string, remediation: string) {
    super(message);
    this.name = 'MicRecorderError';
    this.code = code;
    this.remediation = remediation;
  }
}

export const MIC_WORKLET_PROCESSOR_CODE = `
class NibgridPcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      const ch0 = input[0];
      const copy = new Float32Array(ch0.length);
      copy.set(ch0);
      this.port.postMessage(copy, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('nibgrid-pcm-capture', NibgridPcmCaptureProcessor);
`;

export interface RecordedSketchResult {
  readonly pcm: PcmBuffer;
  readonly wavBytes: Uint8Array;
  readonly sha256: string;
  readonly contour: VocalContour;
  readonly melody: MelodySummary;
}

export function downmixAndConcatChunks(
  chunks: readonly Float32Array[],
  sampleRate: number,
  maxDurationSec = 10,
): PcmBuffer {
  const maxSamples = Math.max(1, Math.round(maxDurationSec * sampleRate));
  let total = 0;
  for (const c of chunks) {
    total += c.length;
    if (total >= maxSamples) {
      total = maxSamples;
      break;
    }
  }
  const merged = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    if (offset >= total) break;
    const take = Math.min(c.length, total - offset);
    merged.set(c.subarray(0, take), offset);
    offset += take;
  }
  return { sampleRate, channels: 1, samples: merged };
}

/**
 * Normalizes uploaded WAV/audio bytes to mono PCM, trims silence, and extracts SHA-256 + pitch contour.
 */
export async function ingestWavSketchBytes(wavBytes: Uint8Array): Promise<RecordedSketchResult> {
  const isRiffWav =
    wavBytes.byteLength >= 44 &&
    String.fromCharCode(...wavBytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...wavBytes.slice(8, 12)) === 'WAVE';

  const decoded = isRiffWav ? decodeWav16(wavBytes) : await decodeAudioBytesToPcm(wavBytes);
  let monoSamples: Float32Array;
  if (decoded.channels === 1) {
    monoSamples = decoded.samples;
  } else {
    const frames = Math.floor(decoded.samples.length / decoded.channels);
    monoSamples = new Float32Array(frames);
    for (let f = 0; f < frames; f++) {
      const l = decoded.samples[f * 2] ?? 0;
      const r = decoded.samples[f * 2 + 1] ?? l;
      monoSamples[f] = (l + r) * 0.5;
    }
  }

  const trimmed = trimSilencePcm({
    sampleRate: decoded.sampleRate,
    channels: 1,
    samples: monoSamples,
  });
  const encodedWav = encodeWav16(trimmed);
  const sha256 = await sha256Bytes(encodedWav);
  const contour = analyzeVocalSketch(trimmed);
  const melody = extractMelodySummary(contour);

  return {
    pcm: trimmed,
    wavBytes: encodedWav,
    sha256,
    contour,
    melody,
  };
}

export interface MicRecorderOptions {
  readonly maxDurationSec?: number;
  readonly onLevel?: (rms: number, elapsedSec: number) => void;
  readonly onAutoStop?: (result: RecordedSketchResult) => void;
  readonly mediaDevicesOverride?: Pick<MediaDevices, 'getUserMedia'>;
  readonly audioContextCtorOverride?: typeof AudioContext;
  readonly audioWorkletNodeFactoryOverride?: (ctx: AudioContext, name: string) => AudioWorkletNode;
}

/**
 * Subpath-safe AudioWorklet raw PCM mic capture (disabling echo/noise DSP) with guaranteed track teardown.
 */
export class MicRecorder {
  private readonly maxDurationSec: number;
  private readonly onLevel?: (rms: number, elapsedSec: number) => void;
  private readonly onAutoStop?: (result: RecordedSketchResult) => void;
  private readonly mediaDevicesOverride?: Pick<MediaDevices, 'getUserMedia'>;
  private readonly audioContextCtorOverride?: typeof AudioContext;
  private readonly audioWorkletNodeFactoryOverride?: (
    ctx: AudioContext,
    name: string,
  ) => AudioWorkletNode;

  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private workletBlobUrl: string | null = null;
  private chunks: Float32Array[] = [];
  private sampleRate = 44100;
  private capturedSamples = 0;
  private recording = false;
  private disposed = false;

  constructor(options: MicRecorderOptions = {}) {
    this.maxDurationSec = Math.max(1, Math.min(10, options.maxDurationSec ?? 10));
    this.onLevel = options.onLevel;
    this.onAutoStop = options.onAutoStop;
    this.mediaDevicesOverride = options.mediaDevicesOverride;
    this.audioContextCtorOverride = options.audioContextCtorOverride;
    this.audioWorkletNodeFactoryOverride = options.audioWorkletNodeFactoryOverride;
  }

  public isRecording(): boolean {
    return this.recording;
  }

  public async start(): Promise<void> {
    if (this.disposed) {
      throw new MicRecorderError(
        'UnsupportedContext',
        'MicRecorder has already been disposed.',
        'Reopen the Mic Sketch panel to initialize audio capture.',
      );
    }
    if (this.recording) return;

    const md =
      this.mediaDevicesOverride ??
      (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);
    if (!md?.getUserMedia) {
      throw new MicRecorderError(
        'UnsupportedContext',
        'Browser microphone capture is unavailable in this context (requires HTTPS or localhost).',
        'Use Upload .WAV Sketch or serve Nibgrid over HTTPS / localhost.',
      );
    }

    const win =
      typeof window !== 'undefined'
        ? (window as Window & {
            AudioContext?: typeof AudioContext;
            webkitAudioContext?: typeof AudioContext;
          })
        : undefined;
    const Ctor =
      this.audioContextCtorOverride ??
      globalThis.AudioContext ??
      win?.AudioContext ??
      win?.webkitAudioContext;
    if (!Ctor) {
      throw new MicRecorderError(
        'WorkletUnavailable',
        'Web Audio AudioContext is unavailable in this browser.',
        'Upgrade your browser or upload a .WAV sketch file directly.',
      );
    }

    try {
      this.stream = await md.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      await this.cleanupResources();
      const name = err instanceof Error ? err.name : '';
      if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        throw new MicRecorderError(
          'NoMicrophone',
          'No microphone input device was found.',
          'Connect a microphone or upload a pre-recorded .WAV sketch.',
        );
      }
      throw new MicRecorderError(
        'PermissionDenied',
        'Microphone permission was denied.',
        'Allow microphone access in your browser site settings or upload a .WAV sketch.',
      );
    }

    try {
      const ctx = new Ctor();
      this.audioCtx = ctx;
      this.sampleRate = ctx.sampleRate || 44100;
      if (ctx.state === 'suspended') {
        await ctx.resume();
      }
      if (!ctx.audioWorklet) {
        throw new MicRecorderError(
          'WorkletUnavailable',
          'AudioWorklet is unavailable in this browser context.',
          'Use HTTPS/localhost in Chrome/Firefox or upload a .WAV file.',
        );
      }

      const blob = new Blob([MIC_WORKLET_PROCESSOR_CODE], { type: 'application/javascript' });
      this.workletBlobUrl = URL.createObjectURL(blob);
      await ctx.audioWorklet.addModule(this.workletBlobUrl);

      this.chunks = [];
      this.capturedSamples = 0;
      this.sourceNode = ctx.createMediaStreamSource(this.stream);
      this.workletNode = this.audioWorkletNodeFactoryOverride
        ? this.audioWorkletNodeFactoryOverride(ctx, 'nibgrid-pcm-capture')
        : new AudioWorkletNode(ctx, 'nibgrid-pcm-capture');
      this.recording = true;

      const maxSamples = Math.round(this.maxDurationSec * this.sampleRate);
      this.workletNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
        if (!this.recording || !(event.data instanceof Float32Array)) return;
        const chunk = event.data;
        this.chunks.push(chunk);
        this.capturedSamples += chunk.length;

        let sumSq = 0;
        for (let i = 0; i < chunk.length; i++) {
          const s = chunk[i] ?? 0;
          sumSq += s * s;
        }
        const rms = Math.sqrt(sumSq / Math.max(1, chunk.length));
        this.onLevel?.(rms, this.capturedSamples / this.sampleRate);

        if (this.capturedSamples >= maxSamples) {
          void this.stop().then((result) => {
            if (result) this.onAutoStop?.(result);
          });
        }
      };

      this.sourceNode.connect(this.workletNode);
    } catch (err) {
      await this.cleanupResources();
      if (err instanceof MicRecorderError) throw err;
      throw new MicRecorderError(
        'WorkletUnavailable',
        err instanceof Error ? err.message : 'Failed to start AudioWorklet microphone capture.',
        'Upload a .WAV audio sketch instead or verify browser permissions.',
      );
    }
  }

  public async stop(): Promise<RecordedSketchResult | null> {
    const wasRecording = this.recording;
    this.recording = false;
    const raw = downmixAndConcatChunks(this.chunks, this.sampleRate, this.maxDurationSec);
    await this.cleanupResources();

    if (!wasRecording || raw.samples.length === 0) {
      return null;
    }

    const trimmed = trimSilencePcm(raw, -48, 2, 8);
    const wavBytes = encodeWav16(trimmed);
    const sha256 = await sha256Bytes(wavBytes);
    const contour = analyzeVocalSketch(trimmed);
    const melody = extractMelodySummary(contour);

    return {
      pcm: trimmed,
      wavBytes,
      sha256,
      contour,
      melody,
    };
  }

  private async cleanupResources(): Promise<void> {
    this.recording = false;
    if (this.workletNode) {
      try {
        this.workletNode.port.onmessage = null;
        this.workletNode.disconnect();
      } catch {
        // Ignore disconnect errors on teardown
      }
      this.workletNode = null;
    }
    if (this.sourceNode) {
      try {
        this.sourceNode.disconnect();
      } catch {
        // Ignore disconnect errors on teardown
      }
      this.sourceNode = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignore track teardown errors
        }
      }
      this.stream = null;
    }
    if (this.workletBlobUrl) {
      try {
        URL.revokeObjectURL(this.workletBlobUrl);
      } catch {
        // Ignore revoke errors
      }
      this.workletBlobUrl = null;
    }
    if (this.audioCtx) {
      const ctx = this.audioCtx;
      this.audioCtx = null;
      await ctx.close().catch(() => undefined);
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cleanupResources();
    this.chunks = [];
  }
}
