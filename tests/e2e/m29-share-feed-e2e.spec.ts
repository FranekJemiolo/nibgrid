import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M29: Zero-Server #share= Recipe Links & Static Pack Feeds', () => {
  test('generates #share= shader link, opens boot-time Shared Recipe modal to re-bake/import, and imports starter Pack Feed cleanly', async ({
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

    // 1. Create a project -> generate sprite -> open Shader Studio -> generate #share= link
    await page.getByTestId('new-project-name').fill('M29 Share Knight');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await page.getByTestId('inspector-tab-shader').click();
    await expect(page.getByTestId('shader-studio')).toBeVisible();
    await page.getByTestId('shader-preset-wind_sway').click();
    await page.getByTestId('shader-share-link-btn').click();

    await expect(page.getByTestId('share-outgoing-panel')).toBeVisible();
    const shareUrl = await page.getByTestId('share-hash-url-output').inputValue();
    expect(shareUrl).toContain('#share=v1.');
    await page.getByTestId('share-close-btn').click();

    // 2. Navigate directly to the #share=v1. URL -> Shared Recipe Detected modal opens & re-bakes
    const hashOnly = `#${shareUrl.split('#')[1]!}`;
    await page.goto(`/${hashOnly}`);
    await expect(page.getByTestId('share-incoming-panel')).toBeVisible();
    await expect(page.getByTestId('share-rebake-status')).toContainText('WebGL2 valid');

    await page.getByTestId('share-import-project-btn').click();
    await expect(page.getByTestId('shader-studio')).toBeVisible();
    await expect(page.getByTestId('shader-code-editor')).toContainText('void vertex()');

    // 3. Open Asset Vault -> Pack Feeds -> load starter-catalog.json -> Import Pack into project
    await page.getByTestId('nav-asset-vault').click();
    await expect(page.getByTestId('vault-browser-view')).toBeVisible();
    await page.getByTestId('vault-tab-feeds').click();
    await expect(page.getByTestId('pack-feed-browser')).toBeVisible();
    await expect(page.getByTestId('pack-card-retro-rpg-starter')).toBeVisible();

    await page.getByTestId('pack-import-btn-retro-rpg-starter').click();
    await expect(page.getByTestId('pack-import-notice')).toContainText('Retro RPG Starter Pack');

    // Verify pack assets now exist inside Project Browser & Global Vault
    await page.getByTestId('vault-tab-project').click();
    await expect(page.locator('[data-testid^="browser-sprite-card-"]')).toHaveCount(2);

    await page.getByTestId('vault-tab-global').click();
    await expect(page.locator('[data-testid^="vault-item-"]')).toHaveCount(3);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
