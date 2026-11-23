import { useEffect, useRef } from 'react';
import type { PcmBuffer } from '../../audio/types';
import type { MelodySummary, VocalContour } from '../../audio/vocalAnalyzer';

export interface PitchRibbonCanvasProps {
  readonly sketchPcm: PcmBuffer | null;
  readonly contour: VocalContour | null;
  readonly melody: MelodySummary | null;
  readonly sha256?: string | null;
}

const MIN_PITCH_HZ = 65;
const MAX_PITCH_HZ = 1100;
const LOG_MIN = Math.log2(MIN_PITCH_HZ);
const LOG_MAX = Math.log2(MAX_PITCH_HZ);

function freqToRibbonY(freqHz: number, height: number): number {
  const clamped = Math.max(MIN_PITCH_HZ, Math.min(MAX_PITCH_HZ, freqHz));
  const norm = (Math.log2(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  const pad = 12;
  return height - pad - norm * (height - pad * 2);
}

/**
 * Interactive acoustic sketch visualizer:
 * renders slate normalized RMS waveform bars, amber unvoiced mouth-foley bands,
 * and a glowing cyan logarithmic f0(t) pitch contour (65–1100 Hz).
 */
export function PitchRibbonCanvas({ sketchPcm, contour, melody, sha256 }: PitchRibbonCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.save();
    ctx.fillStyle = '#090D16';
    ctx.fillRect(0, 0, w, h);

    // Subtle logarithmic pitch reference grid
    ctx.strokeStyle = 'rgba(148, 163, 184, 0.14)';
    ctx.fillStyle = 'rgba(148, 163, 184, 0.45)';
    ctx.font = '10px monospace';
    ctx.lineWidth = 1;
    for (const refHz of [110, 220, 440, 880]) {
      const y = Math.round(freqToRibbonY(refHz, h)) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
      ctx.fillText(`${refHz}Hz`, 6, y - 3);
    }

    if (!contour || contour.frames.length === 0 || !sketchPcm || sketchPcm.samples.length === 0) {
      ctx.fillStyle = 'rgba(148, 163, 184, 0.55)';
      ctx.font = '12px sans-serif';
      ctx.fillText(
        'No hum or vocal sketch loaded. Hold R, click Record (10s max), or upload a .wav file.',
        18,
        Math.floor(h / 2) + 4,
      );
      ctx.restore();
      return;
    }

    const frames = contour.frames;
    const frameCount = frames.length;
    const colW = w / Math.max(1, frameCount);

    // 1. Amber bands on unvoiced mouth-foley bursts (e.g. "kshhh", "pff", desk tap)
    ctx.fillStyle = 'rgba(245, 158, 11, 0.24)';
    for (let i = 0; i < frameCount; i++) {
      const f = frames[i]!;
      if (f.clarity < 0.55 && f.rms > 0.1) {
        ctx.fillRect(i * colW, 0, Math.max(2, colW + 0.5), h);
      }
    }

    // 2. Slate normalized RMS amplitude bars from sketch PCM
    const ch = sketchPcm.channels;
    const totalPcmFrames = Math.floor(sketchPcm.samples.length / ch);
    const barCount = Math.min(w, 170);
    const barW = w / barCount;
    const midY = Math.floor(h / 2);
    const normPeak = Math.max(0.05, contour.peakRms * 1.45);
    ctx.fillStyle = 'rgba(148, 163, 184, 0.36)';
    for (let b = 0; b < barCount; b++) {
      const s0 = Math.floor((b / barCount) * totalPcmFrames);
      const s1 = Math.max(s0 + 1, Math.floor(((b + 1) / barCount) * totalPcmFrames));
      let sumSq = 0;
      let n = 0;
      const stride = Math.max(1, Math.floor((s1 - s0) / 16));
      for (let s = s0; s < s1 && s < totalPcmFrames; s += stride) {
        const v = sketchPcm.samples[s * ch] ?? 0;
        sumSq += v * v;
        n++;
      }
      const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;
      const amp = Math.min(1, rms / normPeak);
      const barH = Math.max(2, amp * (h * 0.72));
      ctx.fillRect(b * barW, midY - barH / 2, Math.max(1, barW - 1), barH);
    }

    // 3. Glowing cyan logarithmic f0(t) pitch contour (65-1100 Hz)
    ctx.save();
    ctx.strokeStyle = '#22D3EE';
    ctx.shadowColor = '#22D3EE';
    ctx.shadowBlur = 8;
    ctx.lineWidth = 2.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';

    let inStroke = false;
    ctx.beginPath();
    for (let i = 0; i < frameCount; i++) {
      const f = frames[i]!;
      const voiced = f.freqHz >= MIN_PITCH_HZ && f.clarity >= 0.45 && f.rms > 0.01;
      const x = ((i + 0.5) / frameCount) * w;
      if (voiced) {
        const y = freqToRibbonY(f.freqHz, h);
        if (!inStroke) {
          ctx.moveTo(x, y);
          inStroke = true;
        } else {
          ctx.lineTo(x, y);
        }
      } else {
        inStroke = false;
      }
    }
    ctx.stroke();

    // Accent dots on voiced frames for short glottal chirps
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#67E8F9';
    for (let i = 0; i < frameCount; i++) {
      const f = frames[i]!;
      if (f.freqHz >= MIN_PITCH_HZ && f.clarity >= 0.45 && f.rms > 0.01) {
        const x = ((i + 0.5) / frameCount) * w;
        const y = freqToRibbonY(f.freqHz, h);
        ctx.fillRect(x - 1, y - 1, 2, 2);
      }
    }
    ctx.restore();
    ctx.restore();
  }, [sketchPcm, contour]);

  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
        <span className="font-semibold tracking-wider text-cyan-300 uppercase">
          Vocal Pitch &amp; Foley Ribbon (f0 / RMS / Unvoiced)
        </span>
        {contour && melody && (
          <div
            data-testid="pitch-ribbon-telemetry"
            className="flex flex-wrap items-center gap-1.5 font-mono text-[10px]"
          >
            <span className="rounded border border-cyan-500/40 bg-cyan-500/15 px-2 py-0.5 text-cyan-200">
              {melody.detectedBpm} BPM · {melody.dominantKey}
            </span>
            <span className="rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-slate-300">
              {melody.notes.length} note(s) · {contour.durationSec.toFixed(2)}s
            </span>
            {sha256 && (
              <span className="rounded border border-slate-800 bg-slate-950 px-2 py-0.5 text-slate-400">
                sha:{sha256.slice(0, 8)}
              </span>
            )}
          </div>
        )}
      </div>
      <canvas
        ref={canvasRef}
        data-testid="pitch-ribbon-canvas"
        width={680}
        height={140}
        className="h-[140px] w-full rounded-lg border border-slate-800 bg-slate-950"
      />
    </div>
  );
}
