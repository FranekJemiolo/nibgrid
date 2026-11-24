import {
  useEffect,
  useRef,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';

export interface BeforeAfterWipeProps {
  enabled: boolean;
  percent: number;
  onChangePercent: (percent: number) => void;
  onToggleEnabled?: () => void;
  enableBackslashShortcut?: boolean;
  beforeLabel?: string;
  afterLabel?: string;
  before: ReactNode;
  after: ReactNode;
  overlay?: ReactNode;
  widthPx?: number;
  heightPx?: number;
  className?: string;
  style?: CSSProperties;
  disabledDrag?: boolean;
  onSurfacePointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onSurfacePointerMove?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onSurfacePointerUp?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  testId?: string;
  handleTestId?: string;
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

export function BeforeAfterWipe({
  enabled,
  percent,
  onChangePercent,
  onToggleEnabled,
  enableBackslashShortcut = false,
  beforeLabel = 'Before',
  afterLabel = 'After',
  before,
  after,
  overlay,
  widthPx,
  heightPx,
  className = '',
  style,
  disabledDrag = false,
  onSurfacePointerDown,
  onSurfacePointerMove,
  onSurfacePointerUp,
  testId = 'split-comparator',
  handleTestId = 'split-handle',
}: BeforeAfterWipeProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<{
    startX: number;
    captured: boolean;
    startedOnHandle: boolean;
  } | null>(null);

  const clampedPercent = Math.max(0, Math.min(100, percent));

  useEffect(() => {
    if (!enableBackslashShortcut || !onToggleEnabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== '\\') return;
      if (isEditableTarget(e.target) || isEditableTarget(document.activeElement)) return;
      e.preventDefault();
      onToggleEnabled();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enableBackslashShortcut, onToggleEnabled]);

  const updatePercentFromClientX = (clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const rawPct = ((clientX - rect.left) / Math.max(1, rect.width)) * 100;
    onChangePercent(Math.max(0, Math.min(100, Math.round(rawPct))));
  };

  const handleContainerPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabledDrag && onSurfacePointerDown) {
      onSurfacePointerDown(e);
      return;
    }
    if (!enabled || disabledDrag || e.button !== 0) {
      onSurfacePointerDown?.(e);
      return;
    }
    e.preventDefault();
    const startedOnHandle = Boolean(
      handleRef.current && e.target instanceof Node && handleRef.current.contains(e.target),
    );
    dragStateRef.current = {
      startX: e.clientX,
      captured: false,
      startedOnHandle,
    };
  };

  const handleContainerPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabledDrag && onSurfacePointerMove) {
      onSurfacePointerMove(e);
      return;
    }
    const drag = dragStateRef.current;
    if (drag) {
      if (!drag.captured && Math.abs(e.clientX - drag.startX) >= 2) {
        drag.captured = true;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // Synthetic pointer events in tests may lack active pointerId capture
        }
      }
      if (drag.captured) {
        updatePercentFromClientX(e.clientX);
      }
      return;
    }
    onSurfacePointerMove?.(e);
  };

  const handleContainerPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragStateRef.current;
    if (drag) {
      dragStateRef.current = null;
      if (drag.captured) {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
          e.currentTarget.releasePointerCapture(e.pointerId);
        }
      } else if (!drag.startedOnHandle && e.detail <= 1) {
        updatePercentFromClientX(e.clientX);
      }
    }
    onSurfacePointerUp?.(e);
  };

  const handleDividerKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!enabled) return;
    const delta = e.shiftKey ? 10 : 2;
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      onChangePercent(Math.max(0, clampedPercent - delta));
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      onChangePercent(Math.min(100, clampedPercent + delta));
    }
  };

  return (
    <div
      ref={containerRef}
      data-testid={testId}
      data-wipe-enabled={String(enabled)}
      data-wipe-percent={String(clampedPercent)}
      onPointerDown={handleContainerPointerDown}
      onPointerMove={handleContainerPointerMove}
      onPointerUp={handleContainerPointerUp}
      onPointerCancel={handleContainerPointerUp}
      className={`relative select-none ${
        disabledDrag ? 'cursor-crosshair' : enabled ? 'cursor-ew-resize' : ''
      } ${className}`}
      style={{
        ...(widthPx !== undefined ? { width: `${widthPx}px` } : {}),
        ...(heightPx !== undefined ? { height: `${heightPx}px` } : {}),
        touchAction: 'none',
        ...style,
      }}
    >
      {/* Left/Before Layer */}
      <div
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{
          clipPath: enabled ? `inset(0 ${100 - clampedPercent}% 0 0)` : 'inset(0 100% 0 0)',
        }}
      >
        {before}
      </div>

      {/* Right/After Layer */}
      <div
        className="pointer-events-none absolute inset-0 h-full w-full"
        style={{
          clipPath: enabled ? `inset(0 0 0 ${clampedPercent}%)` : 'none',
        }}
      >
        {after}
      </div>

      {overlay}

      {enabled && (
        <div
          ref={handleRef}
          data-testid={handleTestId}
          role="slider"
          tabIndex={0}
          aria-label="Before and after split comparison"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clampedPercent)}
          onKeyDown={handleDividerKeyDown}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onChangePercent(50);
          }}
          className="absolute top-0 bottom-0 z-10 flex w-3 -translate-x-1/2 cursor-ew-resize justify-center focus:outline-none"
          style={{ left: `${clampedPercent}%` }}
        >
          <div className="h-full w-0.5 bg-[var(--accent-primary)] shadow-[0_0_8px_rgba(229,160,13,0.9)]" />
          <span className="pointer-events-none absolute top-2 right-2 rounded bg-[var(--bg-well)]/90 px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-slate-200">
            {beforeLabel}
          </span>
          <span className="pointer-events-none absolute top-2 left-2 rounded bg-[var(--accent-primary)]/90 px-1.5 py-0.5 text-[10px] font-semibold whitespace-nowrap text-[#111113]">
            {afterLabel}
          </span>
        </div>
      )}
    </div>
  );
}
