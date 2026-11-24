import 'fake-indexeddb/auto';
import { unzipSync } from 'fflate';
import { afterEach, describe, expect, it } from 'vitest';
import { NibgridDatabase } from '../../src/db/database';
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from '../../src/domain/entitySchema';
import type { VirtualSyncFile } from '../../src/export/godotPrefabAssembler';
import {
  buildGodotSyncZipBytes,
  clearInMemorySyncHandles,
  setInMemoryDirectoryHandle,
  syncFilesToGodotDirectory,
} from '../../src/sync/fsaaSyncEngine';
import { computeSyncDiff } from '../../src/sync/syncDiff';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): NibgridDatabase {
  const db = new NibgridDatabase(`nibgrid-m25b-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return db;
}

afterEach(async () => {
  clearInMemorySyncHandles();
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

interface MockFsState {
  readonly files: Map<string, Uint8Array>;
  readonly writes: string[];
  readonly rootHandle: FileSystemDirectoryHandleLike;
}

function createMockDirectoryHandle(folderName = 'mock_godot_res'): MockFsState {
  const files = new Map<string, Uint8Array>();
  const writes: string[] = [];

  const makeDir = (prefix: string): FileSystemDirectoryHandleLike => ({
    name: prefix === '' ? folderName : prefix.split('/').pop()!,
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getDirectoryHandle: async (segment: string) =>
      makeDir(prefix === '' ? segment : `${prefix}/${segment}`),
    getFileHandle: async (filename: string): Promise<FileSystemFileHandleLike> => {
      const fullPath = prefix === '' ? filename : `${prefix}/${filename}`;
      let chunks: Uint8Array[] = [];
      return {
        name: filename,
        createWritable: async () => {
          chunks = [];
          return {
            write: async (data: BufferSource | Blob | string) => {
              if (typeof data === 'string') {
                chunks.push(new TextEncoder().encode(data));
              } else if (data instanceof Blob) {
                chunks.push(new Uint8Array(await data.arrayBuffer()));
              } else if (ArrayBuffer.isView(data)) {
                chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
              } else {
                chunks.push(new Uint8Array(data));
              }
            },
            close: async () => {
              const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
              const combined = new Uint8Array(total);
              let off = 0;
              for (const c of chunks) {
                combined.set(c, off);
                off += c.byteLength;
              }
              files.set(fullPath, combined);
              writes.push(fullPath);
            },
          };
        },
      };
    },
  });

  return { files, writes, rootHandle: makeDir('') };
}

function sampleFiles(): VirtualSyncFile[] {
  return [
    {
      relativePath: 'assets/nibgrid/goblin_scout/goblin_scout.png',
      content: new Uint8Array([137, 80, 78, 71, 10, 20, 30, 40]),
    },
    {
      relativePath: 'assets/nibgrid/goblin_scout/goblin_scout.png.import',
      content: '[remap]\nimporter="texture"\ncompress/mode=0\n',
    },
    {
      relativePath: 'assets/nibgrid/goblin_scout/goblin_scout.tscn',
      content:
        '[gd_scene load_steps=2 format=3]\n[node name="GoblinScout" type="CharacterBody2D"]\n',
    },
  ];
}

describe('M25B: SHA-256 Sync Diff Engine & FSAA Directory Writer', () => {
  it('classifies added, unchanged, and 1-byte mutated modified files deterministically via SHA-256', async () => {
    const initial = sampleFiles();

    // Run 1: fresh sync marks all files added
    const run1 = await computeSyncDiff(initial, {});
    expect(run1.plan.added.map((f) => f.relativePath)).toEqual(initial.map((f) => f.relativePath));
    expect(run1.plan.modified).toEqual([]);
    expect(run1.plan.unchangedPaths).toEqual([]);
    expect(run1.plan.totalBytesToWrite).toBeGreaterThan(0);

    // Run 2: identical files -> 0 writes
    const run2 = await computeSyncDiff(initial, run1.nextHashes);
    expect(run2.plan.added).toEqual([]);
    expect(run2.plan.modified).toEqual([]);
    expect(run2.plan.unchangedPaths).toHaveLength(initial.length);
    expect(run2.plan.totalBytesToWrite).toBe(0);

    // Run 3: mutate strictly 1 byte in 1 PNG file -> 1 modified, 2 unchanged
    const mutated = sampleFiles();
    const origBytes = mutated[0]!.content as Uint8Array;
    const tweaked = new Uint8Array(origBytes);
    tweaked[tweaked.length - 1] = ((tweaked[tweaked.length - 1] ?? 0) + 1) & 0xff;
    mutated[0] = { relativePath: mutated[0]!.relativePath, content: tweaked };

    const run3 = await computeSyncDiff(mutated, run2.nextHashes);
    expect(run3.plan.added).toEqual([]);
    expect(run3.plan.modified.map((f) => f.relativePath)).toEqual([
      'assets/nibgrid/goblin_scout/goblin_scout.png',
    ]);
    expect(run3.plan.unchangedPaths).toHaveLength(2);
    expect(run3.plan.totalBytesToWrite).toBe(tweaked.byteLength);
  });

  it('writes nested subdirectories through FileSystemDirectoryHandle stub with zero redundant writes on repeat sync', async () => {
    const db = createTestDb();
    const mockFs = createMockDirectoryHandle('my_rpg_res');
    setInMemoryDirectoryHandle('proj-sync-1', mockFs.rootHandle);

    const files = sampleFiles();

    // Sync 1 -> writes all 3 files
    const res1 = await syncFilesToGodotDirectory(db, 'proj-sync-1', files);
    expect(res1.writtenCount).toBe(3);
    expect(res1.folderName).toBe('my_rpg_res');
    expect(mockFs.writes).toEqual([
      'assets/nibgrid/goblin_scout/goblin_scout.png',
      'assets/nibgrid/goblin_scout/goblin_scout.png.import',
      'assets/nibgrid/goblin_scout/goblin_scout.tscn',
    ]);

    // Sync 2 -> identical hashes -> 0 disk writes
    const res2 = await syncFilesToGodotDirectory(db, 'proj-sync-1', files);
    expect(res2.writtenCount).toBe(0);
    expect(res2.plan.unchangedPaths).toHaveLength(3);
    expect(mockFs.writes).toHaveLength(3);

    // Sync 3 -> modify 1 string file -> strictly 1 additional disk write
    const updatedFiles = sampleFiles();
    updatedFiles[2] = {
      relativePath: updatedFiles[2]!.relativePath,
      content: `${updatedFiles[2]!.content as string}[node name="Sprite" type="AnimatedSprite2D" parent="."]\n`,
    };
    const res3 = await syncFilesToGodotDirectory(db, 'proj-sync-1', updatedFiles);
    expect(res3.writtenCount).toBe(1);
    expect(res3.plan.modified.map((f) => f.relativePath)).toEqual([
      'assets/nibgrid/goblin_scout/goblin_scout.tscn',
    ]);
    expect(mockFs.writes).toHaveLength(4);
  });

  it('packages fallback Godot Sync ZIP preserving identical relative paths and bytes', () => {
    const files = sampleFiles();
    const zipBytes = buildGodotSyncZipBytes(files);
    const unzipped = unzipSync(zipBytes);
    expect(Object.keys(unzipped).sort()).toEqual(files.map((f) => f.relativePath).sort());
    expect(Array.from(unzipped['assets/nibgrid/goblin_scout/goblin_scout.png']!)).toEqual(
      Array.from(files[0]!.content as Uint8Array),
    );
  });
});
