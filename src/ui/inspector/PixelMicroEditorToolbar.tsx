import {
  Brush,
  Droplet,
  Eraser,
  Eye,
  FlipHorizontal2,
  PaintBucket,
  Pencil,
  Redo2,
  Sparkles,
  Trash2,
  Undo2,
  Unlock,
} from 'lucide-react';
import type { ProviderConfig } from '../../domain/schemas';
import type { PixelBrushSize, PixelTool } from '../../processing/pixelEditorCore';
import { estimateInpaintCost } from '../../providers/inpaintAdapter';

export interface PixelMicroEditorToolbarProps {
  activeTool: PixelTool | null;
  onSelectTool: (tool: PixelTool | null) => void;
  mirrorX: boolean;
  onToggleMirrorX: () => void;
  brushSize: PixelBrushSize;
  onChangeBrushSize: (size: PixelBrushSize) => void;
  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;
  paletteHex: readonly string[];
  activeColorHex: string;
  onSelectColorHex: (hex: string) => void;
  freeColorUnlocked: boolean;
  onToggleFreeColor: () => void;
  maskedPixelCount: number;
  inpaintPrompt: string;
  onChangeInpaintPrompt: (value: string) => void;
  inpaintProviders: readonly ProviderConfig[];
  inpaintProviderId: string;
  onChangeInpaintProviderId: (id: string) => void;
  snapToPalette: boolean;
  onToggleSnapToPalette: () => void;
  onClearMask: () => void;
  onRunInpaint: () => void;
  inpaintBusy: boolean;
  inpaintStatus: string | null;
  inpaintError: string | null;
}

const BRUSH_SIZES: readonly PixelBrushSize[] = [1, 2, 3];

export function PixelMicroEditorToolbar({
  activeTool,
  onSelectTool,
  mirrorX,
  onToggleMirrorX,
  brushSize,
  onChangeBrushSize,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  paletteHex,
  activeColorHex,
  onSelectColorHex,
  freeColorUnlocked,
  onToggleFreeColor,
  maskedPixelCount,
  inpaintPrompt,
  onChangeInpaintPrompt,
  inpaintProviders,
  inpaintProviderId,
  onChangeInpaintProviderId,
  snapToPalette,
  onToggleSnapToPalette,
  onClearMask,
  onRunInpaint,
  inpaintBusy,
  inpaintStatus,
  inpaintError,
}: PixelMicroEditorToolbarProps) {
  const selectedProvider =
    inpaintProviders.find((p) => p.id === inpaintProviderId) ?? inpaintProviders[0];
  const costEstimate = estimateInpaintCost(selectedProvider?.kind ?? 'mock');
  const normalizedActiveHex = activeColorHex.toUpperCase();

  const toolButtonClass = (isActive: boolean, accent: 'amber' | 'rose' = 'amber') =>
    `flex h-7 w-7 items-center justify-center rounded border transition-colors ${
      isActive
        ? accent === 'rose'
          ? 'border-rose-400/70 bg-rose-500/25 text-rose-200'
          : 'border-[#F5B82E] bg-[#F5B82E] text-zinc-950'
        : 'border-transparent bg-transparent text-slate-300 hover:border-[var(--border-hairline)] hover:bg-[var(--bg-elevated)] hover:text-white'
    }`;

  return (
    <>
      {/* Left Floating Micro-Editor Tool Rail */}
      <div
        data-testid="pixel-editor-toolbar"
        className="pointer-events-auto absolute top-3 left-3 z-20 flex flex-col items-center gap-1 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)]/95 p-1.5 shadow-2xl backdrop-blur-md select-none"
      >
        <button
          type="button"
          data-testid="pixel-tool-none"
          aria-pressed={activeTool === null}
          onClick={() => onSelectTool(null)}
          title="Inspect / Wipe Mode (V or Esc)"
          aria-label="Inspect / Wipe Mode"
          className={toolButtonClass(activeTool === null)}
        >
          <Eye className="h-3.5 w-3.5" />
        </button>

        <div className="my-0.5 h-px w-5 bg-[var(--border-hairline)]" />

        <button
          type="button"
          data-testid="pixel-tool-pencil"
          aria-pressed={activeTool === 'pencil'}
          onClick={() => onSelectTool('pencil')}
          title="Pencil (B)"
          aria-label="Pencil (B)"
          className={toolButtonClass(activeTool === 'pencil')}
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="pixel-tool-eraser"
          aria-pressed={activeTool === 'eraser'}
          onClick={() => onSelectTool('eraser')}
          title="Eraser (E)"
          aria-label="Eraser (E)"
          className={toolButtonClass(activeTool === 'eraser')}
        >
          <Eraser className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="pixel-tool-eyedropper"
          aria-pressed={activeTool === 'eyedropper'}
          onClick={() => onSelectTool('eyedropper')}
          title="Eyedropper (I)"
          aria-label="Eyedropper (I)"
          className={toolButtonClass(activeTool === 'eyedropper')}
        >
          <Droplet className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="pixel-tool-fill"
          aria-pressed={activeTool === 'fill'}
          onClick={() => onSelectTool('fill')}
          title="Flood Fill (G)"
          aria-label="Flood Fill (G)"
          className={toolButtonClass(activeTool === 'fill')}
        >
          <PaintBucket className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="pixel-mirror-x-btn"
          aria-pressed={mirrorX}
          onClick={onToggleMirrorX}
          title="Mirror Horizontal Symmetry (M)"
          aria-label="Mirror-X (M)"
          className={`flex h-7 w-7 items-center justify-center rounded border transition-colors ${
            mirrorX
              ? 'border-cyan-400/70 bg-cyan-500/20 text-cyan-200'
              : 'border-transparent text-slate-300 hover:border-[var(--border-hairline)] hover:bg-[var(--bg-elevated)] hover:text-white'
          }`}
        >
          <FlipHorizontal2 className="h-3.5 w-3.5" />
        </button>

        <div className="my-0.5 h-px w-5 bg-[var(--border-hairline)]" />

        <button
          type="button"
          data-testid="pixel-tool-mask-brush"
          aria-pressed={activeTool === 'mask-brush'}
          onClick={() => onSelectTool('mask-brush')}
          title="Inpaint Mask Brush (K)"
          aria-label="Inpaint Mask Brush (K)"
          className={toolButtonClass(activeTool === 'mask-brush', 'rose')}
        >
          <Brush className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="pixel-tool-mask-eraser"
          aria-pressed={activeTool === 'mask-eraser'}
          onClick={() => onSelectTool('mask-eraser')}
          title="Inpaint Mask Eraser"
          aria-label="Inpaint Mask Eraser"
          className={toolButtonClass(activeTool === 'mask-eraser', 'rose')}
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>

        <div className="my-0.5 h-px w-5 bg-[var(--border-hairline)]" />

        <div className="flex flex-col gap-0.5">
          {BRUSH_SIZES.map((sz) => (
            <button
              key={sz}
              type="button"
              data-testid={`pixel-brush-size-${sz}`}
              aria-pressed={brushSize === sz}
              onClick={() => onChangeBrushSize(sz)}
              title={`Brush Size ${sz}px`}
              className={`h-5 w-7 rounded font-mono text-[10px] font-semibold transition-colors ${
                brushSize === sz
                  ? 'bg-slate-200 text-zinc-950'
                  : 'text-slate-400 hover:bg-[var(--bg-elevated)] hover:text-white'
              }`}
            >
              {sz}px
            </button>
          ))}
        </div>

        <div className="my-0.5 h-px w-5 bg-[var(--border-hairline)]" />

        <button
          type="button"
          data-testid="pixel-undo-btn"
          disabled={!canUndo}
          onClick={onUndo}
          title="Undo Pixel Edit (Cmd/Ctrl+Z)"
          aria-label="Undo Pixel Edit"
          className="flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-[var(--bg-elevated)] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Undo2 className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          data-testid="pixel-redo-btn"
          disabled={!canRedo}
          onClick={onRedo}
          title="Redo Pixel Edit (Cmd/Ctrl+Shift+Z)"
          aria-label="Redo Pixel Edit"
          className="flex h-7 w-7 items-center justify-center rounded text-slate-300 hover:bg-[var(--bg-elevated)] hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
        >
          <Redo2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Top-Center Floating Inpaint Action Bar (shown whenever mask > 0 px or status/error present) */}
      {(maskedPixelCount > 0 || inpaintStatus || inpaintError) && (
        <div
          data-testid="inpaint-action-bar"
          className="pointer-events-auto absolute top-3 left-1/2 z-20 flex max-w-[calc(100%-7rem)] -translate-x-1/2 flex-wrap items-center gap-2 rounded-lg border border-rose-500/45 bg-[var(--bg-panel)]/95 px-3 py-2 text-xs shadow-2xl backdrop-blur-md"
        >
          <span
            data-testid="inpaint-mask-count"
            className="rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 font-mono text-[11px] font-semibold text-rose-200"
          >
            {maskedPixelCount} px masked
          </span>

          {maskedPixelCount > 0 && (
            <>
              <select
                data-testid="inpaint-provider-select"
                value={selectedProvider?.id ?? ''}
                onChange={(e) => onChangeInpaintProviderId(e.target.value)}
                className="max-w-36 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-1 text-[11px] text-slate-200"
              >
                {inpaintProviders.map((provider) => (
                  <option key={provider.id} value={provider.id}>
                    {provider.displayName}
                  </option>
                ))}
              </select>

              <input
                type="text"
                data-testid="inpaint-prompt-input"
                value={inpaintPrompt}
                onChange={(e) => onChangeInpaintPrompt(e.target.value)}
                placeholder="Region prompt (e.g. add glowing visor)"
                className="w-48 rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2.5 py-1 text-xs text-slate-100 placeholder:text-slate-500 focus:border-[#F5B82E] focus:outline-none"
              />

              <label
                className="inline-flex items-center gap-1 text-[11px] text-slate-300"
                title="Snap only masked pixels back to Art Bible palette"
              >
                <input
                  type="checkbox"
                  data-testid="inpaint-palette-snap"
                  checked={snapToPalette}
                  onChange={onToggleSnapToPalette}
                  className="accent-amber-500"
                />
                Snap
              </label>

              <span
                data-testid="inpaint-cost-badge"
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-2 py-0.5 font-mono text-[10px] text-amber-300"
              >
                {costEstimate.label}
              </span>

              <button
                type="button"
                data-testid="inpaint-clear-mask-btn"
                onClick={onClearMask}
                className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] text-slate-300 hover:bg-slate-700"
              >
                Clear Mask
              </button>

              <button
                type="button"
                data-testid="inpaint-run-btn"
                disabled={inpaintBusy}
                onClick={onRunInpaint}
                className="inline-flex items-center gap-1 rounded bg-rose-600 px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-rose-500 disabled:opacity-50"
              >
                <Sparkles className="h-3 w-3" />
                {inpaintBusy ? 'Inpainting…' : 'Inpaint Region'}
              </button>
            </>
          )}

          {inpaintStatus && (
            <span data-testid="inpaint-status" className="text-[11px] text-emerald-300">
              {inpaintStatus}
            </span>
          )}
          {inpaintError && (
            <span data-testid="inpaint-error" className="text-[11px] text-rose-300">
              {inpaintError}
            </span>
          )}
        </div>
      )}

      {/* Bottom-Center Palette-Locked Swatch Strip above CanvasHud */}
      <div className="pointer-events-none absolute inset-x-0 bottom-14 z-20 flex justify-center px-3">
        <div
          data-testid="pixel-palette-strip"
          className="pointer-events-auto flex max-w-full flex-wrap items-center gap-1.5 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-panel)]/95 px-2.5 py-1 shadow-xl backdrop-blur-md"
        >
          <span
            className="h-4 w-4 rounded-full border border-white/40 shadow-inner"
            style={{ backgroundColor: normalizedActiveHex }}
            title={`Active color: ${normalizedActiveHex}`}
          />

          <div className="h-3.5 w-px bg-[var(--border-hairline)]" />

          {paletteHex.map((hex, idx) => {
            const upper = hex.toUpperCase();
            const isSelected = upper === normalizedActiveHex;
            return (
              <button
                key={`${upper}-${idx}`}
                type="button"
                data-testid={`pixel-swatch-${idx}`}
                data-color-hex={upper}
                aria-label={`Select palette color ${upper}`}
                onClick={() => onSelectColorHex(upper)}
                className={`h-4 w-4 rounded-sm border transition-transform ${
                  isSelected
                    ? 'scale-110 border-[#F5B82E] ring-2 ring-[#F5B82E]/70'
                    : 'border-slate-700 hover:scale-105 hover:border-slate-400'
                }`}
                style={{ backgroundColor: upper }}
                title={`${upper} (Art Bible)`}
              />
            );
          })}

          <div className="h-3.5 w-px bg-[var(--border-hairline)]" />

          <button
            type="button"
            data-testid="pixel-unlock-color-btn"
            aria-pressed={freeColorUnlocked}
            onClick={onToggleFreeColor}
            title="Unlock free off-palette color picker"
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium transition-colors ${
              freeColorUnlocked
                ? 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/50'
                : 'text-slate-400 hover:text-white'
            }`}
          >
            <Unlock className="h-2.5 w-2.5" />
            {freeColorUnlocked ? 'Free Color ON' : 'Unlock Free Color'}
          </button>

          {freeColorUnlocked && (
            <input
              type="color"
              data-testid="pixel-free-color-input"
              aria-label="Free color picker"
              value={normalizedActiveHex}
              onChange={(e) => onSelectColorHex(e.target.value.toUpperCase())}
              className="h-5 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          )}
        </div>
      </div>
    </>
  );
}
