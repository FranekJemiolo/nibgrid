import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M21C: Interactive Attachment Sockets Editor & Screen 4 Integration', () => {
  test('adds presets, drags marker, isolates Backspace in input, switches exporters, exports ZIP & persists on reload', async ({
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

    await page.getByTestId('new-project-name').fill('M21C Socket Knight');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    await page.getByTestId('inspector-tab-sockets').click();
    await expect(page.getByTestId('socket-editor-panel')).toBeVisible();
    await expect(page.getByTestId('socket-count-badge')).toContainText('0 sockets');

    // Add presets muzzle & hand_r
    await page.getByTestId('socket-preset-muzzle').click();
    await page.getByTestId('socket-preset-hand_r').click();
    await expect(page.getByTestId('socket-count-badge')).toContainText('2 sockets');
    await expect(page.getByTestId('socket-item-muzzle')).toBeVisible();
    await expect(page.getByTestId('socket-item-hand_r')).toBeVisible();

    // Drag muzzle marker to (25%, 25%) of the SVG overlay
    const svgOverlay = page.getByTestId('socket-svg-overlay');
    const muzzleMarker = page.getByTestId('socket-marker-muzzle');
    const svgBox = await svgOverlay.boundingBox();
    const muzzleBox = await muzzleMarker.boundingBox();
    expect(svgBox).not.toBeNull();
    expect(muzzleBox).not.toBeNull();

    const viewBoxAttr = await svgOverlay.getAttribute('viewBox');
    expect(viewBoxAttr).toBeTruthy();
    const [, , vbWidthStr, vbHeightStr] = viewBoxAttr!.split(/\s+/);
    const spriteW = Number(vbWidthStr);
    const spriteH = Number(vbHeightStr);

    const startX = muzzleBox!.x + muzzleBox!.width / 2;
    const startY = muzzleBox!.y + muzzleBox!.height / 2;
    const targetX = svgBox!.x + svgBox!.width * 0.25;
    const targetY = svgBox!.y + svgBox!.height * 0.25;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(targetX, targetY, { steps: 10 });
    await page.mouse.up();

    const draggedX = Number(await muzzleMarker.getAttribute('data-x'));
    const draggedY = Number(await muzzleMarker.getAttribute('data-y'));
    expect(Math.abs(draggedX - spriteW * 0.25)).toBeLessThanOrEqual(2);
    expect(Math.abs(draggedY - spriteH * 0.25)).toBeLessThanOrEqual(2);
    await expect(page.getByTestId('socket-active-readout')).toContainText(
      `(${draggedX}, ${draggedY})`,
    );

    // Keyboard isolation check: typing + Backspace inside custom input must NOT delete muzzle/hand_r
    const customInput = page.getByTestId('socket-custom-name-input');
    await customInput.click();
    await customInput.fill('wing_tipxx');
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Backspace');
    await expect(customInput).toHaveValue('wing_tip');
    await expect(page.getByTestId('socket-count-badge')).toContainText('2 sockets');
    await expect(page.getByTestId('socket-item-muzzle')).toBeVisible();
    await expect(page.getByTestId('socket-item-hand_r')).toBeVisible();

    await page.getByTestId('socket-custom-add-btn').click();
    await expect(page.getByTestId('socket-item-wing_tip')).toBeVisible();
    await expect(page.getByTestId('socket-count-badge')).toContainText('3 sockets');

    // Remove wing_tip via delete button cleanly
    await page.getByTestId('socket-delete-wing_tip').click();
    await expect(page.getByTestId('socket-count-badge')).toContainText('2 sockets');

    // Verify Godot 4, Phaser 3, and PixiJS export preview switchers
    const previewPre = page.getByTestId('socket-export-preview');
    await page.getByTestId('socket-export-tab-godot').click();
    await expect(previewPre).toContainText('[node name="muzzle" type="Marker2D" parent="."]');
    await expect(previewPre).toContainText('Vector2(');

    await page.getByTestId('socket-export-tab-phaser').click();
    await expect(previewPre).toContainText('"engine": "phaser3"');
    await expect(previewPre).toContainText('"muzzle"');

    await page.getByTestId('socket-export-tab-pixi').click();
    await expect(previewPre).toContainText('"engine": "pixijs"');
    await expect(previewPre).toContainText('"rotationRad"');

    // Save sockets explicitly and download full ZIP bundle
    await page.getByTestId('socket-save-btn').click();
    await expect(page.getByTestId('socket-save-notice')).toContainText(
      'Saved 2 attachment sockets',
    );

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('socket-download-zip-btn').click();
    const download = await downloadPromise;
    const zipEntries = unzipSync(new Uint8Array(await readFile((await download.path())!)));

    const socketsKey = Object.keys(zipEntries).find((k) => k.endsWith('_sockets.json'));
    const recipeKey = Object.keys(zipEntries).find((k) => k.endsWith('.recipe.json'));
    expect(socketsKey).toBeTruthy();
    expect(recipeKey).toBeTruthy();

    const socketsPayload = JSON.parse(strFromU8(zipEntries[socketsKey!]!));
    expect(socketsPayload.app).toBe('nibgrid');
    expect(socketsPayload.sockets.muzzle.frames[0].posPx.x).toBe(draggedX);
    expect(socketsPayload.sockets.muzzle.frames[0].posPx.y).toBe(draggedY);

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(zipEntries[recipeKey!]!)));
    expect(parsedRecipe.sockets?.map((s) => s.name)).toEqual(['muzzle', 'hand_r']);

    // Hard reload and confirm sockets + dragged rest position persist
    await page.waitForTimeout(200);
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-tab-sockets').click();
    await expect(page.getByTestId('socket-item-muzzle')).toBeVisible();
    await expect(page.getByTestId('socket-item-hand_r')).toBeVisible();
    expect(Number(await page.getByTestId('socket-marker-muzzle').getAttribute('data-x'))).toBe(
      draggedX,
    );
    expect(Number(await page.getByTestId('socket-marker-muzzle').getAttribute('data-y'))).toBe(
      draggedY,
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('maps marker drag accurately at deviceScaleFactor: 2 (HiDPI) within +-2.5px', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    try {
      await page.goto('/');
      await page.getByTestId('new-project-name').fill('M21C HiDPI');
      await page.getByTestId('create-project-btn').click();
      await page.getByTestId('go-to-studio-btn').click();
      await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
      await page.getByTestId('variant-count-select').selectOption('1');
      await page.getByTestId('generate-btn').click();
      await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

      await page.getByTestId('open-postprocess-btn').click();
      await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
      await page.getByTestId('inspector-tab-sockets').click();
      await expect(page.getByTestId('socket-editor-panel')).toBeVisible();

      await page.getByTestId('socket-preset-muzzle').click();
      const svgOverlay = page.getByTestId('socket-svg-overlay');
      const muzzleMarker = page.getByTestId('socket-marker-muzzle');
      const svgBox = await svgOverlay.boundingBox();
      const muzzleBox = await muzzleMarker.boundingBox();
      expect(svgBox).not.toBeNull();
      expect(muzzleBox).not.toBeNull();

      const viewBoxAttr = await svgOverlay.getAttribute('viewBox');
      const [, , vbWidthStr, vbHeightStr] = (viewBoxAttr ?? '0 0 64 64').split(/\s+/);
      const spriteW = Number(vbWidthStr);
      const spriteH = Number(vbHeightStr);

      await page.mouse.move(
        muzzleBox!.x + muzzleBox!.width / 2,
        muzzleBox!.y + muzzleBox!.height / 2,
      );
      await page.mouse.down();
      await page.mouse.move(svgBox!.x + svgBox!.width * 0.75, svgBox!.y + svgBox!.height * 0.3, {
        steps: 10,
      });
      await page.mouse.up();

      const actualX = Number(await muzzleMarker.getAttribute('data-x'));
      const actualY = Number(await muzzleMarker.getAttribute('data-y'));
      expect(Math.abs(actualX - spriteW * 0.75)).toBeLessThanOrEqual(2.5);
      expect(Math.abs(actualY - spriteH * 0.3)).toBeLessThanOrEqual(2.5);

      expect(consoleErrors).toEqual([]);
      expect(pageErrors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
