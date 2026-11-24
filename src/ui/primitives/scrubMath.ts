export interface ScrubOptions {
  value: number;
  deltaPx: number;
  step: number;
  min: number;
  max: number;
  pixelsPerStep?: number;
  fineMode?: boolean;
  decimals?: number;
}

function inferStepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = step.toString();
  if (text.includes('e-')) {
    const exp = Number.parseInt(text.split('e-')[1] ?? '0', 10);
    return Number.isFinite(exp) ? exp : 0;
  }
  const dotIdx = text.indexOf('.');
  return dotIdx === -1 ? 0 : text.length - dotIdx - 1;
}

/**
 * Computes a deterministic, clamped, quantized value for horizontal pointer scrubbing.
 * Supports `0.1x` fine precision when `fineMode` is true and avoids float precision drift.
 */
export function computeScrubbedValue(opts: ScrubOptions): number {
  const lo = Math.min(opts.min, opts.max);
  const hi = Math.max(opts.min, opts.max);
  const startVal = Number.isFinite(opts.value) ? Math.min(hi, Math.max(lo, opts.value)) : lo;
  const rawDeltaPx = Number.isFinite(opts.deltaPx) ? opts.deltaPx : 0;
  const baseStep = Number.isFinite(opts.step) && opts.step > 0 ? opts.step : 1;
  const pxPerStep =
    opts.pixelsPerStep !== undefined &&
    Number.isFinite(opts.pixelsPerStep) &&
    opts.pixelsPerStep > 0
      ? opts.pixelsPerStep
      : 4;

  const effectiveStep = opts.fineMode ? baseStep * 0.1 : baseStep;
  const rawValue = startVal + (rawDeltaPx / pxPerStep) * effectiveStep;
  const snapped = Math.round(rawValue / effectiveStep) * effectiveStep;
  const clamped = Math.min(hi, Math.max(lo, snapped));

  const targetDecimals =
    opts.decimals !== undefined && Number.isFinite(opts.decimals) && opts.decimals >= 0
      ? Math.min(8, Math.floor(opts.decimals))
      : Math.min(8, inferStepDecimals(baseStep) + (opts.fineMode ? 1 : 0));

  const factor = Math.pow(10, targetDecimals);
  const rounded = Math.round(clamped * factor) / factor;
  return Object.is(rounded, -0) ? 0 : rounded;
}

export function formatScrubValue(value: number, decimals?: number, unit?: string): string {
  const safeVal = Number.isFinite(value) ? value : 0;
  const numStr =
    decimals !== undefined && Number.isFinite(decimals)
      ? safeVal.toFixed(Math.max(0, Math.min(8, Math.floor(decimals))))
      : String(safeVal);
  return unit ? `${numStr} ${unit}` : numStr;
}
