import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const GOLDEN_REF_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/golden-ref.png');

test.describe('M4 Live BYOK (Gemini) & Local ComfyUI Adapters', () => {
  test('executes intercepted Gemini and ComfyUI flows and surfaces redacted 401 and CORS diagnostics safely', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      // Ignore expected network failure logs triggered when testing 401/aborted routes
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          !text.includes('401') &&
          !text.includes('Failed to load resource') &&
          !text.includes('ERR_FAILED')
        ) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    const samplePngBytes = readFileSync(GOLDEN_REF_FIXTURE);
    const samplePngBase64 = samplePngBytes.toString('base64');

    await page.goto('/');

    // Configure Gemini BYOK + Local ComfyUI in Provider Vault
    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('provider-vault-modal')).toBeVisible();

    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill('AIzaSyTESTKEY123');
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Gemini Multimodal BYOK' }),
    ).toBeVisible();

    await page.getByTestId('vault-kind-select').selectOption('comfyui');
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Local ComfyUI' }),
    ).toBeVisible();

    await page.getByTestId('close-vault-btn').click();

    // Create project & enter Sprite Studio
    await page.getByTestId('new-project-name').fill('Live Adapter Knight');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');

    // 1. Gemini Happy Path via page.route()
    let geminiMode: 'success' | '401' = 'success';
    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      if (geminiMode === '401') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { message: 'API key not valid: AIzaSyTESTKEY123' },
          }),
        });
        return;
      }

      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: samplePngBase64,
                    },
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    const geminiOptionVal = await page
      .getByTestId('provider-select')
      .locator('option', { hasText: 'Gemini Multimodal BYOK' })
      .getAttribute('value');
    expect(geminiOptionVal).toBeTruthy();

    await page.getByTestId('provider-select').selectOption(geminiOptionVal!);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('prompt-delta-input').fill('emerald pauldrons');
    await page.getByTestId('generate-btn').click();

    await expect(page.locator('[data-testid^="dag-node-"]')).toHaveCount(2);
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // 2. Gemini 401 Failure Path (key redacted + state preserved)
    geminiMode = '401';
    await page.getByTestId('prompt-delta-input').fill('preserved prompt delta');
    await page.getByTestId('generate-btn').click();

    const banner = page.getByTestId('studio-error-banner');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('401');
    await expect(banner).not.toContainText('AIzaSyTESTKEY123');
    await expect(page.getByTestId('prompt-delta-input')).toHaveValue('preserved prompt delta');
    await expect(page.locator('[data-testid^="dag-node-"]')).toHaveCount(2);
    await page.getByTestId('dismiss-error-banner-btn').click();

    // 3. ComfyUI Happy Path via page.route() + page.routeWebSocket()
    let comfyMode: 'success' | 'cors-abort' = 'success';
    await page.routeWebSocket('ws://127.0.0.1:8188/**', (ws) => {
      if (comfyMode === 'cors-abort') {
        ws.close();
        return;
      }
      ws.send(
        JSON.stringify({
          type: 'execution_success',
          data: { prompt_id: 'prompt-comfy-001' },
        }),
      );
    });

    await page.route('http://127.0.0.1:8188/**', async (route) => {
      if (comfyMode === 'cors-abort') {
        await route.abort('failed');
        return;
      }

      const pathname = new URL(route.request().url()).pathname;
      if (pathname === '/upload/image') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ name: 'uploaded_sketch.png', subfolder: '', type: 'input' }),
        });
      } else if (pathname === '/prompt') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ prompt_id: 'prompt-comfy-001' }),
        });
      } else if (pathname === '/history/prompt-comfy-001') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            'prompt-comfy-001': {
              outputs: {
                '8': {
                  images: [{ filename: 'nibgrid_sprite_0001.png', subfolder: '', type: 'output' }],
                },
              },
            },
          }),
        });
      } else if (pathname === '/view') {
        await route.fulfill({
          status: 200,
          contentType: 'image/png',
          body: samplePngBytes,
        });
      } else {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
      }
    });

    const comfyOptionVal = await page
      .getByTestId('provider-select')
      .locator('option', { hasText: 'Local ComfyUI' })
      .getAttribute('value');
    expect(comfyOptionVal).toBeTruthy();

    await page.getByTestId('provider-select').selectOption(comfyOptionVal!);
    await page.getByTestId('generate-btn').click();

    await expect(page.locator('[data-testid^="dag-node-"]')).toHaveCount(3);
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(2);

    // 4. ComfyUI CORS / Network Abort Failure Hint
    comfyMode = 'cors-abort';
    await page.getByTestId('generate-btn').click();

    await expect(banner).toBeVisible();
    await expect(banner).toContainText('--enable-cors-header');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
