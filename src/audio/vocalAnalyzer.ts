import type { PcmBuffer } from './types';

export type ScaleQuantizeMode = 'none' | 'chromatic' | 'pentatonic' | 'minor';

export interface VocalFrame {
  readonly timeSec: number;
  readonly rms: number; // 0..1 normalized loudness envelope A(t)
  readonly freqHz: number; // 0 when unvoiced/silent, otherwise 65..1100 Hz
  readonly clarity: number; // 0..1 periodicity (high = hum/whistle, low = "shh/kss" noise)
  readonly zcr: number; // 0..1 zero-crossing rate (high = sibilance/consonants)
}

export interface VocalContour {
  readonly hopSec: number;
  readonly durationSec: number;
  readonly peakRms: number;
  readonly frames: readonly VocalFrame[];
}

export interface AnalyzeOptions {
  readonly frameMs?: number; // default 25 ms window
  readonly hopMs?: number; // default 10 ms step
  readonly minFreqHz?: number; // default 65 Hz (low C2)
  readonly maxFreqHz?: number; // default 1100 Hz (whistle / high voice)
  readonly silenceRms?: number; // default 0.015
}

export interface DetectedMidiNote {
  readonly midi: number;
  readonly startSec: number;
  readonly durationSec: number;
  readonly avgRms: number;
}

export interface MelodySummary {
  readonly notes: readonly DetectedMidiNote[];
  readonly detectedBpm: number;
  readonly dominantKey: string;
}

const SCALE_INTERVALS: Record<Exclude<ScaleQuantizeMode, 'none'>, readonly number[]> = {
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  pentatonic: [0, 2, 4, 7, 9],
  minor: [0, 2, 3, 5, 7, 8, 10],
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

export function freqToMidi(freqHz: number): number {
  if (!Number.isFinite(freqHz) || freqHz <= 0) return 0;
  return 69 + 12 * Math.log2(freqHz / 440);
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

export function quantizeFreqToScale(
  freqHz: number,
  mode: ScaleQuantizeMode,
  rootPitchClass = 0,
): number {
  if (!Number.isFinite(freqHz) || freqHz <= 0 || mode === 'none') {
    return freqHz;
  }
  const rawMidi = freqToMidi(freqHz);
  const intervals = SCALE_INTERVALS[mode];
  const baseOctave = Math.floor(rawMidi / 12) - 1;
  let bestMidi = Math.round(rawMidi);
  let bestDist = Infinity;

  for (let oct = baseOctave; oct <= baseOctave + 2; oct++) {
    for (const iv of intervals) {
      const candidate = oct * 12 + ((rootPitchClass + iv) % 12);
      const dist = Math.abs(rawMidi - candidate);
      if (dist < bestDist) {
        bestDist = dist;
        bestMidi = candidate;
      }
    }
  }
  return midiToFreq(bestMidi);
}

function toMonoSamples(buf: PcmBuffer): Float32Array {
  if (buf.channels === 1) return buf.samples;
  const frames = Math.floor(buf.samples.length / buf.channels);
  const mono = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const l = buf.samples[f * 2] ?? 0;
    const r = buf.samples[f * 2 + 1] ?? l;
    mono[f] = (l + r) * 0.5;
  }
  return mono;
}

/**
 * Extracts 10ms frames of normalized amplitude envelope A(t), fundamental frequency f0(t)
 * via Normalized Square Difference Function (NSDF) + McLeod first key-maximum selection
 * with parabolic lag refinement, voiced/noise clarity, and zero-crossing rate.
 */
export function analyzeVocalSketch(buf: PcmBuffer, options: AnalyzeOptions = {}): VocalContour {
  const sr = Math.max(8000, buf.sampleRate);
  const mono = toMonoSamples(buf);
  const frameLen = Math.max(64, Math.round(((options.frameMs ?? 25) / 1000) * sr));
  const hopLen = Math.max(32, Math.round(((options.hopMs ?? 10) / 1000) * sr));
  const minLag = Math.max(2, Math.floor(sr / (options.maxFreqHz ?? 1100)));
  const maxLag = Math.min(frameLen - 4, Math.ceil(sr / (options.minFreqHz ?? 65)));
  const silenceRms = options.silenceRms ?? 0.015;

  const frames: VocalFrame[] = [];
  let peakRms = 0;
  const nsdf = new Float64Array(maxLag + 2);

  for (let start = 0; start + frameLen <= mono.length; start += hopLen) {
    let sumSq = 0;
    let zeroCrossings = 0;
    let prev = mono[start] ?? 0;

    for (let i = 0; i < frameLen; i++) {
      const s = mono[start + i] ?? 0;
      sumSq += s * s;
      if (i > 0 && ((s >= 0 && prev < 0) || (s < 0 && prev >= 0))) {
        zeroCrossings++;
      }
      prev = s;
    }

    const rms = Math.sqrt(sumSq / frameLen);
    if (rms > peakRms) peakRms = rms;
    const zcr = zeroCrossings / frameLen;

    if (rms < silenceRms || maxLag <= minLag) {
      frames.push({ timeSec: start / sr, rms: 0, freqHz: 0, clarity: 0, zcr });
      continue;
    }

    // Scan from lag=1 to identify when we exit the lag=0 positive main lobe
    const scanStart = Math.max(1, Math.min(minLag, Math.floor(minLag * 0.5)));
    let passedZeroCrossing = false;
    nsdf.fill(0);

    for (let lag = scanStart; lag <= maxLag + 1 && lag < frameLen - 2; lag++) {
      let acf = 0;
      let m = 0;
      const limit = frameLen - lag;
      for (let i = 0; i < limit; i++) {
        const a = mono[start + i] ?? 0;
        const b = mono[start + i + lag] ?? 0;
        acf += a * b;
        m += a * a + b * b;
      }
      const val = m > 1e-12 ? (2 * acf) / m : 0;
      nsdf[lag] = val;
      if (val <= 0) {
        passedZeroCrossing = true;
      }
    }

    // Collect key local maxima strictly after exiting lag=0 main lobe (or if noise exited immediately)
    let startSearchLag = minLag;
    if (!passedZeroCrossing) {
      // Find first local minimum to avoid locking onto lag=minLag on low-frequency slopes
      for (let lag = scanStart + 1; lag < maxLag; lag++) {
        if ((nsdf[lag] ?? 0) <= (nsdf[lag - 1] ?? 0) && (nsdf[lag] ?? 0) <= (nsdf[lag + 1] ?? 0)) {
          startSearchLag = Math.max(minLag, lag);
          break;
        }
      }
    } else {
      // Advance past initial negative section so first peak is true fundamental period
      for (let lag = scanStart; lag <= maxLag; lag++) {
        if ((nsdf[lag] ?? 0) <= 0) {
          startSearchLag = Math.max(minLag, lag);
          break;
        }
      }
    }

    const peaks: Array<{ lag: number; corr: number }> = [];
    let globalMax = 0;

    for (let lag = Math.max(minLag + 1, startSearchLag); lag <= maxLag; lag++) {
      const cPrev = nsdf[lag - 1] ?? 0;
      const cCur = nsdf[lag] ?? 0;
      const cNext = nsdf[lag + 1] ?? 0;
      if (cCur > 0 && cCur >= cPrev && cCur >= cNext) {
        peaks.push({ lag, corr: cCur });
        if (cCur > globalMax) globalMax = cCur;
      }
    }

    let bestLag = -1;
    let bestCorr = globalMax;
    if (peaks.length > 0 && globalMax > 0) {
      // MPM first key maximum >= 0.90 * globalMax avoids 2*lag subharmonic octave errors
      const threshold = globalMax * 0.9;
      const picked = peaks.find((p) => p.corr >= threshold) ?? peaks[0]!;
      bestCorr = picked.corr;
      const k = picked.lag;
      const cPrev = nsdf[k - 1] ?? picked.corr;
      const cCur = picked.corr;
      const cNext = nsdf[k + 1] ?? picked.corr;
      const denom = 2 * (cPrev - 2 * cCur + cNext);
      const delta =
        Math.abs(denom) > 1e-9 ? Math.max(-0.5, Math.min(0.5, (cPrev - cNext) / denom)) : 0;
      bestLag = k + delta;
    }

    const clarity = Math.max(0, Math.min(1, bestCorr));
    const freqHz = bestLag > 0 && clarity >= 0.55 ? sr / bestLag : 0;
    frames.push({
      timeSec: start / sr,
      rms,
      freqHz,
      clarity,
      zcr,
    });
  }

  const invPeak = peakRms > 1e-6 ? 1 / peakRms : 1;
  const normalizedFrames = frames.map((f) => ({
    ...f,
    rms: Math.min(1, f.rms * invPeak),
  }));

  return {
    hopSec: hopLen / sr,
    durationSec: mono.length / sr,
    peakRms,
    frames: normalizedFrames,
  };
}

/**
 * Extracts quantized MIDI notes (>= 50ms), dominant key, and BPM estimate from a vocal contour.
 */
export function extractMelodySummary(contour: VocalContour): MelodySummary {
  const minNoteFrames = Math.max(1, Math.round(0.05 / Math.max(0.002, contour.hopSec)));
  const notes: DetectedMidiNote[] = [];

  let curMidi = -1;
  let curStartSec = 0;
  let curFrames = 0;
  let curRmsSum = 0;

  const flushNote = () => {
    if (curMidi >= 0 && curFrames >= minNoteFrames) {
      notes.push({
        midi: curMidi,
        startSec: Number(curStartSec.toFixed(3)),
        durationSec: Number((curFrames * contour.hopSec).toFixed(3)),
        avgRms: Number((curRmsSum / curFrames).toFixed(3)),
      });
    }
    curMidi = -1;
    curFrames = 0;
    curRmsSum = 0;
  };

  for (const frame of contour.frames) {
    if (frame.freqHz <= 0 || frame.rms <= 0.02) {
      flushNote();
      continue;
    }
    const qMidi = Math.round(freqToMidi(frame.freqHz));
    if (qMidi === curMidi) {
      curFrames += 1;
      curRmsSum += frame.rms;
    } else {
      flushNote();
      curMidi = qMidi;
      curStartSec = frame.timeSec;
      curFrames = 1;
      curRmsSum = frame.rms;
    }
  }
  flushNote();

  // Estimate BPM from inter-note onset intervals (normalized into 75..165 BPM)
  let detectedBpm = 120;
  if (notes.length >= 2) {
    const gaps: number[] = [];
    for (let i = 1; i < notes.length; i++) {
      const gap = notes[i]!.startSec - notes[i - 1]!.startSec;
      if (gap >= 0.12 && gap <= 2.0) gaps.push(gap);
    }
    if (gaps.length > 0) {
      gaps.sort((a, b) => a - b);
      const medianGap = gaps[Math.floor(gaps.length / 2)]!;
      let bpm = 60 / medianGap;
      while (bpm < 75) bpm *= 2;
      while (bpm > 165) bpm /= 2;
      detectedBpm = Math.round(bpm);
    }
  }

  // Histogram pitch classes to pick dominant key
  const pcCounts = new Array<number>(12).fill(0);
  for (const n of notes) {
    const pc = ((n.midi % 12) + 12) % 12;
    pcCounts[pc] = (pcCounts[pc] ?? 0) + n.durationSec;
  }
  let topPc = 0;
  let topWeight = -1;
  for (let pc = 0; pc < 12; pc++) {
    if ((pcCounts[pc] ?? 0) > topWeight) {
      topWeight = pcCounts[pc] ?? 0;
      topPc = pc;
    }
  }
  const minorThirdWeight = pcCounts[(topPc + 3) % 12] ?? 0;
  const majorThirdWeight = pcCounts[(topPc + 4) % 12] ?? 0;
  const quality = minorThirdWeight > majorThirdWeight ? 'Minor' : 'Major';

  return {
    notes,
    detectedBpm,
    dominantKey: `${NOTE_NAMES[topPc] ?? 'C'} ${quality}`,
  };
}
