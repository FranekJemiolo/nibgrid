import {
  DEFAULT_GITHUB_REPO,
  getLatestReleasesFallbackUrl,
  parseLatestDesktopRelease,
  type DesktopPlatform,
} from '../../../src/platform/desktopInstaller';

export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 86_400_000;

export interface SemverTuple {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

export interface UpdateCheckResult {
  readonly status: 'up-to-date' | 'update-available' | 'skipped' | 'offline-or-ratelimited';
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly releaseUrl?: string;
  readonly assetFilename?: string;
  readonly assetDownloadUrl?: string;
  readonly checksumsUrl?: string;
  readonly etag?: string;
}

export interface CheckForDesktopUpdateOptions {
  readonly currentVersion: string;
  readonly platform: DesktopPlatform;
  readonly skippedVersion?: string;
  readonly etag?: string;
  readonly fetchImpl?: typeof fetch;
  readonly repoSlug?: string;
  readonly allowPrerelease?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Parses `v?MAJOR.MINOR.PATCH` strictly by default, returning `null` for malformed
 * strings or pre-release tags unless `allowPrerelease` is explicitly enabled.
 */
export function parseSemver(
  raw: string,
  opts: { readonly allowPrerelease?: boolean } = {},
): SemverTuple | null {
  const trimmed = raw.trim();
  const match = opts.allowPrerelease
    ? /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(trimmed)
    : /^v?(\d+)\.(\d+)\.(\d+)$/.exec(trimmed);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Deterministically checks whether `candidate` is strictly newer than `current`.
 */
export function isNewerSemver(
  current: string,
  candidate: string,
  opts: { readonly allowPrerelease?: boolean } = {},
): boolean {
  const a = parseSemver(current, { allowPrerelease: true });
  const b = parseSemver(candidate, opts);
  if (!a || !b) return false;
  if (b.major !== a.major) return b.major > a.major;
  if (b.minor !== a.minor) return b.minor > a.minor;
  return b.patch > a.patch;
}

/**
 * Returns `true` when enough time has elapsed since the previous update check
 * (defaults to 24 hours).
 */
export function shouldRunAutoUpdateCheck(
  lastCheckedAtMs: number | undefined,
  nowMs: number,
  intervalMs = DEFAULT_UPDATE_CHECK_INTERVAL_MS,
): boolean {
  if (lastCheckedAtMs === undefined || !Number.isFinite(lastCheckedAtMs)) {
    return true;
  }
  if (nowMs < lastCheckedAtMs) {
    return true;
  }
  return nowMs - lastCheckedAtMs >= intervalMs;
}

/**
 * Parses `SHA256SUMS.txt` (`<64-hex>  <filename>` or `<64-hex> *<filename>`)
 * into a filename-keyed lowercase hex map.
 */
export function parseSha256Sums(text: string): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(trimmed);
    if (!match) continue;
    const hex = match[1]?.toLowerCase();
    const filename = match[2]?.trim();
    if (hex && filename) {
      map.set(filename, hex);
    }
  }
  return map;
}

/**
 * Finds the HTTPS download URL for `SHA256SUMS.txt` from a GitHub Release payload,
 * falling back to the canonical release download URL.
 */
export function extractChecksumsDownloadUrl(
  rawJson: unknown,
  tag: string,
  repoSlug = DEFAULT_GITHUB_REPO,
): string {
  if (rawJson && typeof rawJson === 'object') {
    const rawAssets = (rawJson as Record<string, unknown>).assets;
    if (Array.isArray(rawAssets)) {
      for (const rawAsset of rawAssets) {
        if (!rawAsset || typeof rawAsset !== 'object') continue;
        const asset = rawAsset as Record<string, unknown>;
        const name = typeof asset.name === 'string' ? asset.name.trim() : '';
        const url =
          typeof asset.browser_download_url === 'string' ? asset.browser_download_url.trim() : '';
        if (name === 'SHA256SUMS.txt' && url.startsWith('https://')) {
          return url;
        }
      }
    }
  }
  return `https://github.com/${repoSlug}/releases/download/${encodeURIComponent(tag)}/SHA256SUMS.txt`;
}

/**
 * Queries GitHub Releases `/releases/latest` using conditional `If-None-Match` ETags
 * without throwing on network errors or API rate limits.
 */
export async function checkForDesktopUpdate(
  opts: CheckForDesktopUpdateOptions,
): Promise<UpdateCheckResult> {
  const repoSlug = opts.repoSlug ?? DEFAULT_GITHUB_REPO;
  const fallbackUrl = getLatestReleasesFallbackUrl(repoSlug);
  const fetchImpl = opts.fetchImpl ?? (typeof fetch === 'function' ? fetch : undefined);

  if (!fetchImpl) {
    return {
      status: 'offline-or-ratelimited',
      currentVersion: opts.currentVersion,
      releaseUrl: fallbackUrl,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    ...(opts.etag ? { 'If-None-Match': opts.etag } : {}),
  };

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    const respEtag = res.headers?.get?.('etag')?.trim() || undefined;
    const effectiveEtag = respEtag ?? opts.etag;

    if (res.status === 304) {
      return {
        status: 'up-to-date',
        currentVersion: opts.currentVersion,
        ...(effectiveEtag ? { etag: effectiveEtag } : {}),
      };
    }

    if (res.status === 403 || res.status === 429 || !res.ok) {
      return {
        status: 'offline-or-ratelimited',
        currentVersion: opts.currentVersion,
        releaseUrl: fallbackUrl,
      };
    }

    const rawJson = (await res.json()) as unknown;
    const rec =
      rawJson && typeof rawJson === 'object' ? (rawJson as Record<string, unknown>) : null;
    if (!opts.allowPrerelease && rec?.prerelease === true) {
      return {
        status: 'up-to-date',
        currentVersion: opts.currentVersion,
        ...(effectiveEtag ? { etag: effectiveEtag } : {}),
      };
    }

    const parsed = parseLatestDesktopRelease(rawJson, repoSlug);
    if (!parsed) {
      return {
        status: 'up-to-date',
        currentVersion: opts.currentVersion,
        ...(effectiveEtag ? { etag: effectiveEtag } : {}),
      };
    }

    if (
      !isNewerSemver(opts.currentVersion, parsed.tag, { allowPrerelease: opts.allowPrerelease })
    ) {
      return {
        status: 'up-to-date',
        currentVersion: opts.currentVersion,
        latestVersion: parsed.version,
        releaseUrl: parsed.releaseUrl,
        ...(effectiveEtag ? { etag: effectiveEtag } : {}),
      };
    }

    const cleanSkipped = opts.skippedVersion?.trim().replace(/^v/i, '');
    if (cleanSkipped && parsed.version === cleanSkipped) {
      return {
        status: 'skipped',
        currentVersion: opts.currentVersion,
        latestVersion: parsed.version,
        releaseUrl: parsed.releaseUrl,
        ...(effectiveEtag ? { etag: effectiveEtag } : {}),
      };
    }

    const asset = parsed.assetsByPlatform[opts.platform];
    if (!asset) {
      return {
        status: 'up-to-date',
        currentVersion: opts.currentVersion,
        latestVersion: parsed.version,
        releaseUrl: parsed.releaseUrl,
        ...(effectiveEtag ? { etag: effectiveEtag } : {}),
      };
    }

    return {
      status: 'update-available',
      currentVersion: opts.currentVersion,
      latestVersion: parsed.version,
      releaseUrl: parsed.releaseUrl,
      assetFilename: asset.filename,
      assetDownloadUrl: asset.downloadUrl,
      checksumsUrl: extractChecksumsDownloadUrl(rawJson, parsed.tag, repoSlug),
      ...(effectiveEtag ? { etag: effectiveEtag } : {}),
    };
  } catch {
    return {
      status: 'offline-or-ratelimited',
      currentVersion: opts.currentVersion,
      releaseUrl: fallbackUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}
