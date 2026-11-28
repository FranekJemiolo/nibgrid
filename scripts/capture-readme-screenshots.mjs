#!/usr/bin/env node
/**
 * Captures README screenshots of the Nibgrid PWA (GitHub Pages build).
 * Usage: SHOT_URL=http://127.0.0.1:4173/nibgrid/ node scripts/capture-readme-screenshots.mjs
 */
import { chromium } from '@playwright/test';

const url = process.env.SHOT_URL ?? 'http://127.0.0.1:4173/nibgrid/';
const out = process.env.SHOT_OUT ?? 'docs/screenshots';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto(url);
await page.getByTestId('new-project-name').fill('Red Cat Warrior');
await page.getByTestId('create-project-btn').click();
await page.getByTestId('nav-dialogue-l10n').click();
await page.getByTestId('dialogue-l10n-panel').waitFor();
await page.getByTestId('dialogue-new-node-id').fill('guard_warn');
await page.getByTestId('dialogue-new-node-text-key').fill('DLG_GUARD_WARN_01');
await page.getByTestId('dialogue-new-node-en-text').fill('Halt, traveler!');
await page.getByTestId('dialogue-new-node-pl-text').fill('Stój, wędrowcze!');
await page.getByTestId('dialogue-new-node-de-text').fill('Halt, Reisender!');
await page.getByTestId('dialogue-add-node-btn').click();
await page.getByTestId('audit-glyph-status').getByText('Missing Glyph').first().waitFor();
await page.screenshot({ path: `${out}/pwa-dialogue-l10n.png` });

// Director Studio Full-Game Reactive Autopilot (M53)
await page.getByTestId('nav-director-studio').click();
await page.getByTestId('director-studio-view').waitFor();
await page
  .getByTestId('director-prompt-input')
  .fill('Cozy 16-bit dungeon crawler with red cat knight, slime enemy, dungeon room, sword item, and intro dialogue');
await page.getByTestId('director-scope-select').selectOption('multi-room-dungeon');
await page.getByTestId('director-tier-select').selectOption('instant-draft');
await page.getByTestId('director-start-btn').click();
await page.getByTestId('director-anchor-gate').waitFor({ timeout: 15000 });
await page.getByTestId('director-approve-build-btn').click();
await page.getByTestId('director-completion-bar').waitFor({ timeout: 30000 });
await page.screenshot({ path: `${out}/pwa-director-studio.png` });

// Ship to Godot Closed-Loop Compiler & Self-Healing QA (M51/M52)
await page.getByTestId('nav-ship-godot').click();
await page.getByTestId('ship-graph-integrity-badge').waitFor();
await page.getByTestId('ship-autoheal-btn').click();
await page.getByTestId('ship-autoheal-report').waitFor({ timeout: 15000 });
await page.screenshot({ path: `${out}/pwa-ship-godot-compiler.png` });

// Director Asset Composer & Staged Diff (M54)
await page.getByTestId('nav-composer-btn').click();
await page.getByTestId('asset-composer-rail').waitFor();
await page
  .getByTestId('composer-prompt-input')
  .fill('create enemy frost_bat and autofix preflight');
await page.getByTestId('composer-submit-btn').click();
await page.getByTestId('staged-change-card').first().waitFor({ timeout: 15000 });
await page.screenshot({ path: `${out}/pwa-director-composer.png` });

await page.goto(url);
await page.getByText('Red Cat Warrior').first().waitFor();
await page.screenshot({ path: `${out}/pwa-project-hub.png` });

await browser.close();
if (errors.length) {
  console.error('pageerrors:', errors);
  process.exit(1);
}
console.log('Captured PWA screenshots to', out);
