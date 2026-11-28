import { expect, test } from '@playwright/test';

test.describe('M54: Director Verbs in Asset Composer (Cmd+L), Visual Diffs & Checkpoints E2E', () => {
  test('executes Director Verbs (create enemy, add dialogue, autofix preflight) via Offline Mock Agent, commits & restores cleanly', async ({
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

    await page.getByTestId('new-project-name').fill('M54 Director Composer');
    await page.getByTestId('create-project-btn').click();

    await page.keyboard.press('Control+l');
    await expect(page.getByTestId('asset-composer-rail')).toBeVisible();

    const promptInput = page.getByTestId('composer-prompt-input');
    await promptInput.fill('create enemy frost_bat');
    await page.getByTestId('composer-submit-btn').click();
    await expect(page.getByTestId('staged-change-card')).toHaveCount(1);
    await expect(page.getByTestId('staged-change-card')).toContainText('frost_bat');

    await page.getByTestId('composer-accept-all-btn').click();
    await expect(page.getByTestId('checkpoint-restore-btn')).toHaveCount(1);

    // Navigate to Entities and verify frost_bat was created
    await page.getByTestId('nav-entities').click();
    await expect(page.getByTestId('entity-card-frost_bat')).toBeVisible();

    // Author localized dialogue + autofix preflight in one Composer turn
    await promptInput.fill(
      'add dialogue node gate_warn "Halt, frost bats ahead!" and autofix preflight',
    );
    await page.getByTestId('composer-submit-btn').click();
    await expect(page.getByTestId('staged-change-card')).toHaveCount(2);
    await page.getByTestId('composer-accept-all-btn').click();
    await expect(page.getByTestId('checkpoint-restore-btn')).toHaveCount(2);

    // Restore latest checkpoint cleanly
    await page.getByTestId('checkpoint-restore-btn').first().click();
    await expect(page.getByTestId('checkpoint-restore-btn')).toHaveCount(1);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
