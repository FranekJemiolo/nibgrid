import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M13 1x Game Scale Sandbox (Screen 4F)', () => {
  test('renders pure Canvas2D with zero WebGL2 allocations, dynamic biome contrast telemetry, 1x Value lens, keyboard shortcuts, and rAF stop on unmount', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.addInitScript(() => {
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      let webglAllocations = 0;
      const activeRafIds = new Set<number>();
      let rafCallbacksExecuted = 0;

      (window as unknown as { __M13_SANDBOX_AUDIT__: unknown }).__M13_SANDBOX_AUDIT__ = {
        getWebglCount: () => webglAllocations,
        getActiveRafCount: () => activeRafIds.size,
        getRafExecCount: () => rafCallbacksExecuted,
      };

      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        contextId: string,
        options?: unknown,
      ) {
        if (contextId === 'webgl2' || contextId === 'webgl') {
          webglAllocations += 1;
        }
        return origGetContext.call(
          this,
          contextId as '2d',
          options as CanvasRenderingContext2DSettings,
        );
      } as typeof origGetContext;

      const origRaf = window.requestAnimationFrame.bind(window);
      const origCancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        const id = origRaf((ts) => {
          activeRafIds.delete(id);
          rafCallbacksExecuted += 1;
          cb(ts);
        });
        activeRafIds.add(id);
        return id;
      };
      window.cancelAnimationFrame = (id: number) => {
        activeRafIds.delete(id);
        origCancel(id);
      };
    });

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M13 Sandbox Hero');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // Quick-launch Screen 4F directly from Screen 3's DAG "1x Preview" pill
    await expect(page.getByTestId('dag-quick-sandbox-btn')).toBeVisible();
    await page.getByTestId('dag-quick-sandbox-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('game-sandbox-panel')).toBeVisible();

    const canvas = page.getByTestId('sandbox-canvas');
    await expect(canvas).toBeVisible();

    // Assert zero WebGL / WebGL2 contexts created by Game Sandbox
    const webglCount = await page.evaluate(() =>
      (
        window as unknown as { __M13_SANDBOX_AUDIT__: { getWebglCount: () => number } }
      ).__M13_SANDBOX_AUDIT__.getWebglCount(),
    );
    expect(webglCount).toBe(0);

    // Read Contrast Telemetry on Dark Dungeon -> switch to Bright Snow -> ratio must change dynamically
    const dungeonRatioText = await page.getByTestId('sandbox-contrast-ratio').textContent();
    await page.getByTestId('sandbox-biome-bright-snow').click();
    await expect
      .poll(async () => page.getByTestId('sandbox-contrast-ratio').textContent())
      .not.toBe(dungeonRatioText);

    // Toggle 1x scale & Value Check lens -> check pixelated rendering, 320x180 size, and grayscale RGB equality
    await page.getByTestId('sandbox-scale-1').click();
    await page.getByTestId('sandbox-lens-value').click();
    await expect
      .poll(async () =>
        canvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const style = getComputedStyle(c);
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return { ok: false, rendering: style.imageRendering };
          const img = ctx.getImageData(0, 0, Math.min(64, c.width), Math.min(64, c.height)).data;
          let maxChromaDiff = 0;
          let nonEmpty = false;
          for (let i = 0; i < img.length; i += 4) {
            if ((img[i + 3] ?? 0) === 0) continue;
            nonEmpty = true;
            const r = img[i] ?? 0;
            const g = img[i + 1] ?? 0;
            const b = img[i + 2] ?? 0;
            maxChromaDiff = Math.max(
              maxChromaDiff,
              Math.abs(r - g),
              Math.abs(g - b),
              Math.abs(r - b),
            );
          }
          return {
            ok: c.width === 320 && c.height === 180 && nonEmpty && maxChromaDiff <= 2,
            rendering: style.imageRendering,
          };
        }),
      )
      .toEqual({ ok: true, rendering: 'pixelated' });

    // Switch back to Normal lens, then test F (Flip) and H (Hit-Flash) shortcuts
    await page.getByTestId('sandbox-lens-normal').click();
    await expect(canvas).toHaveAttribute('data-flipped', 'false');
    await page.keyboard.press('f');
    await expect(canvas).toHaveAttribute('data-flipped', 'true');

    await page.keyboard.press('h');
    await expect(canvas).toHaveAttribute('data-flash-active', 'true');

    // Wait briefly for 150ms hit-flash to settle cleanly before testing input isolation
    await expect(canvas).toHaveAttribute('data-flash-active', 'false');

    // Focus an <input> slider and press f / h -> must NOT toggle flip or trigger hit-flash
    const scrollSlider = page.getByTestId('sandbox-scroll-speed');
    await scrollSlider.focus();
    await page.keyboard.press('f');
    await page.keyboard.press('h');
    await expect(canvas).toHaveAttribute('data-flipped', 'true');
    await expect(canvas).toHaveAttribute('data-flash-active', 'false');

    // Verify M12 LUT live variant switching inside Game Sandbox
    await page.getByTestId('inspector-tab-palette-lut').click();
    await expect(page.getByTestId('palette-lut-workshop-panel')).toBeVisible();
    const over256 = await page
      .getByTestId('lut-over-256-banner')
      .isVisible()
      .catch(() => false);
    if (over256) {
      await page.getByTestId('lut-quantize-32-btn').click();
    }
    await page.getByTestId('lut-add-variant-btn').click();
    await page.getByTestId('lut-hue-shift').fill('120');

    await page.getByTestId('inspector-tab-sandbox').click();
    await expect(page.getByTestId('game-sandbox-panel')).toBeVisible();
    const lutSelect = page.getByTestId('sandbox-lut-variant-select');
    await expect(lutSelect.locator('option')).toHaveCount(2);
    const readCenterSample = () =>
      canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx) return 0;
        const img = ctx.getImageData(0, 0, c.width, c.height).data;
        let sum = 0;
        for (let i = 0; i < img.length; i += 4) {
          sum += (img[i] ?? 0) * 3 + (img[i + 1] ?? 0) * 5 + (img[i + 2] ?? 0) * 7;
        }
        return sum;
      });
    const baseSample = await readCenterSample();
    await lutSelect.selectOption('1');
    await expect.poll(readCenterSample).not.toBe(baseSample);

    // Switch away from Game Sandbox tab -> requestAnimationFrame loop must stop cleanly
    await page.getByTestId('inspector-tab-postprocess').click();
    await expect(page.getByTestId('game-sandbox-panel')).not.toBeVisible();

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __M13_SANDBOX_AUDIT__: { getActiveRafCount: () => number } }
          ).__M13_SANDBOX_AUDIT__.getActiveRafCount(),
        ),
      )
      .toBe(0);

    const execBeforeIdle = await page.evaluate(() =>
      (
        window as unknown as { __M13_SANDBOX_AUDIT__: { getRafExecCount: () => number } }
      ).__M13_SANDBOX_AUDIT__.getRafExecCount(),
    );
    await page.waitForTimeout(160);
    const execAfterIdle = await page.evaluate(() =>
      (
        window as unknown as { __M13_SANDBOX_AUDIT__: { getRafExecCount: () => number } }
      ).__M13_SANDBOX_AUDIT__.getRafExecCount(),
    );
    expect(execAfterIdle).toBe(execBeforeIdle);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
