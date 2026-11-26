import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M32C: Vision-LLM Art Director QA Pass in Audit Matrix', () => {
  test('packs contact sheet, runs intercepted Gemini Vision QA, deep-links Fix in Micro-Editor, filters in Vault, and persists cached across reload', async ({
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

    // Configure Gemini BYOK provider in Provider Vault
    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('provider-vault-modal')).toBeVisible();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill('AIzaSyQAE2E999');
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Gemini Multimodal BYOK' }),
    ).toBeVisible();
    await page.getByTestId('close-vault-btn').click();

    // Create project and generate 3 sprite variants in Sprite Studio
    await page.getByTestId('new-project-name').fill('M32 Art Director Cast');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);

    await page.getByTestId('variant-count-select').selectOption('2');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(2);

    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('prompt-delta-input').fill('goblin scout');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(3);

    // Navigate to Audit Matrix
    await page.getByTestId('nav-audit-matrix').click();
    await expect(page.getByTestId('audit-matrix-view')).toBeVisible();
    await expect(page.getByTestId('art-director-qa-panel')).toBeVisible();

    // Wait for contact sheet canvas to finish packing & draw non-empty pixels
    const sheetCanvas = page.getByTestId('qa-contact-sheet-canvas');
    await expect(sheetCanvas).toBeVisible();
    await expect
      .poll(() =>
        sheetCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return 0;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          return data[3] ?? 0;
        }),
      )
      .toBeGreaterThan(0);

    // Select Gemini Flash provider & intercept Vision QA endpoint via page.route()
    const geminiOpt = await page
      .locator('[data-testid="qa-provider-select"] option')
      .evaluateAll((opts) => {
        const match = opts.find((o) => o.textContent?.includes('Gemini'));
        return match ? (match as HTMLOptionElement).value : '';
      });
    expect(geminiOpt).toBeTruthy();
    await page.getByTestId('qa-provider-select').selectOption(geminiOpt);
    await expect(page.getByTestId('qa-cost-badge')).toContainText('~$0.002');

    let geminiCalls = 0;
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      geminiCalls++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      overallScore: 84,
                      globalNotes: 'Cast silhouettes read well; cell 02 light side inverted.',
                      findings: [
                        {
                          indexLabel: '01',
                          severity: 'pass',
                          category: 'style-drift',
                          summary: 'Consistent palette and top-left rim highlight.',
                          suggestedFix: 'post-process',
                        },
                        {
                          indexLabel: '02',
                          severity: 'warn',
                          category: 'light-angle',
                          summary: 'Right-lit helm rim conflicts with Art Bible top-left light.',
                          suggestedFix: 'micro-editor',
                        },
                        {
                          indexLabel: '03',
                          severity: 'pass',
                          category: 'silhouette-readability',
                          summary: 'Clean 1x binary silhouette separation.',
                          suggestedFix: 'sandbox-1x',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    await page.getByTestId('qa-run-btn').click();
    await expect(page.getByTestId('qa-overall-score')).toHaveText('84/100');
    await expect(page.getByTestId('qa-finding-02')).toHaveAttribute('data-severity', 'warn');
    await expect(page.locator('[data-testid$="-visualQa"][data-severity="warn"]')).toHaveCount(1);
    await expect(page.locator('[data-testid$="-visualQa"][data-severity="pass"]')).toHaveCount(2);
    expect(geminiCalls).toBe(1);

    // Click deep-link "Fix in Micro-Editor" -> opens Screen 4A with M31 Pencil active on flagged sprite
    await page.getByTestId('qa-fix-btn-02').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('pixel-tool-pencil')).toHaveAttribute('aria-pressed', 'true');

    // Open M28 Vault -> Project Browser and filter by "Visual QA Warnings"
    await page.getByTestId('nav-asset-vault').click();
    await expect(page.getByTestId('vault-browser-view')).toBeVisible();
    await page.getByTestId('browser-filter-qa-warnings').click();
    await expect(page.locator('[data-testid^="browser-sprite-card-"]')).toHaveCount(1);
    await expect(page.locator('[data-testid^="browser-qa-badge-"]')).toHaveText('qa:warn');

    // Return to Audit Matrix and hard-reload -> cached report restores from IndexedDB with zero extra calls
    await page.getByTestId('nav-audit-matrix').click();
    await expect(page.getByTestId('audit-matrix-view')).toBeVisible();
    await page.reload();
    await expect(page.getByTestId('audit-matrix-view')).toBeVisible();
    await expect(page.getByTestId('qa-overall-score')).toHaveText('84/100');
    await expect(page.getByTestId('qa-cached-badge')).toBeVisible();
    await expect(page.locator('[data-testid$="-visualQa"][data-severity="warn"]')).toHaveCount(1);
    expect(geminiCalls).toBe(1);

    const orphanCount = await page.evaluate(async () => {
      const req = indexedDB.open('nibgrid-db');
      const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
        req.onsuccess = () => resolveDb(req.result);
        req.onerror = () => rejectDb(req.error);
      });
      const readAll = (store: string) =>
        new Promise<Array<Record<string, unknown>>>((resolveRows) => {
          const tx = db.transaction(store, 'readonly');
          const r = tx.objectStore(store).getAll();
          r.onsuccess = () => resolveRows((r.result as Array<Record<string, unknown>>) ?? []);
        });
      const [projects, nodes, audio, vault, blobs] = await Promise.all([
        readAll('projects'),
        readAll('spriteNodes'),
        readAll('audioAssets'),
        readAll('vaultItems'),
        readAll('blobs'),
      ]);
      db.close();
      const refs = new Set<string>();
      for (const p of projects) {
        const bible = p.artBible as { goldenReferenceBlobIds?: string[] } | undefined;
        for (const id of bible?.goldenReferenceBlobIds ?? []) refs.add(id);
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
        if (typeof v.previewBlobId === 'string') refs.add(v.previewBlobId);
        for (const id of (v.blobIds as string[] | undefined) ?? []) refs.add(id);
      }
      return blobs.filter((b) => !refs.has(String(b.id))).length;
    });
    expect(orphanCount).toBe(0);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
