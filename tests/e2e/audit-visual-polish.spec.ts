import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const SCREENSHOT_DIR = resolve(process.cwd(), 'test-results/polish-screenshots');

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 720 },
  { width: 1024, height: 768 },
] as const;

async function assertNoHorizontalOverflow(page: Page): Promise<void> {
  const dims = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  expect(dims.scrollWidth).toBeLessThanOrEqual(dims.innerWidth);
}

async function assertCrosshairAndSplitAligned(page: Page): Promise<void> {
  const canvasBox = await page.getByTestId('processed-preview-canvas').boundingBox();
  const crosshairBox = await page.getByTestId('pivot-crosshair').boundingBox();
  const splitBox = await page.getByTestId('split-handle').boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(crosshairBox).not.toBeNull();
  expect(splitBox).not.toBeNull();

  if (canvasBox && crosshairBox && splitBox) {
    const targetX = canvasBox.x + canvasBox.width / 2;
    const targetY = canvasBox.y + canvasBox.height;
    const crosshairCenterX = crosshairBox.x + crosshairBox.width / 2;
    const crosshairCenterY = crosshairBox.y + crosshairBox.height / 2;
    const splitCenterX = splitBox.x + splitBox.width / 2;
    expect(Math.abs(crosshairCenterX - targetX)).toBeLessThanOrEqual(2);
    expect(Math.abs(crosshairCenterY - targetY)).toBeLessThanOrEqual(2);
    expect(Math.abs(splitCenterX - targetX)).toBeLessThanOrEqual(2);
  }
}

test.describe('Phase 3 Audit: Visual Polish, Pixel-Art Fidelity & Studio Ergonomics', () => {
  test('verifies layout containment, pixel-art crispness, shortcut isolation, and pivot alignment', async ({
    page,
    browser,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    mkdirSync(SCREENSHOT_DIR, { recursive: true });

    await page.goto('/');

    // 1. Project Hub responsive overflow check across 1440 / 1280 / 1024
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width === 1440) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'hub-1440.png') });
      }
    }

    // 2. Art Bible Editor responsive check
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('new-project-name').fill('Polish Audit Knight');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('art-mode-select').selectOption('pixel-art');

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width === 1440) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'bible-1440.png') });
      }
    }

    // 3. Sprite Studio: generate node, verify crisp pixelated rendering & shortcut isolation
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    const sketchImageRendering = await page
      .getByTestId('sketch-canvas')
      .evaluate((el) => getComputedStyle(el).imageRendering);
    expect(sketchImageRendering).toBe('pixelated');

    // Verify typing shortcut letters inside prompt delta input does NOT switch tools/grid
    await expect(page.getByTestId('tool-sketch-pen')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('toggle-pixel-grid')).toHaveAttribute('aria-pressed', 'true');
    const promptInput = page.getByTestId('prompt-delta-input');
    await promptInput.click();
    await promptInput.pressSequentially('b e m g');
    await expect(promptInput).toHaveValue('b e m g');
    await expect(page.getByTestId('tool-sketch-pen')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('toggle-pixel-grid')).toHaveAttribute('aria-pressed', 'true');

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width === 1440) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'studio-1440.png') });
      } else if (vp.width === 1024) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'studio-1024.png') });
      }
    }

    // 4. Post-Process Inspector: 64x64 resample + Bottom-Center pivot alignment within <= 2px
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-resample-toggle').check();
    await page.getByTestId('pp-preset-64').click();
    await expect(page.getByTestId('processed-dimensions-badge')).toContainText('64×64', {
      timeout: 5000,
    });

    await page.getByTestId('pivot-preset-bottom-center').click();
    await expect(page.getByTestId('pivot-norm-readout')).toContainText('(0.50, 1.00)');

    const processedRendering = await page
      .getByTestId('processed-preview-canvas')
      .evaluate((el) => getComputedStyle(el).imageRendering);
    expect(processedRendering).toBe('pixelated');

    // Verify Bottom-Center crosshair & 50% split handle align cleanly at 100%, 200%, and 400% zoom
    const zoomBadge = page.getByTestId('inspector-zoom-badge');
    const zoomOutBtn = page.getByTestId('inspector-zoom-out-btn');
    const zoomInBtn = page.getByTestId('inspector-zoom-in-btn');

    for (let i = 0; i < 4; i++) await zoomOutBtn.click(); // 300% -> 100%
    await expect(zoomBadge).toHaveText('100%');
    await assertCrosshairAndSplitAligned(page);

    for (let i = 0; i < 2; i++) await zoomInBtn.click(); // 100% -> 200%
    await expect(zoomBadge).toHaveText('200%');
    await assertCrosshairAndSplitAligned(page);

    for (let i = 0; i < 4; i++) await zoomInBtn.click(); // 200% -> 400%
    await expect(zoomBadge).toHaveText('400%');
    await assertCrosshairAndSplitAligned(page);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width === 1440) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'inspector-1440.png') });
      } else if (vp.width === 1024) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'inspector-1024.png') });
      }
    }

    // Verify High-DPI (deviceScaleFactor: 2) crosshair & split alignment in an isolated context
    const hiDpiContext = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 2,
    });
    try {
      const hiDpiPage = await hiDpiContext.newPage();
      await hiDpiPage.goto('/');
      const dpr = await hiDpiPage.evaluate(() => window.devicePixelRatio);
      expect(dpr).toBe(2);

      await hiDpiPage.getByTestId('new-project-name').fill('HiDPI Knight');
      await hiDpiPage.getByTestId('create-project-btn').click();
      await hiDpiPage.getByTestId('go-to-studio-btn').click();
      await hiDpiPage.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
      await hiDpiPage.getByTestId('variant-count-select').selectOption('1');
      await hiDpiPage.getByTestId('generate-btn').click();
      await expect(hiDpiPage.locator('[data-node-kind="generation"]')).toHaveCount(1);
      await hiDpiPage.getByTestId('open-postprocess-btn').click();
      await hiDpiPage.getByTestId('pivot-preset-bottom-center').click();
      await assertCrosshairAndSplitAligned(hiDpiPage);
    } finally {
      await hiDpiContext.close();
    }

    expect(pageErrors).toEqual([]);
  });
});
