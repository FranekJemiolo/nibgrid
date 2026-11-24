import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const DUMMY_GEMINI_KEY = 'AIzaSyM26E2EKEY999';

test.describe('M26C: Prompt-to-Entity Director & Typed Godot 4.3+ GDScript E2E', () => {
  test('drafts blueprint, executes 6-stage Gemini pipeline, writes .tscn + .gd to FSAA res://, and persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    // 1. Inject in-memory FileSystemDirectoryHandle stub for M25 res:// Sync
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

    const fixtureBase64 = (await readFile(RAW_SKETCH_FIXTURE)).toString('base64');

    // Intercept Gemini Blueprint, Sprite Image, and Typed GDScript endpoints
    let blueprintCalled = false;
    let imageCalled = false;
    let gdscriptCalled = false;

    await page.route('https://generativelanguage.googleapis.com/**', async (routeReq) => {
      const postJson = routeReq.request().postDataJSON() as {
        generationConfig?: { responseMimeType?: string; responseModalities?: string[] };
      };
      const genCfg = postJson?.generationConfig;

      if (genCfg?.responseMimeType === 'application/json') {
        blueprintCalled = true;
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
                        slug: 'goblin_scout',
                        displayName: 'Goblin Scout',
                        bodyType: 'CharacterBody2D',
                        spritePrompt:
                          'Armored goblin scout holding short sword, crisp 32px pixel art',
                        turnaroundLayout: 'single',
                        generateNormalMap: false,
                        colliderMode: 'convex-hull',
                        includeHitbox: true,
                        includeHurtbox: true,
                        sockets: [{ name: 'hand_r', normX: 0.78, normY: 0.52, baseAngleDeg: 15 }],
                        sfxSpecs: [
                          {
                            cueName: 'sword_slash',
                            category: 'sfx',
                            prompt: 'Crisp metallic sword slash',
                            engine: 'procedural',
                            proceduralPreset: 'hit',
                          },
                          {
                            cueName: 'heavy_boot',
                            category: 'sfx',
                            prompt: 'Heavy armored boot step',
                            engine: 'procedural',
                            proceduralPreset: 'footstep',
                          },
                        ],
                        behavior: {
                          archetype: 'melee-enemy',
                          moveSpeed: 95,
                          maxHealth: 40,
                          attackDamage: 12,
                          states: ['IDLE', 'PATROL', 'ATTACK', 'HURT'],
                        },
                      }),
                    },
                  ],
                },
              },
            ],
          }),
        });
        return;
      }

      if (genCfg?.responseModalities?.includes('IMAGE')) {
        imageCalled = true;
        await routeReq.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'image/png', data: fixtureBase64 } }],
                },
              },
            ],
          }),
        });
        return;
      }

      gdscriptCalled = true;
      await routeReq.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: [
                      '```gdscript',
                      'class_name GoblinScout',
                      'extends CharacterBody2D',
                      '',
                      '@export var move_speed: float = 95.0',
                      '@export var max_health: int = 40',
                      '@onready var sprite: AnimatedSprite2D = $AnimatedSprite2D',
                      '@onready var socket_hand_r: Marker2D = $Sockets/hand_r',
                      '@onready var sfx_player: AudioStreamPlayer2D = $Audio/SfxPlayer',
                      '',
                      'func _physics_process(_delta: float) -> void:',
                      '\tmove_and_slide()',
                      '```',
                    ].join('\n'),
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // 2. Configure Gemini provider in Vault & create project
    await page.getByTestId('nav-provider-vault').click();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill(DUMMY_GEMINI_KEY);
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Gemini Multimodal BYOK' }),
    ).toBeVisible();
    await page.getByTestId('close-vault-btn').click();

    await page.getByTestId('new-project-name').fill('M26C Goblin Director');
    await page.getByTestId('create-project-btn').click();

    // 3. Go straight to Entities Hub -> Launch Prompt-to-Entity Director
    await page.getByTestId('nav-entities').click();
    await expect(page.getByTestId('entity-hub-view')).toBeVisible();
    await page.getByTestId('entity-director-open-btn').click();
    await expect(page.getByTestId('entity-director-modal')).toBeVisible();

    await page
      .getByTestId('director-prompt-input')
      .fill('Armored goblin scout, 32px pixel art, sword slash, heavy boots');
    await page.getByTestId('director-draft-btn').click();

    // 4. Inspect Editable Blueprint Review -> Build Entity
    await expect(page.getByTestId('director-bp-slug')).toHaveValue('goblin_scout');
    await expect(page.getByTestId('director-bp-sockets-list')).toContainText('hand_r');
    await expect(page.getByTestId('director-bp-sfx-list')).toContainText('sword_slash');
    await expect(page.getByTestId('director-bp-sfx-list')).toContainText('heavy_boot');
    await expect(page.getByTestId('director-cost-badge')).toContainText('1 Sprite');

    await page.getByTestId('director-build-btn').click();

    for (const stage of ['sprite', 'collider', 'sockets', 'sfx', 'gdscript', 'commit']) {
      await expect(page.getByTestId(`director-stage-${stage}`)).toHaveAttribute(
        'data-status',
        'done',
      );
    }
    expect(blueprintCalled).toBe(true);
    expect(imageCalled).toBe(true);
    expect(gdscriptCalled).toBe(true);

    await page.getByTestId('director-done-btn').click();

    // 5. Verify Entity Card coverage dots (Sprite, Collider, Sockets, Audio, .gd)
    const card = page.getByTestId('entity-card-goblin_scout');
    await expect(card).toBeVisible();
    await expect(
      page.getByTestId('entity-coverage-goblin_scout').locator('[data-covered="true"]'),
    ).toHaveCount(5);

    // 6. Trigger M25 Sync to Godot -> verify .tscn + .gd written to FSAA stub
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
    expect(syncedFiles['assets/nibgrid/goblin_scout/goblin_scout.tscn']).toContain(
      'script = ExtResource(',
    );
    expect(syncedFiles['assets/nibgrid/goblin_scout/goblin_scout.gd']).toContain(
      'extends CharacterBody2D',
    );
    expect(syncedFiles['assets/nibgrid/goblin_scout/goblin_scout.gd']).toContain('$Sockets/hand_r');

    // 7. Reload and confirm Entity + .gd Script preview persist cleanly with zero orphan blobs
    await page.reload();
    await expect(page.getByTestId('entity-card-goblin_scout')).toBeVisible();
    await page.getByTestId('entity-edit-goblin_scout').click();
    await page.getByTestId('entity-tab-gdscript').click();
    await expect(page.getByTestId('entity-gdscript-preview')).toContainText(
      'extends CharacterBody2D',
    );

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
