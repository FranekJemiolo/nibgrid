import { describe, expect, it } from 'vitest';
import {
  assembleGodotDialogueFiles,
  exportDialogueGraphJson,
  exportDialogueRunnerGd,
  exportGodotTranslationCsv,
  parseGodotTranslationCsv,
} from '../../src/export/godotDialogueExporter';
import type { DialogueGraph, LocalizationTable } from '../../src/narrative/dialogueSchemas';

describe('M47B: Godot 4 TranslationServer RFC 4180 CSV & DialogueRunner.gd Exporter', () => {
  it('exports and round-trips RFC 4180 CSV containing commas, double quotes, Polish diacritics, and newlines', () => {
    const table: LocalizationTable = {
      locales: ['en', 'pl', 'de'],
      defaultLocale: 'en',
      strings: {
        DLG_GUARD_GREET_01: {
          en: 'Halt, traveler!\nSay "friend" cleanly.',
          pl: 'Stój, wędrowcze!\nPowiedz "przyjaciel".',
          de: 'Halt, Reisender!\nSag "Freund".',
        },
        DLG_GUARD_CHOICE_BRIBE: {
          en: 'Offer 10 gold',
          pl: 'Zaproponuj 10 złota',
          de: '10 Gold anbieten',
        },
      },
    };

    const csv = exportGodotTranslationCsv(table);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('keys,en,pl,de');
    expect(csv).toContain('""friend""');
    expect(csv).toContain('""przyjaciel""');

    const roundTripped = parseGodotTranslationCsv(csv);
    expect(roundTripped.locales).toEqual(['en', 'pl', 'de']);
    expect(roundTripped.strings['DLG_GUARD_GREET_01']).toEqual(table.strings['DLG_GUARD_GREET_01']);
    expect(roundTripped.strings['DLG_GUARD_CHOICE_BRIBE']).toEqual(
      table.strings['DLG_GUARD_CHOICE_BRIBE'],
    );
  });

  it('emits valid dialogue_graph.json and typed DialogueRunner.gd using tr(...) with zero placeholder tokens', () => {
    const graph: DialogueGraph = {
      id: 'gate_intro',
      entryNodeId: 'guard_greet',
      nodes: [
        {
          id: 'guard_greet',
          speakerId: 'gate_guard',
          portraitEmotion: 'angry',
          textKey: 'DLG_GUARD_GREET_01',
          nextNodeId: null,
          uiBoxPresetId: 'dialogue_box',
          choices: [
            {
              id: 'bribe',
              labelKey: 'DLG_GUARD_CHOICE_BRIBE',
              nextNodeId: null,
              requiredFlags: ['has_coin'],
              setFlags: ['gate_unlocked'],
            },
          ],
        },
      ],
    };

    const jsonStr = exportDialogueGraphJson(graph);
    const parsed = JSON.parse(jsonStr) as {
      id: string;
      entry_node_id: string;
      nodes: Array<{
        speaker_id: string;
        portrait_emotion: string;
        text_key: string;
        choices: Array<{ label_key: string; set_flags: string[] }>;
      }>;
    };
    expect(parsed.id).toBe('gate_intro');
    expect(parsed.entry_node_id).toBe('guard_greet');
    expect(parsed.nodes[0]?.speaker_id).toBe('gate_guard');
    expect(parsed.nodes[0]?.portrait_emotion).toBe('angry');
    expect(parsed.nodes[0]?.choices[0]?.set_flags).toEqual(['gate_unlocked']);

    const gd = exportDialogueRunnerGd();
    expect(gd).toContain('class_name DialogueRunner');
    expect(gd).toContain('tr(String(node.get("text_key", "")))');
    expect(gd).toContain('tr(String(raw_choice.get("label_key", "")))');
    expect(gd).toContain('has_required_flags');
    expect(gd).toContain('grant_flag');
    expect(gd).not.toContain('TODO');
    expect(gd).not.toContain('PLACEHOLDER');
  });

  it('assembles strings.csv, dialogue_graph.json, and DialogueRunner.gd virtual files for M25 res:// sync', () => {
    const table: LocalizationTable = {
      locales: ['en', 'pl', 'de'],
      defaultLocale: 'en',
      strings: {
        DLG_HELLO: { en: 'Hello', pl: 'Cześć', de: 'Hallo' },
      },
    };
    const graph: DialogueGraph = {
      id: 'intro',
      entryNodeId: 'hello',
      nodes: [
        {
          id: 'hello',
          speakerId: 'npc',
          portraitEmotion: 'happy',
          textKey: 'DLG_HELLO',
          nextNodeId: null,
          choices: [],
        },
      ],
    };

    const files = assembleGodotDialogueFiles(graph, table);
    expect(files.map((f) => f.relativePath)).toEqual([
      'localization/strings.csv',
      'narrative/dialogue_graph.json',
      'narrative/DialogueRunner.gd',
    ]);
    for (const f of files) {
      expect(
        f.content instanceof Uint8Array ? f.content.byteLength : f.content.length,
      ).toBeGreaterThan(20);
    }
  });
});
