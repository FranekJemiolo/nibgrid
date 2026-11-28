import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M52: Zero-Touch Asset Auto-Pipeline & Self-Healing Pre-Flight E2E', () => {
  test('auto-assembles a Sprite Studio generation into a full Entity card and auto-heals missing glyphs in Ship to Godot', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M52 Auto Pipeline');
    await page.getByTestId('create-project-btn').click();

    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // 1-click Auto-Assemble Entity from Sprite Studio
    await page.getByTestId('auto-assemble-entity-btn').click();
    await expect(page.getByTestId('studio-status')).toContainText('Auto-Assembled');

    await page.getByTestId('nav-entities').click();
    await expect(page.getByTestId('entity-hub-view')).toBeVisible();
    await expect(page.locator('[data-testid^="entity-card-"]')).toHaveCount(1);

    // Create a missing-glyph condition and auto-heal in Ship to Godot
    await page.getByTestId('nav-dialogue-l10n').click();
    await page.getByTestId('dialogue-new-node-id').fill('healer_warn');
    await page.getByTestId('dialogue-new-node-text-key').fill('DLG_HEALER_01');
    await page.getByTestId('dialogue-new-node-en-text').fill('Welcome!');
    await page.getByTestId('dialogue-new-node-pl-text').fill('Stój, wędrowcze!');
    await page.getByTestId('dialogue-new-node-de-text').fill('Willkommen!');
    await page.getByTestId('dialogue-add-node-btn').click();

    await page.getByTestId('workspace-tab-ship-godot').click();
    await expect(page.getByTestId('fixit-card-missing-glyphs')).toBeVisible();
    await page.getByTestId('ship-autoheal-btn').click();
    await expect(page.getByTestId('ship-autoheal-report')).toContainText('Self-Healed');
    await expect(page.getByTestId('fixit-card-missing-glyphs')).toBeHidden();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
