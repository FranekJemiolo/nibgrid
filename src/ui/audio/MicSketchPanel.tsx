import { useEffect, useRef, type ChangeEvent } from 'react';
import { Mic, Play, Sparkles, Square, Upload, Waves } from 'lucide-react';
import type { ContourTimbrePatch } from '../../audio/contourPatchSchema';
import { estimateHumRouteCost, type HumToSoundRoute } from '../../audio/humToSoundProvider';
import type { RecordedSketchResult } from '../../audio/micRecorder';
import type { ScaleQuantizeMode } from '../../audio/vocalAnalyzer';

export type HumQuickChipId = 'scifi' | 'engine' | 'impact' | 'melody' | 'lyria' | 'bark';

export interface MicSketchPanelProps {
  readonly isActiveTab: boolean;
  readonly sketchResult: RecordedSketchResult | null;
  readonly humRoute: HumToSoundRoute;
  readonly contourPatch: ContourTimbrePatch;
  readonly promptText: string;
  readonly ttsVoice: string;
  readonly ttsStyle: string;
  readonly abMode: 'raw' | 'processed';
  readonly isRecording: boolean;
  readonly isTransforming: boolean;
  readonly vuLevel: number;
  readonly recordingSec: number;
  readonly onStartRecording: () => void;
  readonly onStopRecording: () => void;
  readonly onUploadWav: (file: File) => void;
  readonly onSelectRoute: (route: HumToSoundRoute) => void;
  readonly onChangePrompt: (prompt: string) => void;
  readonly onChangeTtsVoice: (voice: string) => void;
  readonly onChangeTtsStyle: (style: string) => void;
  readonly onChangePatch: (patch: ContourTimbrePatch) => void;
  readonly onApplyChip: (chipId: HumQuickChipId) => void;
  readonly onTransformSketch: () => void;
  readonly onToggleAbMode: () => void;
  readonly onPlayAb: () => void;
}

const HUM_TTS_VOICES = ['Fenrir', 'Puck', 'Charon', 'Kore', 'Aoede'] as const;

function isEditableElement(target: EventTarget | null): boolean {
  if (!target || !(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function MicSketchPanel({
  isActiveTab,
  sketchResult,
  humRoute,
  contourPatch,
  promptText,
  ttsVoice,
  ttsStyle,
  abMode,
  isRecording,
  isTransforming,
  vuLevel,
  recordingSec,
  onStartRecording,
  onStopRecording,
  onUploadWav,
  onSelectRoute,
  onChangePrompt,
  onChangeTtsVoice,
  onChangeTtsStyle,
  onChangePatch,
  onApplyChip,
  onTransformSketch,
  onToggleAbMode,
  onPlayAb,
}: MicSketchPanelProps) {
  const pointerDownAtRef = useRef<number>(0);
  const startedViaHoldKeyRef = useRef<boolean>(false);
  const isRecordingRef = useRef<boolean>(isRecording);
  isRecordingRef.current = isRecording;

  // Hold-to-Record 'R' shortcut strictly isolated from form inputs & textareas
  useEffect(() => {
    if (!isActiveTab) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key.toLowerCase() !== 'r') return;
      if (isEditableElement(e.target) || isEditableElement(document.activeElement)) return;
      if (!isRecordingRef.current) {
        e.preventDefault();
        startedViaHoldKeyRef.current = true;
        onStartRecording();
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'r') return;
      if (startedViaHoldKeyRef.current) {
        startedViaHoldKeyRef.current = false;
        if (isRecordingRef.current) {
          onStopRecording();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
    };
  }, [isActiveTab, onStartRecording, onStopRecording]);

  const cost = estimateHumRouteCost(humRoute);
  const vuWidthPct = Math.min(100, Math.max(2, Math.round(vuLevel * 320)));

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      onUploadWav(file);
    }
    e.target.value = '';
  };

  return (
    <div className="space-y-4">
      {/* Capture Header + Hold-to-Record + WAV Upload */}
      <div className="space-y-2.5 rounded-lg border border-cyan-500/30 bg-slate-950/75 p-3">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-cyan-200 uppercase">
            <Mic className="h-3.5 w-3.5 text-cyan-400" />
            Mic Sketch Capture (10s max)
          </h3>
          <span
            data-testid="hum-cost-badge"
            className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-200"
          >
            {cost.label}
          </span>
        </div>

        <button
          type="button"
          data-testid="hum-record-btn"
          onPointerDown={() => {
            pointerDownAtRef.current = performance.now();
            if (!isRecording) {
              onStartRecording();
            }
          }}
          onPointerUp={() => {
            const heldMs = performance.now() - pointerDownAtRef.current;
            if (isRecording && heldMs >= 200) {
              onStopRecording();
            }
          }}
          onClick={() => {
            // Supports keyboard activation & quick click toggle when held < 200ms
            const sinceDown = performance.now() - pointerDownAtRef.current;
            if (isRecording && sinceDown < 200) {
              // Wait: if click came immediately after pointerDown that just started recording, keep active
              // until a second click (> 250ms later) or Stop button press.
              if (sinceDown === 0) {
                onStopRecording();
              }
            }
          }}
          className={`inline-flex w-full items-center justify-center gap-2 rounded-md border px-3 py-2 text-xs font-semibold transition-colors ${
            isRecording
              ? 'border-rose-400 bg-rose-600 text-white animate-pulse'
              : 'border-cyan-500/50 bg-cyan-600/25 text-cyan-100 hover:bg-cyan-600/40'
          }`}
        >
          {isRecording ? (
            <>
              <Square className="h-3.5 w-3.5" />
              Recording… {recordingSec.toFixed(1)}s / 10.0s (Release R or Click Stop)
            </>
          ) : (
            <>
              <Mic className="h-3.5 w-3.5" />
              Hold R / Press to Record Hum (10s cap)
            </>
          )}
        </button>

        {isRecording && (
          <button
            type="button"
            data-testid="hum-stop-btn"
            onClick={onStopRecording}
            className="w-full rounded border border-rose-500/40 bg-rose-950/60 px-2.5 py-1 text-[11px] font-medium text-rose-200 hover:bg-rose-900/60"
          >
            Stop Capture Now
          </button>
        )}

        {/* Live RMS VU Meter */}
        <div className="space-y-1">
          <div className="flex justify-between font-mono text-[10px] text-slate-400">
            <span>Input VU</span>
            <span>{recordingSec.toFixed(1)}s / 10.0s</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full border border-slate-800 bg-slate-900">
            <div
              data-testid="hum-vu-bar"
              style={{ width: `${vuWidthPct}%` }}
              className={`h-full transition-all duration-75 ${
                isRecording ? 'bg-cyan-400' : 'bg-slate-600'
              }`}
            />
          </div>
        </div>

        {/* Upload .wav Fallback */}
        <label className="flex cursor-pointer items-center justify-center gap-1.5 rounded border border-dashed border-slate-700 bg-slate-900/80 px-2.5 py-1.5 text-[11px] text-slate-300 hover:border-cyan-500/60 hover:text-cyan-100">
          <Upload className="h-3.5 w-3.5 text-cyan-400" />
          <span>Upload .wav Vocal Sketch</span>
          <input
            type="file"
            accept=".wav,audio/wav"
            data-testid="hum-upload-input"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>

        {sketchResult && (
          <div className="rounded border border-slate-800 bg-slate-900/70 px-2.5 py-1.5 font-mono text-[10px] text-slate-300">
            Loaded: {sketchResult.contour.durationSec.toFixed(2)}s ·{' '}
            {sketchResult.melody.detectedBpm} BPM · {sketchResult.melody.dominantKey}
          </div>
        )}
      </div>

      {/* 6 Quick Intent Chips */}
      <div className="space-y-1.5">
        <div className="text-[11px] font-medium text-slate-300">Quick Intent Presets</div>
        <div className="grid grid-cols-2 gap-1.5 text-[11px]">
          <button
            type="button"
            data-testid="hum-chip-scifi"
            onClick={() => onApplyChip('scifi')}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-left text-slate-200 hover:border-cyan-500/60"
          >
            Laser / Pew ($0)
          </button>
          <button
            type="button"
            data-testid="hum-chip-engine"
            onClick={() => onApplyChip('engine')}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-left text-slate-200 hover:border-cyan-500/60"
          >
            Engine Rev ($0)
          </button>
          <button
            type="button"
            data-testid="hum-chip-impact"
            onClick={() => onApplyChip('impact')}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-left text-slate-200 hover:border-cyan-500/60"
          >
            Heavy Impact ($0)
          </button>
          <button
            type="button"
            data-testid="hum-chip-melody"
            onClick={() => onApplyChip('melody')}
            className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-left text-slate-200 hover:border-cyan-500/60"
          >
            Chiptune Hum ($0)
          </button>
          <button
            type="button"
            data-testid="hum-chip-lyria"
            onClick={() => onApplyChip('lyria')}
            className="rounded border border-indigo-500/40 bg-indigo-950/40 px-2 py-1 text-left text-indigo-200 hover:border-indigo-400"
          >
            Hum → Lyria Music
          </button>
          <button
            type="button"
            data-testid="hum-chip-bark"
            onClick={() => onApplyChip('bark')}
            className="rounded border border-amber-500/40 bg-amber-950/40 px-2 py-1 text-left text-amber-200 hover:border-amber-400"
          >
            Voice → Monster
          </button>
        </div>
      </div>

      {/* Multimodal Route & Prompt */}
      <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-slate-300">Transformation Route</span>
          <select
            data-testid="hum-route-select"
            value={humRoute}
            onChange={(e) => onSelectRoute(e.target.value as HumToSoundRoute)}
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          >
            <option value="local-contour">Local Contour Synth ($0.00)</option>
            <option value="hum-to-timbre">Gemini Audio → Timbre Patch (~$0.001)</option>
            <option value="hum-to-lyria">Hum → Lyria 3 Full Clip (~$0.04)</option>
            <option value="hum-to-tts">Vocal Cadence → Gemini TTS (~$0.005)</option>
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] font-medium text-slate-300">Sound Design Intent Prompt</span>
          <textarea
            data-testid="hum-prompt-input"
            rows={2}
            value={promptText}
            onChange={(e) => onChangePrompt(e.target.value)}
            placeholder="e.g. heavy plasma cannon pew with metallic sub tail"
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
          />
        </label>

        {humRoute === 'hum-to-tts' && (
          <div className="grid grid-cols-1 gap-2 rounded border border-slate-800 bg-slate-900/50 p-2">
            <label className="block space-y-1">
              <span className="text-[10px] text-slate-400">TTS Voice Actor</span>
              <select
                value={ttsVoice}
                onChange={(e) => onChangeTtsVoice(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100"
              >
                {HUM_TTS_VOICES.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            <label className="block space-y-1">
              <span className="text-[10px] text-slate-400">Direction</span>
              <input
                type="text"
                value={ttsStyle}
                onChange={(e) => onChangeTtsStyle(e.target.value)}
                className="w-full rounded border border-slate-700 bg-slate-950 px-2 py-1 text-[11px] text-slate-100"
              />
            </label>
          </div>
        )}

        <div className="flex gap-2">
          <button
            type="button"
            data-testid="hum-transform-btn"
            disabled={!sketchResult || isTransforming}
            onClick={onTransformSketch}
            className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-cyan-600 px-3 py-2 text-xs font-semibold text-white hover:bg-cyan-500 disabled:opacity-40"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {isTransforming
              ? 'Transforming…'
              : humRoute === 'local-contour'
                ? 'Render Local Contour ($0)'
                : 'Transform Sketch'}
          </button>

          <button
            type="button"
            data-testid="hum-ab-toggle"
            disabled={!sketchResult}
            onClick={onToggleAbMode}
            className={`rounded-md border px-2.5 py-2 text-[11px] font-semibold disabled:opacity-40 ${
              abMode === 'raw'
                ? 'border-sky-400 bg-sky-500/20 text-sky-100'
                : 'border-cyan-500/40 bg-cyan-500/15 text-cyan-200'
            }`}
          >
            {abMode === 'raw' ? 'My Hum' : 'Transformed Sound'}
          </button>
        </div>

        <button
          type="button"
          data-testid="hum-ab-play-btn"
          disabled={!sketchResult}
          onClick={onPlayAb}
          className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800 disabled:opacity-40"
        >
          <Play className="h-3 w-3 text-emerald-400" />
          Audition {abMode === 'raw' ? 'My Hum' : 'Transformed Sound'}
        </button>
      </div>

      {/* Live $0.00 Local Contour Fine-Tuning Sliders */}
      <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-1.5 font-semibold text-slate-200">
            <Waves className="h-3.5 w-3.5 text-cyan-400" />
            Contour Timbre Shaper ($0.00)
          </span>
          <span className="font-mono text-[10px] text-slate-400">{contourPatch.oscShape}</span>
        </div>

        <label className="block space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>Octave Shift</span>
            <span className="font-mono">
              {contourPatch.octaveShift > 0
                ? `+${contourPatch.octaveShift}`
                : contourPatch.octaveShift}{' '}
              oct
            </span>
          </div>
          <input
            type="range"
            data-testid="hum-octave-shift"
            min={-2}
            max={2}
            step={1}
            value={contourPatch.octaveShift}
            onChange={(e) =>
              onChangePatch({ ...contourPatch, octaveShift: Number(e.target.value) })
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="block space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>Pitch Smooth (ms)</span>
            <span className="font-mono">{Math.round(contourPatch.pitchSmoothMs)} ms</span>
          </div>
          <input
            type="range"
            data-testid="hum-pitch-smooth"
            min={0}
            max={120}
            step={5}
            value={Math.round(contourPatch.pitchSmoothMs)}
            onChange={(e) =>
              onChangePatch({ ...contourPatch, pitchSmoothMs: Number(e.target.value) })
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-[11px] text-slate-400">Scale Quantize</span>
          <select
            data-testid="hum-scale-quantize"
            value={contourPatch.scaleQuantize}
            onChange={(e) =>
              onChangePatch({
                ...contourPatch,
                scaleQuantize: e.target.value as ScaleQuantizeMode,
              })
            }
            className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-100"
          >
            <option value="none">Raw Continuous Pitch</option>
            <option value="chromatic">Chromatic (12-TET)</option>
            <option value="pentatonic">Major Pentatonic</option>
            <option value="minor">Natural Minor</option>
          </select>
        </label>

        <label className="block space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>FM Bite Depth</span>
            <span className="font-mono">{contourPatch.fmDepth.toFixed(1)}</span>
          </div>
          <input
            type="range"
            data-testid="hum-fm-depth"
            min={0}
            max={24}
            step={0.5}
            value={contourPatch.fmDepth}
            onChange={(e) => onChangePatch({ ...contourPatch, fmDepth: Number(e.target.value) })}
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="block space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>Unvoiced Breath / Foley Mix</span>
            <span className="font-mono">{contourPatch.unvoicedNoiseGain.toFixed(2)}</span>
          </div>
          <input
            type="range"
            data-testid="hum-noise-gain"
            min={0}
            max={1}
            step={0.05}
            value={contourPatch.unvoicedNoiseGain}
            onChange={(e) =>
              onChangePatch({ ...contourPatch, unvoicedNoiseGain: Number(e.target.value) })
            }
            className="w-full accent-cyan-400"
          />
        </label>

        <label className="block space-y-1">
          <div className="flex justify-between text-[11px] text-slate-400">
            <span>Bitcrush Resolution</span>
            <span className="font-mono">{contourPatch.bitDepth}-bit</span>
          </div>
          <input
            type="range"
            data-testid="hum-bit-depth"
            min={4}
            max={16}
            step={1}
            value={contourPatch.bitDepth}
            onChange={(e) => onChangePatch({ ...contourPatch, bitDepth: Number(e.target.value) })}
            className="w-full accent-cyan-400"
          />
        </label>
      </div>
    </div>
  );
}

