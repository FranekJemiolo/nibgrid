import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { ChevronDown, ChevronUp, ExternalLink, GripHorizontal, RefreshCw } from 'lucide-react';
import { BIOME_PRESETS, generateBiomeTile, type BiomeId } from '../../processing/sandboxBiomes';
import { computeBiomeContrast } from '../../processing/sandboxContrast';
import type { RgbaBuffer } from '../../processing/types';

export interface PipBiomePreviewProps {
  sprite: RgbaBuffer | null;
  pixelArt: boolean;
  onOpenSandbox: () => void;
}

const STORAGE_KEY = 'nibgrid.pipBiome.v1';
const PIP_W = 168;
const PIP_H = 126;

interface PersistedPipState {
  biomeIdx: number;
  collapsed: boolean;
  offsetX: number;
  offsetY: number;
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable ||
    Boolean(target.closest('[contenteditable="true"]'))
  );
}

function loadPersistedState(): PersistedPipState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { biomeIdx: 0, collapsed: false, offsetX: 0, offsetY: 0 };
    const parsed = JSON.parse(raw) as Partial<PersistedPipState>;
    return {
      biomeIdx:
        typeof parsed.biomeIdx === 'number' && Number.isFinite(parsed.biomeIdx)
          ? Math.max(0, parsed.biomeIdx % BIOME_PRESETS.length)
          : 0,
      collapsed: Boolean(parsed.collapsed),
      offsetX:
        typeof parsed.offsetX === 'number' && Number.isFinite(parsed.offsetX) ? parsed.offsetX : 0,
      offsetY:
        typeof parsed.offsetY === 'number' && Number.isFinite(parsed.offsetY) ? parsed.offsetY : 0,
    };
  } catch {
    return { biomeIdx: 0, collapsed: false, offsetX: 0, offsetY: 0 };
  }
}

export function PipBiomePreview({ sprite, pixelArt, onOpenSandbox }: PipBiomePreviewProps) {
  const initial = useMemo(() => loadPersistedState(), []);
  const [biomeIdx, setBiomeIdx] = useState<number>(initial.biomeIdx);
  const [collapsed, setCollapsed] = useState<boolean>(initial.collapsed);
  const [offset, setOffset] = useState<{ x: number; y: number }>({
    x: initial.offsetX,
    y: initial.offsetY,
  });

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const scratchCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const tileScratchRef = useRef<HTMLCanvasElement | null>(null);
  const dragOriginRef = useRef<{
    startX: number;
    startY: number;
    origX: number;
    origY: number;
  } | null>(null);

  const biomeMeta = BIOME_PRESETS[biomeIdx % BIOME_PRESETS.length] ?? BIOME_PRESETS[0]!;
  const biomeTile = useMemo(() => generateBiomeTile(biomeMeta.id as BiomeId, 64), [biomeMeta.id]);

  const contrastReport = useMemo(() => {
    if (!sprite) return null;
    return computeBiomeContrast(sprite, biomeTile);
  }, [sprite, biomeTile]);

  useEffect(() => {
    return () => {
      if (tileScratchRef.current) {
        tileScratchRef.current.width = 0;
        tileScratchRef.current.height = 0;
        tileScratchRef.current = null;
      }
      if (scratchCanvasRef.current) {
        scratchCanvasRef.current.width = 0;
        scratchCanvasRef.current.height = 0;
        scratchCanvasRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          biomeIdx,
          collapsed,
          offsetX: offset.x,
          offsetY: offset.y,
        }),
      );
    } catch {
      // Ignore storage quota / privacy mode errors
    }
  }, [biomeIdx, collapsed, offset.x, offset.y]);

  // Global 'P' hotkey toggles PiP visibility strictly outside inputs/textareas/selects
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() !== 'p') return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      setCollapsed((c) => !c);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Reactive Canvas2D redraw (Zero WebGL2 contexts, zero requestAnimationFrame loops)
  useEffect(() => {
    if (collapsed) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = PIP_W;
    canvas.height = PIP_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, PIP_W, PIP_H);

    // Paint tiled biome
    let tileCanvas = tileScratchRef.current;
    if (!tileCanvas) {
      tileCanvas = document.createElement('canvas');
      tileScratchRef.current = tileCanvas;
    }
    tileCanvas.width = biomeTile.width;
    tileCanvas.height = biomeTile.height;
    const tileCtx = tileCanvas.getContext('2d');
    if (tileCtx) {
      tileCtx.putImageData(
        new ImageData(new Uint8ClampedArray(biomeTile.data), biomeTile.width, biomeTile.height),
        0,
        0,
      );
      for (let y = 0; y < PIP_H; y += biomeTile.height) {
        for (let x = 0; x < PIP_W; x += biomeTile.width) {
          ctx.drawImage(tileCanvas, x, y);
        }
      }
    }

    if (!sprite) return;

    let spriteCanvas = scratchCanvasRef.current;
    if (!spriteCanvas) {
      spriteCanvas = document.createElement('canvas');
      scratchCanvasRef.current = spriteCanvas;
    }
    spriteCanvas.width = sprite.width;
    spriteCanvas.height = sprite.height;
    const sCtx = spriteCanvas.getContext('2d');
    if (sCtx) {
      sCtx.putImageData(
        new ImageData(new Uint8ClampedArray(sprite.data), sprite.width, sprite.height),
        0,
        0,
      );
      ctx.imageSmoothingEnabled = !pixelArt;
      const drawX = Math.floor((PIP_W - sprite.width) / 2);
      const drawY = Math.floor((PIP_H - sprite.height) / 2);
      ctx.drawImage(spriteCanvas, drawX, drawY);
    }
  }, [sprite, biomeTile, collapsed, pixelArt]);

  const handleHeaderPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement | null)?.closest('button')) return;
    dragOriginRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: offset.x,
      origY: offset.y,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handleHeaderPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin) return;
    const dx = e.clientX - origin.startX;
    const dy = e.clientY - origin.startY;
    setOffset({
      x: Math.max(-420, Math.min(12, origin.origX + dx)),
      y: Math.max(-320, Math.min(56, origin.origY + dy)),
    });
  };

  const handleHeaderPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragOriginRef.current) return;
    dragOriginRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const badgeTone =
    contrastReport?.rating === 'strong'
      ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
      : contrastReport?.rating === 'moderate'
        ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
        : 'border-rose-500/40 bg-rose-500/15 text-rose-300';

  return (
    <div
      data-testid="pip-biome-preview"
      data-collapsed={String(collapsed)}
      className="pointer-events-auto absolute z-20 overflow-hidden rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-panel)]/95 shadow-2xl backdrop-blur-md select-none"
      style={{
        right: `${Math.max(12, 16 - offset.x)}px`,
        bottom: `${Math.max(12, 72 - offset.y)}px`,
      }}
    >
      <div
        onPointerDown={handleHeaderPointerDown}
        onPointerMove={handleHeaderPointerMove}
        onPointerUp={handleHeaderPointerUp}
        onPointerCancel={handleHeaderPointerUp}
        className="flex cursor-grab items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-elevated)]/90 px-2 py-1 text-[11px] active:cursor-grabbing"
      >
        <div className="flex items-center gap-1 text-slate-300">
          <GripHorizontal className="h-3 w-3 text-[var(--text-muted)]" />
          <span className="font-semibold">1× {biomeMeta.shortLabel}</span>
        </div>

        <div className="flex items-center gap-1">
          {contrastReport && (
            <span
              data-testid="pip-contrast-badge"
              className={`tabular-nums rounded border px-1 py-0.2 font-mono text-[10px] font-semibold ${badgeTone}`}
              title={contrastReport.suggestion}
            >
              {contrastReport.contrastRatio.toFixed(1)}:1{' '}
              {contrastReport.rating === 'weak' ? 'LOW' : 'PASS'}
            </span>
          )}
          <button
            type="button"
            data-testid="pip-biome-cycle-btn"
            onClick={() => setBiomeIdx((idx) => (idx + 1) % BIOME_PRESETS.length)}
            className="rounded p-0.5 text-[var(--text-muted)] hover:bg-slate-700 hover:text-white"
            aria-label="Cycle biome backdrop"
            title="Cycle 1× biome background"
          >
            <RefreshCw className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-testid="pip-open-sandbox-btn"
            onClick={onOpenSandbox}
            className="rounded p-0.5 text-[var(--text-muted)] hover:bg-slate-700 hover:text-white"
            aria-label="Open full 1× Game Sandbox"
            title="Open 1× Game Sandbox"
          >
            <ExternalLink className="h-3 w-3" />
          </button>
          <button
            type="button"
            data-testid="pip-toggle-btn"
            onClick={() => setCollapsed((c) => !c)}
            className="rounded p-0.5 text-[var(--text-muted)] hover:bg-slate-700 hover:text-white"
            aria-label={collapsed ? 'Expand 1× biome preview (P)' : 'Collapse 1× biome preview (P)'}
            title="Toggle 1× PiP (P)"
          >
            {collapsed ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <div className="relative bg-black/40 p-1.5">
          <canvas
            ref={canvasRef}
            data-testid="pip-biome-canvas"
            width={PIP_W}
            height={PIP_H}
            className="pixelated block rounded border border-[var(--border-hairline)]"
            style={{ width: `${PIP_W}px`, height: `${PIP_H}px` }}
          />
          {sprite && (
            <div className="mt-1 flex items-center justify-between px-0.5 font-mono text-[10px] text-[var(--text-muted)]">
              <span>
                {sprite.width}×{sprite.height} @ 1×
              </span>
              <span>{biomeMeta.targetLuminanceHint}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
