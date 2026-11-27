import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { HostSecretStore } from '../../../src/platform/hostAdapter';
import { registerNibgridCustomEditors, type VscodeCustomEditorRegistryLike } from './customEditors';
import { NIBGRID_MCP_TOOLS } from './mcpToolServer';
import {
  publishQaDiagnostics,
  registerNibgridTreeProviders,
  type VscodeDiagnosticCollectionLike,
  type VscodeTreeRegistryLike,
} from './treeProviders';
import { dispatchHostRpcRequest, type HostBridgeHandlers } from './vscodeHostBridge';
import type { ArtDirectorQaReport } from '../../../src/processing/artDirectorQaSchema';

export interface VscodeSecretStorageLike {
  get: (key: string) => Promise<string | undefined>;
  store: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export interface VscodeExtensionContextLike {
  readonly secrets: VscodeSecretStorageLike;
  readonly subscriptions: { dispose: () => void }[];
}

export interface ExecFileProcessLike {
  readonly pid?: number;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
}

export type ExecFileLike = (
  file: string,
  args: readonly string[],
  options: { readonly windowsHide?: boolean; readonly signal?: AbortSignal },
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
) => ExecFileProcessLike;

export interface GodotLaunchHandle {
  readonly launched: true;
  readonly binary: string;
  readonly args: readonly string[];
  readonly workspacePath: string;
  readonly scenePath: string;
  readonly pid?: number;
  readonly cancel: () => void;
}

export interface VscodeHostApiLike {
  registerCommand: (command: string, callback: () => unknown) => { dispose: () => void };
  openNibgridPanel: (onMessage: (raw: unknown) => Promise<unknown>) => void;
  runTerminalCommand?: (command: string, cwd?: string) => void;
  showMessage: (level: 'info' | 'warn' | 'error', msg: string) => void;
  readonly customEditorRegistry?: VscodeCustomEditorRegistryLike;
  readonly treeRegistry?: VscodeTreeRegistryLike;
  readonly qaDiagnosticCollection?: VscodeDiagnosticCollectionLike;
}

const UNSAFE_BINARY_CHARS = /[;&|$`<>!\n\r]/;
const SAFE_SCENE_RES_PATH = /^res:\/\/[A-Za-z0-9_./-]+\.tscn$/;

/**
 * Validates workspace/scene inputs and launches Godot cleanly via `execFile`
 * (`shell: false`, zero shell-string concatenation) with clean cancellation support.
 */
export function runGodotWorkspaceScene(opts: {
  readonly workspacePath: string;
  readonly scenePath?: string;
  readonly godotBinary?: string;
  readonly execFileImpl?: ExecFileLike;
  readonly signal?: AbortSignal;
}): GodotLaunchHandle {
  const cleanWorkspace = opts.workspacePath.trim();
  if (!cleanWorkspace || cleanWorkspace.includes('\0')) {
    throw new Error('Godot workspace path cannot be empty.');
  }
  const resolvedWorkspace = resolve(cleanWorkspace);

  const scenePath = (opts.scenePath ?? 'res://main.tscn').trim();
  if (!SAFE_SCENE_RES_PATH.test(scenePath) || scenePath.includes('..')) {
    throw new Error(`Invalid Godot res:// scene path "${scenePath}".`);
  }

  const binary = (opts.godotBinary ?? 'godot').trim();
  if (!binary || UNSAFE_BINARY_CHARS.test(binary)) {
    throw new Error(`Unsafe Godot executable path "${binary}".`);
  }

  const args = ['--path', resolvedWorkspace, scenePath] as const;
  const controller = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) {
      controller.abort();
    } else {
      opts.signal.addEventListener('abort', () => controller.abort(), { once: true });
    }
  }

  const runner: ExecFileLike =
    opts.execFileImpl ??
    ((file, callArgs, options, cb) =>
      execFile(file, [...callArgs], options, cb ?? (() => undefined)));

  const proc = runner(
    binary,
    args,
    { windowsHide: true, signal: controller.signal },
    () => undefined,
  );

  return {
    launched: true,
    binary,
    args,
    workspacePath: resolvedWorkspace,
    scenePath,
    ...(typeof proc.pid === 'number' ? { pid: proc.pid } : {}),
    cancel: () => {
      controller.abort();
      proc.kill?.('SIGTERM');
    },
  };
}

/**
 * Creates a `HostSecretStore` backed exclusively by VS Code OS Keychain `context.secrets`
 * (never writing credentials to `workspaceState`, `settings.json`, or files).
 */
export function createKeychainSecretStore(
  secrets: VscodeSecretStorageLike,
  trackedSecrets = new Set<string>(),
): HostSecretStore & { readonly getKnownSecrets: () => readonly string[] } {
  return {
    getSecret: async (key) => {
      const val = (await secrets.get(key)) ?? null;
      if (val && val.trim().length >= 4) {
        trackedSecrets.add(val);
      }
      return val;
    },
    setSecret: async (key, value) => {
      if (value.trim().length >= 4) {
        trackedSecrets.add(value);
      }
      await secrets.store(key, value);
    },
    deleteSecret: async (key) => {
      await secrets.delete(key);
    },
    getKnownSecrets: () => Array.from(trackedSecrets),
  };
}

export interface ActivateNibgridDeps {
  readonly workspacePath?: string;
  readonly detectAntigravity: HostBridgeHandlers['detectAntigravity'];
  readonly linkAntigravityMcp: HostBridgeHandlers['linkAntigravityMcp'];
  readonly syncGodotProject?: () => Promise<{
    readonly writtenCount: number;
    readonly message?: string;
  }>;
  readonly execFileImpl?: ExecFileLike;
  readonly godotBinary?: string;
  readonly qaReport?: ArtDirectorQaReport | null;
  readonly resolveSpriteUri?: (spriteId: string) => string;
}

/**
 * Pure TypeScript VS Code / Cursor / Nibgrid Desktop Extension Host activation wiring
 * (zero direct `@types/vscode` compile-time lock-in).
 */
export function activateNibgridExtension(
  context: VscodeExtensionContextLike,
  hostApi: VscodeHostApiLike,
  depsOrAntigravity:
    ActivateNibgridDeps | Pick<HostBridgeHandlers, 'detectAntigravity' | 'linkAntigravityMcp'>,
): {
  readonly registeredCommands: readonly string[];
  readonly mcpToolCount: number;
  readonly activeGodotLaunches: readonly GodotLaunchHandle[];
} {
  const deps: ActivateNibgridDeps =
    'syncGodotProject' in depsOrAntigravity || 'workspacePath' in depsOrAntigravity
      ? (depsOrAntigravity as ActivateNibgridDeps)
      : {
          detectAntigravity: depsOrAntigravity.detectAntigravity,
          linkAntigravityMcp: depsOrAntigravity.linkAntigravityMcp,
        };

  const keychain = createKeychainSecretStore(context.secrets);
  const activeLaunches: GodotLaunchHandle[] = [];

  const launchScene = (opts?: { workspacePath?: string; scenePath?: string }) => {
    const targetWorkspace = opts?.workspacePath ?? deps.workspacePath;
    if (!targetWorkspace && hostApi.runTerminalCommand) {
      hostApi.runTerminalCommand('godot --path . res://main.tscn');
      return { launched: true };
    }
    const handle = runGodotWorkspaceScene({
      workspacePath: targetWorkspace ?? '.',
      ...(opts?.scenePath ? { scenePath: opts.scenePath } : {}),
      ...(deps.godotBinary ? { godotBinary: deps.godotBinary } : {}),
      ...(deps.execFileImpl ? { execFileImpl: deps.execFileImpl } : {}),
    });
    activeLaunches.push(handle);
    return { launched: true, ...(handle.pid !== undefined ? { pid: handle.pid } : {}) };
  };

  const handlers: HostBridgeHandlers = {
    getSecret: keychain.getSecret,
    setSecret: keychain.setSecret,
    deleteSecret: keychain.deleteSecret,
    detectAntigravity: deps.detectAntigravity,
    linkAntigravityMcp: deps.linkAntigravityMcp,
    launchGodot: async (opts) => launchScene(opts),
    runGodotSlice: async (opts) => ({ launched: launchScene(opts).launched }),
    notify: (level, message) => hostApi.showMessage(level, message),
  };

  const registeredCommands = [
    'nibgrid.openStudio',
    'nibgrid.syncGodot',
    'nibgrid.runGodotSlice',
    'nibgrid.linkAntigravity',
  ];

  context.subscriptions.push(
    hostApi.registerCommand('nibgrid.openStudio', () => {
      hostApi.openNibgridPanel((raw) =>
        dispatchHostRpcRequest(raw, handlers, { knownSecrets: keychain.getKnownSecrets() }),
      );
    }),
    hostApi.registerCommand('nibgrid.syncGodot', async () => {
      if (!deps.syncGodotProject) {
        hostApi.showMessage('info', 'Nibgrid: Open Studio to bind a Godot project for sync.');
        return;
      }
      const res = await deps.syncGodotProject();
      hostApi.showMessage(
        'info',
        res.message ?? `Synced ${res.writtenCount} Godot res:// files cleanly.`,
      );
    }),
    hostApi.registerCommand('nibgrid.runGodotSlice', () => {
      launchScene();
    }),
    hostApi.registerCommand('nibgrid.linkAntigravity', async () => {
      const res = await deps.linkAntigravityMcp({
        ...(deps.workspacePath ? { workspacePath: deps.workspacePath } : {}),
      });
      hostApi.showMessage(res.ok ? 'info' : 'error', res.message);
    }),
    {
      dispose: () => {
        for (const launch of activeLaunches) {
          launch.cancel();
        }
      },
    },
  );

  if (hostApi.customEditorRegistry) {
    context.subscriptions.push(
      ...registerNibgridCustomEditors(hostApi.customEditorRegistry, handlers, {
        getKnownSecrets: keychain.getKnownSecrets,
      }),
    );
  }

  if (hostApi.treeRegistry) {
    const trees = registerNibgridTreeProviders(hostApi.treeRegistry, {
      qaReport: deps.qaReport ?? null,
    });
    context.subscriptions.push(...trees.disposables);
  }

  if (hostApi.qaDiagnosticCollection && deps.qaReport) {
    publishQaDiagnostics(
      hostApi.qaDiagnosticCollection,
      deps.qaReport,
      deps.resolveSpriteUri ?? ((id) => `nibgrid://sprite/${id}`),
      { knownSecrets: keychain.getKnownSecrets() },
    );
  }

  return {
    registeredCommands,
    mcpToolCount: NIBGRID_MCP_TOOLS.length,
    activeGodotLaunches: activeLaunches,
  };
}
