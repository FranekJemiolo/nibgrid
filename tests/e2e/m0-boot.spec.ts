import { expect, test } from '@playwright/test';

test.describe('M0 Boot Smoke Test', () => {
  test('renders Nibgrid dark studio shell without console or page errors', async ({ page }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    page.on('pageerror', (err) => {
      pageErrors.push(err.message);
    });

    await page.goto('/');

    await expect(page.getByTestId('app-header')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Nibgrid' })).toBeVisible();
    await expect(page.getByTestId('nav-projects')).toBeVisible();
    await expect(page.getByTestId('nav-provider-vault')).toBeVisible();
    await expect(page.getByTestId('projects-shell')).toBeVisible();

    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('vault-shell')).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
