import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M12B Visual 9-Slice UI Panel Workshop & Engine Exporters (Screen 4D)', () => {
  test('auto-detects margins, mirrors Lock T=B, renders live stress-test matrix, and exports .tres + JSON ZIP', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M12B Stone UI Panel');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Enter Screen 4D -> 9-Slice UI Panel mode
    await page.getByTestId('inspector-tab-tile-slice').click();
    await page.getByTestId('workshop-mode-nineslice').click();
    await expect(page.getByTestId('nineslice-guide-stage')).toBeVisible();

    // Auto-detect margins -> verify banner updates
    await page.getByTestId('nineslice-autodetect-btn').click();
    await expect(page.getByTestId('seamless-status-banner')).toContainText(
      'Auto-detected 9-slice margins',
    );

    // Enable Lock T = B and change Top -> 10, verifying Bottom mirrors 10
    await page.getByTestId('nineslice-lock-tb').check();
    await page.getByTestId('nineslice-top').fill('10');
    await expect(page.getByTestId('nineslice-bottom')).toHaveValue('10');

    // Switch Edge + Center modes to Tile
    await page.getByTestId('nineslice-edge-mode').selectOption('tile');
    await page.getByTestId('nineslice-center-mode').selectOption('tile');

    // Confirm all 3 stress-test matrix previews rendered non-empty pixels at exact dimensions
    for (const [id, expectedW, expectedH] of [
      ['nineslice-preview-wide', 240, 48],
      ['nineslice-preview-tall', 72, 220],
      ['nineslice-preview-square', 180, 180],
    ] as const) {
      await expect
        .poll(async () =>
          page.getByTestId(id).evaluate((el) => {
            const c = el as HTMLCanvasElement;
            const ctx = c.getContext('2d');
            if (!ctx || c.width === 0) return { width: 0, height: 0, nonEmpty: false };
            const img = ctx.getImageData(0, 0, Math.min(24, c.width), Math.min(24, c.height)).data;
            let nonEmpty = false;
            for (let i = 3; i < img.length; i += 4) {
              if ((img[i] ?? 0) > 0) {
                nonEmpty = true;
                break;
              }
            }
            return { width: c.width, height: c.height, nonEmpty };
          }),
        )
        .toEqual({ width: expectedW, height: expectedH, nonEmpty: true });
    }

    // Export 9-Slice bundle ZIP and validate Godot StyleBoxTexture .tres, Phaser, Pixi, and recipe.json
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('nineslice-export-zip-btn').click();
    const download = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));

    const tresName = Object.keys(entries).find((k) => k.endsWith('_stylebox.tres'));
    const phaserName = Object.keys(entries).find((k) => k.endsWith('_nineslice_phaser.json'));
    const pixiName = Object.keys(entries).find((k) => k.endsWith('_nineslice_pixi.json'));
    const recipeName = Object.keys(entries).find((k) => k.endsWith('.recipe.json'));

    expect(tresName).toBeTruthy();
    expect(phaserName).toBeTruthy();
    expect(pixiName).toBeTruthy();
    expect(recipeName).toBeTruthy();

    const tresText = strFromU8(entries[tresName!]!);
    expect(tresText).toContain('StyleBoxTexture');
    expect(tresText).toContain('texture_margin_top = 10.0');
    expect(tresText).toContain('texture_margin_bottom = 10.0');
    expect(tresText).toContain('axis_stretch_horizontal = 1');

    const phaser = JSON.parse(strFromU8(entries[phaserName!]!));
    expect(phaser.topHeight).toBe(10);
    expect(phaser.bottomHeight).toBe(10);

    const recipe = JSON.parse(strFromU8(entries[recipeName!]!));
    expect(recipe.nineSlice.enabled).toBe(true);
    expect(recipe.nineSlice.top).toBe(10);
    expect(recipe.nineSlice.bottom).toBe(10);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
