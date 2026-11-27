import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M38C: Agentic Asset Composer (Cmd+L), Visual Diff, Checkpoints & Inline Canvas Cmd+K', () => {
  test('plans & stages Gemini tool call via @goblin_scout, commits & restores Checkpoint, executes Inline Cmd+K, and persists across reload', async ({
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

    // 1. Configure Gemini BYOK in Provider Vault so intercepted endpoint is selectable
    await page.getByTestId('nav-provider-vault').click();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill('AIzaSyM38E2EKEY123');
    await page.getByTestId('vault-save-provider-btn').click();
    await page.getByTestId('close-vault-btn').click();

    // 2. Create Project, generate 1 sprite, and create goblin_scout Entity
    await page.getByTestId('new-project-name').fill('M38C Composer Dungeon');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('nav-entities').click();
    await expect(page.getByTestId('entity-hub-view')).toBeVisible();
    await page.getByTestId('entity-create-btn').click();
    await page.getByTestId('entity-name-input').fill('Goblin Scout');
    await expect(page.getByTestId('entity-slug-input')).toHaveValue('goblin_scout');
    await page.getByTestId('entity-save-btn').click();
    await expect(page.getByTestId('entity-card-goblin_scout')).toBeVisible();

    // 3. Intercept Gemini Function Calling endpoint
    await page.route('https://generativelanguage.googleapis.com/**', async (routeReq) => {
      await routeReq.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'add_or_move_socket',
                      args: {
                        targetSlug: 'goblin_scout',
                        socketName: 'cape_tip',
                        normX: 0.25,
                        normY: 0.72,
                        baseAngleDeg: 15,
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    // 4. Open Asset Composer via Control+L, select Gemini, @-autocomplete goblin_scout, stage diff
    await page.keyboard.press('Control+l');
    await expect(page.getByTestId('asset-composer-rail')).toBeVisible();
    const geminiOptionVal = await page
      .getByTestId('composer-provider-select')
      .locator('option', { hasText: 'Gemini' })
      .getAttribute('value');
    await page.getByTestId('composer-provider-select').selectOption(geminiOptionVal!);

    const composerInput = page.getByTestId('composer-prompt-input');
    await composerInput.fill('@goblin');
    await expect(page.getByTestId('composer-at-popover')).toBeVisible();
    await page.getByTestId('composer-at-option-goblin_scout').click();
    await expect(composerInput).toHaveValue(/@goblin_scout /);
    await composerInput.fill('@goblin_scout add cape_tip socket');
    await page.getByTestId('composer-submit-btn').click();

    await expect(page.getByTestId('staged-change-card')).toHaveCount(1);
    await expect(page.getByTestId('staged-change-card')).toContainText('cape_tip');

    // 5. Accept All -> commits change & records Checkpoint, then Restore reverts cleanly
    await page.getByTestId('composer-accept-all-btn').click();
    await expect(page.getByTestId('checkpoint-restore-btn')).toHaveCount(1);

    await page.getByTestId('checkpoint-restore-btn').click();
    await expect(page.getByTestId('checkpoint-restore-btn')).toHaveCount(0);

    // 6. Switch back to Offline Mock ($0.00), close Composer, focus Screen 4A canvas & trigger Inline Cmd+K
    await page.getByTestId('composer-provider-select').selectOption('offline-mock');
    await page.getByTestId('composer-close-btn').click();

    await page.getByTestId('nav-sprite-studio').click();
    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    await page.getByTestId('inspector-canvas-stage').focus();
    await page.keyboard.press('Control+k');
    await expect(page.getByTestId('inline-canvas-command')).toBeVisible();
    await page.getByTestId('inline-command-input').fill('repalette crimson outline');
    await page.getByTestId('inline-submit-btn').click();

    await expect(page.getByTestId('inline-staged-preview')).toBeVisible();
    await page.getByTestId('inline-accept-btn').click();
    await expect(page.getByTestId('inline-canvas-command')).toBeHidden();

    // 7. Hard reload preserves the committed Inline Checkpoint cleanly
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible({ timeout: 15000 });
    await page.keyboard.press('Control+l');
    await expect(page.getByTestId('asset-composer-rail')).toBeVisible();
    await expect(page.getByTestId('checkpoint-restore-btn')).toHaveCount(1);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
