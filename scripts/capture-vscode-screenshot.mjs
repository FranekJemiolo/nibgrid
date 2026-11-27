#!/usr/bin/env node
/**
 * Captures README screenshots of the Nibgrid extension running inside local VS Code
 * (`/Applications/Visual Studio Code.app`) via Chrome DevTools Protocol.
 *
 * Prereq: `npm run build:ext` (produces packages/vscode-extension/dist/vscodeMain.cjs + dist/webview).
 *
 * Usage:
 *   node scripts/capture-vscode-screenshot.mjs
 *   VSCODE_BIN="/Applications/Visual Studio Code.app/Contents/MacOS/Code" node scripts/capture-vscode-screenshot.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';

const candidateBins = [
  process.env.VSCODE_BIN,
  '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
].filter(Boolean);

const vscodeBin = candidateBins.find((candidate) => existsSync(candidate));
if (!vscodeBin) {
  throw new Error(
    `Local Visual Studio Code executable not found. Checked: ${candidateBins.join(', ')}`,
  );
}

const outDir = resolve(process.env.SHOT_OUT ?? 'docs/screenshots');
const port = Number(process.env.CDP_PORT ?? 0);
const extPath = resolve('packages/vscode-extension');

mkdirSync(outDir, { recursive: true });
const scratch = mkdtempSync(join(tmpdir(), 'nibgrid-vscode-'));
const userDataDir = join(scratch, 'user-data');
const workspace = join(scratch, 'nibgrid-demo');
mkdirSync(join(userDataDir, 'User'), { recursive: true });
mkdirSync(workspace, { recursive: true });
writeFileSync(
  join(userDataDir, 'User', 'settings.json'),
  JSON.stringify(
    {
      'update.mode': 'none',
      'workbench.startupEditor': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'chat.commandCenter.enabled': false,
    },
    null,
    2,
  ),
);

// Electron binaries must not inherit ELECTRON_RUN_AS_NODE (which forces Node CLI mode).
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const vscodeProc = spawn(
  vscodeBin,
  [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    `--extensions-dir=${join(scratch, 'extensions')}`,
    `--extensionDevelopmentPath=${extPath}`,
    '--new-window',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-workspace-trust',
    workspace,
  ],
  { env, stdio: ['ignore', 'pipe', 'pipe'], detached: false },
);

let procLog = '';
let wsEndpoint = null;
const captureLine = (chunk) => {
  const text = String(chunk);
  procLog += text;
  const match = /DevTools listening on (ws:\/\/\S+)/.exec(text);
  if (match?.[1]) {
    wsEndpoint = match[1];
  }
};
vscodeProc.stdout?.on('data', captureLine);
vscodeProc.stderr?.on('data', captureLine);

async function connect() {
  let lastErr = '';
  for (let i = 0; i < 60; i++) {
    const target = wsEndpoint ?? (port > 0 ? `http://127.0.0.1:${port}` : null);
    if (!target) {
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    try {
      return await chromium.connectOverCDP(target);
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error(
    `Could not connect to VS Code over CDP (${lastErr || 'no endpoint'}).\nLogs:\n${procLog}`,
  );
}

let exitCode = 0;
try {
  const browser = await connect();
  const context = browser.contexts()[0];
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = context?.pages().find((p) => p.url().includes('workbench'));
    if (!page) await new Promise((r) => setTimeout(r, 1000));
  }
  if (!page) {
    throw new Error('VS Code workbench window not found.');
  }

  await page.setViewportSize({ width: 1440, height: 900 }).catch(() => undefined);
  await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
  await page.waitForTimeout(2500);

  // Collapse the Primary Side Bar (if open) so the Nibgrid Studio webview has full editor width
  // while keeping the VS Code window chrome, Activity Bar, tab bar, and status bar visible.
  const sideBarVisible = await page.locator('.part.sidebar').isVisible().catch(() => false);
  if (sideBarVisible) {
    await page.keyboard.press('F1');
    await page.waitForSelector('.quick-input-widget', { timeout: 10000 });
    await page.keyboard.type('View: Close Primary Side Bar', { delay: 15 });
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
  }

  // Open Command Palette (F1) and invoke "Nibgrid: Open Asset Foundry & Composer".
  await page.keyboard.press('F1');
  await page.waitForSelector('.quick-input-widget', { timeout: 15000 });
  await page.keyboard.type('Nibgrid: Open Asset Foundry', { delay: 20 });
  await page
    .locator('.quick-input-list .monaco-list-row', { hasText: 'Nibgrid: Open Asset Foundry' })
    .first()
    .waitFor({ timeout: 20000 });
  await page.keyboard.press('Enter');

  // VS Code renders extension webviews inside nested frames: iframe.webview -> iframe#active-frame.
  const outer = page.frameLocator('iframe.webview.ready').first();
  const app = outer.frameLocator('iframe#active-frame');

  await app.getByTestId('new-project-name').waitFor({ timeout: 60000 });
  await page.waitForTimeout(600);
  await app.getByTestId('new-project-name').fill('Red Cat Warrior');
  await app.getByTestId('create-project-btn').click();
  await app.getByTestId('nav-dialogue-l10n').waitFor({ timeout: 20000 });

  const dialogueNav = app.getByTestId('nav-dialogue-l10n');
  await dialogueNav.evaluate((el) => {
    el.scrollIntoView({ block: 'nearest', inline: 'center' });
    el.click();
  });
  await app.getByTestId('dialogue-l10n-panel').waitFor({ timeout: 20000 });
  await app.getByTestId('dialogue-new-node-id').fill('guard_warn');
  await app.getByTestId('dialogue-new-node-text-key').fill('DLG_GUARD_WARN_01');
  await app.getByTestId('dialogue-new-node-en-text').fill('Halt, traveler!');
  await app.getByTestId('dialogue-new-node-pl-text').fill('Stój, wędrowcze!');
  await app.getByTestId('dialogue-new-node-de-text').fill('Halt, Reisender!');
  await app.getByTestId('dialogue-add-node-btn').click();
  await app
    .getByTestId('audit-glyph-status')
    .getByText('Missing Glyph')
    .first()
    .waitFor({ timeout: 20000 });
  await page.waitForTimeout(800);

  const dialogueShot = join(outDir, 'vscode-dialogue-l10n.png');
  await page.screenshot({ path: dialogueShot });
  console.log('Captured VS Code Dialogue screenshot:', dialogueShot);

  // Also capture VS Code Hub view with created project.
  const projectsNav = app.getByTestId('nav-projects');
  await projectsNav.evaluate((el) => {
    el.scrollIntoView({ block: 'nearest', inline: 'center' });
    el.click();
  });
  await app.getByText('Red Cat Warrior').first().waitFor({ timeout: 20000 });
  await page.waitForTimeout(600);
  const hubShot = join(outDir, 'vscode-project-hub.png');
  await page.screenshot({ path: hubShot });
  console.log('Captured VS Code Project Hub screenshot:', hubShot);

  await browser.close();
} catch (err) {
  console.error(err);
  if (procLog) console.error('VS Code process log:\n', procLog);
  exitCode = 1;
} finally {
  vscodeProc.kill('SIGTERM');
  setTimeout(() => {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }, 500);
}

process.exit(exitCode);
