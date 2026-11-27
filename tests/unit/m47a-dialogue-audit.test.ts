import { describe, expect, it } from 'vitest';
import {
  type DialogueGraph,
  type LocalizationTable,
  validateDialogueGraph,
} from '../../src/narrative/dialogueSchemas';
import {
  auditFontGlyphCoverage,
  auditUiTextOverflow,
  buildCharsetCodepointSet,
  type UiBoxConstraint,
} from '../../src/narrative/localizationAuditor';
import { CHARSET_PRESETS } from '../../src/processing/pixelGlyphTable';

describe('M47A: Dialogue Graph Validation, M24 Glyph Coverage & M33 Overflow Audit', () => {
  it('detects dangling nextNodeId pointers, unreachable nodes, and missing locale translations', () => {
    const graph: DialogueGraph = {
      id: 'guard_gate',
      entryNodeId: 'greet',
      nodes: [
        {
          id: 'greet',
          speakerId: 'guard',
          portraitEmotion: 'neutral',
          textKey: 'DLG_GREET',
          nextNodeId: 'ghost_node', // Dangling!
          choices: [
            {
              id: 'bribe',
              labelKey: 'DLG_CHOICE_BRIBE',
              nextNodeId: 'pass',
              requiredFlags: [],
              setFlags: ['gate_open'],
            },
          ],
        },
        {
          id: 'pass',
          speakerId: 'guard',
          portraitEmotion: 'happy',
          textKey: 'DLG_PASS',
          nextNodeId: null,
          choices: [],
        },
        {
          id: 'secret_orphan',
          speakerId: 'guard',
          portraitEmotion: 'angry',
          textKey: 'DLG_ORPHAN',
          nextNodeId: null,
          choices: [],
        },
      ],
    };

    const table: LocalizationTable = {
      locales: ['en', 'pl', 'de'],
      defaultLocale: 'en',
      strings: {
        DLG_GREET: { en: 'Halt!', pl: 'Stój!', de: 'Halt!' },
        DLG_CHOICE_BRIBE: { en: 'Bribe', pl: '', de: 'Bestechen' }, // Missing pl!
        DLG_PASS: { en: 'Enter.', pl: 'Wejdź.', de: 'Tritt ein.' },
        DLG_ORPHAN: { en: 'Unused.', pl: 'Nieużyte.', de: 'Unbenutzt.' },
      },
    };

    const brokenReport = validateDialogueGraph(graph, table);
    expect(brokenReport.ok).toBe(false);
    expect(brokenReport.danglingPointers).toHaveLength(1);
    expect(brokenReport.danglingPointers[0]?.targetNodeId).toBe('ghost_node');
    expect(brokenReport.unreachableNodeIds).toEqual(['secret_orphan']);
    expect(
      brokenReport.missingTranslations.some(
        (m) => m.key === 'DLG_CHOICE_BRIBE' && m.locale === 'pl',
      ),
    ).toBe(true);

    const fixedGraph: DialogueGraph = {
      ...graph,
      nodes: graph.nodes
        .slice(0, 2)
        .map((n) => (n.id === 'greet' ? { ...n, nextNodeId: null } : n)),
    };
    const fixedTable: LocalizationTable = {
      ...table,
      strings: {
        ...table.strings,
        DLG_CHOICE_BRIBE: { en: 'Bribe', pl: 'Przekup', de: 'Bestechen' },
      },
    };

    const cleanReport = validateDialogueGraph(fixedGraph, fixedTable);
    expect(cleanReport.ok).toBe(true);
    expect(cleanReport.errors).toEqual([]);
  });

  it('flags missing Polish diacritics and non-BMP glyphs against ASCII-only M24 charset, then passes once added', () => {
    const shieldChar = String.fromCodePoint(0x1f6e1);
    const table: LocalizationTable = {
      locales: ['en', 'pl', 'de'],
      defaultLocale: 'en',
      strings: {
        DLG_GUARD_GREET_01: {
          en: 'Halt, traveler!\nShow badge.',
          pl: 'Stój, wędrowcze! Złóż broń.',
          de: 'Halt, Reisender!',
        },
        DLG_SURROGATE_TAG: {
          en: `Key ${shieldChar}`,
          pl: `Klucz ${shieldChar}`,
          de: `Schlüssel ${shieldChar}`,
        },
      },
    };

    const asciiSet = buildCharsetCodepointSet(CHARSET_PRESETS['ascii-basic']);
    const audit1 = auditFontGlyphCoverage(table, asciiSet);

    expect(audit1.ok).toBe(false);
    expect(audit1.missingByLocale['pl']).toEqual(expect.arrayContaining(['ó', 'ę', 'ł', 'ż', 'ń']));
    // Whitespace / newlines must never be flagged as missing glyphs
    expect(audit1.missingChars).not.toContain(' ');
    expect(audit1.missingChars).not.toContain('\n');
    // Codepoint iteration preserves full astral symbols (U+1F6E1) rather than split UTF-16 surrogates
    expect(audit1.missingChars).toContain(shieldChar);
    expect(audit1.missingCodepoints).toContain(0x1f6e1);

    const expandedSet = buildCharsetCodepointSet(
      `${CHARSET_PRESETS['ascii-basic']}${audit1.missingChars.join('')}`,
    );
    const audit2 = auditFontGlyphCoverage(table, expandedSet);
    expect(audit2.ok).toBe(true);
    expect(audit2.findings).toEqual([]);
  });

  it('flags long German button strings exceeding a 100px M33 constraint and passes when concise', () => {
    const table: LocalizationTable = {
      locales: ['en', 'pl', 'de'],
      defaultLocale: 'en',
      strings: {
        BTN_ACCEPT: {
          en: 'Accept',
          pl: 'Akceptuj',
          de: 'Geschwindigkeitsbegrenzung',
        },
      },
    };

    const constraints = new Map<string, UiBoxConstraint>([
      ['BTN_ACCEPT', { maxWidthPx: 100, maxLines: 1, lineHeightPx: 18 }],
    ]);
    const metrics = {
      defaultAdvancePx: 10,
      lineHeightPx: 18,
    };

    const overflowReport = auditUiTextOverflow(table, metrics, constraints);
    expect(overflowReport.ok).toBe(false);
    expect(overflowReport.findings).toHaveLength(1);
    expect(overflowReport.findings[0]).toMatchObject({
      key: 'BTN_ACCEPT',
      locale: 'de',
      maxWidthPx: 100,
      maxLines: 1,
      reason: 'width-exceeded',
    });
    expect(overflowReport.findings[0]!.measuredWidthPx).toBeGreaterThan(100);

    const trimmedTable: LocalizationTable = {
      ...table,
      strings: {
        BTN_ACCEPT: {
          en: 'Accept',
          pl: 'Zgoda',
          de: 'Annehmen', // 8 chars * 10px = 80px <= 100px
        },
      },
    };
    const passReport = auditUiTextOverflow(trimmedTable, metrics, constraints);
    expect(passReport.ok).toBe(true);
    expect(passReport.findings).toEqual([]);
  });
});
