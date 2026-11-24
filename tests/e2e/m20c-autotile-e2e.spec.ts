import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M20C: Interactive Auto-Tile Terrain Generator & Paint-Test Sandbox (Screen 4I)', () => {
  test('reclassifies to tile, paints 12x8 Blob-47 & Wang-16 terrain, exports ZIP bundle, and persists on reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.setViewportSize({ width: 1280, height: 800 });

    await page.getByTestId('new-project-name').fill('M20C Terrain World');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Reclassify to Tile -> opens Auto-Tile primary tab cleanly
    await page.getByTestId('inspector-asset-class-select').selectOption('tile');
    await page.getByTestId('inspector-tab-autotile').click();
    await expect(page.getByTestId('autotile-workshop-panel')).toBeVisible();
    await expect(page.getByTestId('autotile-meta-badge')).toContainText('Blob-47 · 8×6');

    const readCanvasHash = () =>
      page.getByTestId('autotile-paint-canvas').evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx || c.width === 0) return '';
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let acc = 0;
        let nonZero = 0;
        for (let i = 0; i < d.length; i += 16) {
          const v = d[i + 3] ?? 0;
          if (v > 0) nonZero += 1;
          acc = (acc * 31 + (d[i] ?? 0) + (d[i + 1] ?? 0) + v) >>> 0;
        }
        return `${c.width}x${c.height}:${nonZero}:${acc}`;
      });

    // Clear map first, then Load Sample Map & drag-paint additional cells
    await page.getByTestId('autotile-clear-map-btn').click();
    await expect.poll(readCanvasHash).toMatch(/^576x384:0:/);

    await page.getByTestId('autotile-load-sample-btn').click();
    const afterSampleHash = await readCanvasHash();
    expect(afterSampleHash).not.toMatch(/^576x384:0:/);

    // Drag-paint across top-left empty cells (0,0 -> 3,0) and confirm canvas updates
    const paintCanvas = page.getByTestId('autotile-paint-canvas');
    const paintBox = await paintCanvas.boundingBox();
    expect(paintBox).not.toBeNull();
    const startX = paintBox!.x + paintBox!.width * 0.04;
    const startY = paintBox!.y + paintBox!.height * 0.06;
    const endX = paintBox!.x + paintBox!.width * 0.28;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(endX, startY, { steps: 6 });
    await page.mouse.up();
    const afterDragHash = await readCanvasHash();
    expect(afterDragHash).not.toEqual(afterSampleHash);

    // Toggle Wang-16 mode and inspect Full Packed Sheet (4x4 aspect ratio)
    await page.getByTestId('autotile-mode-wang-16').click();
    await expect(page.getByTestId('autotile-meta-badge')).toContainText('Wang-16 · 4×4');

    await page.getByTestId('autotile-view-sheet').click();
    const sheetCanvas = page.getByTestId('autotile-sheet-canvas');
    await expect(sheetCanvas).toBeVisible();
    await expect
      .poll(() =>
        sheetCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          return { width: c.width, height: c.height };
        }),
      )
      .toEqual({ width: 512, height: 512 });

    // Switch back to Blob-47 (8x6 -> 1024x768)
    await page.getByTestId('autotile-mode-blob-47').click();
    await expect(page.getByTestId('autotile-meta-badge')).toContainText('Blob-47 · 8×6 · 1024×768');
    await expect
      .poll(() =>
        sheetCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          return { width: c.width, height: c.height };
        }),
      )
      .toEqual({ width: 1024, height: 768 });

    // Save to Project & Download Terrain Bundle ZIP
    await page.getByTestId('autotile-save-btn').click();
    await expect(page.getByTestId('autotile-save-notice')).toContainText('Saved BLOB-47');

    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('autotile-download-zip-btn').click();
    const download = await dlPromise;
    const zipEntries = unzipSync(new Uint8Array(await readFile((await download.path())!)));

    const pngKey = Object.keys(zipEntries).find((k) => k.endsWith('_autotile_blob-47.png'));
    const tresKey = Object.keys(zipEntries).find((k) => k.endsWith('_tileset.tres'));
    const tsxKey = Object.keys(zipEntries).find((k) => k.endsWith('.tsx'));
    const recipeKey = Object.keys(zipEntries).find((k) => k.endsWith('.recipe.json'));

    expect(pngKey).toBeTruthy();
    expect(tresKey).toBeTruthy();
    expect(tsxKey).toBeTruthy();
    expect(recipeKey).toBeTruthy();

    expect(Array.from(zipEntries[pngKey!]!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(strFromU8(zipEntries[tresKey!]!)).toContain('terrain_set_0/mode = 0');
    const tsxText = strFromU8(zipEntries[tsxKey!]!);
    expect(tsxText).toContain('tilecount="47"');
    expect(tsxText).toContain('<wangtile');

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(zipEntries[recipeKey!]!)));
    expect(parsedRecipe.autoTile?.mode).toBe('blob-47');
    expect(parsedRecipe.assetClass).toBe('tile');

    // Hard reload and confirm Auto-Tile settings & painted map survive cleanly
    await page.getByTestId('autotile-view-paint').click();
    await page.waitForTimeout(200);
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('inspector-asset-class-select')).toHaveValue('tile');
    await page.getByTestId('inspector-tab-autotile').click();
    await expect(page.getByTestId('autotile-workshop-panel')).toBeVisible();
    await expect.poll(readCanvasHash).toEqual(afterDragHash);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
