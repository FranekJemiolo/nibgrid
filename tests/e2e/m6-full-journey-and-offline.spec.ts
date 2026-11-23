import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

const PALETTE_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/test-palette.gpl');
const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M6 Pivot Export Bundle & Offline PWA Resilience', () => {
  test('executes zero-to-export journey and emits valid PNG + asset.recipe.json ZIP bundle', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('/');

    // 1. Create project & configure Art Bible (4-color .gpl palette)
    await page.getByTestId('new-project-name').fill('Chrono Knight');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();

    await page.getByTestId('projection-select').selectOption('top-down');
    await page.getByTestId('art-mode-select').selectOption('pixel-art');
    await page.getByTestId('palette-file-input').setInputFiles(PALETTE_FIXTURE);
    await expect(page.getByTestId('palette-swatch-#1A1C2C')).toBeVisible();

    // 2. Open Sprite Studio -> upload sketch -> normalize -> generate -> fork with inpaint
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');

    await page.getByTestId('normalize-sketch-btn').click();
    await expect(page.getByTestId('studio-status')).toContainText('Normalized & centered');

    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('prompt-delta-input').fill('royal crest');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // Paint mask stroke & inpaint to create 3rd-level child node
    await page.getByTestId('mode-inpaint-mask').click();
    const box = await page.getByTestId('sketch-canvas').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.42, box!.y + box!.height * 0.42);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.58, box!.y + box!.height * 0.58, { steps: 6 });
    await page.mouse.up();

    await page.getByTestId('inpaint-btn').click();
    await expect(page.locator('[data-node-kind="inpaint"]')).toHaveCount(1);

    // 2b. Animate DAG frames and verify downloadable GIF89a + Horizontal Spritesheet PNG
    await page.getByTestId('open-animation-studio-btn').click();
    await expect(page.getByTestId('animation-studio-modal')).toBeVisible();
    await expect(page.getByTestId('encoded-gif-preview')).toBeVisible();
    await expect
      .poll(async () =>
        page
          .getByTestId('encoded-gif-preview')
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);

    const gifDownloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-gif-btn').click();
    const gifDownload = await gifDownloadPromise;
    const gifBytes = new Uint8Array(readFileSync((await gifDownload.path())!));
    expect(String.fromCharCode(...gifBytes.slice(0, 6))).toBe('GIF89a');
    expect(gifBytes[gifBytes.length - 1]).toBe(0x3b);

    const sheetDownloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-spritesheet-btn').click();
    const sheetDownload = await sheetDownloadPromise;
    const sheetBytes = new Uint8Array(readFileSync((await sheetDownload.path())!));
    expect(Array.from(sheetBytes.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    await page.getByTestId('close-animation-modal-btn').click();

    // 3. Open Post-Process Inspector -> Fast Color-Key + Palette Snap + 64x64 + Bottom-Center pivot
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-palette-snap-toggle').check();
    await page.getByTestId('pp-resample-toggle').check();
    await page.getByTestId('pp-preset-64').click();
    await page.getByTestId('pivot-preset-bottom-center').click();

    await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');
    await expect(page.getByTestId('pivot-norm-readout')).toHaveText('(0.50, 1.00)');

    // 4. Download ZIP bundle & inspect contents
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('download-zip-btn').click();
    const download = await downloadPromise;
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();

    const zipBytes = new Uint8Array(readFileSync(downloadPath!));
    const entries = unzipSync(zipBytes);
    const entryNames = Object.keys(entries);
    const pngName = entryNames.find((name) => name.endsWith('.png'));
    const recipeName = entryNames.find((name) => name.endsWith('.recipe.json'));

    expect(pngName).toBeTruthy();
    expect(recipeName).toBeTruthy();

    const pngData = entries[pngName!]!;
    expect(Array.from(pngData.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);

    const recipeJson = strFromU8(entries[recipeName!]!);
    expect(recipeJson).not.toMatch(/apiKey/i);
    const recipe = JSON.parse(recipeJson) as {
      schemaVersion: string;
      source: { sketchSha256: string };
      output: { width: number; height: number; pivotNorm: { x: number; y: number } };
    };
    expect(recipe.schemaVersion).toBe('1.0.0');
    expect(recipe.source.sketchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(recipe.output.width).toBe(64);
    expect(recipe.output.height).toBe(64);
    expect(recipe.output.pivotNorm).toEqual({ x: 0.5, y: 1 });

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('runs complete Sketch -> Mock Generate -> Post-Process -> ZIP Export loop offline via Service Worker', async ({
    page,
    context,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('/');

    // Wait for PWA Service Worker activation & page control
    await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.ready;
      if (!reg.active) {
        throw new Error('Service Worker failed to activate');
      }
    });
    await page.reload();
    await expect
      .poll(async () => page.evaluate(() => Boolean(navigator.serviceWorker.controller)))
      .toBe(true);

    // Go completely offline and reload the PWA
    await context.setOffline(true);
    try {
      await page.reload();
      await expect(page.getByTestId('project-hub')).toBeVisible();

      await page.getByTestId('new-project-name').fill('Offline Rogue');
      await page.getByTestId('create-project-btn').click();
      await expect(page.getByTestId('art-bible-editor')).toBeVisible();

      await page.getByTestId('go-to-studio-btn').click();
      await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
      await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');

      await page.getByTestId('variant-count-select').selectOption('1');
      await page.getByTestId('generate-btn').click();
      await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

      await page.getByTestId('open-postprocess-btn').click();
      await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

      await page.getByTestId('pp-bg-mode').selectOption('color-key');
      await page.getByTestId('pp-resample-toggle').check();
      await page.getByTestId('pp-preset-64').click();
      await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');

      const downloadPromise = page.waitForEvent('download');
      await page.getByTestId('download-zip-btn').click();
      const download = await downloadPromise;
      const downloadPath = await download.path();
      expect(downloadPath).toBeTruthy();

      const entries = unzipSync(new Uint8Array(readFileSync(downloadPath!)));
      expect(Object.keys(entries).some((k) => k.endsWith('.png'))).toBe(true);
      expect(Object.keys(entries).some((k) => k.endsWith('.recipe.json'))).toBe(true);
    } finally {
      await context.setOffline(false);
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
