import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONTOUR_TIMBRE_RESPONSE_SCHEMA } from '../../src/audio/contourPatchSchema';
import {
  buildHumToLyriaInteractionRequest,
  buildHumToTimbreRequest,
  buildHumToTtsStepRequest,
  estimateHumRouteCost,
  invokeHumToSoundRoute,
} from '../../src/audio/humToSoundProvider';
import { MicRecorder, ingestWavSketchBytes } from '../../src/audio/micRecorder';
import { encodeWav16 } from '../../src/audio/pcmPostProcess';
import { ProviderError } from '../../src/providers/errors';
import { executeAudioWorkerJob, executeVocalAnalyzeJob } from '../../src/workers/audio.worker';
import { createDefaultAudioPostProcessConfig } from '../../src/domain/schemas';
import { STARTER_CONTOUR_PATCHES } from '../../src/audio/contourPatchSchema';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('M15B MicRecorder Cleanup, Multimodal Hum Routing & Audio Worker Jobs', () => {
  it('builds Route A (hum-to-timbre), Route B (hum-to-lyria), Route C (hum-to-tts), and cost badges cleanly', () => {
    expect(estimateHumRouteCost('local-contour').label).toContain('$0.00');
    expect(estimateHumRouteCost('hum-to-timbre').label).toContain('$0.001');
    expect(estimateHumRouteCost('hum-to-lyria').label).toContain('$0.04');
    expect(estimateHumRouteCost('hum-to-tts').label).toContain('$0.005');

    // Route A: hum.wav inlineData + CONTOUR_TIMBRE_RESPONSE_SCHEMA
    const timbreReq = buildHumToTimbreRequest({
      modelId: 'gemini-2.5-flash',
      prompt: 'crunchy 16-bit turbo blow-off valve',
      humWavBase64: 'UklGRg==',
    });
    expect(timbreReq.url).toContain('/models/gemini-2.5-flash:generateContent');
    const contents = timbreReq.payload.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    expect(contents[0]!.parts[1]).toEqual({
      inlineData: {
        mimeType: 'audio/wav',
        data: 'UklGRg==',
      },
    });
    expect(timbreReq.payload.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseSchema: CONTOUR_TIMBRE_RESPONSE_SCHEMA,
    });

    // Route B: Lyria compiles detected BPM + dominant key
    const lyriaReq = buildHumToLyriaInteractionRequest({
      modelId: 'lyria-3-clip-preview',
      prompt: 'Dungeon chiptune melody',
      melodySummary: {
        notes: [{ midi: 60, startSec: 0, durationSec: 0.2, avgRms: 0.5 }],
        detectedBpm: 136,
        dominantKey: 'A Minor',
      },
      humWavBase64: 'UklGRg==',
    });
    expect(lyriaReq.url).toContain('/interactions');
    const lyriaInputs = lyriaReq.payload.input as Array<Record<string, unknown>>;
    expect(String(lyriaInputs[0]!.text)).toContain('136 BPM');
    expect(String(lyriaInputs[0]!.text)).toContain('A Minor');
    expect(lyriaInputs[1]).toEqual({
      type: 'audio',
      data: 'UklGRg==',
      mime_type: 'audio/wav',
    });

    // Route C: Cadence -> gemini-3.8-flash-tts speechConfig
    const ttsReq = buildHumToTtsStepRequest({
      ttsModelId: 'gemini-3.8-flash-tts',
      cadence: {
        voiceName: 'Fenrir',
        styleDirection: 'Short punchy warrior grunt',
        script: '<grunt> Agh!',
      },
    });
    expect(ttsReq.url).toContain('/models/gemini-3.8-flash-tts:generateContent');
    expect(ttsReq.payload.generationConfig).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: 'Fenrir' },
        },
      },
    });
  });

  it('redacts dummy API key AIzaSyTESTHUM777 from all 401/429/500 ProviderError diagnostics', async () => {
    const secret = 'AIzaSyTESTHUM777';
    for (const status of [401, 429, 500]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status,
          text: async () => `Auth failed with key=${secret} status=${status}`,
        })),
      );

      let caught: unknown;
      try {
        await invokeHumToSoundRoute({
          route: 'hum-to-timbre',
          apiKey: secret,
          prompt: 'retro laser',
          humWavBytes: new Uint8Array([1, 2, 3, 4]),
          melodySummary: { notes: [], detectedBpm: 120, dominantKey: 'C Major' },
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ProviderError);
      const pe = caught as ProviderError;
      expect(pe.status).toBe(status);
      expect(pe.message).not.toContain(secret);
      expect(pe.remediation).not.toContain(secret);
    }
  });

  it('tears down MediaStreamTrack.stop() and URL.revokeObjectURL on MicRecorder stop() and dispose(), and ingests WAV sketches cleanly', async () => {
    const trackStopSpy = vi.fn();
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const createUrlSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockReturnValue('blob:nibgrid-worklet-test');
    const ctxCloseSpy = vi.fn(async () => {});
    const sourceDisconnectSpy = vi.fn();
    const workletDisconnectSpy = vi.fn();

    const fakePort: { onmessage: ((ev: MessageEvent<Float32Array>) => void) | null } = {
      onmessage: null,
    };

    const getUserMediaMock = vi.fn(async () => ({
      getTracks: () => [{ stop: trackStopSpy }],
    })) as unknown as MediaDevices['getUserMedia'];

    class FakeAudioCtx {
      sampleRate = 44100;
      state: AudioContextState = 'running';
      audioWorklet = { addModule: vi.fn(async () => {}) };
      createMediaStreamSource = vi.fn(() => ({
        connect: vi.fn(),
        disconnect: sourceDisconnectSpy,
      }));
      close = ctxCloseSpy;
    }

    const recorder = new MicRecorder({
      mediaDevicesOverride: { getUserMedia: getUserMediaMock },
      audioContextCtorOverride: FakeAudioCtx as unknown as typeof AudioContext,
      audioWorkletNodeFactoryOverride: () =>
        ({
          port: fakePort,
          disconnect: workletDisconnectSpy,
        }) as unknown as AudioWorkletNode,
    });

    await recorder.start();
    expect(getUserMediaMock).toHaveBeenCalledWith({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    expect(createUrlSpy).toHaveBeenCalled();

    // Feed a synthetic 300 Hz chunk via the mocked AudioWorklet port
    const chunk = new Float32Array(2048);
    for (let i = 0; i < chunk.length; i++) {
      chunk[i] = 0.5 * Math.sin((2 * Math.PI * 300 * i) / 44100);
    }
    fakePort.onmessage?.({ data: chunk } as MessageEvent<Float32Array>);

    const result = await recorder.stop();
    expect(result).not.toBeNull();
    expect(trackStopSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledWith('blob:nibgrid-worklet-test');
    expect(ctxCloseSpy).toHaveBeenCalledTimes(1);
    expect(workletDisconnectSpy).toHaveBeenCalledTimes(1);
    expect(sourceDisconnectSpy).toHaveBeenCalledTimes(1);

    await recorder.dispose();

    // Test ingestWavSketchBytes + worker execution jobs
    const wavBytes = encodeWav16({ sampleRate: 44100, channels: 1, samples: chunk });
    const ingested = await ingestWavSketchBytes(wavBytes);
    expect(ingested.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ingested.contour.frames.length).toBeGreaterThan(0);

    const workerAnalysis = executeVocalAnalyzeJob({ id: 1, rawPcm: ingested.pcm });
    expect(workerAnalysis.contour.frames.length).toBe(ingested.contour.frames.length);

    const synthJob = executeAudioWorkerJob({
      op: 'synth',
      id: 2,
      sourceKind: 'contour',
      contour: workerAnalysis.contour,
      contourPatch: STARTER_CONTOUR_PATCHES[0]!.patch,
      postProcess: createDefaultAudioPostProcessConfig(),
      variationCount: 4,
      seed: 1234,
    });
    expect(synthJob.variations).toHaveLength(4);
    expect(String.fromCharCode(...synthJob.variations[0]!.wavBytes.slice(0, 4))).toBe('RIFF');
  });
});
