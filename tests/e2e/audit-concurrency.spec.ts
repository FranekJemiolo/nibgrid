import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
// Valid 1x1 opaque PNG encoded in base64 for deterministic Gemini mock responses
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test.describe('Phase 2 Audit: Concurrency, Cancellation & Adversarial Edge Cases', () => {
  test('aborts in-flight generation cleanly and isolates project switches', async ({ page }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let geminiDelayMs = 1500;
    await page.route('**/v1beta/models/*:generateContent*', async (route) => {
      await new Promise((r) => setTimeout(r, geminiDelayMs));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: TINY_PNG_BASE64 } }],
              },
            },
          ],
        }),
      });
    });

    await page.goto('/');

    // Add a BYOK Gemini provider (intercepted locally via page.route)
    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('provider-vault-modal')).toBeVisible();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-display-name-input').fill('Mocked Gemini Audit');
    await page.getByTestId('vault-api-key-input').fill('AIzaTestAuditSecret001');
    await page.getByTestId('vault-save-provider-btn').click();
    await page.getByTestId('close-vault-btn').click();

    // Validate ComfyUI malformed workflow guard in Vault
    await page.getByTestId('nav-provider-vault').click();
    await page.getByTestId('vault-kind-select').selectOption('comfyui');
    await page
      .getByTestId('vault-workflow-textarea')
      .fill('{"1":{"class_type":"CLIPTextEncode","inputs":{"text":"no token"}}}');
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(page.getByTestId('vault-form-error')).toContainText('{{PROMPT}}');
    await page.getByTestId('close-vault-btn').click();

    // Create Project A and open Studio
    await page.getByTestId('new-project-name').fill('Project Alpha');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page
      .getByTestId('provider-select')
      .selectOption({ label: 'Mocked Gemini Audit (gemini-2.5-flash-image)' });

    // Start generation and click Cancel immediately
    await page.getByTestId('generate-btn').click();
    await expect(page.getByTestId('cancel-generation-btn')).toBeVisible();
    await page.getByTestId('cancel-generation-btn').click();

    await expect(page.getByTestId('studio-status')).toContainText('Generation cancelled.');
    await expect(page.getByTestId('studio-error-banner')).toHaveCount(0);
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(0);

    // Start generation on Project Alpha and switch immediately to a new Project Beta
    geminiDelayMs = 450;
    await page.getByTestId('generate-btn').click();
    await expect(page.getByTestId('cancel-generation-btn')).toBeVisible();

    await page.getByTestId('nav-projects').click();
    await page.getByTestId('new-project-name').fill('Project Beta');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();

    // Wait longer than Project Alpha's delayed response and verify zero cross-project bleed
    await page.waitForTimeout(650);
    await expect(page.getByTestId('dag-empty-state')).toBeVisible();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(0);

    expect(pageErrors).toEqual([]);
  });

  test('drops stale worker results under rapid slider thrashing & warns on empty palette snap', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.getByTestId('new-project-name').fill('Worker Thrash Project');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();

    // Clear default Art Bible palette swatches so OKLab snap warning triggers
    const removeSwatchButtons = page.locator('[data-testid="palette-swatch-list"] button');
    while ((await removeSwatchButtons.count()) > 0) {
      await removeSwatchButtons.first().click();
    }
    await expect(page.getByTestId('palette-swatch-list')).toContainText('No swatches added yet.');

    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Enable palette snap on empty palette -> must show warning hint
    await page.getByTestId('pp-palette-snap-toggle').check();
    await expect(page.getByTestId('empty-palette-snap-hint')).toBeVisible();

    // Rapidly thrash sliders/presets/toggles without waiting between interactions
    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-resample-toggle').check();
    await page.getByTestId('pp-preset-256').click();
    await page.getByTestId('pp-preset-64').click();
    await page.getByTestId('pp-preset-128').click();
    await page.getByTestId('pp-preset-64').click();

    await expect(page.getByTestId('processed-dimensions-badge')).toContainText('64×64', {
      timeout: 5000,
    });

    expect(pageErrors).toEqual([]);
  });
});
