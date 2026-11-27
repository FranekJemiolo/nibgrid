import { expect, test } from '@playwright/test';

const GITHUB_RELEASE_API = 'https://api.github.com/repos/FranekJemiolo/nibgrid/releases/latest';

test.describe('M42C: InstallDesktopModal, Platform Switcher, CLI Copy & HTTP 403 Fallback E2E', () => {
  test('renders Get Desktop App in PWA, resolves v1.2.0 release assets across OS tabs, copies CLI command, and falls back gracefully on 403', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // 1. Intercept GitHub Releases API returning v1.2.0 assets across all 4 targets
    await page.route(GITHUB_RELEASE_API, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          tag_name: 'v1.2.0',
          html_url: 'https://github.com/FranekJemiolo/nibgrid/releases/tag/v1.2.0',
          assets: [
            {
              name: 'Nibgrid-Studio-1.2.0-macos-arm64.dmg',
              browser_download_url:
                'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.0/Nibgrid-Studio-1.2.0-macos-arm64.dmg',
            },
            {
              name: 'Nibgrid-Studio-1.2.0-macos-x64.dmg',
              browser_download_url:
                'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.0/Nibgrid-Studio-1.2.0-macos-x64.dmg',
            },
            {
              name: 'Nibgrid-Studio-1.2.0-win-x64-setup.exe',
              browser_download_url:
                'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.0/Nibgrid-Studio-1.2.0-win-x64-setup.exe',
            },
            {
              name: 'Nibgrid-Studio-1.2.0-linux-x64.AppImage',
              browser_download_url:
                'https://github.com/FranekJemiolo/nibgrid/releases/download/v1.2.0/Nibgrid-Studio-1.2.0-linux-x64.AppImage',
            },
          ],
        }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('nav-get-desktop-btn').click();
    await expect(page.getByTestId('install-desktop-modal')).toBeVisible();
    await expect(page.getByTestId('install-version-badge')).toHaveText('v1.2.0');

    // Switch OS tabs & verify direct asset link + CLI one-liner updates cleanly
    await page.getByTestId('install-platform-tab-macos-arm64').click();
    await expect(page.getByTestId('install-primary-download-link')).toHaveAttribute(
      'href',
      /Nibgrid-Studio-1\.2\.0-macos-arm64\.dmg$/,
    );
    await expect(page.getByTestId('install-cli-command')).toHaveText(
      'curl -fsSL https://franekjemiolo.github.io/nibgrid/install.sh | sh',
    );

    await page.getByTestId('install-platform-tab-win-x64').click();
    await expect(page.getByTestId('install-primary-download-link')).toHaveAttribute(
      'href',
      /Nibgrid-Studio-1\.2\.0-win-x64-setup\.exe$/,
    );
    await expect(page.getByTestId('install-cli-command')).toHaveText(
      'irm https://franekjemiolo.github.io/nibgrid/install.ps1 | iex',
    );

    await page.getByTestId('install-platform-tab-linux-x64').click();
    await expect(page.getByTestId('install-primary-download-link')).toHaveAttribute(
      'href',
      /Nibgrid-Studio-1\.2\.0-linux-x64\.AppImage$/,
    );
    await expect(page.getByTestId('install-cli-command')).toHaveText(
      'curl -fsSL https://franekjemiolo.github.io/nibgrid/install.sh | sh',
    );

    await page.getByTestId('install-copy-cli-btn').click();
    await expect(page.getByTestId('install-copy-cli-btn')).toContainText('Copied!');
    await page.getByTestId('close-install-desktop-btn').click();

    // 2. Simulate GitHub API HTTP 403 rate-limit -> graceful static fallback + CLI stays active
    await page.unroute(GITHUB_RELEASE_API);
    await page.route(GITHUB_RELEASE_API, async (route) => {
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'API rate limit exceeded' }),
      });
    });

    await page.getByTestId('nav-get-desktop-btn').click();
    await expect(page.getByTestId('install-fallback-notice')).toBeVisible();
    await expect(page.getByTestId('install-primary-download-link')).toHaveAttribute(
      'href',
      'https://github.com/FranekJemiolo/nibgrid/releases/latest',
    );
    await expect(page.getByTestId('install-cli-command')).toBeVisible();

    expect(pageErrors).toEqual([]);
  });

  test('hides Get Desktop App top-bar button when running under VscodeHostAdapter / Desktop host', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({
        postMessage: () => undefined,
      });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');
    await expect(page.getByTestId('nav-models-btn')).toBeVisible();
    await expect(page.getByTestId('nav-get-desktop-btn')).toHaveCount(0);
  });
});
