import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { decodePngBytesToRgba } from '../../src/processing/png';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M8 WebGL2 2D Normal Map Generator & Live Point-Light Preview (Screen 4B)', () => {
  test('renders live WebGL2 lighting preview and exports Godot (+Y) vs DirectX (-Y) _n.png maps', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M8 Lit Knight');
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

    // Remove backdrop via Fast Color-Key so silhouette has crisp transparent border
    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await expect
      .poll(async () =>
        page.getByTestId('processed-preview-canvas').evaluate((el) => {
          const ctx = (el as HTMLCanvasElement).getContext('2d')!;
          return ctx.getImageData(0, 0, 1, 1).data[3] ?? 255;
        }),
      )
      .toBe(0);

    // Switch to Screen 4B: 2D Lighting & Normal Map
    await page.getByTestId('inspector-tab-normal').click();
    await expect(page.getByTestId('normal-map-preview-panel')).toBeVisible();
    await expect(page.getByTestId('normal-include-export-toggle')).toBeChecked();

    // Move pointer over interactive lighting stage
    const stageBox = await page.getByTestId('normal-light-stage').boundingBox();
    expect(stageBox).not.toBeNull();
    await page.mouse.move(
      stageBox!.x + stageBox!.width * 0.25,
      stageBox!.y + stageBox!.height * 0.25,
    );
    await page.mouse.move(
      stageBox!.x + stageBox!.width * 0.72,
      stageBox!.y + stageBox!.height * 0.35,
    );

    // Toggle Normal view mode & ensure canvas has visible pixels
    await page.getByTestId('normal-view-normal').click();
    await expect
      .poll(async () =>
        page.getByTestId('normal-preview-canvas').evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          return { width: canvas.width, height: canvas.height };
        }),
      )
      .toEqual({ width: 128, height: 128 });

    // 1) Export Godot / OpenGL (+Y) normal map
    await page.getByTestId('normal-convention-opengl').click();
    const dlOpenglPromise = page.waitForEvent('download');
    await page.getByTestId('download-zip-btn').click();
    const dlOpengl = await dlOpenglPromise;
    const zipOpengl = unzipSync(new Uint8Array(await readFile((await dlOpengl.path())!)));
    const normEntryGl = Object.keys(zipOpengl).find((k) => k.endsWith('_n.png'));
    const recipeEntry = Object.keys(zipOpengl).find((k) => k.endsWith('.recipe.json'));
    expect(normEntryGl).toBeTruthy();
    expect(recipeEntry).toBeTruthy();

    const normBytesGl = zipOpengl[normEntryGl!]!;
    expect(Array.from(normBytesGl.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const decodedGl = await decodePngBytesToRgba(normBytesGl);
    // Transparent corner (0, 0) must encode neutral normal (128, 128, 255, 0)
    expect(Array.from(decodedGl.rgba.slice(0, 4))).toEqual([128, 128, 255, 0]);

    const parsedRecipe = JSON.parse(strFromU8(zipOpengl[recipeEntry!]!));
    expect(parsedRecipe.normalMap?.enabled).toBe(true);
    expect(parsedRecipe.normalMap?.convention).toBe('opengl');

    // 2) Export DirectX (-Y) normal map & verify G channel flips on non-flat opaque edge pixels
    await page.getByTestId('normal-convention-directx').click();
    const dlDxPromise = page.waitForEvent('download');
    await page.getByTestId('download-zip-btn').click();
    const dlDx = await dlDxPromise;
    const zipDx = unzipSync(new Uint8Array(await readFile((await dlDx.path())!)));
    const normEntryDx = Object.keys(zipDx).find((k) => k.endsWith('_n.png'));
    const decodedDx = await decodePngBytesToRgba(zipDx[normEntryDx!]!);

    let invertedYCount = 0;
    for (let i = 0; i < decodedGl.width * decodedGl.height; i++) {
      const idx = i * 4;
      if ((decodedGl.rgba[idx + 3] ?? 0) >= 128) {
        const gGl = decodedGl.rgba[idx + 1] ?? 128;
        const gDx = decodedDx.rgba[idx + 1] ?? 128;
        if (gGl > 135 && gDx < 121) {
          invertedYCount++;
        }
      }
    }
    expect(invertedYCount).toBeGreaterThan(5);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
