import { expect, test } from '@playwright/test';

test.describe('M49: 4-Workspace Navigation, Creator/Pro Mode Toggle & 1-Click Fix-It Cards E2E', () => {
  test('hides technical panels in Creator Mode, reveals them in Pro Mode, applies a Fix-It Card, and persists across reload', async ({
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

    await page.getByTestId('new-project-name').fill('M49 Streamlined Studio');
    await page.getByTestId('create-project-btn').click();

    // 4 Workspace tabs visible
    await expect(page.getByTestId('workspace-tab-style-vision')).toBeVisible();
    await expect(page.getByTestId('workspace-tab-cast-world')).toBeVisible();
    await expect(page.getByTestId('workspace-tab-play-tune')).toBeVisible();
    await expect(page.getByTestId('workspace-tab-ship-godot')).toBeVisible();

    // Create a missing-glyph condition in Dialogue & L10n
    await page.getByTestId('nav-dialogue-l10n').click();
    await page.getByTestId('dialogue-new-node-id').fill('guard_warn');
    await page.getByTestId('dialogue-new-node-text-key').fill('DLG_GUARD_WARN_01');
    await page.getByTestId('dialogue-new-node-en-text').fill('Halt!');
    await page.getByTestId('dialogue-new-node-pl-text').fill('Stój, wędrowcze!');
    await page.getByTestId('dialogue-new-node-de-text').fill('Halt!');
    await page.getByTestId('dialogue-add-node-btn').click();

    // Switch to Workspace 4: Ship to Godot in default Creator Mode
    await page.getByTestId('workspace-tab-ship-godot').click();
    await expect(page.getByTestId('ship-godot-panel')).toBeVisible();
    await expect(page.getByTestId('creator-mode-hint')).toBeVisible();
    await expect(page.getByTestId('pro-raw-shader-panel')).toBeHidden();
    await expect(page.getByTestId('pro-rdp-epsilon-slider')).toBeHidden();

    // Switch to Pro Mode and confirm granular panels appear
    await page.getByTestId('ux-mode-pro').click();
    await expect(page.getByTestId('pro-raw-shader-panel')).toBeVisible();
    await expect(page.getByTestId('pro-rdp-epsilon-slider')).toBeVisible();

    // Click the Missing Glyph Fix-It Card to fix it in 1 click
    await expect(page.getByTestId('fixit-card-missing-glyphs')).toBeVisible();
    await page.getByTestId('fixit-apply-missing-glyphs').click();
    await expect(page.getByTestId('fixit-card-missing-glyphs')).toBeHidden();

    // Reload and confirm Pro mode + resolved Fix-It state persist cleanly
    await page.reload();
    await expect(page.getByTestId('ship-godot-panel')).toBeVisible();
    await expect(page.getByTestId('pro-raw-shader-panel')).toBeVisible();
    await expect(page.getByTestId('fixit-card-missing-glyphs')).toBeHidden();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
