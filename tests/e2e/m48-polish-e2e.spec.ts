import { expect, test } from '@playwright/test';

test.describe('M48: Auto-Polish Pixel Cleanup & Palette Lock E2E', () => {
  test('generates a mock sprite, applies Auto-Polish to lock palette, and leaves zero orphan blobs', async ({
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

    await page.getByTestId('new-project-name').fill('M48 Polish Hero');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();

    await expect(page.getByTestId('sprite-studio')).toBeVisible();
    await page.getByTestId('prompt-delta-input').fill('cat knight sword');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]').first()).toBeVisible({
      timeout: 15000,
    });

    await page.getByTestId('studio-auto-polish-toggle').check();
    await expect(page.getByTestId('studio-polish-badge')).toContainText('Palette-Locked');

    // Verify all blobs in IndexedDB are referenced (0 orphans)
    const orphanCount = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      const dbName = dbs[0]?.name || 'nibgrid-db';
      const req = indexedDB.open(dbName);
      const idb = await new Promise<IDBDatabase>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const [nodes, blobs] = await Promise.all([
        new Promise<Array<{ imageBlobId: string; processedBlobId?: string }>>((resolve, reject) => {
          const r = idb.transaction('spriteNodes', 'readonly').objectStore('spriteNodes').getAll();
          r.onsuccess = () =>
            resolve((r.result as Array<{ imageBlobId: string; processedBlobId?: string }>) ?? []);
          r.onerror = () => reject(r.error);
        }),
        new Promise<Array<{ id: string }>>((resolve, reject) => {
          const r = idb.transaction('blobs', 'readonly').objectStore('blobs').getAll();
          r.onsuccess = () => resolve((r.result as Array<{ id: string }>) ?? []);
          r.onerror = () => reject(r.error);
        }),
      ]);
      idb.close();
      const referenced = new Set<string>();
      for (const n of nodes) {
        referenced.add(n.imageBlobId);
        if (n.processedBlobId) referenced.add(n.processedBlobId);
      }
      return blobs.filter((b) => !referenced.has(b.id)).length;
    });
    expect(orphanCount).toBe(0);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
