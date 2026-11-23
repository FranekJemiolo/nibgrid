import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Dices,
  Download,
  FileArchive,
  FolderOutput,
  Mic,
  Music,
  Play,
  Repeat,
  Save,
  Sparkles,
  Square,
  Trash2,
} from 'lucide-react';
import { STARTER_CONTOUR_PATCHES, type ContourTimbrePatch } from '../../audio/contourPatchSchema';
import {
  GOOGLE_AUDIO_PRESETS,
  compileAudioPresetPrompt,
  getGoogleAudioPreset,
} from '../../audio/googlePresets';
import {
  estimateGoogleAudioCost,
  findGeminiAudioCredential,
  invokeGoogleAudioRoute,
  type LyriaReferenceImage,
} from '../../audio/googleAudioProvider';
import { invokeHumToSoundRoute, type HumToSoundRoute } from '../../audio/humToSoundProvider';
import {
  ingestWavSketchBytes,
  MicRecorder,
  type RecordedSketchResult,
} from '../../audio/micRecorder';
import { AudioPlaybackEngine, decodeAudioBytesToPcm } from '../../audio/playbackEngine';
import { detectNonVocalSfxTags } from '../../audio/synthResponseSchema';
import type {
  AudioCategory,
  AudioPostProcessConfig,
  GoogleAudioRoute,
  PcmBuffer,
  ProceduralSfxParams,
} from '../../audio/types';
import { repository } from '../../db/database';
import { createDefaultAudioPostProcessConfig, type AudioAsset } from '../../domain/schemas';
import { buildAudioRecipe, packageAudioZip } from '../../export/audioExport';
import { supportsFileSystemAccess } from '../../export/fsAccess';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { uint8ToBase64 } from '../../processing/png';
import { createMonotonicRequestGuard } from '../../workers/postprocessClient';
import { runAudioPipelineInWorker } from '../../workers/audioClient';
import { type AudioWorkerSuccess } from '../../workers/audio.worker';
import { useAppStore } from '../../store/useAppStore';
import { MicSketchPanel, type HumQuickChipId } from './MicSketchPanel';
import { PitchRibbonCanvas } from './PitchRibbonCanvas';

const TTS_VOICES = ['Fenrir', 'Puck', 'Charon', 'Kore', 'Aoede'] as const;
const VOCAL_TAG_CHIPS = ['<grunt>', '<chuckle>', '<gasp>', '<sigh>', '<pause>'] as const;

export function AudioFoundry() {
  const {
    activeProject,
    spriteNodes,
    audioAssets,
    providers,
    setVaultOpen,
    saveAudioAssetRecord,
    deleteAudioAssetRecord,
  } = useAppStore();

  const initialPreset = useMemo(() => getGoogleAudioPreset('sfx-sprite-impact'), []);

  const [categoryFilter, setCategoryFilter] = useState<'all' | AudioCategory>('all');
  const [selectedPresetId, setSelectedPresetId] = useState<string>(initialPreset.id);
  const [route, setRoute] = useState<GoogleAudioRoute>('local-synth');
  const [modelId, setModelId] = useState<string>(initialPreset.modelId);
  const [clipName, setClipName] = useState<string>(initialPreset.label);

  // Prompt / Voice / Music authoring inputs
  const [promptText, setPromptText] = useState<string>(() =>
    compileAudioPresetPrompt(initialPreset.promptTemplate, {
      subject: activeProject?.name || '2D warrior sprite',
      biome: 'dark dungeon',
      mood: 'punchy retro indie',
      bpm: 128,
    }),
  );
  const [bpm, setBpm] = useState<number>(128);
  const [mood, setMood] = useState<string>('punchy retro indie');
  const [attachSprite, setAttachSprite] = useState<boolean>(
    Boolean(initialPreset.attachActiveSpriteImage),
  );
  const [ttsVoice, setTtsVoice] = useState<string>('Fenrir');
  const [ttsStyle, setTtsStyle] = useState<string>(
    'Gritty armored warrior taking a sudden physical hit, short sharp exertion, dry studio mic',
  );
  const [ttsScript, setTtsScript] = useState<string>('<grunt> Agh!');

  // Procedural 3-layer synth state & external decoded PCM state
  const [synthParams, setSynthParams] = useState<ProceduralSfxParams>(
    initialPreset.fallbackSynthParams,
  );
  const [sourcePcm, setSourcePcm] = useState<PcmBuffer | null>(null);
  const [postProcess, setPostProcess] = useState<AudioPostProcessConfig>(() => ({
    ...createDefaultAudioPostProcessConfig(),
    ...initialPreset.postProcessDefaults,
  }));
  const [variationCount, setVariationCount] = useState<1 | 4 | 6>(4);
  const [selectedVarIdx, setSelectedVarIdx] = useState<number>(0);

  // Hum-to-Sound (Mic Sketch) state (M15)
  const [sourceTab, setSourceTab] = useState<'presets' | 'mic-sketch'>('presets');
  const [sketchResult, setSketchResult] = useState<RecordedSketchResult | null>(null);
  const [humRoute, setHumRoute] = useState<HumToSoundRoute>('local-contour');
  const [humModelId, setHumModelId] = useState<string>('local-contour-follow');
  const [contourPatch, setContourPatch] = useState<ContourTimbrePatch>(
    () => STARTER_CONTOUR_PATCHES[0]!.patch,
  );
  const [humPrompt, setHumPrompt] = useState<string>(STARTER_CONTOUR_PATCHES[0]!.promptHint);
  const [humRemotePcm, setHumRemotePcm] = useState<PcmBuffer | null>(null);
  const [isRecordingMic, setIsRecordingMic] = useState<boolean>(false);
  const [micVuLevel, setMicVuLevel] = useState<number>(0);
  const [micElapsedSec, setMicElapsedSec] = useState<number>(0);

  // Transport & UI state
  const [workerResult, setWorkerResult] = useState<AudioWorkerSuccess | null>(null);
  const [abMode, setAbMode] = useState<'processed' | 'raw'>('processed');
  const [loopPlay, setLoopPlay] = useState<boolean>(false);
  const [isGeneratingRemote, setIsGeneratingRemote] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const waveformCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const playerRef = useRef<AudioPlaybackEngine | null>(null);
  const micRecorderRef = useRef<MicRecorder | null>(null);
  const requestGuardRef = useRef(createMonotonicRequestGuard());
  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const engine = new AudioPlaybackEngine();
    playerRef.current = engine;
    const guard = requestGuardRef.current;
    return () => {
      guard.invalidate();
      abortControllerRef.current?.abort();
      micRecorderRef.current?.dispose();
      micRecorderRef.current = null;
      void engine.dispose();
      playerRef.current = null;
    };
  }, []);

  const handleSelectPreset = (presetId: string) => {
    const preset = getGoogleAudioPreset(presetId);
    setSelectedPresetId(preset.id);
    setRoute(preset.route);
    setModelId(preset.modelId);
    setClipName(preset.label);
    setSynthParams(preset.fallbackSynthParams);
    setSourcePcm(null);
    setSelectedVarIdx(0);
    setAttachSprite(Boolean(preset.attachActiveSpriteImage));
    setPromptText(
      compileAudioPresetPrompt(preset.promptTemplate, {
        subject: activeProject?.name || '2D warrior sprite',
        biome: 'dark dungeon',
        mood,
        bpm,
      }),
    );
    if (preset.ttsConfig) {
      setTtsVoice(preset.ttsConfig.defaultVoice);
      setTtsStyle(preset.ttsConfig.styleDirection);
      setTtsScript(preset.ttsConfig.sampleScript);
    }
    setPostProcess({
      ...createDefaultAudioPostProcessConfig(),
      trimSilence: preset.postProcessDefaults.trimSilence,
      silenceThresholdDb: preset.postProcessDefaults.silenceThresholdDb ?? -48,
      targetLufs: preset.postProcessDefaults.targetLufs,
      seamlessLoop: preset.postProcessDefaults.seamlessLoop,
      loopCrossfadeMs: preset.postProcessDefaults.loopCrossfadeMs,
      pitchShiftPercent: preset.postProcessDefaults.pitchShiftPercent,
      cropStartSec: 0,
      cropEndSec: 0,
    });
    setVariationCount(preset.postProcessDefaults.variationCount);
    setErrorMessage(null);
  };

  // Run pure-TS audio synthesis + DSP + variations inside Dedicated Audio Web Worker
  useEffect(() => {
    const token = requestGuardRef.current.next();

    if (sourceTab === 'mic-sketch') {
      if (!sketchResult) {
        setWorkerResult(null);
        return;
      }
      const useRemotePcm =
        humRemotePcm !== null && (humRoute === 'hum-to-lyria' || humRoute === 'hum-to-tts');
      void runAudioPipelineInWorker({
        sourceKind: useRemotePcm ? 'pcm' : 'contour',
        ...(useRemotePcm
          ? { rawPcm: humRemotePcm }
          : {
              rawPcm: sketchResult.pcm,
              contour: sketchResult.contour,
              contourPatch,
            }),
        postProcess,
        variationCount,
        seed: synthParams.seed,
      })
        .then((res) => {
          if (!requestGuardRef.current.isCurrent(token)) return;
          setWorkerResult(res);
        })
        .catch((err: unknown) => {
          if (!requestGuardRef.current.isCurrent(token)) return;
          setErrorMessage(err instanceof Error ? err.message : 'Audio worker processing failed.');
        });
      return;
    }

    const useRawPcm = sourcePcm !== null && route !== 'local-synth' && route !== 'gemini-to-synth';

    void runAudioPipelineInWorker({
      sourceKind: useRawPcm ? 'pcm' : 'procedural',
      ...(useRawPcm ? { rawPcm: sourcePcm } : { synthParams }),
      postProcess,
      variationCount,
      seed: synthParams.seed,
    })
      .then((res) => {
        if (!requestGuardRef.current.isCurrent(token)) return;
        setWorkerResult(res);
      })
      .catch((err: unknown) => {
        if (!requestGuardRef.current.isCurrent(token)) return;
        setErrorMessage(err instanceof Error ? err.message : 'Audio worker processing failed.');
      });
  }, [
    sourceTab,
    sketchResult,
    humRoute,
    humRemotePcm,
    contourPatch,
    synthParams,
    sourcePcm,
    postProcess,
    variationCount,
    route,
  ]);

  const rawDurationSec = useMemo(() => {
    const pcm = workerResult?.rawPcm;
    if (!pcm) return 0;
    const frames = Math.floor(pcm.samples.length / pcm.channels);
    return frames / Math.max(1, pcm.sampleRate);
  }, [workerResult?.rawPcm]);

  const effectiveRawPcm = useMemo(
    () => (sourceTab === 'mic-sketch' && sketchResult ? sketchResult.pcm : workerResult?.rawPcm),
    [sourceTab, sketchResult, workerResult?.rawPcm],
  );

  const activeVariation =
    workerResult?.variations[
      Math.min(selectedVarIdx, Math.max(0, (workerResult?.variations.length ?? 1) - 1))
    ] ??
    workerResult?.variations[0] ??
    null;

  const displayedDurationSec = useMemo(() => {
    const targetPcm = abMode === 'raw' ? effectiveRawPcm : activeVariation?.buffer;
    if (!targetPcm) return 0;
    return (
      Math.floor(targetPcm.samples.length / targetPcm.channels) / Math.max(1, targetPcm.sampleRate)
    );
  }, [abMode, effectiveRawPcm, activeVariation?.buffer]);

  // Draw interactive Canvas2D waveform with pre-trim ghost region, crop handles & loop seam
  useEffect(() => {
    const canvas = waveformCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.fillStyle = '#090D16';
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.fillStyle = '#1E293B';
    ctx.fillRect(0, Math.floor(h / 2), w, 1);

    const raw = effectiveRawPcm;
    const proc = activeVariation?.buffer;
    const primary = abMode === 'raw' ? raw : (proc ?? raw);
    if (!primary || primary.samples.length === 0) return;

    // Ghost outline of raw signal behind processed waveform
    if (abMode === 'processed' && raw && raw.samples.length > 0) {
      const ch = raw.channels;
      const frames = Math.floor(raw.samples.length / ch);
      ctx.fillStyle = 'rgba(100, 116, 139, 0.28)';
      for (let x = 0; x < w; x++) {
        const f0 = Math.floor((x / w) * frames);
        const f1 = Math.max(f0 + 1, Math.floor(((x + 1) / w) * frames));
        let pk = 0;
        for (let f = f0; f < f1 && f < frames; f += Math.max(1, Math.floor((f1 - f0) / 8))) {
          pk = Math.max(pk, Math.abs(raw.samples[f * ch] ?? 0));
        }
        const barH = Math.max(1, Math.round(pk * (h * 0.86)));
        ctx.fillRect(x, Math.floor((h - barH) / 2), 1, barH);
      }
    }

    // Active waveform
    const ch = primary.channels;
    const frames = Math.floor(primary.samples.length / ch);
    ctx.fillStyle = abMode === 'raw' ? '#38BDF8' : '#6366F1';
    for (let x = 0; x < w; x++) {
      const f0 = Math.floor((x / w) * frames);
      const f1 = Math.max(f0 + 1, Math.floor(((x + 1) / w) * frames));
      let pk = 0;
      for (let f = f0; f < f1 && f < frames; f += Math.max(1, Math.floor((f1 - f0) / 8))) {
        pk = Math.max(pk, Math.abs(primary.samples[f * ch] ?? 0));
      }
      const barH = Math.max(2, Math.round(pk * (h * 0.86)));
      ctx.fillRect(x, Math.floor((h - barH) / 2), 1, barH);
    }

    // Crop boundary handles & dim overlays
    if (rawDurationSec > 0 && (postProcess.cropStartSec > 0 || postProcess.cropEndSec > 0)) {
      const startX = Math.round((postProcess.cropStartSec / rawDurationSec) * w);
      const endSec = postProcess.cropEndSec > 0 ? postProcess.cropEndSec : rawDurationSec;
      const endX = Math.round((endSec / rawDurationSec) * w);
      ctx.fillStyle = 'rgba(2, 6, 23, 0.55)';
      if (startX > 0) ctx.fillRect(0, 0, startX, h);
      if (endX < w) ctx.fillRect(endX, 0, w - endX, h);
      ctx.fillStyle = '#22D3EE';
      ctx.fillRect(Math.max(0, startX), 0, 2, h);
      ctx.fillStyle = '#F59E0B';
      ctx.fillRect(Math.min(w - 2, endX), 0, 2, h);
    }

    // Loop crossfade seam marker
    if (postProcess.seamlessLoop && displayedDurationSec > 0) {
      const crossSec = postProcess.loopCrossfadeMs / 1000;
      const seamX = Math.min(w - 2, Math.max(4, Math.round((crossSec / displayedDurationSec) * w)));
      ctx.fillStyle = '#10B981';
      ctx.fillRect(seamX, 0, 2, h);
    }
  }, [
    workerResult,
    effectiveRawPcm,
    activeVariation,
    abMode,
    rawDurationSec,
    postProcess.cropStartSec,
    postProcess.cropEndSec,
    postProcess.seamlessLoop,
    postProcess.loopCrossfadeMs,
    displayedDurationSec,
  ]);

  const nonVocalTags = useMemo(
    () => (route === 'gemini-tts' ? detectNonVocalSfxTags(ttsScript) : []),
    [route, ttsScript],
  );

  const costEstimate = useMemo(() => estimateGoogleAudioCost(route, modelId), [route, modelId]);

  const loadReferenceAttachments = async (): Promise<{
    spritePngBase64?: string;
    lyriaRefs: LyriaReferenceImage[];
  }> => {
    const lyriaRefs: LyriaReferenceImage[] = [];
    let spritePngBase64: string | undefined;

    if (attachSprite) {
      const targetNode = spriteNodes[spriteNodes.length - 1];
      const blobId = targetNode?.processedBlobId ?? targetNode?.imageBlobId;
      if (blobId) {
        const rec = await repository.getBlob(blobId);
        if (rec) {
          const bytes = new Uint8Array(await rec.bytes.arrayBuffer());
          spritePngBase64 = uint8ToBase64(bytes);
          lyriaRefs.push({ base64: spritePngBase64, mimeType: rec.mimeType || 'image/png' });
        }
      }
      if (route === 'lyria-full' && activeProject) {
        for (const refId of activeProject.artBible.goldenReferenceBlobIds.slice(0, 9)) {
          const rec = await repository.getBlob(refId);
          if (rec) {
            const bytes = new Uint8Array(await rec.bytes.arrayBuffer());
            lyriaRefs.push({
              base64: uint8ToBase64(bytes),
              mimeType: rec.mimeType || 'image/png',
            });
          }
        }
      }
    }

    return { spritePngBase64, lyriaRefs };
  };

  const handleGenerateAudio = async () => {
    setErrorMessage(null);
    setStatusNotice(null);

    if (route === 'local-synth') {
      setSourcePcm(null);
      setSynthParams((prev) => ({ ...prev, seed: (prev.seed + 1) >>> 0 }));
      setStatusNotice('Rendered procedural 3-layer synth locally ($0.00).');
      return;
    }

    const cred = findGeminiAudioCredential(providers);
    if (!cred) {
      setErrorMessage(
        'No enabled Gemini API key found in Provider Vault. Add your key or switch to Local Synth ($0.00).',
      );
      setVaultOpen(true);
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsGeneratingRemote(true);

    try {
      const { spritePngBase64, lyriaRefs } = await loadReferenceAttachments();
      const res = await invokeGoogleAudioRoute({
        route,
        modelId,
        apiKey: cred.apiKey,
        baseUrl: cred.baseUrl,
        providerId: cred.providerId,
        prompt: promptText,
        spritePngBase64,
        referenceImages: lyriaRefs,
        voiceName: ttsVoice,
        styleDirection: ttsStyle,
        script: ttsScript,
        seed: synthParams.seed,
        signal: controller.signal,
      });

      if (res.kind === 'synth-params') {
        setSourcePcm(null);
        setSynthParams(res.params);
        setStatusNotice(`Gemini (${res.modelId}) synthesized procedural patch parameters cleanly.`);
      } else if (res.kind === 'pcm') {
        setSourcePcm(res.pcm);
        setStatusNotice(`Decoded audio clip from Google (${res.modelId}).`);
      } else {
        const decoded = await decodeAudioBytesToPcm(res.bytes);
        setSourcePcm(decoded);
        setStatusNotice(`Decoded ${res.mimeType} audio clip from Google (${res.modelId}).`);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Google Audio generation failed.');
    } finally {
      setIsGeneratingRemote(false);
    }
  };

  const handleStartRecording = async () => {
    setErrorMessage(null);
    setStatusNotice(null);
    try {
      micRecorderRef.current?.dispose();
      const recorder = new MicRecorder({
        maxDurationSec: 10,
        onLevel: (rms, elapsedSec) => {
          setMicVuLevel(rms);
          setMicElapsedSec(elapsedSec);
        },
        onAutoStop: (res) => {
          setSketchResult(res);
          setHumRemotePcm(null);
          setSelectedVarIdx(0);
          setIsRecordingMic(false);
          setMicVuLevel(0);
          setClipName((prev) =>
            prev === initialPreset.label || !prev.trim() ? 'Mic Hum Sketch' : prev,
          );
          setStatusNotice(
            `Captured ${res.contour.durationSec.toFixed(2)}s sketch (${res.melody.detectedBpm} BPM, ${res.melody.dominantKey}).`,
          );
        },
      });
      micRecorderRef.current = recorder;
      await recorder.start();
      setMicElapsedSec(0);
      setIsRecordingMic(true);
    } catch (err: unknown) {
      micRecorderRef.current?.dispose();
      micRecorderRef.current = null;
      setIsRecordingMic(false);
      setMicVuLevel(0);
      setErrorMessage(
        err instanceof Error ? err.message : 'Microphone capture failed or permission denied.',
      );
    }
  };

  const handleStopRecording = async () => {
    const rec = micRecorderRef.current;
    if (!rec) {
      setIsRecordingMic(false);
      return;
    }
    try {
      const res = await rec.stop();
      if (res) {
        setSketchResult(res);
        setHumRemotePcm(null);
        setSelectedVarIdx(0);
        setStatusNotice(
          `Captured ${res.contour.durationSec.toFixed(2)}s sketch (${res.melody.detectedBpm} BPM, ${res.melody.dominantKey}).`,
        );
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to stop recording.');
    } finally {
      setIsRecordingMic(false);
      setMicVuLevel(0);
      rec.dispose();
      if (micRecorderRef.current === rec) {
        micRecorderRef.current = null;
      }
    }
  };

  const handleUploadWavSketch = async (file: File) => {
    setErrorMessage(null);
    setStatusNotice(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const res = await ingestWavSketchBytes(bytes);
      setSketchResult(res);
      setHumRemotePcm(null);
      setSelectedVarIdx(0);
      const baseName = file.name.replace(/\.wav$/i, '').trim();
      if (baseName) {
        setClipName(baseName);
      }
      setStatusNotice(
        `Loaded ${file.name} (${res.contour.durationSec.toFixed(2)}s, ${res.melody.detectedBpm} BPM, ${res.melody.dominantKey}).`,
      );
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to ingest .wav sketch.');
    }
  };

  const handleApplyHumChip = (chipId: HumQuickChipId) => {
    setErrorMessage(null);
    const chipMap: Record<'scifi' | 'engine' | 'impact' | 'melody', string> = {
      scifi: 'scifi-weapon',
      engine: 'engine-rev',
      impact: 'heavy-impact',
      melody: 'chiptune-melody',
    };
    if (chipId === 'lyria') {
      setHumRoute('hum-to-lyria');
      setHumModelId('lyria-3-clip-preview');
      setHumPrompt('Transform hummed melody into punchy retro indie game boss track');
      setClipName('Hum Lyria Clip');
      return;
    }
    if (chipId === 'bark') {
      setHumRoute('hum-to-tts');
      setHumModelId('gemini-3.8-flash-tts');
      setHumPrompt('Convert vocal rhythm and cadence into a gritty armored warrior monster bark');
      setClipName('Hum Monster Bark');
      return;
    }
    const starter =
      STARTER_CONTOUR_PATCHES.find((s) => s.id === chipMap[chipId]) ?? STARTER_CONTOUR_PATCHES[0]!;
    setHumRoute('local-contour');
    setHumModelId('local-contour-follow');
    setHumRemotePcm(null);
    setContourPatch(starter.patch);
    setHumPrompt(starter.promptHint);
    setClipName(starter.label);
  };

  const handleTransformHumSketch = async () => {
    if (!sketchResult) return;
    setErrorMessage(null);
    setStatusNotice(null);

    if (humRoute === 'local-contour') {
      setHumRemotePcm(null);
      setHumModelId('local-contour-follow');
      setSynthParams((prev) => ({ ...prev, seed: (prev.seed + 1) >>> 0 }));
      setStatusNotice('Rendered contour-following synthesis locally ($0.00).');
      return;
    }

    const cred = findGeminiAudioCredential(providers);
    if (!cred) {
      setErrorMessage(
        'No enabled Gemini API key found in Provider Vault. Add your key or use Local Contour ($0.00).',
      );
      setVaultOpen(true);
      return;
    }

    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setIsGeneratingRemote(true);

    try {
      const res = await invokeHumToSoundRoute({
        route: humRoute,
        apiKey: cred.apiKey,
        baseUrl: cred.baseUrl,
        providerId: cred.providerId,
        prompt:
          humRoute === 'hum-to-tts' && (ttsVoice || ttsStyle)
            ? `${humPrompt} (prefer voice: ${ttsVoice}; direction: ${ttsStyle})`
            : humPrompt,
        humWavBytes: sketchResult.wavBytes,
        melodySummary: sketchResult.melody,
        signal: controller.signal,
      });

      setHumModelId(res.modelId);
      if (res.kind === 'timbre-patch') {
        setHumRemotePcm(null);
        setContourPatch(res.patch);
        setStatusNotice(
          `Gemini (${res.modelId}) styled ContourTimbrePatch (${res.patch.oscShape}, octave ${res.patch.octaveShift}).`,
        );
      } else if (res.kind === 'pcm') {
        setHumRemotePcm(res.pcm);
        if (res.ttsMeta) {
          setTtsVoice(res.ttsMeta.voiceName);
          setTtsStyle(res.ttsMeta.styleDirection);
          setTtsScript(res.ttsMeta.script);
        }
        setStatusNotice(`Rendered vocal cadence output via Google (${res.modelId}).`);
      } else {
        const decoded = await decodeAudioBytesToPcm(res.bytes);
        setHumRemotePcm(decoded);
        setStatusNotice(`Decoded ${res.mimeType} clip via Google (${res.modelId}).`);
      }
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Hum-to-Sound route failed.');
    } finally {
      setIsGeneratingRemote(false);
    }
  };

  const handlePlay = async () => {
    const pcm = abMode === 'raw' ? effectiveRawPcm : activeVariation?.buffer;
    if (!pcm || !playerRef.current) return;
    await playerRef.current.playPcm(pcm, { loop: loopPlay });
  };

  const handleStop = () => {
    playerRef.current?.stop();
  };

  const resolveEffectivePersistenceMeta = () => {
    const mappedGoogleRoute: GoogleAudioRoute =
      sourceTab === 'mic-sketch'
        ? humRoute === 'hum-to-lyria'
          ? 'lyria-clip'
          : humRoute === 'hum-to-tts'
            ? 'gemini-tts'
            : humRoute === 'hum-to-timbre'
              ? 'gemini-to-synth'
              : 'local-synth'
        : route;

    const effectivePresetId = sourceTab === 'mic-sketch' ? 'mic-sketch' : selectedPresetId;
    const effectiveModelId = sourceTab === 'mic-sketch' ? humModelId : modelId;
    const activeAudioSketch =
      sourceTab === 'mic-sketch' && sketchResult
        ? {
            sketchSha256: sketchResult.sha256,
            durationSec: sketchResult.contour.durationSec,
            humRoute,
            ...(humRoute === 'local-contour' || humRoute === 'hum-to-timbre'
              ? { contourPatch }
              : {}),
            detectedBpm: sketchResult.melody.detectedBpm,
            dominantKey: sketchResult.melody.dominantKey,
          }
        : undefined;

    return {
      mappedGoogleRoute,
      effectivePresetId,
      effectiveModelId,
      activeAudioSketch,
    };
  };

  const handleSaveAsset = async () => {
    if (!activeProject || !workerResult || workerResult.variations.length === 0) return;
    const primary = workerResult.variations[0]!;
    const primaryCopy = new Uint8Array(primary.wavBytes.byteLength);
    primaryCopy.set(primary.wavBytes);
    const primaryBlob = await repository.storeBlob(
      new Blob([primaryCopy.buffer], { type: 'audio/wav' }),
      'audio/wav',
    );

    const varBlobIds: string[] = [];
    for (const v of workerResult.variations) {
      const copy = new Uint8Array(v.wavBytes.byteLength);
      copy.set(v.wavBytes);
      const rec = await repository.storeBlob(
        new Blob([copy.buffer], { type: 'audio/wav' }),
        'audio/wav',
      );
      varBlobIds.push(rec.id);
    }

    const { mappedGoogleRoute, effectivePresetId, effectiveModelId, activeAudioSketch } =
      resolveEffectivePersistenceMeta();
    const frames = Math.floor(primary.buffer.samples.length / primary.buffer.channels);
    const saved = await saveAudioAssetRecord({
      id: globalThis.crypto.randomUUID(),
      projectId: activeProject.id,
      name: clipName.trim() || 'Untitled Audio',
      presetId: effectivePresetId,
      route: mappedGoogleRoute,
      modelId: effectiveModelId,
      wavBlobId: primaryBlob.id,
      variationBlobIds: varBlobIds,
      ...(sourceTab === 'presets' && sourcePcm === null ? { synthParams } : {}),
      ...(activeAudioSketch ? { audioSketch: activeAudioSketch } : {}),
      postProcess,
      lufs: Number.isFinite(primary.outputLufs) ? Number(primary.outputLufs.toFixed(2)) : -60,
      durationSec: Number((frames / Math.max(1, primary.buffer.sampleRate)).toFixed(4)),
      createdAt: new Date().toISOString(),
    });
    setStatusNotice(`Saved "${saved.name}" (${workerResult.variations.length} WAVs) to IndexedDB.`);
  };

  const buildCurrentRecipeAndSlug = () => {
    if (!workerResult || workerResult.variations.length === 0) {
      throw new Error('No audio variation rendered yet.');
    }
    const { mappedGoogleRoute, effectivePresetId, effectiveModelId, activeAudioSketch } =
      resolveEffectivePersistenceMeta();
    const slug = toAssetSlug(clipName || effectivePresetId || 'audio-sfx');
    const cred = findGeminiAudioCredential(providers);
    const recipe = buildAudioRecipe({
      slug,
      assetName: clipName.trim() || effectivePresetId,
      presetId: effectivePresetId,
      route: mappedGoogleRoute,
      modelId: effectiveModelId,
      promptOrScript:
        sourceTab === 'mic-sketch' ? humPrompt : route === 'gemini-tts' ? ttsScript : promptText,
      ...(sourceTab === 'presets' && sourcePcm === null ? { synthParams } : {}),
      ...(activeAudioSketch ? { audioSketch: activeAudioSketch } : {}),
      postProcess,
      variations: workerResult.variations,
      secretsToRedact: [cred?.apiKey],
    });
    return { slug, recipe, variations: workerResult.variations };
  };

  const handleDownloadZip = () => {
    try {
      const { slug, recipe, variations } = buildCurrentRecipeAndSlug();
      const zipBytes = packageAudioZip({ slug, variations, recipe });
      const copy = new Uint8Array(zipBytes.byteLength);
      copy.set(zipBytes);
      triggerBlobDownload(
        new Blob([copy.buffer], { type: 'application/zip' }),
        `${slug}-audio.zip`,
      );
      setStatusNotice(`Exported ${variations.length} WAV file(s) + ${slug}.audio.recipe.json.`);
    } catch (err: unknown) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to export audio ZIP.');
    }
  };

  const handleExportLocalFolder = async () => {
    if (!supportsFileSystemAccess()) return;
    try {
      const picker = (
        window as Window & {
          showDirectoryPicker?: () => Promise<FileSystemDirectoryHandle>;
        }
      ).showDirectoryPicker;
      if (!picker) return;
      const dir = await picker();
      const { slug, recipe, variations } = buildCurrentRecipeAndSlug();
      for (const v of variations) {
        const fh = await dir.getFileHandle(`${slug}${v.filenameSuffix}`, { create: true });
        const writable = await fh.createWritable();
        const copy = new Uint8Array(v.wavBytes.byteLength);
        copy.set(v.wavBytes);
        await writable.write(copy);
        await writable.close();
      }
      const rfh = await dir.getFileHandle(`${slug}.audio.recipe.json`, { create: true });
      const rw = await rfh.createWritable();
      await rw.write(`${JSON.stringify(recipe, null, 2)}\n`);
      await rw.close();
      setStatusNotice(`Exported ${variations.length} WAV(s) to local folder.`);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      setErrorMessage(err instanceof Error ? err.message : 'Local folder export failed.');
    }
  };

  const visiblePresets = useMemo(
    () =>
      categoryFilter === 'all'
        ? GOOGLE_AUDIO_PRESETS
        : GOOGLE_AUDIO_PRESETS.filter((p) => p.category === categoryFilter),
    [categoryFilter],
  );

  const fsaSupported = supportsFileSystemAccess();
  const maxCropSec = Math.max(0.25, Number(rawDurationSec.toFixed(2)) || 1.0);

  return (
    <div
      data-testid="audio-foundry"
      className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[320px_minmax(0,1fr)_320px]"
    >
      {/* Left Pane: Source Mode Tabs + Presets / Mic Sketch Authoring */}
      <aside className="space-y-4 overflow-y-auto border-b border-slate-800 bg-slate-900/70 p-4 lg:border-r lg:border-b-0">
        {/* Source Mode Switcher */}
        <div className="grid grid-cols-2 gap-1.5 rounded-lg border border-slate-800 bg-slate-950 p-1 text-[11px]">
          <button
            type="button"
            data-testid="audio-tab-presets"
            onClick={() => {
              if (isRecordingMic) {
                void handleStopRecording();
              }
              setSourceTab('presets');
              setErrorMessage(null);
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-semibold transition-colors ${
              sourceTab === 'presets'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-900'
            }`}
          >
            <Music className="h-3.5 w-3.5" />
            Presets &amp; Google
          </button>
          <button
            type="button"
            data-testid="audio-tab-mic-sketch"
            onClick={() => {
              setSourceTab('mic-sketch');
              setErrorMessage(null);
            }}
            className={`inline-flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-semibold transition-colors ${
              sourceTab === 'mic-sketch'
                ? 'bg-cyan-600 text-white'
                : 'text-slate-300 hover:bg-slate-900'
            }`}
          >
            <Mic className="h-3.5 w-3.5" />
            Mic Sketch
          </button>
        </div>

        {sourceTab === 'mic-sketch' ? (
          <MicSketchPanel
            isActiveTab={sourceTab === 'mic-sketch'}
            sketchResult={sketchResult}
            humRoute={humRoute}
            contourPatch={contourPatch}
            promptText={humPrompt}
            ttsVoice={ttsVoice}
            ttsStyle={ttsStyle}
            abMode={abMode}
            isRecording={isRecordingMic}
            isTransforming={isGeneratingRemote}
            vuLevel={micVuLevel}
            recordingSec={micElapsedSec}
            onStartRecording={() => void handleStartRecording()}
            onStopRecording={() => void handleStopRecording()}
            onUploadWav={(file) => void handleUploadWavSketch(file)}
            onSelectRoute={(nextRoute) => {
              setHumRoute(nextRoute);
              if (nextRoute === 'local-contour') {
                setHumRemotePcm(null);
                setHumModelId('local-contour-follow');
              } else if (nextRoute === 'hum-to-timbre') {
                setHumRemotePcm(null);
                setHumModelId('gemini-2.5-flash');
              } else if (nextRoute === 'hum-to-lyria') {
                setHumModelId('lyria-3-clip-preview');
              } else if (nextRoute === 'hum-to-tts') {
                setHumModelId('gemini-3.8-flash-tts');
              }
            }}
            onChangePrompt={setHumPrompt}
            onChangeTtsVoice={setTtsVoice}
            onChangeTtsStyle={setTtsStyle}
            onChangePatch={setContourPatch}
            onApplyChip={handleApplyHumChip}
            onTransformSketch={() => void handleTransformHumSketch()}
            onToggleAbMode={() => setAbMode((m) => (m === 'processed' ? 'raw' : 'processed'))}
            onPlayAb={() => void handlePlay()}
          />
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <h2 className="flex items-center gap-2 text-xs font-semibold tracking-wider text-slate-200 uppercase">
                  <Music className="h-3.5 w-3.5 text-indigo-400" />
                  Google Audio Presets (12)
                </h2>
                <span
                  data-testid="audio-cost-badge"
                  className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 font-mono text-[10px] font-semibold text-emerald-200"
                >
                  {costEstimate.label}
                </span>
              </div>

              <div className="flex flex-wrap gap-1 text-[11px]">
                {(['all', 'sfx', 'ui', 'voice', 'music', 'ambience'] as const).map((cat) => (
                  <button
                    key={cat}
                    type="button"
                    data-testid={`audio-cat-${cat}`}
                    onClick={() => setCategoryFilter(cat)}
                    className={`rounded border px-2 py-0.5 uppercase ${
                      categoryFilter === cat
                        ? 'border-indigo-500 bg-indigo-600 font-semibold text-white'
                        : 'border-slate-700 bg-slate-950 text-slate-300'
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>

              <div className="grid max-h-48 grid-cols-1 gap-1.5 overflow-y-auto pr-1">
                {visiblePresets.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    data-testid={`audio-preset-${preset.id}`}
                    onClick={() => handleSelectPreset(preset.id)}
                    className={`flex items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                      selectedPresetId === preset.id
                        ? 'border-indigo-500 bg-indigo-600/20 text-white'
                        : 'border-slate-800 bg-slate-950/70 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <span className="font-medium">{preset.label}</span>
                    <span className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                      {preset.route}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Execution Route & Single-Key Actions */}
            <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
              <label className="block space-y-1">
                <span className="font-semibold text-slate-200">Generation Route</span>
                <select
                  data-testid="audio-route-select"
                  value={route}
                  onChange={(e) => {
                    const nextRoute = e.target.value as GoogleAudioRoute;
                    setRoute(nextRoute);
                    if (nextRoute === 'lyria-clip') setModelId('lyria-3-clip-preview');
                    if (nextRoute === 'lyria-full') setModelId('lyria-3.5');
                    if (nextRoute === 'gemini-tts') setModelId('gemini-3.8-flash-tts');
                    if (nextRoute === 'gemini-to-synth') setModelId('gemini-2.5-flash');
                    if (nextRoute === 'local-synth') setSourcePcm(null);
                  }}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-200"
                >
                  <option value="local-synth">Local Procedural Synth ($0.00)</option>
                  <option value="gemini-to-synth">Sprite-to-SFX Gemini JSON (~$0.001)</option>
                  <option value="gemini-tts">Gemini 3.8 TTS Barks (~$0.005)</option>
                  <option value="lyria-clip">Lyria 3 Clip (~$0.04)</option>
                  <option value="lyria-full">Lyria 3.5 Full Track (~$0.08)</option>
                </select>
              </label>

              {route === 'gemini-tts' ? (
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block space-y-1">
                      <span className="text-[11px] text-slate-400">Voice</span>
                      <select
                        data-testid="audio-tts-voice"
                        value={ttsVoice}
                        onChange={(e) => setTtsVoice(e.target.value)}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                      >
                        {TTS_VOICES.map((v) => (
                          <option key={v} value={v}>
                            {v}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="block space-y-1">
                      <span className="text-[11px] text-slate-400">TTS Model</span>
                      <select
                        data-testid="audio-tts-model"
                        value={modelId}
                        onChange={(e) => setModelId(e.target.value)}
                        className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                      >
                        <option value="gemini-3.8-flash-tts">gemini-3.8-flash-tts</option>
                        <option value="gemini-3.8-flash-lite-tts">gemini-3.8-flash-lite-tts</option>
                      </select>
                    </label>
                  </div>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-slate-400">Style Direction</span>
                    <input
                      type="text"
                      data-testid="audio-tts-style"
                      value={ttsStyle}
                      onChange={(e) => setTtsStyle(e.target.value)}
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-[11px] text-slate-400">Script (Vocal Tags)</span>
                    <textarea
                      rows={2}
                      data-testid="audio-tts-script"
                      value={ttsScript}
                      onChange={(e) => setTtsScript(e.target.value)}
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                    />
                  </label>
                  <div className="flex flex-wrap gap-1">
                    {VOCAL_TAG_CHIPS.map((tag) => (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => setTtsScript((prev) => `${prev.trim()} ${tag}`.trim())}
                        className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-300 hover:bg-slate-800"
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                  {nonVocalTags.length > 0 && (
                    <div
                      data-testid="audio-vocal-tag-warning"
                      className="flex items-start gap-1.5 rounded border border-amber-500/40 bg-amber-950/40 p-2 text-[10px] text-amber-200"
                    >
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      <span>
                        Avoid non-vocal SFX tags ({nonVocalTags.join(', ')}) in Gemini TTS scripts.
                      </span>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  {(route === 'lyria-clip' || route === 'lyria-full') && (
                    <div className="grid grid-cols-2 gap-2">
                      <label className="block space-y-1">
                        <span className="text-[11px] text-slate-400">BPM</span>
                        <input
                          type="number"
                          min={60}
                          max={200}
                          value={bpm}
                          onChange={(e) => setBpm(Number(e.target.value))}
                          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                        />
                      </label>
                      <label className="block space-y-1">
                        <span className="text-[11px] text-slate-400">Mood</span>
                        <input
                          type="text"
                          value={mood}
                          onChange={(e) => setMood(e.target.value)}
                          className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                        />
                      </label>
                    </div>
                  )}

                  <label className="block space-y-1">
                    <span className="text-[11px] text-slate-400">Audio Prompt</span>
                    <textarea
                      rows={2}
                      data-testid="audio-prompt-input"
                      value={promptText}
                      onChange={(e) => setPromptText(e.target.value)}
                      className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200"
                    />
                  </label>

                  <label className="flex items-center gap-2 text-[11px] text-slate-300">
                    <input
                      type="checkbox"
                      data-testid="audio-attach-sprite-toggle"
                      checked={attachSprite}
                      onChange={(e) => setAttachSprite(e.target.checked)}
                      className="accent-indigo-500"
                    />
                    Attach Active Sprite / Art Bible Refs
                  </label>
                </div>
              )}

              <button
                type="button"
                data-testid="audio-generate-btn"
                disabled={isGeneratingRemote}
                onClick={() => void handleGenerateAudio()}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <Sparkles className="h-3.5 w-3.5" />
                {isGeneratingRemote
                  ? 'Generating...'
                  : route === 'local-synth'
                    ? 'Render Local Synth ($0.00)'
                    : `Generate with Google (${costEstimate.label})`}
              </button>
            </div>

            {/* Manual 3-Layer Procedural Synth Controls */}
            {(route === 'local-synth' || route === 'gemini-to-synth') && (
              <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-200">3-Layer Synth Patch</span>
                  <button
                    type="button"
                    data-testid="audio-mutate-seed-btn"
                    onClick={() =>
                      setSynthParams((prev) => ({
                        ...prev,
                        seed: ((prev.seed + 137) * 3) >>> 0,
                      }))
                    }
                    className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-200 hover:bg-slate-800"
                  >
                    <Dices className="h-3 w-3" />
                    Seed #{synthParams.seed}
                  </button>
                </div>

                <label className="block space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Body Start Hz</span>
                    <span data-testid="audio-body-start-hz" className="font-mono">
                      {Math.round(synthParams.bodyStartHz)} Hz
                    </span>
                  </div>
                  <input
                    type="range"
                    data-testid="audio-body-start-slider"
                    min={30}
                    max={2000}
                    value={Math.round(synthParams.bodyStartHz)}
                    onChange={(e) =>
                      setSynthParams((p) => ({ ...p, bodyStartHz: Number(e.target.value) }))
                    }
                    className="w-full accent-indigo-500"
                  />
                </label>

                <label className="block space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Transient Attack Gain</span>
                    <span className="font-mono">{synthParams.transientGain.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={synthParams.transientGain}
                    onChange={(e) =>
                      setSynthParams((p) => ({ ...p, transientGain: Number(e.target.value) }))
                    }
                    className="w-full accent-indigo-500"
                  />
                </label>

                <label className="block space-y-1">
                  <div className="flex justify-between text-[11px] text-slate-400">
                    <span>Noise Tail Gain</span>
                    <span className="font-mono">{synthParams.noiseGain.toFixed(2)}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={1}
                    step={0.05}
                    value={synthParams.noiseGain}
                    onChange={(e) =>
                      setSynthParams((p) => ({ ...p, noiseGain: Number(e.target.value) }))
                    }
                    className="w-full accent-indigo-500"
                  />
                </label>
              </div>
            )}
          </>
        )}
      </aside>

      {/* Center Pane: Waveform, Region Crop Handles, Transport & LUFS Meters */}
      <section className="flex min-w-0 flex-col bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/50 px-4 py-2.5 text-xs">
          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="audio-play-btn"
              onClick={() => void handlePlay()}
              className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 font-semibold text-white hover:bg-emerald-500"
            >
              <Play className="h-3.5 w-3.5" />
              Play
            </button>
            <button
              type="button"
              data-testid="audio-stop-btn"
              onClick={handleStop}
              className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-slate-200 hover:bg-slate-700"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
            <label className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-200">
              <input
                type="checkbox"
                data-testid="audio-loop-toggle"
                checked={loopPlay}
                onChange={(e) => setLoopPlay(e.target.checked)}
                className="accent-indigo-500"
              />
              <Repeat className="h-3.5 w-3.5" />
              Loop
            </label>
            <button
              type="button"
              data-testid="audio-ab-toggle"
              onClick={() => setAbMode((m) => (m === 'processed' ? 'raw' : 'processed'))}
              className={`rounded border px-2.5 py-1.5 font-medium ${
                abMode === 'raw'
                  ? 'border-sky-500/40 bg-sky-500/20 text-sky-200'
                  : 'border-indigo-500/40 bg-indigo-500/20 text-indigo-200'
              }`}
            >
              A/B:{' '}
              {abMode === 'raw'
                ? sourceTab === 'mic-sketch'
                  ? 'My Hum'
                  : 'Raw Source'
                : sourceTab === 'mic-sketch'
                  ? 'Transformed Sound'
                  : 'Processed DSP'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
            <span
              data-testid="audio-input-lufs"
              className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-slate-400"
            >
              In:{' '}
              {activeVariation && Number.isFinite(activeVariation.inputLufs)
                ? `${activeVariation.inputLufs.toFixed(1)} LUFS`
                : '-∞'}
            </span>
            <span
              data-testid="audio-output-lufs"
              className="rounded border border-indigo-500/40 bg-indigo-500/15 px-2 py-1 font-semibold text-indigo-200"
            >
              Out:{' '}
              {activeVariation && Number.isFinite(activeVariation.outputLufs)
                ? `${activeVariation.outputLufs.toFixed(1)} LUFS`
                : '-∞'}
            </span>
            <span
              data-testid="audio-peak-db"
              className="rounded border border-slate-800 bg-slate-900 px-2 py-1 text-slate-300"
            >
              Peak:{' '}
              {activeVariation && Number.isFinite(activeVariation.peakDb)
                ? `${activeVariation.peakDb.toFixed(1)} dBFS`
                : '-∞'}
            </span>
            <span
              data-testid="audio-duration-badge"
              className="rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-1 text-emerald-200"
            >
              {displayedDurationSec.toFixed(3)}s
            </span>
          </div>
        </div>

        <div className="flex flex-1 flex-col justify-center gap-4 p-6">
          {sourceTab === 'mic-sketch' && (
            <PitchRibbonCanvas
              sketchPcm={sketchResult?.pcm ?? null}
              contour={sketchResult?.contour ?? null}
              melody={sketchResult?.melody ?? null}
              sha256={sketchResult?.sha256 ?? null}
            />
          )}

          <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/40 p-4">
            <canvas
              ref={waveformCanvasRef}
              data-testid="audio-waveform-canvas"
              width={680}
              height={200}
              className="h-[200px] w-full rounded-lg border border-slate-800 bg-slate-950"
            />

            {/* Region Crop Handles */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
              <label className="space-y-1">
                <div className="flex justify-between text-slate-400">
                  <span>Region Crop Start (s)</span>
                  <span className="font-mono">{postProcess.cropStartSec.toFixed(2)}s</span>
                </div>
                <input
                  type="range"
                  data-testid="audio-crop-start"
                  min={0}
                  max={maxCropSec}
                  step={0.05}
                  value={postProcess.cropStartSec}
                  onChange={(e) =>
                    setPostProcess((p) => ({
                      ...p,
                      cropStartSec: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-cyan-400"
                />
              </label>
              <label className="space-y-1">
                <div className="flex justify-between text-slate-400">
                  <span>Region Crop End (0 = full)</span>
                  <span className="font-mono">{postProcess.cropEndSec.toFixed(2)}s</span>
                </div>
                <input
                  type="range"
                  data-testid="audio-crop-end"
                  min={0}
                  max={maxCropSec}
                  step={0.05}
                  value={postProcess.cropEndSec}
                  onChange={(e) =>
                    setPostProcess((p) => ({
                      ...p,
                      cropEndSec: Number(e.target.value),
                    }))
                  }
                  className="w-full accent-amber-400"
                />
              </label>
            </div>
          </div>

          {workerResult && workerResult.variations.length > 1 && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400">Preview Variation:</span>
              {workerResult.variations.map((v, idx) => (
                <button
                  key={v.filenameSuffix}
                  type="button"
                  data-testid={`audio-var-pill-${idx}`}
                  onClick={() => setSelectedVarIdx(idx)}
                  className={`rounded border px-2 py-1 font-mono text-[11px] ${
                    selectedVarIdx === idx
                      ? 'border-indigo-500 bg-indigo-600 font-semibold text-white'
                      : 'border-slate-700 bg-slate-900 text-slate-300'
                  }`}
                >
                  #{idx + 1}
                </button>
              ))}
            </div>
          )}

          {errorMessage && (
            <div
              data-testid="audio-error-banner"
              className="rounded-lg border border-rose-500/40 bg-rose-950/60 px-3 py-2 text-xs text-rose-200"
            >
              {errorMessage}
            </div>
          )}
          {statusNotice && !errorMessage && (
            <div
              data-testid="audio-status-banner"
              className="rounded-lg border border-indigo-500/30 bg-indigo-950/30 px-3 py-2 text-xs text-indigo-200"
            >
              {statusNotice}
            </div>
          )}
        </div>
      </section>

      {/* Right Pane: DSP Post-Process, Variations, Save & Export */}
      <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs">
          <div className="font-semibold text-slate-200">PCM Post-Processor</div>

          <label className="flex items-center justify-between text-slate-300">
            <span>Auto-Trim Leading/Trailing Silence</span>
            <input
              type="checkbox"
              data-testid="audio-trim-toggle"
              checked={postProcess.trimSilence}
              onChange={(e) => setPostProcess((p) => ({ ...p, trimSilence: e.target.checked }))}
              className="accent-indigo-500"
            />
          </label>

          <label className="flex items-center justify-between text-slate-300">
            <span>LUFS Loudness Normalize (-1 dBFS)</span>
            <input
              type="checkbox"
              data-testid="audio-lufs-toggle"
              checked={postProcess.normalizeLufs}
              onChange={(e) => setPostProcess((p) => ({ ...p, normalizeLufs: e.target.checked }))}
              className="accent-indigo-500"
            />
          </label>

          <label className="block space-y-1">
            <span className="text-[11px] text-slate-400">Target Loudness (LUFS)</span>
            <select
              data-testid="audio-lufs-target"
              value={postProcess.targetLufs}
              onChange={(e) =>
                setPostProcess((p) => ({ ...p, targetLufs: Number(e.target.value) }))
              }
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-slate-200"
            >
              <option value={-12}>-12 LUFS (UI / Announcer)</option>
              <option value={-14}>-14 LUFS (SFX / Impacts)</option>
              <option value={-16}>-16 LUFS (BGM Loop / Steps)</option>
              <option value={-20}>-20 LUFS (Biome Ambience)</option>
            </select>
          </label>

          <label className="flex items-center justify-between text-slate-300">
            <span>Seamless Loop Crossfade</span>
            <input
              type="checkbox"
              data-testid="audio-seamless-loop-toggle"
              checked={postProcess.seamlessLoop}
              onChange={(e) => setPostProcess((p) => ({ ...p, seamlessLoop: e.target.checked }))}
              className="accent-indigo-500"
            />
          </label>

          {postProcess.seamlessLoop && (
            <label className="block space-y-1">
              <div className="flex justify-between text-[11px] text-slate-400">
                <span>Crossfade Overlap</span>
                <span className="font-mono">{postProcess.loopCrossfadeMs} ms</span>
              </div>
              <input
                type="range"
                data-testid="audio-crossfade-ms"
                min={40}
                max={600}
                step={20}
                value={postProcess.loopCrossfadeMs}
                onChange={(e) =>
                  setPostProcess((p) => ({ ...p, loopCrossfadeMs: Number(e.target.value) }))
                }
                className="w-full accent-emerald-500"
              />
            </label>
          )}
        </div>

        {/* Variations & Clip Export */}
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs">
          <div className="font-semibold text-slate-200">Anti-Repetition Variations</div>
          <div className="grid grid-cols-3 gap-1.5">
            {([1, 4, 6] as const).map((cnt) => (
              <button
                key={cnt}
                type="button"
                data-testid={`audio-var-${cnt}`}
                onClick={() => {
                  setVariationCount(cnt);
                  setSelectedVarIdx(0);
                }}
                className={`rounded border py-1.5 font-mono text-[11px] font-semibold ${
                  variationCount === cnt
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                {cnt}×
              </button>
            ))}
          </div>

          <label className="block space-y-1">
            <span className="text-[11px] text-slate-400">Clip Name</span>
            <input
              type="text"
              data-testid="audio-clip-name-input"
              value={clipName}
              onChange={(e) => setClipName(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
            />
          </label>

          <button
            type="button"
            data-testid="audio-save-btn"
            disabled={!activeProject || !workerResult}
            onClick={() => void handleSaveAsset()}
            className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-emerald-500/40 bg-emerald-500/20 px-3 py-2 font-semibold text-emerald-100 hover:bg-emerald-500/30 disabled:opacity-40"
          >
            <Save className="h-3.5 w-3.5" />
            Save to Project ({variationCount} WAV)
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              data-testid="audio-download-zip-btn"
              disabled={!workerResult}
              onClick={handleDownloadZip}
              className="inline-flex items-center justify-center gap-1.5 rounded bg-indigo-600 px-2.5 py-2 font-semibold text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              <FileArchive className="h-3.5 w-3.5" />
              Audio ZIP
            </button>
            <button
              type="button"
              data-testid="audio-export-folder-btn"
              disabled={!fsaSupported || !workerResult}
              onClick={() => void handleExportLocalFolder()}
              className="inline-flex items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-800 px-2.5 py-2 text-slate-200 hover:bg-slate-700 disabled:opacity-40"
            >
              <FolderOutput className="h-3.5 w-3.5" />
              Folder
            </button>
          </div>
        </div>

        {/* Saved Project Audio Bank */}
        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs">
          <div className="flex items-center justify-between font-semibold text-slate-200">
            <span>Saved Audio Bank ({audioAssets.length})</span>
            <Download className="h-3.5 w-3.5 text-slate-400" />
          </div>

          {audioAssets.length === 0 ? (
            <p className="text-[11px] text-slate-500">
              No saved clips yet. Click Save to bind into Sandbox (4F) or 9-Slice (4D).
            </p>
          ) : (
            <div data-testid="audio-saved-list" className="space-y-1.5">
              {audioAssets.map((asset: AudioAsset) => (
                <div
                  key={asset.id}
                  data-testid={`audio-saved-item-${asset.id}`}
                  className="flex items-center justify-between gap-2 rounded border border-slate-800 bg-slate-900/70 px-2.5 py-1.5"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-slate-200">{asset.name}</div>
                    <div className="font-mono text-[10px] text-slate-400">
                      {asset.lufs.toFixed(1)} LUFS · {asset.durationSec.toFixed(2)}s ·{' '}
                      {Math.max(1, asset.variationBlobIds.length)} var
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        void repository.getBlob(asset.wavBlobId).then((b) => {
                          if (b && playerRef.current) {
                            void playerRef.current.playWavBlob(b.bytes);
                          }
                        })
                      }
                      className="rounded border border-slate-700 bg-slate-800 p-1 text-emerald-300 hover:bg-slate-700"
                      title="Play saved clip"
                    >
                      <Play className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      data-testid={`audio-delete-${asset.id}`}
                      onClick={() => void deleteAudioAssetRecord(asset.id, asset.projectId)}
                      className="rounded border border-rose-500/30 bg-rose-500/10 p-1 text-rose-300 hover:bg-rose-500/20"
                      title="Delete saved clip"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
