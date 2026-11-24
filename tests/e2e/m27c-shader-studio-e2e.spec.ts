import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');
const DUMMY_GEMINI_KEY = 'AIzaSyM27ShaderE2EKey999';

test.describe('M27C: Godot 4 Shader Studio (Screen 4N)', () => {
  test('renders live WebGL2 uniforms, runs intercepted Gemini shader, flags Godot 3 errors, exports ZIP & persists on reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let geminiCalled = false;
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
                    text: [
                      '```gdshader',
                      'shader_type canvas_item;',
                      '',
                      'uniform float dissolve_amount : hint_range(0.0, 1.0, 0.05) = 0.42;',
                      'uniform vec4 edge_glow : source_color = vec4(0.2, 0.9, 1.0, 1.0);',
                      '',
                      'void fragment() {',
                      '  vec4 tex = texture(TEXTURE, UV);',
                      '  COLOR = vec4(mix(tex.rgb, edge_glow.rgb, dissolve_amount), tex.a);',
                      '}',
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

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');

    // Configure Gemini provider in Vault
    await page.getByTestId('nav-provider-vault').click();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill(DUMMY_GEMINI_KEY);
    await page.getByTestId('vault-save-provider-btn').click();
    await expect(
      page.locator('[data-testid^="provider-card-"]', { hasText: 'Gemini Multimodal BYOK' }),
    ).toBeVisible();
    await page.getByTestId('close-vault-btn').click();

    // Create project & generate 1 sprite variant
    await page.getByTestId('new-project-name').fill('M27C Shader Knight');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Open Shader Studio (Screen 4N)
    await page.getByTestId('inspector-tab-shader').click();
    await expect(page.getByTestId('shader-studio')).toBeVisible();
    await expect(page.getByTestId('shader-compile-ok')).toBeVisible();

    // Verify WebGL2 preview renders non-transparent pixels
    const glCanvas = page.getByTestId('shader-webgl-canvas');
    await expect(glCanvas).toBeVisible();
    await page.waitForTimeout(120);
    const nonZeroPixels = await glCanvas.evaluate((node) => {
      const src = node as HTMLCanvasElement;
      const probe = document.createElement('canvas');
      probe.width = Math.max(1, src.width);
      probe.height = Math.max(1, src.height);
      const ctx = probe.getContext('2d');
      if (!ctx) return 0;
      ctx.drawImage(src, 0, 0);
      const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
      let count = 0;
      for (let i = 3; i < data.length; i += 4) {
        if ((data[i] ?? 0) > 0) count += 1;
      }
      return count;
    });
    expect(nonZeroPixels).toBeGreaterThan(0);

    // Scrub Hit Flash amount via pointer drag
    const flashScrub = page.getByTestId('shader-uniform-flash_amount');
    await flashScrub.scrollIntoViewIfNeeded();
    const beforeVal = Number(await flashScrub.getAttribute('data-value'));
    const box = await flashScrub.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(12, box!.height / 2));
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 - 28, box!.y + Math.min(12, box!.height / 2), {
      steps: 6,
    });
    await page.mouse.up();
    const afterVal = Number(await flashScrub.getAttribute('data-value'));
    expect(afterVal).not.toBe(beforeVal);

    // Select Gemini BYOK provider & generate custom AI shader
    const providerSelect = page.getByTestId('shader-provider-select');
    const geminiOptionVal = await providerSelect.evaluate((sel) => {
      const opt = Array.from((sel as HTMLSelectElement).options).find((o) =>
        o.text.includes('Gemini'),
      );
      return opt?.value ?? '';
    });
    expect(geminiOptionVal).not.toBe('');
    await providerSelect.selectOption(geminiOptionVal);

    await page.getByTestId('shader-prompt-input').fill('neon cyan dissolve shader');
    await page.getByTestId('shader-generate-btn').click();
    await expect.poll(() => geminiCalled).toBe(true);

    // Dynamic uniform inspector renders parsed uniforms from Gemini response
    await expect(page.getByTestId('shader-uniform-dissolve_amount')).toBeVisible();
    await expect(page.getByTestId('shader-uniform-color-edge_glow')).toBeVisible();

    // Introduce Godot 3 hint_color syntax error and verify inline diagnostic banner
    const editor = page.getByTestId('shader-code-editor');
    await editor.fill(
      'shader_type canvas_item;\nuniform vec4 bad : hint_color = vec4(1.0);\nvoid fragment() { COLOR = bad; }',
    );
    await expect(page.getByTestId('shader-diagnostics')).toBeVisible();
    await expect(page.getByTestId('shader-diagnostics')).toContainText('hint_color');

    // Switch to Metallic Sheen preset, inspect .tres preview, save to node, and download ZIP bundle
    await page.getByTestId('shader-preset-metallic_sheen').click();
    await expect(page.getByTestId('shader-compile-ok')).toBeVisible();

    await page.getByTestId('shader-code-tab-tres').click();
    await expect(page.getByTestId('shader-tres-preview')).toContainText('ShaderMaterial');
    await expect(page.getByTestId('shader-tres-preview')).toContainText(
      'shader_parameter/shine_color = Color(',
    );

    await page.getByTestId('shader-save-btn').click();
    await expect(page.getByTestId('shader-status-notice')).toContainText('Saved shader');

    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('shader-download-zip-btn').click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/_shader\.zip$/);

    const dlPath = await download.path();
    expect(dlPath).not.toBeNull();
    const zipBytes = new Uint8Array(await readFile(dlPath!));
    const entries = unzipSync(zipBytes);
    const names = Object.keys(entries);
    const gdshaderName = names.find((n) => n.endsWith('.gdshader'));
    const matName = names.find((n) => n.endsWith('_mat.tres'));
    const recipeName = names.find((n) => n.endsWith('.recipe.json'));

    expect(gdshaderName).toBeDefined();
    expect(matName).toBeDefined();
    expect(recipeName).toBeDefined();

    expect(strFromU8(entries[gdshaderName!]!)).toContain('uniform vec4 shine_color : source_color');
    expect(strFromU8(entries[matName!]!)).toContain('[gd_resource type="ShaderMaterial"');

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(entries[recipeName!]!)));
    expect(parsedRecipe.shaderConfig?.presetId).toBe('metallic_sheen');

    // Reload persistence verification
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-tab-shader').click();
    await expect(page.getByTestId('shader-studio')).toBeVisible();
    await expect(page.getByTestId('shader-code-editor')).toContainText('uniform float shine_speed');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
