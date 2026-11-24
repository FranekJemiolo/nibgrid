import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M25C: Entity Hub, Live res:// Sync & Godot 4 .tscn Prefab Assembler', () => {
  test('creates goblin_scout Entity, previews .tscn, syncs via FSAA stub with 0-write repeat sync, and persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Inject in-memory FileSystemDirectoryHandle stub before navigation & reloads
    await page.addInitScript(() => {
      const files: Record<string, string> = {};
      const writes: string[] = [];

      const makeDir = (prefix: string) => ({
        name: prefix === '' ? 'my_godot_rpg' : prefix.split('/').pop()!,
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
        folderName: 'my_godot_rpg',
        writes,
        files,
      };
      (window as unknown as Record<string, unknown>).showDirectoryPicker = async () => rootHandle;
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // 1. Seed Project, Sprite, M16 Collider, M21 Socket, and M14 Procedural Audio
    await page.getByTestId('new-project-name').fill('M25C Godot Foundry');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await page.getByTestId('pp-resample-toggle').check();
    await page.getByTestId('pp-preset-64').click();
    await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');

    // Auto-trace M16 Collider
    await page.getByTestId('inspector-tab-collider').click();
    await expect(page.getByTestId('collider-editor')).toBeVisible();
    await page.getByTestId('collider-box2d-preset-btn').click();
    await expect(page.getByTestId('collider-poly-collider')).toBeVisible();

    // Bind M21 hand_r Socket and save SpriteNode
    await page.getByTestId('inspector-tab-sockets').click();
    await expect(page.getByTestId('socket-editor-panel')).toBeVisible();
    await page.getByTestId('socket-preset-hand_r').click();
    await page.getByTestId('socket-save-btn').click();
    await expect(page.getByTestId('socket-save-notice')).toContainText('Saved 1 attachment socket');

    // Generate & save 1 procedural audio clip in Audio Foundry
    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.getByTestId('audio-foundry')).toBeVisible();
    await page.getByTestId('audio-preset-sfx-sprite-impact').click();
    await page.getByTestId('audio-route-select').selectOption('local-synth');
    await expect(page.getByTestId('audio-output-lufs')).toContainText('-');
    await page.getByTestId('audio-clip-name-input').fill('Goblin Slash');
    await page.getByTestId('audio-save-btn').click();
    await expect(page.getByTestId('audio-saved-list')).toContainText('Goblin Slash');

    // 2. Open Entities Hub & create goblin_scout CharacterBody2D Entity
    await page.getByTestId('nav-entities').click();
    await expect(page.getByTestId('entity-hub-view')).toBeVisible();
    await page.getByTestId('entity-create-btn').click();
    await expect(page.getByTestId('entity-editor-drawer')).toBeVisible();

    await page.getByTestId('entity-name-input').fill('Goblin Scout');
    await expect(page.getByTestId('entity-slug-input')).toHaveValue('goblin_scout');
    await page.getByTestId('entity-body-type-select').selectOption('CharacterBody2D');

    // Bind the saved audio clip
    const audioCheckbox = page.locator('[data-testid^="entity-audio-checkbox-"]').first();
    await audioCheckbox.check();

    // Preview generated .tscn tree before saving
    await page.getByTestId('entity-tab-tscn').click();
    const tscnPreview = page.getByTestId('entity-tscn-preview');
    await expect(tscnPreview).toContainText('[node name="GoblinScout" type="CharacterBody2D"]');
    await expect(tscnPreview).toContainText('CollisionPolygon2D');
    await expect(tscnPreview).toContainText(
      '[node name="hand_r" type="Marker2D" parent="Sockets"]',
    );
    await expect(tscnPreview).toContainText('[node name="SfxPlayer" type="AudioStreamPlayer2D"');

    await page.getByTestId('entity-save-btn').click();
    await expect(page.getByTestId('entity-card-goblin_scout')).toBeVisible();
    await expect(
      page.getByTestId('entity-coverage-goblin_scout').locator('[data-covered="true"]'),
    ).toHaveCount(4); // Sprite, Collider, Sockets, Audio

    // 3. Bind Godot res:// directory and perform Sync 1
    await page.getByTestId('godot-bind-btn').click();
    await expect(page.getByTestId('godot-sync-pill-btn')).toContainText('res://my_godot_rpg');

    await page.getByTestId('godot-sync-pill-btn').click();
    await expect(page.getByTestId('godot-sync-popover')).toBeVisible();
    await expect(page.getByTestId('sync-diff-added-list')).toContainText('goblin_scout.tscn');
    await expect(page.getByTestId('sync-diff-added-list')).toContainText(
      'goblin_scout_frames.tres',
    );
    await expect(page.getByTestId('sync-diff-added-list')).toContainText('goblin_scout_anims.tres');
    await expect(page.getByTestId('sync-diff-added-list')).toContainText('goblin_scout.png.import');
    await expect(page.getByTestId('sync-diff-added-list')).toContainText('.wav');

    await page.getByTestId('godot-sync-confirm-btn').click();
    await expect(page.getByTestId('godot-sync-status')).toContainText('Synced');

    const fsAfterFirst = await page.evaluate(() => {
      const m = (window as unknown as Record<string, unknown>).__nibgridMockFs as {
        writes: string[];
        files: Record<string, string>;
      };
      return { writeCount: m.writes.length, files: m.files };
    });
    expect(fsAfterFirst.writeCount).toBeGreaterThanOrEqual(6);
    expect(fsAfterFirst.files['assets/nibgrid/goblin_scout/goblin_scout.png.import']).toContain(
      'compress/mode=0',
    );
    expect(fsAfterFirst.files['assets/nibgrid/goblin_scout/goblin_scout.tscn']).toContain(
      'CharacterBody2D',
    );

    // 4. Repeat Sync 2 without changes -> 0 files changed & 0 new disk writes
    await expect(page.getByTestId('sync-diff-summary')).toContainText('0 files changed');
    await page.getByTestId('godot-sync-confirm-btn').click();
    await expect(page.getByTestId('godot-sync-status')).toContainText('0 files changed');

    const writeCountAfterSecond = await page.evaluate(() => {
      const m = (window as unknown as Record<string, unknown>).__nibgridMockFs as {
        writes: string[];
      };
      return m.writes.length;
    });
    expect(writeCountAfterSecond).toBe(fsAfterFirst.writeCount);

    // 5. Hard reload -> verify entity + sync target persist cleanly and 0 orphan blobs exist
    await page.reload();
    await expect(page.getByTestId('entity-card-goblin_scout')).toBeVisible();
    await expect(page.getByTestId('godot-sync-pill-btn')).toContainText('res://my_godot_rpg');

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
            }>) {
              refs.add(n.imageBlobId);
              if (n.maskBlobId) refs.add(n.maskBlobId);
              if (n.processedBlobId) refs.add(n.processedBlobId);
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
