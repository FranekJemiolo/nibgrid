import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Download,
  Film,
  Layers,
  Pause,
  Play,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import type { ArtBible, SpriteNode } from '../../domain/schemas';
import {
  buildSpriteAnimationArtifacts,
  selectDefaultAnimationNodeIds,
  type SpriteAnimationArtifacts,
} from '../../export/animationExporter';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';
import { gifBytesToBlob, type GifFrameInput } from '../../processing/gif';
import { uint8ToBase64 } from '../../processing/png';
import { BlobImage } from '../components/BlobImage';

interface AnimationStudioModalProps {
  nodes: SpriteNode[];
  artBible: ArtBible;
  projectName: string;
  onClose: () => void;
}

function getInitialFrameSize(artBible: ArtBible): number {
  if (artBible.targetWidth <= 64) return 64;
  if (artBible.targetWidth <= 128) return 128;
  return 256;
}

export function AnimationStudioModal({
  nodes,
  artBible,
  projectName,
  onClose,
}: AnimationStudioModalProps) {
  const [frameNodeIds, setFrameNodeIds] = useState<string[]>(() =>
    selectDefaultAnimationNodeIds(nodes),
  );
  const [fps, setFps] = useState(6);
  const [targetSize, setTargetSize] = useState(() => getInitialFrameSize(artBible));
  const [autoCutout, setAutoCutout] = useState(true);
  const [tolerance, setTolerance] = useState(12);
  const [paletteSnap, setPaletteSnap] = useState(artBible.palette.length > 0);
  const [pingPong, setPingPong] = useState(true);
  const [onionSkin, setOnionSkin] = useState(false);
  const [isPlaying, setIsPlaying] = useState(true);
  const [activeFrameIdx, setActiveFrameIdx] = useState(0);
  const [artifacts, setArtifacts] = useState<SpriteAnimationArtifacts | null>(null);
  const [isBuilding, setIsBuilding] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const frameNodes = useMemo(
    () =>
      frameNodeIds
        .map((id) => nodes.find((n) => n.id === id))
        .filter((n): n is SpriteNode => n !== undefined),
    [frameNodeIds, nodes],
  );

  // Rebuild GIF89a & spritesheet strip whenever timeline or pipeline settings change
  useEffect(() => {
    let cancelled = false;
    if (frameNodes.length === 0) {
      setArtifacts(null);
      return;
    }

    setIsBuilding(true);
    setErrorMsg(null);
    const timer = window.setTimeout(() => {
      void buildSpriteAnimationArtifacts(frameNodes, artBible, {
        targetSize,
        autoCutout,
        tolerance,
        paletteSnap,
        fps,
        pingPong,
      })
        .then((res) => {
          if (cancelled) return;
          setArtifacts(res);
          setActiveFrameIdx((prev) => (res.frames.length > 0 ? prev % res.frames.length : 0));
          setIsBuilding(false);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setErrorMsg(err instanceof Error ? err.message : 'Failed to encode animation.');
          setIsBuilding(false);
        });
    }, 40);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [frameNodes, artBible, targetSize, autoCutout, tolerance, paletteSnap, fps, pingPong]);

  // Expand frame indices for smooth live canvas playback (respecting Ping-Pong toggle)
  const playbackSequence = useMemo((): readonly GifFrameInput[] => {
    if (!artifacts || artifacts.frames.length === 0) return [];
    const base = artifacts.frames;
    if (!pingPong || base.length <= 2) return base;
    const seq = [...base];
    for (let i = base.length - 2; i >= 1; i--) {
      const f = base[i];
      if (f) seq.push(f);
    }
    return seq;
  }, [artifacts, pingPong]);

  // Playback timer
  useEffect(() => {
    if (!isPlaying || playbackSequence.length <= 1) return;
    const intervalMs = Math.max(40, Math.round(1000 / Math.max(1, fps)));
    const id = window.setInterval(() => {
      setActiveFrameIdx((prev) => (prev + 1) % playbackSequence.length);
    }, intervalMs);
    return () => window.clearInterval(id);
  }, [isPlaying, fps, playbackSequence.length]);

  // Paint active canvas frame (+ optional translucent previous-frame onion skin)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || playbackSequence.length === 0) return;
    const current = playbackSequence[activeFrameIdx % playbackSequence.length];
    if (!current) return;

    canvas.width = current.width;
    canvas.height = current.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = artBible.artMode === 'hd-2d';
    ctx.clearRect(0, 0, current.width, current.height);

    if (onionSkin && playbackSequence.length > 1) {
      const prevIdx = (activeFrameIdx - 1 + playbackSequence.length) % playbackSequence.length;
      const prevFrame = playbackSequence[prevIdx];
      if (prevFrame) {
        const scratch = document.createElement('canvas');
        scratch.width = prevFrame.width;
        scratch.height = prevFrame.height;
        const sCtx = scratch.getContext('2d');
        if (sCtx) {
          sCtx.putImageData(
            new ImageData(new Uint8ClampedArray(prevFrame.rgba), prevFrame.width, prevFrame.height),
            0,
            0,
          );
          ctx.save();
          ctx.globalAlpha = 0.28;
          ctx.drawImage(scratch, 0, 0);
          ctx.restore();
        }
        scratch.width = 0;
        scratch.height = 0;
      }
    }

    const fg = document.createElement('canvas');
    fg.width = current.width;
    fg.height = current.height;
    const fgCtx = fg.getContext('2d');
    if (fgCtx) {
      fgCtx.putImageData(
        new ImageData(new Uint8ClampedArray(current.rgba), current.width, current.height),
        0,
        0,
      );
      ctx.drawImage(fg, 0, 0);
    }
    fg.width = 0;
    fg.height = 0;
  }, [playbackSequence, activeFrameIdx, onionSkin, artBible.artMode]);

  const gifDataUrl = useMemo(() => {
    if (!artifacts) return null;
    return `data:image/gif;base64,${uint8ToBase64(artifacts.gifBytes)}`;
  }, [artifacts]);

  const moveFrame = (index: number, delta: -1 | 1) => {
    const nextIdx = index + delta;
    if (nextIdx < 0 || nextIdx >= frameNodeIds.length) return;
    setFrameNodeIds((prev) => {
      const copy = [...prev];
      const temp = copy[index]!;
      copy[index] = copy[nextIdx]!;
      copy[nextIdx] = temp;
      return copy;
    });
  };

  const handleDownloadGif = () => {
    if (!artifacts) return;
    const slug = toAssetSlug(projectName);
    triggerBlobDownload(gifBytesToBlob(artifacts.gifBytes), `${slug}-anim.gif`);
  };

  const handleDownloadSpritesheet = () => {
    if (!artifacts) return;
    const slug = toAssetSlug(projectName);
    const copy = new Uint8Array(artifacts.spritesheetPngBytes.byteLength);
    copy.set(artifacts.spritesheetPngBytes);
    triggerBlobDownload(new Blob([copy.buffer], { type: 'image/png' }), `${slug}-spritesheet.png`);
  };

  const isPixelArt = artBible.artMode === 'pixel-art';
  const imgRendering = isPixelArt ? 'pixelated' : 'auto';

  return (
    <div
      data-testid="animation-studio-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="animation-studio-title"
    >
      <div className="flex max-h-[92vh] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <Film className="h-4 w-4 text-indigo-400" />
            <div>
              <h2 id="animation-studio-title" className="text-sm font-semibold text-slate-100">
                Animation & GIF Studio
              </h2>
              <p className="text-[11px] text-slate-400">
                Sequence DAG sprites into transparent looping GIF89a &amp; horizontal spritesheets
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="close-animation-modal-btn"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="Close animation studio"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-5 overflow-y-auto p-5 lg:grid-cols-[1.2fr_340px]">
          {/* Left: Live Playback & GIF89a Preview + Frame Timeline */}
          <div className="flex min-w-0 flex-col gap-4">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="font-semibold text-slate-200">Interactive Canvas Preview</span>
                  <span className="font-mono">
                    {artifacts
                      ? `${artifacts.width}×${artifacts.height}`
                      : `${targetSize}×${targetSize}`}
                  </span>
                </div>
                <div className="flex aspect-square items-center justify-center rounded border border-slate-800 bg-checkerboard p-3">
                  <canvas
                    ref={canvasRef}
                    data-testid="anim-preview-canvas"
                    className="h-full w-full object-contain"
                    style={{ imageRendering: imgRendering }}
                  />
                </div>
              </div>

              <div className="space-y-1.5 rounded-lg border border-slate-800 bg-slate-950/70 p-3">
                <div className="flex items-center justify-between text-[11px] text-slate-400">
                  <span className="font-semibold text-slate-200">Encoded GIF89a Output</span>
                  <span className="font-mono">
                    {artifacts ? `${(artifacts.gifBytes.length / 1024).toFixed(1)} KB` : '...'}
                  </span>
                </div>
                <div className="flex aspect-square items-center justify-center rounded border border-slate-800 bg-checkerboard p-3">
                  {gifDataUrl ? (
                    <img
                      data-testid="encoded-gif-preview"
                      src={gifDataUrl}
                      alt="Encoded animated GIF sprite preview"
                      className="h-full w-full object-contain"
                      style={{ imageRendering: imgRendering }}
                    />
                  ) : (
                    <span className="text-xs text-slate-500">
                      {isBuilding ? 'Encoding GIF...' : 'Add frames below'}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {errorMsg && (
              <p className="rounded border border-rose-500/30 bg-rose-950/60 px-3 py-2 text-xs text-rose-200">
                {errorMsg}
              </p>
            )}

            {/* Selected Animation Frames */}
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold text-slate-200">
                  Timeline Frames ({frameNodes.length})
                </span>
                <span className="font-mono text-[11px] text-slate-400">
                  {playbackSequence.length} loop steps @ {fps} FPS
                </span>
              </div>

              {frameNodes.length === 0 ? (
                <p className="py-2 text-xs text-slate-500">
                  Add nodes from the DAG palette below to build an animation sequence.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {frameNodes.map((node, idx) => (
                    <div
                      key={`${node.id}-${idx}`}
                      className="flex flex-col items-center gap-1 rounded-md border border-slate-700 bg-slate-900 p-1.5"
                    >
                      <BlobImage
                        blobId={node.imageBlobId}
                        alt={`Frame ${idx + 1}`}
                        artMode={artBible.artMode}
                        className="h-14 w-14 rounded border border-slate-800 bg-checkerboard object-contain"
                      />
                      <span className="font-mono text-[10px] text-slate-300">
                        #{idx + 1} · {node.kind}
                      </span>
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          disabled={idx === 0}
                          onClick={() => moveFrame(idx, -1)}
                          className="rounded border border-slate-700 p-0.5 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                          aria-label={`Move frame ${idx + 1} left`}
                        >
                          <ArrowLeft className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          disabled={idx === frameNodes.length - 1}
                          onClick={() => moveFrame(idx, 1)}
                          className="rounded border border-slate-700 p-0.5 text-slate-300 hover:bg-slate-800 disabled:opacity-30"
                          aria-label={`Move frame ${idx + 1} right`}
                        >
                          <ArrowRight className="h-3 w-3" />
                        </button>
                        <button
                          type="button"
                          data-testid={`anim-remove-frame-${idx}`}
                          onClick={() =>
                            setFrameNodeIds((prev) => prev.filter((_, fIdx) => fIdx !== idx))
                          }
                          className="rounded border border-rose-500/30 p-0.5 text-rose-300 hover:bg-rose-500/20"
                          aria-label={`Remove frame ${idx + 1}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="border-t border-slate-800 pt-2">
                <p className="mb-1.5 text-[11px] font-medium text-slate-400">
                  Append Frame from DAG Nodes:
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {nodes.map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      data-testid={`anim-add-node-${node.id}`}
                      onClick={() => setFrameNodeIds((prev) => [...prev, node.id])}
                      className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                    >
                      <Plus className="h-3 w-3 text-indigo-400" />
                      {node.kind} #{node.generationMeta.seed}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Right: Timing, Auto-Cutout & Export Controls */}
          <aside className="flex flex-col gap-4 rounded-lg border border-slate-800 bg-slate-950/60 p-4">
            <div className="space-y-3">
              <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
                Playback &amp; Timing
              </h3>

              <label className="block space-y-1 text-xs">
                <div className="flex justify-between text-slate-300">
                  <span>Frame Rate</span>
                  <span className="font-mono text-indigo-300">{fps} FPS</span>
                </div>
                <input
                  type="range"
                  data-testid="anim-fps-slider"
                  min={1}
                  max={24}
                  value={fps}
                  onChange={(e) => setFps(Number.parseInt(e.target.value, 10))}
                  className="w-full accent-indigo-500"
                />
              </label>

              <div className="flex flex-col gap-2 text-xs text-slate-200">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="anim-pingpong-toggle"
                    checked={pingPong}
                    onChange={(e) => setPingPong(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  Ping-Pong Loop (Forward + Reverse)
                </label>

                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    data-testid="anim-onion-skin-toggle"
                    checked={onionSkin}
                    onChange={(e) => setOnionSkin(e.target.checked)}
                    className="accent-indigo-500"
                  />
                  Onion Skin Overlay (Canvas)
                </label>
              </div>

              <button
                type="button"
                data-testid="anim-play-toggle"
                onClick={() => setIsPlaying((p) => !p)}
                className="inline-flex w-full items-center justify-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-800"
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                {isPlaying ? 'Pause Playback' : 'Resume Playback'}
              </button>
            </div>

            <div className="space-y-3 border-t border-slate-800 pt-3">
              <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
                Frame Cutout &amp; Resolution
              </h3>

              <label className="block space-y-1 text-xs">
                <span className="text-slate-300">Output Resolution</span>
                <select
                  data-testid="anim-size-select"
                  value={targetSize}
                  onChange={(e) => setTargetSize(Number.parseInt(e.target.value, 10))}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
                >
                  <option value={64}>64×64 (Classic Platformer)</option>
                  <option value={128}>128×128 (Crisp HD Pixel)</option>
                  <option value={256}>256×256 (Large Sprite)</option>
                </select>
              </label>

              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="anim-auto-cutout-toggle"
                  checked={autoCutout}
                  onChange={(e) => setAutoCutout(e.target.checked)}
                  className="accent-indigo-500"
                />
                Auto Color-Key Background Cutout
              </label>

              {autoCutout && (
                <label className="block space-y-1 text-xs">
                  <div className="flex justify-between text-slate-400">
                    <span>Color Tolerance</span>
                    <span className="font-mono">{tolerance}</span>
                  </div>
                  <input
                    type="range"
                    data-testid="anim-tolerance-slider"
                    min={1}
                    max={50}
                    value={tolerance}
                    onChange={(e) => setTolerance(Number.parseInt(e.target.value, 10))}
                    className="w-full accent-indigo-500"
                  />
                </label>
              )}

              <label className="flex items-center gap-2 text-xs text-slate-200">
                <input
                  type="checkbox"
                  data-testid="anim-palette-snap-toggle"
                  checked={paletteSnap}
                  onChange={(e) => setPaletteSnap(e.target.checked)}
                  className="accent-indigo-500"
                />
                OKLab Snap to Art Bible Palette ({artBible.palette.length})
              </label>
            </div>

            <div className="mt-auto space-y-2 border-t border-slate-800 pt-3">
              <button
                type="button"
                data-testid="download-gif-btn"
                disabled={!artifacts || isBuilding}
                onClick={handleDownloadGif}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-indigo-600 px-3 py-2 text-xs font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                <Download className="h-3.5 w-3.5" />
                Download Animated .GIF
              </button>
              <button
                type="button"
                data-testid="download-spritesheet-btn"
                disabled={!artifacts || isBuilding}
                onClick={handleDownloadSpritesheet}
                className="inline-flex w-full items-center justify-center gap-2 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-3 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50"
              >
                <Layers className="h-3.5 w-3.5" />
                Download Spritesheet PNG
              </button>
            </div>
          </aside>
        </div>
      </div>
    </div>
  );
}
