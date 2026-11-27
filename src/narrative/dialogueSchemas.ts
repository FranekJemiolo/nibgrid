import { z } from 'zod';
import { CHARSET_PRESETS } from '../processing/pixelGlyphTable';

export const PortraitEmotionSchema = z.enum(['neutral', 'happy', 'angry', 'surprised', 'sad']);
export type PortraitEmotion = z.infer<typeof PortraitEmotionSchema>;

export const DialogueChoiceSchema = z.object({
  id: z.string().trim().min(1).max(64),
  labelKey: z.string().trim().min(1).max(128),
  nextNodeId: z.string().trim().min(1).max(64).nullable().default(null),
  requiredFlags: z.array(z.string().trim().min(1).max(64)).default([]),
  setFlags: z.array(z.string().trim().min(1).max(64)).default([]),
});
export type DialogueChoice = z.infer<typeof DialogueChoiceSchema>;

export const DialogueNodeSchema = z.object({
  id: z.string().trim().min(1).max(64),
  speakerId: z.string().trim().min(1).max(64),
  portraitEmotion: PortraitEmotionSchema.default('neutral'),
  textKey: z.string().trim().min(1).max(128),
  nextNodeId: z.string().trim().min(1).max(64).nullable().optional(),
  choices: z.array(DialogueChoiceSchema).default([]),
  uiBoxPresetId: z.string().trim().min(1).max(64).optional(),
});
export type DialogueNode = z.infer<typeof DialogueNodeSchema>;

export const DialogueGraphSchema = z.object({
  id: z.string().trim().min(1).max(64),
  entryNodeId: z.string().trim().min(1).max(64),
  nodes: z.array(DialogueNodeSchema).default([]),
});
export type DialogueGraph = z.infer<typeof DialogueGraphSchema>;

export const LocalizationTableSchema = z.object({
  locales: z.array(z.string().trim().min(1).max(16)).min(1),
  defaultLocale: z.string().trim().min(1).max(16),
  strings: z.record(z.string(), z.record(z.string(), z.string())).default({}),
});
export type LocalizationTable = z.infer<typeof LocalizationTableSchema>;

export const ProjectNarrativeBundleSchema = z.object({
  projectId: z.string().min(1),
  version: z.literal(1).default(1),
  graph: DialogueGraphSchema,
  localization: LocalizationTableSchema,
  fontCharset: z.string().min(1).max(2048),
  updatedAt: z.string().min(1),
});
export type ProjectNarrativeBundle = z.infer<typeof ProjectNarrativeBundleSchema>;

export interface DialogueBoxPreset {
  readonly id: string;
  readonly label: string;
  readonly maxWidthPx: number;
  readonly maxLines: number;
  readonly lineHeightPx: number;
}

export const UI_BOX_PRESETS: Readonly<Record<string, DialogueBoxPreset>> = {
  dialogue_box: {
    id: 'dialogue_box',
    label: 'M33 Dialogue Panel (280x54)',
    maxWidthPx: 280,
    maxLines: 3,
    lineHeightPx: 18,
  },
  choice_button: {
    id: 'choice_button',
    label: 'M33 Choice Button (120px)',
    maxWidthPx: 120,
    maxLines: 1,
    lineHeightPx: 18,
  },
  compact_button: {
    id: 'compact_button',
    label: 'M33 Compact Button (100px)',
    maxWidthPx: 100,
    maxLines: 1,
    lineHeightPx: 18,
  },
};

export interface DanglingPointerIssue {
  readonly sourceNodeId: string;
  readonly choiceId?: string;
  readonly targetNodeId: string;
}

export interface MissingTranslationIssue {
  readonly key: string;
  readonly locale: string;
  readonly referencedByNodeId: string;
}

export interface DialogueValidationReport {
  readonly ok: boolean;
  readonly missingEntryNode: boolean;
  readonly duplicateNodeIds: readonly string[];
  readonly danglingPointers: readonly DanglingPointerIssue[];
  readonly unreachableNodeIds: readonly string[];
  readonly missingTranslations: readonly MissingTranslationIssue[];
  readonly errors: readonly string[];
}

export function sanitizeDialogueId(raw: string, fallback = 'node_1'): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 64) : fallback;
}

export function sanitizeDialogueKey(raw: string, fallback = 'DLG_LINE_01'): string {
  const cleaned = raw
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 128) : fallback;
}

/**
 * Creates a starter 2-node dialogue + 3-locale translation bundle with ASCII-safe initial strings
 * so glyph coverage passes out of the box until non-ASCII localization lines are authored.
 */
export function createDefaultProjectNarrative(projectId: string): ProjectNarrativeBundle {
  return ProjectNarrativeBundleSchema.parse({
    projectId,
    version: 1,
    graph: {
      id: 'main_story',
      entryNodeId: 'guard_greet',
      nodes: [
        {
          id: 'guard_greet',
          speakerId: 'gate_guard',
          portraitEmotion: 'neutral',
          textKey: 'DLG_GUARD_GREET_01',
          nextNodeId: null,
          uiBoxPresetId: 'dialogue_box',
          choices: [
            {
              id: 'bribe',
              labelKey: 'DLG_GUARD_CHOICE_BRIBE',
              nextNodeId: 'guard_pass',
              requiredFlags: [],
              setFlags: ['gate_unlocked'],
            },
            {
              id: 'leave',
              labelKey: 'DLG_GUARD_CHOICE_LEAVE',
              nextNodeId: null,
              requiredFlags: [],
              setFlags: [],
            },
          ],
        },
        {
          id: 'guard_pass',
          speakerId: 'gate_guard',
          portraitEmotion: 'happy',
          textKey: 'DLG_GUARD_PASS_01',
          nextNodeId: null,
          uiBoxPresetId: 'dialogue_box',
          choices: [],
        },
      ],
    },
    localization: {
      locales: ['en', 'pl', 'de'],
      defaultLocale: 'en',
      strings: {
        DLG_GUARD_GREET_01: {
          en: 'Halt, traveler!',
          pl: 'Stac, wedrowcze!',
          de: 'Halt, Reisender!',
        },
        DLG_GUARD_CHOICE_BRIBE: {
          en: 'Offer 10 gold',
          pl: 'Daj 10 zlota',
          de: '10 Gold geben',
        },
        DLG_GUARD_CHOICE_LEAVE: {
          en: 'Step back',
          pl: 'Cofnij sie',
          de: 'Zuruck',
        },
        DLG_GUARD_PASS_01: {
          en: 'You may pass the gate.',
          pl: 'Mozesz przejsc brame.',
          de: 'Du darfst passieren.',
        },
      },
    },
    fontCharset: CHARSET_PRESETS['ascii-basic'],
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Pure integrity validator for branching dialogue graphs and localization tables.
 * Checks entry node existence, duplicate IDs, dangling nextNodeId edges, unreachable nodes via BFS,
 * and missing non-empty translations across every declared locale.
 */
export function validateDialogueGraph(
  graph: DialogueGraph,
  table: LocalizationTable,
): DialogueValidationReport {
  const errors: string[] = [];
  const nodeById = new Map<string, DialogueNode>();
  const duplicateNodeIds: string[] = [];

  for (const node of graph.nodes) {
    if (nodeById.has(node.id)) {
      if (!duplicateNodeIds.includes(node.id)) {
        duplicateNodeIds.push(node.id);
        errors.push(`Duplicate dialogue node ID "${node.id}".`);
      }
      continue;
    }
    nodeById.set(node.id, node);
  }

  const missingEntryNode = !nodeById.has(graph.entryNodeId);
  if (missingEntryNode) {
    errors.push(`Missing entry node "${graph.entryNodeId}".`);
  }

  if (!table.locales.includes(table.defaultLocale)) {
    errors.push(
      `Default locale "${table.defaultLocale}" is not listed in declared locales [${table.locales.join(', ')}].`,
    );
  }

  const danglingPointers: DanglingPointerIssue[] = [];
  const missingTranslations: MissingTranslationIssue[] = [];
  const checkedKeyLocale = new Set<string>();

  const checkKey = (key: string, nodeId: string): void => {
    const entry = table.strings[key];
    for (const locale of table.locales) {
      const marker = `${key}\0${locale}`;
      if (checkedKeyLocale.has(marker)) continue;
      checkedKeyLocale.add(marker);
      const val = entry?.[locale];
      if (typeof val !== 'string' || val.trim().length === 0) {
        missingTranslations.push({ key, locale, referencedByNodeId: nodeId });
        errors.push(`Missing "${locale}" translation for key "${key}" (node "${nodeId}").`);
      }
    }
  };

  for (const node of graph.nodes) {
    checkKey(node.textKey, node.id);

    if (node.nextNodeId && !nodeById.has(node.nextNodeId)) {
      danglingPointers.push({ sourceNodeId: node.id, targetNodeId: node.nextNodeId });
      errors.push(`Node "${node.id}" references dangling nextNodeId "${node.nextNodeId}".`);
    }

    for (const choice of node.choices) {
      checkKey(choice.labelKey, node.id);
      if (choice.nextNodeId && !nodeById.has(choice.nextNodeId)) {
        danglingPointers.push({
          sourceNodeId: node.id,
          choiceId: choice.id,
          targetNodeId: choice.nextNodeId,
        });
        errors.push(
          `Choice "${node.id}.${choice.id}" references dangling nextNodeId "${choice.nextNodeId}".`,
        );
      }
    }
  }

  const reachable = new Set<string>();
  const queue: string[] = [];
  if (!missingEntryNode) {
    reachable.add(graph.entryNodeId);
    queue.push(graph.entryNodeId);
  }

  let head = 0;
  while (head < queue.length) {
    const currId = queue[head++];
    if (!currId) continue;
    const node = nodeById.get(currId);
    if (!node) continue;

    if (node.nextNodeId && nodeById.has(node.nextNodeId) && !reachable.has(node.nextNodeId)) {
      reachable.add(node.nextNodeId);
      queue.push(node.nextNodeId);
    }
    for (const choice of node.choices) {
      if (
        choice.nextNodeId &&
        nodeById.has(choice.nextNodeId) &&
        !reachable.has(choice.nextNodeId)
      ) {
        reachable.add(choice.nextNodeId);
        queue.push(choice.nextNodeId);
      }
    }
  }

  const unreachableNodeIds: string[] = [];
  for (const node of graph.nodes) {
    if (!reachable.has(node.id) && !unreachableNodeIds.includes(node.id)) {
      unreachableNodeIds.push(node.id);
      errors.push(`Dialogue node "${node.id}" is unreachable from entry "${graph.entryNodeId}".`);
    }
  }

  return {
    ok: errors.length === 0,
    missingEntryNode,
    duplicateNodeIds,
    danglingPointers,
    unreachableNodeIds,
    missingTranslations,
    errors,
  };
}
