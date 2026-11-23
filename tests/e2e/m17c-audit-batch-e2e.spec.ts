import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { encodeWav16 } from '../../src/audio/pcmPostProcess';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const PALETTE_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/test-palette.gpl');

function createQuietWavBuffer(
  amplitude = 0.04,
  durationSec = 0.45,
  sampleRate = 22050,
): Uint8Array {
  const frames = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    samples[i] = amplitude * Math.sin((2 * Math.PI * 330 * i) / sampleRate);
  }
  return encodeWav16({ sampleRate, channels: 1, samples });
}

test.describe('M17C Project-Wide Asset Audit Matrix & 1-Click Batch Recipe Runner (Screen 7)', () => {
  test('audits 3 sprites + quiet audio, switches biome contrast, runs $0.00 batch, supports Undo Batch & reload persistence', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    // 1. Seed project with 3 Mock Provider sprites (2 variants + 1 variant)
    await page.getByTestId('new-project-name').fill('M17C Audit Foundry');
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
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(3);

    // 2. Post-process node 3 once so it stamps recipeArtBibleHash, then mutate Art Bible to make it Stale
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await expect(page.getByText('Processing in Worker...')).toHaveCount(0);
    await page.waitForTimeout(250);

    await page.getByTestId('nav-art-bible').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('palette-file-input').setInputFiles(PALETTE_FIXTURE);
    await expect(page.getByTestId('palette-swatch-#38B764')).toBeVisible();

    // 3. Save 1 un-normalized quiet audio clip (~-34 LUFS) in Audio Foundry
    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.getByTestId('audio-foundry')).toBeVisible();
    await page.getByTestId('audio-tab-mic-sketch').click();

    await page.getByTestId('audio-lufs-toggle').uncheck();
    await page.getByTestId('hum-upload-input').setInputFiles({
      name: 'quiet-sfx.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from(createQuietWavBuffer()),
    });
    await expect(page.getByTestId('audio-output-lufs')).toContainText('-3');
    await page.getByTestId('audio-clip-name-input').fill('Quiet Audit Clip');
    await page.getByTestId('audio-save-btn').click();
    await expect(page.locator('[data-testid^="audio-saved-item-"]')).toHaveCount(1);

    // 4. Open Audit Matrix (Screen 7) -> assert Readiness Score < 100 & fail/warn/stale badges
    await page.getByTestId('nav-audit-matrix').click();
    await expect(page.getByTestId('audit-matrix-view')).toBeVisible();
    await expect(page.locator('tr[data-testid^="audit-row-"]')).toHaveCount(4);

    const scoreEl = page.getByTestId('audit-readiness-score');
    const initialScore = Number.parseInt((await scoreEl.textContent()) ?? '100', 10);
    expect(initialScore).toBeLessThan(100);

    await expect(page.locator('[data-severity="fail"]').first()).toBeVisible();
    await expect(page.locator('[data-severity="warn"]').first()).toBeVisible();
    await expect(page.locator('[data-testid="audit-matrix-view"] tbody')).toContainText('Stale');

    // 5. Switch Target Biome -> confirm 1x Contrast cell updates dynamically
    const firstContrastCell = page.locator('[data-testid$="-contrast"]').first();
    const darkContrastText = await firstContrastCell.textContent();
    await page.getByTestId('audit-biome-select').selectOption('bright-snow');
    await expect(firstContrastCell).not.toHaveText(darkContrastText ?? '');

    const preBatchScore = Number.parseInt((await scoreEl.textContent()) ?? '0', 10);

    // 6. Click Fix All Stale & Failing -> verify Dry-Run "$0.00 local compute" -> Run Batch
    await page.getByTestId('audit-fix-all-btn').click();
    await expect(page.getByTestId('batch-dry-run-summary')).toContainText('$0.00 local compute');
    await page.getByTestId('batch-run-btn').click();

    await expect(page.getByTestId('batch-result-banner')).toBeVisible();
    await expect(page.getByTestId('batch-undo-btn')).toBeVisible();

    await expect
      .poll(async () => Number.parseInt((await scoreEl.textContent()) ?? '0', 10))
      .toBeGreaterThan(preBatchScore);
    const fixedScore = Number.parseInt((await scoreEl.textContent()) ?? '0', 10);

    // 7. Click Undo Batch -> confirm exact pre-batch score restores cleanly
    await page.getByTestId('batch-undo-btn').click();
    await expect
      .poll(async () => Number.parseInt((await scoreEl.textContent()) ?? '0', 10))
      .toBe(preBatchScore);

    // 8. Re-run Batch -> hard reload -> verify fixed Readiness Score & matrix state persist from IndexedDB
    await page.getByTestId('audit-fix-all-btn').click();
    await page.getByTestId('batch-run-btn').click();
    await expect(page.getByTestId('batch-result-banner')).toBeVisible();
    await expect
      .poll(async () => Number.parseInt((await scoreEl.textContent()) ?? '0', 10))
      .toBe(fixedScore);

    await page.waitForTimeout(250);
    await page.reload();
    await expect(page.getByTestId('audit-matrix-view')).toBeVisible();
    await expect(page.locator('tr[data-testid^="audit-row-"]')).toHaveCount(4);
    await page.getByTestId('audit-biome-select').selectOption('bright-snow');
    await expect
      .poll(async () => Number.parseInt((await scoreEl.textContent()) ?? '0', 10))
      .toBe(fixedScore);
    await expect(page.locator('[data-testid$="-palette"][data-severity="fail"]')).toHaveCount(0);
    await expect(page.locator('[data-testid$="-collider"][data-severity="warn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid$="-recipeSync"][data-severity="warn"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="audit-matrix-view"] tbody')).not.toContainText(
      'Stale',
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
