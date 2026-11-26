import { resolve } from 'node:path';
import { unzipSync } from 'fflate';
import { expect, test } from '@playwright/test';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M31C: Screen 4A Surgical Pixel Micro-Editor & Region-Masked Inpainting', () => {
  test('draws with Pencil + Mirror-X, supports Cmd+Z/Shift+Z & editable shortcut isolation, runs intercepted Gemini Inpaint, and persists with zero orphan blobs', async ({
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

    // Add Gemini BYOK provider with dummy key for Region Inpaint test
    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('provider-vault-modal')).toBeVisible();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill('AIzaSyE2EINPAINT999');
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Gemini Multimodal BYOK' }),
    ).toBeVisible();
    await page.getByTestId('close-vault-btn').click();

    // Create project, generate 1 sprite, open Screen 4A Post-Process Inspector
    await page.getByTestId('new-project-name').fill('M31 Pixel Studio');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('pixel-editor-toolbar')).toBeVisible();
    await expect(page.getByTestId('processed-preview-canvas')).toHaveAttribute(
      'data-ready',
      'true',
    );

    // Select Art Bible gold swatch (#FFCD75) & activate Pencil (B) + Mirror-X (M)
    await page.getByTestId('pixel-swatch-4').click();
    await page.keyboard.press('b');
    await expect(page.getByTestId('pixel-tool-pencil')).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('m');
    await expect(page.getByTestId('pixel-mirror-x-btn')).toHaveAttribute('aria-pressed', 'true');

    const readCanvasPixel = async (tx: number, ty: number) =>
      page.getByTestId('processed-preview-canvas').evaluate(
        (el, coords) => {
          const canvas = el as HTMLCanvasElement;
          const ctx = canvas.getContext('2d');
          if (!ctx) return null;
          const d = ctx.getImageData(coords.x, coords.y, 1, 1).data;
          return {
            w: canvas.width,
            h: canvas.height,
            rgba: [d[0], d[1], d[2], d[3]],
          };
        },
        { x: tx, y: ty },
      );

    const dims = await readCanvasPixel(0, 0);
    expect(dims).not.toBeNull();
    const w = dims!.w;
    const h = dims!.h;
    const targetX = 10;
    const targetY = 10;
    const mirrorTargetX = w - 1 - targetX;

    const stageBox = await page.getByTestId('split-comparator').boundingBox();
    expect(stageBox).not.toBeNull();

    const clickTexel = async (tx: number, ty: number) => {
      const cx = stageBox!.x + ((tx + 0.5) / w) * stageBox!.width;
      const cy = stageBox!.y + ((ty + 0.5) / h) * stageBox!.height;
      await page.mouse.click(cx, cy);
    };

    const beforeCorner00 = await readCanvasPixel(0, 0);
    const beforeTarget10 = await readCanvasPixel(targetX, targetY);

    await clickTexel(targetX, targetY);
    await expect(page.getByTestId('postprocess-inspector')).toHaveAttribute(
      'data-pixel-edit-count',
      '1',
    );

    const afterStrokeTarget = await readCanvasPixel(targetX, targetY);
    const afterStrokeMirror = await readCanvasPixel(mirrorTargetX, targetY);
    // Swatch 4 (#FFCD75) = [255, 205, 117, 255]
    expect(afterStrokeTarget?.rgba).toEqual([255, 205, 117, 255]);
    expect(afterStrokeMirror?.rgba).toEqual([255, 205, 117, 255]);

    // Cmd+Z / Cmd+Shift+Z restores and re-applies exact pixels
    await page.keyboard.press('ControlOrMeta+z');
    await expect
      .poll(async () => (await readCanvasPixel(targetX, targetY))?.rgba)
      .toEqual(beforeTarget10!.rgba);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect
      .poll(async () => (await readCanvasPixel(targetX, targetY))?.rgba)
      .toEqual([255, 205, 117, 255]);

    // Switch to Inpaint Mask Brush (K) and paint center texels
    await page.keyboard.press('k');
    await expect(page.getByTestId('pixel-tool-mask-brush')).toHaveAttribute('aria-pressed', 'true');

    const centerX = Math.floor(w / 2);
    const centerY = Math.floor(h / 2);
    const maskStartX = stageBox!.x + ((centerX - 3 + 0.5) / w) * stageBox!.width;
    const maskEndX = stageBox!.x + ((centerX + 3 + 0.5) / w) * stageBox!.width;
    const maskY = stageBox!.y + ((centerY + 0.5) / h) * stageBox!.height;

    await page.mouse.move(maskStartX, maskY);
    await page.mouse.down();
    await page.mouse.move(maskEndX, maskY, { steps: 6 });
    await page.mouse.up();

    await expect(page.getByTestId('inpaint-action-bar')).toBeVisible();
    await expect(page.getByTestId('inpaint-mask-count')).not.toHaveText('0 px masked');

    // Typing 'b', 'e', 'm' into prompt input must NOT switch tool or toggle Mirror-X
    const promptInput = page.getByTestId('inpaint-prompt-input');
    await promptInput.fill('bem add glowing visor');
    await expect(page.getByTestId('pixel-tool-mask-brush')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('pixel-mirror-x-btn')).toHaveAttribute('aria-pressed', 'true');

    // Select Gemini BYOK provider & disable snap-to-palette so exact intercepted color #00FFCC renders
    const geminiOption = await page
      .locator('[data-testid="inpaint-provider-select"] option')
      .evaluateAll((opts) => {
        const found = opts.find((o) => o.textContent?.includes('Gemini'));
        return found ? (found as HTMLOptionElement).value : '';
      });
    expect(geminiOption).toBeTruthy();
    await page.getByTestId('inpaint-provider-select').selectOption(geminiOption);

    const snapToggle = page.getByTestId('inpaint-palette-snap');
    if (await snapToggle.isChecked()) {
      await snapToggle.uncheck();
    }

    // Intercept Gemini endpoint and return solid bright cyan (#00FFCC) image
    const cyanRgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      cyanRgba[i * 4] = 0;
      cyanRgba[i * 4 + 1] = 255;
      cyanRgba[i * 4 + 2] = 204;
      cyanRgba[i * 4 + 3] = 255;
    }
    const cyanBase64 = Buffer.from(encodeRgbaToPngBytes(cyanRgba, w, h)).toString('base64');

    let geminiRequests = 0;
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      geminiRequests++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: cyanBase64 } }],
              },
            },
          ],
        }),
      });
    });

    await page.getByTestId('inpaint-run-btn').click();
    await expect(page.getByTestId('inpaint-status')).toContainText('Inpainted');
    expect(geminiRequests).toBe(1);

    // Center masked texels updated to #00FFCC while unmasked corner + manual stroke remain untouched
    expect((await readCanvasPixel(centerX, centerY))?.rgba).toEqual([0, 255, 204, 255]);
    expect((await readCanvasPixel(targetX, targetY))?.rgba).toEqual([255, 205, 117, 255]);
    expect((await readCanvasPixel(0, 0))?.rgba).toEqual(beforeCorner00!.rgba);
    await expect(page.getByTestId('postprocess-inspector')).toHaveAttribute(
      'data-inpaint-count',
      '1',
    );

    // Check downloaded ZIP recipe contains M31 manualPixelEditCount & inpaintHistory
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('download-zip-btn').click();
    const dl = await dlPromise;
    const dlPath = await dl.path();
    const { readFile } = await import('node:fs/promises');
    const entries = unzipSync(new Uint8Array(await readFile(dlPath!)));
    const recipeKey = Object.keys(entries).find((k) => k.endsWith('.recipe.json'))!;
    const recipe = AssetRecipeSchema.parse(
      JSON.parse(new TextDecoder().decode(entries[recipeKey]!)),
    );
    expect(recipe.manualPixelEditCount).toBe(1);
    expect(recipe.inpaintHistory?.[0]?.prompt).toBe('bem add glowing visor');

    // Hard reload and confirm edited/inpainted pixels + metadata persist with zero orphan blobs
    await page.waitForTimeout(200);
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('processed-preview-canvas')).toHaveAttribute(
      'data-ready',
      'true',
    );
    await expect(page.getByTestId('postprocess-inspector')).toHaveAttribute(
      'data-inpaint-count',
      '1',
    );
    await expect
      .poll(async () => (await readCanvasPixel(centerX, centerY))?.rgba)
      .toEqual([0, 255, 204, 255]);
    expect((await readCanvasPixel(targetX, targetY))?.rgba).toEqual([255, 205, 117, 255]);

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

  test('maps pointer texel clicks accurately at devicePixelRatio: 2', async ({ browser }) => {
    const context = await browser.newContext({
      deviceScaleFactor: 2,
      viewport: { width: 1280, height: 800 },
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.getByTestId('new-project-name').fill('M31 HiDPI');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('processed-preview-canvas')).toHaveAttribute(
      'data-ready',
      'true',
    );

    await page.getByTestId('pixel-swatch-4').click();
    await page.getByTestId('pixel-tool-pencil').click();
    await page.getByTestId('pixel-mirror-x-btn').click();

    const size = await page.getByTestId('processed-preview-canvas').evaluate((el) => {
      const c = el as HTMLCanvasElement;
      return { width: c.width, height: c.height };
    });
    const box = await page.getByTestId('split-comparator').boundingBox();
    expect(box).not.toBeNull();

    const tx = 12;
    const ty = 14;
    await page.mouse.click(
      box!.x + ((tx + 0.5) / size.width) * box!.width,
      box!.y + ((ty + 0.5) / size.height) * box!.height,
    );

    const result = await page.getByTestId('processed-preview-canvas').evaluate(
      (el, c) => {
        const canvas = el as HTMLCanvasElement;
        const ctx = canvas.getContext('2d')!;
        const p1 = ctx.getImageData(c.tx, c.ty, 1, 1).data;
        const p2 = ctx.getImageData(canvas.width - 1 - c.tx, c.ty, 1, 1).data;
        return {
          p1: [p1[0], p1[1], p1[2], p1[3]],
          p2: [p2[0], p2[1], p2[2], p2[3]],
        };
      },
      { tx, ty },
    );

    expect(result.p1).toEqual([255, 205, 117, 255]);
    expect(result.p2).toEqual([255, 205, 117, 255]);
    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
    await context.close();
  });
});
