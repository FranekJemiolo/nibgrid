import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M7 Pixel-Art Foundry (De-Mixel, Orphan Clean & Sel-Out)', () => {
  test('enables De-Mixel, Orphan Cleaner, and Outer Sel-Out and persists settings in asset.recipe.json', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M7 Foundry Knight');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Activate Background Color-Key + De-Mixel + Orphan Clean + Outer Sel-Out
    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-demixel-toggle').check();
    await page.getByTestId('pp-orphan-toggle').check();
    await page.getByTestId('pp-selout-mode').selectOption('outer');

    await expect(page.getByTestId('pp-demixel-badge')).toBeVisible();
    await expect(page.getByTestId('pp-orphan-badge')).toBeVisible();

    // Download ZIP and assert asset.recipe.json persists all M7 config blocks
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-zip-btn').click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    const fs = await import('node:fs/promises');
    const zipBytes = new Uint8Array(await fs.readFile(downloadPath!));
    const entries = unzipSync(zipBytes);
    const recipeEntryName = Object.keys(entries).find((k) => k.endsWith('.recipe.json'));
    expect(recipeEntryName).toBeTruthy();

    const recipe = JSON.parse(strFromU8(entries[recipeEntryName!]!));
    expect(recipe.postProcess.demixelEnabled).toBe(true);
    expect(recipe.postProcess.orphanCleanEnabled).toBe(true);
    expect(recipe.postProcess.selOutMode).toBe('outer');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
