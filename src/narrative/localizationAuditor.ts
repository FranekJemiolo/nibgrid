import type { BakedBitmapFont } from '../processing/bitmapFont';
import { UI_BOX_PRESETS, type DialogueGraph, type LocalizationTable } from './dialogueSchemas';

export interface GlyphFinding {
  readonly key: string;
  readonly locale: string;
  readonly missingChars: readonly string[];
}

export interface GlyphAuditReport {
  readonly ok: boolean;
  readonly missingByLocale: Readonly<Record<string, readonly string[]>>;
  readonly missingCodepoints: readonly number[];
  readonly missingChars: readonly string[];
  readonly findings: readonly GlyphFinding[];
}

export interface M24GlyphMetricsInput {
  readonly defaultAdvancePx: number;
  readonly advancesByCodepoint?: ReadonlyMap<number, number>;
  readonly kerning?: ReadonlyMap<string, number>;
  readonly lineHeightPx?: number;
}

export interface UiBoxConstraint {
  readonly maxWidthPx: number;
  readonly maxLines: number;
  readonly lineHeightPx?: number;
}

export interface OverflowFinding {
  readonly key: string;
  readonly locale: string;
  readonly text: string;
  readonly measuredWidthPx: number;
  readonly maxWidthPx: number;
  readonly lineCount: number;
  readonly maxLines: number;
  readonly reason: 'width-exceeded' | 'lines-exceeded' | 'both';
}

export interface OverflowAuditReport {
  readonly ok: boolean;
  readonly findings: readonly OverflowFinding[];
}

function isIgnoredControlOrWhitespace(codepoint: number): boolean {
  return (
    codepoint < 0x20 ||
    codepoint === 0x20 ||
    codepoint === 0x09 ||
    codepoint === 0x0a ||
    codepoint === 0x0d ||
    codepoint === 0x00a0
  );
}

/**
 * Converts a string into a Unicode codepoint Set using `for...of` iteration (never UTF-16 `.charCodeAt()`).
 */
export function buildCharsetCodepointSet(charset: string): Set<number> {
  const codepoints = new Set<number>();
  for (const ch of charset) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) {
      codepoints.add(cp);
    }
  }
  return codepoints;
}

/**
 * Scans every localized string across all locales by Unicode codepoint against M24's `.fnt` charset,
 * ignoring control and whitespace characters (`\n`, `\r`, `\t`, `' '`).
 */
export function auditFontGlyphCoverage(
  table: LocalizationTable,
  m24Charset: ReadonlySet<number>,
): GlyphAuditReport {
  const missingByLocaleSet = new Map<string, Set<string>>();
  const missingCpSet = new Set<number>();
  const findings: GlyphFinding[] = [];

  const sortedKeys = Object.keys(table.strings).sort();
  for (const key of sortedKeys) {
    const perLocale = table.strings[key];
    if (!perLocale) continue;

    for (const locale of table.locales) {
      const text = perLocale[locale];
      if (!text) continue;

      const missingInCell: string[] = [];
      const seenInCell = new Set<number>();

      for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp === undefined || isIgnoredControlOrWhitespace(cp)) continue;
        if (!m24Charset.has(cp)) {
          missingCpSet.add(cp);
          let localeSet = missingByLocaleSet.get(locale);
          if (!localeSet) {
            localeSet = new Set<string>();
            missingByLocaleSet.set(locale, localeSet);
          }
          localeSet.add(ch);

          if (!seenInCell.has(cp)) {
            seenInCell.add(cp);
            missingInCell.push(ch);
          }
        }
      }

      if (missingInCell.length > 0) {
        findings.push({
          key,
          locale,
          missingChars: missingInCell,
        });
      }
    }
  }

  const missingByLocale: Record<string, readonly string[]> = {};
  for (const locale of table.locales) {
    const chars = missingByLocaleSet.get(locale);
    if (chars && chars.size > 0) {
      missingByLocale[locale] = Array.from(chars);
    }
  }

  const missingCodepoints = Array.from(missingCpSet).sort((a, b) => a - b);
  const missingChars = missingCodepoints.map((cp) => String.fromCodePoint(cp));

  return {
    ok: findings.length === 0,
    missingByLocale,
    missingCodepoints,
    missingChars,
    findings,
  };
}

/**
 * Extracts per-codepoint glyph advance metrics from an already-baked M24 `BakedBitmapFont`.
 */
export function buildM24MetricsFromBakedFont(font: BakedBitmapFont): M24GlyphMetricsInput {
  const advances = new Map<number, number>();
  let totalAdvance = 0;
  for (const glyph of font.glyphs) {
    advances.set(glyph.id, glyph.xadvance);
    totalAdvance += glyph.xadvance;
  }
  const avgAdvance = font.glyphs.length > 0 ? Math.round(totalAdvance / font.glyphs.length) : 10;
  return {
    defaultAdvancePx: Math.max(4, avgAdvance),
    advancesByCodepoint: advances,
    lineHeightPx: font.lineHeight,
  };
}

/**
 * Derives UI box width/line constraints for every textKey and choice labelKey in a `DialogueGraph`.
 */
export function buildConstraintsFromDialogueGraph(
  graph: DialogueGraph,
): Map<string, UiBoxConstraint> {
  const constraints = new Map<string, UiBoxConstraint>();
  const defaultDialogue = UI_BOX_PRESETS['dialogue_box']!;
  const defaultChoice = UI_BOX_PRESETS['choice_button']!;

  for (const node of graph.nodes) {
    const preset =
      (node.uiBoxPresetId ? UI_BOX_PRESETS[node.uiBoxPresetId] : undefined) ?? defaultDialogue;
    constraints.set(node.textKey, {
      maxWidthPx: preset.maxWidthPx,
      maxLines: preset.maxLines,
      lineHeightPx: preset.lineHeightPx,
    });
    for (const choice of node.choices) {
      if (!constraints.has(choice.labelKey)) {
        constraints.set(choice.labelKey, {
          maxWidthPx: defaultChoice.maxWidthPx,
          maxLines: defaultChoice.maxLines,
          lineHeightPx: defaultChoice.lineHeightPx,
        });
      }
    }
  }

  return constraints;
}

function measureRunPx(text: string, metrics: M24GlyphMetricsInput): number {
  let width = 0;
  let prevCh: string | null = null;
  let prevCp: number | null = null;

  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    const adv = metrics.advancesByCodepoint?.get(cp) ?? metrics.defaultAdvancePx;
    let kern = 0;
    if (prevCh !== null && prevCp !== null && metrics.kerning) {
      kern = metrics.kerning.get(`${prevCp}:${cp}`) ?? metrics.kerning.get(`${prevCh}${ch}`) ?? 0;
    }
    width += adv + kern;
    prevCh = ch;
    prevCp = cp;
  }

  return Math.max(0, Math.round(width * 100) / 100);
}

/**
 * Simulates deterministic pixel word-wrapping using M24 glyph advances and kerning pairs against
 * M33 9-slice container constraints (`maxWidthPx`, `maxLines`).
 */
export function measureWrappedTextPx(
  text: string,
  metrics: M24GlyphMetricsInput,
  maxWidthPx: number,
): {
  readonly lines: readonly string[];
  readonly lineWidthsPx: readonly number[];
  readonly maxLineWidthPx: number;
} {
  const normalized = text.replace(/\r\n/g, '\n');
  const paragraphs = normalized.split('\n');
  const spaceWidth = measureRunPx(' ', metrics);
  const lines: string[] = [];
  const lineWidthsPx: number[] = [];

  for (const paragraph of paragraphs) {
    const words = paragraph.trim().length === 0 ? [] : paragraph.trim().split(/\s+/);
    if (words.length === 0) {
      lines.push('');
      lineWidthsPx.push(0);
      continue;
    }

    let currentLine = words[0] ?? '';
    let currentWidth = measureRunPx(currentLine, metrics);

    for (let i = 1; i < words.length; i++) {
      const word = words[i] ?? '';
      const wordWidth = measureRunPx(word, metrics);
      const candidateWidth = currentWidth + spaceWidth + wordWidth;

      if (candidateWidth <= maxWidthPx) {
        currentLine = `${currentLine} ${word}`;
        currentWidth = candidateWidth;
      } else {
        lines.push(currentLine);
        lineWidthsPx.push(currentWidth);
        currentLine = word;
        currentWidth = wordWidth;
      }
    }

    lines.push(currentLine);
    lineWidthsPx.push(currentWidth);
  }

  const maxLineWidthPx = lineWidthsPx.reduce((best, w) => Math.max(best, w), 0);
  return { lines, lineWidthsPx, maxLineWidthPx };
}

/**
 * Audits every constrained `(key, locale)` entry for horizontal pixel width overflow or line-count overflow.
 */
export function auditUiTextOverflow(
  table: LocalizationTable,
  m24Metrics: M24GlyphMetricsInput,
  constraintsByKey: ReadonlyMap<string, UiBoxConstraint>,
): OverflowAuditReport {
  const findings: OverflowFinding[] = [];
  const sortedKeys = Object.keys(table.strings).sort();

  for (const key of sortedKeys) {
    const constraint = constraintsByKey.get(key);
    if (!constraint) continue;

    const perLocale = table.strings[key];
    if (!perLocale) continue;

    for (const locale of table.locales) {
      const text = perLocale[locale];
      if (!text) continue;

      const wrapped = measureWrappedTextPx(text, m24Metrics, constraint.maxWidthPx);
      const widthExceeded = wrapped.maxLineWidthPx > constraint.maxWidthPx;
      const linesExceeded = wrapped.lines.length > constraint.maxLines;

      if (widthExceeded || linesExceeded) {
        const reason: OverflowFinding['reason'] =
          widthExceeded && linesExceeded
            ? 'both'
            : widthExceeded
              ? 'width-exceeded'
              : 'lines-exceeded';

        findings.push({
          key,
          locale,
          text,
          measuredWidthPx: wrapped.maxLineWidthPx,
          maxWidthPx: constraint.maxWidthPx,
          lineCount: wrapped.lines.length,
          maxLines: constraint.maxLines,
          reason,
        });
      }
    }
  }

  return {
    ok: findings.length === 0,
    findings,
  };
}
