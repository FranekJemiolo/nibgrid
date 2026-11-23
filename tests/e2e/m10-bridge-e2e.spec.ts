import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { encodeRgbaToPngBytes, uint8ToBase64 } from '../../src/processing/png';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

function makeSampleBridgePngB64(r: number, g: number, b: number): string {
  const rgba = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 16 * 16; i++) {
    rgba[i * 4] = r;
    rgba[i * 4 + 1] = g;
    rgba[i * 4 + 2] = b;
    rgba[i * 4 + 3] = 255;
  }
  return uint8ToBase64(encodeRgbaToPngBytes(rgba, 16, 16));
}

test.describe('M10 Antigravity Loopback Bridge & Critique Loop', () => {
  test('chains interaction_id across forks, surfaces critique delta, and redacts 401 diagnostics cleanly', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    const capturedAuthHeaders: string[] = [];
    const generatePayloads: Array<Record<string, unknown>> = [];
    let simulateUnauthorized = false;

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        // Ignore browser network error emitted when intentionally simulating HTTP 401
        if (!text.includes('401') && !text.includes('Failed to load resource')) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.route('http://127.0.0.1:4188/**', async (route) => {
      const req = route.request();
      const auth = req.headers()['authorization'] ?? '';
      if (auth) capturedAuthHeaders.push(auth);

      if (req.url().endsWith('/v1/health')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ok: true,
            version: '1.0.0',
            models: ['gemini-2.5-flash-image'],
            supportsStatefulInteractions: true,
          }),
        });
        return;
      }

      if (req.url().endsWith('/v1/generate')) {
        if (simulateUnauthorized) {
          await route.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'Token expired: nbg_test_token_999' }),
          });
          return;
        }
        const body = JSON.parse(req.postData() ?? '{}') as Record<string, unknown>;
        generatePayloads.push(body);
        const isFollowUp = Boolean(body.previousInteractionId);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            requestId: body.requestId,
            usedStatefulChain: isFollowUp,
            latencyMs: 42,
            variants: [
              {
                pngBase64: isFollowUp
                  ? makeSampleBridgePngB64(64, 210, 255)
                  : makeSampleBridgePngB64(220, 64, 64),
                width: 16,
                height: 16,
                interactionId: isFollowUp ? 'int_child_2' : 'int_root_1',
                interactionExpiresAt: '2099-01-01T00:00:00.000Z',
                modelId: 'gemini-2.5-flash-image',
              },
            ],
          }),
        });
        return;
      }

      if (req.url().endsWith('/v1/critique')) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            passed: false,
            score: 74,
            driftFlags: ['lighting_mismatch'],
            suggestedPromptDelta: 'shift key light strictly top-left and brighten sword rim',
            rationale: 'Rim highlight slightly diffused compared to top-left Art Bible key.',
          }),
        });
        return;
      }

      await route.fulfill({ status: 404, body: '{}' });
    });

    await page.goto('/');

    // 1. Add Antigravity Loopback Bridge in Provider Vault & test health
    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('provider-vault-modal')).toBeVisible();
    await page.getByTestId('vault-kind-select').selectOption('antigravity-bridge');
    await page.getByTestId('vault-api-key-input').fill('nbg_test_token_999');
    await expect(page.getByTestId('vault-session-only-toggle')).toBeChecked();
    await page.getByTestId('vault-save-provider-btn').click();

    const bridgeCard = page.locator('[data-testid^="provider-card-"]', {
      hasText: 'Google Antigravity Loopback Bridge',
    });
    await expect(bridgeCard).toBeVisible();
    await bridgeCard.locator('[data-testid^="test-provider-"]').click();
    await expect(bridgeCard.locator('[data-testid^="provider-test-status-"]')).toContainText(
      'Stateful Chains ON',
    );
    await page.getByTestId('close-vault-btn').click();

    // 2. Create project -> Studio -> select Bridge provider
    await page.getByTestId('new-project-name').fill('M10 Bridge Cat');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    const bridgeOption = await page
      .getByTestId('provider-select')
      .locator('option', { hasText: 'Google Antigravity Loopback Bridge' })
      .getAttribute('value');
    expect(bridgeOption).toBeTruthy();
    await page.getByTestId('provider-select').selectOption(bridgeOption!);
    await page.getByTestId('variant-count-select').selectOption('1');

    // 3. Root generation stores interactionId: "int_root_1" and runs critique
    await page.getByTestId('prompt-delta-input').fill('crimson warrior stance');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);
    expect(capturedAuthHeaders.every((h) => h === 'Bearer nbg_test_token_999')).toBe(true);
    expect(generatePayloads[0]?.previousInteractionId).toBeUndefined();

    // Verify critique score & 1-click "Apply Suggested Delta"
    await expect(page.getByTestId('bridge-critique-score')).toHaveText('74/100');
    await page.getByTestId('apply-suggested-delta-btn').click();
    await expect(page.getByTestId('prompt-delta-input')).toHaveValue(
      'shift key light strictly top-left and brighten sword rim',
    );
    await expect(page.getByTestId('bridge-chain-badge')).toContainText('int_root_1');

    // 4. Forked generation sends previousInteractionId: "int_root_1"
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(2);
    expect(generatePayloads[1]?.previousInteractionId).toBe('int_root_1');

    // 5. Simulate 401 unauthorized response and verify token redaction + DAG preservation
    simulateUnauthorized = true;
    await page.getByTestId('generate-btn').click();
    await expect(page.getByTestId('studio-error-banner')).toBeVisible();
    const errText = await page.getByTestId('studio-error-banner').textContent();
    expect(errText).not.toContain('nbg_test_token_999');
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(2);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
