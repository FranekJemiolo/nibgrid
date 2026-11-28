import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import type { ArtDirectorQaReport } from '../../../src/processing/artDirectorQaSchema';
import {
  DEFAULT_GITHUB_REPO,
  detectDesktopPlatform,
  getLatestReleasesFallbackUrl,
  type DesktopPlatform,
} from '../../../src/platform/desktopInstaller';
import type { HostSecretStore } from '../../../src/platform/hostAdapter';
import { registerNibgridCustomEditors, type VscodeCustomEditorRegistryLike } from './customEditors';
import {
  ChecksumMismatchError,
  downloadAndVerifyUpdate,
  handoffVerifiedInstaller,
  type UpdaterExecFileLike,
  type UpdaterFsLike,
} from './desktopUpdater';
import { NIBGRID_MCP_TOOLS } from './mcpToolServer';
import {
  publishQaDiagnostics,
  registerNibgridTreeProviders,
  type VscodeDiagnosticCollectionLike,
  type VscodeTreeRegistryLike,
} from './treeProviders';
import {
  checkForDesktopUpdate,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  shouldRunAutoUpdateCheck,
  type UpdateCheckResult,
} from './updateCheckerCore';
import { dispatchHostRpcRequest, type HostBridgeHandlers } from './vscodeHostBridge';

export const UPDATE_LAST_CHECKED_AT_KEY = 'nibgrid.updateLastCheckedAt';
export const UPDATE_ETAG_KEY = 'nibgrid.updateEtag';
export const UPDATE_SKIPPED_VERSION_KEY = 'nibgrid.updateSkippedVersion';
export const DEFAULT_STARTUP_UPDATE_DELAY_MS = 10_000;

export interface VscodeSecretStorageLike {
  get: (key: string) => Promise<string | undefined>;
  store: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export interface VscodeMementoLike {
  get: <T>(key: string, defaultValue?: T) => T | undefined;
  update: (key: string, value: unknown) => Promise<void> | void;
}

export interface VscodeStatusBarItemLike {
  text: string;
  tooltip?: string;
  command?: string;
  show: () => void;
  hide: () => void;
  dispose: () => void;
}

export interface VscodeExtensionContextLike {
  readonly secrets: VscodeSecretStorageLike;
  readonly globalState?: VscodeMementoLike;
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
  showMessage: (
    level: 'info' | 'warn' | 'error',
    msg: string,
    ...actions: string[]
  ) => Promise<string | undefined> | string | undefined | void;
  createStatusBarItem?: () => VscodeStatusBarItemLike;
  withProgress?: <T>(
    title: string,
    task: (report: (message: string) => void) => Promise<T>,
  ) => Promise<T>;
  openExternal?: (url: string) => Promise<boolean | void> | boolean | void;
  getAutoCheckUpdates?: () => boolean;
  readonly customEditorRegistry?: VscodeCustomEditorRegistryLike;
  readonly treeRegistry?: VscodeTreeRegistryLike;
  readonly qaDiagnosticCollection?: VscodeDiagnosticCollectionLike;
}

const UNSAFE_BINARY_CHARS = /[;&|$`<>!\n\r]/;
const SAFE_SCENE_RES_PATH = /^res:\/\/[A-Za-z0-9_./-]+\.tscn$/;

/**
 * Maps Node's `process.platform` and `process.arch` deterministically to a
 * `DesktopPlatform` release asset target.
 */
export function detectNodeDesktopPlatform(
  platform: string = process.platform,
  arch: string = process.arch,
): DesktopPlatform {
  if (platform === 'win32') return 'win-x64';
  if (platform === 'linux') return 'linux-x64';
  if (platform === 'darwin') {
    return arch === 'x64' ? 'macos-x64' : 'macos-arm64';
  }
  return detectDesktopPlatform({ platform, architecture: arch });
}

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

export interface HeadlessGodotCheckResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly diagnostics: readonly string[];
}

/**
 * Runs `godot --headless --path <workspacePath> --check-only --quit` safely via `execFile`
 * (`shell: false`) to surface scene/GDScript parse errors right after `res://` sync.
 */
export function validateGodotProjectHeadless(opts: {
  readonly workspacePath: string;
  readonly godotBinary?: string;
  readonly execFileImpl?: ExecFileLike;
  readonly signal?: AbortSignal;
}): Promise<HeadlessGodotCheckResult> {
  const cleanWorkspace = opts.workspacePath.trim();
  if (!cleanWorkspace || cleanWorkspace.includes('\0')) {
    return Promise.reject(new Error('Godot workspace path cannot be empty.'));
  }
  const binary = (opts.godotBinary ?? 'godot').trim();
  if (!binary || UNSAFE_BINARY_CHARS.test(binary)) {
    return Promise.reject(new Error(`Unsafe Godot executable path "${binary}".`));
  }

  const resolvedWorkspace = resolve(cleanWorkspace);
  const args = ['--headless', '--path', resolvedWorkspace, '--check-only', '--quit'];

  return new Promise((resolvePromise) => {
    const runner: ExecFileLike =
      opts.execFileImpl ??
      ((file, callArgs, options, cb) =>
        execFile(file, [...callArgs], options, cb ?? (() => undefined)));

    runner(binary, args, { windowsHide: true, signal: opts.signal }, (error, stdout, stderr) => {
      const cleanOut = String(stdout ?? '');
      const cleanErr = String(stderr ?? '');
      const diagnostics = `${cleanErr}\n${cleanOut}`
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => /\b(error|failed|parse error|script error)\b/i.test(line));
      resolvePromise({
        ok: !error && diagnostics.length === 0,
        exitCode: error ? 1 : 0,
        stdout: cleanOut,
        stderr: cleanErr,
        diagnostics,
      });
    });
  });
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
  readonly currentVersion?: string;
  readonly platform?: DesktopPlatform;
  readonly supportsLocalProcessLaunch?: boolean;
  readonly fetchImpl?: typeof fetch;
  readonly updaterExecFileImpl?: UpdaterExecFileLike;
  readonly updaterFsImpl?: UpdaterFsLike;
  readonly updaterHomeDir?: string;
  readonly updaterTmpRootDir?: string;
  readonly quitApp?: () => Promise<void> | void;
  readonly updateStartupDelayMs?: number;
  readonly updateCheckIntervalMs?: number;
  readonly nowMs?: () => number;
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
  readonly checkForUpdatesNow: () => Promise<UpdateCheckResult>;
} {
  const deps: ActivateNibgridDeps = depsOrAntigravity;

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

  const currentVersion = deps.currentVersion ?? '0.1.0';
  const targetPlatform = deps.platform ?? detectNodeDesktopPlatform();
  const nowMs = deps.nowMs ?? (() => Date.now());
  let statusBarItem: VscodeStatusBarItemLike | null = null;
  let pendingUpdate: UpdateCheckResult | null = null;
  let startupTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const ensureStatusBarItem = (latestVersion: string) => {
    if (!hostApi.createStatusBarItem) return;
    if (!statusBarItem) {
      statusBarItem = hostApi.createStatusBarItem();
    }
    statusBarItem.text = `$(cloud-download) Nibgrid v${latestVersion}`;
    statusBarItem.tooltip = `Nibgrid Studio v${latestVersion} is available (running v${currentVersion})`;
    statusBarItem.command = 'nibgrid.checkForUpdates';
    statusBarItem.show();
  };

  const installVerifiedUpdate = async (update: UpdateCheckResult): Promise<void> => {
    const runTask = async (report: (msg: string) => void) => {
      report('Downloading and verifying SHA-256 installer...');
      const downloaded = await downloadAndVerifyUpdate(update, {
        fetchImpl: deps.fetchImpl,
        tmpRootDir: deps.updaterTmpRootDir,
        onProgress: report,
      });
      report('Launching verified installer...');
      return handoffVerifiedInstaller(targetPlatform, downloaded.installerPath, {
        execFileImpl: deps.updaterExecFileImpl,
        fsImpl: deps.updaterFsImpl,
        homeDir: deps.updaterHomeDir,
        quitApp: deps.quitApp,
      });
    };

    try {
      const handoff = hostApi.withProgress
        ? await hostApi.withProgress(`Installing Nibgrid Studio v${update.latestVersion}`, runTask)
        : await runTask(() => undefined);
      if (!handoff.quitRequested) {
        await hostApi.showMessage(
          'info',
          `Verified installer ready (${handoff.action}). Restart Nibgrid Studio to complete update to v${update.latestVersion}.`,
        );
      }
    } catch (err) {
      const message =
        err instanceof ChecksumMismatchError
          ? `Update aborted: ${err.message}`
          : err instanceof Error
            ? `Failed to install update: ${err.message}`
            : 'Failed to install update.';
      await hostApi.showMessage('error', message);
    }
  };

  const promptForUpdate = async (update: UpdateCheckResult): Promise<void> => {
    if (disposed || !update.latestVersion) return;
    const choice = await hostApi.showMessage(
      'info',
      `Nibgrid Studio v${update.latestVersion} is available (running v${update.currentVersion}).`,
      'Install Update',
      'Release Notes',
      'Skip This Version',
    );
    if (choice === 'Install Update') {
      await installVerifiedUpdate(update);
    } else if (choice === 'Release Notes' && update.releaseUrl) {
      await hostApi.openExternal?.(update.releaseUrl);
    } else if (choice === 'Skip This Version') {
      await context.globalState?.update(UPDATE_SKIPPED_VERSION_KEY, update.latestVersion);
      pendingUpdate = null;
      statusBarItem?.hide();
    }
  };

  const runUpdateCheck = async (manual: boolean): Promise<UpdateCheckResult> => {
    const savedEtag = context.globalState?.get<string>(UPDATE_ETAG_KEY);
    const savedSkipped = manual
      ? undefined
      : context.globalState?.get<string>(UPDATE_SKIPPED_VERSION_KEY);

    const result = await checkForDesktopUpdate({
      currentVersion,
      platform: targetPlatform,
      ...(savedSkipped ? { skippedVersion: savedSkipped } : {}),
      ...(savedEtag ? { etag: savedEtag } : {}),
      ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
    });

    if (disposed) return result;

    if (result.status !== 'offline-or-ratelimited') {
      await context.globalState?.update(UPDATE_LAST_CHECKED_AT_KEY, nowMs());
      if (result.etag) {
        await context.globalState?.update(UPDATE_ETAG_KEY, result.etag);
      }
    }

    if (result.status === 'offline-or-ratelimited') {
      if (manual) {
        const action = await hostApi.showMessage(
          'info',
          'Offline or rate-limited — view releases on GitHub.',
          'View Releases on GitHub',
        );
        if (action === 'View Releases on GitHub') {
          await hostApi.openExternal?.(
            result.releaseUrl ?? getLatestReleasesFallbackUrl(DEFAULT_GITHUB_REPO),
          );
        }
      }
      return result;
    }

    if (result.status === 'update-available' && result.latestVersion) {
      pendingUpdate = result;
      ensureStatusBarItem(result.latestVersion);
      if (manual) {
        await promptForUpdate(result);
      }
      return result;
    }

    pendingUpdate = null;
    statusBarItem?.hide();
    if (manual) {
      await hostApi.showMessage('info', `Nibgrid Studio v${currentVersion} is up to date.`);
    }
    return result;
  };

  const registeredCommands = [
    'nibgrid.openStudio',
    'nibgrid.syncGodot',
    'nibgrid.runGodotSlice',
    'nibgrid.linkAntigravity',
    'nibgrid.checkForUpdates',
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
    hostApi.registerCommand('nibgrid.checkForUpdates', async () => {
      if (pendingUpdate) {
        const cached = pendingUpdate;
        await promptForUpdate(cached);
        return cached;
      }
      return runUpdateCheck(true);
    }),
    {
      dispose: () => {
        disposed = true;
        if (startupTimer !== null) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        statusBarItem?.dispose();
        statusBarItem = null;
        for (const launch of activeLaunches) {
          launch.cancel();
        }
      },
    },
  );

  const supportsLocalLaunch = deps.supportsLocalProcessLaunch ?? true;
  const autoCheckEnabled = hostApi.getAutoCheckUpdates ? hostApi.getAutoCheckUpdates() : true;
  if (supportsLocalLaunch && autoCheckEnabled) {
    const delayMs = deps.updateStartupDelayMs ?? DEFAULT_STARTUP_UPDATE_DELAY_MS;
    const intervalMs = deps.updateCheckIntervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS;
    startupTimer = setTimeout(() => {
      startupTimer = null;
      if (disposed) return;
      const lastCheckedAt = context.globalState?.get<number>(UPDATE_LAST_CHECKED_AT_KEY);
      if (shouldRunAutoUpdateCheck(lastCheckedAt, nowMs(), intervalMs)) {
        void runUpdateCheck(false);
      }
    }, delayMs);
    if (typeof startupTimer === 'object' && startupTimer !== null && 'unref' in startupTimer) {
      (startupTimer as { unref?: () => void }).unref?.();
    }
  }

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
    checkForUpdatesNow: () => runUpdateCheck(true),
  };
}
