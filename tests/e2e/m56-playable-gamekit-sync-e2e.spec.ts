import { expect, test } from '@playwright/test';

test.describe('M56–M59: Director-First Path, Playable GameKit, Ownership Sync & Delta Pull E2E', () => {
  test('navigates Director-first workspace, builds playable F5 GameKit, preserves customized scaffold on re-sync, and pulls .nibgrid_sync_delta.json', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.addInitScript(() => {
      const files: Record<string, string> = {};
      const makeDir = (prefix: string) => ({
        name: prefix === '' ? 'm56_godot_res' : prefix.split('/').pop()!,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getDirectoryHandle: async (segment: string) =>
          makeDir(prefix === '' ? segment : `${prefix}/${segment}`),
        getFileHandle: async (filename: string, opts?: { create?: boolean }) => {
          const fullPath = prefix === '' ? filename : `${prefix}/${filename}`;
          if (opts?.create === false && !(fullPath in files)) {
            throw new Error(`File not found: ${fullPath}`);
          }
          let chunks: Uint8Array[] = [];
          return {
            name: filename,
            createWritable: async () => {
              chunks = [];
              return {
                write: async (data: BufferSource | Blob | string) => {
                  if (typeof data === 'string') {
                    chunks.push(new TextEncoder().encode(data));
                  } else if (data instanceof Blob) {
                    chunks.push(new Uint8Array(await data.arrayBuffer()));
                  } else if (ArrayBuffer.isView(data)) {
                    chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
                  } else {
                    chunks.push(new Uint8Array(data));
                  }
                },
                close: async () => {
                  const total = chunks.reduce((sum, c) => sum + c.byteLength, 0);
                  const combined = new Uint8Array(total);
                  let off = 0;
                  for (const c of chunks) {
                    combined.set(c, off);
                    off += c.byteLength;
                  }
                  files[fullPath] = new TextDecoder().decode(combined);
                },
              };
            },
            getFile: async () => {
              const textVal = files[fullPath] ?? '';
              return {
                size: new TextEncoder().encode(textVal).byteLength,
                text: async () => textVal,
              };
            },
          };
        },
        removeEntry: async (name: string) => {
          const fullPath = prefix === '' ? name : `${prefix}/${name}`;
          delete files[fullPath];
        },
      });
      (window as unknown as Record<string, unknown>).__m56MockFs = files;
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => makeDir('');
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M56 Playable Saga');
    await page.getByTestId('create-project-btn').click();

    // Workspace 1 defaults straight to Director Studio + shows GamePipelineRibbon
    await page.getByTestId('workspace-tab-style-vision').click();
    await expect(page.getByTestId('director-studio-view')).toBeVisible();
    await expect(page.getByTestId('game-pipeline-ribbon')).toBeVisible();

    await page.getByTestId('director-scope-select').selectOption('multi-room-dungeon');
    await page.getByTestId('director-tier-select').selectOption('instant-draft');
    await page.getByTestId('director-start-btn').click();
    await expect(page.getByTestId('director-anchor-gate')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('director-approve-build-btn').click();
    await expect(page.getByTestId('director-completion-bar')).toBeVisible({ timeout: 30000 });

    // Jump to Ship to Godot via Workspace 4
    await page.getByTestId('workspace-tab-ship-godot').click();
    await expect(page.getByTestId('ship-godot-panel')).toBeVisible();
    await expect(page.getByTestId('ship-headless-check-box')).toBeVisible();
    await expect(page.getByTestId('ship-preserve-scaffolds-toggle')).toBeChecked();

    await page.getByTestId('ship-sync-gamekit-btn').click();
    await expect(page.getByTestId('ship-status-notice')).toContainText('Synced Turnkey GameKit');

    const syncedFiles = await page.evaluate(
      () => (window as unknown as Record<string, Record<string, string>>).__m56MockFs!,
    );
    expect(syncedFiles['scripts/runtime/PlayerController.gd']).toContain('NibgridPlayerController');
    expect(syncedFiles['scripts/runtime/EnemyAiController.gd']).toContain(
      'NibgridEnemyAiController',
    );
    expect(syncedFiles['scripts/runtime/NpcController.gd']).toContain('NibgridNpcController');
    expect(syncedFiles['scripts/runtime/SaveManager.gd']).toContain('NibgridSaveManager');
    expect(syncedFiles['scripts/GameShell.gd']).toContain('_on_portal_body_entered');

    // Simulate user editing GameShell.gd on disk AND exporting .nibgrid_sync_delta.json from Godot
    await page.evaluate(() => {
      const fs = (window as unknown as Record<string, Record<string, string>>).__m56MockFs!;
      fs['scripts/GameShell.gd'] = 'extends Node2D\n# CUSTOM USER HOOK PRESERVED';
      fs['.nibgrid_sync_delta.json'] = JSON.stringify({
        version: 1,
        updatedAt: 123456,
        entityStatOverrides: [{ slug: 'armored_knight', moveSpeedPx: 215, attackDamage: 32 }],
        roomSpawnOverrides: [],
      });
    });

    // Re-sync with Preserve User Scaffolds enabled -> user GameShell.gd stays untouched
    await page.getByTestId('ship-sync-gamekit-btn').click();
    const afterResync = await page.evaluate(
      () => (window as unknown as Record<string, Record<string, string>>).__m56MockFs!,
    );
    expect(afterResync['scripts/GameShell.gd']).toContain('CUSTOM USER HOOK PRESERVED');

    // Pull Godot Tweaks directly in UI
    await page.getByTestId('ship-pull-delta-btn').click();
    await expect(page.getByTestId('ship-delta-status')).toContainText('1 entity(s)');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
