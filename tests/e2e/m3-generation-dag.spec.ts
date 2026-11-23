import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M3 Mock Generation, Inpainting & Branching DAG', () => {
  test('generates 2 variants, inpaints Variant 2 into 3rd-level child, compares, and restores full DAG on reload', async ({
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

    // Create project and enter Sprite Studio
    await page.getByTestId('new-project-name').fill('Iron Paladin');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    // Upload sketch and verify Offline Mock Provider is selected
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await expect(page.getByTestId('provider-select')).toHaveValue('offline-mock');
    await expect(page.getByTestId('cost-estimate-badge')).toContainText('$0.00');

    // Enter prompt delta and generate 2 variants
    await page.getByTestId('prompt-delta-input').fill('metallic armor trim');
    await page.getByTestId('variant-count-select').selectOption('2');
    await page.getByTestId('generate-btn').click();

    // Wait for 1 root sketch + 2 generation children
    const allNodes = page.locator('[data-testid^="dag-node-"]');
    await expect(allNodes).toHaveCount(3);
    const genNodes = page.locator('[data-node-kind="generation"]');
    await expect(genNodes).toHaveCount(2);

    const rootNodeId = (await page
      .locator('[data-node-kind="sketch"]')
      .first()
      .getAttribute('data-testid'))!.replace('dag-node-', '');
    await expect(genNodes.nth(0)).toHaveAttribute('data-parent-id', rootNodeId);
    await expect(genNodes.nth(1)).toHaveAttribute('data-parent-id', rootNodeId);

    // Select Variant 2
    const variant2TestId = await genNodes.nth(1).getAttribute('data-testid');
    const variant2Id = variant2TestId!.replace('dag-node-', '');
    await page.getByTestId(`select-node-${variant2Id}`).click();

    // Paint an inpaint mask stroke on the canvas
    await page.getByTestId('mode-inpaint-mask').click();
    const box = await page.getByTestId('sketch-canvas').boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width * 0.4, box!.y + box!.height * 0.4);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width * 0.6, box!.y + box!.height * 0.55, { steps: 8 });
    await page.mouse.up();

    // Click Inpaint Masked Region
    await expect(page.getByTestId('inpaint-btn')).toBeEnabled();
    await page.getByTestId('inpaint-btn').click();

    // Assert 3rd-level inpaint child node appears under Variant 2
    const inpaintNodes = page.locator('[data-node-kind="inpaint"]');
    await expect(inpaintNodes).toHaveCount(1);
    await expect(inpaintNodes.first()).toHaveAttribute('data-parent-id', variant2Id);
    await expect(inpaintNodes.first()).toHaveAttribute('data-node-depth', '2');
    await expect(allNodes).toHaveCount(4);

    // Open Compare view between Variant 2 and Inpaint child
    const inpaintId = (await inpaintNodes.first().getAttribute('data-testid'))!.replace(
      'dag-node-',
      '',
    );
    await page.getByTestId(`compare-node-${inpaintId}`).click();
    await expect(page.getByTestId('compare-split-view')).toBeVisible();
    await expect
      .poll(async () =>
        page
          .getByTestId('compare-image-left')
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(async () =>
        page
          .getByTestId('compare-image-right')
          .evaluate((el) => (el as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);

    await page.getByTestId('close-compare-btn').click();
    await expect(page.getByTestId('compare-split-view')).toBeHidden();

    // Reload browser and verify full 3-level DAG tree restores intact from IndexedDB
    await page.reload();
    await expect(page.getByTestId('dag-tree')).toBeVisible();
    await expect(page.locator('[data-testid^="dag-node-"]')).toHaveCount(4);
    await expect(page.locator('[data-node-kind="sketch"]')).toHaveCount(1);
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(2);
    await expect(page.locator('[data-node-kind="inpaint"]')).toHaveCount(1);
    await expect(page.locator('[data-node-kind="inpaint"]').first()).toHaveAttribute(
      'data-node-depth',
      '2',
    );
    await expect(page.locator('[data-node-kind="inpaint"]').first()).toHaveAttribute(
      'data-parent-id',
      variant2Id,
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
