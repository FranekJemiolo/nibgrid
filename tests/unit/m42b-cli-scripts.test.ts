import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DESKTOP_PLATFORM_META, DESKTOP_PLATFORMS } from '../../src/platform/desktopInstaller';

describe('M42B: Hardened CLI Installers (install.sh & install.ps1) & Release Naming Parity', () => {
  it('public/install.sh passes strict POSIX sh syntax check (sh -n)', () => {
    const shPath = resolve(process.cwd(), 'public/install.sh');
    expect(() => execFileSync('sh', ['-n', shPath], { stdio: 'pipe' })).not.toThrow();
  });

  it('install.sh, install.ps1, and release.yml align on repo, SHA256SUMS verification, and M41 asset suffixes', async () => {
    const [shRaw, ps1Raw, releaseYmlRaw] = await Promise.all([
      readFile(resolve(process.cwd(), 'public/install.sh'), 'utf8'),
      readFile(resolve(process.cwd(), 'public/install.ps1'), 'utf8'),
      readFile(resolve(process.cwd(), '.github/workflows/release.yml'), 'utf8'),
    ]);

    expect(shRaw).toContain('FranekJemiolo/nibgrid');
    expect(shRaw).toContain('SHA256SUMS.txt');
    expect(shRaw).toContain('shasum -a 256');
    expect(shRaw).toContain('sha256sum');
    expect(shRaw).toContain('macos-arm64.dmg');
    expect(shRaw).toContain('macos-x64.dmg');
    expect(shRaw).toContain('linux-x64.AppImage');

    expect(ps1Raw).toContain('FranekJemiolo/nibgrid');
    expect(ps1Raw).toContain('SHA256SUMS.txt');
    expect(ps1Raw).toContain('Get-FileHash');
    expect(ps1Raw).toContain('-Algorithm SHA256');
    expect(ps1Raw).toContain('win-x64-setup.exe');
    expect(ps1Raw).toContain('checksum mismatch');

    for (const platform of DESKTOP_PLATFORMS) {
      expect(releaseYmlRaw).toContain(DESKTOP_PLATFORM_META[platform].assetSuffix);
    }
  });
});
