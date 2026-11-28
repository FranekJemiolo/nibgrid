import { expect, test } from '@playwright/test';

test.describe('M53: Director Studio Workspace & Full-Game Reactive Autopilot E2E', () => {
  test('launches from ProjectHub into Director Studio, builds 3-Room Dungeon GameKit, validates 0 broken refs, syncs res://, and persists across reload', async ({
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
        name: prefix === '' ? 'm53_director_godot' : prefix.split('/').pop()!,
        queryPermission: async () => 'granted',
        requestPermission: async () => 'granted',
        getDirectoryHandle: async (segment: string) =>
          makeDir(prefix === '' ? segment : `${prefix}/${segment}`),
        getFileHandle: async (filename: string) => {
          const fullPath = prefix === '' ? filename : `${prefix}/${filename}`;
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
          };
        },
      });
      (window as unknown as Record<string, unknown>).__m53MockFs = files;
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => makeDir('');
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    await page.getByTestId('new-project-name').fill('M53 Director Saga');
    await page.getByTestId('hub-director-studio-btn').click();
    await expect(page.getByTestId('director-studio-view')).toBeVisible();

    await page.getByTestId('director-scope-select').selectOption('multi-room-dungeon');
    await page.getByTestId('director-tier-select').selectOption('instant-draft');
    await page.getByTestId('director-start-btn').click();

    await expect(page.getByTestId('director-anchor-gate')).toBeVisible({ timeout: 15000 });
    await page.getByTestId('director-approve-build-btn').click();

    await expect(page.getByTestId('director-completion-bar')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('director-node-world_graph')).toHaveAttribute(
      'data-status',
      'done',
    );
    await expect(page.getByTestId('director-node-self_heal_qa')).toHaveAttribute(
      'data-status',
      'done',
    );
    await expect(page.getByTestId('director-node-gamekit_bundle')).toHaveAttribute(
      'data-status',
      'done',
    );
    await expect(page.getByTestId('director-integrity-badge')).toContainText(
      '0 broken res:// refs',
    );

    await page.getByTestId('director-sync-godot-btn').click();
    await expect(page.getByTestId('director-sync-status')).toBeVisible({ timeout: 15000 });

    const syncedFiles = await page.evaluate(
      () => (window as unknown as { __m53MockFs: Record<string, string> }).__m53MockFs,
    );
    expect(syncedFiles['project.godot']).toContain('run/main_scene="res://main.tscn"');
    expect(syncedFiles['world/WorldTransitionManager.gd']).toBeTruthy();
    expect(syncedFiles['data/schemas/EnemyStatData.gd']).toBeTruthy();
    expect(syncedFiles['localization/strings.csv']).toBeTruthy();
    expect(syncedFiles['addons/nibgrid_sync/plugin.cfg']).toContain('Nibgrid Live Sync');

    await page.reload();
    await expect(page.getByTestId('director-studio-view')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('director-completion-bar')).toBeVisible();

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
