import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M22C: 2D VFX Flipbook & Particle Sheet Baker (Screen 4K)', () => {
  test('bakes Hit Ring, scrubs Spread & Turbulence, toggles Full Sheet, exports ZIP & persists across reload', async ({
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

    await page.getByTestId('new-project-name').fill('M22C VFX Burst');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Reclassify to VFX and open VFX Baker primary tab
    await page.getByTestId('inspector-asset-class-select').selectOption('vfx');
    await page.getByTestId('inspector-tab-vfx-baker').click();
    await expect(page.getByTestId('vfx-baker-panel')).toBeVisible();

    // Select Hit Ring archetype
    await page.getByTestId('vfx-archetype-hit-ring').click();
    await expect(page.getByTestId('vfx-meta-badge')).toContainText(
      'Hit Ring · 4×4 (16f) · 256×256',
    );

    // Scrub Spread & Turbulence via ScrubInput pointer drag
    const spreadScrub = page.getByTestId('vfx-spread-scrub');
    const spreadBefore = Number(await spreadScrub.getAttribute('data-value'));
    const spreadBox = await spreadScrub.boundingBox();
    expect(spreadBox).not.toBeNull();
    await page.mouse.move(
      spreadBox!.x + spreadBox!.width / 2,
      spreadBox!.y + Math.min(12, spreadBox!.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      spreadBox!.x + spreadBox!.width / 2 - 20,
      spreadBox!.y + Math.min(12, spreadBox!.height / 2),
      { steps: 6 },
    );
    await page.mouse.up();
    const spreadAfter = Number(await spreadScrub.getAttribute('data-value'));
    expect(spreadAfter).not.toBe(spreadBefore);

    const turbScrub = page.getByTestId('vfx-turbulence-scrub');
    const turbBefore = Number(await turbScrub.getAttribute('data-value'));
    const turbBox = await turbScrub.boundingBox();
    expect(turbBox).not.toBeNull();
    await page.mouse.move(
      turbBox!.x + turbBox!.width / 2,
      turbBox!.y + Math.min(12, turbBox!.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      turbBox!.x + turbBox!.width / 2 + 28,
      turbBox!.y + Math.min(12, turbBox!.height / 2),
      { steps: 6 },
    );
    await page.mouse.up();
    const turbAfter = Number(await turbScrub.getAttribute('data-value'));
    expect(turbAfter).not.toBe(turbBefore);

    // Toggle Play/Pause and assert non-empty live flipbook canvas pixels
    await page.getByTestId('vfx-play-toggle').click();
    const liveCanvas = page.getByTestId('vfx-preview-canvas');
    await expect(liveCanvas).toBeVisible();
    await expect
      .poll(() =>
        liveCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return 0;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let count = 0;
          for (let i = 3; i < d.length; i += 4) {
            if ((d[i] ?? 0) > 0) count++;
          }
          return count;
        }),
      )
      .toBeGreaterThan(0);

    await page.getByTestId('vfx-play-toggle').click();

    // Switch to Full Sheet view and verify packed 256x256 non-empty sheet canvas
    await page.getByTestId('vfx-view-sheet').click();
    const sheetCanvas = page.getByTestId('vfx-sheet-canvas');
    await expect(sheetCanvas).toBeVisible();
    await expect
      .poll(() =>
        sheetCanvas.evaluate((el) => {
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
      .toEqual(expect.objectContaining({ width: 256, height: 256 }));
    const sheetStats = await sheetCanvas.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const ctx = c.getContext('2d');
      if (!ctx) return 0;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let nonEmpty = 0;
      for (let i = 3; i < d.length; i += 16) {
        if ((d[i] ?? 0) > 0) nonEmpty++;
      }
      return nonEmpty;
    });
    expect(sheetStats).toBeGreaterThan(0);

    // Check Godot .tres, Godot .tscn, and PixiJS JSON preview switchers
    const previewPre = page.getByTestId('vfx-export-preview');
    await page.getByTestId('vfx-export-tab-tres').click();
    await expect(previewPre).toContainText('particles_anim_h_frames = 4');
    await page.getByTestId('vfx-export-tab-tscn').click();
    await expect(previewPre).toContainText('GPUParticles2D');
    await page.getByTestId('vfx-export-tab-pixi').click();
    await expect(previewPre).toContainText('"blendMode": "add"');

    // Save to IndexedDB and download VFX ZIP bundle
    await page.getByTestId('vfx-save-btn').click();
    await expect(page.getByTestId('vfx-save-notice')).toContainText('Saved VFX (hit-ring · 4×4)');

    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('vfx-download-zip-btn').click();
    const download = await dlPromise;
    const zipEntries = unzipSync(new Uint8Array(await readFile((await download.path())!)));

    const pngKey = Object.keys(zipEntries).find((k) => k.endsWith('_vfx_sheet.png'));
    const tresKey = Object.keys(zipEntries).find((k) => k.endsWith('_vfx_godot.tres'));
    const tscnKey = Object.keys(zipEntries).find((k) => k.endsWith('_vfx_godot.tscn'));
    const pixiKey = Object.keys(zipEntries).find((k) => k.endsWith('_vfx_pixi.json'));
    const recipeKey = Object.keys(zipEntries).find((k) => k.endsWith('.recipe.json'));

    expect(pngKey).toBeTruthy();
    expect(tresKey).toBeTruthy();
    expect(tscnKey).toBeTruthy();
    expect(pixiKey).toBeTruthy();
    expect(recipeKey).toBeTruthy();

    expect(Array.from(zipEntries[pngKey!]!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const tresText = strFromU8(zipEntries[tresKey!]!);
    expect(tresText).toContain('particles_anim_h_frames = 4');
    expect(tresText).toContain('particles_anim_v_frames = 4');
    expect(strFromU8(zipEntries[tscnKey!]!)).toContain('GPUParticles2D');

    const pixiJson = JSON.parse(strFromU8(zipEntries[pixiKey!]!));
    expect(pixiJson.frameCount).toBe(16);
    expect(pixiJson.blendMode).toBe('add');

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(zipEntries[recipeKey!]!)));
    expect(parsedRecipe.vfxFlipbook?.archetype).toBe('hit-ring');
    expect(parsedRecipe.vfxFlipbook?.spread).toBe(spreadAfter);
    expect(parsedRecipe.vfxFlipbook?.turbulence).toBe(turbAfter);

    // Hard reload and confirm saved VFX settings persist cleanly from IndexedDB
    await page.waitForTimeout(200);
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByTestId('inspector-asset-class-select')).toHaveValue('vfx');
    await page.getByTestId('inspector-tab-vfx-baker').click();
    await expect(page.getByTestId('vfx-meta-badge')).toContainText('Hit Ring · 4×4');
    await expect(page.getByTestId('vfx-spread-scrub')).toHaveAttribute(
      'data-value',
      String(spreadAfter),
    );
    await expect(page.getByTestId('vfx-turbulence-scrub')).toHaveAttribute(
      'data-value',
      String(turbAfter),
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
