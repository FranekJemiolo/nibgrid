import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('Phase 1 Audit: Browser Object URL Memory Leak Guard', () => {
  test('revokes all blob object URLs across 15 Generate -> Inspect -> Post-Process -> Delete cycles', async ({
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

    await page.addInitScript(() => {
      const stats = { created: 0, revoked: 0 };
      (window as unknown as { __nibgridUrlStats: typeof stats }).__nibgridUrlStats = stats;

      const origCreate = URL.createObjectURL.bind(URL);
      const origRevoke = URL.revokeObjectURL.bind(URL);

      URL.createObjectURL = (obj: Blob | MediaSource) => {
        stats.created += 1;
        return origCreate(obj);
      };
      URL.revokeObjectURL = (url: string) => {
        stats.revoked += 1;
        origRevoke(url);
      };
    });

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('Leak Torture Project');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');

    for (let cycle = 1; cycle <= 15; cycle++) {
      await page.getByTestId('seed-input').fill(String(1000 + cycle));
      await page.getByTestId('generate-btn').click();

      const genNodes = page.locator('[data-node-kind="generation"]');
      await expect(genNodes).toHaveCount(1);
      const genTestId = await genNodes.first().getAttribute('data-testid');
      const genId = genTestId!.replace('dag-node-', '');

      // Open Post-Process Inspector & enable color-key
      await page.getByTestId('open-postprocess-btn').click();
      await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
      await page.getByTestId('pp-bg-mode').selectOption('color-key');
      await expect
        .poll(async () =>
          page.getByTestId('processed-preview-canvas').evaluate((el) => {
            const c = el as HTMLCanvasElement;
            return c.getContext('2d')!.getImageData(0, 0, 1, 1).data[3];
          }),
        )
        .toBe(0);

      // Return to Studio and delete the generated leaf node
      await page.getByTestId('back-to-studio-btn').click();
      await expect(page.getByTestId('sprite-studio')).toBeVisible();
      await page.getByTestId(`delete-node-${genId}`).click();
      await expect(genNodes).toHaveCount(0);
    }

    // Navigate back to Project Hub so all Studio/DAG views unmount cleanly
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('project-hub')).toBeVisible();

    const urlStats = await page.evaluate(
      () =>
        (window as unknown as { __nibgridUrlStats: { created: number; revoked: number } })
          .__nibgridUrlStats,
    );

    expect(urlStats.created).toBeGreaterThanOrEqual(15);
    expect(urlStats.created - urlStats.revoked).toBeLessThanOrEqual(2);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
