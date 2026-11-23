export interface PcmBuffer {
  readonly sampleRate: number; // default 44100
  readonly channels: 1 | 2;
  /** Interleaved or mono samples in [-1, 1] */
  readonly samples: Float32Array;
}

export type OscShape = 'sine' | 'triangle' | 'sawtooth' | 'square';

export interface ProceduralSfxParams {
  readonly seed: number;
  readonly durationSec: number; // 0.05 .. 4.0
  readonly sampleRate?: number; // default 44100
  // Layer 1: Transient click/punch
  readonly transientGain: number; // 0..1
  readonly transientDecayMs: number; // 2..40
  readonly transientFreqHz: number; // 80..4000
  // Layer 2: Tonal body (with FM & pitch envelope)
  readonly bodyGain: number; // 0..1
  readonly bodyShape: OscShape;
  readonly bodyStartHz: number; // 30..2400
  readonly bodyEndHz: number; // 20..2400
  readonly bodyAttackMs: number; // 0..50
  readonly bodyDecayMs: number; // 15..2000
  readonly fmRatio: number; // 0..8 (0 = pure subtractive)
  readonly fmDepth: number; // 0..600 Hz
  // Layer 3: Filtered noise tail
  readonly noiseGain: number; // 0..1
  readonly noiseDecayMs: number; // 15..2500
  readonly filterStartHz: number; // 100..14000
  readonly filterEndHz: number; // 80..12000
  readonly filterQ: number; // 0.5..8.0
  // Character / Retro FX
  readonly bitDepth: number; // 4..16 (16 = clean)
  readonly drive: number; // 1.0..6.0 soft-clip saturation
}

export interface AudioPostProcessConfig {
  readonly trimSilence: boolean;
  readonly silenceThresholdDb: number; // default -48 dBFS
  readonly fadeInMs: number; // default 2 ms
  readonly fadeOutMs: number; // default 8 ms
  readonly normalizeLufs: boolean;
  readonly targetLufs: number; // e.g. -14 LUFS SFX, -16 BGM, -20 Ambience
  readonly ceilingDb: number; // default -1.0 dBFS true-peak cap
  readonly seamlessLoop: boolean;
  readonly loopCrossfadeMs: number; // default 120 ms equal-power overlap-add
  readonly cropStartSec: number; // 0..duration
  readonly cropEndSec: number; // 0 = full length, else > cropStartSec
  readonly pitchShiftPercent?: number; // optional base transpose e.g. -15 for monster growl
}

export type GoogleAudioRoute =
  'lyria-clip' | 'lyria-full' | 'gemini-tts' | 'gemini-to-synth' | 'local-synth';

export type AudioCategory = 'sfx' | 'ui' | 'ambience' | 'music' | 'voice';

export interface GoogleAudioPreset {
  readonly id: string;
  readonly label: string;
  readonly category: AudioCategory;
  readonly route: GoogleAudioRoute;
  readonly modelId: string;
  /** Supports {{subject}}, {{biome}}, {{mood}}, {{bpm}} tokens */
  readonly promptTemplate: string;
  readonly attachActiveSpriteImage?: boolean;
  readonly ttsConfig?: {
    readonly defaultVoice: string;
    readonly styleDirection: string;
    readonly sampleScript: string;
  };
  readonly realtimeConfig?: {
    readonly bpm: number;
    readonly density: number;
    readonly brightness: number;
    readonly weightedPrompts: readonly { readonly text: string; readonly weight: number }[];
  };
  readonly fallbackSynthParams: ProceduralSfxParams;
  readonly postProcessDefaults: {
    readonly trimSilence: boolean;
    readonly silenceThresholdDb?: number;
    readonly targetLufs: number;
    readonly seamlessLoop: boolean;
    readonly loopCrossfadeMs: number;
    readonly variationCount: 1 | 4 | 6;
    readonly pitchShiftPercent?: number;
  };
}
