import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M14C 1x Game Scale Sandbox & 9-Slice Audio-Visual Juice Binding', () => {
  test('saves procedural Hit & UI Click clips, binds them to H hit-flash & 9-Slice matrix clicks, and persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    // 1. Create project & generate 1 Mock Provider sprite
    await page.getByTestId('new-project-name').fill('M14C Juice Knight');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // 2. Open Audio Foundry and save procedural Hit / Impact + UI Click clips
    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.getByTestId('audio-foundry')).toBeVisible();

    await page.getByTestId('audio-preset-sfx-sprite-impact').click();
    await page.getByTestId('audio-route-select').selectOption('local-synth');
    await expect(page.getByTestId('audio-output-lufs')).toContainText('-14');
    await page.getByTestId('audio-save-btn').click();
    await expect(page.locator('[data-testid^="audio-saved-item-"]')).toHaveCount(1);

    await page.getByTestId('audio-preset-sfx-ui-tactile').click();
    await page.getByTestId('audio-route-select').selectOption('local-synth');
    await expect(page.getByTestId('audio-output-lufs')).toContainText('-12');
    await page.getByTestId('audio-save-btn').click();
    await expect(page.locator('[data-testid^="audio-saved-item-"]')).toHaveCount(2);

    // 3. Quick-launch 1x Game Scale Sandbox & bind Hit / Impact SFX
    await page.getByTestId('nav-sprite-studio').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();
    await page.getByTestId('dag-quick-sandbox-btn').click();
    await expect(page.getByTestId('game-sandbox-panel')).toBeVisible();

    const hitSelect = page.getByTestId('sandbox-hit-sfx-select');
    const hitOptionVal = await hitSelect
      .locator('option', { hasText: 'Hit / Impact' })
      .getAttribute('value');
    expect(hitOptionVal).toBeTruthy();
    await hitSelect.selectOption(hitOptionVal!);

    // Trigger Hit-Flash via 'H' shortcut -> verify audio trigger increments cleanly
    await page.keyboard.press('h');
    await expect(page.getByTestId('sandbox-canvas')).toHaveAttribute(
      'data-audio-trigger-count',
      '1',
    );
    await expect(page.getByTestId('sandbox-canvas')).toHaveAttribute(
      'data-last-played-sfx',
      hitOptionVal!,
    );

    // 4. Switch to 9-Slice UI Panel Workshop -> bind UI Click SFX -> click Wide Button preview
    await page.getByTestId('inspector-tab-tile-slice').click();
    await page.getByTestId('workshop-mode-nineslice').click();
    await expect(page.getByTestId('nineslice-guide-stage')).toBeVisible();

    const clickSelect = page.getByTestId('nineslice-click-sfx-select');
    const clickOptionVal = await clickSelect
      .locator('option', { hasText: 'UI Click / Confirm' })
      .getAttribute('value');
    expect(clickOptionVal).toBeTruthy();
    await clickSelect.selectOption(clickOptionVal!);

    await page.getByTestId('nineslice-preview-wide').click();
    await expect(page.getByTestId('nineslice-click-feedback')).toHaveAttribute(
      'data-click-count',
      '1',
    );
    await expect(page.getByTestId('nineslice-click-feedback')).toHaveAttribute(
      'data-last-clicked-sfx',
      clickOptionVal!,
    );

    // Wait briefly for Dexie queued project write to flush before hard reload
    await page.waitForTimeout(250);

    // 5. Hard reload and confirm saved clips + Sandbox/9-Slice bindings restore cleanly
    await page.reload();
    await expect(page.getByTestId('game-sandbox-panel')).toBeVisible();
    await expect(page.getByTestId('sandbox-hit-sfx-select')).toHaveValue(hitOptionVal!);

    await page.getByTestId('inspector-tab-tile-slice').click();
    await page.getByTestId('workshop-mode-nineslice').click();
    await expect(page.getByTestId('nineslice-click-sfx-select')).toHaveValue(clickOptionVal!);

    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.locator('[data-testid^="audio-saved-item-"]')).toHaveCount(2);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
