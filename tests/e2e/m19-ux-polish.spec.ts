import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

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

test.describe('M19: UX Polish, Studio Chrome, ScrubInput & Floating HUD', () => {
  test('M19A: neutral chrome responsiveness, 70%+ canvas viewport, floating HUD & ScrubInput interactions', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.getByTestId('new-project-name').fill('M19A Studio Knight');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('canvas-hud')).toBeVisible();

    // Check responsive zero overflow + 70%+ canvas well ratio on Screen 4A
    for (const vp of VIEWPORTS) {
      await page.setViewportSize(vp);
      await assertNoHorizontalOverflow(page);
      if (vp.width >= 1280) {
        const wellBox = await page.getByTestId('inspector-canvas-well').boundingBox();
        expect(wellBox).not.toBeNull();
        expect(wellBox!.width / vp.width).toBeGreaterThanOrEqual(0.7);
      }
    }

    await page.setViewportSize({ width: 1280, height: 720 });

    // ScrubInput drag (coarse), Shift+drag (0.1x precision), double-click Enter commit & Escape cancel
    const scrub = page.getByTestId('scrub-alpha-threshold');
    await expect(scrub).toHaveAttribute('data-value', '16');
    const box = await scrub.boundingBox();
    expect(box).not.toBeNull();

    const startX = box!.x + box!.width / 2;
    const startY = box!.y + Math.min(12, box!.height / 2);

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 6 });
    await page.mouse.up();
    await expect(scrub).toHaveAttribute('data-value', '36');

    await page.keyboard.down('Shift');
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.up('Shift');
    await expect(scrub).toHaveAttribute('data-value', '38');

    // Double-click inline edit + Enter commit
    await scrub.dblclick({ position: { x: box!.width / 2, y: 10 } });
    const inlineInput = page.getByTestId('scrub-alpha-threshold-input');
    await expect(inlineInput).toBeVisible();
    await inlineInput.fill('92');
    await inlineInput.press('Enter');
    await expect(inlineInput).toBeHidden();
    await expect(scrub).toHaveAttribute('data-value', '92');

    // Double-click inline edit + Escape cancel
    await scrub.dblclick({ position: { x: box!.width / 2, y: 10 } });
    await expect(inlineInput).toBeVisible();
    await inlineInput.fill('200');
    await inlineInput.press('Escape');
    await expect(inlineInput).toBeHidden();
    await expect(scrub).toHaveAttribute('data-value', '92');

    // Drawer collapse toggle gives 100% canvas width
    await page.getByTestId('inspector-drawer-toggle').click();
    await expect(page.getByTestId('inspector-drawer')).toBeHidden();
    const expandedWellBox = await page.getByTestId('inspector-canvas-well').boundingBox();
    expect(expandedWellBox!.width).toBeGreaterThanOrEqual(1260);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('M19B: asset-type workspace collapse, +Tools overflow, 1x PiP biome contrast & BeforeAfterWipe', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.addInitScript(() => {
      let webglCalls = 0;
      const origGetContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        contextId: string,
        options?: unknown,
      ): ReturnType<HTMLCanvasElement['getContext']> {
        if (contextId === 'webgl' || contextId === 'webgl2') {
          webglCalls += 1;
          (window as unknown as { __nibgridWebglCount?: number }).__nibgridWebglCount = webglCalls;
        }
        return origGetContext.call(
          this,
          contextId as '2d',
          options as CanvasRenderingContext2DSettings,
        );
      } as HTMLCanvasElement['getContext'];
    });

    await page.goto('/');
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByTestId('new-project-name').fill('M19B Panel Test');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Reclassify to ui-panel -> strictly 3 primary tabs visible, rest inside +Tools overflow
    await page.getByTestId('inspector-asset-class-select').selectOption('ui-panel');
    await expect(page.getByTestId('inspector-tab-postprocess')).toBeVisible();
    await expect(page.getByTestId('inspector-tab-tile-slice')).toBeVisible();
    await expect(page.getByTestId('inspector-tab-palette-lut')).toBeVisible();
    await expect(page.getByTestId('inspector-tab-collider')).toBeHidden();
    await expect(page.getByTestId('inspector-tab-sandbox')).toBeHidden();

    await page.getByTestId('inspector-more-tools-btn').click();
    await expect(page.getByTestId('inspector-overflow-menu')).toBeVisible();
    await expect(
      page.getByTestId('inspector-overflow-menu').getByTestId('inspector-tab-collider'),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('inspector-overflow-menu')).toBeHidden();

    // 1x PiP Biome Preview: visible, live contrast badge, cycles biome, toggles via 'P'
    const pip = page.getByTestId('pip-biome-preview');
    await expect(pip).toBeVisible();
    await expect(pip).toHaveAttribute('data-collapsed', 'false');
    await expect(page.getByTestId('pip-contrast-badge')).toContainText(':1');

    const beforeCycleLabel = await pip.innerText();
    await page.getByTestId('pip-biome-cycle-btn').click();
    const afterCycleLabel = await pip.innerText();
    expect(afterCycleLabel).not.toEqual(beforeCycleLabel);

    await page.keyboard.press('p');
    await expect(pip).toHaveAttribute('data-collapsed', 'true');
    await page.keyboard.press('p');
    await expect(pip).toHaveAttribute('data-collapsed', 'false');

    // BeforeAfterWipe: drag 50% -> ~25%, double-click handle resets to 50%, backslash toggles
    const comparator = page.getByTestId('split-comparator');
    const handle = page.getByTestId('split-handle');
    await expect(comparator).toHaveAttribute('data-wipe-percent', '50');
    const compBox = await comparator.boundingBox();
    expect(compBox).not.toBeNull();

    const dragStartX = compBox!.x + compBox!.width * 0.5;
    const dragY = compBox!.y + compBox!.height * 0.5;
    const dragEndX = compBox!.x + compBox!.width * 0.25;
    await page.mouse.move(dragStartX, dragY);
    await page.mouse.down();
    await page.mouse.move(dragEndX, dragY, { steps: 6 });
    await page.mouse.up();

    const pctAfterDrag = Number(await comparator.getAttribute('data-wipe-percent'));
    expect(pctAfterDrag).toBeGreaterThanOrEqual(15);
    expect(pctAfterDrag).toBeLessThanOrEqual(35);

    await handle.dblclick();
    await expect(comparator).toHaveAttribute('data-wipe-percent', '50');

    await page.keyboard.press('\\');
    await expect(comparator).toHaveAttribute('data-wipe-enabled', 'false');
    await expect(handle).toBeHidden();
    await page.keyboard.press('\\');
    await expect(comparator).toHaveAttribute('data-wipe-enabled', 'true');
    await expect(handle).toBeVisible();

    // Screen 4A must allocate zero WebGL/WebGL2 contexts
    const webglCount = await page.evaluate(
      () => (window as unknown as { __nibgridWebglCount?: number }).__nibgridWebglCount ?? 0,
    );
    expect(webglCount).toBe(0);

    // Asset class reload persistence
    await page.reload();
    await expect(page.getByTestId('inspector-asset-class-select')).toHaveValue('ui-panel');
    await expect(page.getByTestId('inspector-tab-sandbox')).toBeHidden();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('M19C: Cmd/Ctrl+K Command Palette navigation, Escape restore, and input-focus shortcut isolation', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.setViewportSize({ width: 1280, height: 720 });

    await page.getByTestId('new-project-name').fill('M19C Palette Knight');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // Input-focus isolation in Studio prompt textarea ('p' and '\' must stay literal text)
    const promptInput = page.getByTestId('prompt-delta-input');
    await promptInput.click();
    await promptInput.pressSequentially('p\\');
    await expect(promptInput).toHaveValue('p\\');

    // Open Screen 4A Inspector and test Command Palette isolation from PiP ('P') and Wipe ('\')
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    const pip = page.getByTestId('pip-biome-preview');
    const comparator = page.getByTestId('split-comparator');
    await expect(pip).toHaveAttribute('data-collapsed', 'false');
    await expect(comparator).toHaveAttribute('data-wipe-enabled', 'true');

    // Open Command Palette via Control+k, type 'p\' inside search input -> global P / \ shortcuts must NOT fire
    await page.keyboard.press('Control+k');
    const palette = page.getByTestId('command-palette');
    await expect(palette).toBeVisible();
    const paletteInput = page.getByTestId('command-palette-input');
    await paletteInput.pressSequentially('p\\');
    await expect(paletteInput).toHaveValue('p\\');
    await expect(pip).toHaveAttribute('data-collapsed', 'false');
    await expect(comparator).toHaveAttribute('data-wipe-enabled', 'true');

    // Press Escape to close cleanly
    await page.keyboard.press('Escape');
    await expect(palette).toBeHidden();

    // Re-open via header button, filter 'Audit', press Enter -> navigates to Screen 7 Audit Matrix
    await page.getByTestId('nav-command-palette-btn').click();
    await expect(palette).toBeVisible();
    await paletteInput.fill('Audit');
    await expect(page.getByTestId('command-item-nav-audit')).toBeVisible();
    await paletteInput.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page.getByTestId('audit-matrix-view')).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
