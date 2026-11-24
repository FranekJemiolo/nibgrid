import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M18C Orthographic Turnaround Sheet & Connected-Component Auto-Slicer (Screen 4H)', () => {
  test('generates 2x2 sheet, previews Onion-Skin & Mirror East->West, stops Turntable rAF cleanly, commits 4 linked nodes, groups in Atlas, and persists on reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.addInitScript(() => {
      const activeRafIds = new Set<number>();
      let rafExecCount = 0;
      (window as unknown as { __M18C_RAF_AUDIT__: unknown }).__M18C_RAF_AUDIT__ = {
        getActiveRafCount: () => activeRafIds.size,
        getRafExecCount: () => rafExecCount,
      };

      const origRaf = window.requestAnimationFrame.bind(window);
      const origCancel = window.cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = (cb: FrameRequestCallback) => {
        const id = origRaf((ts) => {
          activeRafIds.delete(id);
          rafExecCount += 1;
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

    // 1. Create project -> Screen 3 -> select Turnaround (2x2) -> generate via Mock Provider
    await page.getByTestId('new-project-name').fill('M18C Turnaround Knight');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');

    await page.getByTestId('sheet-mode-2x2').click();
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();

    await expect(page.locator('[data-testid^="dag-turnaround-badge-"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="dag-turnaround-badge-"]').first()).toContainText(
      'Sheet 2x2',
    );

    // 2. Open Screen 4 -> Turnaround Slicer tab auto-selects & displays 4 color-coded slots + Onion-Skin preview
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('turnaround-slicer-panel')).toBeVisible();
    await expect(page.getByTestId('turnaround-slot-box-0')).toBeVisible();
    await expect(page.getByTestId('turnaround-slot-box-3')).toBeVisible();
    await expect(page.getByTestId('turnaround-metrics-badge')).toContainText('4/4 views');

    await expect
      .poll(async () =>
        page.getByTestId('turnaround-preview-canvas').evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0 || c.height === 0) return false;
          const img = ctx.getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          for (let i = 3; i < img.length; i += 4) {
            if ((img[i] ?? 0) > 0) opaque++;
          }
          return opaque > 40;
        }),
      )
      .toBe(true);

    // 3. Toggle Mirror East -> West, start Turntable playback, then switch tabs to verify clean rAF stop
    await page.getByTestId('turnaround-mirror-ew').check();
    await page.getByTestId('turnaround-mode-turntable').click();
    await page.getByTestId('turnaround-turntable-play').click();

    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __M18C_RAF_AUDIT__: { getRafExecCount: () => number } }
          ).__M18C_RAF_AUDIT__.getRafExecCount(),
        ),
      )
      .toBeGreaterThan(2);

    await page.getByTestId('inspector-tab-postprocess').click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          (
            window as unknown as { __M18C_RAF_AUDIT__: { getActiveRafCount: () => number } }
          ).__M18C_RAF_AUDIT__.getActiveRafCount(),
        ),
      )
      .toBe(0);

    // Switch back to Turnaround Slicer, re-enable Mirror East -> West, and commit 4 linked views
    await page.getByTestId('inspector-tab-turnaround').click();
    await expect(page.getByTestId('turnaround-slicer-panel')).toBeVisible();
    await page.getByTestId('turnaround-mirror-ew').check();
    await expect(page.getByTestId('turnaround-commit-btn')).toBeEnabled();

    const expectedMetricsText = await page.getByTestId('turnaround-metrics-badge').textContent();
    await page.getByTestId('turnaround-commit-btn').click();
    await expect(page.getByTestId('turnaround-commit-banner')).toBeVisible();

    // 4. Jump to Studio DAG -> verify 4 linked child nodes share directionGroupId and pivotPx
    await page.getByTestId('turnaround-open-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    for (const dir of ['south', 'east', 'north', 'west'] as const) {
      await expect(page.locator(`[data-direction="${dir}"]`)).toHaveCount(1);
    }

    const groupIds = await page
      .locator('[data-direction-group]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-direction-group')));
    expect(groupIds).toHaveLength(4);
    expect(new Set(groupIds).size).toBe(1);

    const indexedDbCheck = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      const target = dbs.find((d) => d.name && d.name.toLowerCase().includes('nibgrid'));
      if (!target?.name) return { count: 0, pivots: [] as Array<{ x: number; y: number } | null> };
      const req = indexedDB.open(target.name);
      const idb = await new Promise<IDBDatabase>((resolveOpen, rejectOpen) => {
        req.onsuccess = () => resolveOpen(req.result);
        req.onerror = () => rejectOpen(req.error);
      });
      const tx = idb.transaction('spriteNodes', 'readonly');
      const all = await new Promise<
        Array<{
          turnaroundMeta?: { directionGroupId?: string; sharedPivotPx?: { x: number; y: number } };
        }>
      >((resolveAll, rejectAll) => {
        const getReq = tx.objectStore('spriteNodes').getAll();
        getReq.onsuccess = () => resolveAll(getReq.result as []);
        getReq.onerror = () => rejectAll(getReq.error);
      });
      idb.close();
      const linked = all.filter((n) => Boolean(n.turnaroundMeta?.directionGroupId));
      return {
        count: linked.length,
        pivots: linked.map((n) => n.turnaroundMeta?.sharedPivotPx ?? null),
      };
    });
    expect(indexedDbCheck.count).toBe(4);
    expect(new Set(indexedDbCheck.pivots.map((p) => JSON.stringify(p))).size).toBe(1);
    expect(expectedMetricsText).toContain(
      `${indexedDbCheck.pivots[0]!.x}, ${indexedDbCheck.pivots[0]!.y}`,
    );

    // 5. Open Atlas Packer Screen 5 -> verify directional group + 1-click toggle
    await page.getByTestId('nav-atlas-workshop').click();
    await expect(page.getByTestId('atlas-workshop')).toBeVisible();
    const dirGroup = page.locator('[data-testid^="atlas-direction-group-"]').first();
    await expect(dirGroup).toBeVisible();
    const groupToggle = page.locator('[data-testid^="atlas-group-toggle-"]').first();
    await expect(groupToggle).toBeChecked();
    await groupToggle.uncheck();
    await expect(dirGroup.locator('input[data-testid^="atlas-item-"]')).toHaveCount(4);
    for (let i = 0; i < 4; i++) {
      await expect(dirGroup.locator('input[data-testid^="atlas-item-"]').nth(i)).not.toBeChecked();
    }
    await groupToggle.check();
    for (let i = 0; i < 4; i++) {
      await expect(dirGroup.locator('input[data-testid^="atlas-item-"]').nth(i)).toBeChecked();
    }

    // 6. Hard reload -> verify sheet + 4 linked directional nodes persist from IndexedDB
    await page.reload();
    await page.getByTestId('nav-sprite-studio').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();
    await expect(page.locator('[data-testid^="dag-turnaround-badge-"]')).toHaveCount(1);
    for (const dir of ['south', 'east', 'north', 'west'] as const) {
      await expect(page.locator(`[data-direction="${dir}"]`)).toHaveCount(1);
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
