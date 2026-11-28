import type { VirtualSyncFile } from '../export/godotPrefabAssembler';
import type { SyncDiffPlan } from './syncDiff';

export type SyncFileOwnership = 'nibgrid-managed' | 'scaffold-once';

const SCAFFOLD_ONCE_EXACT_PATHS = new Set<string>([
  'project.godot',
  'default_bus_layout.tres',
  'main.tscn',
  'scripts/GameShell.gd',
]);

/**
 * Classifies a virtual `res://` file path by ownership so re-syncing Nibgrid assets
 * never overwrites or prunes user-edited Godot project entrypoints or gameplay scripts.
 */
export function classifySyncFileOwnership(relativePath: string): SyncFileOwnership {
  const clean = relativePath
    .replace(/\\/g, '/')
    .replace(/^res:\/\//i, '')
    .replace(/^\/+/, '');
  if (SCAFFOLD_ONCE_EXACT_PATHS.has(clean) || clean.startsWith('scripts/runtime/')) {
    return 'scaffold-once';
  }
  return 'nibgrid-managed';
}

export interface FilteredSyncPlan {
  readonly toWrite: readonly VirtualSyncFile[];
  readonly toRemove: readonly string[];
  readonly preservedPaths: readonly string[];
}

/**
 * Filters a SHA-256 `SyncDiffPlan` against file ownership rules:
 * - Never prunes `scaffold-once` files from disk.
 * - When `preserveUserScaffolds` is `true`, skips overwriting any `scaffold-once` file
 *   already present in `existingScaffoldPaths`.
 */
export function filterSyncPlanForOwnership(
  plan: SyncDiffPlan,
  existingScaffoldPaths: ReadonlySet<string>,
  preserveUserScaffolds: boolean,
): FilteredSyncPlan {
  const candidateWrites = [...plan.added, ...plan.modified];
  const toWrite: VirtualSyncFile[] = [];
  const preservedPaths: string[] = [];

  for (const file of candidateWrites) {
    const ownership = classifySyncFileOwnership(file.relativePath);
    if (
      preserveUserScaffolds &&
      ownership === 'scaffold-once' &&
      existingScaffoldPaths.has(file.relativePath)
    ) {
      preservedPaths.push(file.relativePath);
      continue;
    }
    toWrite.push(file);
  }

  const toRemove = plan.removedPaths.filter(
    (relPath) => classifySyncFileOwnership(relPath) === 'nibgrid-managed',
  );

  return {
    toWrite,
    toRemove,
    preservedPaths: preservedPaths.sort(),
  };
}
