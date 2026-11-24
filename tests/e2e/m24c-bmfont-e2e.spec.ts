import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

test.describe('M24C: Bitmap Font & Damage Numeral Exporter (Screen 4M)', () => {
  test('styles damage numerals with ScrubInput, spawns Crit Pop, previews PoT atlas, exports ZIP & persists across reload', async ({
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

    await page.getByTestId('new-project-name').fill('M24C Combat Font');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    await page.getByTestId('inspector-asset-class-select').selectOption('ui-panel');
    await page.getByTestId('inspector-tab-bmfont').click();
    await expect(page.getByTestId('bmfont-workshop-panel')).toBeVisible();

    await page.getByTestId('bmfont-charset-damage-numerals').click();
    await expect(page.getByTestId('bmfont-meta-badge')).toContainText('23 glyphs');

    // Scrub Integer Scale (2 -> 3 or 4)
    const scaleScrub = page.getByTestId('bmfont-scale-scrub');
    await scaleScrub.scrollIntoViewIfNeeded();
    const scaleBefore = Number(await scaleScrub.getAttribute('data-value'));
    const scaleBox = await scaleScrub.boundingBox();
    expect(scaleBox).not.toBeNull();
    await page.mouse.move(
      scaleBox!.x + scaleBox!.width / 2,
      scaleBox!.y + Math.min(12, scaleBox!.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      scaleBox!.x + scaleBox!.width / 2 + 20,
      scaleBox!.y + Math.min(12, scaleBox!.height / 2),
      { steps: 5 },
    );
    await page.mouse.up();
    const scaleAfter = Number(await scaleScrub.getAttribute('data-value'));
    expect(scaleAfter).not.toBe(scaleBefore);

    // Scrub Sel-Out Darken via pointer drag
    const selOutScrub = page.getByTestId('bmfont-selout-scrub');
    await selOutScrub.scrollIntoViewIfNeeded();
    const selOutBefore = Number(await selOutScrub.getAttribute('data-value'));
    const selOutBox = await selOutScrub.boundingBox();
    expect(selOutBox).not.toBeNull();
    await page.mouse.move(
      selOutBox!.x + selOutBox!.width / 2,
      selOutBox!.y + Math.min(12, selOutBox!.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      selOutBox!.x + selOutBox!.width / 2 + 24,
      selOutBox!.y + Math.min(12, selOutBox!.height / 2),
      { steps: 6 },
    );
    await page.mouse.up();
    const selOutAfter = Number(await selOutScrub.getAttribute('data-value'));
    expect(selOutAfter).not.toBe(selOutBefore);

    // Trigger floating Crit Pop & assert live preview canvas draws crisp pixels
    await page.getByTestId('bmfont-spawn-crit-btn').click();
    const liveCanvas = page.getByTestId('bmfont-preview-canvas');
    await expect(liveCanvas).toBeVisible();
    await expect
      .poll(() =>
        liveCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return 0;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let count = 0;
          for (let i = 3; i < d.length; i += 16) {
            if ((d[i] ?? 0) > 0) count++;
          }
          return count;
        }),
      )
      .toBeGreaterThan(0);

    // Switch to Packed Atlas view & assert Power-of-Two dimensions + non-empty glyphs
    await page.getByTestId('bmfont-view-atlas').click();
    const atlasCanvas = page.getByTestId('bmfont-atlas-canvas');
    await expect(atlasCanvas).toBeVisible();
    const atlasDims = await expect
      .poll(() =>
        atlasCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return { width: 0, height: 0, nonEmpty: 0 };
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let nonEmpty = 0;
          for (let i = 3; i < d.length; i += 16) {
            if ((d[i] ?? 0) > 0) nonEmpty++;
          }
          return { width: c.width, height: c.height, nonEmpty };
        }),
      )
      .toEqual(expect.objectContaining({ width: expect.any(Number), height: expect.any(Number) }));
    void atlasDims;
    const rawAtlasStats = await atlasCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return { width: 0, height: 0, nonEmpty: 0 };
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonEmpty = 0;
      for (let i = 3; i < d.length; i += 16) {
        if ((d[i] ?? 0) > 0) nonEmpty++;
      }
      return { width: c.width, height: c.height, nonEmpty };
    });
    expect(isPowerOfTwo(rawAtlasStats.width)).toBe(true);
    expect(isPowerOfTwo(rawAtlasStats.height)).toBe(true);
    expect(rawAtlasStats.nonEmpty).toBeGreaterThan(0);

    // Verify .fnt and .xml preview switchers
    const previewPre = page.getByTestId('bmfont-export-preview');
    await page.getByTestId('bmfont-export-tab-fnt').click();
    await expect(previewPre).toContainText('chars count=23');
    await page.getByTestId('bmfont-export-tab-xml').click();
    await expect(previewPre).toContainText('<chars count="23">');

    // Save Font to Project & download BMFont ZIP
    await page.getByTestId('bmfont-save-btn').click();
    await expect(page.getByTestId('bmfont-save-notice')).toContainText('Saved nibgrid_damage');

    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('bmfont-download-zip-btn').click();
    const download = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
    const keys = Object.keys(entries);

    const pngKey = keys.find((k) => k.endsWith('.png'));
    const fntKey = keys.find((k) => k.endsWith('.fnt'));
    const xmlKey = keys.find((k) => k.endsWith('.xml'));
    const recipeKey = keys.find((k) => k.endsWith('.recipe.json'));

    expect(pngKey).toBeTruthy();
    expect(fntKey).toBeTruthy();
    expect(xmlKey).toBeTruthy();
    expect(recipeKey).toBeTruthy();

    expect(Array.from(entries[pngKey!]!.slice(0, 8))).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    expect(strFromU8(entries[fntKey!]!)).toContain('char id=48');
    expect(strFromU8(entries[xmlKey!]!)).toContain('<char id="48"');

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(entries[recipeKey!]!)));
    expect(parsedRecipe.bitmapFont?.scale).toBe(scaleAfter);
    expect(parsedRecipe.bitmapFont?.selOutDarken).toBe(selOutAfter);

    // Hard reload & assert IndexedDB persistence
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-tab-bmfont').click();
    await expect(page.getByTestId('bmfont-meta-badge')).toContainText('23 glyphs');
    expect(Number(await page.getByTestId('bmfont-scale-scrub').getAttribute('data-value'))).toBe(
      scaleAfter,
    );
    expect(Number(await page.getByTestId('bmfont-selout-scrub').getAttribute('data-value'))).toBe(
      selOutAfter,
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
