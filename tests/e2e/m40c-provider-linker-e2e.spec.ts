import { expect, test } from '@playwright/test';

test.describe('M40C: Pluggable ModelRouter, Google Antigravity Auto-Linker & Offline Fallback E2E', () => {
  test('links Antigravity MCP via host bridge, shows Offline Mock fallback, persists routing profiles across reload with zero leaks', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Inject mock Extension Host / Desktop bridge cleanly before navigation & reloads
    await page.addInitScript(() => {
      (window as unknown as Record<string, unknown>).__nibgridHostBridge = {
        hostKind: 'nibgrid-desktop',
        antigravity: {
          detectAntigravity: async () => ({ detected: false, configDir: '~/.gemini/config' }),
          linkAntigravityMcp: async () => ({
            ok: true,
            configPath: '~/.gemini/config/mcp_config.json',
            backupPath: '~/.gemini/config/mcp_config.json.bak.2026-11-27T12-00-00-000Z',
            message: 'Linked nibgrid MCP server cleanly to ~/.gemini/config/mcp_config.json',
          }),
        },
      };
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // 1. Open Models & Providers settings panel from header
    await page.getByTestId('nav-models-btn').click();
    await expect(page.getByTestId('model-providers-panel')).toBeVisible();
    await expect(page.getByTestId('task-routing-table')).toBeVisible();

    // 2. Verify external daemons unreachable -> resolves cleanly to Offline Mock ($0.00)
    await page.getByTestId('ping-providers-btn').click();
    await expect(page.getByTestId('resolved-route-planning-composer')).toContainText(
      'Offline Procedural / Mock',
    );
    await expect(page.getByTestId('resolved-route-vision-qa')).toContainText(
      'Offline Procedural / Mock',
    );

    // 3. Configure per-task route & trigger 1-click Link Google Antigravity
    await page.getByTestId('route-select-planning-composer').selectOption('ollama-local');
    await page.getByTestId('link-antigravity-btn').click();
    await expect(page.getByTestId('antigravity-link-status')).toContainText(
      '~/.gemini/config/mcp_config.json',
    );
    await expect(page.getByTestId('antigravity-link-status')).toContainText('.bak.');

    // Verify no accidental secret token pattern exists in localStorage routing config
    const storedRouting = await page.evaluate(() =>
      window.localStorage.getItem('nibgrid.modelRouter.v1'),
    );
    expect(storedRouting).toContain('ollama-local');
    expect(storedRouting ?? '').not.toMatch(/AIza|sk-|nbg_/);

    // 4. Hard reload persists ModelRouter routing selections cleanly
    await page.reload();
    await page.getByTestId('nav-models-btn').click();
    await expect(page.getByTestId('route-select-planning-composer')).toHaveValue('ollama-local');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
