import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M44C: Interactive WebGL2 LightingBakerPanel, CanvasTexture Sync & Zero Orphan Blobs', () => {
  test('bakes normal/emission maps with interactive PointLight2D, syncs _n.png/_n.png.import/_canvas.tres, and persists across reload', async ({
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
      const writes: string[] = [];

      const makeDir = (prefix: string) => ({
        name: prefix === '' ? 'my_godot_lit' : prefix.split('/').pop()!,
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
      (window as unknown as Record<string, unknown>).__nibgridMockFs = {
        writes,
        files,
      };
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => rootHandle;
    });

    await page.setViewportSize({ width: 1280, height: 820 });
    await page.goto('/');

    // 1. Seed Project, Sprite & goblin_scout Entity
    await page.getByTestId('new-project-name').fill('M44C Lighting Project');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-resample-toggle').check();
    await page.getByTestId('pp-preset-64').click();
    await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');

    await page.getByTestId('nav-entities').click();
    await page.getByTestId('entity-create-btn').click();
    await page.getByTestId('entity-name-input').fill('Goblin Scout');
    await expect(page.getByTestId('entity-slug-input')).toHaveValue('goblin_scout');
    await page.getByTestId('entity-save-btn').click();
    await expect(page.getByTestId('entity-card-goblin_scout')).toBeVisible();

    // 2. Open Lighting Baker on goblin_scout -> drag PointLight2D -> adjust Strength -> Normal channel
    await page.getByTestId('entity-lighting-goblin_scout').click();
    await expect(page.getByTestId('lighting-baker-panel')).toBeVisible();

    const stageBox = await page.getByTestId('lighting-baker-stage').boundingBox();
    expect(stageBox).not.toBeNull();
    await page.mouse.move(
      stageBox!.x + stageBox!.width * 0.25,
      stageBox!.y + stageBox!.height * 0.25,
    );
    await page.mouse.down();
    await page.mouse.move(
      stageBox!.x + stageBox!.width * 0.72,
      stageBox!.y + stageBox!.height * 0.68,
    );
    await page.mouse.up();

    const strengthPill = page.getByTestId('lighting-strength-input');
    await strengthPill.dblclick();
    const strengthEdit = page.getByTestId('lighting-strength-input-input');
    await strengthEdit.fill('2.5');
    await strengthEdit.press('Enter');
    await expect(strengthPill).toHaveAttribute('data-value', '2.5');

    await page.getByTestId('lighting-channel-normal').click();
    await expect
      .poll(async () =>
        page.getByTestId('lighting-baker-canvas').evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const gl = canvas.getContext('webgl2');
          if (gl) {
            const buf = new Uint8Array(4 * 4 * 4);
            gl.readPixels(
              Math.floor(canvas.width / 2),
              Math.floor(canvas.height / 2),
              4,
              4,
              gl.RGBA,
              gl.UNSIGNED_BYTE,
              buf,
            );
            return canvas.width > 0 && canvas.height > 0 && buf.some((v) => v > 0);
          }
          const ctx = canvas.getContext('2d');
          const img = ctx?.getImageData(0, 0, canvas.width, canvas.height);
          return Boolean(img && img.data.some((v) => v > 0));
        }),
      )
      .toBe(true);

    // 3. Bake & Attach atomically -> close modal
    await page.getByTestId('lighting-bake-attach-btn').click();
    await expect(page.getByTestId('lighting-bake-status')).toContainText('goblin_scout_n.png');
    await expect(page.getByTestId('lighting-persisted-badge')).toBeVisible();
    await page.getByTestId('lighting-baker-close-btn').click();
    await expect(page.getByTestId('lighting-baker-panel')).toBeHidden();

    // 4. Bind FSAA mock folder and trigger M25 res:// Sync
    await page.getByTestId('godot-bind-btn').click();
    await page.getByTestId('godot-sync-pill-btn').click();
    await page.getByTestId('godot-sync-confirm-btn').click();
    await expect(page.getByTestId('godot-sync-status')).toContainText('Synced');

    const syncedFiles = await page.evaluate(() => {
      const m = (window as unknown as Record<string, unknown>).__nibgridMockFs as {
        files: Record<string, string>;
      };
      return m.files;
    });
    expect(syncedFiles['assets/nibgrid/goblin_scout/goblin_scout_n.png']).toBeTruthy();
    expect(syncedFiles['assets/nibgrid/goblin_scout/goblin_scout_n.png.import']).toContain(
      'compress/normal_map=1',
    );
    expect(syncedFiles['assets/nibgrid/goblin_scout/goblin_scout_canvas.tres']).toContain(
      'type="CanvasTexture"',
    );
    expect(syncedFiles['assets/nibgrid/goblin_scout/goblin_scout_canvas.tres']).toContain(
      'texture_filter = 1',
    );

    // 5. Hard reload -> confirm baked state persists cleanly and zero orphan blobs exist
    await page.reload();
    await expect(page.getByTestId('entity-card-goblin_scout')).toBeVisible();
    await page.getByTestId('entity-lighting-goblin_scout').click();
    await expect(page.getByTestId('lighting-persisted-badge')).toBeVisible();

    const orphanCount = await page.evaluate(async () => {
      const openReq = indexedDB.open('nibgrid-db');
      return new Promise<number>((res, rej) => {
        openReq.onerror = () => rej(openReq.error);
        openReq.onsuccess = () => {
          const idb = openReq.result;
          const tx = idb.transaction(
            ['projects', 'spriteNodes', 'audioAssets', 'blobs'],
            'readonly',
          );
          const allProjects = tx.objectStore('projects').getAll();
          const allNodes = tx.objectStore('spriteNodes').getAll();
          const allAudio = tx.objectStore('audioAssets').getAll();
          const allBlobKeys = tx.objectStore('blobs').getAllKeys();
          tx.oncomplete = () => {
            const refs = new Set<string>();
            for (const p of allProjects.result as Array<{
              artBible: { goldenReferenceBlobIds: string[] };
            }>) {
              for (const id of p.artBible.goldenReferenceBlobIds) refs.add(id);
            }
            for (const n of allNodes.result as Array<{
              imageBlobId: string;
              maskBlobId?: string;
              processedBlobId?: string;
              lightingBake?: { normalBlobId?: string; emissionBlobId?: string };
            }>) {
              refs.add(n.imageBlobId);
              if (n.maskBlobId) refs.add(n.maskBlobId);
              if (n.processedBlobId) refs.add(n.processedBlobId);
              if (n.lightingBake?.normalBlobId) refs.add(n.lightingBake.normalBlobId);
              if (n.lightingBake?.emissionBlobId) refs.add(n.lightingBake.emissionBlobId);
            }
            for (const a of allAudio.result as Array<{
              wavBlobId: string;
              variationBlobIds: string[];
            }>) {
              refs.add(a.wavBlobId);
              for (const v of a.variationBlobIds) refs.add(v);
            }
            const orphans = (allBlobKeys.result as string[]).filter((k) => !refs.has(k));
            idb.close();
            res(orphans.length);
          };
        };
      });
    });
    expect(orphanCount).toBe(0);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
