#!/usr/bin/env node
/**
 * Nibgrid Post-Deploy / Pre-Release Smoke Test
 *
 * Usage:
 *   SMOKE_URL=https://franekjemiolo.github.io/nibgrid/ node scripts/smoke-release.mjs
 *   SMOKE_URL=http://127.0.0.1:4173/nibgrid/ node scripts/smoke-release.mjs
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const BASE_URL = (process.env.SMOKE_URL || 'https://franekjemiolo.github.io/nibgrid/').replace(
  /\/?$/,
  '/',
);

const GITHUB_RELEASES_API_URL =
  'https://api.github.com/repos/FranekJemiolo/nibgrid/releases/latest';

function assert(condition, message) {
  if (!condition) {
    throw new Error(`SMOKE FAIL: ${message}`);
  }
}

async function verifyHttpEndpoint(path, validator) {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, { cache: 'no-store' });
  assert(res.ok, `${url} returned HTTP ${res.status}`);
  const text = await res.text();
  if (validator) validator(text, url);
  console.log(`  [OK] GET ${path} (${res.status}, ${text.length} bytes)`);
  return text;
}

async function main() {
  console.log(`Running Nibgrid release smoke test against: ${BASE_URL}\n`);

  // 1. Verify static PWA & CLI installer endpoints
  console.log('1) Verifying HTTP & CLI installer endpoints...');
  const installSh = await verifyHttpEndpoint('install.sh', (text) => {
    assert(text.startsWith('#!/usr/bin/env sh'), 'install.sh missing POSIX shebang');
    assert(text.includes('SHA256SUMS.txt'), 'install.sh missing SHA256SUMS.txt check');
    assert(text.includes('FranekJemiolo/nibgrid'), 'install.sh missing repo slug');
  });

  // Run POSIX syntax check on downloaded install.sh
  const tmpSh = join(tmpdir(), `nibgrid-smoke-install-${Date.now()}.sh`);
  try {
    writeFileSync(tmpSh, installSh, 'utf8');
    execFileSync('sh', ['-n', tmpSh], { stdio: 'pipe' });
    console.log('  [OK] sh -n install.sh passed');
  } finally {
    try {
      unlinkSync(tmpSh);
    } catch {
      // ignore cleanup error
    }
  }

  await verifyHttpEndpoint('install.ps1', (text) => {
    assert(text.includes('SHA256SUMS.txt'), 'install.ps1 missing SHA256SUMS.txt check');
    assert(text.includes('Get-FileHash'), 'install.ps1 missing Get-FileHash verification');
    assert(text.includes('FranekJemiolo/nibgrid'), 'install.ps1 missing repo slug');
  });

  await verifyHttpEndpoint('manifest.webmanifest', (text) => {
    const manifest = JSON.parse(text);
    assert(Boolean(manifest.name || manifest.short_name), 'manifest missing name');
  });

  // 2. Verify zero console/page errors & PWA offline reload in Chromium
  console.log('\n2) Verifying cold boot, zero console errors, and PWA offline mode...');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  const consoleErrors = [];
  const pageErrors = [];

  page.on('console', (msg) => {
    if (msg.type() !== 'error') return;
    const text = msg.text();
    const locUrl = msg.location()?.url || '';
    if (locUrl === GITHUB_RELEASES_API_URL && text.includes('Failed to load resource')) {
      return;
    }
    consoleErrors.push(locUrl ? `${text} (${locUrl})` : text);
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });

  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 30_000 });
    const title = await page.title();
    assert(title.length > 0, 'Page title is empty');
    console.log(`  [OK] Cold boot loaded (title: "${title}")`);

    // Wait for Service Worker registration and page control if supported
    const swReady = await page.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return false;
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 8_000)),
      ]);
      if (!reg || !reg.active) return false;
      if (!navigator.serviceWorker.controller) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          navigator.serviceWorker.addEventListener(
            'controllerchange',
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
      return Boolean(reg.active);
    });
    assert(swReady, 'Service Worker did not activate within 8s');
    console.log('  [OK] Service Worker active');

    // Verify Get Desktop App modal opens cleanly (if present in PWA mode)
    const desktopBtn = page.getByRole('button', { name: /get desktop app/i });
    if (await desktopBtn.isVisible().catch(() => false)) {
      await desktopBtn.click();
      await page.getByText(/install\.sh|install\.ps1/i).first().waitFor({ timeout: 5_000 });
      await page.keyboard.press('Escape');
      console.log('  [OK] InstallDesktopModal renders CLI one-liner');
    }

    // Toggle offline mode and reload to verify PWA cache
    await context.setOffline(true);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 });
    await page.waitForFunction(
      () => document.body && document.body.innerText.trim().length > 0,
      null,
      { timeout: 10_000 },
    );
    const offlineBodyLen = await page.evaluate(() => document.body.innerText.trim().length);
    assert(offlineBodyLen > 0, 'Offline reload rendered empty body');
    console.log('  [OK] Offline PWA reload succeeded');

    assert(pageErrors.length === 0, `Uncaught pageerrors:\n  - ${pageErrors.join('\n  - ')}`);
    assert(consoleErrors.length === 0, `Console errors:\n  - ${consoleErrors.join('\n  - ')}`);
    console.log('  [OK] Zero console.error and zero pageerror');
  } finally {
    await browser.close();
  }

  console.log('\nALL NIBGRID RELEASE SMOKE CHECKS PASSED.');
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
