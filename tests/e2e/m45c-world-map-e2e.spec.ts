import { expect, test } from '@playwright/test';

test.describe('M45C: Interactive World Map Graph, Softlock Auditor & Minimap Persistence', () => {
  test('connects 2 M35 rooms with red_key portal, catches & fixes softlock, bakes minimap, and persists cleanly on reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M45C World Realm');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('nav-world-map').click();
    await expect(page.getByTestId('world-map-panel')).toBeVisible();

    // Seed 2 M35 starter rooms directly from World Map
    await page.getByTestId('world-seed-empty-btn').click();
    await expect(page.locator('[data-testid^="world-room-node-"]')).toHaveCount(2);

    // Ensure Room A is Start and Room B is Goal, then link A -> B gated by red_key
    const roomFromSelect = page.getByTestId('world-edge-from-select');
    const roomToSelect = page.getByTestId('world-edge-to-select');
    const optionValues = await roomFromSelect
      .locator('option')
      .evaluateAll((opts) =>
        opts.map((o) => ({ value: (o as HTMLOptionElement).value, label: o.textContent ?? '' })),
      );
    expect(optionValues).toHaveLength(2);
    const roomAId = optionValues[0]!.value;
    const roomBId = optionValues[1]!.value;

    await page.getByTestId(`world-room-node-${roomAId}`).click();
    const startToggle = page.getByTestId('world-room-start-toggle');
    if (!(await startToggle.isChecked())) {
      await startToggle.click();
    }

    await page.getByTestId(`world-room-node-${roomBId}`).click();
    const goalToggle = page.getByTestId('world-room-goal-toggle');
    if (!(await goalToggle.isChecked())) {
      await goalToggle.click();
    }

    await roomFromSelect.selectOption(roomAId);
    await roomToSelect.selectOption(roomBId);
    await page.getByTestId('world-edge-flags-input').fill('red_key');
    await page.getByTestId('world-add-edge-btn').click();

    // Audit before granting red_key -> Room B unreachable
    await page.getByTestId('world-run-audit-btn').click();
    await expect(page.getByTestId('world-audit-status')).toHaveText('Issues Found');
    await expect(page.getByTestId('world-audit-unreachable')).toContainText('Room B');

    // Grant red_key on Room A -> re-audit -> OK with progression containing red_key
    await page.getByTestId(`world-room-node-${roomAId}`).click();
    await page.getByTestId('world-room-grants-input').fill('red_key');
    await page.getByTestId('world-room-grants-apply').click();
    await page.getByTestId('world-run-audit-btn').click();
    await expect(page.getByTestId('world-audit-status')).toHaveText('OK');
    await expect(page.getByTestId('world-audit-progression')).toContainText('red_key');

    // Bake pixel-art minimap & confirm non-empty pixel data
    await page.getByTestId('world-bake-minimap-btn').click();
    await expect(page.getByTestId('world-status-notice')).toContainText('Baked pixel-art minimap');

    const preReloadNonZero = await page.evaluate(() => {
      const canvas = document.querySelector(
        '[data-testid="world-minimap-canvas"]',
      ) as HTMLCanvasElement | null;
      if (!canvas || canvas.width === 0 || canvas.height === 0) return 0;
      const ctx = canvas.getContext('2d');
      if (!ctx) return 0;
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) {
        if (data[i]! > 0) count++;
      }
      return count;
    });
    expect(preReloadNonZero).toBeGreaterThan(100);

    // Hard reload & assert full persistence (world graph, green OK audit, baked minimap, 0 orphans)
    await page.reload();
    await expect(page.getByTestId('world-map-panel')).toBeVisible();
    await expect(page.getByTestId('world-audit-status')).toHaveText('OK');
    await expect(page.getByTestId('world-audit-progression')).toContainText('red_key');

    await expect
      .poll(async () => {
        return page.evaluate(() => {
          const canvas = document.querySelector(
            '[data-testid="world-minimap-canvas"]',
          ) as HTMLCanvasElement | null;
          if (!canvas || canvas.width === 0 || canvas.height === 0) return 0;
          const ctx = canvas.getContext('2d');
          if (!ctx) return 0;
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
          let count = 0;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i]! > 0) count++;
          }
          return count;
        });
      })
      .toBeGreaterThan(100);

    const orphanCount = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      const dbName = dbs[0]?.name || 'nibgrid-db';
      const req = indexedDB.open(dbName);
      const idb = await new Promise<IDBDatabase>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const readAll = (storeName: string) =>
        new Promise<Record<string, unknown>[]>((resolve, reject) => {
          const tx = idb.transaction(storeName, 'readonly');
          const r = tx.objectStore(storeName).getAll();
          r.onsuccess = () => resolve((r.result as Record<string, unknown>[]) ?? []);
          r.onerror = () => reject(r.error);
        });
      const [blobs, graphs, nodes] = await Promise.all([
        readAll('blobs'),
        readAll('worldGraphs'),
        readAll('spriteNodes'),
      ]);
      const referenced = new Set<string>();
      for (const wg of graphs) {
        if (typeof wg.minimapBlobId === 'string') referenced.add(wg.minimapBlobId);
      }
      for (const n of nodes) {
        if (typeof n.imageBlobId === 'string') referenced.add(n.imageBlobId);
        if (typeof n.processedBlobId === 'string') referenced.add(n.processedBlobId);
      }
      idb.close();
      return blobs.filter((b) => typeof b.id === 'string' && !referenced.has(b.id)).length;
    });
    expect(orphanCount).toBe(0);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
