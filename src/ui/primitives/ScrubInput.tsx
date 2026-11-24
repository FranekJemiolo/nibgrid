import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { computeScrubbedValue, formatScrubValue } from './scrubMath';

export interface ScrubInputProps {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  decimals?: number;
  pixelsPerStep?: number;
  disabled?: boolean;
  testId?: string;
  compatRangeTestId?: string;
  className?: string;
}

export function ScrubInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
  unit,
  decimals,
  pixelsPerStep = 4,
  disabled = false,
  testId,
  compatRangeTestId,
  className = '',
}: ScrubInputProps) {
  const [editing, setEditing] = useState(false);
  const [draftText, setDraftText] = useState('');
  const [dragging, setDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const dragOriginRef = useRef<{ startX: number; startValue: number } | null>(null);
  const cancelledEditRef = useRef(false);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const safeValue = Number.isFinite(value) ? Math.min(hi, Math.max(lo, value)) : lo;
  const fillPct = hi > lo ? ((safeValue - lo) / (hi - lo)) * 100 : 0;

  const beginInlineEdit = () => {
    if (disabled) return;
    cancelledEditRef.current = false;
    setDraftText(String(safeValue));
    setEditing(true);
  };

  const commitInlineEdit = () => {
    if (cancelledEditRef.current) {
      cancelledEditRef.current = false;
      setEditing(false);
      return;
    }
    const parsed = Number.parseFloat(draftText);
    if (Number.isFinite(parsed)) {
      const clamped = Math.min(hi, Math.max(lo, parsed));
      const factor = decimals !== undefined ? Math.pow(10, Math.max(0, Math.floor(decimals))) : 1e6;
      const clean = Math.round(clamped * factor) / factor;
      onChange(Object.is(clean, -0) ? 0 : clean);
    }
    setEditing(false);
  };

  const handlePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || editing || e.button !== 0) return;
    if ((e.target as HTMLElement | null)?.tagName === 'INPUT') return;
    dragOriginRef.current = { startX: e.clientX, startValue: safeValue };
    setDragging(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const origin = dragOriginRef.current;
    if (!origin || disabled || editing) return;
    const next = computeScrubbedValue({
      value: origin.startValue,
      deltaPx: e.clientX - origin.startX,
      step,
      min: lo,
      max: hi,
      pixelsPerStep,
      fineMode: e.shiftKey,
      ...(decimals !== undefined ? { decimals } : {}),
    });
    if (next !== safeValue) {
      onChange(next);
    }
  };

  const handlePointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragOriginRef.current) return;
    dragOriginRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  };

  const handlePillKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (disabled || editing) return;
    if (e.key === 'Enter' || e.key === 'F2') {
      e.preventDefault();
      beginInlineEdit();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(
        computeScrubbedValue({
          value: safeValue,
          deltaPx: pixelsPerStep,
          step,
          min: lo,
          max: hi,
          pixelsPerStep,
          fineMode: e.shiftKey,
          ...(decimals !== undefined ? { decimals } : {}),
        }),
      );
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(
        computeScrubbedValue({
          value: safeValue,
          deltaPx: -pixelsPerStep,
          step,
          min: lo,
          max: hi,
          pixelsPerStep,
          fineMode: e.shiftKey,
          ...(decimals !== undefined ? { decimals } : {}),
        }),
      );
    }
  };

  const displayText = formatScrubValue(safeValue, decimals, unit);

  return (
    <div
      data-testid={testId}
      data-value={String(safeValue)}
      tabIndex={disabled || editing ? -1 : 0}
      role="spinbutton"
      aria-label={label}
      aria-valuemin={lo}
      aria-valuemax={hi}
      aria-valuenow={safeValue}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={beginInlineEdit}
      onKeyDown={handlePillKeyDown}
      className={`group relative overflow-hidden rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] text-xs select-none transition-colors ${
        disabled
          ? 'cursor-not-allowed opacity-50'
          : dragging
            ? 'cursor-ew-resize border-[var(--accent-primary)]/70'
            : 'cursor-ew-resize hover:border-slate-600 focus:border-[var(--accent-primary)] focus:outline-none'
      } ${className}`}
      title="Drag horizontally to scrub (Shift = 0.1× fine). Double-click to type."
    >
      {/* Proportion bar fill */}
      <div
        className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--accent-primary)]/12 transition-[width] duration-75"
        style={{ width: `${Math.max(0, Math.min(100, fillPct))}%` }}
      />

      <div className="relative flex items-center justify-between gap-2 px-2.5 py-1.5">
        <span className="truncate text-[11px] text-[var(--text-muted)]">{label}</span>
        {editing ? (
          <input
            ref={inputRef}
            type="number"
            data-testid={testId ? `${testId}-input` : undefined}
            min={lo}
            max={hi}
            step={step}
            value={draftText}
            onChange={(e) => setDraftText(e.target.value)}
            onBlur={commitInlineEdit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                commitInlineEdit();
              } else if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                cancelledEditRef.current = true;
                setEditing(false);
              }
            }}
            className="tabular-nums w-20 rounded border border-[var(--accent-primary)] bg-[var(--bg-well)] px-1.5 py-0.5 text-right font-mono text-[11px] text-[var(--text-primary)] outline-none"
          />
        ) : (
          <span className="tabular-nums font-mono text-[11px] font-medium text-[var(--text-primary)]">
            {displayText}
          </span>
        )}
      </div>

      {compatRangeTestId && !editing && (
        <input
          type="range"
          data-testid={compatRangeTestId}
          aria-label={label}
          min={lo}
          max={hi}
          step={step}
          disabled={disabled}
          value={safeValue}
          onPointerDown={(e) => e.stopPropagation()}
          onChange={(e) => {
            const next = Number.parseFloat(e.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
          className="relative block h-1 w-full cursor-pointer accent-[var(--accent-primary)] opacity-60 transition-opacity hover:opacity-100"
        />
      )}
    </div>
  );
}
