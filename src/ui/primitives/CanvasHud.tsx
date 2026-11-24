import { Columns2, Grid3X3, Maximize2, ZoomIn, ZoomOut } from 'lucide-react';

export type CanvasBackdropMode = 'checkerboard' | 'dark' | 'mid' | 'light' | 'game-green';

export interface CanvasHudProps {
  zoomPercent: number;
  onZoomChange: (nextZoom: number) => void;
  onFitZoom: () => void;
  showPixelGrid: boolean;
  onTogglePixelGrid: () => void;
  wipeEnabled: boolean;
  onToggleWipe: () => void;
  backdrop: CanvasBackdropMode;
  onBackdropChange: (next: CanvasBackdropMode) => void;
}

const BACKDROP_SWATCHES: readonly {
  key: CanvasBackdropMode;
  label: string;
  swatchClass: string;
  swatchStyle?: { backgroundColor: string };
}[] = [
  { key: 'checkerboard', label: 'Checker', swatchClass: 'bg-checkerboard' },
  { key: 'dark', label: 'Dark #111', swatchClass: '', swatchStyle: { backgroundColor: '#111113' } },
  { key: 'mid', label: 'Mid #808', swatchClass: '', swatchStyle: { backgroundColor: '#808080' } },
  {
    key: 'light',
    label: 'Light #E4E',
    swatchClass: '',
    swatchStyle: { backgroundColor: '#E4E4E7' },
  },
  {
    key: 'game-green',
    label: 'Game Green',
    swatchClass: '',
    swatchStyle: { backgroundColor: '#2D5A27' },
  },
];

const QUICK_ZOOMS = [
  { label: '1×', value: 100 },
  { label: '2×', value: 200 },
  { label: '4×', value: 400 },
  { label: '8×', value: 800 },
] as const;

export function CanvasHud({
  zoomPercent,
  onZoomChange,
  onFitZoom,
  showPixelGrid,
  onTogglePixelGrid,
  wipeEnabled,
  onToggleWipe,
  backdrop,
  onBackdropChange,
}: CanvasHudProps) {
  return (
    <div
      data-testid="canvas-hud"
      className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-3"
    >
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1.5 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-panel)]/90 px-3 py-1.5 text-xs shadow-2xl backdrop-blur-md">
        <button
          type="button"
          data-testid="inspector-zoom-out-btn"
          onClick={() => onZoomChange(Math.max(50, zoomPercent - 50))}
          className="rounded-full p-1 text-slate-200 hover:bg-slate-800"
          aria-label="Zoom out"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>
        <span
          data-testid="inspector-zoom-badge"
          className="tabular-nums min-w-11 text-center font-mono text-[11px] font-medium text-[var(--text-primary)]"
        >
          {zoomPercent}%
        </span>
        <button
          type="button"
          data-testid="inspector-zoom-in-btn"
          onClick={() => onZoomChange(Math.min(800, zoomPercent + 50))}
          className="rounded-full p-1 text-slate-200 hover:bg-slate-800"
          aria-label="Zoom in"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>

        <div className="mx-0.5 hidden items-center gap-0.5 border-l border-[var(--border-hairline)] pl-1.5 sm:flex">
          {QUICK_ZOOMS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => onZoomChange(preset.value)}
              className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                zoomPercent === preset.value
                  ? 'bg-[var(--accent-primary)]/20 text-[#F5B82E]'
                  : 'text-[var(--text-muted)] hover:bg-slate-800 hover:text-white'
              }`}
            >
              {preset.label}
            </button>
          ))}
          <button
            type="button"
            data-testid="hud-zoom-fit"
            onClick={onFitZoom}
            className="inline-flex items-center gap-0.5 rounded px-1.5 py-0.5 text-[10px] text-[var(--text-muted)] hover:bg-slate-800 hover:text-white"
            title="Fit sprite to viewport"
          >
            <Maximize2 className="h-2.5 w-2.5" />
            Fit
          </button>
        </div>

        <div className="flex items-center gap-1 border-l border-[var(--border-hairline)] pl-1.5">
          <button
            type="button"
            data-testid="hud-grid-toggle"
            aria-pressed={showPixelGrid}
            onClick={onTogglePixelGrid}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
              showPixelGrid
                ? 'bg-[var(--accent-primary)]/20 text-[#F5B82E]'
                : 'text-[var(--text-muted)] hover:bg-slate-800 hover:text-white'
            }`}
            title="Toggle pixel grid (visible >= 200%)"
          >
            <Grid3X3 className="h-3 w-3" />
            Grid
          </button>
          <button
            type="button"
            data-testid="hud-wipe-toggle"
            aria-pressed={wipeEnabled}
            onClick={onToggleWipe}
            className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] transition-colors ${
              wipeEnabled
                ? 'bg-[var(--accent-primary)]/20 text-[#F5B82E]'
                : 'text-[var(--text-muted)] hover:bg-slate-800 hover:text-white'
            }`}
            title="Toggle before/after wipe (\)"
          >
            <Columns2 className="h-3 w-3" />
            Wipe
          </button>
        </div>

        <div
          className="flex items-center gap-1 border-l border-[var(--border-hairline)] pl-2"
          role="group"
          aria-label="Canvas backdrop"
        >
          {BACKDROP_SWATCHES.map((swatch) => (
            <button
              key={swatch.key}
              type="button"
              data-testid={`inspector-backdrop-${swatch.key}`}
              aria-label={swatch.label}
              title={swatch.label}
              aria-pressed={backdrop === swatch.key}
              onClick={() => onBackdropChange(swatch.key)}
              className={`h-4 w-4 rounded-full border transition-transform ${swatch.swatchClass} ${
                backdrop === swatch.key
                  ? 'scale-110 border-[var(--accent-primary)] ring-2 ring-[var(--accent-primary)]/50'
                  : 'border-slate-600 hover:scale-105'
              }`}
              style={swatch.swatchStyle}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
