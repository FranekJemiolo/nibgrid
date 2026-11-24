import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M12A Seamless Tile 50% Wrap-Offset & Auto-Masking Workflow (Screen 4D)', () => {
  test('wraps 50%, heals cross-seam via Offline Mock inpaint, unwraps into DAG, and records seamlessTile in recipe.json', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M12A Brick Floor');
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

    // Reclassify asset as Tile so Tile & 9-Slice primary tab is promoted, then open Screen 4D
    await page.getByTestId('inspector-asset-class-select').selectOption('tile');
    await page.getByTestId('inspector-tab-tile-slice').click();
    await expect(page.getByTestId('tile-slice-workshop-panel')).toBeVisible();
    await expect(page.getByTestId('workshop-mode-tile')).toBeVisible();

    // 1. Wrap 50% & generate cross-seam mask
    await page.getByTestId('seamless-wrap-mask-btn').click();
    await expect(page.getByTestId('seamless-status-banner')).toContainText('Wrapped 50%');
    await expect(page.getByTestId('seamless-inpaint-btn')).toBeEnabled();

    // 2. Run Offline Mock Inpaint over cross-seam mask
    await page.getByTestId('seamless-inpaint-btn').click();
    await expect(page.getByTestId('seamless-status-banner')).toContainText('Healed cross-seam');

    // 3. Un-Wrap & commit new child node into DAG
    await page.getByTestId('seamless-unwrap-btn').click();
    await expect(page.getByTestId('seamless-status-banner')).toContainText(
      'Committed seamless tile',
    );

    // Confirm live 3x3 tiled canvas rendered non-empty bitmap (3 * 128 = 384)
    await expect
      .poll(async () =>
        page.getByTestId('seamless-tiled-canvas').evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const ctx = canvas.getContext('2d');
          if (!ctx || canvas.width === 0) return { width: 0, nonEmpty: false };
          const d = ctx.getImageData(0, 0, Math.min(32, canvas.width), Math.min(32, canvas.height));
          let hasVisible = false;
          for (let i = 3; i < d.data.length; i += 4) {
            if ((d.data[i] ?? 0) > 0) {
              hasVisible = true;
              break;
            }
          }
          return { width: canvas.width, nonEmpty: hasVisible };
        }),
      )
      .toEqual({ width: 384, nonEmpty: true });

    // Verify toroidal normal map integration automatically enables seamless badge when switching to Normal Map tab
    await page.getByTestId('inspector-tab-normal').click();
    await expect(page.getByTestId('normal-seamless-badge')).toBeVisible();

    // Export ZIP and verify asset.recipe.json records seamlessTile metadata
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('download-zip-btn').click();
    const download = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
    const recipeName = Object.keys(entries).find((k) => k.endsWith('.recipe.json'));
    expect(recipeName).toBeTruthy();

    const recipe = JSON.parse(strFromU8(entries[recipeName!]!));
    expect(recipe.seamlessTile).toBeDefined();
    expect(recipe.seamlessTile.isSeamlessTile).toBe(true);
    expect(typeof recipe.seamlessTile.continuityScore).toBe('number');

    // Navigate back to Sprite Studio and confirm unwrapped child node entered DAG
    await page.getByTestId('back-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();
    await expect(page.locator('[data-node-kind="inpaint"]')).toHaveCount(1);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
