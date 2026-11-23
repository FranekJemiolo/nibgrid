import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const SCREENSHOT_DIR = resolve(process.cwd(), 'test-results/polish-m11');

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

async function seedProjectToInspector(page: Page, projectName: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('new-project-name').fill(projectName);
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

  await page.getByTestId('pp-bg-mode').selectOption('color-key');
  await page.getByTestId('pp-resample-toggle').check();
  await page.getByTestId('pp-preset-64').click();
  await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');
}

test.describe('Post-M11 Audit Phase 3: Visual Polish, High-DPI Precision & Screen 5 UX', () => {
  test('verifies Screen 4B/4C/5 responsive layouts, Alt+Wheel Z readout, canvas click-to-highlight, and pixel-art crispness', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    mkdirSync(SCREENSHOT_DIR, { recursive: true });
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedProjectToInspector(page, 'Audit Polish 1x');

    // Screen 4B: Normal Map preview responsive + Alt+Wheel Z readout without outer page scroll
    await page.getByTestId('inspector-tab-normal').click();
    await expect(page.getByTestId('normal-map-preview-panel')).toBeVisible();

    const zBefore = await page.getByTestId('normal-light-z-readout').innerText();
    expect(zBefore).toBe('0.28');
    const stageBox = await page.getByTestId('normal-light-stage').boundingBox();
    expect(stageBox).not.toBeNull();
    await page.mouse.move(
      stageBox!.x + stageBox!.width * 0.5,
      stageBox!.y + stageBox!.height * 0.5,
    );
    await page.keyboard.down('Alt');
    await page.mouse.wheel(0, -150);
    await page.keyboard.up('Alt');
    await expect(page.getByTestId('normal-light-z-readout')).not.toHaveText('0.28');
    const scrollYAfterWheel = await page.evaluate(() => window.scrollY);
    expect(scrollYAfterWheel).toBe(0);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width === 1440) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'normal-map-1440.png') });
      }
    }

    // Screen 4C: Puppet Warp Editor responsive + pin markers + onion skins
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('inspector-tab-puppet').click();
    await expect(page.getByTestId('puppet-warp-panel')).toBeVisible();

    const puppetCanvasBox = await page.getByTestId('puppet-pin-canvas').boundingBox();
    expect(puppetCanvasBox).not.toBeNull();
    await page.getByTestId('puppet-role-anchor').click();
    await page.mouse.click(
      puppetCanvasBox!.x + puppetCanvasBox!.width * 0.5,
      puppetCanvasBox!.y + puppetCanvasBox!.height * 0.78,
    );
    await page.getByTestId('puppet-role-tip').click();
    await page.mouse.click(
      puppetCanvasBox!.x + puppetCanvasBox!.width * 0.5,
      puppetCanvasBox!.y + puppetCanvasBox!.height * 0.24,
    );
    await page.getByTestId('puppet-onion-skin-toggle').check();
    await page.getByTestId('puppet-play-toggle').click(); // pause on legible onion frame for screenshot

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width === 1440) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'puppet-warp-1440.png') });
      }
    }

    // Screen 5: Atlas Workshop pixel rendering, empty state, click-to-highlight, and responsive viewports
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('nav-atlas-workshop').click();
    await expect(page.getByTestId('atlas-workshop')).toBeVisible();
    await expect(page.getByTestId('atlas-preview-canvas')).toBeVisible();

    // Check CSS pixelated & click-to-highlight card
    const atlasCssRendering = await page
      .getByTestId('atlas-preview-canvas')
      .evaluate((el) => getComputedStyle(el).imageRendering);
    expect(atlasCssRendering).toMatch(/pixelated|crisp-edges/);

    await expect(page.getByTestId('atlas-card-0')).toHaveAttribute('data-highlighted', 'false');
    const atlasCanvasBox = await page.getByTestId('atlas-preview-canvas').boundingBox();
    expect(atlasCanvasBox).not.toBeNull();
    await page.mouse.click(
      atlasCanvasBox!.x + atlasCanvasBox!.width * 0.5,
      atlasCanvasBox!.y + atlasCanvasBox!.height * 0.12,
    );
    await expect(page.getByTestId('atlas-card-0')).toHaveAttribute('data-highlighted', 'true');

    // Screenshot 1440 and 1024 before testing empty toggle
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width === 1440) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'atlas-workshop-1440.png') });
      } else if (vp.width === 1024) {
        await page.screenshot({ path: resolve(SCREENSHOT_DIR, 'atlas-workshop-1024.png') });
      }
    }

    // Toggle off all sprites & puppet loops -> verifies empty state cleanly without error
    await page.getByTestId('atlas-item-0').uncheck();
    if ((await page.getByTestId('atlas-loop-0').count()) > 0) {
      await page.getByTestId('atlas-loop-0').uncheck();
    }
    await expect(page.getByTestId('atlas-empty-state')).toBeVisible();
    await expect(page.getByTestId('download-atlas-zip-btn')).toBeDisabled();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('verifies high-DPI (devicePixelRatio=2) pin placement lands within <= 1px accuracy', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await seedProjectToInspector(page, 'Audit HiDPI 2x');
    await page.getByTestId('inspector-tab-puppet').click();
    await expect(page.getByTestId('puppet-warp-panel')).toBeVisible();

    const dpr = await page.evaluate(() => window.devicePixelRatio);
    expect(dpr).toBe(2);

    const canvasBox = await page.getByTestId('puppet-pin-canvas').boundingBox();
    expect(canvasBox).not.toBeNull();

    // Sprite is 64x64 with default paddingPx = 8 => frame is 80x80
    const nx = 0.35;
    const ny = 0.72;
    const expectedSpriteX = nx * 80 - 8; // 20.0
    const expectedSpriteY = ny * 80 - 8; // 49.6

    await page.mouse.click(
      canvasBox!.x + canvasBox!.width * nx,
      canvasBox!.y + canvasBox!.height * ny,
    );

    const marker = page.getByTestId('puppet-pin-marker-0');
    await expect(marker).toBeVisible();
    const actualX = Number.parseFloat((await marker.getAttribute('data-pin-x')) ?? 'NaN');
    const actualY = Number.parseFloat((await marker.getAttribute('data-pin-y')) ?? 'NaN');

    expect(Math.abs(actualX - expectedSpriteX)).toBeLessThanOrEqual(1);
    expect(Math.abs(actualY - expectedSpriteY)).toBeLessThanOrEqual(1);
    expect(pageErrors).toEqual([]);

    await context.close();
  });
});
