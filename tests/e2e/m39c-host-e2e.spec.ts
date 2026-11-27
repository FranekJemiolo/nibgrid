import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

async function countIndexedDbOrphanBlobs(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolveCount, rejectCount) => {
        const req = indexedDB.open('nibgrid-db');
        req.onerror = () => rejectCount(new Error('Failed to open nibgrid-db'));
        req.onsuccess = () => {
          const db = req.result;
          const storeNames = Array.from(db.objectStoreNames);
          const needed = [
            'projects',
            'spriteNodes',
            'audioAssets',
            'blobs',
            'vaultItems',
            'agentCheckpoints',
          ].filter((s) => storeNames.includes(s));

          if (!needed.includes('blobs')) {
            db.close();
            resolveCount(0);
            return;
          }

          const tx = db.transaction(needed, 'readonly');
          const readAll = (name: string) =>
            new Promise<Record<string, unknown>[]>((res) => {
              if (!needed.includes(name)) return res([]);
              const r = tx.objectStore(name).getAll();
              r.onsuccess = () => res((r.result as Record<string, unknown>[]) ?? []);
              r.onerror = () => res([]);
            });

          Promise.all([
            readAll('projects'),
            readAll('spriteNodes'),
            readAll('audioAssets'),
            readAll('vaultItems'),
            readAll('agentCheckpoints'),
            readAll('blobs'),
          ]).then(([projects, nodes, audio, vault, checkpoints, blobs]) => {
            const refs = new Set<string>();
            for (const p of projects) {
              const artBible = p.artBible as { goldenReferenceBlobIds?: string[] } | undefined;
              for (const id of artBible?.goldenReferenceBlobIds ?? []) refs.add(id);
            }
            for (const n of nodes) {
              if (typeof n.imageBlobId === 'string') refs.add(n.imageBlobId);
              if (typeof n.maskBlobId === 'string') refs.add(n.maskBlobId);
              if (typeof n.processedBlobId === 'string') refs.add(n.processedBlobId);
            }
            for (const a of audio) {
              if (typeof a.wavBlobId === 'string') refs.add(a.wavBlobId);
            }
            for (const v of vault) {
              for (const id of (v.blobIds as string[] | undefined) ?? []) refs.add(id);
              if (typeof v.previewBlobId === 'string') refs.add(v.previewBlobId);
            }
            for (const c of checkpoints) {
              for (const id of (c.referencedBlobIds as string[] | undefined) ?? []) refs.add(id);
            }
            const orphans = blobs.filter((b) => typeof b.id === 'string' && !refs.has(b.id));
            db.close();
            resolveCount(orphans.length);
          });
        };
      }),
  );
}

test.describe('M39C: BrowserHostAdapter vs. VscodeHostAdapter RPC Bridge E2E', () => {
  test('BrowserHostAdapter loads Studio, persists generated project across reload, and leaves zero orphan blobs', async ({
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

    await page.getByTestId('new-project-name').fill('M39C Browser PWA');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('nav-models-btn').click();
    await expect(page.getByTestId('model-providers-panel')).toBeVisible();
    await page.getByTestId('route-select-planning-composer').selectOption('offline-mock');
    await page.getByTestId('close-models-btn').click();

    await page.reload();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('nav-models-btn').click();
    await expect(page.getByTestId('route-select-planning-composer')).toHaveValue('offline-mock');
    await page.getByTestId('close-models-btn').click();

    expect(await countIndexedDbOrphanBlobs(page)).toBe(0);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('VscodeHostAdapter over acquireVsCodeApi postMessage RPC bridge links Antigravity cleanly and persists state across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.addInitScript(() => {
      const keychain = new Map<string, string>();
      window.acquireVsCodeApi = () => ({
        postMessage: (raw: unknown) => {
          const msg = raw as { id?: string; method?: string; params?: Record<string, unknown> };
          if (!msg?.id || !msg.method) return;
          queueMicrotask(() => {
            if (msg.method === 'detectAntigravity' || msg.method === 'antigravity.detect') {
              window.postMessage(
                { id: msg.id, ok: true, result: { detected: true, configDir: '~/.gemini/config' } },
                '*',
              );
              return;
            }
            if (msg.method === 'linkAntigravityMcp' || msg.method === 'antigravity.linkMcp') {
              window.postMessage(
                {
                  id: msg.id,
                  ok: true,
                  result: {
                    ok: true,
                    configPath: '~/.gemini/config/mcp_config.json',
                    backupPath: '~/.gemini/config/mcp_config.json.bak.m39c',
                    message: 'Linked nibgrid via VS Code Webview Host RPC',
                  },
                },
                '*',
              );
              return;
            }
            if (msg.method === 'setSecret' || msg.method === 'secrets.set') {
              keychain.set(String(msg.params?.key ?? ''), String(msg.params?.value ?? ''));
              window.postMessage({ id: msg.id, ok: true, result: true }, '*');
              return;
            }
            if (msg.method === 'getSecret' || msg.method === 'secrets.get') {
              window.postMessage(
                {
                  id: msg.id,
                  ok: true,
                  result: keychain.get(String(msg.params?.key ?? '')) ?? null,
                },
                '*',
              );
              return;
            }
            window.postMessage({ id: msg.id, ok: true, result: true }, '*');
          });
        },
      });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('nav-models-btn').click();
    await expect(page.getByTestId('model-providers-panel')).toBeVisible();
    await page.getByTestId('route-select-vision-qa').selectOption('antigravity-acp');
    await page.getByTestId('ping-providers-btn').click();
    await expect(page.getByTestId('resolved-route-vision-qa')).toContainText(
      'Google Antigravity (ACP / MCP)',
    );

    await page.getByTestId('link-antigravity-btn').click();
    await expect(page.getByTestId('antigravity-link-status')).toContainText(
      'Linked nibgrid via VS Code Webview Host RPC',
    );
    await expect(page.getByTestId('antigravity-link-status')).toContainText('.bak.m39c');

    await page.reload();
    await page.getByTestId('nav-models-btn').click();
    await expect(page.getByTestId('route-select-vision-qa')).toHaveValue('antigravity-acp');

    expect(await countIndexedDbOrphanBlobs(page)).toBe(0);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
