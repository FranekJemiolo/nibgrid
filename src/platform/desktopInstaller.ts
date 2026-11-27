export const DEFAULT_GITHUB_REPO = 'FranekJemiolo/nibgrid';
export const DEFAULT_PAGES_BASE_URL = 'https://franekjemiolo.github.io/nibgrid';

export type DesktopPlatform = 'macos-arm64' | 'macos-x64' | 'win-x64' | 'linux-x64';

export const DESKTOP_PLATFORMS: readonly DesktopPlatform[] = [
  'macos-arm64',
  'macos-x64',
  'win-x64',
  'linux-x64',
];

export interface DesktopPlatformMeta {
  readonly id: DesktopPlatform;
  readonly label: string;
  readonly shortLabel: string;
  readonly assetSuffix: string;
  readonly shellKind: 'sh' | 'ps1';
}

export const DESKTOP_PLATFORM_META: Readonly<Record<DesktopPlatform, DesktopPlatformMeta>> = {
  'macos-arm64': {
    id: 'macos-arm64',
    label: 'macOS (Apple Silicon)',
    shortLabel: 'macOS arm64',
    assetSuffix: 'macos-arm64.dmg',
    shellKind: 'sh',
  },
  'macos-x64': {
    id: 'macos-x64',
    label: 'macOS (Intel)',
    shortLabel: 'macOS x64',
    assetSuffix: 'macos-x64.dmg',
    shellKind: 'sh',
  },
  'win-x64': {
    id: 'win-x64',
    label: 'Windows (x64)',
    shortLabel: 'Windows x64',
    assetSuffix: 'win-x64-setup.exe',
    shellKind: 'ps1',
  },
  'linux-x64': {
    id: 'linux-x64',
    label: 'Linux (AppImage)',
    shortLabel: 'Linux AppImage',
    assetSuffix: 'linux-x64.AppImage',
    shellKind: 'sh',
  },
};

export interface DesktopReleaseAsset {
  readonly filename: string;
  readonly downloadUrl: string;
  readonly sizeBytes?: number;
}

export interface DesktopReleaseInfo {
  readonly version: string;
  readonly tag: string;
  readonly releaseUrl: string;
  readonly assetsByPlatform: Partial<Record<DesktopPlatform, DesktopReleaseAsset>>;
}

export type FetchDesktopReleaseResult =
  | { readonly status: 'ok'; readonly release: DesktopReleaseInfo }
  | { readonly status: 'fallback'; readonly fallbackUrl: string; readonly reason: string };

export function buildDesktopAssetFilename(version: string, platform: DesktopPlatform): string {
  const cleanVersion = version.trim().replace(/^v/, '') || '0.1.0';
  return `Nibgrid-Studio-${cleanVersion}-${DESKTOP_PLATFORM_META[platform].assetSuffix}`;
}

export function getLatestReleasesFallbackUrl(repoSlug = DEFAULT_GITHUB_REPO): string {
  return `https://github.com/${repoSlug}/releases/latest`;
}

/**
 * Deterministically maps browser/OS hint strings to a `DesktopPlatform` target.
 */
export function detectDesktopPlatform(
  input: {
    readonly platform?: string;
    readonly userAgent?: string;
    readonly uaDataPlatform?: string;
    readonly architecture?: string;
  } = {},
): DesktopPlatform {
  const combined = [input.uaDataPlatform, input.platform, input.userAgent]
    .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    .join(' ')
    .toLowerCase();

  if (/\bwin(dows|32|64)?\b/.test(combined)) {
    return 'win-x64';
  }
  if (/\b(linux|ubuntu|debian|fedora|arch|x11)\b/.test(combined) && !combined.includes('android')) {
    return 'linux-x64';
  }
  if (/(macintel|macintosh|macos|mac os|darwin|\bmac\b)/.test(combined)) {
    const archHint = (input.architecture ?? input.userAgent ?? '').toLowerCase();
    const looksIntel =
      /\b(x86_64|x86|amd64|x64|intel)\b/.test(archHint) &&
      !/\b(arm|aarch64|apple)\b/.test(archHint);
    return looksIntel ? 'macos-x64' : 'macos-arm64';
  }
  return 'macos-arm64';
}

/**
 * Safely parses GitHub's `/releases/latest` JSON payload into normalized platform assets,
 * returning `null` cleanly on malformed payloads.
 */
export function parseLatestDesktopRelease(
  rawJson: unknown,
  repoSlug = DEFAULT_GITHUB_REPO,
): DesktopReleaseInfo | null {
  if (!rawJson || typeof rawJson !== 'object') {
    return null;
  }
  const rec = rawJson as Record<string, unknown>;
  const rawTag = typeof rec.tag_name === 'string' ? rec.tag_name.trim() : '';
  if (!rawTag) {
    return null;
  }
  const version = rawTag.replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return null;
  }

  const rawHtmlUrl = typeof rec.html_url === 'string' ? rec.html_url.trim() : '';
  const releaseUrl = rawHtmlUrl.startsWith('https://')
    ? rawHtmlUrl
    : `https://github.com/${repoSlug}/releases/tag/${encodeURIComponent(rawTag)}`;

  const rawAssets = Array.isArray(rec.assets) ? rec.assets : [];
  const assetsByPlatform: Partial<Record<DesktopPlatform, DesktopReleaseAsset>> = {};

  for (const rawAsset of rawAssets) {
    if (!rawAsset || typeof rawAsset !== 'object') continue;
    const assetObj = rawAsset as Record<string, unknown>;
    const filename = typeof assetObj.name === 'string' ? assetObj.name.trim() : '';
    const downloadUrl =
      typeof assetObj.browser_download_url === 'string' ? assetObj.browser_download_url.trim() : '';
    if (!filename || !downloadUrl.startsWith('https://')) continue;

    for (const platform of DESKTOP_PLATFORMS) {
      const suffix = DESKTOP_PLATFORM_META[platform].assetSuffix;
      if (filename.endsWith(`-${suffix}`)) {
        const sizeBytes =
          typeof assetObj.size === 'number' && Number.isFinite(assetObj.size)
            ? assetObj.size
            : undefined;
        assetsByPlatform[platform] = {
          filename,
          downloadUrl,
          ...(sizeBytes !== undefined ? { sizeBytes } : {}),
        };
      }
    }
  }

  return {
    version,
    tag: rawTag,
    releaseUrl,
    assetsByPlatform,
  };
}

/**
 * Builds the 1-line SHA-256-verifying CLI install command hosted on GitHub Pages.
 */
export function getCliInstallCommand(
  platform: DesktopPlatform,
  pagesBaseUrl = DEFAULT_PAGES_BASE_URL,
): string {
  const cleanBase = pagesBaseUrl.replace(/\/+$/, '');
  if (DESKTOP_PLATFORM_META[platform].shellKind === 'ps1') {
    return `irm ${cleanBase}/install.ps1 | iex`;
  }
  return `curl -fsSL ${cleanBase}/install.sh | sh`;
}

/**
 * Queries GitHub `/releases/latest` cleanly with an abort timeout, returning a structured
 * static fallback when rate-limited (`403`/`429`) or offline without ever throwing.
 */
export async function fetchLatestDesktopRelease(
  fetchImpl: typeof fetch | undefined = typeof fetch === 'function' ? fetch : undefined,
  repoSlug = DEFAULT_GITHUB_REPO,
  opts: { readonly timeoutMs?: number } = {},
): Promise<FetchDesktopReleaseResult> {
  const fallbackUrl = getLatestReleasesFallbackUrl(repoSlug);
  if (!fetchImpl) {
    return { status: 'fallback', fallbackUrl, reason: 'Fetch API unavailable' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 6000);

  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repoSlug}/releases/latest`, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        status: 'fallback',
        fallbackUrl,
        reason: `GitHub API returned HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as unknown;
    const parsed = parseLatestDesktopRelease(json, repoSlug);
    if (!parsed) {
      return {
        status: 'fallback',
        fallbackUrl,
        reason: 'GitHub release payload was missing a valid SemVer tag.',
      };
    }
    return { status: 'ok', release: parsed };
  } catch (err) {
    return {
      status: 'fallback',
      fallbackUrl,
      reason: err instanceof Error ? err.message : 'Network error reaching GitHub Releases',
    };
  } finally {
    clearTimeout(timeout);
  }
}
