import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FolderSync,
  GitBranch,
  Languages,
  Plus,
  Sparkles,
  Trash2,
  Upload,
} from 'lucide-react';
import { db } from '../../db/database';
import { bakeBitmapFontFromConfig } from '../../export/godotThemeExporter';
import {
  exportGodotTranslationCsv,
  parseGodotTranslationCsv,
} from '../../export/godotDialogueExporter';
import { triggerBlobDownload } from '../../export/zipPackager';
import {
  UI_BOX_PRESETS,
  createDefaultProjectNarrative,
  sanitizeDialogueId,
  sanitizeDialogueKey,
  validateDialogueGraph,
  type DialogueChoice,
  type DialogueNode,
  type PortraitEmotion,
  type ProjectNarrativeBundle,
} from '../../narrative/dialogueSchemas';
import {
  auditFontGlyphCoverage,
  auditUiTextOverflow,
  buildCharsetCodepointSet,
  buildConstraintsFromDialogueGraph,
  buildM24MetricsFromBakedFont,
  measureWrappedTextPx,
  type M24GlyphMetricsInput,
} from '../../narrative/localizationAuditor';
import { CHARSET_PRESETS } from '../../processing/pixelGlyphTable';
import { useAppStore } from '../../store/useAppStore';
import {
  bindGodotDirectory,
  collectProjectGodotSyncFiles,
  syncFilesToGodotDirectory,
} from '../../sync/fsaaSyncEngine';

const EMOTIONS: readonly PortraitEmotion[] = ['neutral', 'happy', 'angry', 'surprised', 'sad'];

function resolveNodeFontCharset(config: {
  charsetPreset: 'damage-numerals' | 'hud-upper' | 'ascii-basic' | 'custom';
  customCharset: string;
}): string {
  if (config.charsetPreset === 'damage-numerals') return CHARSET_PRESETS['damage-numerals'];
  if (config.charsetPreset === 'hud-upper') return CHARSET_PRESETS['hud-upper'];
  if (config.charsetPreset === 'ascii-basic') return CHARSET_PRESETS['ascii-basic'];
  return config.customCharset || CHARSET_PRESETS['ascii-basic'];
}

/**
 * Milestone 47C Interactive Branching Dialogue & Localization Studio with live M24 Glyph-Coverage,
 * M33 Text-Overflow Audits, Godot 4 TranslationServer CSV Export/Import, and M25 res:// Sync.
 */
export function DialogueLocalizationPanel() {
  const {
    activeProject,
    entities,
    spriteNodes,
    audioAssets,
    rooms,
    narrativeBundle,
    syncTarget,
    saveNarrativeBundleRecord,
    appendNarrativeFontGlyphs,
    refreshSyncTarget,
  } = useAppStore();

  const activeBundle = useMemo(
    () =>
      narrativeBundle ?? (activeProject ? createDefaultProjectNarrative(activeProject.id) : null),
    [narrativeBundle, activeProject],
  );

  const [selectedNodeId, setSelectedNodeId] = useState(() => activeBundle?.graph.entryNodeId ?? '');
  const [previewLocale, setPreviewLocale] = useState(
    () => activeBundle?.localization.defaultLocale ?? 'en',
  );
  const [missingOnly, setMissingOnly] = useState(false);
  const [newLocaleInput, setNewLocaleInput] = useState('');
  const [highlightedCellKey, setHighlightedCellKey] = useState<string | null>(null);

  const [newNodeId, setNewNodeId] = useState('');
  const [newNodeSpeaker, setNewNodeSpeaker] = useState('gate_guard');
  const [newNodeEmotion, setNewNodeEmotion] = useState<PortraitEmotion>('angry');
  const [newNodeTextKey, setNewNodeTextKey] = useState('');
  const [newNodeEnText, setNewNodeEnText] = useState('');
  const [newNodePlText, setNewNodePlText] = useState('');
  const [newNodeDeText, setNewNodeDeText] = useState('');
  const [newNodeBoxPresetId, setNewNodeBoxPresetId] = useState('dialogue_box');

  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);

  const csvInputRef = useRef<HTMLInputElement | null>(null);
  const cellRefs = useRef<Record<string, HTMLInputElement | null>>({});

  useEffect(() => {
    if (!activeBundle) return;
    if (!selectedNodeId || !activeBundle.graph.nodes.some((n) => n.id === selectedNodeId)) {
      setSelectedNodeId(activeBundle.graph.entryNodeId || activeBundle.graph.nodes[0]?.id || '');
    }
    if (!activeBundle.localization.locales.includes(previewLocale)) {
      setPreviewLocale(activeBundle.localization.defaultLocale);
    }
  }, [activeBundle, selectedNodeId, previewLocale]);

  const effectiveFontCharset = useMemo(() => {
    const base = activeBundle?.fontCharset ?? CHARSET_PRESETS['ascii-basic'];
    const merged = new Set(Array.from(base));
    for (const node of spriteNodes) {
      if (!node.bitmapFont) continue;
      for (const ch of resolveNodeFontCharset(node.bitmapFont)) {
        merged.add(ch);
      }
    }
    return Array.from(merged).join('');
  }, [activeBundle, spriteNodes]);

  const m24Metrics = useMemo<M24GlyphMetricsInput>(() => {
    if (!activeProject) {
      return { defaultAdvancePx: 10, lineHeightPx: 18 };
    }
    const fontNode = spriteNodes.find((n) => Boolean(n.bitmapFont));
    if (fontNode?.bitmapFont) {
      const baked = bakeBitmapFontFromConfig(fontNode.bitmapFont, activeProject.artBible.palette);
      return buildM24MetricsFromBakedFont(baked);
    }
    return { defaultAdvancePx: 10, lineHeightPx: 18 };
  }, [activeProject, spriteNodes]);

  const validation = useMemo(
    () =>
      activeBundle
        ? validateDialogueGraph(activeBundle.graph, activeBundle.localization)
        : {
            ok: false,
            missingEntryNode: true,
            duplicateNodeIds: [],
            danglingPointers: [],
            unreachableNodeIds: [],
            missingTranslations: [],
            errors: ['Open a project to author branching dialogue.'],
          },
    [activeBundle],
  );

  const glyphAudit = useMemo(() => {
    if (!activeBundle) {
      return {
        ok: true,
        missingByLocale: {},
        missingCodepoints: [],
        missingChars: [],
        findings: [],
      };
    }
    return auditFontGlyphCoverage(
      activeBundle.localization,
      buildCharsetCodepointSet(effectiveFontCharset),
    );
  }, [activeBundle, effectiveFontCharset]);

  const constraintsByKey = useMemo(
    () => (activeBundle ? buildConstraintsFromDialogueGraph(activeBundle.graph) : new Map()),
    [activeBundle],
  );

  const overflowAudit = useMemo(() => {
    if (!activeBundle) {
      return { ok: true, findings: [] };
    }
    return auditUiTextOverflow(activeBundle.localization, m24Metrics, constraintsByKey);
  }, [activeBundle, m24Metrics, constraintsByKey]);

  const selectedNode = useMemo(
    () =>
      activeBundle?.graph.nodes.find((n) => n.id === selectedNodeId) ??
      activeBundle?.graph.nodes[0] ??
      null,
    [activeBundle, selectedNodeId],
  );

  const persistBundle = async (next: ProjectNarrativeBundle, message?: string) => {
    setErrorMsg(null);
    try {
      await saveNarrativeBundleRecord(next);
      if (message) setStatusNotice(message);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to save dialogue & localization');
    }
  };

  const handleAddNode = async () => {
    if (!activeBundle || !activeProject) return;
    const nodeId = sanitizeDialogueId(newNodeId, `node_${activeBundle.graph.nodes.length + 1}`);
    if (activeBundle.graph.nodes.some((n) => n.id === nodeId)) {
      setErrorMsg(`Node "${nodeId}" already exists.`);
      return;
    }

    const textKey = sanitizeDialogueKey(newNodeTextKey, `DLG_${nodeId.toUpperCase()}_01`);
    const speakerId = sanitizeDialogueId(newNodeSpeaker, 'npc');

    const newNode: DialogueNode = {
      id: nodeId,
      speakerId,
      portraitEmotion: newNodeEmotion,
      textKey,
      nextNodeId: null,
      choices: [],
      uiBoxPresetId: newNodeBoxPresetId,
    };

    // Connect from currently selected node if it has an open nextNodeId and no choices so graph stays reachable
    const updatedNodes = activeBundle.graph.nodes.map((node) => {
      if (node.id === selectedNode?.id && !node.nextNodeId && node.choices.length === 0) {
        return { ...node, nextNodeId: nodeId };
      }
      if (
        node.id === activeBundle.graph.entryNodeId &&
        node.choices.length > 0 &&
        !activeBundle.graph.nodes.some((n) => n.id === selectedNode?.id)
      ) {
        return node;
      }
      return node;
    });

    // If selected node already has choices, wire a follow-up choice onto selectedNode so the new branch is reachable
    const finalNodes = updatedNodes.map((node) => {
      const targetId = selectedNode?.id ?? activeBundle.graph.entryNodeId;
      if (
        node.id === targetId &&
        node.id !== nodeId &&
        node.nextNodeId !== nodeId &&
        node.choices.length > 0
      ) {
        const choiceId = `to_${nodeId}`;
        const choiceKey = `DLG_CHOICE_${nodeId.toUpperCase()}`;
        const updatedChoices: DialogueChoice[] = [
          ...node.choices,
          {
            id: choiceId,
            labelKey: choiceKey,
            nextNodeId: nodeId,
            requiredFlags: [],
            setFlags: [],
          },
        ];
        return { ...node, choices: updatedChoices };
      }
      return node;
    });

    const targetBranchParent = finalNodes.find(
      (n) =>
        n.id === (selectedNode?.id ?? activeBundle.graph.entryNodeId) &&
        n.choices.some((c) => c.nextNodeId === nodeId),
    );

    const existingRow = activeBundle.localization.strings[textKey] ?? {};
    const nextRow: Record<string, string> = { ...existingRow };
    for (const loc of activeBundle.localization.locales) {
      if (loc === 'en') {
        nextRow['en'] = newNodeEnText || existingRow['en'] || 'Stay alert!';
      } else if (loc === 'pl') {
        nextRow['pl'] = newNodePlText || existingRow['pl'] || 'Uwazaj!';
      } else if (loc === 'de') {
        nextRow['de'] = newNodeDeText || existingRow['de'] || 'Sei wachsam!';
      } else {
        nextRow[loc] = existingRow[loc] ?? (newNodeEnText || 'Stay alert!');
      }
    }

    const nextStrings: Record<string, Record<string, string>> = {
      ...activeBundle.localization.strings,
      [textKey]: nextRow,
    };

    if (targetBranchParent) {
      const addedChoice = targetBranchParent.choices.find((c) => c.nextNodeId === nodeId);
      if (addedChoice && !nextStrings[addedChoice.labelKey]) {
        const choiceRow: Record<string, string> = {};
        for (const loc of activeBundle.localization.locales) {
          choiceRow[loc] = loc === 'pl' ? 'Dalej' : loc === 'de' ? 'Weiter' : 'Continue';
        }
        nextStrings[addedChoice.labelKey] = choiceRow;
      }
    }

    const nextBundle: ProjectNarrativeBundle = {
      ...activeBundle,
      graph: {
        ...activeBundle.graph,
        nodes: [...finalNodes, newNode],
      },
      localization: {
        ...activeBundle.localization,
        strings: nextStrings,
      },
      updatedAt: new Date().toISOString(),
    };

    await persistBundle(nextBundle, `Added branching node "${nodeId}" (${textKey}).`);
    setSelectedNodeId(nodeId);
    setNewNodeId('');
    setNewNodeTextKey('');
    setNewNodeEnText('');
    setNewNodePlText('');
    setNewNodeDeText('');
  };

  const handleUpdateSelectedNode = async (patch: Partial<DialogueNode>) => {
    if (!activeBundle || !selectedNode) return;
    const nextBundle: ProjectNarrativeBundle = {
      ...activeBundle,
      graph: {
        ...activeBundle.graph,
        nodes: activeBundle.graph.nodes.map((n) =>
          n.id === selectedNode.id ? { ...n, ...patch } : n,
        ),
      },
      updatedAt: new Date().toISOString(),
    };
    await persistBundle(nextBundle);
  };

  const handleDeleteNode = async (nodeId: string) => {
    if (!activeBundle || activeBundle.graph.nodes.length <= 1) return;
    const remaining = activeBundle.graph.nodes
      .filter((n) => n.id !== nodeId)
      .map((n) => ({
        ...n,
        nextNodeId: n.nextNodeId === nodeId ? null : n.nextNodeId,
        choices: n.choices.map((c) => (c.nextNodeId === nodeId ? { ...c, nextNodeId: null } : c)),
      }));
    const nextEntry =
      activeBundle.graph.entryNodeId === nodeId
        ? (remaining[0]?.id ?? '')
        : activeBundle.graph.entryNodeId;

    await persistBundle(
      {
        ...activeBundle,
        graph: { ...activeBundle.graph, entryNodeId: nextEntry, nodes: remaining },
        updatedAt: new Date().toISOString(),
      },
      `Removed node "${nodeId}".`,
    );
  };

  const handleUpdateCell = async (key: string, locale: string, value: string) => {
    if (!activeBundle) return;
    const prevRow = activeBundle.localization.strings[key] ?? {};
    const nextBundle: ProjectNarrativeBundle = {
      ...activeBundle,
      localization: {
        ...activeBundle.localization,
        strings: {
          ...activeBundle.localization.strings,
          [key]: { ...prevRow, [locale]: value },
        },
      },
      updatedAt: new Date().toISOString(),
    };
    await persistBundle(nextBundle);
  };

  const handleAddLocale = async () => {
    if (!activeBundle) return;
    const clean = newLocaleInput
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '');
    if (!clean) return;
    if (activeBundle.localization.locales.includes(clean)) {
      setErrorMsg(`Locale "${clean}" already exists.`);
      return;
    }
    const nextStrings: Record<string, Record<string, string>> = {};
    for (const [k, row] of Object.entries(activeBundle.localization.strings)) {
      nextStrings[k] = { ...row, [clean]: row[clean] ?? '' };
    }
    await persistBundle(
      {
        ...activeBundle,
        localization: {
          ...activeBundle.localization,
          locales: [...activeBundle.localization.locales, clean],
          strings: nextStrings,
        },
        updatedAt: new Date().toISOString(),
      },
      `Added locale "${clean}".`,
    );
    setNewLocaleInput('');
  };

  const handleAddMissingGlyphs = async () => {
    if (!activeBundle || !activeProject || glyphAudit.missingChars.length === 0) return;
    setErrorMsg(null);
    try {
      // Ensure current graph & localization edits exist in Dexie before updating charset atomically
      await saveNarrativeBundleRecord(activeBundle);
      const count = glyphAudit.missingChars.length;
      await appendNarrativeFontGlyphs(activeProject.id, glyphAudit.missingChars);
      setStatusNotice(`Added ${count} missing glyph(s) to M24 Bitmap Font charset.`);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to append missing glyphs');
    }
  };

  const handleImportCsv = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !activeBundle) return;
    try {
      const text = await file.text();
      const parsed = parseGodotTranslationCsv(text);
      const mergedLocales = Array.from(
        new Set([...activeBundle.localization.locales, ...parsed.locales]),
      );
      const mergedStrings: Record<string, Record<string, string>> = {
        ...activeBundle.localization.strings,
      };
      for (const [k, row] of Object.entries(parsed.strings)) {
        mergedStrings[k] = { ...(mergedStrings[k] ?? {}), ...row };
      }
      await persistBundle(
        {
          ...activeBundle,
          localization: {
            locales: mergedLocales,
            defaultLocale: activeBundle.localization.defaultLocale,
            strings: mergedStrings,
          },
          updatedAt: new Date().toISOString(),
        },
        `Imported ${Object.keys(parsed.strings).length} localization keys from CSV.`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'CSV import failed');
    }
  };

  const handleSyncToGodot = async () => {
    if (!activeProject || !activeBundle) return;
    setIsSyncing(true);
    setErrorMsg(null);
    try {
      await saveNarrativeBundleRecord(activeBundle);
      if (!syncTarget?.directoryHandle) {
        await bindGodotDirectory(db, activeProject.id);
      }
      const files = await collectProjectGodotSyncFiles(
        db,
        activeProject,
        entities,
        spriteNodes,
        audioAssets,
        rooms,
      );
      const summary = await syncFilesToGodotDirectory(db, activeProject.id, files);
      await refreshSyncTarget(activeProject.id);
      setStatusNotice(
        `Synced Dialogue & L10n to res:// (${summary.writtenCount} written, ${summary.plan.unchangedPaths.length} unchanged).`,
      );
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : 'Failed to sync Dialogue & L10n to Godot');
    } finally {
      setIsSyncing(false);
    }
  };

  if (!activeProject || !activeBundle) {
    return (
      <div className="p-6 text-sm text-slate-400" data-testid="dialogue-l10n-panel">
        Open a project to author branching dialogue and localization tables.
      </div>
    );
  }

  const allStringKeys = Object.keys(activeBundle.localization.strings).sort();
  const visibleKeys = missingOnly
    ? allStringKeys.filter((key) =>
        activeBundle.localization.locales.some(
          (loc) => !(activeBundle.localization.strings[key]?.[loc] ?? '').trim(),
        ),
      )
    : allStringKeys;

  const previewText = selectedNode
    ? (activeBundle.localization.strings[selectedNode.textKey]?.[previewLocale] ?? '')
    : '';
  const previewBoxPreset =
    (selectedNode?.uiBoxPresetId ? UI_BOX_PRESETS[selectedNode.uiBoxPresetId] : undefined) ??
    UI_BOX_PRESETS['dialogue_box']!;
  const previewWrap = measureWrappedTextPx(previewText, m24Metrics, previewBoxPreset.maxWidthPx);

  return (
    <div
      className="flex flex-1 flex-col gap-4 p-4 text-slate-100"
      data-testid="dialogue-l10n-panel"
    >
      {/* Top Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-sm font-semibold text-white">
            <Languages className="h-4 w-4 text-indigo-400" />
            Dialogue &amp; Localization Studio
          </div>
          <span
            data-testid="dialogue-validation-status"
            className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-semibold ${
              validation.ok
                ? 'bg-emerald-500/15 text-emerald-300'
                : 'bg-amber-500/15 text-amber-300'
            }`}
          >
            {validation.ok ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <AlertTriangle className="h-3 w-3" />
            )}
            {validation.ok ? 'Valid Dialogue Graph' : `${validation.errors.length} Graph Issue(s)`}
          </span>
          {syncTarget && (
            <span className="text-[11px] text-slate-400">
              Target: <code className="text-slate-200">{syncTarget.folderName}</code>
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-slate-300">
            Preview:
            <select
              data-testid="dialogue-preview-locale"
              value={previewLocale}
              onChange={(e) => setPreviewLocale(e.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"
            >
              {activeBundle.localization.locales.map((loc) => (
                <option key={loc} value={loc}>
                  {loc}
                </option>
              ))}
            </select>
          </label>

          <button
            type="button"
            data-testid="dialogue-export-csv-btn"
            onClick={() => {
              const csv = exportGodotTranslationCsv(activeBundle.localization);
              triggerBlobDownload(
                new Blob([csv], { type: 'text/csv;charset=utf-8' }),
                'strings.csv',
              );
              setStatusNotice('Exported RFC 4180 Godot TranslationServer strings.csv.');
            }}
            className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500"
          >
            <Download className="h-3.5 w-3.5" />
            Export strings.csv
          </button>

          <button
            type="button"
            onClick={() => csvInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs font-medium text-slate-200 hover:border-slate-500"
          >
            <Upload className="h-3.5 w-3.5" />
            Import CSV
          </button>
          <input
            ref={csvInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => void handleImportCsv(e)}
            className="hidden"
          />

          <button
            type="button"
            data-testid="dialogue-sync-godot-btn"
            disabled={isSyncing}
            onClick={() => void handleSyncToGodot()}
            className="inline-flex items-center gap-1.5 rounded bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            <FolderSync className="h-3.5 w-3.5" />
            {isSyncing ? 'Syncing...' : 'Sync CSV & Runner to Godot res://'}
          </button>
        </div>
      </div>

      {statusNotice && (
        <div
          data-testid="dialogue-status-notice"
          className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
        >
          {statusNotice}
        </div>
      )}
      {errorMsg && (
        <div className="rounded border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
          {errorMsg}
        </div>
      )}

      {/* Main Split Workspace */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
        {/* Left: Branching Dialogue Graph Editor */}
        <section className="flex flex-col gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 xl:col-span-5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-xs font-semibold tracking-wider text-slate-300 uppercase">
              <GitBranch className="h-3.5 w-3.5 text-indigo-400" />
              Branching Dialogue Graph ({activeBundle.graph.nodes.length} nodes)
            </h2>
            <span className="text-[11px] text-slate-400">
              Entry: <code className="text-indigo-300">{activeBundle.graph.entryNodeId}</code>
            </span>
          </div>

          <div className="flex max-h-44 flex-col gap-1.5 overflow-y-auto pr-1">
            {activeBundle.graph.nodes.map((node) => {
              const selected = node.id === selectedNode?.id;
              return (
                <div
                  key={node.id}
                  data-testid={`dialogue-node-card-${node.id}`}
                  className={`flex items-center justify-between rounded border px-2.5 py-2 text-xs ${
                    selected
                      ? 'border-indigo-400 bg-indigo-500/15 text-white'
                      : 'border-slate-800 bg-slate-900/70 text-slate-300'
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedNodeId(node.id)}
                    className="flex flex-1 flex-col text-left"
                  >
                    <span className="font-mono font-semibold">
                      {node.id} <span className="text-slate-400">({node.speakerId})</span>
                    </span>
                    <span className="text-[11px] text-slate-400">
                      {node.textKey} • {node.portraitEmotion} • {node.choices.length} choices
                    </span>
                  </button>
                  {activeBundle.graph.nodes.length > 1 && (
                    <button
                      type="button"
                      onClick={() => void handleDeleteNode(node.id)}
                      className="rounded p-1 text-slate-500 hover:bg-rose-500/20 hover:text-rose-300"
                      title={`Delete ${node.id}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          {/* Selected Node Inspector & Live Dialogue Box Preview */}
          {selectedNode && (
            <div className="flex flex-col gap-2 rounded border border-slate-800 bg-slate-900/60 p-2.5 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-slate-400 uppercase">Speaker ID</span>
                  <input
                    value={selectedNode.speakerId}
                    onChange={(e) => void handleUpdateSelectedNode({ speakerId: e.target.value })}
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-[10px] text-slate-400 uppercase">Portrait Emotion</span>
                  <select
                    value={selectedNode.portraitEmotion}
                    onChange={(e) =>
                      void handleUpdateSelectedNode({
                        portraitEmotion: e.target.value as PortraitEmotion,
                      })
                    }
                    className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
                  >
                    {EMOTIONS.map((emo) => (
                      <option key={emo} value={emo}>
                        {emo}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div
                data-testid="dialogue-live-preview"
                className="rounded border border-indigo-500/30 bg-slate-950 p-2.5"
              >
                <div className="mb-1 flex items-center justify-between text-[10px] text-indigo-300 uppercase">
                  <span>
                    Preview [{previewLocale}]: {selectedNode.speakerId} (
                    {selectedNode.portraitEmotion})
                  </span>
                  <span>
                    {previewWrap.maxLineWidthPx}px / {previewBoxPreset.maxWidthPx}px •{' '}
                    {previewWrap.lines.length}/{previewBoxPreset.maxLines} lines
                  </span>
                </div>
                <p className="min-h-8 font-mono text-xs whitespace-pre-wrap text-slate-100">
                  {previewText || `[missing ${selectedNode.textKey}]`}
                </p>
                {selectedNode.choices.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {selectedNode.choices.map((choice) => (
                      <button
                        key={choice.id}
                        type="button"
                        onClick={() => {
                          if (choice.nextNodeId) setSelectedNodeId(choice.nextNodeId);
                        }}
                        className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-[11px] text-slate-200 hover:border-indigo-400"
                      >
                        {activeBundle.localization.strings[choice.labelKey]?.[previewLocale] ||
                          choice.labelKey}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Add Branching Node Form */}
          <div className="flex flex-col gap-2 rounded border border-slate-800 bg-slate-900/50 p-2.5 text-xs">
            <div className="text-[11px] font-semibold text-slate-300">Add Branching Node</div>
            <div className="grid grid-cols-2 gap-2">
              <input
                data-testid="dialogue-new-node-id"
                placeholder="Node ID (e.g. guard_warn)"
                value={newNodeId}
                onChange={(e) => setNewNodeId(e.target.value)}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
              />
              <input
                data-testid="dialogue-new-node-speaker"
                placeholder="Speaker ID"
                value={newNodeSpeaker}
                onChange={(e) => setNewNodeSpeaker(e.target.value)}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
              />
              <input
                data-testid="dialogue-new-node-text-key"
                placeholder="Key (DLG_GUARD_WARN_01)"
                value={newNodeTextKey}
                onChange={(e) => setNewNodeTextKey(e.target.value)}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 font-mono text-white"
              />
              <div className="flex gap-1.5">
                <select
                  value={newNodeEmotion}
                  onChange={(e) => setNewNodeEmotion(e.target.value as PortraitEmotion)}
                  className="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
                >
                  {EMOTIONS.map((emo) => (
                    <option key={emo} value={emo}>
                      {emo}
                    </option>
                  ))}
                </select>
                <select
                  value={newNodeBoxPresetId}
                  onChange={(e) => setNewNodeBoxPresetId(e.target.value)}
                  className="flex-1 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
                >
                  {Object.values(UI_BOX_PRESETS).map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              <input
                data-testid="dialogue-new-node-en-text"
                placeholder="en text"
                value={newNodeEnText}
                onChange={(e) => setNewNodeEnText(e.target.value)}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
              />
              <input
                data-testid="dialogue-new-node-pl-text"
                placeholder="pl text"
                value={newNodePlText}
                onChange={(e) => setNewNodePlText(e.target.value)}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
              />
              <input
                data-testid="dialogue-new-node-de-text"
                placeholder="de text"
                value={newNodeDeText}
                onChange={(e) => setNewNodeDeText(e.target.value)}
                className="rounded border border-slate-700 bg-slate-950 px-2 py-1 text-white"
              />
            </div>
            <button
              type="button"
              data-testid="dialogue-add-node-btn"
              onClick={() => void handleAddNode()}
              className="inline-flex items-center justify-center gap-1 rounded bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Branching Node &amp; Strings
            </button>
          </div>
        </section>

        {/* Center/Right: Localization Matrix + M24/M33 Live Audit Drawer */}
        <section className="flex flex-col gap-3 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-3 xl:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-xs font-semibold tracking-wider text-slate-300 uppercase">
              Localization Matrix ({visibleKeys.length} keys ×{' '}
              {activeBundle.localization.locales.length} locales)
            </h2>
            <div className="flex items-center gap-2 text-xs">
              <label className="flex items-center gap-1 text-slate-300">
                <input
                  type="checkbox"
                  checked={missingOnly}
                  onChange={(e) => setMissingOnly(e.target.checked)}
                />
                Missing only
              </label>
              <input
                placeholder="Add locale (e.g. fr)"
                value={newLocaleInput}
                onChange={(e) => setNewLocaleInput(e.target.value)}
                className="w-28 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-xs text-white"
              />
              <button
                type="button"
                onClick={() => void handleAddLocale()}
                className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs hover:border-slate-500"
              >
                + Locale
              </button>
            </div>
          </div>

          <div className="max-h-64 overflow-auto rounded border border-slate-800">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="sticky top-0 bg-slate-900 text-[11px] text-slate-400 uppercase">
                <tr>
                  <th className="border-b border-slate-800 px-2 py-1.5">Key</th>
                  {activeBundle.localization.locales.map((loc) => (
                    <th key={loc} className="border-b border-slate-800 px-2 py-1.5">
                      {loc}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visibleKeys.map((key) => {
                  const row = activeBundle.localization.strings[key] ?? {};
                  return (
                    <tr key={key} className="border-b border-slate-800/60">
                      <td className="px-2 py-1 font-mono text-[11px] text-indigo-300">{key}</td>
                      {activeBundle.localization.locales.map((loc) => {
                        const cellId = `${key}:${loc}`;
                        const isFocused = highlightedCellKey === cellId;
                        return (
                          <td key={loc} className="px-1.5 py-1">
                            <input
                              ref={(el) => {
                                cellRefs.current[cellId] = el;
                              }}
                              data-testid={`l10n-cell-${key}-${loc}`}
                              value={row[loc] ?? ''}
                              onChange={(e) => void handleUpdateCell(key, loc, e.target.value)}
                              className={`w-full rounded border bg-slate-950 px-1.5 py-1 text-xs text-slate-100 ${
                                isFocused
                                  ? 'border-amber-400 ring-1 ring-amber-400'
                                  : 'border-slate-800 focus:border-indigo-500'
                              }`}
                            />
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Live M24 Glyph-Coverage & M33 Overflow Audit Drawer */}
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {/* M24 Missing Glyph Audit */}
            <div
              data-testid="audit-glyph-status"
              className={`flex flex-col gap-2 rounded border p-3 text-xs ${
                glyphAudit.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : 'border-amber-500/40 bg-amber-500/10'
              }`}
            >
              <div className="flex items-center justify-between font-semibold">
                <span>M24 Bitmap Font Glyph Audit</span>
                <span>
                  {glyphAudit.ok
                    ? 'All glyphs covered'
                    : `${glyphAudit.missingChars.length} Missing Glyph(s)`}
                </span>
              </div>
              {!glyphAudit.ok ? (
                <>
                  <div className="flex flex-col gap-1 text-[11px] text-amber-200">
                    {Object.entries(glyphAudit.missingByLocale).map(([loc, chars]) => (
                      <div key={loc}>
                        <code>{loc}</code> missing: <code>{chars.join(', ')}</code>
                      </div>
                    ))}
                  </div>
                  <button
                    type="button"
                    data-testid="audit-add-missing-glyphs-btn"
                    onClick={() => void handleAddMissingGlyphs()}
                    className="inline-flex items-center justify-center gap-1.5 rounded bg-amber-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400"
                  >
                    <Sparkles className="h-3.5 w-3.5" />
                    Add Missing Glyphs to M24 Font
                  </button>
                </>
              ) : (
                <div className="text-[11px] text-emerald-200">
                  Zero missing codepoints across {activeBundle.localization.locales.join(', ')} (
                  {buildCharsetCodepointSet(effectiveFontCharset).size} baked glyphs).
                </div>
              )}
            </div>

            {/* M33 UI Text-Overflow Audit */}
            <div
              data-testid="audit-overflow-status"
              className={`flex flex-col gap-2 rounded border p-3 text-xs ${
                overflowAudit.ok
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : 'border-rose-500/40 bg-rose-500/10'
              }`}
            >
              <div className="flex items-center justify-between font-semibold">
                <span>M33 UI Text-Overflow Audit</span>
                <span>
                  {overflowAudit.ok
                    ? 'Zero Overflows'
                    : `${overflowAudit.findings.length} Overflow(s)`}
                </span>
              </div>
              {overflowAudit.ok ? (
                <div className="text-[11px] text-emerald-200">
                  All {constraintsByKey.size} constrained dialogue/choice strings fit within M33
                  9-slice box limits.
                </div>
              ) : (
                <div className="flex max-h-24 flex-col gap-1 overflow-y-auto text-[11px] text-rose-200">
                  {overflowAudit.findings.map((finding) => {
                    const cellId = `${finding.key}:${finding.locale}`;
                    return (
                      <button
                        key={cellId}
                        type="button"
                        onClick={() => {
                          setHighlightedCellKey(cellId);
                          cellRefs.current[cellId]?.focus();
                        }}
                        className="rounded border border-rose-500/30 bg-rose-950/50 px-2 py-1 text-left hover:bg-rose-900/50"
                      >
                        <code>{finding.key}</code> [{finding.locale}]: {finding.measuredWidthPx}px /{' '}
                        {finding.maxWidthPx}px ({finding.lineCount}/{finding.maxLines} lines)
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
