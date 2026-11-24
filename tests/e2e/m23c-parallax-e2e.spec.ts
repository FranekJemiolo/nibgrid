import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';
import { encodeRgbaToPngBytes } from '../../src/processing/png';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const DUMMY_GEMINI_KEY = 'AIzaSyPARALLAX999';

function makeChromaBandBase64(
  width: number,
  height: number,
  ridgeRgb: [number, number, number],
  silhouetteStartY: number,
): string {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = (y * width + x) * 4;
      const wave = Math.round(Math.sin((x / width) * Math.PI * 2) * 8);
      if (y < silhouetteStartY + wave) {
        data[px] = 255;
        data[px + 1] = 0;
        data[px + 2] = 255;
        data[px + 3] = 255;
      } else {
        data[px] = ridgeRgb[0];
        data[px + 1] = ridgeRgb[1];
        data[px + 2] = ridgeRgb[2];
        data[px + 3] = 255;
      }
    }
  }
  return Buffer.from(encodeRgbaToPngBytes(data, width, height)).toString('base64');
}

test.describe('M23C: Parallax Background Compositor, Depth Tinter & GenAI Workshop (Screen 4L)', () => {
  test('generates 3-band Gemini stack, scrubs depth/scroll, rerolls single band, redacts 401 key, exports ZIP & persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (
          !text.includes('401') &&
          !text.includes('Failed to load resource') &&
          !text.includes('ERR_FAILED')
        ) {
          consoleErrors.push(text);
        }
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // 1. Save Gemini BYOK key in Provider Vault
    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('provider-vault-modal')).toBeVisible();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill(DUMMY_GEMINI_KEY);
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Gemini Multimodal BYOK' }),
    ).toBeVisible();
    await page.getByTestId('close-vault-btn').click();

    // 2. Create project & sprite node -> Screen 4L Parallax BG tab
    await page.getByTestId('new-project-name').fill('M23C Dusk Vista');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-asset-class-select').selectOption('tile');
    await page.getByTestId('inspector-tab-parallax').click();
    await expect(page.getByTestId('parallax-workshop-panel')).toBeVisible();

    // 3. Intercept Gemini Blueprint + Master + Band image calls
    let routeMode: 'success' | '401' = 'success';
    let imageCallCount = 0;
    const blueprintSawSchema = { value: false };
    const bandSawMasterInline = { value: false };
    const bandSawChromaRule = { value: false };

    const masterB64 = makeChromaBandBase64(160, 90, [92, 68, 108], 40);
    const bandB64s = [
      makeChromaBandBase64(160, 90, [74, 58, 96], 42),
      makeChromaBandBase64(160, 90, [48, 52, 76], 54),
      makeChromaBandBase64(160, 90, [24, 30, 44], 70),
      makeChromaBandBase64(160, 90, [34, 88, 66], 66),
    ];

    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      if (routeMode === '401') {
        await route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({
            error: { message: `API key not valid: ${DUMMY_GEMINI_KEY}` },
          }),
        });
        return;
      }

      const body = JSON.parse(route.request().postData() ?? '{}') as {
        generationConfig?: {
          responseMimeType?: string;
          responseSchema?: unknown;
          responseModalities?: string[];
        };
        contents?: Array<{
          parts?: Array<{
            text?: string;
            inlineData?: { mimeType?: string; data?: string };
          }>;
        }>;
      };

      if (body.generationConfig?.responseMimeType === 'application/json') {
        blueprintSawSchema.value = Boolean(body.generationConfig.responseSchema);
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        sceneTitle: 'Masovian Dusk Forest',
                        themePrompt: 'Masovian dusk pine valley',
                        skyTopHex: '#181A2F',
                        horizonHex: '#D97B59',
                        horizonLinePct: 0.6,
                        lightingDirection: 'dusk right glow',
                        bandCount: 3,
                        bands: [
                          {
                            id: 'dusk-far',
                            name: 'Far Misty Ridges',
                            role: 'far-mountains',
                            scrollRatioX: 0.2,
                            depthHaze: 0.65,
                            seamBlendPx: 20,
                            yOffsetPx: 0,
                            subjectPrompt: 'Far jagged ridges in dusk mist',
                            silhouetteRule: 'Flat #FF00FF chroma key background',
                            edgeHeightHint: 'Flush horizon at 50%',
                          },
                          {
                            id: 'dusk-mid',
                            name: 'Pine Timberline',
                            role: 'midground',
                            scrollRatioX: 0.5,
                            depthHaze: 0.3,
                            seamBlendPx: 20,
                            yOffsetPx: 0,
                            subjectPrompt: 'Silhouetted pine tree canopy',
                            silhouetteRule: 'Flat #FF00FF chroma key background',
                            edgeHeightHint: 'Consistent treetops at 62%',
                          },
                          {
                            id: 'dusk-fg',
                            name: 'Foreground Grass',
                            role: 'foreground-silhouette',
                            scrollRatioX: 0.9,
                            depthHaze: 0.05,
                            seamBlendPx: 20,
                            yOffsetPx: 0,
                            subjectPrompt: 'Dark meadow reeds',
                            silhouetteRule: 'Flat #FF00FF chroma key background',
                            edgeHeightHint: 'Low reeds at 80%',
                          },
                        ],
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

      const parts = body.contents?.[0]?.parts ?? [];
      const text = parts.map((p) => p.text ?? '').join('\n');
      if (text.includes('PARALLAX DEPTH BAND GENERATION')) {
        if (parts.some((p) => p.inlineData?.data)) {
          bandSawMasterInline.value = true;
        }
        if (text.includes('#FF00FF')) {
          bandSawChromaRule.value = true;
        }
        // Index 0 was Master Keyframe; subsequent calls map across bandB64s
        const b64 = bandB64s[Math.min(bandB64s.length - 1, Math.max(0, imageCallCount - 1))]!;
        imageCallCount++;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'image/png', data: b64 } }],
                },
              },
            ],
          }),
        });
        return;
      }

      imageCallCount++;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { mimeType: 'image/png', data: masterB64 } }],
              },
            },
          ],
        }),
      });
    });

    // 4. Generate 3-band Matched Stack
    await page.getByTestId('parallax-biome-masovian-dusk').click();
    await page.getByTestId('parallax-band-count-3').click();
    await page.getByTestId('parallax-generate-stack-btn').click();

    await expect(page.locator('[data-testid^="parallax-layer-row-"]')).toHaveCount(3);
    await expect(page.getByTestId('parallax-meta-badge')).toContainText('3 bands');
    expect(blueprintSawSchema.value).toBe(true);
    expect(bandSawMasterInline.value).toBe(true);
    expect(bandSawChromaRule.value).toBe(true);

    // Canvas2D renders non-empty pixels
    const previewCanvas = page.getByTestId('parallax-preview-canvas');
    await expect
      .poll(() =>
        previewCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return 0;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          return d.length > 0 ? (d[3] ?? 0) : 0;
        }),
      )
      .toBeGreaterThan(0);

    // 5. Select Band 2 & scrub Depth Haze + Scroll Ratio via pointer drag
    await page.getByTestId('parallax-layer-row-2').click();
    const hazeScrub = page.getByTestId('parallax-depth-haze-scrub');
    await hazeScrub.scrollIntoViewIfNeeded();
    const hazeBefore = Number(await hazeScrub.getAttribute('data-value'));
    const hazeBox = await hazeScrub.boundingBox();
    expect(hazeBox).not.toBeNull();
    await page.mouse.move(
      hazeBox!.x + hazeBox!.width / 2,
      hazeBox!.y + Math.min(12, hazeBox!.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      hazeBox!.x + hazeBox!.width / 2 + 24,
      hazeBox!.y + Math.min(12, hazeBox!.height / 2),
      { steps: 6 },
    );
    await page.mouse.up();
    const hazeAfter = Number(await hazeScrub.getAttribute('data-value'));
    expect(hazeAfter).not.toBe(hazeBefore);

    const scrollScrub = page.getByTestId('parallax-scroll-ratio-scrub');
    await scrollScrub.scrollIntoViewIfNeeded();
    const scrollBefore = Number(await scrollScrub.getAttribute('data-value'));
    const scrollBox = await scrollScrub.boundingBox();
    expect(scrollBox).not.toBeNull();
    await page.mouse.move(
      scrollBox!.x + scrollBox!.width / 2,
      scrollBox!.y + Math.min(12, scrollBox!.height / 2),
    );
    await page.mouse.down();
    await page.mouse.move(
      scrollBox!.x + scrollBox!.width / 2 - 24,
      scrollBox!.y + Math.min(12, scrollBox!.height / 2),
      { steps: 6 },
    );
    await page.mouse.up();
    const scrollAfter = Number(await scrollScrub.getAttribute('data-value'));
    expect(scrollAfter).not.toBe(scrollBefore);

    // 6. Surgically regenerate ONLY Band 2
    const rev0Before = await page
      .getByTestId('parallax-layer-row-0')
      .getAttribute('data-layer-rev');
    const rev1Before = await page
      .getByTestId('parallax-layer-row-1')
      .getAttribute('data-layer-rev');
    const rev2Before = Number(
      await page.getByTestId('parallax-layer-row-2').getAttribute('data-layer-rev'),
    );

    await page.getByTestId('parallax-regen-band-2').click();
    await expect
      .poll(async () =>
        Number(await page.getByTestId('parallax-layer-row-2').getAttribute('data-layer-rev')),
      )
      .toBeGreaterThan(rev2Before);
    expect(await page.getByTestId('parallax-layer-row-0').getAttribute('data-layer-rev')).toBe(
      rev0Before,
    );
    expect(await page.getByTestId('parallax-layer-row-1').getAttribute('data-layer-rev')).toBe(
      rev1Before,
    );

    // 7. Toggle Play/Pause & 1x Sprite Contrast overlay
    await page.getByTestId('parallax-play-toggle').click();
    await expect(page.getByTestId('parallax-play-toggle')).toContainText('Play');
    await page.getByTestId('parallax-dummy-toggle').click();
    await expect(page.getByTestId('parallax-dummy-toggle')).toHaveAttribute('aria-pressed', 'true');

    // 8. Simulate 401 failure and assert API key is strictly redacted from UI banner
    routeMode = '401';
    await page.getByTestId('parallax-regen-band-1').click();
    const errorBanner = page.getByTestId('parallax-ai-error');
    await expect(errorBanner).toBeVisible();
    const errText = (await errorBanner.textContent()) ?? '';
    expect(errText).not.toContain(DUMMY_GEMINI_KEY);
    routeMode = 'success';

    // 9. Save to Dexie and Download Parallax ZIP Bundle
    await page.getByTestId('parallax-save-btn').click();
    await expect(page.getByTestId('parallax-save-notice')).toContainText('Saved 3 parallax layers');

    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('parallax-download-zip-btn').click();
    const download = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await download.path())!)));
    const keys = Object.keys(entries);

    const pngKeys = keys.filter((k) => k.endsWith('.png'));
    const tscnKey = keys.find((k) => k.endsWith('_parallax.tscn'));
    const jsonKey = keys.find((k) => k.endsWith('_parallax.json'));
    const recipeKey = keys.find((k) => k.endsWith('.recipe.json'));

    expect(pngKeys).toHaveLength(3);
    for (const pngKey of pngKeys) {
      expect(Array.from(entries[pngKey]!.slice(0, 8))).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ]);
    }
    expect(tscnKey).toBeTruthy();
    expect(jsonKey).toBeTruthy();
    expect(recipeKey).toBeTruthy();

    const tscnText = strFromU8(entries[tscnKey!]!);
    expect(tscnText).toContain('Parallax2D');
    expect(tscnText).toContain('scroll_scale');
    expect(tscnText).toContain('repeat_size');

    const manifestParsed = JSON.parse(strFromU8(entries[jsonKey!]!)) as {
      layers: Array<{ depthHaze: number; scrollRatioX: number }>;
    };
    expect(manifestParsed.layers).toHaveLength(3);
    expect(manifestParsed.layers[2]!.depthHaze).toBe(hazeAfter);
    expect(manifestParsed.layers[2]!.scrollRatioX).toBe(scrollAfter);

    const recipeText = strFromU8(entries[recipeKey!]!);
    expect(recipeText).not.toContain(DUMMY_GEMINI_KEY);
    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(recipeText));
    expect(parsedRecipe.parallaxScene?.blueprint?.sceneTitle).toBe('Masovian Dusk Forest');

    // 10. Hard reload & verify IndexedDB persistence + zero orphan blobs
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-tab-parallax').click();
    await expect(page.locator('[data-testid^="parallax-layer-row-"]')).toHaveCount(3);
    await page.getByTestId('parallax-layer-row-2').click();
    expect(
      Number(await page.getByTestId('parallax-depth-haze-scrub').getAttribute('data-value')),
    ).toBe(hazeAfter);

    await expect
      .poll(() =>
        page.evaluate(async () => {
          const dbReq = indexedDB.open('nibgrid-db');
          const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
            dbReq.onsuccess = () => resolveDb(dbReq.result);
            dbReq.onerror = () => rejectDb(dbReq.error);
          });
          const readAll = <T>(store: string) =>
            new Promise<T[]>((res, rej) => {
              const tx = db.transaction(store, 'readonly');
              const req = tx.objectStore(store).getAll();
              req.onsuccess = () => res(req.result as T[]);
              req.onerror = () => rej(req.error);
            });
          const [projects, nodes, audio, blobs] = await Promise.all([
            readAll<{ artBible?: { goldenReferenceBlobIds?: string[] } }>('projects'),
            readAll<{
              imageBlobId: string;
              maskBlobId?: string;
              processedBlobId?: string;
              parallaxScene?: {
                masterKeyframeBlobId?: string;
                layers?: Array<{ blobId?: string }>;
              };
            }>('spriteNodes'),
            readAll<{ wavBlobId: string; variationBlobIds?: string[] }>('audioAssets'),
            readAll<{ id: string }>('blobs'),
          ]);
          db.close();
          const refs = new Set<string>();
          for (const p of projects) {
            for (const id of p.artBible?.goldenReferenceBlobIds ?? []) refs.add(id);
          }
          for (const n of nodes) {
            refs.add(n.imageBlobId);
            if (n.maskBlobId) refs.add(n.maskBlobId);
            if (n.processedBlobId) refs.add(n.processedBlobId);
            if (n.parallaxScene?.masterKeyframeBlobId) refs.add(n.parallaxScene.masterKeyframeBlobId);
            for (const l of n.parallaxScene?.layers ?? []) {
              if (l.blobId) refs.add(l.blobId);
            }
          }
          for (const a of audio) {
            refs.add(a.wavBlobId);
            for (const id of a.variationBlobIds ?? []) refs.add(id);
          }
          return blobs.filter((b) => !refs.has(b.id)).length;
        }),
      )
      .toBe(0);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
