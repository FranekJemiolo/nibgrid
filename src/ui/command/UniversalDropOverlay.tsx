import { useEffect, useState } from 'react';
import { FileAudio, ImagePlus, Mic, Palette, Scissors, Sparkles, Upload, X } from 'lucide-react';
import { deduplicateColors } from '../../domain/palette';
import { createDefaultAudioPostProcessConfig, SpriteNodeSchema } from '../../domain/schemas';
import { OFFLINE_MOCK_PROVIDER_ID, repository } from '../../db/database';
import { useAppStore } from '../../store/useAppStore';

type DroppedKind = 'image' | 'audio' | 'unsupported';

function classifyDroppedFile(file: File): DroppedKind {
  const name = file.name.toLowerCase();
  if (
    file.type.startsWith('image/') ||
    name.endsWith('.png') ||
    name.endsWith('.webp') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg')
  ) {
    return 'image';
  }
  if (
    file.type.startsWith('audio/') ||
    name.endsWith('.wav') ||
    name.endsWith('.mp3') ||
    name.endsWith('.ogg')
  ) {
    return 'audio';
  }
  return 'unsupported';
}

function isFileDragEvent(e: DragEvent): boolean {
  const types = e.dataTransfer?.types;
  if (!types) return false;
  return Array.from(types).includes('Files');
}

async function extractTopPaletteFromFile(file: File, maxColors = 8): Promise<string[]> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  try {
    const scale = Math.min(1, 64 / Math.max(1, bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const counts = new Map<string, number>();
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 128) continue;
      const qr = Math.round((data[i] ?? 0) / 16) * 16;
      const qg = Math.round((data[i + 1] ?? 0) / 16) * 16;
      const qb = Math.round((data[i + 2] ?? 0) / 16) * 16;
      const hex = `#${[qr, qg, qb]
        .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase()}`;
      counts.set(hex, (counts.get(hex) ?? 0) + 1);
    }
    const sorted = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxColors)
      .map(([hex]) => hex);
    return deduplicateColors(sorted);
  } finally {
    bitmap.close();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function UniversalDropOverlay() {
  const {
    activeProject,
    navigate,
    refreshSpriteNodes,
    addGoldenReference,
    patchActiveArtBible,
    saveAudioAssetRecord,
  } = useAppStore();

  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [droppedFile, setDroppedFile] = useState<File | null>(null);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    let dragDepth = 0;

    const handleDragEnter = (e: DragEvent) => {
      if (!isFileDragEvent(e)) return;
      e.preventDefault();
      dragDepth += 1;
      setIsDraggingFiles(true);
    };

    const handleDragOver = (e: DragEvent) => {
      if (!isFileDragEvent(e)) return;
      e.preventDefault();
    };

    const handleDragLeave = (e: DragEvent) => {
      if (!isFileDragEvent(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) {
        setIsDraggingFiles(false);
      }
    };

    const handleDrop = (e: DragEvent) => {
      if (!isFileDragEvent(e)) return;
      e.preventDefault();
      dragDepth = 0;
      setIsDraggingFiles(false);
      const firstFile = e.dataTransfer?.files?.[0];
      if (firstFile) {
        setErrorMsg(null);
        setDroppedFile(firstFile);
      }
    };

    window.addEventListener('dragenter', handleDragEnter);
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('dragleave', handleDragLeave);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragenter', handleDragEnter);
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('dragleave', handleDragLeave);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  useEffect(() => {
    if (!droppedFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyMessage) {
        setDroppedFile(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [droppedFile, busyMessage]);

  const importImageNode = async (asTurnaroundSheet: boolean) => {
    if (!activeProject || !droppedFile) return;
    setBusyMessage('Importing image into IndexedDB...');
    setErrorMsg(null);
    try {
      const stored = await repository.storeBlob(droppedFile, droppedFile.type || 'image/png');
      const node = SpriteNodeSchema.parse({
        id: globalThis.crypto.randomUUID(),
        projectId: activeProject.id,
        parentId: null,
        kind: 'sketch',
        imageBlobId: stored.id,
        sketchSha256: stored.sha256,
        ...(asTurnaroundSheet
          ? {
              turnaroundMeta: {
                isTurnaroundSheet: true,
                turnaroundLayout: '2x2' as const,
              },
            }
          : {}),
        generationMeta: {
          providerId: OFFLINE_MOCK_PROVIDER_ID,
          modelId: 'universal-drop-import',
          seed: 0,
          adherence: 'balanced',
          promptDelta: droppedFile.name,
          compiledPrompt: droppedFile.name,
          createdAt: new Date().toISOString(),
        },
      });
      await repository.saveSpriteNode(node);
      await refreshSpriteNodes(activeProject.id);
      setDroppedFile(null);
      await navigate({
        screen: 'inspector',
        projectId: activeProject.id,
        nodeId: node.id,
        ...(asTurnaroundSheet ? { initialTab: 'turnaround' } : {}),
      });
    } catch (err) {
      await repository.cleanupOrphanedBlobs().catch(() => {});
      setErrorMsg(err instanceof Error ? err.message : 'Failed to import dropped image.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleAddGoldenRef = async () => {
    if (!activeProject || !droppedFile) return;
    setBusyMessage('Adding Golden Reference...');
    setErrorMsg(null);
    try {
      await addGoldenReference(droppedFile);
      setDroppedFile(null);
      await navigate({ screen: 'bible', projectId: activeProject.id });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to add golden reference.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleExtractPalette = async () => {
    if (!activeProject || !droppedFile) return;
    setBusyMessage('Extracting dominant palette...');
    setErrorMsg(null);
    try {
      const swatches = await extractTopPaletteFromFile(droppedFile, 8);
      if (swatches.length === 0) {
        throw new Error('No opaque pixels found to extract a palette.');
      }
      await patchActiveArtBible({ palette: swatches });
      setDroppedFile(null);
      await navigate({ screen: 'bible', projectId: activeProject.id });
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Palette extraction failed.');
    } finally {
      setBusyMessage(null);
    }
  };

  const handleImportAudio = async () => {
    if (!activeProject || !droppedFile) return;
    setBusyMessage('Saving audio clip...');
    setErrorMsg(null);
    try {
      const stored = await repository.storeBlob(droppedFile, droppedFile.type || 'audio/wav');
      await saveAudioAssetRecord({
        id: globalThis.crypto.randomUUID(),
        projectId: activeProject.id,
        name: droppedFile.name.replace(/\.[^.]+$/, '') || 'Imported Audio',
        presetId: 'sfx-sprite-impact',
        route: 'local-synth',
        modelId: 'universal-drop-audio',
        wavBlobId: stored.id,
        variationBlobIds: [],
        postProcess: createDefaultAudioPostProcessConfig(),
        lufs: -14,
        durationSec: 1.0,
        createdAt: new Date().toISOString(),
      });
      setDroppedFile(null);
      await navigate({ screen: 'audio', projectId: activeProject.id });
    } catch (err) {
      await repository.cleanupOrphanedBlobs().catch(() => {});
      setErrorMsg(err instanceof Error ? err.message : 'Failed to import audio file.');
    } finally {
      setBusyMessage(null);
    }
  };

  const droppedKind = droppedFile ? classifyDroppedFile(droppedFile) : null;

  return (
    <>
      {isDraggingFiles && (
        <div
          data-testid="universal-drop-overlay"
          className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-6 backdrop-blur-sm"
        >
          <div className="flex max-w-md flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-[var(--accent-primary)] bg-[var(--bg-panel)]/95 px-8 py-10 text-center shadow-2xl">
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[var(--accent-primary)]/15 text-[var(--accent-primary)]">
              <Upload className="h-6 w-6" />
            </div>
            <h3 className="text-base font-semibold text-[var(--text-primary)]">
              Drop Asset into Nibgrid
            </h3>
            <p className="text-xs text-[var(--text-muted)]">
              Release `.png`/`.webp` sprites, turnaround sheets, or `.wav`/`.mp3` audio clips to
              route directly.
            </p>
          </div>
        </div>
      )}

      {droppedFile && (
        <div
          data-testid="universal-drop-modal"
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-xs"
          onClick={() => {
            if (!busyMessage) setDroppedFile(null);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Route dropped file"
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-md space-y-4 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] p-5 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-[var(--text-primary)]">
                  Route Dropped File
                </h3>
                <p className="mt-0.5 font-mono text-[11px] text-[var(--text-muted)]">
                  {droppedFile.name} · {Math.max(1, Math.round(droppedFile.size / 1024))} KB
                </p>
              </div>
              <button
                type="button"
                disabled={Boolean(busyMessage)}
                onClick={() => setDroppedFile(null)}
                className="rounded p-1 text-[var(--text-muted)] hover:bg-[var(--bg-elevated)] hover:text-white"
                aria-label="Cancel file drop"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {errorMsg && (
              <div className="rounded border border-rose-500/40 bg-rose-950/50 px-3 py-2 text-xs text-rose-200">
                {errorMsg}
              </div>
            )}

            {!activeProject ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-200">
                Open or create a project in Projects Hub first so Nibgrid knows where to store this
                asset.
              </p>
            ) : droppedKind === 'image' ? (
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  data-testid="drop-action-sprite"
                  disabled={Boolean(busyMessage)}
                  onClick={() => void importImageNode(false)}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60"
                >
                  <ImagePlus className="h-4 w-4 text-emerald-400" />
                  <span>Import as Sprite Node (Screen 4 Inspector)</span>
                </button>
                <button
                  type="button"
                  data-testid="drop-action-golden-ref"
                  disabled={Boolean(busyMessage)}
                  onClick={() => void handleAddGoldenRef()}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60"
                >
                  <Sparkles className="h-4 w-4 text-[var(--accent-primary)]" />
                  <span>Add as Art Bible Golden Reference</span>
                </button>
                <button
                  type="button"
                  data-testid="drop-action-turnaround"
                  disabled={Boolean(busyMessage)}
                  onClick={() => void importImageNode(true)}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60"
                >
                  <Scissors className="h-4 w-4 text-cyan-400" />
                  <span>Slice as 2×2 Orthographic Turnaround Sheet</span>
                </button>
                <button
                  type="button"
                  data-testid="drop-action-extract-palette"
                  disabled={Boolean(busyMessage)}
                  onClick={() => void handleExtractPalette()}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60"
                >
                  <Palette className="h-4 w-4 text-amber-300" />
                  <span>Extract Top 8 Swatches to Art Bible Palette</span>
                </button>
              </div>
            ) : droppedKind === 'audio' ? (
              <div className="grid grid-cols-1 gap-2">
                <button
                  type="button"
                  data-testid="drop-action-audio-import"
                  disabled={Boolean(busyMessage)}
                  onClick={() => void handleImportAudio()}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60"
                >
                  <FileAudio className="h-4 w-4 text-cyan-400" />
                  <span>Import Audio Clip into Audio Foundry</span>
                </button>
                <button
                  type="button"
                  data-testid="drop-action-hum-studio"
                  disabled={Boolean(busyMessage)}
                  onClick={() => {
                    setDroppedFile(null);
                    void navigate({ screen: 'audio', projectId: activeProject.id });
                  }}
                  className="flex items-center gap-2.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-3 py-2.5 text-left text-xs font-medium text-[var(--text-primary)] hover:border-[var(--accent-primary)]/60"
                >
                  <Mic className="h-4 w-4 text-[var(--accent-primary)]" />
                  <span>Open Screen 6 Audio Foundry</span>
                </button>
              </div>
            ) : (
              <p className="text-xs text-[var(--text-muted)]">
                Unsupported file type. Drop a `.png`/`.webp` image or `.wav`/`.mp3` audio clip.
              </p>
            )}

            {busyMessage && <p className="text-[11px] text-amber-300">{busyMessage}</p>}
          </div>
        </div>
      )}
    </>
  );
}
