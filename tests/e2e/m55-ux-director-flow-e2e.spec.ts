import { expect, test } from '@playwright/test';

test.describe('M55: Streamlined Director Navigation & Wired Creator/Pro Mode E2E', () => {
  test('opens Director Studio via header nav, wires Creator presets to ArtBible artMode, and binds Pro Mode sliders cleanly', async ({
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

    await page.getByTestId('new-project-name').fill('M55 UX Streamline');
    await page.getByTestId('create-project-btn').click();

    // Navigate to Director Studio from top header button
    await page.getByTestId('nav-director-studio').click();
    await expect(page.getByTestId('director-studio-view')).toBeVisible();

    // Navigate to Ship to Godot where ContextualInspector is mounted
    await page.getByTestId('nav-ship-godot').click();
    await expect(page.getByTestId('ship-godot-panel')).toBeVisible();

    // Click Cozy Hand-Drawn preset in Creator Mode -> updates artMode to hd-2d
    await page.getByTestId('creator-preset-cozy-handdrawn').click();

    // Switch to Pro Mode and adjust controlled Sobel bevel & RDP sliders
    await page.getByTestId('ux-mode-pro').click();
    const bevelSlider = page.getByTestId('pro-sobel-bevel-slider');
    const rdpSlider = page.getByTestId('pro-rdp-epsilon-slider');
    await expect(bevelSlider).toBeVisible();
    await expect(rdpSlider).toBeVisible();
    await expect(bevelSlider).toHaveValue('1.5');
    await expect(rdpSlider).toHaveValue('1.5');

    await bevelSlider.fill('3.25');
    await expect(bevelSlider).toHaveValue('3.25');

    // Verify Art Bible persisted hd-2d from Creator preset click
    await page.getByTestId('nav-art-bible').click();
    await expect(page.getByTestId('art-mode-select')).toHaveValue('hd-2d');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
