export type HostKind = 'browser' | 'vscode-webview' | 'nibgrid-desktop';

export interface HostSecretsAdapter {
  readonly getSecret: (key: string) => Promise<string | null>;
  readonly setSecret: (key: string, value: string) => Promise<void>;
  readonly deleteSecret: (key: string) => Promise<void>;
}

export interface AntigravityLinkResult {
  readonly ok: boolean;
  readonly configPath: string;
  readonly backupPath?: string;
  readonly mergedConfigJson?: string;
  readonly message: string;
}

export interface HostAntigravityBridge {
  readonly detectAntigravity: () => Promise<{
    readonly detected: boolean;
    readonly configDir: string;
  }>;
  readonly linkAntigravityMcp: (opts: {
    readonly configDir?: string;
    readonly workspacePath?: string;
  }) => Promise<AntigravityLinkResult>;
}

export interface HostAdapter {
  readonly kind: HostKind;
  readonly secrets: HostSecretsAdapter;
  readonly antigravity: HostAntigravityBridge;
  readonly notify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface GlobalNibgridHostBridge {
  readonly hostKind?: HostKind;
  readonly secrets?: HostSecretsAdapter;
  readonly antigravity?: HostAntigravityBridge;
}

interface VscodeWebviewApiLike {
  postMessage: (msg: unknown) => void;
}

declare global {
  interface Window {
    __nibgridHostBridge?: GlobalNibgridHostBridge;
    acquireVsCodeApi?: () => VscodeWebviewApiLike;
  }
}

const MEMORY_SECRETS = new Map<string, string>();

/**
 * Browser PWA HostAdapter backed by volatile in-memory secrets (IndexedDB handles
 * long-lived vault storage separately) and optional desktop/IDE test hooks.
 */
export function createBrowserHostAdapter(): HostAdapter {
  return {
    kind: 'browser',
    secrets: {
      getSecret: async (key) => MEMORY_SECRETS.get(key) ?? null,
      setSecret: async (key, value) => {
        MEMORY_SECRETS.set(key, value);
      },
      deleteSecret: async (key) => {
        MEMORY_SECRETS.delete(key);
      },
    },
    antigravity: {
      detectAntigravity: async () => {
        if (typeof window !== 'undefined' && window.__nibgridHostBridge?.antigravity) {
          return window.__nibgridHostBridge.antigravity.detectAntigravity();
        }
        return { detected: false, configDir: '~/.gemini/config' };
      },
      linkAntigravityMcp: async (opts) => {
        if (typeof window !== 'undefined' && window.__nibgridHostBridge?.antigravity) {
          return window.__nibgridHostBridge.antigravity.linkAntigravityMcp(opts);
        }
        const snippet = JSON.stringify(
          {
            mcpServers: {
              nibgrid: {
                command: 'node',
                args: ['packages/vscode-extension/src/mcpToolServer.ts'],
                env: { NIBGRID_WORKSPACE: opts.workspacePath ?? '.' },
              },
            },
          },
          null,
          2,
        );
        return {
          ok: true,
          configPath: `${opts.configDir ?? '~/.gemini/config'}/mcp_config.json`,
          mergedConfigJson: snippet,
          message:
            'Generated clean mcp_config.json entry (run inside Nibgrid Desktop / VS Code Extension to write directly to ~/.gemini/config/mcp_config.json).',
        };
      },
    },
    notify: (_level, _message) => undefined,
  };
}

/**
 * VS Code / Standalone Desktop Webview HostAdapter delegating OS Keychain SecretStorage
 * and `~/.gemini/config/mcp_config.json` writes over typed Extension Host postMessage RPC.
 */
export function createVscodeWebviewHostAdapter(
  vscodeApi: VscodeWebviewApiLike,
  kind: HostKind = 'vscode-webview',
): HostAdapter {
  const sendRpc = <T>(method: string, params: Record<string, unknown>): Promise<T> =>
    new Promise((resolve, reject) => {
      if (typeof window === 'undefined') {
        reject(new Error('Webview RPC requires browser window context.'));
        return;
      }
      const id = globalThis.crypto.randomUUID();
      const timeout = window.setTimeout(() => {
        window.removeEventListener('message', onMsg);
        reject(new Error(`Extension Host RPC timed out for "${method}"`));
      }, 15000);

      const onMsg = (ev: MessageEvent<{ id?: string; result?: T; error?: string }>) => {
        if (!ev.data || ev.data.id !== id) return;
        window.clearTimeout(timeout);
        window.removeEventListener('message', onMsg);
        if (ev.data.error) {
          reject(new Error(ev.data.error));
        } else {
          resolve(ev.data.result as T);
        }
      };

      window.addEventListener('message', onMsg);
      vscodeApi.postMessage({ id, method, params });
    });

  return {
    kind,
    secrets: {
      getSecret: (key) => sendRpc<string | null>('secrets.get', { key }),
      setSecret: (key, value) => sendRpc<void>('secrets.set', { key, value }),
      deleteSecret: (key) => sendRpc<void>('secrets.delete', { key }),
    },
    antigravity: {
      detectAntigravity: () =>
        sendRpc<{ detected: boolean; configDir: string }>('antigravity.detect', {}),
      linkAntigravityMcp: (opts) => sendRpc<AntigravityLinkResult>('antigravity.linkMcp', opts),
    },
    notify: (level, message) => {
      vscodeApi.postMessage({
        id: globalThis.crypto.randomUUID(),
        method: 'ui.notify',
        params: { level, message },
      });
    },
  };
}

let cachedVscodeAdapter: HostAdapter | null = null;

/**
 * Resolves the active host adapter (`__nibgridHostBridge` override -> VS Code Webview -> Browser PWA).
 */
export function getActiveHostAdapter(): HostAdapter {
  if (typeof window !== 'undefined' && window.__nibgridHostBridge) {
    const base = createBrowserHostAdapter();
    return {
      kind: window.__nibgridHostBridge.hostKind ?? 'nibgrid-desktop',
      secrets: window.__nibgridHostBridge.secrets ?? base.secrets,
      antigravity: window.__nibgridHostBridge.antigravity ?? base.antigravity,
      notify: base.notify,
    };
  }
  if (typeof window !== 'undefined' && typeof window.acquireVsCodeApi === 'function') {
    if (!cachedVscodeAdapter) {
      cachedVscodeAdapter = createVscodeWebviewHostAdapter(
        window.acquireVsCodeApi(),
        'vscode-webview',
      );
    }
    return cachedVscodeAdapter;
  }
  return createBrowserHostAdapter();
}
