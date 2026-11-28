#!/usr/bin/env node
/**
 * Captures step-by-step screenshots for `docs/TUTORIAL_RED_CAT_STARBASE.md`
 * walking through a complete 2D platformer: Red Cat with Lightsaber vs. Lunar Starbase Robots.
 *
 * Usage:
 *   SHOT_URL=http://127.0.0.1:4173/nibgrid/ node scripts/capture-tutorial-screenshots.mjs
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';

const url = process.env.SHOT_URL ?? 'http://127.0.0.1:4173/nibgrid/';
const out = resolve(process.cwd(), process.env.SHOT_OUT ?? 'docs/screenshots/tutorial');
const RED_CAT_SPRITE = resolve(process.cwd(), 'docs/demo/red-cat-warrior-final-64x64.png');

mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
});
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

// Seed project and open Workspace 1 (Director Studio)
await page.goto(url);
await page.getByTestId('new-project-name').fill('Crimson Whisker: Lunar Starbase');
await page.getByTestId('create-project-btn').click();
await page.getByTestId('workspace-tab-style-vision').click();
await page.getByTestId('director-studio-view').waitFor();

// 1. Director Studio Full-Game Reactive DAG (Red Cat Lightsaber vs Lunar Starbase Robots)
await page
  .getByTestId('director-prompt-input')
  .fill(
    '16-bit sci-fi 2D platformer: red cat hero with blue glowing lightsaber defeating bad robots in a star base on a remote moon, steel lunar bulkhead tileset, cratered moon parallax skyline, cyan sci-fi HUD',
  );
await page.getByTestId('director-genre-select').selectOption('side-platformer');
await page.getByTestId('director-scope-select').selectOption('multi-room-dungeon');
await page.getByTestId('director-tier-select').selectOption('instant-draft');
await page.getByTestId('director-start-btn').click();
await page.getByTestId('director-anchor-gate').waitFor({ timeout: 20000 });
await page.getByTestId('director-approve-build-btn').click();
await page.getByTestId('director-completion-bar').waitFor({ timeout: 45000 });
await page.screenshot({ path: resolve(out, '01-director-starbase-dag.png') });

// 2. Art Bible: attach the Red Cat Golden Reference
await page.getByTestId('nav-art-bible').click();
await page.getByTestId('art-bible-editor').waitFor();
await page.getByTestId('golden-ref-input').setInputFiles(RED_CAT_SPRITE);
await page.getByTestId('golden-ref-grid').locator('img').first().waitFor({ timeout: 10000 });
await page.screenshot({ path: resolve(out, '02-art-bible-red-cat-ref.png') });

// 3. Sprite Studio: upload Red Cat + generate + 1-click Auto-Assemble Entity
await page.getByTestId('nav-sprite-studio').click();
await page.getByTestId('sprite-studio').waitFor();
await page.getByTestId('sketch-upload-input').setInputFiles(RED_CAT_SPRITE);
await page.getByTestId('variant-count-select').selectOption('2');
await page
  .getByTestId('prompt-delta-input')
  .fill('red cat hero wielding glowing cyan plasma lightsaber in lunar starbase');
await page.getByTestId('generate-btn').click();
await page.locator('[data-node-kind="generation"]').first().waitFor({ timeout: 15000 });
await page.getByTestId('auto-assemble-entity-btn').click();
await page.getByTestId('studio-status').getByText('Auto-Assembled').waitFor({ timeout: 15000 });
await page.screenshot({ path: resolve(out, '03-sprite-studio-red-cat-assemble.png') });

// 4. Entity Hub + 60 Hz Mini-Playtest Stage
await page.getByTestId('nav-entities').click();
await page.getByTestId('entity-hub-view').waitFor();
await page.locator('[data-testid^="entity-playtest-"]').first().click();
await page.getByTestId('playtest-stage-modal').waitFor();
await page.waitForTimeout(500);
await page.screenshot({ path: resolve(out, '04-entity-hub-playtest.png') });
await page.getByTestId('playtest-close-btn').click();

// 5. Agentic Asset Composer (Cmd+L) adding Laser Turret Robot + Airlock Alert Dialogue
await page.getByTestId('nav-composer-btn').click();
await page.getByTestId('asset-composer-rail').waitFor();
await page
  .getByTestId('composer-prompt-input')
  .fill(
    'create enemy laser_turret_bot and add dialogue node airlock_alert "Red alert! Rogue robots breached the lunar airlock!" and autofix preflight',
  );
await page.getByTestId('composer-submit-btn').click();
await page.getByTestId('staged-change-card').first().waitFor({ timeout: 15000 });
await page.screenshot({ path: resolve(out, '05-composer-add-robot-boss.png') });
await page.getByTestId('composer-accept-all-btn').click();
await page.getByTestId('checkpoint-restore-btn').first().waitFor({ timeout: 10000 });
await page.getByTestId('nav-composer-btn').click();

// 6. Multi-Room World Map + Softlock Audit + Minimap Bake
await page.getByTestId('nav-world-map').click();
await page.getByTestId('world-map-panel').waitFor();
await page.getByTestId('world-map-canvas').waitFor();
await page.getByTestId('world-run-audit-btn').click();
await page.getByTestId('world-bake-minimap-btn').click();
await page.waitForTimeout(400);
await page.screenshot({ path: resolve(out, '06-world-map-lunar-starbase.png') });

// 7. Data Foundry: Plasma Lightsaber Balance + Monte Carlo TTK Histogram
await page.getByTestId('nav-data-foundry').click();
await page.getByTestId('data-foundry-panel').waitFor();
await page.getByTestId('data-new-weapon-id').fill('plasma_lightsaber');
await page.getByTestId('data-new-weapon-name').fill('Plasma Lightsaber');
await page.getByTestId('data-new-weapon-damage').fill('38');
await page.getByTestId('data-new-weapon-aps').fill('1.8');
await page.getByTestId('data-add-weapon-btn').click();
await page.getByTestId('balance-weapon-select').selectOption('plasma_lightsaber');
await page.getByTestId('balance-run-sim-btn').click();
await page.getByTestId('balance-ttk-histogram').waitFor();
await page.screenshot({ path: resolve(out, '07-data-foundry-saber-balance.png') });

// 8. Dialogue & Localization Studio: Starbase Briefing + Missing Glyph Audit
await page.getByTestId('nav-dialogue-l10n').click();
await page.getByTestId('dialogue-l10n-panel').waitFor();
await page.getByTestId('dialogue-new-node-id').fill('moon_base_briefing');
await page.getByTestId('dialogue-new-node-text-key').fill('DLG_LUNAR_BRIEF_01');
await page
  .getByTestId('dialogue-new-node-en-text')
  .fill('Commander Whisker, rogue droids seized Lunar Sector 7!');
await page
  .getByTestId('dialogue-new-node-pl-text')
  .fill('Komandorze, zbuntowane roboty przejęły Sektor 7!');
await page
  .getByTestId('dialogue-new-node-de-text')
  .fill('Kommandant, abtrünnige Roboter haben Sektor 7 besetzt!');
await page.getByTestId('dialogue-add-node-btn').click();
await page.getByTestId('audit-glyph-status').waitFor();
await page.screenshot({ path: resolve(out, '08-dialogue-l10n-starbase.png') });

// 9. Audio Foundry: Procedural Lightsaber Slash SFX + 4x Variations + LUFS Normalization
await page.getByTestId('nav-audio-foundry').click();
await page.getByTestId('audio-foundry').waitFor();
await page.getByTestId('audio-generate-btn').click();
await page.getByTestId('audio-output-lufs').waitFor({ timeout: 15000 });
await page.getByTestId('audio-var-4').click();
await page.getByTestId('audio-clip-name-input').fill('lightsaber_slash');
await page.getByTestId('audio-save-btn').click();
await page.getByTestId('audio-saved-list').locator('[data-testid^="audio-saved-item-"]').first().waitFor();
await page.screenshot({ path: resolve(out, '09-audio-foundry-saber-sfx.png') });

// 10. Ship to Godot: Auto-Heal Pre-Flight, Preserve Scaffolds & F5 Turnkey Export
await page.getByTestId('nav-ship-godot').click();
await page.getByTestId('ship-godot-panel').waitFor();
await page.getByTestId('ship-graph-integrity-badge').waitFor();
await page.getByTestId('ship-autoheal-btn').click();
await page.getByTestId('ship-autoheal-report').waitFor({ timeout: 15000 });
await page.screenshot({ path: resolve(out, '10-ship-godot-f5-ready.png') });

await browser.close();
if (errors.length) {
  console.error('pageerrors:', errors);
  process.exit(1);
}
console.log('Captured 10 tutorial screenshots to', out);
