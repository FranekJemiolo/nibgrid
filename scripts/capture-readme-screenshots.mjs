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

await page.goto(url);
await page.getByText('Red Cat Warrior').first().waitFor();
await page.screenshot({ path: `${out}/pwa-project-hub.png` });

await browser.close();
if (errors.length) {
  console.error('pageerrors:', errors);
  process.exit(1);
}
console.log('Captured PWA screenshots to', out);
