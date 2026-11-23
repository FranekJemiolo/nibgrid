import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M2 Sketch Studio, Normalization Worker & Mask Canvas', () => {
  test('uploads raw sketch, normalizes in Web Worker, paints mask stroke, and toggles viewport controls', async ({
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

    await page.getByTestId('new-project-name').fill('Forest Ranger');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();

    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    // Upload off-center noisy paper sketch
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');

    // Run Web Worker normalization ("Extract Lines & Center")
    await page.getByTestId('normalize-sketch-btn').click();
    await expect(page.getByTestId('normalize-sketch-btn')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('studio-status')).toContainText('Normalized & centered');

    // Verify sketch-canvas contains pure white outer margin & centered dark ink pixels
    const sketchStats = await page.getByTestId('sketch-canvas').evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let darkPixels = 0;
      const cornerIsWhite = data[0] === 255 && data[1] === 255 && data[2] === 255;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i] ?? 255) < 50) darkPixels++;
      }
      return { darkPixels, cornerIsWhite, width: canvas.width, height: canvas.height };
    });
    expect(sketchStats.cornerIsWhite).toBe(true);
    expect(sketchStats.darkPixels).toBeGreaterThan(100);

    // Switch to Inpaint Mask mode and draw a stroke across the canvas
    await page.getByTestId('mode-inpaint-mask').click();
    const canvasBox = await page.getByTestId('sketch-canvas').boundingBox();
    expect(canvasBox).not.toBeNull();
    const startX = canvasBox!.x + canvasBox!.width * 0.35;
    const startY = canvasBox!.y + canvasBox!.height * 0.45;
    const endX = canvasBox!.x + canvasBox!.width * 0.65;
    const endY = canvasBox!.y + canvasBox!.height * 0.55;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, endY, { steps: 10 });
    await page.mouse.up();

    // Verify mask-canvas has painted red overlay pixels and mask-pixel-count > 0
    const maskStats = await page.getByTestId('mask-canvas').evaluate((el) => {
      const canvas = el as HTMLCanvasElement;
      const ctx = canvas.getContext('2d')!;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let painted = 0;
      for (let i = 0; i < data.length; i += 4) {
        if ((data[i + 3] ?? 0) > 0 && (data[i] ?? 0) > 200) painted++;
      }
      return painted;
    });
    expect(maskStats).toBeGreaterThan(10);

    // Toggle mask visibility
    await page.getByTestId('toggle-mask-visibility').click();
    await expect(page.getByTestId('mask-canvas')).toHaveClass(/opacity-0/);
    await page.getByTestId('toggle-mask-visibility').click();
    await expect(page.getByTestId('mask-canvas')).toHaveClass(/opacity-100/);

    // Switch backdrop modes and zoom
    await page.getByTestId('backdrop-dark').click();
    await expect(page.getByTestId('viewport-backdrop')).toHaveAttribute('data-backdrop', 'dark');
    await page.getByTestId('backdrop-light').click();
    await expect(page.getByTestId('viewport-backdrop')).toHaveAttribute('data-backdrop', 'light');
    await page.getByTestId('backdrop-checkerboard').click();
    await expect(page.getByTestId('viewport-backdrop')).toHaveAttribute(
      'data-backdrop',
      'checkerboard',
    );

    await page.getByTestId('zoom-in-btn').click();
    await expect(page.getByTestId('zoom-level-badge')).toHaveText('350%');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
