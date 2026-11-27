import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const DUMMY_GEMINI_KEY = 'AIzaSyE2EROOMTESTKEY';

test.describe('M35C: Godot 4 TileMapLayer Room & Encounter Prototyper (Screen 4P)', () => {
  test('generates 24x14 Gemini room, paints solid tiles & moves PlayerSpawn, exports secret-free ZIP, syncs via FSAA stub & persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // Inject in-memory FileSystemDirectoryHandle stub for M25 res:// sync
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

    // Intercept Gemini Flash JSON room generation
    let geminiCalled = false;
    const mockedGridRows = Array.from({ length: 14 }, (_, y) => {
      if (y === 0 || y === 13) return '1'.repeat(24);
      if (y === 9) return '100222200000000002222001';
      return `1${'0'.repeat(22)}1`;
    });

    await page.route('**/models/*:generateContent**', async (routeReq) => {
      geminiCalled = true;
      await routeReq.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      slug: 'crypt_boss_hall',
                      displayName: 'Crypt Boss Hall',
                      gridRows: mockedGridRows,
                      playerSpawn: { cellX: 2, cellY: 12 },
                      entities: [
                        { entitySlug: 'goblin_scout', cellX: 11, cellY: 12, facing: 'left' },
                        { entitySlug: 'treasure_chest', cellX: 18, cellY: 8, facing: 'right' },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // 1. Add Gemini Provider in Vault
    await page.getByTestId('nav-provider-vault').click();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill(DUMMY_GEMINI_KEY);
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Gemini Multimodal BYOK' }),
    ).toBeVisible();
    await page.getByTestId('close-vault-btn').click();

    // 2. Create Project & Sprite Node
    await page.getByTestId('new-project-name').fill('M35C Dungeon Room Lab');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Classify as tile so Room Builder shows cleanly in primary tabs
    await page.getByTestId('inspector-asset-class-select').selectOption('tile');
    await page.getByTestId('inspector-tab-room').click();
    await expect(page.getByTestId('room-workshop-panel')).toBeVisible();

    // 3. Generate Room via intercepted Gemini Flash provider
    const geminiOption = page
      .getByTestId('room-provider-select')
      .locator('option', { hasText: 'Gemini Multimodal BYOK' });
    const geminiVal = await geminiOption.getAttribute('value');
    expect(geminiVal).toBeTruthy();
    await page.getByTestId('room-provider-select').selectOption(geminiVal!);
    await expect(page.getByTestId('room-cost-badge')).toContainText('~$0.001');

    await page.getByTestId('room-prompt-input').fill('Boss crypt hall with two raised platforms');
    await page.getByTestId('room-generate-btn').click();
    await expect.poll(() => geminiCalled).toBe(true);

    await expect(page.getByTestId('room-stats-bar')).toContainText('24×14');
    await expect(page.getByTestId('room-stats-bar')).toContainText('72 solid');
    await expect(page.getByTestId('room-stats-bar')).toContainText('2 entities');

    // 4. Paint 3 solid cells on empty interior coordinates and move PlayerSpawn
    const canvas = page.getByTestId('room-editor-canvas');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const clickCell = async (cx: number, cy: number) => {
      const px = box!.x + ((cx + 0.5) / 24) * box!.width;
      const py = box!.y + ((cy + 0.5) / 14) * box!.height;
      await page.mouse.click(px, py);
    };

    await page.getByTestId('room-tool-solid').click();
    await clickCell(10, 6);
    await clickCell(11, 6);
    await clickCell(12, 6);
    await expect(page.getByTestId('room-stats-bar')).toContainText('75 solid');

    await page.getByTestId('room-tool-spawn').click();
    await clickCell(5, 11);
    await expect(page.getByTestId('room-stats-bar')).toContainText('PlayerSpawn: (5, 11)');

    // Assert live .tscn preview reflects TileMapLayer + PlayerSpawn + entities
    const tscnPreview = page.getByTestId('room-tscn-preview');
    await expect(tscnPreview).toContainText('type="TileMapLayer"');
    await expect(tscnPreview).toContainText('tile_map_data = PackedByteArray(');

    // 5. Save Room to Project & Download Level Bundle ZIP
    await page.getByTestId('room-save-btn').click();
    await expect(page.getByTestId('room-status-notice')).toContainText(
      'levels/crypt_boss_hall.tscn',
    );

    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('room-export-zip-btn').click();
    const download = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
    const keys = Object.keys(entries).sort();
    expect(keys).toEqual(['levels/crypt_boss_hall.tscn', 'recipe.json']);

    const exportedTscn = strFromU8(entries['levels/crypt_boss_hall.tscn']!);
    expect(exportedTscn).toContain('[gd_scene load_steps=');
    expect(exportedTscn).toContain('type="TileMapLayer"');
    expect(exportedTscn).toContain('tile_map_data = PackedByteArray(');

    const rawRecipeJson = strFromU8(entries['recipe.json']!);
    expect(rawRecipeJson).not.toContain(DUMMY_GEMINI_KEY);
    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(rawRecipeJson));
    expect(parsedRecipe.roomLayout?.cols).toBe(24);
    expect(parsedRecipe.roomLayout?.rows).toBe(14);
    expect(parsedRecipe.roomLayout?.playerSpawn).toEqual({ cellX: 5, cellY: 11 });

    // 6. Sync Room to Godot (res://) via injected FSAA stub
    await page.getByTestId('room-sync-godot-btn').click();
    await expect(page.getByTestId('room-sync-status')).toContainText('levels/crypt_boss_hall.tscn');

    const mockFs = await page.evaluate(
      () =>
        (
          window as unknown as {
            __nibgridMockFs: { writes: string[]; files: Record<string, string> };
          }
        ).__nibgridMockFs,
    );
    expect(mockFs.writes).toContain('levels/crypt_boss_hall.tscn');
    expect(mockFs.files['levels/crypt_boss_hall.tscn']).toContain('type="TileMapLayer"');

    // 7. Hard reload & verify IndexedDB persistence
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-asset-class-select').selectOption('tile');
    await page.getByTestId('inspector-tab-room').click();
    await expect(page.getByTestId('room-workshop-panel')).toBeVisible();
    await expect(page.getByTestId('room-name-input')).toHaveValue('Crypt Boss Hall');
    await expect(page.getByTestId('room-stats-bar')).toContainText('75 solid');
    await expect(page.getByTestId('room-stats-bar')).toContainText('PlayerSpawn: (5, 11)');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
