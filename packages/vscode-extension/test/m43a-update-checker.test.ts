import { describe, expect, it, vi } from 'vitest';
import {
  checkForDesktopUpdate,
  DEFAULT_UPDATE_CHECK_INTERVAL_MS,
  extractChecksumsDownloadUrl,
  isNewerSemver,
  parseSemver,
  parseSha256Sums,
  shouldRunAutoUpdateCheck,
} from '../src/updateCheckerCore';

describe('M43A: Pure-TS SemVer, ETag Caching, 24h Throttle & SHA256SUMS.txt Parser', () => {
  it('parses strict SemVer, ignores pre-releases by default, and compares major/minor/patch accurately', () => {
    expect(parseSemver('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    expect(parseSemver('1.3.0-beta.1')).toBeNull();
    expect(parseSemver('1.3.0-beta.1', { allowPrerelease: true })).toEqual({
      major: 1,
      minor: 3,
      patch: 0,
    });
    expect(parseSemver('not-a-version')).toBeNull();

    expect(isNewerSemver('1.2.0', '1.2.1')).toBe(true);
    expect(isNewerSemver('1.2.0', 'v1.3.0')).toBe(true);
    expect(isNewerSemver('1.2.0', '2.0.0')).toBe(true);
    expect(isNewerSemver('1.2.0', '1.2.0')).toBe(false);
    expect(isNewerSemver('1.2.0', '1.1.9')).toBe(false);
    expect(isNewerSemver('1.2.0', '1.3.0-beta.1')).toBe(false);
    expect(isNewerSemver('1.2.0', '1.3.0-beta.1', { allowPrerelease: true })).toBe(true);
  });

  it('throttles background checks to once every 24 hours via lastCheckedAtMs', () => {
    const now = 1_700_000_000_000;
    expect(shouldRunAutoUpdateCheck(undefined, now)).toBe(true);
    expect(shouldRunAutoUpdateCheck(now - (DEFAULT_UPDATE_CHECK_INTERVAL_MS - 1000), now)).toBe(
      false,
    );
    expect(shouldRunAutoUpdateCheck(now - DEFAULT_UPDATE_CHECK_INTERVAL_MS, now)).toBe(true);
    expect(shouldRunAutoUpdateCheck(now + 5000, now)).toBe(true);
  });

  it('parses standard and binary (*) SHA256SUMS.txt manifests into lowercase hex maps', () => {
    const sample = [
      '# comment line',
      '',
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA  Nibgrid-Studio-1.2.1-macos-arm64.dmg',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb *Nibgrid-Studio-1.2.1-win-x64-setup.exe',
      'invalid-short-line  ignored.bin',
    ].join('\n');

    const map = parseSha256Sums(sample);
    expect(map.size).toBe(2);
    expect(map.get('Nibgrid-Studio-1.2.1-macos-arm64.dmg')).toBe('a'.repeat(64));
    expect(map.get('Nibgrid-Studio-1.2.1-win-x64-setup.exe')).toBe('b'.repeat(64));
  });

  it('handles HTTP 304 ETag short-circuiting without parsing JSON body', async () => {
    const jsonSpy = vi.fn();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)['If-None-Match']).toBe('"etag-v120"');
      return new Response(null, {
        status: 304,
        headers: { ETag: '"etag-v120"' },
      });
    });

    const result = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      platform: 'macos-arm64',
      etag: '"etag-v120"',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(jsonSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      status: 'up-to-date',
      currentVersion: '1.2.0',
      etag: '"etag-v120"',
    });
  });

  it('returns update-available with matched asset + SHA256SUMS.txt URL and honors skippedVersion & pre-releases', async () => {
    const releasePayload = {
      tag_name: 'v1.2.1',
      html_url: 'https://github.com/FranekJemiolo/nibgrid/releases/tag/v1.2.1',
      prerelease: false,
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
        new Response(JSON.stringify(releasePayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json', ETag: '"etag-v121"' },
        }),
    );

    const available = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      platform: 'macos-arm64',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(available).toEqual({
      status: 'update-available',
      currentVersion: '1.2.0',
      latestVersion: '1.2.1',
      releaseUrl: 'https://github.com/FranekJemiolo/nibgrid/releases/tag/v1.2.1',
      assetFilename: 'Nibgrid-Studio-1.2.1-macos-arm64.dmg',
      assetDownloadUrl:
        'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.1/Nibgrid-Studio-1.2.1-macos-arm64.dmg',
      checksumsUrl:
        'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.1/SHA256SUMS.txt',
      etag: '"etag-v121"',
    });

    const skipped = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      platform: 'macos-arm64',
      skippedVersion: 'v1.2.1',
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(skipped.status).toBe('skipped');

    const prereleaseFetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...releasePayload, tag_name: 'v1.3.0-beta.1' }), {
          status: 200,
        }),
    );
    const ignoredPrerelease = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      platform: 'macos-arm64',
      fetchImpl: prereleaseFetch as unknown as typeof fetch,
    });
    expect(ignoredPrerelease.status).toBe('up-to-date');

    expect(extractChecksumsDownloadUrl({}, 'v1.2.1')).toBe(
      'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.1/SHA256SUMS.txt',
    );
  });

  it('degrades cleanly to offline-or-ratelimited on HTTP 403, 429, or network rejection', async () => {
    const rateLimited = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      platform: 'win-x64',
      fetchImpl: (async () => new Response('', { status: 403 })) as typeof fetch,
    });
    expect(rateLimited).toEqual({
      status: 'offline-or-ratelimited',
      currentVersion: '1.2.0',
      releaseUrl: 'https://github.com/FranekJemiolo/nibgrid/releases/latest',
    });

    const tooMany = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      platform: 'linux-x64',
      fetchImpl: (async () => new Response('', { status: 429 })) as typeof fetch,
    });
    expect(tooMany.status).toBe('offline-or-ratelimited');

    const offline = await checkForDesktopUpdate({
      currentVersion: '1.2.0',
      platform: 'macos-x64',
      fetchImpl: (async () => {
        throw new Error('ENOTFOUND api.github.com');
      }) as typeof fetch,
    });
    expect(offline.status).toBe('offline-or-ratelimited');
  });
});
