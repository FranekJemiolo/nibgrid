import { z } from 'zod';
import {
  assertSafeWorkspaceRelativePath,
  decodeBytesBase64,
  encodeBytesBase64,
  redactHostSecrets,
  type AntigravityLinkResult,
  type HostAdapter,
  type HostCapabilities,
  type HostFileEntry,
  type HostKind,
  type HostSyncFile,
  type HostSyncResult,
} from '../../../src/platform/hostAdapter';

export const HostRpcRequestSchema = z.discriminatedUnion('method', [
  z.object({
    id: z.string().min(1),
    method: z.literal('readFile'),
    params: z.object({ path: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('writeFile'),
    params: z.object({
      path: z.string().min(1),
      base64: z.string().optional(),
      text: z.string().optional(),
    }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('listFiles'),
    params: z.object({ dirPath: z.string().optional() }).default({}),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('getSecret'),
    params: z.object({ key: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('setSecret'),
    params: z.object({ key: z.string().min(1), value: z.string() }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('deleteSecret'),
    params: z.object({ key: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('syncResFiles'),
    params: z.object({
      projectId: z.string().min(1),
      files: z.array(
        z.object({
          relativePath: z.string().min(1),
          base64: z.string().optional(),
          text: z.string().optional(),
        }),
      ),
    }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('openEditor'),
    params: z.object({ path: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('launchGodot'),
    params: z
      .object({
        workspacePath: z.string().optional(),
        scenePath: z.string().optional(),
      })
      .default({}),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('detectAntigravity'),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('linkAntigravityMcp'),
    params: z
      .object({
        configDir: z.string().optional(),
        workspacePath: z.string().optional(),
      })
      .default({}),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('notify'),
    params: z.object({
      level: z.enum(['info', 'warn', 'error']).default('info'),
      message: z.string(),
    }),
  }),
  // Backward-compatible M40 dotted aliases
  z.object({
    id: z.string().min(1),
    method: z.literal('fs.readText'),
    params: z.object({ path: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('fs.writeText'),
    params: z.object({ path: z.string().min(1), content: z.string() }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('secrets.get'),
    params: z.object({ key: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('secrets.set'),
    params: z.object({ key: z.string().min(1), value: z.string() }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('secrets.delete'),
    params: z.object({ key: z.string().min(1) }),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('antigravity.detect'),
    params: z.record(z.string(), z.unknown()).default({}),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('antigravity.linkMcp'),
    params: z
      .object({
        configDir: z.string().optional(),
        workspacePath: z.string().optional(),
      })
      .default({}),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('godot.runSlice'),
    params: z
      .object({
        workspacePath: z.string().optional(),
        scenePath: z.string().optional(),
      })
      .default({}),
  }),
  z.object({
    id: z.string().min(1),
    method: z.literal('ui.notify'),
    params: z.object({
      level: z.enum(['info', 'warn', 'error']).default('info'),
      message: z.string(),
    }),
  }),
]);
export type HostRpcRequest = z.infer<typeof HostRpcRequestSchema>;
export type HostRpcMethod = HostRpcRequest['method'];

export const HostRpcResponseSchema = z.object({
  id: z.string().min(1),
  ok: z.boolean().optional(),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type HostRpcResponse = z.infer<typeof HostRpcResponseSchema>;

export interface HostBridgeHandlers {
  readonly readFile?: (relativePath: string) => Promise<Uint8Array>;
  readonly writeFile?: (relativePath: string, data: Uint8Array) => Promise<void>;
  readonly listFiles?: (dirPath?: string) => Promise<readonly HostFileEntry[]>;
  readonly readText?: (relativePath: string) => Promise<string>;
  readonly writeText?: (relativePath: string, content: string) => Promise<void>;
  readonly getSecret: (key: string) => Promise<string | null>;
  readonly setSecret: (key: string, value: string) => Promise<void>;
  readonly deleteSecret: (key: string) => Promise<void>;
  readonly syncResFiles?: (
    projectId: string,
    files: readonly HostSyncFile[],
  ) => Promise<HostSyncResult>;
  readonly openEditor?: (relativePath: string) => Promise<void>;
  readonly launchGodot?: (opts: {
    readonly workspacePath?: string;
    readonly scenePath?: string;
  }) => Promise<{ readonly launched: boolean; readonly pid?: number; readonly message?: string }>;
  readonly detectAntigravity: () => Promise<{
    readonly detected: boolean;
    readonly configDir: string;
  }>;
  readonly linkAntigravityMcp: (opts: {
    readonly configDir?: string;
    readonly workspacePath?: string;
  }) => Promise<AntigravityLinkResult>;
  readonly runGodotSlice?: (opts: {
    readonly workspacePath?: string;
    readonly scenePath?: string;
  }) => Promise<{ readonly launched: boolean }>;
  readonly notify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface RpcMessageTransport {
  readonly postMessage: (msg: unknown) => void;
  readonly onMessage: (listener: (msg: unknown) => void) => () => void;
}

/**
 * Creates a bidirectional in-memory RPC transport pair for offline extension tests.
 */
export function createInMemoryRpcPair(): {
  readonly webviewTransport: RpcMessageTransport;
  readonly hostTransport: RpcMessageTransport;
} {
  const webviewListeners = new Set<(msg: unknown) => void>();
  const hostListeners = new Set<(msg: unknown) => void>();

  return {
    webviewTransport: {
      postMessage: (msg) => {
        queueMicrotask(() => {
          for (const listener of hostListeners) {
            listener(msg);
          }
        });
      },
      onMessage: (listener) => {
        webviewListeners.add(listener);
        return () => webviewListeners.delete(listener);
      },
    },
    hostTransport: {
      postMessage: (msg) => {
        queueMicrotask(() => {
          for (const listener of webviewListeners) {
            listener(msg);
          }
        });
      },
      onMessage: (listener) => {
        hostListeners.add(listener);
        return () => hostListeners.delete(listener);
      },
    },
  };
}

/**
 * Webview-side `HostAdapter` communicating with the VS Code / Desktop Extension Host
 * using correlated `postMessage` JSON-RPC envelopes and secret-redacted errors.
 */
export function createVscodeHostAdapter(
  transport: RpcMessageTransport,
  opts: {
    readonly kind?: HostKind;
    readonly timeoutMs?: number;
    readonly capabilities?: Partial<HostCapabilities>;
  } = {},
): HostAdapter & { readonly dispose: () => void } {
  const timeoutMs = opts.timeoutMs ?? 15000;
  const pending = new Map<
    string,
    {
      readonly resolve: (val: unknown) => void;
      readonly reject: (err: Error) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();

  const unsubscribe = transport.onMessage((rawMsg) => {
    const parsed = HostRpcResponseSchema.safeParse(rawMsg);
    if (!parsed.success) return;
    const entry = pending.get(parsed.data.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(parsed.data.id);

    if (parsed.data.error) {
      entry.reject(new Error(redactHostSecrets(parsed.data.error)));
    } else {
      entry.resolve(parsed.data.result);
    }
  });

  const callRpc = <T>(method: HostRpcMethod, params: Record<string, unknown>): Promise<T> =>
    new Promise((resolve, reject) => {
      const id = globalThis.crypto.randomUUID();
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Extension Host RPC timed out for "${method}"`));
      }, timeoutMs);

      pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });
      transport.postMessage({ id, method, params });
    });

  return {
    kind: opts.kind ?? 'vscode-webview',
    capabilities: {
      supportsDirectDiskSync: true,
      supportsNativeKeychain: true,
      supportsLocalProcessLaunch: true,
      supportsMcpServer: true,
      ...opts.capabilities,
    },
    fs: {
      readFile: async (relativePath) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        const res = await callRpc<{ base64?: string }>('readFile', { path: safePath });
        return decodeBytesBase64(String(res?.base64 ?? ''));
      },
      readText: async (relativePath) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        const res = await callRpc<{ base64?: string; text?: string }>('readFile', {
          path: safePath,
        });
        if (typeof res?.text === 'string') return res.text;
        return new TextDecoder().decode(decodeBytesBase64(String(res?.base64 ?? '')));
      },
      writeFile: async (relativePath, data) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
        await callRpc<boolean>('writeFile', {
          path: safePath,
          base64: encodeBytesBase64(bytes),
        });
      },
      listFiles: async (dirPath) => {
        const safeDir = dirPath ? assertSafeWorkspaceRelativePath(dirPath) : undefined;
        return callRpc<HostFileEntry[]>('listFiles', safeDir ? { dirPath: safeDir } : {});
      },
    },
    secrets: {
      getSecret: (key) => callRpc<string | null>('getSecret', { key }),
      setSecret: (key, value) => callRpc<void>('setSecret', { key, value }),
      deleteSecret: (key) => callRpc<void>('deleteSecret', { key }),
    },
    sync: {
      syncResFiles: async (projectId, files) => {
        const serialized = files.map((file) => {
          const relativePath = assertSafeWorkspaceRelativePath(file.relativePath);
          const bytes =
            typeof file.data === 'string' ? new TextEncoder().encode(file.data) : file.data;
          return {
            relativePath,
            base64: encodeBytesBase64(bytes),
          };
        });
        return callRpc<HostSyncResult>('syncResFiles', {
          projectId,
          files: serialized,
        });
      },
      openEditor: async (relativePath) => {
        const safePath = assertSafeWorkspaceRelativePath(relativePath);
        await callRpc<boolean>('openEditor', { path: safePath });
      },
      launchGodot: (launchOpts) =>
        callRpc<{ launched: boolean; pid?: number; message?: string }>('launchGodot', {
          ...(launchOpts?.workspacePath ? { workspacePath: launchOpts.workspacePath } : {}),
          ...(launchOpts?.scenePath ? { scenePath: launchOpts.scenePath } : {}),
        }),
    },
    antigravity: {
      detectAntigravity: () =>
        callRpc<{ detected: boolean; configDir: string }>('detectAntigravity', {}),
      linkAntigravityMcp: (linkOpts) =>
        callRpc<AntigravityLinkResult>('linkAntigravityMcp', linkOpts),
    },
    notify: (level, message) => {
      transport.postMessage({
        id: globalThis.crypto.randomUUID(),
        method: 'notify',
        params: { level, message },
      });
    },
    dispose: () => {
      unsubscribe();
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.reject(new Error('VS Code HostAdapter disposed before RPC completion.'));
      }
      pending.clear();
    },
  };
}

/**
 * Dispatches a validated Webview -> Extension Host RPC message with path validation
 * and secret-scrubbed error handling.
 */
export async function dispatchHostRpcRequest(
  rawReq: unknown,
  handlers: HostBridgeHandlers,
  opts: { readonly knownSecrets?: readonly string[] } = {},
): Promise<HostRpcResponse> {
  const parsed = HostRpcRequestSchema.safeParse(rawReq);
  if (!parsed.success) {
    return {
      id:
        typeof rawReq === 'object' && rawReq !== null && 'id' in rawReq
          ? String((rawReq as { id: unknown }).id)
          : 'unknown',
      ok: false,
      error: `Invalid RPC request: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
    };
  }

  const req = parsed.data;
  const scrub = (msg: string): string => redactHostSecrets(msg, opts.knownSecrets);

  try {
    switch (req.method) {
      case 'readFile': {
        const safePath = assertSafeWorkspaceRelativePath(req.params.path);
        if (handlers.readFile) {
          const bytes = await handlers.readFile(safePath);
          return {
            id: req.id,
            ok: true,
            result: { base64: encodeBytesBase64(bytes) },
          };
        }
        if (handlers.readText) {
          const text = await handlers.readText(safePath);
          return {
            id: req.id,
            ok: true,
            result: { base64: encodeBytesBase64(new TextEncoder().encode(text)), text },
          };
        }
        throw new Error('readFile handler is not mounted.');
      }

      case 'fs.readText': {
        const safePath = assertSafeWorkspaceRelativePath(req.params.path);
        if (handlers.readText) {
          return { id: req.id, ok: true, result: await handlers.readText(safePath) };
        }
        if (handlers.readFile) {
          const bytes = await handlers.readFile(safePath);
          return { id: req.id, ok: true, result: new TextDecoder().decode(bytes) };
        }
        throw new Error('fs.readText handler is not mounted.');
      }

      case 'writeFile': {
        const safePath = assertSafeWorkspaceRelativePath(req.params.path);
        const bytes =
          typeof req.params.base64 === 'string'
            ? decodeBytesBase64(req.params.base64)
            : new TextEncoder().encode(req.params.text ?? '');
        if (handlers.writeFile) {
          await handlers.writeFile(safePath, bytes);
          return { id: req.id, ok: true, result: true };
        }
        if (handlers.writeText) {
          await handlers.writeText(safePath, new TextDecoder().decode(bytes));
          return { id: req.id, ok: true, result: true };
        }
        throw new Error('writeFile handler is not mounted.');
      }

      case 'fs.writeText': {
        const safePath = assertSafeWorkspaceRelativePath(req.params.path);
        if (handlers.writeText) {
          await handlers.writeText(safePath, req.params.content);
          return { id: req.id, ok: true, result: true };
        }
        if (handlers.writeFile) {
          await handlers.writeFile(safePath, new TextEncoder().encode(req.params.content));
          return { id: req.id, ok: true, result: true };
        }
        throw new Error('fs.writeText handler is not mounted.');
      }

      case 'listFiles': {
        if (!handlers.listFiles) {
          throw new Error('listFiles handler is not mounted.');
        }
        const safeDir = req.params.dirPath
          ? assertSafeWorkspaceRelativePath(req.params.dirPath)
          : undefined;
        return {
          id: req.id,
          ok: true,
          result: await handlers.listFiles(safeDir),
        };
      }

      case 'getSecret':
      case 'secrets.get':
        return { id: req.id, ok: true, result: await handlers.getSecret(req.params.key) };

      case 'setSecret':
      case 'secrets.set':
        await handlers.setSecret(req.params.key, req.params.value);
        return { id: req.id, ok: true, result: true };

      case 'deleteSecret':
      case 'secrets.delete':
        await handlers.deleteSecret(req.params.key);
        return { id: req.id, ok: true, result: true };

      case 'syncResFiles': {
        if (!handlers.syncResFiles) {
          throw new Error('syncResFiles handler is not mounted.');
        }
        const decodedFiles: HostSyncFile[] = req.params.files.map((item) => ({
          relativePath: assertSafeWorkspaceRelativePath(item.relativePath),
          data:
            typeof item.base64 === 'string' ? decodeBytesBase64(item.base64) : (item.text ?? ''),
        }));
        return {
          id: req.id,
          ok: true,
          result: await handlers.syncResFiles(req.params.projectId, decodedFiles),
        };
      }

      case 'openEditor': {
        const safePath = assertSafeWorkspaceRelativePath(req.params.path);
        if (!handlers.openEditor) {
          throw new Error('openEditor handler is not mounted.');
        }
        await handlers.openEditor(safePath);
        return { id: req.id, ok: true, result: true };
      }

      case 'launchGodot':
      case 'godot.runSlice': {
        if (handlers.launchGodot) {
          return {
            id: req.id,
            ok: true,
            result: await handlers.launchGodot({
              ...(req.params.workspacePath ? { workspacePath: req.params.workspacePath } : {}),
              ...(req.params.scenePath ? { scenePath: req.params.scenePath } : {}),
            }),
          };
        }
        if (handlers.runGodotSlice) {
          return {
            id: req.id,
            ok: true,
            result: await handlers.runGodotSlice({
              ...(req.params.workspacePath ? { workspacePath: req.params.workspacePath } : {}),
              ...(req.params.scenePath ? { scenePath: req.params.scenePath } : {}),
            }),
          };
        }
        throw new Error('launchGodot handler is not mounted.');
      }

      case 'detectAntigravity':
      case 'antigravity.detect':
        return { id: req.id, ok: true, result: await handlers.detectAntigravity() };

      case 'linkAntigravityMcp':
      case 'antigravity.linkMcp':
        return {
          id: req.id,
          ok: true,
          result: await handlers.linkAntigravityMcp({
            ...(req.params.configDir ? { configDir: req.params.configDir } : {}),
            ...(req.params.workspacePath ? { workspacePath: req.params.workspacePath } : {}),
          }),
        };

      case 'notify':
      case 'ui.notify':
        handlers.notify(req.params.level, req.params.message);
        return { id: req.id, ok: true, result: true };
    }
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'Host RPC handler failed';
    return {
      id: req.id,
      ok: false,
      error: scrub(rawMsg),
    };
  }
}
