import type { VirtualSyncFile } from '../export/godotPrefabAssembler';
import { sha256Bytes } from '../processing/hash';

export interface SyncDiffPlan {
  readonly added: readonly VirtualSyncFile[];
  readonly modified: readonly VirtualSyncFile[];
  readonly unchangedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly totalBytesToWrite: number;
}

export interface SyncDiffResult {
  readonly plan: SyncDiffPlan;
  readonly nextHashes: Record<string, string>;
}

const textEncoder = new TextEncoder();

export function virtualFileToBytes(file: VirtualSyncFile): Uint8Array {
  return typeof file.content === 'string' ? textEncoder.encode(file.content) : file.content;
}

/**
 * Pure-TS SHA-256 diff engine comparing generated virtual files against previously synced digests.
 * Computes `added`, `modified`, and `unchangedPaths` so unchanged files never trigger Godot re-imports.
 */
export async function computeSyncDiff(
  files: readonly VirtualSyncFile[],
  previousHashes: Readonly<Record<string, string>>,
): Promise<SyncDiffResult> {
  const added: VirtualSyncFile[] = [];
  const modified: VirtualSyncFile[] = [];
  const unchangedPaths: string[] = [];
  const currentPaths = new Set<string>();
  const nextHashes: Record<string, string> = {};
  let totalBytesToWrite = 0;

  for (const file of files) {
    currentPaths.add(file.relativePath);
    const bytes = virtualFileToBytes(file);
    const hashHex = await sha256Bytes(bytes);
    const prevHash = previousHashes[file.relativePath];

    if (!prevHash) {
      added.push(file);
      totalBytesToWrite += bytes.byteLength;
    } else if (prevHash !== hashHex) {
      modified.push(file);
      totalBytesToWrite += bytes.byteLength;
    } else {
      unchangedPaths.push(file.relativePath);
    }

    nextHashes[file.relativePath] = hashHex;
  }

  const removedPaths = Object.keys(previousHashes)
    .filter((p) => !currentPaths.has(p))
    .sort();

  return {
    plan: {
      added,
      modified,
      unchangedPaths,
      removedPaths,
      totalBytesToWrite,
    },
    nextHashes,
  };
}
