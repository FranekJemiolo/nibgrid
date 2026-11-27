import { expect, test } from '@playwright/test';

test.describe('M46C: Schema-Driven Game Data Foundry, Balance Simulator & Godot Resource Sync', () => {
  test('adds flame_blade, runs seeded Monte Carlo TTK simulation, syncs .gd/.tres via FSAA, and persists cleanly on reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.addInitScript(() => {
      const files: Record<string, string> = {};
      const writes: string[] = [];

      const makeDir = (prefix: string) => ({
        name: prefix === '' ? 'my_godot_data' : prefix.split('/').pop()!,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getDirectoryHandle: async (segment: string) =>
          makeDir(prefix === '' ? segment : `${prefix}/${segment}`),
        getFileHandle: async (filename: string) => {
          const fullPath = prefix === '' ? filename : `${prefix}/${filename}`;
          let chunks: Uint8Array[] = [];
          return {
            name: filename,
            createWritable: async () => {
              chunks = [];
              return {
                write: async (data: BufferSource | Blob | string) => {
                  if (typeof data === 'string') {
                    chunks.push(new TextEncoder().encode(data));
                  } else if (data instanceof Blob) {
                    chunks.push(new Uint8Array(await data.arrayBuffer()));
                  } else if (ArrayBuffer.isView(data)) {
                    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                  } else {
                    chunks.push(new Uint8Array(data));
                  }
                },
                close: async () => {
                  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
                  const combined = new Uint8Array(total);
                  let off = 0;
                  for (const c of chunks) {
                    combined.set(c, off);
                    off += c.byteLength;
                  }
                  files[fullPath] = new TextDecoder().decode(combined);
                  writes.push(fullPath);
                },
              };
            },
          };
        },
      });

      const rootHandle = makeDir('');
      (window as unknown as Record<string, unknown>).__nibgridMockFs = {
        writes,
        files,
      };
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => rootHandle;
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M46C RPG Data');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('nav-data-foundry').click();
    await expect(page.getByTestId('data-foundry-panel')).toBeVisible();
    await expect(page.getByTestId('data-validation-status')).toContainText('Valid Registry');

    // Add flame_blade (22 dmg @ 1.5 aps)
    await page.getByTestId('data-new-weapon-id').fill('flame_blade');
    await page.getByTestId('data-new-weapon-name').fill('Flame Blade');
    await page.getByTestId('data-new-weapon-damage').fill('22');
    await page.getByTestId('data-new-weapon-aps').fill('1.5');
    await page.getByTestId('data-add-weapon-btn').click();
    await expect(page.getByTestId('data-item-row-flame_blade')).toBeVisible();

    // Select flame_blade vs goblin_scout in Balance Lab & run Monte Carlo TTK sim
    await page.getByTestId('balance-weapon-select').selectOption('flame_blade');
    await page.getByTestId('balance-enemy-select').selectOption('goblin_scout');
    await page.getByTestId('balance-seed-input').fill('42');
    await page.getByTestId('balance-run-sim-btn').click();

    await expect(page.getByTestId('balance-p50-ttk')).toHaveText(/\d+\.\d+s/);
    await expect(page.getByTestId('balance-win-rate')).toHaveText(/\d+\.\d+%/);

    // Trigger M25 FSAA sync & verify WeaponItemData.gd + flame_blade.tres
    await page.getByTestId('data-sync-godot-btn').click();
    await expect(page.getByTestId('data-status-notice')).toContainText('Synced Game Data');

    const fsDump = await page.evaluate(
      () =>
        (window as unknown as Record<string, { files: Record<string, string> } | undefined>)
          .__nibgridMockFs,
    );
    expect(fsDump).toBeTruthy();
    expect(fsDump!.files['data/schemas/WeaponItemData.gd']).toContain('class_name WeaponItemData');
    expect(fsDump!.files['data/items/flame_blade.tres']).toContain('base_damage = 22.0');
    expect(fsDump!.files['data/enemies/goblin_scout.tres']).toContain('max_hp = 65.0');

    // Hard reload & assert persistence + 0 orphaned blobs
    await page.reload();
    await expect(page.getByTestId('data-foundry-panel')).toBeVisible();
    await expect(page.getByTestId('data-item-row-flame_blade')).toBeVisible();

    const orphanCount = await page.evaluate(async () => {
      const dbs = await indexedDB.databases();
      const dbName = dbs[0]?.name || 'nibgrid-db';
      const req = indexedDB.open(dbName);
      const idb = await new Promise<IDBDatabase>((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      const blobs = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
        const r = idb.transaction('blobs', 'readonly').objectStore('blobs').getAll();
        r.onsuccess = () => resolve((r.result as Record<string, unknown>[]) ?? []);
        r.onerror = () => reject(r.error);
      });
      idb.close();
      return blobs.length;
    });
    expect(orphanCount).toBe(0);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
