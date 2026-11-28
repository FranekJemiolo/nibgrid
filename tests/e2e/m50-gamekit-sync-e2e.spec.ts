import { expect, test } from '@playwright/test';

test.describe('M50: Turnkey Godot 4 GameKit Exporter & addons/nibgrid_sync Plugin E2E', () => {
  test('selects Side-Platformer GameKit in Ship to Godot, syncs project.godot, main.tscn, addons/nibgrid_sync, and composable prefabs via FSAA', async ({
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
        name: prefix === '' ? 'my_godot_gamekit' : prefix.split('/').pop()!,
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

    await page.getByTestId('new-project-name').fill('M50 GameKit Adventure');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('workspace-tab-ship-godot').click();
    await expect(page.getByTestId('ship-godot-panel')).toBeVisible();

    await page.getByTestId('gamekit-template-side-platformer').click();
    await page.getByTestId('ship-sync-gamekit-btn').click();
    await expect(page.getByTestId('ship-status-notice')).toContainText('Synced Turnkey GameKit');

    const fsDump = await page.evaluate(
      () =>
        (window as unknown as Record<string, { files: Record<string, string> } | undefined>)
          .__nibgridMockFs,
    );
    expect(fsDump).toBeTruthy();
    expect(fsDump!.files['project.godot']).toContain('run/main_scene="res://main.tscn"');
    expect(fsDump!.files['project.godot']).toContain('[input]');
    expect(fsDump!.files['main.tscn']).toContain('[node name="TitleScreen"');
    expect(fsDump!.files['default_bus_layout.tres']).toContain('AudioBusLayout');
    expect(fsDump!.files['addons/nibgrid_sync/plugin.cfg']).toContain('Nibgrid Live Sync');
    expect(fsDump!.files['addons/nibgrid_sync/nibgrid_sync.gd']).toContain('extends EditorPlugin');
    expect(fsDump!.files['entities/hero/hero_prefab.tscn']).toContain('HealthComponent');

    // Assert zero orphaned blobs
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
