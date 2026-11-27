import { expect, test } from '@playwright/test';

test.describe('M37C: Vertical Slice Autopilot Wizard, Resumable DAG, Godot 4 main.tscn Sync & #share=', () => {
  test('drafts single-prompt slice, approves Golden Ref Gate, completes full DAG, syncs res://main.tscn, shares #share=, and persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Inject in-memory FileSystemDirectoryHandle stub across loads + reloads
    await page.addInitScript(() => {
      const files: Record<string, string> = {};
      const writes: string[] = [];

      const makeDir = (prefix: string) => ({
        name: prefix === '' ? 'nibgrid_slice_godot' : prefix.split('/').pop()!,
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
                  writes.push(fullPath);
                },
              };
            },
          };
        },
      });

      const rootHandle = makeDir('');
      (window as unknown as Record<string, unknown>).__nibgridWrittenFiles = writes;
      (window as unknown as Record<string, unknown>).__nibgridMockFsFiles = files;
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => rootHandle;
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // 1. Open Vertical Slice Autopilot from global header
    await page.getByTestId('nav-vertical-slice-btn').click();
    await expect(page.getByTestId('vertical-slice-wizard')).toBeVisible();

    // 2. Fill single prompt, select Instant Draft ($0.00), verify cost badge & draft + lock style
    await page
      .getByTestId('slice-prompt-input')
      .fill(
        '16-bit gothic platformer: armored knight hero, 2 skeleton enemies, crypt stone tileset, moonlit parallax, gothic HUD, and a boss arena',
      );
    await page.getByTestId('slice-tier-select').selectOption('instant-draft');
    await expect(page.getByTestId('slice-cost-badge')).toContainText('$0.00');
    await page.getByTestId('slice-draft-btn').click();

    // 3. Golden Reference Approval Gate pauses before fan-out
    await expect(page.getByTestId('slice-anchor-gate')).toBeVisible({ timeout: 15000 });
    await expect(page.getByTestId('slice-node-golden_ref_hero')).toHaveAttribute(
      'data-status',
      'awaiting-approval',
    );

    // 4. Approve style & fan out full parallel DAG to completion
    await page.getByTestId('slice-approve-fanout-btn').click();
    await expect(page.getByTestId('slice-completion-bar')).toBeVisible({ timeout: 30000 });
    await expect(page.getByTestId('slice-node-main_scene')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('slice-node-room_level')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('slice-node-ui_theme')).toHaveAttribute('data-status', 'done');
    await expect(page.getByTestId('slice-node-visual_qa')).toHaveAttribute('data-status', 'done');

    // 5. Sync complete Godot 4 res:// tree via FSAA stub
    await page.getByTestId('slice-sync-godot-btn').click();
    await expect(page.getByTestId('slice-sync-status')).toBeVisible({ timeout: 15000 });

    const writtenPaths = await page.evaluate(() => {
      return (window as unknown as { __nibgridWrittenFiles: string[] }).__nibgridWrittenFiles;
    });
    expect(writtenPaths).toContain('main.tscn');
    expect(writtenPaths.some((p) => /^levels\/.*\.tscn$/.test(p))).toBe(true);
    expect(writtenPaths.some((p) => /^entities\/[^/]+\/[^/]+\.tscn$/.test(p))).toBe(true);
    expect(writtenPaths.some((p) => /^ui\/.*_theme\.tres$/.test(p))).toBe(true);
    expect(writtenPaths.some((p) => /^tiles\/.*_tileset\.tres$/.test(p))).toBe(true);
    expect(writtenPaths.some((p) => /^parallax\/.*_parallax\.tscn$/.test(p))).toBe(true);

    // 6. Export zero-server #share= recipe link
    await page.getByTestId('slice-share-btn').click();
    await expect(page.getByTestId('share-outgoing-panel')).toBeVisible();
    await expect(page.getByTestId('share-hash-url-output')).toHaveValue(/#share=v1\./);
    await page.getByTestId('share-close-btn').click();

    // 7. Hard reload preserves completed DAG in Dexie IndexedDB
    await page.reload();
    await page.getByTestId('nav-vertical-slice-btn').click();
    await expect(page.getByTestId('slice-completion-bar')).toBeVisible({ timeout: 10000 });
    await expect(page.getByTestId('slice-node-main_scene')).toHaveAttribute('data-status', 'done');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
