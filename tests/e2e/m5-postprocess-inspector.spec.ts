import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M5 Deterministic Post-Processing Inspector (Screen 4A)', () => {
  test('applies Fast Color-Key, Defringe, Palette Snap, and 64x64 Nearest-Neighbor with transparent corner', async ({
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

    // Create project & enter Sprite Studio
    await page.getByTestId('new-project-name').fill('PostProcess Paladin');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    // Upload sketch and generate sprite via Offline Mock Provider
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // Navigate to Post-Process & Export Inspector
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('split-comparator')).toBeVisible();

    // Enable Fast Color-Key, Defringe, Palette Snap, and 64x64 Nearest-Neighbor
    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-defringe-toggle').check();
    await page.getByTestId('pp-palette-snap-toggle').check();
    await page.getByTestId('pp-resample-toggle').check();
    await page.getByTestId('pp-resample-mode').selectOption('nearest');
    await page.getByTestId('pp-preset-64').click();

    await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');

    // Wait for worker processing & verify processed-preview-canvas corner (0, 0) alpha === 0
    await expect
      .poll(async () =>
        page.getByTestId('processed-preview-canvas').evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const ctx = canvas.getContext('2d')!;
          const px = ctx.getImageData(0, 0, 1, 1).data;
          return { width: canvas.width, height: canvas.height, cornerAlpha: px[3] ?? 255 };
        }),
      )
      .toEqual({ width: 64, height: 64, cornerAlpha: 0 });

    // Confirm center of sprite has opaque content (not blank)
    const centerAlpha = await page.getByTestId('processed-preview-canvas').evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4) {
        if ((data[i] ?? 0) > 0) opaque++;
      }
      return opaque;
    });
    expect(centerAlpha).toBeGreaterThan(20);

    // Switch inspector backdrop modes
    await page.getByTestId('inspector-backdrop-game-green').click();
    await page.getByTestId('inspector-backdrop-dark').click();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
