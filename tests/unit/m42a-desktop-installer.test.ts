import { describe, expect, it } from 'vitest';
import {
  buildDesktopAssetFilename,
  detectDesktopPlatform,
  fetchLatestDesktopRelease,
  getCliInstallCommand,
  parseLatestDesktopRelease,
} from '../../src/platform/desktopInstaller';

describe('M42A: Pure-TS Desktop OS Detection, Release Parser & CLI Command Builder', () => {
  it('detectDesktopPlatform maps macOS arm64, macOS Intel, Windows, Linux & empty inputs accurately', () => {
    expect(detectDesktopPlatform({ uaDataPlatform: 'macOS', architecture: 'arm' })).toBe(
      'macos-arm64',
    );
    expect(detectDesktopPlatform({ platform: 'MacIntel', architecture: 'x86_64' })).toBe(
      'macos-x64',
    );
    expect(detectDesktopPlatform({ uaDataPlatform: 'Windows' })).toBe('win-x64');
    expect(detectDesktopPlatform({ platform: 'Win32' })).toBe('win-x64');
    expect(detectDesktopPlatform({ platform: 'Linux x86_64' })).toBe('linux-x64');
    expect(detectDesktopPlatform({})).toBe('macos-arm64');
  });

  it('parseLatestDesktopRelease matches all 4 M41 platform assets and returns null on malformed payloads', () => {
    const valid = parseLatestDesktopRelease({
      tag_name: 'v1.2.3',
      html_url: 'https://github.com/FranekJemiolo/nibgrid/releases/tag/v1.2.3',
      assets: [
        {
          name: buildDesktopAssetFilename('1.2.3', 'macos-arm64'),
          browser_download_url:
            'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.3/Nibgrid-Studio-1.2.3-macos-arm64.dmg',
          size: 42000000,
        },
        {
          name: buildDesktopAssetFilename('1.2.3', 'macos-x64'),
          browser_download_url:
            'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.3/Nibgrid-Studio-1.2.3-macos-x64.dmg',
        },
        {
          name: buildDesktopAssetFilename('1.2.3', 'win-x64'),
          browser_download_url:
            'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.3/Nibgrid-Studio-1.2.3-win-x64-setup.exe',
        },
        {
          name: buildDesktopAssetFilename('1.2.3', 'linux-x64'),
          browser_download_url:
            'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.3/Nibgrid-Studio-1.2.3-linux-x64.AppImage',
        },
      ],
    });

    expect(valid).not.toBeNull();
    expect(valid?.version).toBe('1.2.3');
    expect(valid?.assetsByPlatform['macos-arm64']?.filename).toBe(
      'Nibgrid-Studio-1.2.3-macos-arm64.dmg',
    );
    expect(valid?.assetsByPlatform['win-x64']?.downloadUrl).toContain('win-x64-setup.exe');
    expect(valid?.assetsByPlatform['linux-x64']?.downloadUrl).toContain('linux-x64.AppImage');

    expect(parseLatestDesktopRelease(null)).toBeNull();
    expect(parseLatestDesktopRelease({ tag_name: 'not-a-semver' })).toBeNull();
  });

  it('getCliInstallCommand generates exact curl|sh and irm|iex one-liners', () => {
    expect(getCliInstallCommand('macos-arm64')).toBe(
      'curl -fsSL https://franekjemiolo.github.io/nibgrid/install.sh | sh',
    );
    expect(getCliInstallCommand('linux-x64')).toBe(
      'curl -fsSL https://franekjemiolo.github.io/nibgrid/install.sh | sh',
    );
    expect(getCliInstallCommand('win-x64')).toBe(
      'irm https://franekjemiolo.github.io/nibgrid/install.ps1 | iex',
    );
  });

  it('fetchLatestDesktopRelease returns ok on HTTP 200 and fallback cleanly on HTTP 403 or network error', async () => {
    const okFetch = (async () =>
      new Response(
        JSON.stringify({
          tag_name: 'v0.9.0',
          assets: [
            {
              name: 'Nibgrid-Studio-0.9.0-linux-x64.AppImage',
              browser_download_url:
                'https://github.com/FranekJemiolo/nibgrid/releases/download/v0.9.0/Nibgrid-Studio-0.9.0-linux-x64.AppImage',
            },
          ],
        }),
        { status: 200 },
      )) as unknown as typeof fetch;

    const okRes = await fetchLatestDesktopRelease(okFetch);
    expect(okRes.status).toBe('ok');
    if (okRes.status === 'ok') {
      expect(okRes.release.version).toBe('0.9.0');
      expect(okRes.release.assetsByPlatform['linux-x64']?.filename).toBe(
        'Nibgrid-Studio-0.9.0-linux-x64.AppImage',
      );
    }

    const rateLimitedFetch = (async () =>
      new Response('API rate limit exceeded', { status: 403 })) as unknown as typeof fetch;
    const limitedRes = await fetchLatestDesktopRelease(rateLimitedFetch);
    expect(limitedRes).toEqual({
      status: 'fallback',
      fallbackUrl: 'https://github.com/FranekJemiolo/nibgrid/releases/latest',
      reason: 'GitHub API returned HTTP 403',
    });

    const offlineFetch = (async () => {
      throw new Error('Failed to fetch');
    }) as unknown as typeof fetch;
    const offlineRes = await fetchLatestDesktopRelease(offlineFetch);
    expect(offlineRes.status).toBe('fallback');
    if (offlineRes.status === 'fallback') {
      expect(offlineRes.fallbackUrl).toBe(
        'https://github.com/FranekJemiolo/nibgrid/releases/latest',
      );
    }
  });
});
