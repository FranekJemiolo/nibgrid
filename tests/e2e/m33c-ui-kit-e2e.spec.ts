import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';
import { ALL_UI_WIDGET_SLOTS } from '../../src/processing/uiKitCore';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M33C: Godot 4 Theme .tres UI Kit Builder', () => {
  test('synthesizes 7-slot 9-slice UI Kit, pairs M24 BMFont, previews live states, exports Theme ZIP & persists across reload', async ({
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

    await page.getByTestId('new-project-name').fill('M33C UI Theme Studio');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Classify as ui-panel so both bmfont and uikit appear as primary tabs
    await page.getByTestId('inspector-asset-class-select').selectOption('ui-panel');

    // Save an M24 Bitmap Font first so UiKitWorkshop can pair it
    await page.getByTestId('inspector-tab-bmfont').click();
    await expect(page.getByTestId('bmfont-workshop-panel')).toBeVisible();
    await page.getByTestId('bmfont-name-input').fill('rpg_hud');
    await page.getByTestId('bmfont-save-btn').click();
    await expect(page.getByTestId('bmfont-save-notice')).toContainText('Saved rpg_hud');

    // Open UI Kit tab and pair the saved M24 font
    await page.getByTestId('inspector-tab-uikit').click();
    await expect(page.getByTestId('uikit-workshop-panel')).toBeVisible();
    await expect(page.getByTestId('uikit-cost-badge')).toContainText('$0.00');

    for (const slot of ALL_UI_WIDGET_SLOTS) {
      await expect(page.getByTestId(`uikit-slot-${slot}`)).toBeVisible();
    }

    const fontSelect = page.getByTestId('uikit-font-select');
    await expect(fontSelect).toContainText('rpg_hud');
    const fontOptions = await fontSelect.locator('option').all();
    let rpgHudVal = '';
    for (const opt of fontOptions) {
      const txt = await opt.innerText();
      if (txt.includes('rpg_hud')) {
        rpgHudVal = (await opt.getAttribute('value')) ?? '';
        break;
      }
    }
    expect(rpgHudVal).toBeTruthy();
    await page.getByTestId('uikit-font-select').selectOption(rpgHudVal);

    // Verify Theme .tres header & ExtResource FontFile linkage
    const tresPreview = page.getByTestId('uikit-tres-preview');
    await expect(tresPreview).toContainText('[gd_resource type="Theme" load_steps=16 format=3]');
    await expect(tresPreview).toContainText('default_font = ExtResource("8_font")');
    await expect(tresPreview).toContainText('rpg_hud.fnt');

    // Interactive Button states: Normal -> Hover -> Pressed -> Disabled
    const stateBadge = page.getByTestId('uikit-button-state-badge');
    const previewBtn = page.getByTestId('uikit-preview-button');
    await expect(stateBadge).toHaveText('State: Normal');
    await previewBtn.hover();
    await expect(stateBadge).toHaveText('State: Hover');
    await page.mouse.down();
    await expect(stateBadge).toHaveText('State: Pressed');
    await page.mouse.up();
    await expect(stateBadge).toHaveText('State: Hover');
    await page.mouse.move(10, 10);
    await expect(stateBadge).toHaveText('State: Normal');

    await page.getByTestId('uikit-preview-disabled-toggle').check();
    await expect(stateBadge).toHaveText('State: Disabled');
    await page.getByTestId('uikit-preview-disabled-toggle').uncheck();
    await expect(stateBadge).toHaveText('State: Normal');

    // Verify progress bar & zoomed 9-slice margin overlay render pixels
    await page.getByTestId('uikit-slot-button_hover').click();
    const overlayCanvas = page.getByTestId('uikit-margin-overlay-canvas');
    await expect
      .poll(() =>
        overlayCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return 0;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let count = 0;
          for (let i = 3; i < d.length; i += 8) {
            if ((d[i] ?? 0) > 0) count++;
          }
          return count;
        }),
      )
      .toBeGreaterThan(0);

    // Save UI Kit to Project & Download Theme ZIP Bundle
    await page.getByTestId('uikit-slug-input').fill('fantasy_hud');
    await page.getByTestId('uikit-save-btn').click();
    await expect(page.getByTestId('uikit-status-notice')).toContainText('Saved "fantasy_hud"');

    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('uikit-download-zip-btn').click();
    const download = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
    const keys = Object.keys(entries);

    for (const slot of ALL_UI_WIDGET_SLOTS) {
      expect(keys).toContain(`${slot}.png`);
      expect(keys).toContain(`${slot}.png.import`);
      expect(Array.from(entries[`${slot}.png`]!.slice(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
    }
    expect(keys).toContain('rpg_hud.fnt');
    expect(keys).toContain('rpg_hud.png');
    expect(keys).toContain('rpg_hud.png.import');
    expect(keys).toContain('fantasy_hud_theme.tres');
    expect(keys).toContain('fantasy_hud.recipe.json');

    const tresContent = strFromU8(entries['fantasy_hud_theme.tres']!);
    expect(tresContent).toContain('[gd_resource type="Theme" load_steps=16 format=3]');
    expect(tresContent).toContain('default_font = ExtResource("8_font")');

    const parsedRecipe = AssetRecipeSchema.parse(
      JSON.parse(strFromU8(entries['fantasy_hud.recipe.json']!)),
    );
    expect(parsedRecipe.uiKitConfig?.slug).toBe('fantasy_hud');
    expect(parsedRecipe.uiKitConfig?.linkedBmFontId).toBe(rpgHudVal);

    // Hard reload & assert IndexedDB persistence
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-tab-uikit').click();
    await expect(page.getByTestId('uikit-slug-input')).toHaveValue('fantasy_hud');
    await expect(page.getByTestId('uikit-font-select')).toHaveValue(rpgHudVal);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
