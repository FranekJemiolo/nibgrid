import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { decodePngBytesToRgba } from '../../src/processing/png';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M12C Indexed Palette-Swap & Stacked LUT Workshop (Screen 4E)', () => {
  test('indexes sprite, builds 2 OKLCH hue variants, renders distinct live canvases, and exports verified LUT ZIP', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M12C Crimson Knight');
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

    await page.getByTestId('inspector-tab-palette-lut').click();
    await expect(page.getByTestId('palette-lut-workshop-panel')).toBeVisible();

    // Auto-quantize if raw sprite exceeded 256 unique colors
    const over256Visible = await page
      .getByTestId('lut-over-256-banner')
      .isVisible()
      .catch(() => false);
    if (over256Visible) {
      await page.getByTestId('lut-quantize-32-btn').click();
    }

    await expect(page.getByTestId('lut-dimensions-badge')).toBeVisible();

    // Add Variant 1 & apply +120 deg hue shift (also bump temperature slightly so even grays shift if selected)
    await page.getByTestId('lut-add-variant-btn').click();
    await expect(page.getByTestId('lut-preview-variant-0')).toBeVisible();
    await page.getByTestId('lut-hue-shift').fill('120');

    // Add Variant 2 & apply -90 deg hue shift
    await page.getByTestId('lut-add-variant-btn').click();
    await expect(page.getByTestId('lut-preview-variant-1')).toBeVisible();
    await page.getByTestId('lut-hue-shift').fill('-90');

    const canvasSignature = async (testId: string) =>
      page.getByTestId(testId).evaluate((el) => {
        const c = el as HTMLCanvasElement;
        const ctx = c.getContext('2d');
        if (!ctx || c.width === 0 || c.height === 0) return { r: 0, g: 0, b: 0, alpha: 0 };
        const img = ctx.getImageData(0, 0, c.width, c.height).data;
        let r = 0;
        let g = 0;
        let b = 0;
        let alpha = 0;
        for (let i = 0; i < img.length; i += 4) {
          const a = img[i + 3] ?? 0;
          if (a === 0) continue;
          r += img[i] ?? 0;
          g += img[i + 1] ?? 0;
          b += img[i + 2] ?? 0;
          alpha += a;
        }
        return { r, g, b, alpha };
      });

    await expect
      .poll(async () => {
        const [baseSig, v0Sig, v1Sig] = await Promise.all([
          canvasSignature('lut-preview-base'),
          canvasSignature('lut-preview-variant-0'),
          canvasSignature('lut-preview-variant-1'),
        ]);
        const nonEmpty = baseSig.alpha > 0 && v0Sig.alpha > 0 && v1Sig.alpha > 0;
        const distinctBaseV0 =
          Math.abs(baseSig.r - v0Sig.r) +
            Math.abs(baseSig.g - v0Sig.g) +
            Math.abs(baseSig.b - v0Sig.b) >
          0;
        const distinctBaseV1 =
          Math.abs(baseSig.r - v1Sig.r) +
            Math.abs(baseSig.g - v1Sig.g) +
            Math.abs(baseSig.b - v1Sig.b) >
          0;
        const distinctV0V1 =
          Math.abs(v0Sig.r - v1Sig.r) + Math.abs(v0Sig.g - v1Sig.g) + Math.abs(v0Sig.b - v1Sig.b) >
          0;
        return { nonEmpty, distinctBaseV0, distinctBaseV1, distinctV0V1 };
      })
      .toEqual({ nonEmpty: true, distinctBaseV0: true, distinctBaseV1: true, distinctV0V1: true });

    // Download Stacked LUT ZIP bundle & validate files + PNG signatures + recipe
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('lut-download-zip-btn').click();
    const download = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));

    const idxName = Object.keys(entries).find((k) => k.endsWith('_idx.png'));
    const lutName = Object.keys(entries).find((k) => k.endsWith('_lut.png'));
    const gdShaderName = Object.keys(entries).find((k) => k.endsWith('_palette_swap.gdshader'));
    const pixiFilterName = Object.keys(entries).find((k) => k.endsWith('_palette_swap_pixi.ts'));
    const recipeName = Object.keys(entries).find((k) => k.endsWith('.recipe.json'));

    expect(idxName).toBeTruthy();
    expect(lutName).toBeTruthy();
    expect(gdShaderName).toBeTruthy();
    expect(pixiFilterName).toBeTruthy();
    expect(recipeName).toBeTruthy();

    const idxBytes = entries[idxName!]!;
    const lutBytes = entries[lutName!]!;
    expect(Array.from(idxBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Array.from(lutBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);

    const decodedLut = await decodePngBytesToRgba(lutBytes);
    expect(decodedLut.height).toBe(3); // Base + Variant 1 + Variant 2
    expect(decodedLut.width).toBeGreaterThanOrEqual(2);

    const gdText = strFromU8(entries[gdShaderName!]!);
    expect(gdText).toContain('filter_nearest');

    const pixiText = strFromU8(entries[pixiFilterName!]!);
    expect(pixiText).toContain("scaleMode = 'nearest'");

    const recipe = JSON.parse(strFromU8(entries[recipeName!]!));
    expect(recipe.paletteLut).toBeDefined();
    expect(recipe.paletteLut.variantCount).toBe(3);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
