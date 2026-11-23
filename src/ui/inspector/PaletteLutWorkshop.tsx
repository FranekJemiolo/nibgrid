import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Download, Palette, Plus, Sparkles, Trash2 } from 'lucide-react';
import { zipSync, strToU8 } from 'fflate';
import type {
  ArtMode,
  PaletteLutConfig,
  PostProcessConfig,
  Project,
  SpriteNode,
} from '../../domain/schemas';
import { parseHexRgb } from '../../processing/backgroundKey';
import {
  clusterPaletteRamps,
  countUniqueOpaqueColors,
  decodeIndexedSprite,
  encodeLutBuffer,
  evaluatePaletteVariant,
  extractIndexedSprite,
  quantizeBufferToMaxColors,
  type PaletteVariant,
  type RampTransform,
} from '../../processing/paletteLut';
import { encodeRgbaToPngBytes } from '../../processing/png';
import type { Rgb, RgbaBuffer } from '../../processing/types';
import {
  generateGodotPaletteSwapShader,
  generatePixiPaletteSwapFilterTs,
} from '../../export/lutShaders';
import { buildAssetRecipe } from '../../export/recipeBuilder';
import { toAssetSlug, triggerBlobDownload } from '../../export/zipPackager';

export interface PaletteLutWorkshopProps {
  sprite: RgbaBuffer;
  artMode: ArtMode;
  project: Project;
  targetNode: SpriteNode;
  postProcessConfig: PostProcessConfig;
  rawWidth: number;
  rawHeight: number;
  variants?: PaletteVariant[];
  onChangeVariants?: (variants: PaletteVariant[]) => void;
  exportSlot?: ReactNode;
}

const DEFAULT_RAMP_TRANSFORM: Omit<RampTransform, 'rampId'> = {
  hueShiftDeg: 0,
  chromaScale: 1,
  lightnessShift: 0,
  temperatureShift: 0,
};

const QUICK_PRESETS: readonly {
  readonly name: string;
  readonly hueShiftDeg: number;
  readonly chromaScale: number;
  readonly lightnessShift: number;
  readonly temperatureShift: number;
}[] = [
  {
    name: 'Faction Red',
    hueShiftDeg: -140,
    chromaScale: 1.25,
    lightnessShift: 0.02,
    temperatureShift: 0.02,
  },
  {
    name: 'Toxic Slime',
    hueShiftDeg: 105,
    chromaScale: 1.3,
    lightnessShift: 0.04,
    temperatureShift: -0.02,
  },
  {
    name: 'Frozen',
    hueShiftDeg: -165,
    chromaScale: 0.85,
    lightnessShift: 0.12,
    temperatureShift: -0.04,
  },
  {
    name: 'Shadow Cursed',
    hueShiftDeg: 85,
    chromaScale: 0.7,
    lightnessShift: -0.18,
    temperatureShift: -0.03,
  },
  {
    name: 'Golden Rare',
    hueShiftDeg: -50,
    chromaScale: 1.35,
    lightnessShift: 0.08,
    temperatureShift: 0.04,
  },
];

function rgbToHex(rgb: Rgb): string {
  const h = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, '0');
  return `#${h(rgb.r)}${h(rgb.g)}${h(rgb.b)}`;
}

function PreviewBufferCanvas({
  buffer,
  zoomScale,
  pixelArt,
  testId,
}: {
  buffer: RgbaBuffer;
  zoomScale: number;
  pixelArt: boolean;
  testId: string;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    if (canvas.width !== buffer.width) canvas.width = buffer.width;
    if (canvas.height !== buffer.height) canvas.height = buffer.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = !pixelArt;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(buffer.data), buffer.width, buffer.height),
      0,
      0,
    );
  }, [buffer, pixelArt]);

  return (
    <canvas
      ref={ref}
      data-testid={testId}
      className="max-h-[260px] max-w-full rounded border border-slate-700 bg-checkerboard shadow-lg"
      style={{
        width: `${buffer.width * zoomScale}px`,
        height: `${buffer.height * zoomScale}px`,
        imageRendering: pixelArt ? 'pixelated' : 'auto',
      }}
    />
  );
}

export function PaletteLutWorkshop({
  sprite,
  artMode,
  project,
  targetNode,
  postProcessConfig,
  rawWidth,
  rawHeight,
  variants: controlledVariants,
  onChangeVariants,
  exportSlot,
}: PaletteLutWorkshopProps) {
  const [workingSprite, setWorkingSprite] = useState<RgbaBuffer>(sprite);
  const [localVariants, setLocalVariants] = useState<PaletteVariant[]>([]);
  const variants = controlledVariants ?? localVariants;
  const variantsRef = useRef(variants);
  variantsRef.current = variants;
  const setVariants = (
    updater: PaletteVariant[] | ((prev: PaletteVariant[]) => PaletteVariant[]),
  ) => {
    const next = typeof updater === 'function' ? updater(variantsRef.current) : updater;
    if (onChangeVariants) {
      onChangeVariants(next);
    } else {
      setLocalVariants(next);
    }
  };
  const [activeVariantIdx, setActiveVariantIdx] = useState(0);
  const [selectedRampId, setSelectedRampId] = useState<string | null>(null);
  const [lutMode, setLutMode] = useState<'stacked' | 'single'>('stacked');
  const [zoomMult, setZoomMult] = useState<1 | 2 | 4>(2);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  const lutStripCanvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    setWorkingSprite(sprite);
  }, [sprite]);

  const uniqueColorCount = useMemo(() => countUniqueOpaqueColors(workingSprite), [workingSprite]);
  const needsQuantize = uniqueColorCount > 256;

  const indexedResult = useMemo(() => {
    if (needsQuantize) return null;
    try {
      return extractIndexedSprite(workingSprite);
    } catch {
      return null;
    }
  }, [workingSprite, needsQuantize]);

  const ramps = useMemo(
    () => (indexedResult ? clusterPaletteRamps(indexedResult.palette) : []),
    [indexedResult],
  );

  // Default selectedRampId to first chromatic ramp when ramps update
  useEffect(() => {
    if (ramps.length === 0) {
      setSelectedRampId(null);
      return;
    }
    setSelectedRampId((prev) => {
      if (prev && ramps.some((r) => r.id === prev)) return prev;
      return ramps.find((r) => !r.isNeutral)?.id ?? ramps[0]!.id;
    });
  }, [ramps]);

  const safeActiveVariantIdx =
    variants.length === 0 ? -1 : Math.max(0, Math.min(variants.length - 1, activeVariantIdx));
  const activeVariant = safeActiveVariantIdx >= 0 ? (variants[safeActiveVariantIdx] ?? null) : null;

  const variantPalettes = useMemo(() => {
    if (!indexedResult) return [];
    return variants.map((v) => evaluatePaletteVariant(indexedResult.palette, ramps, v));
  }, [indexedResult, ramps, variants]);

  const stackedLut = useMemo(() => {
    if (!indexedResult || indexedResult.palette.length === 0) return null;
    return encodeLutBuffer([indexedResult.palette, ...variantPalettes]);
  }, [indexedResult, variantPalettes]);

  const decodedBase = useMemo(() => {
    if (!indexedResult || !stackedLut) return workingSprite;
    return decodeIndexedSprite(indexedResult.indexedBuffer, stackedLut, 0);
  }, [indexedResult, stackedLut, workingSprite]);

  const decodedVariants = useMemo(() => {
    if (!indexedResult || !stackedLut) return [];
    return variants.map((_, i) =>
      decodeIndexedSprite(indexedResult.indexedBuffer, stackedLut, i + 1),
    );
  }, [indexedResult, stackedLut, variants]);

  // Draw live LUT strip texture canvas
  useEffect(() => {
    const canvas = lutStripCanvasRef.current;
    if (!canvas || !stackedLut) return;
    if (canvas.width !== stackedLut.width) canvas.width = stackedLut.width;
    if (canvas.height !== stackedLut.height) canvas.height = stackedLut.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.putImageData(
      new ImageData(new Uint8ClampedArray(stackedLut.data), stackedLut.width, stackedLut.height),
      0,
      0,
    );
  }, [stackedLut]);

  const activeTransform: RampTransform = useMemo(() => {
    const rId = selectedRampId ?? ramps[0]?.id ?? 'ramp_1';
    const existing = activeVariant?.rampTransforms.find((t) => t.rampId === rId);
    return existing ?? { rampId: rId, ...DEFAULT_RAMP_TRANSFORM };
  }, [activeVariant, selectedRampId, ramps]);

  const handleAddVariant = (preset?: (typeof QUICK_PRESETS)[number]) => {
    const nextNum = variants.length + 1;
    const id = `variant_${nextNum}_${Date.now().toString(36).slice(-4)}`;
    const newVar: PaletteVariant = {
      id,
      name: preset ? preset.name : `Variant ${nextNum}`,
      rampTransforms: ramps.map((r) => ({
        rampId: r.id,
        hueShiftDeg: preset && !r.isNeutral ? preset.hueShiftDeg : 0,
        chromaScale: preset && !r.isNeutral ? preset.chromaScale : 1,
        lightnessShift: preset ? preset.lightnessShift : 0,
        temperatureShift: preset && !r.isNeutral ? preset.temperatureShift : 0,
      })),
      overrides: {},
    };
    setVariants((prev) => [...prev, newVar]);
    setActiveVariantIdx(variants.length);
  };

  const updateActiveTransform = (patch: Partial<Omit<RampTransform, 'rampId'>>) => {
    if (safeActiveVariantIdx < 0 || !activeTransform.rampId) return;
    const targetRampId = activeTransform.rampId;
    setVariants((prev) =>
      prev.map((v, idx) => {
        if (idx !== safeActiveVariantIdx) return v;
        const exists = v.rampTransforms.some((t) => t.rampId === targetRampId);
        const nextTransforms = exists
          ? v.rampTransforms.map((t) => (t.rampId === targetRampId ? { ...t, ...patch } : t))
          : [...v.rampTransforms, { rampId: targetRampId, ...DEFAULT_RAMP_TRANSFORM, ...patch }];
        return { ...v, rampTransforms: nextTransforms };
      }),
    );
  };

  const updateActiveSwatchOverride = (swatchIdx: number, hex: string) => {
    if (safeActiveVariantIdx < 0) return;
    const rgb = parseHexRgb(hex);
    setVariants((prev) =>
      prev.map((v, idx) =>
        idx === safeActiveVariantIdx
          ? { ...v, overrides: { ...v.overrides, [swatchIdx]: rgb } }
          : v,
      ),
    );
  };

  const handleDownloadLutBundle = () => {
    if (!indexedResult || !stackedLut) return;
    const baseSlug = toAssetSlug(
      `${project.name}-${targetNode.kind}-${targetNode.generationMeta.seed}`,
    );
    const paletteSize = indexedResult.palette.length;
    const variantCount = Math.max(1, stackedLut.height);

    const idxFilename = `${baseSlug}_idx.png`;
    const lutFilename = `${baseSlug}_lut.png`;
    const files: Record<string, Uint8Array> = {
      [idxFilename]: encodeRgbaToPngBytes(
        indexedResult.indexedBuffer.data,
        indexedResult.indexedBuffer.width,
        indexedResult.indexedBuffer.height,
      ),
    };

    if (lutMode === 'stacked') {
      files[lutFilename] = encodeRgbaToPngBytes(
        stackedLut.data,
        stackedLut.width,
        stackedLut.height,
      );
    } else {
      const baseLut = encodeLutBuffer([indexedResult.palette]);
      files[`${baseSlug}_base_lut.png`] = encodeRgbaToPngBytes(
        baseLut.data,
        baseLut.width,
        baseLut.height,
      );
      variantPalettes.forEach((vp, i) => {
        const vSlug = toAssetSlug(variants[i]?.name ?? `variant-${i + 1}`);
        const single = encodeLutBuffer([vp]);
        files[`${baseSlug}_${vSlug}_lut.png`] = encodeRgbaToPngBytes(
          single.data,
          single.width,
          single.height,
        );
      });
    }

    files[`${baseSlug}_palette_swap.gdshader`] = strToU8(
      generateGodotPaletteSwapShader(baseSlug, paletteSize, variantCount),
    );
    files[`${baseSlug}_palette_swap_pixi.ts`] = strToU8(
      generatePixiPaletteSwapFilterTs(baseSlug, paletteSize, variantCount),
    );

    const lutRecipeMeta: PaletteLutConfig = {
      mode: lutMode,
      paletteSize,
      variantCount,
      idxFilename,
      lutFilename: lutMode === 'stacked' ? lutFilename : `${baseSlug}_base_lut.png`,
      variants: variants.map((v) => ({
        id: v.id,
        name: v.name,
        rampTransforms: [...v.rampTransforms],
        overrides: Object.fromEntries(
          Object.entries(v.overrides).map(([k, rgb]) => [k, rgbToHex(rgb)]),
        ),
      })),
    };

    const recipe = buildAssetRecipe({
      project,
      node: targetNode,
      postProcess: postProcessConfig,
      filename: `${baseSlug}.png`,
      outputWidth: workingSprite.width,
      outputHeight: workingSprite.height,
      normalizedWidth: rawWidth,
      normalizedHeight: rawHeight,
      paletteLut: lutRecipeMeta,
    });
    files[`${baseSlug}.recipe.json`] = strToU8(`${JSON.stringify(recipe, null, 2)}\n`);

    const zipBytes = zipSync(files, { level: 6 });
    const copy = new Uint8Array(zipBytes.byteLength);
    copy.set(zipBytes);
    triggerBlobDownload(
      new Blob([copy.buffer], { type: 'application/zip' }),
      `${baseSlug}-lut-bundle.zip`,
    );
    setStatusNotice(
      `Exported ${idxFilename} + ${lutMode === 'stacked' ? `${lutFilename} (${paletteSize}×${stackedLut.height})` : `${variantPalettes.length + 1}×(N×1) LUTs`} + Godot & PixiJS shaders.`,
    );
  };

  const isPixelArt = artMode === 'pixel-art';
  const basePreviewScale = isPixelArt
    ? zoomMult
    : Math.max(1, Math.min(2, Math.floor((zoomMult * 64) / Math.max(1, workingSprite.width))));

  return (
    <div
      data-testid="palette-lut-workshop-panel"
      className="grid min-w-0 flex-1 grid-cols-1 lg:grid-cols-[310px_minmax(0,1fr)_320px]"
    >
      {/* Left Pane: Variant Tabs + Auto-Clustered OKLCH Ramps */}
      <aside className="space-y-4 overflow-y-auto border-b border-slate-800 bg-slate-900/60 p-4 lg:border-r lg:border-b-0">
        {needsQuantize && (
          <div
            data-testid="lut-over-256-banner"
            className="space-y-2 rounded-lg border border-amber-500/40 bg-amber-950/40 p-3 text-xs text-amber-100"
          >
            <p>
              Sprite has <strong>{uniqueColorCount}</strong> unique colors (exceeds 256-index 8-bit
              LUT limit).
            </p>
            <button
              type="button"
              data-testid="lut-quantize-32-btn"
              onClick={() => {
                setWorkingSprite(quantizeBufferToMaxColors(workingSprite, 32));
                setStatusNotice('Quantized sprite cleanly to <= 32 colors for LUT indexing.');
              }}
              className="inline-flex w-full items-center justify-center gap-1.5 rounded bg-amber-500 px-2.5 py-1.5 font-semibold text-slate-950 hover:bg-amber-400"
            >
              <Sparkles className="h-3.5 w-3.5" />
              Quantize to 32 Colors
            </button>
          </div>
        )}

        <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-semibold text-slate-200">Variants ({variants.length})</span>
            <button
              type="button"
              data-testid="lut-add-variant-btn"
              disabled={!indexedResult || variants.length >= 8}
              onClick={() => handleAddVariant()}
              className="inline-flex items-center gap-1 rounded border border-indigo-500/40 bg-indigo-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-indigo-500 disabled:opacity-40"
            >
              <Plus className="h-3 w-3" />
              Add Variant
            </button>
          </div>

          <div className="flex flex-wrap gap-1">
            {QUICK_PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                disabled={!indexedResult || variants.length >= 8}
                onClick={() => handleAddVariant(preset)}
                className="rounded border border-slate-700 bg-slate-900 px-1.5 py-0.5 text-[10px] text-slate-300 hover:bg-slate-800 disabled:opacity-40"
              >
                +{preset.name}
              </button>
            ))}
          </div>

          {variants.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {variants.map((v, idx) => (
                <div
                  key={v.id}
                  className="inline-flex items-center overflow-hidden rounded border border-slate-700"
                >
                  <button
                    type="button"
                    data-testid={`lut-variant-tab-${idx}`}
                    onClick={() => setActiveVariantIdx(idx)}
                    className={`px-2 py-1 text-[11px] ${
                      safeActiveVariantIdx === idx
                        ? 'bg-indigo-600 font-semibold text-white'
                        : 'bg-slate-900 text-slate-300'
                    }`}
                  >
                    {v.name}
                  </button>
                  <button
                    type="button"
                    aria-label={`Remove ${v.name}`}
                    onClick={() => {
                      setVariants((prev) => prev.filter((_, i) => i !== idx));
                      setActiveVariantIdx((prevIdx) => Math.max(0, prevIdx - 1));
                    }}
                    className="bg-slate-900 px-1.5 py-1 text-slate-400 hover:text-rose-300"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Clustered OKLCH Ramp Cards */}
        <div className="space-y-2">
          <div className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
            Clustered OKLCH Ramps ({ramps.length})
          </div>
          {ramps.map((ramp, rIdx) => {
            const isSelected = selectedRampId === ramp.id;
            const currentPal =
              safeActiveVariantIdx >= 0
                ? (variantPalettes[safeActiveVariantIdx] ?? indexedResult?.palette ?? [])
                : (indexedResult?.palette ?? []);
            return (
              <div
                key={ramp.id}
                data-testid={`lut-ramp-${rIdx}`}
                onClick={() => setSelectedRampId(ramp.id)}
                className={`cursor-pointer space-y-2 rounded-lg border p-2.5 text-xs ${
                  isSelected
                    ? 'border-indigo-500 bg-indigo-950/30'
                    : 'border-slate-800 bg-slate-950/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-slate-200">{ramp.label}</span>
                  <span className="font-mono text-[10px] text-slate-400">
                    {ramp.swatchIndices.length} swatches
                  </span>
                </div>
                <div className="flex flex-wrap gap-1">
                  {ramp.swatchIndices.map((sIdx) => {
                    const col = currentPal[sIdx] ??
                      indexedResult?.palette[sIdx] ?? { r: 0, g: 0, b: 0 };
                    const hex = rgbToHex(col);
                    return (
                      <label
                        key={sIdx}
                        title={`Index ${sIdx} (${hex}) — click to override`}
                        className="relative h-5 w-5 cursor-pointer overflow-hidden rounded border border-slate-700"
                        style={{ backgroundColor: hex }}
                      >
                        {safeActiveVariantIdx >= 0 && (
                          <input
                            type="color"
                            data-testid={`lut-swatch-override-${sIdx}`}
                            value={hex}
                            onChange={(e) => updateActiveSwatchOverride(sIdx, e.target.value)}
                            className="absolute inset-0 cursor-pointer opacity-0"
                          />
                        )}
                      </label>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>

        {/* Active Variant OKLCH Sliders */}
        {activeVariant && selectedRampId && (
          <div className="space-y-2.5 rounded-lg border border-slate-800 bg-slate-950/60 p-3 text-xs">
            <div className="flex items-center gap-1.5 font-semibold text-slate-200">
              <Palette className="h-3.5 w-3.5 text-indigo-400" />
              <span>{activeVariant.name} Sliders</span>
            </div>

            <label className="block space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Hue Shift</span>
                <span className="font-mono">{activeTransform.hueShiftDeg}°</span>
              </div>
              <input
                type="range"
                data-testid="lut-hue-shift"
                min={-180}
                max={180}
                step={5}
                value={activeTransform.hueShiftDeg}
                onChange={(e) =>
                  updateActiveTransform({ hueShiftDeg: Number.parseInt(e.target.value, 10) })
                }
                className="w-full accent-indigo-500"
              />
            </label>

            <label className="block space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Chroma Scale</span>
                <span className="font-mono">{activeTransform.chromaScale.toFixed(2)}×</span>
              </div>
              <input
                type="range"
                data-testid="lut-chroma-scale"
                min={0}
                max={2}
                step={0.05}
                value={activeTransform.chromaScale}
                onChange={(e) =>
                  updateActiveTransform({ chromaScale: Number.parseFloat(e.target.value) })
                }
                className="w-full accent-indigo-500"
              />
            </label>

            <label className="block space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Lightness Shift</span>
                <span className="font-mono">{activeTransform.lightnessShift.toFixed(2)}</span>
              </div>
              <input
                type="range"
                data-testid="lut-lightness-shift"
                min={-0.4}
                max={0.4}
                step={0.02}
                value={activeTransform.lightnessShift}
                onChange={(e) =>
                  updateActiveTransform({ lightnessShift: Number.parseFloat(e.target.value) })
                }
                className="w-full accent-indigo-500"
              />
            </label>

            <label className="block space-y-1">
              <div className="flex justify-between text-slate-400">
                <span>Temp Contrast</span>
                <span className="font-mono">{activeTransform.temperatureShift.toFixed(3)}</span>
              </div>
              <input
                type="range"
                data-testid="lut-temp-shift"
                min={-0.05}
                max={0.05}
                step={0.005}
                value={activeTransform.temperatureShift}
                onChange={(e) =>
                  updateActiveTransform({ temperatureShift: Number.parseFloat(e.target.value) })
                }
                className="w-full accent-indigo-500"
              />
            </label>
          </div>
        )}
      </aside>

      {/* Center Pane: Synchronized Multi-Variant Grid + Magnified LUT Strip */}
      <section className="flex min-w-0 flex-col bg-slate-950">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/40 px-4 py-2 text-xs">
          <div className="flex items-center gap-1.5">
            <span className="text-slate-400">Zoom:</span>
            {([1, 2, 4] as const).map((z) => (
              <button
                key={z}
                type="button"
                onClick={() => setZoomMult(z)}
                className={`rounded border px-2 py-0.5 font-mono ${
                  zoomMult === z
                    ? 'border-indigo-500 bg-indigo-600 text-white'
                    : 'border-slate-700 bg-slate-900 text-slate-300'
                }`}
              >
                {z}×
              </button>
            ))}
          </div>

          {stackedLut && (
            <span
              data-testid="lut-dimensions-badge"
              className="rounded border border-emerald-500/40 bg-emerald-950/40 px-2.5 py-0.5 font-mono text-[11px] text-emerald-200"
            >
              LUT: {stackedLut.width}×{stackedLut.height} ({stackedLut.width} colors ·{' '}
              {variants.length} variants)
            </span>
          )}
        </div>

        <div className="flex flex-1 flex-col justify-between gap-6 overflow-auto bg-checkerboard p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div className="flex flex-col items-center gap-2 rounded-lg border border-slate-800 bg-slate-950/80 p-3">
              <span className="text-xs font-medium text-slate-200">Base (Row 0)</span>
              <PreviewBufferCanvas
                buffer={decodedBase}
                zoomScale={basePreviewScale}
                pixelArt={isPixelArt}
                testId="lut-preview-base"
              />
            </div>

            {variants.map((variant, idx) => (
              <div
                key={variant.id}
                onClick={() => setActiveVariantIdx(idx)}
                className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-3 ${
                  safeActiveVariantIdx === idx
                    ? 'border-indigo-500 bg-indigo-950/30'
                    : 'border-slate-800 bg-slate-950/80'
                }`}
              >
                <span className="text-xs font-medium text-slate-200">
                  {variant.name} (Row {idx + 1})
                </span>
                <PreviewBufferCanvas
                  buffer={decodedVariants[idx] ?? decodedBase}
                  zoomScale={basePreviewScale}
                  pixelArt={isPixelArt}
                  testId={`lut-preview-variant-${idx}`}
                />
              </div>
            ))}
          </div>

          {stackedLut && (
            <div className="space-y-2 rounded-lg border border-slate-800 bg-slate-950/85 p-3">
              <div className="text-[11px] font-semibold tracking-wider text-slate-400 uppercase">
                Live N×M LUT Texture Strip ({stackedLut.width}×{stackedLut.height})
              </div>
              <canvas
                ref={lutStripCanvasRef}
                data-testid="lut-strip-canvas"
                className="w-full rounded border border-slate-700"
                style={{
                  height: `${Math.max(24, stackedLut.height * 16)}px`,
                  imageRendering: 'pixelated',
                }}
              />
            </div>
          )}
        </div>

        {statusNotice && (
          <div
            data-testid="lut-status-banner"
            className="border-t border-indigo-500/30 bg-indigo-950/30 px-4 py-1.5 text-[11px] text-indigo-200"
          >
            {statusNotice}
          </div>
        )}
      </section>

      {/* Right Pane: Export Controls */}
      <aside className="space-y-4 overflow-y-auto border-t border-slate-800 bg-slate-900/70 p-4 lg:border-t-0 lg:border-l">
        <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/60 p-3.5 text-xs">
          <div className="font-semibold text-slate-200">LUT Texture Format</div>

          <div className="grid grid-cols-2 gap-1.5">
            <button
              type="button"
              data-testid="lut-mode-stacked"
              onClick={() => setLutMode('stacked')}
              className={`rounded border px-2 py-1.5 text-[11px] font-medium ${
                lutMode === 'stacked'
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300'
              }`}
            >
              Stacked N×M Sheet
            </button>
            <button
              type="button"
              data-testid="lut-mode-single"
              onClick={() => setLutMode('single')}
              className={`rounded border px-2 py-1.5 text-[11px] font-medium ${
                lutMode === 'single'
                  ? 'border-indigo-500 bg-indigo-600 text-white'
                  : 'border-slate-700 bg-slate-900 text-slate-300'
              }`}
            >
              Single N×1 per Var
            </button>
          </div>

          <p className="text-[11px] text-slate-400">
            Emits linear <code>_idx.png</code> (R=G=B=index), nearest-filtered <code>_lut.png</code>
            , Godot 4 <code>.gdshader</code>, PixiJS v8 <code>Filter</code>, and{' '}
            <code>recipe.json</code>.
          </p>

          <button
            type="button"
            data-testid="lut-download-zip-btn"
            disabled={!indexedResult || !stackedLut}
            onClick={handleDownloadLutBundle}
            className="inline-flex w-full items-center justify-center gap-2 rounded-md bg-emerald-600 px-3 py-2 font-semibold text-white hover:bg-emerald-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Download className="h-3.5 w-3.5" />
            Download LUT Bundle (.zip)
          </button>
        </div>

        {exportSlot}
      </aside>
    </div>
  );
}
