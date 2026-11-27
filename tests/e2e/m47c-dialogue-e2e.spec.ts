import { expect, test } from '@playwright/test';

test.describe('M47C: Branching Dialogue & Localization Studio, M24 Glyph Audit & Godot CSV Sync', () => {
  test('flags missing Polish glyphs, adds missing glyphs to M24 font, syncs strings.csv + dialogue_graph.json + DialogueRunner.gd via FSAA, and persists across reload', async ({
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
        name: prefix === '' ? 'my_godot_narrative' : prefix.split('/').pop()!,
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

    await page.getByTestId('new-project-name').fill('M47C Dialogue L10n');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('nav-dialogue-l10n').click();
    await expect(page.getByTestId('dialogue-l10n-panel')).toBeVisible();
    await expect(page.getByTestId('audit-glyph-status')).toContainText('All glyphs covered');

    // Add branching node with Polish diacritics ("Stój, wędrowcze!") -> surfaces M24 missing glyph warning
    await page.getByTestId('dialogue-new-node-id').fill('guard_warn');
    await page.getByTestId('dialogue-new-node-speaker').fill('gate_guard');
    await page.getByTestId('dialogue-new-node-text-key').fill('DLG_GUARD_WARN_01');
    await page.getByTestId('dialogue-new-node-en-text').fill('Halt, traveler!');
    await page.getByTestId('dialogue-new-node-pl-text').fill('Stój, wędrowcze!');
    await page.getByTestId('dialogue-new-node-de-text').fill('Halt, Reisender!');
    await page.getByTestId('dialogue-add-node-btn').click();

    await expect(page.getByTestId('dialogue-node-card-guard_warn')).toBeVisible();
    await expect(page.getByTestId('audit-glyph-status')).toContainText('Missing Glyph');
    await expect(page.getByTestId('audit-glyph-status')).toContainText('ó');
    await expect(page.getByTestId('audit-glyph-status')).toContainText('ę');
    expect(pageErrors).toEqual([]);

    // 1-click Add Missing Glyphs to M24 Font -> clears warning
    await page.getByTestId('audit-add-missing-glyphs-btn').click();
    await expect(page.getByTestId('audit-glyph-status')).toContainText('All glyphs covered');

    // Trigger M25 FSAA sync & verify strings.csv, dialogue_graph.json, DialogueRunner.gd
    await page.getByTestId('dialogue-sync-godot-btn').click();
    await expect(page.getByTestId('dialogue-status-notice')).toContainText(
      'Synced Dialogue & L10n',
    );

    const fsDump = await page.evaluate(
      () =>
        (window as unknown as Record<string, { files: Record<string, string> } | undefined>)
          .__nibgridMockFs,
    );
    expect(fsDump).toBeTruthy();
    expect(fsDump!.files['localization/strings.csv']).toContain('keys,en,pl,de');
    expect(fsDump!.files['localization/strings.csv']).toContain('DLG_GUARD_WARN_01');
    expect(fsDump!.files['localization/strings.csv']).toContain('Stój, wędrowcze!');
    expect(fsDump!.files['narrative/dialogue_graph.json']).toContain('"guard_warn"');
    expect(fsDump!.files['narrative/DialogueRunner.gd']).toContain('tr(String(node.get("text_key"');

    // Hard reload & assert persistence + 0 orphaned blobs
    await page.reload();
    await expect(page.getByTestId('dialogue-l10n-panel')).toBeVisible();
    await expect(page.getByTestId('dialogue-node-card-guard_warn')).toBeVisible();
    await expect(page.getByTestId('l10n-cell-DLG_GUARD_WARN_01-pl')).toHaveValue(
      'Stój, wędrowcze!',
    );
    await expect(page.getByTestId('audit-glyph-status')).toContainText('All glyphs covered');

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
