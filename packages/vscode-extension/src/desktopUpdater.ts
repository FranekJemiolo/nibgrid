import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { DesktopPlatform } from '../../../src/platform/desktopInstaller';
import { parseSha256Sums, type UpdateCheckResult } from './updateCheckerCore';

export class ChecksumMismatchError extends Error {
  readonly filename: string;
  readonly expected?: string;
  readonly actual?: string;

  constructor(filename: string, expected?: string, actual?: string, message?: string) {
    super(
      message ??
        (expected && actual
          ? `SHA-256 mismatch for "${filename}": expected ${expected}, got ${actual}.`
          : `Missing SHA-256 checksum entry for "${filename}".`),
    );
    this.name = 'ChecksumMismatchError';
    this.filename = filename;
    this.expected = expected;
    this.actual = actual;
  }
}

function assertSafeAssetFilename(raw: string): string {
  const trimmed = raw.trim();
  if (
    !trimmed ||
    trimmed.includes('\0') ||
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..') ||
    basename(trimmed) !== trimmed
  ) {
    throw new Error(`Unsafe update asset filename "${raw}".`);
  }
  return trimmed;
}

/**
 * Streams a file on disk through SHA-256 and returns the lowercase hex digest.
 */
export async function computeFileSha256Hex(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  const stream = createReadStream(filePath);
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex').toLowerCase();
}

/**
 * Verifies a local file's streaming SHA-256 digest against `expectedHex` using
 * constant-time `crypto.timingSafeEqual`.
 */
export async function verifyFileSha256(filePath: string, expectedHex: string): Promise<boolean> {
  const cleanExpected = expectedHex.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(cleanExpected)) {
    return false;
  }
  const actualHex = await computeFileSha256Hex(filePath);
  const actualBuf = Buffer.from(actualHex, 'hex');
  const expectedBuf = Buffer.from(cleanExpected.toLowerCase(), 'hex');
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return timingSafeEqual(actualBuf, expectedBuf);
}

export interface DownloadAndVerifyDeps {
  readonly fetchImpl?: typeof fetch;
  readonly tmpRootDir?: string;
  readonly onProgress?: (message: string) => void;
}

export interface VerifiedUpdateDownload {
  readonly installerPath: string;
  readonly tmpDir: string;
  readonly sha256: string;
}

/**
 * Downloads `SHA256SUMS.txt` and the target platform installer into an isolated
 * temp directory, verifies the streaming SHA-256 digest via `timingSafeEqual`,
 * and removes the temp directory on any checksum or download failure.
 */
export async function downloadAndVerifyUpdate(
  update: UpdateCheckResult,
  deps: DownloadAndVerifyDeps = {},
): Promise<VerifiedUpdateDownload> {
  if (
    update.status !== 'update-available' ||
    !update.assetFilename ||
    !update.assetDownloadUrl ||
    !update.checksumsUrl
  ) {
    throw new Error('Cannot download update without complete update-available metadata.');
  }
  if (
    !update.assetDownloadUrl.startsWith('https://') ||
    !update.checksumsUrl.startsWith('https://')
  ) {
    throw new Error('Update download URLs must use HTTPS.');
  }

  const fetchImpl = deps.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);
  if (!fetchImpl) {
    throw new Error('Fetch API is unavailable for downloading updates.');
  }

  const safeFilename = assertSafeAssetFilename(update.assetFilename);
  const tmpDir = await mkdtemp(join(deps.tmpRootDir ?? tmpdir(), 'nibgrid-update-'));
  const installerPath = join(tmpDir, safeFilename);

  try {
    deps.onProgress?.('Fetching SHA256SUMS.txt manifest...');
    const sumsRes = await fetchImpl(update.checksumsUrl, { method: 'GET' });
    if (!sumsRes.ok) {
      throw new Error(`Failed to fetch SHA256SUMS.txt (HTTP ${sumsRes.status}).`);
    }
    const sumsText = await sumsRes.text();
    const sumsMap = parseSha256Sums(sumsText);
    const expectedHex = sumsMap.get(safeFilename);
    if (!expectedHex) {
      throw new ChecksumMismatchError(safeFilename);
    }

    deps.onProgress?.(`Downloading ${safeFilename}...`);
    const assetRes = await fetchImpl(update.assetDownloadUrl, { method: 'GET' });
    if (!assetRes.ok) {
      throw new Error(`Failed to download ${safeFilename} (HTTP ${assetRes.status}).`);
    }

    if (assetRes.body && typeof (assetRes.body as ReadableStream).getReader === 'function') {
      const nodeReadable = Readable.fromWeb(
        assetRes.body as unknown as import('stream/web').ReadableStream,
      );
      await pipeline(nodeReadable, createWriteStream(installerPath));
    } else {
      const buf = Buffer.from(await assetRes.arrayBuffer());
      await pipeline(Readable.from([buf]), createWriteStream(installerPath));
    }

    deps.onProgress?.('Verifying SHA-256 digest...');
    const actualHex = await computeFileSha256Hex(installerPath);
    const actualBuf = Buffer.from(actualHex, 'hex');
    const expectedBuf = Buffer.from(expectedHex, 'hex');
    if (actualBuf.length !== expectedBuf.length || !timingSafeEqual(actualBuf, expectedBuf)) {
      throw new ChecksumMismatchError(safeFilename, expectedHex, actualHex);
    }

    return {
      installerPath,
      tmpDir,
      sha256: expectedHex,
    };
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true });
    throw err;
  }
}

export type UpdaterExecFileLike = (
  file: string,
  args: readonly string[],
  options: { readonly detached?: boolean; readonly windowsHide?: boolean },
) => { readonly pid?: number; unref?: () => void } | void;

export interface UpdaterFsLike {
  readonly mkdir: typeof mkdir;
  readonly rename: typeof rename;
  readonly copyFile: typeof copyFile;
  readonly chmod: typeof chmod;
  readonly rm: typeof rm;
}

export interface HandoffUpdateDeps {
  readonly execFileImpl?: UpdaterExecFileLike;
  readonly fsImpl?: UpdaterFsLike;
  readonly homeDir?: string;
  readonly quitApp?: () => Promise<void> | void;
}

export interface VerifiedHandoffResult {
  readonly launched: true;
  readonly platform: DesktopPlatform;
  readonly action: 'opened-dmg' | 'launched-silent-installer' | 'installed-appimage';
  readonly targetPath: string;
  readonly quitRequested: boolean;
}

const defaultExecFile: UpdaterExecFileLike = (file, args, options) => {
  const proc = execFile(file, [...args], {
    windowsHide: options.windowsHide ?? true,
  });
  return proc;
};

const defaultFs: UpdaterFsLike = {
  mkdir,
  rename,
  copyFile,
  chmod,
  rm,
};

/**
 * Safely hands off an already SHA-256-verified installer artifact to the OS
 * using `execFile` argument arrays (zero shell interpolation).
 */
export async function handoffVerifiedInstaller(
  platform: DesktopPlatform,
  installerPath: string,
  deps: HandoffUpdateDeps = {},
): Promise<VerifiedHandoffResult> {
  if (!installerPath.trim() || installerPath.includes('\0')) {
    throw new Error('Verified installer path cannot be empty.');
  }

  const execImpl = deps.execFileImpl ?? defaultExecFile;
  const fsImpl = deps.fsImpl ?? defaultFs;

  if (platform === 'macos-arm64' || platform === 'macos-x64') {
    execImpl('open', [installerPath], { windowsHide: true });
    return {
      launched: true,
      platform,
      action: 'opened-dmg',
      targetPath: installerPath,
      quitRequested: false,
    };
  }

  if (platform === 'win-x64') {
    const proc = execImpl(installerPath, ['/SILENT'], {
      detached: true,
      windowsHide: true,
    });
    proc?.unref?.();
    await deps.quitApp?.();
    return {
      launched: true,
      platform,
      action: 'launched-silent-installer',
      targetPath: installerPath,
      quitRequested: true,
    };
  }

  const home = deps.homeDir ?? homedir();
  const binDir = join(home, '.local', 'bin');
  const targetPath = join(binDir, 'nibgrid-studio');
  await fsImpl.mkdir(binDir, { recursive: true });

  try {
    await fsImpl.rename(installerPath, targetPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== 'EXDEV') {
      throw err;
    }
    const stagingPath = join(binDir, `.nibgrid-studio.tmp-${process.pid}`);
    await fsImpl.copyFile(installerPath, stagingPath);
    await fsImpl.chmod(stagingPath, 0o755);
    await fsImpl.rename(stagingPath, targetPath);
    await fsImpl.rm(installerPath, { force: true });
  }

  await fsImpl.chmod(targetPath, 0o755);
  return {
    launched: true,
    platform,
    action: 'installed-appimage',
    targetPath,
    quitRequested: false,
  };
}
