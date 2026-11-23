import { useState, type ChangeEvent } from 'react';
import {
  ArrowLeft,
  Check,
  ImagePlus,
  Paintbrush,
  Palette,
  Plus,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { normalizeHexColor, parsePaletteFile } from '../../domain/palette';
import {
  ArtBibleSchema,
  type ArtBible,
  type ArtMode,
  type Lighting,
  type Projection,
} from '../../domain/schemas';
import { useAppStore } from '../../store/useAppStore';
import { BlobImage } from '../components/BlobImage';

const RESOLUTION_PRESETS = [
  { label: '64×64', width: 64, height: 64 },
  { label: '128×128', width: 128, height: 128 },
  { label: '256×256', width: 256, height: 256 },
  { label: '512×512', width: 512, height: 512 },
] as const;

export function ArtBibleEditor() {
  const {
    activeProject,
    navigate,
    patchActiveArtBible,
    addGoldenReference,
    removeGoldenReference,
  } = useAppStore();

  const [hexInput, setHexInput] = useState('#38B764');
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [refError, setRefError] = useState<string | null>(null);
  const [dimensionError, setDimensionError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  if (!activeProject) {
    return null;
  }

  const bible = activeProject.artBible;

  const commitBible = async (patch: Partial<ArtBible>) => {
    const current = useAppStore.getState().activeProject?.artBible ?? bible;
    const next = { ...current, ...patch };
    const parsed = ArtBibleSchema.safeParse(next);
    if (!parsed.success) {
      setDimensionError(parsed.error.issues[0]?.message ?? 'Invalid Art Bible configuration');
      return;
    }
    setDimensionError(null);
    await patchActiveArtBible(patch);
    setSavedNotice(true);
    window.setTimeout(() => setSavedNotice(false), 1200);
  };

  const handleAddSwatch = async () => {
    setPaletteError(null);
    try {
      const normalized = normalizeHexColor(hexInput);
      if (bible.palette.includes(normalized)) {
        setPaletteError(`Color ${normalized} is already in the palette.`);
        return;
      }
      if (bible.palette.length >= 64) {
        setPaletteError('Palette limit is 64 colors.');
        return;
      }
      await commitBible({ palette: [...bible.palette, normalized] });
    } catch (error) {
      setPaletteError(error instanceof Error ? error.message : 'Invalid hex color');
    }
  };

  const handleRemoveSwatch = async (hexToRemove: string) => {
    setPaletteError(null);
    await commitBible({
      palette: bible.palette.filter((hex) => hex !== hexToRemove),
    });
  };

  const handlePaletteFileUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    setPaletteError(null);
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      const text = await file.text();
      const parsedColors = parsePaletteFile(file.name, text);
      if (parsedColors.length === 0) {
        setPaletteError('Imported palette file contained no colors.');
        return;
      }
      if (parsedColors.length > 64) {
        setPaletteError(`Imported palette has ${parsedColors.length} colors (max 64).`);
        return;
      }
      await commitBible({ palette: parsedColors });
    } catch (error) {
      setPaletteError(error instanceof Error ? error.message : 'Failed to parse palette file.');
    }
  };

  const handleGoldenRefUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    setRefError(null);
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    try {
      await addGoldenReference(file);
    } catch (error) {
      setRefError(error instanceof Error ? error.message : 'Failed to upload Golden Reference.');
    }
  };

  const handleDimensionChange = async (field: 'targetWidth' | 'targetHeight', rawValue: string) => {
    const parsed = Number.parseInt(rawValue, 10);
    if (Number.isNaN(parsed)) {
      setDimensionError('Dimensions must be whole numbers between 16 and 2048.');
      return;
    }
    await commitBible({ [field]: parsed });
  };

  return (
    <div
      data-testid="art-bible-editor"
      className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-800 bg-slate-900/70 px-5 py-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            data-testid="back-to-hub-btn"
            onClick={() => void navigate({ screen: 'hub' })}
            className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Projects
          </button>
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Art Bible: <span data-testid="bible-project-name">{activeProject.name}</span>
            </h2>
            <p className="text-xs text-slate-400">
              Style Lock settings auto-save to IndexedDB and compile into every generation prompt.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {savedNotice && (
            <span
              data-testid="bible-saved-indicator"
              className="inline-flex items-center gap-1 text-xs text-emerald-400"
            >
              <Check className="h-3.5 w-3.5" />
              Saved to IndexedDB
            </span>
          )}
          <button
            type="button"
            data-testid="go-to-studio-btn"
            onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
            className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-xs font-medium text-white hover:bg-indigo-500"
          >
            <Paintbrush className="h-3.5 w-3.5" />
            Open Sprite Studio
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-5 lg:col-span-2">
          <h3 className="text-sm font-semibold text-slate-100">Geometry, Lighting & Rendering</h3>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <label className="space-y-1.5 text-xs">
              <span className="font-medium text-slate-300">Camera Projection</span>
              <select
                data-testid="projection-select"
                value={bible.projection}
                onChange={(e) => void commitBible({ projection: e.target.value as Projection })}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="top-down">Top-Down</option>
                <option value="isometric">Isometric</option>
                <option value="side-scroller">Side-Scroller</option>
                <option value="three-quarter">Three-Quarter</option>
              </select>
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-medium text-slate-300">Key Lighting</span>
              <select
                data-testid="lighting-select"
                value={bible.lighting}
                onChange={(e) => void commitBible({ lighting: e.target.value as Lighting })}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="top-left">Top-Left</option>
                <option value="top-right">Top-Right</option>
                <option value="overhead">Overhead</option>
                <option value="flat">Flat</option>
              </select>
            </label>

            <label className="space-y-1.5 text-xs">
              <span className="font-medium text-slate-300">Art Mode</span>
              <select
                data-testid="art-mode-select"
                value={bible.artMode}
                onChange={(e) => void commitBible({ artMode: e.target.value as ArtMode })}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              >
                <option value="pixel-art">Pixel Art</option>
                <option value="hd-2d">HD-2D</option>
              </select>
            </label>
          </div>

          <div className="space-y-2 border-t border-slate-800 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs font-medium text-slate-300">Target Sprite Resolution</span>
              <div className="flex flex-wrap gap-1.5">
                {RESOLUTION_PRESETS.map((preset) => {
                  const active =
                    bible.targetWidth === preset.width && bible.targetHeight === preset.height;
                  return (
                    <button
                      key={preset.label}
                      type="button"
                      onClick={() =>
                        void commitBible({
                          targetWidth: preset.width,
                          targetHeight: preset.height,
                        })
                      }
                      className={`rounded px-2.5 py-1 font-mono text-xs transition-colors ${
                        active
                          ? 'bg-indigo-600 text-white'
                          : 'border border-slate-700 bg-slate-950 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {preset.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <label className="space-y-1 text-xs">
                <span className="text-slate-400">Width (16–2048px)</span>
                <input
                  type="number"
                  data-testid="target-width-input"
                  min={16}
                  max={2048}
                  value={bible.targetWidth}
                  onChange={(e) => void handleDimensionChange('targetWidth', e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </label>
              <label className="space-y-1 text-xs">
                <span className="text-slate-400">Height (16–2048px)</span>
                <input
                  type="number"
                  data-testid="target-height-input"
                  min={16}
                  max={2048}
                  value={bible.targetHeight}
                  onChange={(e) => void handleDimensionChange('targetHeight', e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-1.5 font-mono text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>
            {dimensionError && <p className="text-xs text-rose-400">{dimensionError}</p>}
          </div>

          <div className="space-y-3 border-t border-slate-800 pt-4">
            <label className="block space-y-1.5 text-xs">
              <span className="font-medium text-slate-300">Global Style Prompt</span>
              <textarea
                rows={3}
                data-testid="style-prompt-input"
                value={bible.stylePrompt}
                onChange={(e) => void commitBible({ stylePrompt: e.target.value })}
                placeholder="Describe line weight, shading technique, material polish..."
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </label>

            <label className="block space-y-1.5 text-xs">
              <span className="font-medium text-slate-300">Cutout-Safe Negative Prompt</span>
              <textarea
                rows={2}
                data-testid="negative-prompt-input"
                value={bible.negativePrompt}
                onChange={(e) => void commitBible({ negativePrompt: e.target.value })}
                className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </label>
          </div>
        </section>

        <div className="space-y-6">
          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Palette className="h-4 w-4 text-indigo-400" />
                <h3 className="text-sm font-semibold text-slate-100">
                  Locked Palette ({bible.palette.length}/64)
                </h3>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700">
                <Upload className="h-3.5 w-3.5" />
                Import .gpl/.hex
                <input
                  type="file"
                  data-testid="palette-file-input"
                  accept=".gpl,.hex,text/plain"
                  onChange={(e) => void handlePaletteFileUpload(e)}
                  className="hidden"
                />
              </label>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="color"
                value={/^#[0-9A-Fa-f]{6}$/.test(hexInput) ? hexInput : '#38B764'}
                onChange={(e) => setHexInput(e.target.value.toUpperCase())}
                className="h-9 w-10 cursor-pointer rounded border border-slate-700 bg-slate-950 p-0.5"
                aria-label="Pick swatch color"
              />
              <input
                type="text"
                data-testid="hex-swatch-input"
                value={hexInput}
                onChange={(e) => setHexInput(e.target.value)}
                placeholder="#RRGGBB"
                className="flex-1 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
              <button
                type="button"
                data-testid="add-swatch-btn"
                onClick={() => void handleAddSwatch()}
                className="inline-flex items-center gap-1 rounded-md bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </button>
            </div>

            {paletteError && <p className="text-xs text-rose-400">{paletteError}</p>}

            <div data-testid="palette-swatch-list" className="flex flex-wrap gap-2">
              {bible.palette.length === 0 ? (
                <p className="text-xs text-slate-500 italic">No swatches added yet.</p>
              ) : (
                bible.palette.map((hex) => (
                  <div
                    key={hex}
                    data-testid={`palette-swatch-${hex}`}
                    className="inline-flex items-center gap-1.5 rounded-md border border-slate-700 bg-slate-950 px-2 py-1"
                  >
                    <span
                      className="h-3.5 w-3.5 rounded-sm border border-slate-600"
                      style={{ backgroundColor: hex }}
                    />
                    <span className="font-mono text-[11px] text-slate-200">{hex}</span>
                    <button
                      type="button"
                      onClick={() => void handleRemoveSwatch(hex)}
                      className="text-slate-500 hover:text-rose-400"
                      aria-label={`Remove ${hex}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </section>

          <section className="space-y-4 rounded-xl border border-slate-800 bg-slate-900/70 p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Golden References ({bible.goldenReferenceBlobIds.length}/3)
              </h3>
              <label
                className={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium ${
                  bible.goldenReferenceBlobIds.length >= 3
                    ? 'cursor-not-allowed border-slate-800 bg-slate-900 text-slate-500'
                    : 'cursor-pointer border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700'
                }`}
              >
                <ImagePlus className="h-3.5 w-3.5" />
                Upload Ref
                <input
                  type="file"
                  data-testid="golden-ref-input"
                  accept="image/png,image/jpeg,image/webp"
                  disabled={bible.goldenReferenceBlobIds.length >= 3}
                  onChange={(e) => void handleGoldenRefUpload(e)}
                  className="hidden"
                />
              </label>
            </div>

            {refError && <p className="text-xs text-rose-400">{refError}</p>}

            {bible.goldenReferenceBlobIds.length === 0 ? (
              <p className="text-xs text-slate-500">
                Attach 1–3 style anchor sprites (PNG/JPG/WebP). Stored as binary blobs in IndexedDB.
              </p>
            ) : (
              <div data-testid="golden-ref-grid" className="grid grid-cols-3 gap-2.5">
                {bible.goldenReferenceBlobIds.map((blobId, index) => (
                  <div
                    key={blobId}
                    className="group relative overflow-hidden rounded-lg border border-slate-700 bg-checkerboard"
                  >
                    <BlobImage
                      blobId={blobId}
                      alt={`Golden Reference ${index + 1}`}
                      testId={`golden-ref-image-${index}`}
                      className="aspect-square w-full object-contain"
                    />
                    <button
                      type="button"
                      data-testid={`remove-golden-ref-${index}`}
                      onClick={() => void removeGoldenReference(blobId)}
                      className="absolute top-1 right-1 rounded bg-slate-950/85 p-1 text-rose-300 opacity-90 hover:bg-rose-600 hover:text-white"
                      aria-label={`Remove Golden Reference ${index + 1}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
