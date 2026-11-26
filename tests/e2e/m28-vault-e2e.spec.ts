import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M28: Global Asset Vault, Smart Browser & Portable .nibgrid.zip Snapshots', () => {
  test('promotes sprite & shader to Global Vault, imports into second project, exports/imports .nibgrid.zip, and persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // 1. Create Project A and generate 1 sprite variant
    await page.getByTestId('new-project-name').fill('M28 Alpha Vault');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // 2. Open Shader Studio -> Pixel Outline -> Save -> Promote Shader to Global Vault
    await page.getByTestId('open-postprocess-btn').click();
    await page.getByTestId('inspector-tab-shader').click();
    await expect(page.getByTestId('shader-studio')).toBeVisible();
    await page.getByTestId('shader-preset-pixel_outline').click();
    await page.getByTestId('shader-save-btn').click();
    await page.getByTestId('shader-promote-vault-btn').click();
    await expect(page.getByTestId('shader-status-notice')).toContainText('Promoted');

    // 3. Open Asset Vault -> Project Browser -> Promote the generated sprite
    await page.getByTestId('nav-asset-vault').click();
    await expect(page.getByTestId('vault-browser-view')).toBeVisible();
    await page.getByTestId('vault-tab-project').click();

    const genPromoteBtn = page.locator('[data-testid^="promote-sprite-"]').last();
    await genPromoteBtn.click();
    await expect(page.getByTestId('vault-status-banner')).toContainText('Promoted');

    // 4. Create Project B -> Open Global Vault -> Import sprite & shader in 1 click each
    await page.getByTestId('nav-projects').click();
    await page.getByTestId('new-project-name').fill('M28 Beta Reuse');
    await page.getByTestId('create-project-btn').click();

    await page.getByTestId('nav-asset-vault').click();
    await page.getByTestId('vault-tab-global').click();
    await expect(page.locator('[data-testid^="vault-item-"]')).toHaveCount(2);

    // Import sprite first (so target node exists for shader) then import shader
    await page
      .locator('[data-vault-kind="sprite"] [data-testid^="vault-import-btn-"]')
      .first()
      .click();
    await expect(page.getByTestId('vault-status-banner')).toContainText('Imported sprite');

    await page
      .locator('[data-vault-kind="shader"] [data-testid^="vault-import-btn-"]')
      .first()
      .click();
    await expect(page.getByTestId('vault-status-banner')).toContainText('Imported shader');

    await page.getByTestId('vault-tab-project').click();
    await expect(page.locator('[data-testid^="browser-sprite-card-"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="browser-sprite-card-"]').first()).toContainText(
      'shader:pixel_outline',
    );

    // 5. Export Project B as .nibgrid.zip -> re-import as new project
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('export-snapshot-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe('m28-beta-reuse.nibgrid.zip');
    const zipPath = await download.path();
    expect(zipPath).not.toBeNull();
    const zipBytes = await readFile(zipPath!);
    expect(zipBytes.byteLength).toBeGreaterThan(100);

    await page.getByTestId('snapshot-import-input').setInputFiles({
      name: 'm28-beta-reuse.nibgrid.zip',
      mimeType: 'application/zip',
      buffer: zipBytes,
    });
    await expect(page.getByTestId('vault-status-banner')).toContainText(
      'Imported "M28 Beta Reuse (Imported)"',
    );
    await expect(page.locator('[data-testid^="browser-sprite-card-"]')).toHaveCount(1);

    // 6. Hard reload and confirm persistence + zero errors
    await page.reload();
    await expect(page.getByTestId('vault-browser-view')).toBeVisible();
    await expect(page.locator('[data-testid^="browser-sprite-card-"]')).toHaveCount(1);
    await page.getByTestId('vault-tab-global').click();
    await expect(page.locator('[data-testid^="vault-item-"]')).toHaveCount(2);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
