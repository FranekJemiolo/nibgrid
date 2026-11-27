import { z } from 'zod';
import {
  SliceExecutionTierSchema,
  VerticalSliceBlueprintSchema,
  type SliceExecutionTier,
  type VerticalSliceBlueprint,
} from './verticalSliceSchema';

export const SliceNodeStatusSchema = z.enum([
  'pending',
  'running',
  'awaiting-approval',
  'done',
  'failed',
  'aborted',
]);
export type SliceNodeStatus = z.infer<typeof SliceNodeStatusSchema>;

export const SliceNodeKindSchema = z.enum([
  'art-bible',
  'golden-ref',
  'tileset',
  'parallax',
  'entity',
  'bmfont',
  'ui-theme',
  'room',
  'main-scene',
  'visual-qa',
]);
export type SliceNodeKind = z.infer<typeof SliceNodeKindSchema>;

export const SliceDagNodeSchema = z.object({
  id: z.string().min(1),
  kind: SliceNodeKindSchema,
  label: z.string().min(1),
  dependsOn: z.array(z.string()),
  status: SliceNodeStatusSchema,
  metaSlug: z.string().optional(),
  artifactId: z.string().optional(),
  errorMessage: z.string().optional(),
});
export type SliceDagNode = z.infer<typeof SliceDagNodeSchema>;

export const SliceJobStatusSchema = z.enum([
  'idle',
  'running',
  'awaiting-approval',
  'completed',
  'failed',
  'aborted',
]);
export type SliceJobStatus = z.infer<typeof SliceJobStatusSchema>;

export const SliceJobRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  tier: SliceExecutionTierSchema,
  status: SliceJobStatusSchema,
  blueprint: VerticalSliceBlueprintSchema,
  nodes: z.array(SliceDagNodeSchema),
  updatedAt: z.number().int().nonnegative(),
});
export type SliceJobRecord = z.infer<typeof SliceJobRecordSchema>;

export type SliceNodeExecutor = (
  node: SliceDagNode,
  job: SliceJobRecord,
  signal?: AbortSignal,
) => Promise<{ readonly artifactId?: string }>;

/**
 * Builds the deterministic 4-stage Vertical Slice DAG:
 * - Stage 1 & 2: `art_bible` -> `golden_ref_hero` (checkpoint)
 * - Stage 3 (Fan-out): `terrain_tileset`, `parallax_stack`, `entity_<slug>` × N, `bmfont` -> `ui_theme`
 * - Stage 4 (Convergence): `room_level` -> `main_scene`, plus `visual_qa`
 */
export function buildSliceDagNodes(blueprint: VerticalSliceBlueprint): SliceDagNode[] {
  const nodes: SliceDagNode[] = [
    {
      id: 'art_bible',
      kind: 'art-bible',
      label: 'Art Bible Style Lock',
      dependsOn: [],
      status: 'pending',
    },
    {
      id: 'golden_ref_hero',
      kind: 'golden-ref',
      label: `Golden Ref Anchor (${blueprint.cast[0]?.slug ?? 'hero'})`,
      dependsOn: ['art_bible'],
      status: 'pending',
      metaSlug: blueprint.cast[0]?.slug,
    },
    {
      id: 'terrain_tileset',
      kind: 'tileset',
      label: 'M20 Auto-Tile Set',
      dependsOn: ['golden_ref_hero'],
      status: 'pending',
    },
    {
      id: 'parallax_stack',
      kind: 'parallax',
      label: 'M23 Parallax Stack',
      dependsOn: ['golden_ref_hero'],
      status: 'pending',
    },
  ];

  const entityNodeIds: string[] = [];
  for (const member of blueprint.cast) {
    const id = `entity_${member.slug}`;
    entityNodeIds.push(id);
    nodes.push({
      id,
      kind: 'entity',
      label: `${member.role === 'hero' ? 'Hero' : member.role === 'prop' ? 'Prop' : 'Enemy'}: ${member.slug}`,
      dependsOn: ['golden_ref_hero'],
      status: 'pending',
      metaSlug: member.slug,
    });
  }

  nodes.push(
    {
      id: 'bmfont',
      kind: 'bmfont',
      label: 'M24 Bitmap HUD Font',
      dependsOn: ['golden_ref_hero'],
      status: 'pending',
    },
    {
      id: 'ui_theme',
      kind: 'ui-theme',
      label: 'M33 Godot 4 Theme .tres',
      dependsOn: ['bmfont'],
      status: 'pending',
    },
    {
      id: 'room_level',
      kind: 'room',
      label: `M35 Level (${blueprint.roomCols}×${blueprint.roomRows})`,
      dependsOn: ['terrain_tileset', 'parallax_stack', ...entityNodeIds],
      status: 'pending',
    },
    {
      id: 'main_scene',
      kind: 'main-scene',
      label: 'M37 main.tscn Entry',
      dependsOn: ['room_level', 'ui_theme'],
      status: 'pending',
    },
    {
      id: 'visual_qa',
      kind: 'visual-qa',
      label: 'M32 Art Director QA',
      dependsOn: [...entityNodeIds],
      status: 'pending',
    },
  );

  return nodes;
}

export function createSliceJobRecord(
  projectId: string,
  blueprint: VerticalSliceBlueprint,
  tier: SliceExecutionTier,
  id?: string,
): SliceJobRecord {
  return SliceJobRecordSchema.parse({
    id: id ?? globalThis.crypto.randomUUID(),
    projectId,
    tier,
    status: 'idle',
    blueprint,
    nodes: buildSliceDagNodes(blueprint),
    updatedAt: Date.now(),
  });
}

export function computeSliceJobStatus(nodes: readonly SliceDagNode[]): SliceJobStatus {
  if (nodes.some((n) => n.status === 'awaiting-approval')) return 'awaiting-approval';
  if (nodes.some((n) => n.status === 'running')) return 'running';
  if (nodes.some((n) => n.status === 'failed')) return 'failed';
  if (nodes.some((n) => n.status === 'aborted')) return 'aborted';
  if (nodes.length > 0 && nodes.every((n) => n.status === 'done')) return 'completed';
  return 'idle';
}

export interface RunSliceDagOptions {
  readonly approvedAnchor: boolean;
  readonly maxConcurrency?: number;
  readonly signal?: AbortSignal;
  readonly onJobUpdate?: (job: SliceJobRecord) => void | Promise<void>;
}

/**
 * Pure-TS resumable DAG executor:
 * - Skips every node already `'done'`.
 * - Halts at `'awaiting-approval'` after `golden_ref_hero` completes until `approvedAnchor === true`.
 * - Schedules ready `'pending'` / `'failed'` nodes up to `maxConcurrency` (default `2`).
 * - Serializes persisted snapshots so concurrent branch completions never race.
 */
export async function runSliceDag(
  initialJob: SliceJobRecord,
  executor: SliceNodeExecutor,
  options: RunSliceDagOptions,
): Promise<SliceJobRecord> {
  const maxConcurrency = Math.max(1, Math.min(4, Math.round(options.maxConcurrency ?? 2)));
  const signal = options.signal;

  let nodes: SliceDagNode[] = initialJob.nodes.map((n) => ({
    ...n,
    dependsOn: [...n.dependsOn],
    ...(n.status === 'running' || n.status === 'failed' || n.status === 'aborted'
      ? { status: 'pending' as const, errorMessage: undefined }
      : {}),
  }));

  let persistChain: Promise<void> = Promise.resolve();
  const buildSnapshot = (overrideStatus?: SliceJobStatus): SliceJobRecord => ({
    ...initialJob,
    status: overrideStatus ?? computeSliceJobStatus(nodes),
    nodes: nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn] })),
    updatedAt: Date.now(),
  });

  const emitUpdate = async (overrideStatus?: SliceJobStatus): Promise<SliceJobRecord> => {
    const snap = buildSnapshot(overrideStatus);
    if (options.onJobUpdate) {
      persistChain = persistChain.then(async () => {
        await options.onJobUpdate!(snap);
      });
      await persistChain;
    }
    return snap;
  };

  const setNode = (nodeId: string, patch: Partial<SliceDagNode>) => {
    nodes = nodes.map((n) => (n.id === nodeId ? { ...n, ...patch } : n));
  };

  const isDoneMap = (): ReadonlySet<string> =>
    new Set(nodes.filter((n) => n.status === 'done').map((n) => n.id));

  // If anchor was awaiting approval and the user just approved it, promote it cleanly to 'done'.
  if (options.approvedAnchor) {
    const anchor = nodes.find((n) => n.id === 'golden_ref_hero');
    if (anchor && anchor.status === 'awaiting-approval') {
      setNode('golden_ref_hero', { status: 'done', errorMessage: undefined });
      await emitUpdate('running');
    }
  }

  const executeSingleNode = async (node: SliceDagNode): Promise<void> => {
    if (signal?.aborted) {
      setNode(node.id, { status: 'aborted' });
      return;
    }
    setNode(node.id, { status: 'running', errorMessage: undefined });
    const jobSnapshot = await emitUpdate('running');

    try {
      const result = await executor(node, jobSnapshot, signal);
      if (signal?.aborted) {
        setNode(node.id, { status: 'aborted' });
        await emitUpdate();
        return;
      }

      if (node.id === 'golden_ref_hero' && !options.approvedAnchor) {
        setNode(node.id, {
          status: 'awaiting-approval',
          ...(result.artifactId ? { artifactId: result.artifactId } : {}),
        });
      } else {
        setNode(node.id, {
          status: 'done',
          ...(result.artifactId ? { artifactId: result.artifactId } : {}),
        });
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        setNode(node.id, { status: 'aborted' });
      } else {
        setNode(node.id, {
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      }
    }
    await emitUpdate();
  };

  const inFlight = new Set<Promise<void>>();

  while (true) {
    if (signal?.aborted) {
      await Promise.allSettled([...inFlight]);
      nodes = nodes.map((n) => (n.status === 'running' ? { ...n, status: 'aborted' } : n));
      return emitUpdate('aborted');
    }

    // Pause immediately at Golden Reference checkpoint if not approved
    const anchor = nodes.find((n) => n.id === 'golden_ref_hero');
    if (!options.approvedAnchor && anchor?.status === 'awaiting-approval') {
      await Promise.allSettled([...inFlight]);
      return emitUpdate('awaiting-approval');
    }

    const doneSet = isDoneMap();
    const runnable = nodes.filter(
      (n) =>
        n.status === 'pending' &&
        (options.approvedAnchor || n.id === 'art_bible' || n.id === 'golden_ref_hero') &&
        n.dependsOn.every((dep) => doneSet.has(dep)),
    );

    while (inFlight.size < maxConcurrency && runnable.length > 0) {
      const next = runnable.shift()!;
      // Re-mark synchronously before starting async task so next iteration won't double-pick
      setNode(next.id, { status: 'running', errorMessage: undefined });
      const p = executeSingleNode(next).finally(() => {
        inFlight.delete(p);
      });
      inFlight.add(p);
    }

    if (inFlight.size === 0) {
      break;
    }

    await Promise.race(inFlight);
  }

  return emitUpdate();
}
