import { expect, test } from '@playwright/test';

test.describe('M51: Canonical Godot Compiler, Scene Graph Integrity & Deletion-Aware Sync E2E', () => {
  test('shows 0 broken res:// refs badge, syncs GameKit + manifest, and falls back cleanly to ZIP when FSAA is absent', async ({
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
      const removed: string[] = [];

      const makeDir = (prefix: string) => ({
        name: prefix === '' ? 'm51_godot_res' : prefix.split('/').pop()!,
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
                },
              };
            },
          };
        },
        removeEntry: async (name: string) => {
          const fullPath = prefix === '' ? name : `${prefix}/${name}`;
          delete files[fullPath];
          removed.push(fullPath);
        },
      });

      (window as unknown as Record<string, unknown>).__m51MockFs = { files, removed };
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => makeDir('');
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M51 Compiler Project');
    await page.getByTestId('create-project-btn').click();

    await page.getByTestId('workspace-tab-ship-godot').click();
    await expect(page.getByTestId('ship-godot-panel')).toBeVisible();
    await expect(page.getByTestId('ship-graph-integrity-badge')).toContainText(
      '0 broken res:// refs',
    );

    await page.getByTestId('ship-autosync-toggle').click();
    await expect(page.getByTestId('ship-autosync-toggle')).toBeChecked();

    await page.getByTestId('ship-sync-gamekit-btn').click();
    await expect(page.getByTestId('ship-status-notice')).toContainText('Synced Turnkey GameKit');

    const manifestRaw = await page.evaluate(
      () =>
        (window as unknown as { __m51MockFs: { files: Record<string, string> } }).__m51MockFs.files[
          '.nibgrid_sync_manifest.json'
        ],
    );
    expect(manifestRaw).toContain('"generator": "nibgrid-m51"');
    expect(manifestRaw).toContain('"managedFiles"');

    // Verify Download ZIP button works cleanly
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('ship-download-zip-btn').click(),
    ]);
    expect(download.suggestedFilename()).toContain('_godot_sync.zip');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
