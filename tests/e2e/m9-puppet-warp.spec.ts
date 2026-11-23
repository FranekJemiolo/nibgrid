import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { decodePngBytesToRgba } from '../../src/processing/png';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M9 MLS Puppet-Warp 2D Micro-Animator (Screen 4C)', () => {
  test('places 3 control pins, previews Idle Breathe (6 frames), and exports horizontal strip ZIP', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M9 Slime Buddy');
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

    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-resample-toggle').check();
    await page.getByTestId('pp-preset-64').click();
    await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');

    // Switch to Screen 4C: Puppet Warp Animator
    await page.getByTestId('inspector-tab-puppet').click();
    await expect(page.getByTestId('puppet-warp-panel')).toBeVisible();

    const stageBox = await page.getByTestId('puppet-stage').boundingBox();
    expect(stageBox).not.toBeNull();

    // Place 3 pins: Anchor (bottom), Driver (middle), Tip (top)
    await page.getByTestId('puppet-role-anchor').click();
    await page.mouse.click(
      stageBox!.x + stageBox!.width * 0.5,
      stageBox!.y + stageBox!.height * 0.8,
    );

    await page.getByTestId('puppet-role-driver').click();
    await page.mouse.click(
      stageBox!.x + stageBox!.width * 0.5,
      stageBox!.y + stageBox!.height * 0.52,
    );

    await page.getByTestId('puppet-role-tip').click();
    await page.mouse.click(
      stageBox!.x + stageBox!.width * 0.5,
      stageBox!.y + stageBox!.height * 0.22,
    );

    await expect(page.getByTestId('puppet-pin-marker-2')).toBeVisible();

    await page.getByTestId('puppet-preset-select').selectOption('idle-breathe');
    await page.getByTestId('puppet-frame-count').fill('6');

    // Verify strip export ZIP button updates expected dimensions: (64 + 8*2) * 6 = 480x80
    await expect(page.getByTestId('puppet-export-zip-btn')).toContainText('480×80');

    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('puppet-export-zip-btn').click();
    const download = await dlPromise;
    const zipBytes = new Uint8Array(await readFile((await download.path())!));
    const entries = unzipSync(zipBytes);

    const stripName = Object.keys(entries).find((k) => k.endsWith('_idle_strip.png'));
    const jsonName = Object.keys(entries).find((k) => k.endsWith('_idle.json'));
    const recipeName = Object.keys(entries).find((k) => k.endsWith('.recipe.json'));
    expect(stripName).toBeTruthy();
    expect(jsonName).toBeTruthy();
    expect(recipeName).toBeTruthy();

    const stripPng = entries[stripName!]!;
    expect(Array.from(stripPng.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]);
    const decodedStrip = await decodePngBytesToRgba(stripPng);
    expect(decodedStrip.width).toBe(480);
    expect(decodedStrip.height).toBe(80);

    const recipe = JSON.parse(strFromU8(entries[recipeName!]!));
    expect(recipe.puppetAnim.mode).toBe('rigid');
    expect(recipe.puppetAnim.pins).toHaveLength(3);
    expect(recipe.puppetAnim.frameCount).toBe(6);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
