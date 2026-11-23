import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { decodePngBytesToRgba } from '../../src/processing/png';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M11 MaxRects Atlas Packer & Multi-Engine Exporter (Screen 5)', () => {
  test('packs 3 sprites + 6-frame Puppet-Warp loop into Godot 4, Phaser 3, and PixiJS ZIP bundle', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    // 1. Create project -> generate 2 variants + 1 extra generation (= 3 sprites)
    await page.getByTestId('new-project-name').fill('M11 Hero Pack');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');

    await page.getByTestId('variant-count-select').selectOption('2');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(2);

    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('prompt-delta-input').fill('attack variant');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(3);

    // 2. Open Atlas Packer Screen 5
    await page.getByTestId('nav-atlas-workshop').click();
    await expect(page.getByTestId('atlas-workshop')).toBeVisible();

    // Add a 6-frame Puppet-Warp loop onto the first sprite inside Screen 5
    await expect(page.getByTestId('atlas-add-loop-0')).toBeVisible();
    await page.getByTestId('atlas-add-loop-0').click();
    await expect(page.getByTestId('atlas-loop-0')).toBeChecked();

    await expect(page.getByTestId('atlas-occupancy-badge')).toContainText('% packed');
    await expect(page.getByTestId('atlas-engine-godot')).toBeChecked();
    await expect(page.getByTestId('atlas-engine-phaser')).toBeChecked();
    await expect(page.getByTestId('atlas-engine-pixi')).toBeChecked();
    await expect(page.getByTestId('atlas-rotation-toggle')).toBeDisabled();

    // 3. Download Atlas ZIP and verify contents
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('download-atlas-zip-btn').click();
    const download = await dlPromise;
    const zipBytes = new Uint8Array(await readFile((await download.path())!));
    const entries = unzipSync(zipBytes);

    expect(entries['atlas_0.png']).toBeDefined();
    expect(entries['atlas.json']).toBeDefined();
    expect(entries['atlas_pixi.json']).toBeDefined();
    expect(entries['atlas_frames.tres']).toBeDefined();

    const pngBytes = entries['atlas_0.png']!;
    expect(Array.from(pngBytes.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const decodedAtlas = await decodePngBytesToRgba(pngBytes);

    const pixi = JSON.parse(strFromU8(entries['atlas_pixi.json']!));
    expect(pixi.meta.size.w).toBe(decodedAtlas.width);
    expect(pixi.meta.size.h).toBe(decodedAtlas.height);
    expect(Object.keys(pixi.frames).length).toBeGreaterThanOrEqual(9);

    const phaser = JSON.parse(strFromU8(entries['atlas.json']!));
    expect(phaser.textures[0].size.w).toBe(decodedAtlas.width);

    const tres = strFromU8(entries['atlas_frames.tres']!);
    expect(tres).toContain('texture_filter = 1');
    expect(tres).toContain('SpriteFrames');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
