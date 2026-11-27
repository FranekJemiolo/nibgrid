import { NibgridRepository, db, findOrphanBlobIds, type NibgridDatabase } from '../db/database';
import { ProviderKindSchema, type ProviderKind } from '../domain/schemas';
import type { VirtualSyncFile } from '../export/godotPrefabAssembler';
import {
  getBoundDirectoryHandle,
  isFsaaSupported,
  writeFilesToDirectoryHandle,
} from '../sync/fsaaSyncEngine';
import { computeSyncDiff } from '../sync/syncDiff';
import { createVscodeHostAdapter } from '../../packages/vscode-extension/src/vscodeHostBridge';
import {
  assertSafeWorkspaceRelativePath,
  type GlobalNibgridHostBridge,
  type HostAdapter,
  type HostFileEntry,
  type VscodeWebviewApiLike,
} from './hostAdapter';

declare global {
  interface Window {
    __nibgridHostBridge?: GlobalNibgridHostBridge;
    acquireVsCodeApi?: () => VscodeWebviewApiLike;
  }
}

export interface BrowserHostAdapterOptions {
  readonly database?: NibgridDatabase;
  readonly memorySecrets?: Map<string, string>;
  readonly virtualFs?: Map<string, Uint8Array>;
  readonly onNotify?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const DEFAULT_MEMORY_SECRETS = new Map<string, string>();
const DEFAULT_VIRTUAL_FS = new Map<string, Uint8Array>();

function parseProviderKindFromSecretKey(key: string): ProviderKind | null {
  if (key.startsWith('nibgrid.secret.')) {
    const candidate = key.slice('nibgrid.secret.'.length);
    const parsed = ProviderKindSchema.safeParse(candidate);
    return parsed.success ? parsed.data : null;
  }
  return null;
}

/**
 * Browser PWA HostAdapter backed by Dexie (`providerConfigs` vault + `syncTargets`),
 * File System Access API disk sync (`fsaaSyncEngine`), and orphan-blob hygiene.
 */
export function createBrowserHostAdapter(opts: BrowserHostAdapterOptions = {}): HostAdapter {
  const database = opts.database ?? db;
  const repo = new NibgridRepository(database);
  const memorySecrets = opts.memorySecrets ?? DEFAULT_MEMORY_SECRETS;
  const virtualFs = opts.virtualFs ?? DEFAULT_VIRTUAL_FS;

  return {
    kind: 'browser',
    capabilities: {
      supportsDirectDiskSync: isFsaaSupported(),
      supportsNativeKeychain: false,
      supportsLocalProcessLaunch: false,
      supportsMcpServer: false,
    },
    fs: {
      readFile: async (relativePath) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        const bytes = virtualFs.get(safePath);
        if (!bytes) {
          throw new Error(`Workspace file "${safePath}" does not exist.`);
        }
        return new Uint8Array(bytes);
      },
      readText: async (relativePath) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        const bytes = virtualFs.get(safePath);
        if (!bytes) {
          throw new Error(`Workspace file "${safePath}" does not exist.`);
        }
        return new TextDecoder().decode(bytes);
      },
      writeFile: async (relativePath, data) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        const bytes =
          typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
        virtualFs.set(safePath, bytes);
      },
      listFiles: async (dirPath) => {
        const prefix = dirPath ? `${assertSafeWorkspaceRelativePath(dirPath)}/` : '';
        const entries: HostFileEntry[] = [];
        for (const [path, bytes] of virtualFs.entries()) {
          if (!prefix || path.startsWith(prefix)) {
            entries.push({ path, kind: 'file', sizeBytes: bytes.byteLength });
          }
        }
        return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      },
    },
    secrets: {
      getSecret: async (key) => {
        const providerKind = parseProviderKindFromSecretKey(key);
        if (providerKind) {
          const configs = await repo.listProviderConfigs();
          const match = configs.find((c) => c.kind === providerKind || c.id === key);
          if (match && match.apiKey.trim().length > 0) {
            return match.apiKey;
          }
        }
        return memorySecrets.get(key) ?? null;
      },
      setSecret: async (key, value) => {
        const providerKind = parseProviderKindFromSecretKey(key);
        if (providerKind) {
          const configs = await repo.listProviderConfigs();
          const match = configs.find((c) => c.kind === providerKind || c.id === key);
          if (match) {
            await repo.saveProviderConfig({ ...match, apiKey: value, enabled: true });
            return;
          }
          await repo.saveProviderConfig({
            id: key,
            kind: providerKind,
            displayName: `${providerKind} BYOK Vault`,
            modelId: providerKind === 'gemini' ? 'gemini-2.5-flash' : 'default',
            endpointUrl: '',
            apiKey: value,
            enabled: true,
            capabilities: {
              supportsInpaint: providerKind === 'gemini' || providerKind === 'comfyui',
              supportsMultiRef: true,
              supportsSeed: true,
              isLocal: false,
            },
            updatedAt: new Date().toISOString(),
          });
          return;
        }
        memorySecrets.set(key, value);
      },
      deleteSecret: async (key) => {
        memorySecrets.delete(key);
        const providerKind = parseProviderKindFromSecretKey(key);
        if (providerKind) {
          const configs = await repo.listProviderConfigs();
          for (const cfg of configs) {
            if (cfg.kind === providerKind || cfg.id === key) {
              await repo.saveProviderConfig({ ...cfg, apiKey: '' });
            }
          }
        }
      },
    },
    sync: {
      syncResFiles: async (projectId, files) => {
        const virtualFiles: VirtualSyncFile[] = files.map((file) => ({
          relativePath: assertSafeWorkspaceRelativePath(file.relativePath),
          content: file.data,
        }));

        const handle = await getBoundDirectoryHandle(database, projectId);
        if (!handle) {
          return {
            ok: false,
            writtenCount: 0,
            skippedCount: virtualFiles.length,
            targetLabel: 'unbound',
            writtenPaths: [],
            message: 'No Godot directory bound via File System Access API.',
          };
        }

        const existingTarget = await repo.getSyncTarget(projectId);
        const { plan, nextHashes } = await computeSyncDiff(
          virtualFiles,
          existingTarget?.lastSyncedHashes ?? {},
        );
        const changedFiles = [...plan.added, ...plan.modified];
        const writtenCount = await writeFilesToDirectoryHandle(handle, changedFiles);

        await repo.saveSyncTarget({
          projectId,
          folderName: existingTarget?.folderName || handle.name || 'godot_res',
          lastSyncedHashes: nextHashes,
          lastSyncedAt: Date.now(),
          directoryHandle: handle,
        });

        await findOrphanBlobIds(database);

        return {
          ok: true,
          writtenCount,
          skippedCount: plan.unchangedPaths.length,
          targetLabel: handle.name || 'godot_res',
          writtenPaths: changedFiles.map((f) => f.relativePath),
          message: `Synced ${writtenCount} Godot res:// files to ${handle.name || 'godot_res'}.`,
        };
      },
      openEditor: async (relativePath) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        opts.onNotify?.('info', `Previewing "${safePath}" in Browser Studio`);
      },
      launchGodot: async () => ({
        launched: false,
        message: 'Direct Godot process launch requires VS Code Extension or Nibgrid Desktop host.',
      }),
    },
    antigravity: {
      detectAntigravity: async () => {
        if (typeof window !== 'undefined' && window.__nibgridHostBridge?.antigravity) {
          return window.__nibgridHostBridge.antigravity.detectAntigravity();
        }
        return { detected: false, configDir: '~/.gemini/config' };
      },
      linkAntigravityMcp: async (linkOpts) => {
        if (typeof window !== 'undefined' && window.__nibgridHostBridge?.antigravity) {
          return window.__nibgridHostBridge.antigravity.linkAntigravityMcp(linkOpts);
        }
        const snippet = JSON.stringify(
          {
            mcpServers: {
              nibgrid: {
                command: 'node',
                args: ['packages/vscode-extension/dist/mcpToolServer.js'],
                env: { NIBGRID_WORKSPACE: linkOpts.workspacePath ?? '.' },
              },
            },
          },
          null,
          2,
        );
        return {
          ok: true,
          configPath: `${linkOpts.configDir ?? '~/.gemini/config'}/mcp_config.json`,
          mergedConfigJson: snippet,
          message:
            'Generated clean mcp_config.json entry (run inside Nibgrid Desktop / VS Code Extension to write directly to ~/.gemini/config/mcp_config.json).',
        };
      },
    },
    notify: (level, message) => {
      opts.onNotify?.(level, message);
    },
  };
}

let cachedVscodeAdapter: HostAdapter | null = null;

/**
 * Resolves the active host adapter (`__nibgridHostBridge` override -> VS Code Webview -> Browser PWA).
 */
export function getActiveHostAdapter(opts?: BrowserHostAdapterOptions): HostAdapter {
  if (typeof window !== 'undefined' && window.__nibgridHostBridge) {
    const base = createBrowserHostAdapter(opts);
    const bridge = window.__nibgridHostBridge;
    return {
      kind: bridge.hostKind ?? 'nibgrid-desktop',
      capabilities: {
        ...base.capabilities,
        ...bridge.capabilities,
      },
      fs: bridge.fs ?? base.fs,
      secrets: bridge.secrets ?? base.secrets,
      sync: bridge.sync ?? base.sync,
      antigravity: bridge.antigravity ?? base.antigravity,
      notify: bridge.notify ?? base.notify,
    };
  }

  if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
    if (!cachedVscodeAdapter) {
      const vsApi = window.acquireVsCodeApi();
      cachedVscodeAdapter = createVscodeHostAdapter(
        {
          postMessage: (msg) => vsApi.postMessage(msg),
          onMessage: (listener) => {
            const handler = (ev: MessageEvent) => listener(ev.data);
            window.addEventListener('message', handler);
            return () => window.removeEventListener('message', handler);
          },
        },
        { kind: 'vscode-webview' },
      );
    }
    return cachedVscodeAdapter;
  }

  return createBrowserHostAdapter(opts);
}
