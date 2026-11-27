import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ChecksumMismatchError,
  downloadAndVerifyUpdate,
  handoffVerifiedInstaller,
  verifyFileSha256,
  type UpdaterExecFileLike,
} from '../src/desktopUpdater';
import type { UpdateCheckResult } from '../src/updateCheckerCore';

const tempRootsToClean: string[] = [];

afterEach(async () => {
  while (tempRootsToClean.length > 0) {
    const dir = tempRootsToClean.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

function sha256Hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('M43B: Streaming SHA-256 Verifier, Cleanup on Tamper & Safe OS Handoff', () => {
  it('verifies a matching downloaded artifact and hands off cleanly per OS via execFile', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'm43b-valid-'));
    tempRootsToClean.push(tmpRoot);

    const payload = Buffer.from('nibgrid-studio-signed-installer-payload');
    const digest = sha256Hex(payload);
    const dmgUpdate: UpdateCheckResult = {
      status: 'update-available',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      releaseUrl: 'https://github.com/FranekJemiolo/nibgrid/releases/tag/v0.2.0',
      assetFilename: 'Nibgrid-Studio-0.2.0-macos-arm64.dmg',
      assetDownloadUrl:
        'https://github.com/FranekJemiolo/nibgrid/releases/download/v0.2.0/Nibgrid-Studio-0.2.0-macos-arm64.dmg',
      checksumsUrl:
        'https://github.com/FranekJemiolo/nibgrid/releases/download/v0.2.0/SHA256SUMS.txt',
    };

    const sumsText = `${digest}  Nibgrid-Studio-0.2.0-macos-arm64.dmg\n`;
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('SHA256SUMS.txt')) {
        return new Response(sumsText, { status: 200 });
      }
      return new Response(new Uint8Array(payload), { status: 200 });
    });

    const verified = await downloadAndVerifyUpdate(dmgUpdate, {
      fetchImpl: fetchMock as unknown as typeof fetch,
      tmpRootDir: tmpRoot,
    });
    expect(verified.sha256).toBe(digest);
    expect(existsSync(verified.installerPath)).toBe(true);
    expect(await verifyFileSha256(verified.installerPath, digest)).toBe(true);

    const execCalls: { file: string; args: readonly string[]; detached?: boolean }[] = [];
    const mockExecFile: UpdaterExecFileLike = (file, args, options) => {
      execCalls.push({ file, args, detached: options.detached });
      return { pid: 4301, unref: vi.fn() };
    };

    const macRes = await handoffVerifiedInstaller('macos-arm64', verified.installerPath, {
      execFileImpl: mockExecFile,
    });
    expect(macRes).toEqual({
      launched: true,
      platform: 'macos-arm64',
      action: 'opened-dmg',
      targetPath: verified.installerPath,
      quitRequested: false,
    });
    expect(execCalls[0]).toEqual({
      file: 'open',
      args: [verified.installerPath],
      detached: undefined,
    });

    const quitApp = vi.fn();
    const winRes = await handoffVerifiedInstaller('win-x64', 'C:\\Temp\\Nibgrid-Setup.exe', {
      execFileImpl: mockExecFile,
      quitApp,
    });
    expect(winRes.action).toBe('launched-silent-installer');
    expect(winRes.quitRequested).toBe(true);
    expect(quitApp).toHaveBeenCalledTimes(1);
    expect(execCalls[1]).toEqual({
      file: 'C:\\Temp\\Nibgrid-Setup.exe',
      args: ['/SILENT'],
      detached: true,
    });

    const fakeHome = await mkdtemp(join(tmpdir(), 'm43b-linux-home-'));
    tempRootsToClean.push(fakeHome);
    const linuxUpdate: UpdateCheckResult = {
      ...dmgUpdate,
      assetFilename: 'Nibgrid-Studio-0.2.0-linux-x64.AppImage',
      assetDownloadUrl:
        'https://github.com/FranekJemiolo/nibgrid/releases/download/v0.2.0/Nibgrid-Studio-0.2.0-linux-x64.AppImage',
    };
    const linuxFetch = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('SHA256SUMS.txt')) {
        return new Response(`${digest}  Nibgrid-Studio-0.2.0-linux-x64.AppImage\n`, {
          status: 200,
        });
      }
      return new Response(new Uint8Array(payload), { status: 200 });
    });
    const verifiedLinux = await downloadAndVerifyUpdate(linuxUpdate, {
      fetchImpl: linuxFetch as unknown as typeof fetch,
      tmpRootDir: tmpRoot,
    });
    const linuxRes = await handoffVerifiedInstaller('linux-x64', verifiedLinux.installerPath, {
      execFileImpl: mockExecFile,
      homeDir: fakeHome,
    });
    expect(linuxRes).toEqual({
      launched: true,
      platform: 'linux-x64',
      action: 'installed-appimage',
      targetPath: join(fakeHome, '.local', 'bin', 'nibgrid-studio'),
      quitRequested: false,
    });
    expect(await readFile(linuxRes.targetPath)).toEqual(payload);
    const mode = (await stat(linuxRes.targetPath)).mode & 0o777;
    expect(mode).toBe(0o755);
    expect(execCalls).toHaveLength(2);
  });

  it('throws ChecksumMismatchError, removes temp directory, and never calls execFile on 1-byte tamper', async () => {
    const tmpRoot = await mkdtemp(join(tmpdir(), 'm43b-tamper-'));
    tempRootsToClean.push(tmpRoot);

    const original = Buffer.from('authentic-release-binary-bytes');
    const expectedDigest = sha256Hex(original);
    const tampered = Buffer.from(original);
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;

    const update: UpdateCheckResult = {
      status: 'update-available',
      currentVersion: '0.1.0',
      latestVersion: '0.2.0',
      assetFilename: 'Nibgrid-Studio-0.2.0-win-x64-setup.exe',
      assetDownloadUrl:
        'https://github.com/FranekJemiolo/nibgrid/releases/download/v0.2.0/Nibgrid-Studio-0.2.0-win-x64-setup.exe',
      checksumsUrl:
        'https://github.com/FranekJemiolo/nibgrid/releases/download/v0.2.0/SHA256SUMS.txt',
    };

    const execSpy = vi.fn();
    const fetchTampered = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).endsWith('SHA256SUMS.txt')) {
        return new Response(`${expectedDigest}  Nibgrid-Studio-0.2.0-win-x64-setup.exe\n`, {
          status: 200,
        });
      }
      return new Response(new Uint8Array(tampered), { status: 200 });
    });

    let caughtError: unknown = null;
    try {
      const verified = await downloadAndVerifyUpdate(update, {
        fetchImpl: fetchTampered as unknown as typeof fetch,
        tmpRootDir: tmpRoot,
      });
      await handoffVerifiedInstaller('win-x64', verified.installerPath, {
        execFileImpl: execSpy,
      });
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(ChecksumMismatchError);
    expect(execSpy).not.toHaveBeenCalled();

    const fsEntries = await import('node:fs/promises').then((m) => m.readdir(tmpRoot));
    expect(fsEntries).toHaveLength(0);
  });
});
