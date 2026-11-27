import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  activateNibgridExtension,
  DEFAULT_STARTUP_UPDATE_DELAY_MS,
  UPDATE_ETAG_KEY,
  UPDATE_LAST_CHECKED_AT_KEY,
  UPDATE_SKIPPED_VERSION_KEY,
  type VscodeStatusBarItemLike,
} from '../src/extension';
import { DEFAULT_UPDATE_CHECK_INTERVAL_MS } from '../src/updateCheckerCore';

const tmpDirs: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

function makeGlobalState(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    get: <T>(key: string, fallback?: T): T | undefined =>
      store.has(key) ? (store.get(key) as T) : fallback,
    update: async (key: string, value: unknown) => {
      store.set(key, value);
    },
  };
}

describe('M43C: Delayed Startup Update Check, Status Bar UX, globalState & Verified Install Wiring', () => {
  it('delays background check by 10s, throttles by 24h, persists ETag, and creates status bar item cleanly', async () => {
    vi.useFakeTimers();
    const now = 1_700_000_000_000;

    const releaseJson = {
      tag_name: 'v1.2.1',
      html_url: 'https://github.com/FranekJemiolo/nibgrid/releases/tag/v1.2.1',
      assets: [
        {
          name: 'Nibgrid-Studio-1.2.1-macos-arm64.dmg',
          browser_download_url:
            'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.1/Nibgrid-Studio-1.2.1-macos-arm64.dmg',
        },
        {
          name: 'SHA256SUMS.txt',
          browser_download_url:
            'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.1/SHA256SUMS.txt',
        },
      ],
    };

    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(releaseJson), {
          status: 200,
          headers: { ETag: '"etag-121"', 'Content-Type': 'application/json' },
        }),
    );

    const statusBarItem: VscodeStatusBarItemLike = {
      text: '',
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };

    const globalState = makeGlobalState();
    const subscriptions: { dispose: () => void }[] = [];
    const commands = new Map<string, () => unknown>();
    const messages: string[] = [];

    activateNibgridExtension(
      {
        secrets: {
          get: async () => undefined,
          store: async () => undefined,
          delete: async () => undefined,
        },
        globalState,
        subscriptions,
      },
      {
        registerCommand: (cmd, cb) => {
          commands.set(cmd, cb);
          return { dispose: () => undefined };
        },
        openNibgridPanel: () => undefined,
        showMessage: (_level, msg) => {
          messages.push(msg);
          return undefined;
        },
        createStatusBarItem: () => statusBarItem,
      },
      {
        currentVersion: '1.2.0',
        platform: 'macos-arm64',
        fetchImpl: fetchMock as unknown as typeof fetch,
        nowMs: () => now,
        detectAntigravity: async () => ({ detected: false, configDir: '~/.gemini/config' }),
        linkAntigravityMcp: async () => ({ ok: true, configPath: '', message: 'ok' }),
      },
    );

    expect(commands.has('nibgrid.checkForUpdates')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(DEFAULT_STARTUP_UPDATE_DELAY_MS - 10);
    expect(fetchMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(globalState.store.get(UPDATE_LAST_CHECKED_AT_KEY)).toBe(now);
    expect(globalState.store.get(UPDATE_ETAG_KEY)).toBe('"etag-121"');
    expect(statusBarItem.text).toBe('$(cloud-download) Nibgrid v1.2.1');
    expect(statusBarItem.show).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(0);

    for (const sub of subscriptions) sub.dispose();
    expect(statusBarItem.dispose).toHaveBeenCalledTimes(1);

    // Recent check (< 24h) skips network fetch cleanly; disposing before 10s cancels timer
    const recentState = makeGlobalState({
      [UPDATE_LAST_CHECKED_AT_KEY]: now - (DEFAULT_UPDATE_CHECK_INTERVAL_MS - 5000),
    });
    const fetchSkipped = vi.fn();
    const subs2: { dispose: () => void }[] = [];
    activateNibgridExtension(
      {
        secrets: {
          get: async () => undefined,
          store: async () => undefined,
          delete: async () => undefined,
        },
        globalState: recentState,
        subscriptions: subs2,
      },
      {
        registerCommand: () => ({ dispose: () => undefined }),
        openNibgridPanel: () => undefined,
        showMessage: () => undefined,
      },
      {
        currentVersion: '1.2.0',
        platform: 'macos-arm64',
        fetchImpl: fetchSkipped as unknown as typeof fetch,
        nowMs: () => now,
        detectAntigravity: async () => ({ detected: false, configDir: '' }),
        linkAntigravityMcp: async () => ({ ok: true, configPath: '', message: '' }),
      },
    );
    await vi.advanceTimersByTimeAsync(DEFAULT_STARTUP_UPDATE_DELAY_MS + 50);
    expect(fetchSkipped).not.toHaveBeenCalled();
    for (const sub of subs2) sub.dispose();
  });

  it('supports Skip This Version, Install Update inside withProgress, and manual offline fallback link', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'm43c-'));
    tmpDirs.push(tmpRoot);

    const payload = Buffer.from('nibgrid-v121-dmg-content');
    const digest = createHash('sha256').update(payload).digest('hex');

    const globalState = makeGlobalState();
    const statusBarItem: VscodeStatusBarItemLike = {
      text: '',
      show: vi.fn(),
      hide: vi.fn(),
      dispose: vi.fn(),
    };
    const commands = new Map<string, () => Promise<unknown> | unknown>();
    const subscriptions: { dispose: () => void }[] = [];
    const openedUrls: string[] = [];
    const progressTitles: string[] = [];
    const execCalls: { file: string; args: readonly string[] }[] = [];

    let nextPromptAction = 'Skip This Version';

    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.endsWith('SHA256SUMS.txt')) {
        return new Response(`${digest}  Nibgrid-Studio-1.2.1-macos-arm64.dmg\n`, { status: 200 });
      }
      if (target.endsWith('.dmg')) {
        return new Response(new Uint8Array(payload), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          tag_name: 'v1.2.1',
          html_url: 'https://github.com/FranekJemiolo/nibgrid/releases/tag/v1.2.1',
          assets: [
            {
              name: 'Nibgrid-Studio-1.2.1-macos-arm64.dmg',
              browser_download_url:
                'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.1/Nibgrid-Studio-1.2.1-macos-arm64.dmg',
            },
            {
              name: 'SHA256SUMS.txt',
              browser_download_url:
                'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.1/SHA256SUMS.txt',
            },
          ],
        }),
        { status: 200, headers: { ETag: '"etag-121"' } },
      );
    });

    activateNibgridExtension(
      {
        secrets: {
          get: async () => undefined,
          store: async () => undefined,
          delete: async () => undefined,
        },
        globalState,
        subscriptions,
      },
      {
        registerCommand: (cmd, cb) => {
          commands.set(cmd, cb);
          return { dispose: () => undefined };
        },
        openNibgridPanel: () => undefined,
        showMessage: (_level, _msg, ...actions) => {
          if (actions.includes('Skip This Version')) {
            return nextPromptAction;
          }
          if (actions.includes('View Releases on GitHub')) {
            return 'View Releases on GitHub';
          }
          return undefined;
        },
        createStatusBarItem: () => statusBarItem,
        withProgress: async (title, task) => {
          progressTitles.push(title);
          return task(() => undefined);
        },
        openExternal: (url) => {
          openedUrls.push(url);
        },
      },
      {
        currentVersion: '1.2.0',
        platform: 'macos-arm64',
        fetchImpl: fetchMock as unknown as typeof fetch,
        updaterTmpRootDir: tmpRoot,
        updaterExecFileImpl: (file, args) => {
          execCalls.push({ file, args });
        },
        detectAntigravity: async () => ({ detected: false, configDir: '' }),
        linkAntigravityMcp: async () => ({ ok: true, configPath: '', message: '' }),
      },
    );

    const checkCmd = commands.get('nibgrid.checkForUpdates')!;
    await checkCmd();
    expect(globalState.store.get(UPDATE_SKIPPED_VERSION_KEY)).toBe('1.2.1');
    expect(statusBarItem.hide).toHaveBeenCalled();

    nextPromptAction = 'Install Update';
    await checkCmd();
    expect(progressTitles).toEqual(['Installing Nibgrid Studio v1.2.1']);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]?.file).toBe('open');

    // Manual check during 403/offline shows View Releases on GitHub
    const offlineSubs: { dispose: () => void }[] = [];
    const offlineCmds = new Map<string, () => Promise<unknown> | unknown>();
    activateNibgridExtension(
      {
        secrets: {
          get: async () => undefined,
          store: async () => undefined,
          delete: async () => undefined,
        },
        globalState: makeGlobalState(),
        subscriptions: offlineSubs,
      },
      {
        registerCommand: (cmd, cb) => {
          offlineCmds.set(cmd, cb);
          return { dispose: () => undefined };
        },
        openNibgridPanel: () => undefined,
        showMessage: (_level, _msg, ...actions) =>
          actions.includes('View Releases on GitHub') ? 'View Releases on GitHub' : undefined,
        openExternal: (url) => {
          openedUrls.push(url);
        },
      },
      {
        currentVersion: '1.2.0',
        platform: 'macos-arm64',
        fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch,
        detectAntigravity: async () => ({ detected: false, configDir: '' }),
        linkAntigravityMcp: async () => ({ ok: true, configPath: '', message: '' }),
      },
    );
    await offlineCmds.get('nibgrid.checkForUpdates')!();
    expect(openedUrls).toContain('https://github.com/FranekJemiolo/nibgrid/releases/latest');

    for (const sub of subscriptions) sub.dispose();
    for (const sub of offlineSubs) sub.dispose();
  });
});
