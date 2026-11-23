import { useState } from 'react';
import { Columns2, X } from 'lucide-react';
import type { ArtMode, SpriteNode } from '../../domain/schemas';
import { BlobImage } from '../components/BlobImage';

interface CompareSplitModalProps {
  nodes: SpriteNode[];
  artMode?: ArtMode;
  initialLeftId: string;
  initialRightId: string;
  onClose: () => void;
}

export function CompareSplitModal({
  nodes,
  artMode = 'pixel-art',
  initialLeftId,
  initialRightId,
  onClose,
}: CompareSplitModalProps) {
  const [leftId, setLeftId] = useState(initialLeftId);
  const [rightId, setRightId] = useState(initialRightId);

  const leftNode = nodes.find((n) => n.id === leftId) ?? nodes[0];
  const rightNode = nodes.find((n) => n.id === rightId) ?? nodes[nodes.length - 1];

  const formatLabel = (node: SpriteNode, index: number) =>
    `#${index + 1} ${node.kind.toUpperCase()} · seed ${node.generationMeta.seed}${
      node.generationMeta.promptDelta ? ` (${node.generationMeta.promptDelta.slice(0, 24)})` : ''
    }`;

  return (
    <div
      data-testid="compare-split-view"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/85 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="compare-modal-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-3.5">
          <div className="flex items-center gap-2">
            <Columns2 className="h-4 w-4 text-indigo-400" />
            <h2 id="compare-modal-title" className="text-sm font-semibold text-slate-100">
              Side-by-Side Sprite Comparison
            </h2>
          </div>
          <button
            type="button"
            data-testid="close-compare-btn"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="Close comparison"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-1 gap-4 overflow-y-auto p-5 md:grid-cols-2">
          {leftNode && (
            <div
              data-testid="compare-pane-left"
              className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-4"
            >
              <label className="space-y-1 text-xs">
                <span className="text-slate-400">Left Node</span>
                <select
                  data-testid="compare-select-left"
                  value={leftNode.id}
                  onChange={(e) => setLeftId(e.target.value)}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
                >
                  {nodes.map((node, idx) => (
                    <option key={node.id} value={node.id}>
                      {formatLabel(node, idx)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex aspect-square items-center justify-center rounded-lg border border-slate-800 bg-checkerboard p-4">
                <BlobImage
                  blobId={leftNode.imageBlobId}
                  alt="Comparison Left"
                  artMode={artMode}
                  testId="compare-image-left"
                  className="h-full w-full object-contain"
                />
              </div>

              <div className="space-y-1 text-xs text-slate-400">
                <p>
                  <strong className="text-slate-200">Kind:</strong> {leftNode.kind} ·{' '}
                  <strong className="text-slate-200">Seed:</strong> {leftNode.generationMeta.seed}
                </p>
                <p>
                  <strong className="text-slate-200">Delta:</strong>{' '}
                  {leftNode.generationMeta.promptDelta || '—'}
                </p>
              </div>
            </div>
          )}

          {rightNode && (
            <div
              data-testid="compare-pane-right"
              className="flex flex-col gap-3 rounded-lg border border-slate-800 bg-slate-950/70 p-4"
            >
              <label className="space-y-1 text-xs">
                <span className="text-slate-400">Right Node</span>
                <select
                  data-testid="compare-select-right"
                  value={rightNode.id}
                  onChange={(e) => setRightId(e.target.value)}
                  className="w-full rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
                >
                  {nodes.map((node, idx) => (
                    <option key={node.id} value={node.id}>
                      {formatLabel(node, idx)}
                    </option>
                  ))}
                </select>
              </label>

              <div className="flex aspect-square items-center justify-center rounded-lg border border-slate-800 bg-checkerboard p-4">
                <BlobImage
                  blobId={rightNode.imageBlobId}
                  alt="Comparison Right"
                  artMode={artMode}
                  testId="compare-image-right"
                  className="h-full w-full object-contain"
                />
              </div>

              <div className="space-y-1 text-xs text-slate-400">
                <p>
                  <strong className="text-slate-200">Kind:</strong> {rightNode.kind} ·{' '}
                  <strong className="text-slate-200">Seed:</strong> {rightNode.generationMeta.seed}
                </p>
                <p>
                  <strong className="text-slate-200">Delta:</strong>{' '}
                  {rightNode.generationMeta.promptDelta || '—'}
                </p>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
