import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const PALETTE_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/test-palette.gpl');
const GOLDEN_REF_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/golden-ref.png');

test.describe('M1 Art Bible & IndexedDB Persistence', () => {
  test('persists project, Art Bible style lock, .gpl palette, and Golden Reference across reload', async ({
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

    await page.getByTestId('new-project-name').fill('Dungeon Knight');
    await page.getByTestId('create-project-btn').click();

    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await expect(page.getByTestId('bible-project-name')).toHaveText('Dungeon Knight');

    await page.getByTestId('projection-select').selectOption('top-down');
    await page.getByTestId('art-mode-select').selectOption('pixel-art');

    await page.getByTestId('palette-file-input').setInputFiles(PALETTE_FIXTURE);
    await expect(page.getByTestId('palette-swatch-#1A1C2C')).toBeVisible();
    await expect(page.getByTestId('palette-swatch-#B13E53')).toBeVisible();
    await expect(page.getByTestId('palette-swatch-#FFCD75')).toBeVisible();
    await expect(page.getByTestId('palette-swatch-#38B764')).toBeVisible();

    await page.getByTestId('golden-ref-input').setInputFiles(GOLDEN_REF_FIXTURE);
    const refImg = page.getByTestId('golden-ref-image-0');
    await expect(refImg).toBeVisible();

    // Give IndexedDB writes a moment to settle (plus verify indicator)
    await expect
      .poll(async () => refImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    await page.reload();

    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await expect(page.getByTestId('bible-project-name')).toHaveText('Dungeon Knight');
    await expect(page.getByTestId('projection-select')).toHaveValue('top-down');
    await expect(page.getByTestId('art-mode-select')).toHaveValue('pixel-art');

    await expect(page.getByTestId('palette-swatch-#1A1C2C')).toBeVisible();
    await expect(page.getByTestId('palette-swatch-#B13E53')).toBeVisible();
    await expect(page.getByTestId('palette-swatch-#FFCD75')).toBeVisible();
    await expect(page.getByTestId('palette-swatch-#38B764')).toBeVisible();

    const reloadedRefImg = page.getByTestId('golden-ref-image-0');
    await expect(reloadedRefImg).toBeVisible();
    await expect
      .poll(async () => reloadedRefImg.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);

    // Also verify Project Hub card reflects persisted data
    await page.getByTestId('back-to-hub-btn').click();
    await expect(page.getByTestId('project-hub')).toBeVisible();
    await expect(page.getByText('Dungeon Knight')).toBeVisible();
    await expect(page.getByText('Top-Down')).toBeVisible();
    await expect(page.getByText('Pixel Art')).toBeVisible();
    await expect(page.getByText('Palette (4)')).toBeVisible();
    await expect(page.getByText('Refs (1/3)')).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});

