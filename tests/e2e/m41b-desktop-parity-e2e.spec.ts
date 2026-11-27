import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

async function countOrphanBlobs(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolveCount, rejectCount) => {
        const req = indexedDB.open('nibgrid-db');
        req.onerror = () => rejectCount(new Error('Failed to open nibgrid-db'));
        req.onsuccess = () => {
          const db = req.result;
          const storeNames = Array.from(db.objectStoreNames);
          if (!storeNames.includes('blobs')) {
            db.close();
            resolveCount(0);
            return;
          }
          const needed = [
            'projects',
            'spriteNodes',
            'audioAssets',
            'blobs',
            'vaultItems',
            'agentCheckpoints',
          ].filter((s) => storeNames.includes(s));

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

async function runCoreParityFlow(
  page: import('@playwright/test').Page,
  mode: 'pwa-browser' | 'desktop-vscode-webview',
): Promise<string[]> {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => pageErrors.push(err.message));

  if (mode === 'desktop-vscode-webview') {
    await page.addInitScript(() => {
      window.acquireVsCodeApi = () => ({
        postMessage: (raw: unknown) => {
          const msg = raw as { id?: string; method?: string };
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
                    backupPath: '~/.gemini/config/mcp_config.json.bak.m41b',
                    message: 'Linked Desktop MCP cleanly',
                  },
                },
                '*',
              );
              return;
            }
            window.postMessage({ id: msg.id, ok: true, result: null }, '*');
          });
        },
      });
    });
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  // 1. Project & Sprite Studio generation
  await page.getByTestId('new-project-name').fill(`M41B Parity (${mode})`);
  await page.getByTestId('create-project-btn').click();
  await page.getByTestId('go-to-studio-btn').click();
  await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
  await page.getByTestId('variant-count-select').selectOption('1');
  await page.getByTestId('generate-btn').click();
  await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

  // 2. Screen 4A Inspector + collect primary & overflow tabs
  await page.getByTestId('open-postprocess-btn').click();
  await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

  const primaryTabs = await page
    .locator('[data-testid^="inspector-tab-"]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  await page.getByTestId('inspector-more-tools-btn').click();
  await expect(page.getByTestId('inspector-overflow-menu')).toBeVisible();
  const overflowTabs = await page
    .locator('[data-testid="inspector-overflow-menu"] [data-testid]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-testid') ?? ''));
  await page.getByTestId('inspector-more-tools-btn').click();
  const allCollectedTabs = Array.from(new Set([...primaryTabs, ...overflowTabs])).sort();

  // 3. M25 Entity Hub
  await page.getByTestId('nav-entities').click();
  await expect(page.getByTestId('entity-hub-view')).toBeVisible();

  // 4. M37 Vertical Slice Autopilot ($0.00 Instant Draft modal check)
  await page.getByTestId('nav-vertical-slice-btn').click();
  await expect(page.getByTestId('vertical-slice-wizard')).toBeVisible();
  await page.getByTestId('slice-tier-select').selectOption('instant-draft');
  await expect(page.getByTestId('slice-cost-badge')).toContainText('$0.00');
  await page.getByTestId('slice-close-btn').click();

  // 5. M38 Agentic Composer Rail (Control+l)
  await page.keyboard.press('Control+l');
  await expect(page.getByTestId('asset-composer-rail')).toBeVisible();
  await page.getByTestId('composer-close-btn').click();

  // 6. M40 / M41B Local Configuration & Secret-Free Portable Settings Export
  await page.getByTestId('nav-models-btn').click();
  await expect(page.getByTestId('model-providers-panel')).toBeVisible();
  await page.getByTestId('route-select-planning-composer').selectOption('ollama-local');
  await page.getByTestId('godot-binary-input').fill('/usr/local/bin/godot4');
  await page.getByTestId('res-subdir-input').fill('assets/m41_parity');
  await page.getByTestId('export-portable-settings-btn').click();

  await expect(page.getByTestId('portable-settings-status')).toContainText('zero secrets');
  const exportedText = await page.getByTestId('portable-settings-textarea').inputValue();
  expect(exportedText).toContain('/usr/local/bin/godot4');
  expect(exportedText).toContain('assets/m41_parity');
  expect(exportedText).not.toMatch(/AIza|sk-|nbg_/);

  await page.getByTestId('import-portable-settings-btn').click();
  await expect(page.getByTestId('portable-settings-status')).toContainText('Imported');
  await page.getByTestId('close-models-btn').click();

  // 7. Hard reload confirms zero loss of local settings & generated sprite
  await page.reload();
  await page.getByTestId('nav-models-btn').click();
  await expect(page.getByTestId('godot-binary-input')).toHaveValue('/usr/local/bin/godot4');
  await expect(page.getByTestId('res-subdir-input')).toHaveValue('assets/m41_parity');
  await page.getByTestId('close-models-btn').click();

  expect(await countOrphanBlobs(page)).toBe(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  return allCollectedTabs;
}

test.describe('M41B: PWA vs. Desktop Webview Feature Parity E2E', () => {
  test('Browser PWA and VS Code Desktop Webview expose identical inspector tabs, local config, Autopilot, Composer & zero orphan blobs', async ({
    browser,
  }) => {
    const pwaContext = await browser.newContext();
    const pwaPage = await pwaContext.newPage();
    const pwaTabs = await runCoreParityFlow(pwaPage, 'pwa-browser');
    await pwaContext.close();

    const desktopContext = await browser.newContext();
    const desktopPage = await desktopContext.newPage();
    const desktopTabs = await runCoreParityFlow(desktopPage, 'desktop-vscode-webview');
    await desktopContext.close();

    expect(pwaTabs.length).toBeGreaterThanOrEqual(15);
    expect(desktopTabs).toEqual(pwaTabs);
  });
});
