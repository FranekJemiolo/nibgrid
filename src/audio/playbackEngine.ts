import { decodeWav16 } from './pcmPostProcess';
import type { PcmBuffer } from './types';

function resolveAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const win = window as Window & {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  return globalThis.AudioContext ?? win.AudioContext ?? win.webkitAudioContext ?? null;
}

/**
 * Decodes WAV16 cleanly in pure TS, or delegates compressed MP3/OGG decoding
 * to the browser Web Audio API `decodeAudioData()`.
 */
export async function decodeAudioBytesToPcm(bytes: Uint8Array): Promise<PcmBuffer> {
  if (
    bytes.byteLength >= 44 &&
    String.fromCharCode(...bytes.slice(0, 4)) === 'RIFF' &&
    String.fromCharCode(...bytes.slice(8, 12)) === 'WAVE'
  ) {
    return decodeWav16(bytes);
  }

  const Ctor = resolveAudioContextCtor();
  if (!Ctor) {
    throw new Error('Web Audio AudioContext is unavailable to decode compressed audio bytes.');
  }

  const ctx = new Ctor();
  try {
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const decoded = await ctx.decodeAudioData(copy.buffer);
    const channels: 1 | 2 = decoded.numberOfChannels >= 2 ? 2 : 1;
    const frames = decoded.length;
    const samples = new Float32Array(frames * channels);
    const ch0 = decoded.getChannelData(0);
    const ch1 = channels === 2 ? decoded.getChannelData(1) : null;

    for (let f = 0; f < frames; f++) {
      samples[f * channels] = ch0[f] ?? 0;
      if (channels === 2 && ch1) {
        samples[f * channels + 1] = ch1[f] ?? 0;
      }
    }
    return { sampleRate: decoded.sampleRate, channels, samples };
  } finally {
    await ctx.close().catch(() => undefined);
  }
}

/**
 * Disposable Web Audio API auditioning player for Screen 6 Audio Foundry,
 * Screen 4F 1x Game Scale Sandbox, and Screen 4D 9-Slice panel clicks.
 */
export class AudioPlaybackEngine {
  private ctx: AudioContext | null = null;
  private activeSource: AudioBufferSourceNode | null = null;
  private isPlaying = false;
  private disposed = false;
  private playCount = 0;

  private async ensureContext(): Promise<AudioContext | null> {
    if (this.disposed) return null;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return null;
    if (!this.ctx) {
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
    }
    if (this.ctx.state === 'suspended') {
      await this.ctx.resume().catch(() => undefined);
    }
    return this.ctx;
  }

  public getPlayCount(): number {
    return this.playCount;
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public stop(): void {
    if (this.activeSource) {
      try {
        this.activeSource.stop();
      } catch {
        // Ignore already-stopped source nodes in headless Chromium
      }
      try {
        this.activeSource.disconnect();
      } catch {
        // Ignore
      }
      this.activeSource = null;
    }
    this.isPlaying = false;
  }

  /**
   * Plays a PcmBuffer safely on user gesture without throwing or leaking rejections in headless browsers.
   */
  public async playPcm(
    pcm: PcmBuffer,
    options: { readonly loop?: boolean; readonly onEnded?: () => void } = {},
  ): Promise<boolean> {
    if (this.disposed || pcm.samples.length === 0) return false;
    this.playCount += 1;

    const ctx = await this.ensureContext();
    if (!ctx) return false;

    this.stop();
    try {
      const frames = Math.max(1, Math.floor(pcm.samples.length / pcm.channels));
      const audioBuf = ctx.createBuffer(pcm.channels, frames, pcm.sampleRate);
      for (let c = 0; c < pcm.channels; c++) {
        const ch = audioBuf.getChannelData(c);
        for (let f = 0; f < frames; f++) {
          ch[f] = pcm.samples[f * pcm.channels + c] ?? 0;
        }
      }
      const source = ctx.createBufferSource();
      source.buffer = audioBuf;
      source.loop = Boolean(options.loop);
      source.connect(ctx.destination);
      source.onended = () => {
        if (this.activeSource === source) {
          this.activeSource = null;
          this.isPlaying = false;
          options.onEnded?.();
        }
      };
      this.activeSource = source;
      this.isPlaying = true;
      source.start(0);
      return true;
    } catch {
      this.isPlaying = false;
      return false;
    }
  }

  public async playWavBlob(
    blob: Blob,
    options: { readonly loop?: boolean; readonly onEnded?: () => void } = {},
  ): Promise<boolean> {
    if (this.disposed) return false;
    try {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const pcm = await decodeAudioBytesToPcm(buf);
      return await this.playPcm(pcm, options);
    } catch {
      return false;
    }
  }

  public async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    if (this.ctx) {
      const c = this.ctx;
      this.ctx = null;
      await c.close().catch(() => undefined);
    }
  }
}
