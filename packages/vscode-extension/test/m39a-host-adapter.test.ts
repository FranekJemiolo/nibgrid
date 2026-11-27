import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../../src/db/database';
import {
  assertSafeWorkspaceRelativePath,
  type HostAdapter,
} from '../../../src/platform/hostAdapter';
import { createBrowserHostAdapter } from '../../../src/platform/browserHostAdapter';
import type {
  FileSystemDirectoryHandleLike,
  FileSystemFileHandleLike,
} from '../../../src/domain/entitySchema';
import { setInMemoryDirectoryHandle } from '../../../src/sync/fsaaSyncEngine';
import {
  createInMemoryRpcPair,
  createVscodeHostAdapter,
  dispatchHostRpcRequest,
  type HostBridgeHandlers,
} from '../src/vscodeHostBridge';

function createMockMemoryDirectoryHandle(name = 'godot_res'): {
  readonly handle: FileSystemDirectoryHandleLike;
  readonly files: Map<string, Uint8Array>;
} {
  const files = new Map<string, Uint8Array>();

  function makeDir(prefix: string): FileSystemDirectoryHandleLike {
    return {
      name,
      async getDirectoryHandle(segment: string): Promise<FileSystemDirectoryHandleLike> {
        return makeDir(prefix ? `${prefix}/${segment}` : segment);
      },
      async getFileHandle(fileName: string): Promise<FileSystemFileHandleLike> {
        const relPath = prefix ? `${prefix}/${fileName}` : fileName;
        return {
          name: fileName,
          async createWritable() {
            const chunks: Uint8Array[] = [];
            return {
              async write(data: BlobPart | Uint8Array | string) {
                if (typeof data === 'string') {
                  chunks.push(new TextEncoder().encode(data));
                } else if (data instanceof Uint8Array) {
                  chunks.push(new Uint8Array(data));
                } else if (data instanceof Blob) {
                  chunks.push(new Uint8Array(await data.arrayBuffer()));
                } else if (data instanceof ArrayBuffer) {
                  chunks.push(new Uint8Array(data));
                }
              },
              async close() {
                const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
                const merged = new Uint8Array(total);
                let offset = 0;
                for (const c of chunks) {
                  merged.set(c, offset);
                  offset += c.byteLength;
                }
                files.set(relPath, merged);
              },
            };
          },
        };
      },
    };
  }

  return { handle: makeDir(''), files };
}

describe('M39A: Pure-TS HostAdapter, BrowserHostAdapter & Typed Extension Host RPC Bridge', () => {
  it('round-trips readFile, writeFile, listFiles, secrets, syncResFiles, openEditor & launchGodot over in-memory postMessage RPC', async () => {
    const { webviewTransport, hostTransport } = createInMemoryRpcPair();
    const vfs = new Map<string, Uint8Array>();
    const keychain = new Map<string, string>();
    const openedEditors: string[] = [];
    const notifications: { level: string; message: string }[] = [];

    const handlers: HostBridgeHandlers = {
      readFile: async (path) => {
        const bytes = vfs.get(path);
        if (!bytes) throw new Error(`Missing file ${path}`);
        return bytes;
      },
      writeFile: async (path, data) => {
        vfs.set(path, data);
      },
      listFiles: async (dirPath) =>
        Array.from(vfs.entries())
          .filter(([p]) => !dirPath || p.startsWith(`${dirPath}/`))
          .map(([path, b]) => ({ path, kind: 'file' as const, sizeBytes: b.byteLength })),
      getSecret: async (key) => keychain.get(key) ?? null,
      setSecret: async (key, val) => {
        keychain.set(key, val);
      },
      deleteSecret: async (key) => {
        keychain.delete(key);
      },
      syncResFiles: async (_projectId, synced) => {
        const writtenPaths: string[] = [];
        for (const f of synced) {
          const bytes = typeof f.data === 'string' ? new TextEncoder().encode(f.data) : f.data;
          vfs.set(f.relativePath, bytes);
          writtenPaths.push(f.relativePath);
        }
        return {
          ok: true,
          writtenCount: writtenPaths.length,
          skippedCount: 0,
          targetLabel: 'workspace-res',
          writtenPaths,
        };
      },
      openEditor: async (path) => {
        openedEditors.push(path);
      },
      launchGodot: async ({ scenePath }) => ({
        launched: true,
        pid: 4242,
        message: `Launched ${scenePath ?? 'res://main.tscn'}`,
      }),
      detectAntigravity: async () => ({ detected: true, configDir: '~/.gemini/config' }),
      linkAntigravityMcp: async () => ({
        ok: true,
        configPath: '~/.gemini/config/mcp_config.json',
        message: 'Linked',
      }),
      notify: (level, message) => notifications.push({ level, message }),
    };

    const unsubHost = hostTransport.onMessage(async (msg) => {
      const resp = await dispatchHostRpcRequest(msg, handlers, {
        knownSecrets: Array.from(keychain.values()),
      });
      hostTransport.postMessage(resp);
    });

    const adapter: HostAdapter & { dispose: () => void } =
      createVscodeHostAdapter(webviewTransport);
    expect(adapter.capabilities).toEqual({
      supportsDirectDiskSync: true,
      supportsNativeKeychain: true,
      supportsLocalProcessLaunch: true,
      supportsMcpServer: true,
    });

    await adapter.fs.writeFile('shaders/flash.gdshader', 'shader_type canvas_item;');
    expect(await adapter.fs.readText('shaders/flash.gdshader')).toBe('shader_type canvas_item;');
    const binaryPayload = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    await adapter.fs.writeFile('sprites/hero.png', binaryPayload);
    expect(await adapter.fs.readFile('sprites/hero.png')).toEqual(binaryPayload);
    expect(await adapter.fs.listFiles('shaders')).toEqual([
      { path: 'shaders/flash.gdshader', kind: 'file', sizeBytes: 24 },
    ]);

    await adapter.secrets.setSecret('nibgrid.secret.gemini', 'AIzaSyHOST39SECRET');
    expect(await adapter.secrets.getSecret('nibgrid.secret.gemini')).toBe('AIzaSyHOST39SECRET');
    await adapter.secrets.deleteSecret('nibgrid.secret.gemini');
    expect(await adapter.secrets.getSecret('nibgrid.secret.gemini')).toBeNull();

    const syncRes = await adapter.sync.syncResFiles('proj-1', [
      { relativePath: 'entities/hero/hero.tscn', data: '[gd_scene format=3]' },
    ]);
    expect(syncRes.ok).toBe(true);
    expect(syncRes.writtenCount).toBe(1);
    expect(syncRes.writtenPaths).toEqual(['entities/hero/hero.tscn']);

    await adapter.sync.openEditor('entities/hero/hero.tscn');
    expect(openedEditors).toEqual(['entities/hero/hero.tscn']);

    const launchRes = await adapter.sync.launchGodot({ scenePath: 'res://main.tscn' });
    expect(launchRes).toEqual({
      launched: true,
      pid: 4242,
      message: 'Launched res://main.tscn',
    });

    adapter.dispose();
    unsubHost();
  });

  it('matches out-of-order concurrent correlation IDs and scrubs secrets from propagated errors', async () => {
    const { webviewTransport, hostTransport } = createInMemoryRpcPair();

    const handlers: HostBridgeHandlers = {
      readFile: async (path) => {
        if (path === 'slow.txt') {
          await new Promise((r) => setTimeout(r, 25));
          return new TextEncoder().encode('slow-ok');
        }
        if (path === 'secret-boom.txt') {
          throw new Error(
            'Auth failed for AIzaSyLEAK999KEY and sk-leak-token-888 and custom-top-secret!',
          );
        }
        return new TextEncoder().encode('fast-ok');
      },
      getSecret: async () => null,
      setSecret: async () => undefined,
      deleteSecret: async () => undefined,
      detectAntigravity: async () => ({ detected: false, configDir: '~/.gemini/config' }),
      linkAntigravityMcp: async () => ({ ok: false, configPath: '', message: 'none' }),
      notify: () => undefined,
    };

    const unsubHost = hostTransport.onMessage(async (msg) => {
      const resp = await dispatchHostRpcRequest(msg, handlers, {
        knownSecrets: ['custom-top-secret!'],
      });
      hostTransport.postMessage(resp);
    });

    const adapter = createVscodeHostAdapter(webviewTransport, { timeoutMs: 200 });
    const [slow, fast] = await Promise.all([
      adapter.fs.readText('slow.txt'),
      adapter.fs.readText('fast.txt'),
    ]);
    expect(slow).toBe('slow-ok');
    expect(fast).toBe('fast-ok');

    let caughtMessage = '';
    try {
      await adapter.fs.readText('secret-boom.txt');
    } catch (err) {
      caughtMessage = err instanceof Error ? err.message : String(err);
    }
    expect(caughtMessage).not.toContain('AIzaSyLEAK999KEY');
    expect(caughtMessage).not.toContain('sk-leak-token-888');
    expect(caughtMessage).not.toContain('custom-top-secret!');
    expect(caughtMessage).toContain('[REDACTED]');

    // Verify timeout handling when host stops replying
    unsubHost();
    await expect(adapter.fs.readText('fast.txt')).rejects.toThrow(/timed out/);
    adapter.dispose();

    // Verify path traversal guard
    expect(() => assertSafeWorkspaceRelativePath('../secrets.env')).toThrow(/Unsafe/);
    expect(() => assertSafeWorkspaceRelativePath('/etc/passwd')).toThrow(/Absolute/);
  });

  it('BrowserHostAdapter conforms to HostAdapter, persists Dexie vault secrets & syncs FSAA files with zero orphan blobs', async () => {
    const testDb = new NibgridDatabase(`nibgrid-m39a-${crypto.randomUUID()}`);
    const repo = new NibgridRepository(testDb);
    const project = await repo.createProject('M39A Browser Test');
    const { handle, files } = createMockMemoryDirectoryHandle('res_root');

    await repo.saveSyncTarget({
      projectId: project.id,
      folderName: 'res_root',
      lastSyncedHashes: {},
      lastSyncedAt: null,
      directoryHandle: handle,
    });
    setInMemoryDirectoryHandle(project.id, handle);

    const browserHost: HostAdapter = createBrowserHostAdapter({
      database: testDb,
      memorySecrets: new Map(),
      virtualFs: new Map(),
    });

    await browserHost.fs.writeFile('notes/design.md', '# Knight Palette');
    expect(await browserHost.fs.readText('notes/design.md')).toBe('# Knight Palette');

    await browserHost.secrets.setSecret('nibgrid.secret.gemini', 'AIzaSyDEXIE39KEY');
    expect(await browserHost.secrets.getSecret('nibgrid.secret.gemini')).toBe('AIzaSyDEXIE39KEY');
    await browserHost.secrets.deleteSecret('nibgrid.secret.gemini');
    expect(await browserHost.secrets.getSecret('nibgrid.secret.gemini')).toBeNull();

    const syncResult = await browserHost.sync.syncResFiles(project.id, [
      { relativePath: 'entities/slime/slime.tscn', data: '[gd_scene format=3]' },
    ]);
    expect(syncResult.ok).toBe(true);
    expect(syncResult.writtenCount).toBe(1);
    expect(new TextDecoder().decode(files.get('entities/slime/slime.tscn'))).toBe(
      '[gd_scene format=3]',
    );

    const secondSync = await browserHost.sync.syncResFiles(project.id, [
      { relativePath: 'entities/slime/slime.tscn', data: '[gd_scene format=3]' },
    ]);
    expect(secondSync.writtenCount).toBe(0);
    expect(secondSync.skippedCount).toBe(1);

    expect(await findOrphanBlobIds(testDb)).toEqual([]);
    setInMemoryDirectoryHandle(project.id, null);
    await testDb.delete();
  });
});
