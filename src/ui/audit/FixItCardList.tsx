import { useState } from 'react';
import { CheckCircle2, Sparkles, Wrench } from 'lucide-react';
import { db, repository } from '../../db/database';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../../processing/png';
import { useAppStore } from '../../store/useAppStore';
import { applyOffPaletteFix, applySoftlockTrapFix, type FixItCard } from './fixItEngine';

interface FixItCardListProps {
  readonly cards: readonly FixItCard[];
  readonly onApplied?: (card: FixItCard) => void;
}

/**
 * Renders plain-English 1-click Fix-It Cards executing atomic Dexie fixes with zero orphan blobs.
 */
export function FixItCardList({ cards, onApplied }: FixItCardListProps) {
  const {
    activeProject,
    worldGraph,
    spriteNodes,
    appendNarrativeFontGlyphs,
    saveWorldGraphRecord,
    refreshSpriteNodes,
    narrativeBundle,
    saveNarrativeBundleRecord,
  } = useAppStore();

  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleApply = async (card: FixItCard) => {
    if (!activeProject) return;
    setBusyId(card.id);
    setNotice(null);
    try {
      if (card.kind === 'missing-glyph') {
        if (narrativeBundle) {
          await saveNarrativeBundleRecord(narrativeBundle);
        }
        await appendNarrativeFontGlyphs(activeProject.id, card.missingChars);
        setNotice(`Added ${card.missingChars.length} glyph(s) to M24 Font.`);
      } else if (card.kind === 'softlock-trap' && worldGraph) {
        const fixedGraph = applySoftlockTrapFix(worldGraph, card.trapRoomId);
        await saveWorldGraphRecord(fixedGraph);
        setNotice(`Opened return route from "${card.trapRoomId}".`);
      } else if (card.kind === 'off-palette') {
        const node = spriteNodes.find((n) => n.id === card.spriteId);
        if (node) {
          const blobId = node.processedBlobId ?? node.imageBlobId;
          const rec = await repository.getBlob(blobId);
          if (rec) {
            const decoded = await decodePngBytesToRgba(
              new Uint8Array(await rec.bytes.arrayBuffer()),
            );
            const fixedRgba = applyOffPaletteFix(
              decoded.rgba,
              decoded.width,
              decoded.height,
              activeProject.artBible.palette,
            );
            const pngBytes = encodeRgbaToPngBytes(fixedRgba, decoded.width, decoded.height);
            await db.transaction('rw', [db.blobs, db.spriteNodes, db.projects], async () => {
              const savedBlob = await repository.storeBlobDeduplicated(pngBytes, 'image/png');
              await repository.saveSpriteNode({ ...node, processedBlobId: savedBlob.id });
              await repository.cleanupOrphanedBlobs();
            });
            await refreshSpriteNodes(activeProject.id);
            setNotice(`Snapped "${node.id}" cleanly to ArtBible palette.`);
          }
        }
      }
      onApplied?.(card);
    } finally {
      setBusyId(null);
    }
  };

  if (cards.length === 0) {
    return (
      <div
        data-testid="fixit-card-list"
        className="flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"
      >
        <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
        <span>
          All Fix-It checks pass cleanly — no broken fonts, traps, or palette drifts detected.
        </span>
      </div>
    );
  }

  return (
    <div data-testid="fixit-card-list" className="flex flex-col gap-2">
      {notice && (
        <div
          data-testid="fixit-notice"
          className="rounded border border-emerald-500/30 bg-emerald-500/10 px-3 py-1.5 text-xs text-emerald-200"
        >
          {notice}
        </div>
      )}
      {cards.map((card) => (
        <div
          key={card.id}
          data-testid={`fixit-card-${card.id}`}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/35 bg-amber-500/10 px-3 py-2.5 text-xs"
        >
          <div className="flex items-start gap-2.5">
            <Wrench className="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <div>
              <div className="font-semibold text-amber-100">{card.title}</div>
              <div className="text-[11px] text-amber-200/80">{card.description}</div>
            </div>
          </div>
          <button
            type="button"
            data-testid={`fixit-apply-${card.id}`}
            disabled={busyId === card.id}
            onClick={() => void handleApply(card)}
            className="inline-flex shrink-0 items-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-50"
          >
            <Sparkles className="h-3.5 w-3.5" />
            {busyId === card.id ? 'Applying...' : card.actionLabel}
          </button>
        </div>
      ))}
    </div>
  );
}
