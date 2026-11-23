import { Columns2, GitBranch, GitFork, Trash2 } from 'lucide-react';
import { buildDagTreeRows } from '../../domain/dag';
import type { SpriteNode, SpriteNodeKind } from '../../domain/schemas';
import { BlobImage } from '../components/BlobImage';

interface DagTreeDockProps {
  nodes: SpriteNode[];
  activeNodeId: string | null;
  forkParentId: string | null;
  onSelectNode: (nodeId: string) => void;
  onForkNode: (nodeId: string) => void;
  onCompareNode: (nodeId: string) => void;
  onDeleteLeafNode: (nodeId: string) => void;
}

const KIND_LABELS: Record<SpriteNodeKind, { label: string; className: string }> = {
  sketch: {
    label: 'Sketch',
    className: 'border-slate-600 bg-slate-800 text-slate-200',
  },
  generation: {
    label: 'Gen',
    className: 'border-indigo-500/40 bg-indigo-500/20 text-indigo-200',
  },
  inpaint: {
    label: 'Inpaint',
    className: 'border-rose-500/40 bg-rose-500/20 text-rose-200',
  },
};

export function DagTreeDock({
  nodes,
  activeNodeId,
  forkParentId,
  onSelectNode,
  onForkNode,
  onCompareNode,
  onDeleteLeafNode,
}: DagTreeDockProps) {
  const rows = buildDagTreeRows(nodes);

  return (
    <section
      data-testid="dag-tree-dock"
      className="border-t border-slate-800 bg-slate-900/80 px-4 py-3"
    >
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitBranch className="h-4 w-4 text-indigo-400" />
          <h3 className="text-xs font-semibold tracking-wider text-slate-300 uppercase">
            Sprite Lineage DAG ({nodes.length} {nodes.length === 1 ? 'node' : 'nodes'})
          </h3>
        </div>
        {nodes.length >= 2 && activeNodeId && (
          <button
            type="button"
            data-testid="open-compare-btn"
            onClick={() => onCompareNode(activeNodeId)}
            className="inline-flex items-center gap-1.5 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
          >
            <Columns2 className="h-3.5 w-3.5" />
            Compare Nodes
          </button>
        )}
      </div>

      {rows.length === 0 ? (
        <p data-testid="dag-empty-state" className="py-2 text-xs text-slate-500">
          Upload or draw a sketch and click Generate to build your branching sprite lineage tree.
        </p>
      ) : (
        <div data-testid="dag-tree" className="flex flex-col gap-1.5 overflow-x-auto pb-1">
          {rows.map(({ node, depth, isLeaf }) => {
            const isActive = node.id === activeNodeId;
            const isForkParent = node.id === forkParentId;
            const kindStyle = KIND_LABELS[node.kind];

            return (
              <div
                key={node.id}
                data-testid={`dag-node-${node.id}`}
                data-node-kind={node.kind}
                data-node-depth={depth}
                data-parent-id={node.parentId ?? 'root'}
                style={{ marginLeft: `${depth * 24}px` }}
                className={`flex items-center justify-between gap-3 rounded-lg border px-2.5 py-1.5 transition-colors ${
                  isActive
                    ? 'border-indigo-500 bg-indigo-500/15'
                    : 'border-slate-800 bg-slate-950/70 hover:border-slate-700'
                }`}
              >
                <button
                  type="button"
                  data-testid={`select-node-${node.id}`}
                  onClick={() => onSelectNode(node.id)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                >
                  {depth > 0 && (
                    <span className="font-mono text-xs text-slate-600" aria-hidden="true">
                      └─
                    </span>
                  )}
                  <BlobImage
                    blobId={node.imageBlobId}
                    alt={`${kindStyle.label} node`}
                    className="h-10 w-10 shrink-0 rounded border border-slate-700 bg-checkerboard object-contain"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${kindStyle.className}`}
                      >
                        {kindStyle.label}
                      </span>
                      <span className="font-mono text-[11px] text-slate-300">
                        seed #{node.generationMeta.seed}
                      </span>
                      <span className="text-[11px] text-slate-500">
                        ({node.generationMeta.adherence})
                      </span>
                      {isForkParent && (
                        <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                          Active Parent
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 truncate text-[11px] text-slate-400">
                      {node.generationMeta.promptDelta || 'Base node'}
                    </p>
                  </div>
                </button>

                <div className="flex shrink-0 items-center gap-1.5">
                  <button
                    type="button"
                    data-testid={`fork-node-${node.id}`}
                    onClick={() => onForkNode(node.id)}
                    className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700"
                    title="Fork next generation from this node"
                  >
                    <GitFork className="h-3 w-3" />
                    Fork
                  </button>
                  <button
                    type="button"
                    data-testid={`compare-node-${node.id}`}
                    disabled={nodes.length < 2}
                    onClick={() => onCompareNode(node.id)}
                    className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-700 disabled:opacity-40"
                    title="Compare against another node"
                  >
                    <Columns2 className="h-3 w-3" />
                    Compare
                  </button>
                  {isLeaf && (
                    <button
                      type="button"
                      data-testid={`delete-node-${node.id}`}
                      onClick={() => onDeleteLeafNode(node.id)}
                      className="rounded border border-rose-500/30 bg-rose-500/10 p-1 text-rose-300 hover:bg-rose-500/20"
                      title="Delete leaf node"
                      aria-label={`Delete leaf node ${node.id}`}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
