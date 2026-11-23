import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { AssetRecipeSchema } from '../../src/export/recipeBuilder';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

async function setup64x64SpriteColliderTab(page: Page, projectName: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('new-project-name').fill(projectName);
  await page.getByTestId('create-project-btn').click();
  await expect(page.getByTestId('art-bible-editor')).toBeVisible();
  await page.getByTestId('go-to-studio-btn').click();
  await expect(page.getByTestId('sprite-studio')).toBeVisible();

  await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
  await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
  await page.getByTestId('variant-count-select').selectOption('1');
  await page.getByTestId('generate-btn').click();
  await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

  await page.getByTestId('open-postprocess-btn').click();
  await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

  await page.getByTestId('pp-bg-mode').selectOption('color-key');
  await page.getByTestId('pp-resample-toggle').check();
  await page.getByTestId('pp-preset-64').click();
  await expect(page.getByTestId('processed-dimensions-badge')).toHaveText('64×64');

  await page.getByTestId('inspector-tab-collider').click();
  await expect(page.getByTestId('collider-editor')).toBeVisible();
}

function parseCoordText(text: string | null): { x: number; y: number } {
  const match = /\((-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)\)/.exec(text ?? '');
  if (!match?.[1] || !match[2]) {
    throw new Error(`Could not parse coordinate text: "${text ?? ''}"`);
  }
  return { x: Number(match[1]), y: Number(match[2]) };
}

test.describe('M16C Interactive Collision Hull, Hitbox & Hurtbox Editor (Screen 4G)', () => {
  test('auto-traces 8-vertex convex collider, adds hitbox, edits vertices, exports physics ZIP, and persists on reload', async ({
    page,
    browser,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await setup64x64SpriteColliderTab(page, 'M16C Physics Knight');

    // 1. Auto-trace convex hull with 8-Vertex Box2D Safe preset
    await page.getByTestId('collider-box2d-preset-btn').click();
    await expect(page.getByTestId('collider-poly-collider')).toBeVisible();
    await expect(page.getByTestId('collider-convexity-badge')).toContainText('Convex');
    const colVertsText = await page.getByTestId('collider-vertex-count').textContent();
    const colVertCount = Number.parseInt(colVertsText ?? '0', 10);
    expect(colVertCount).toBeGreaterThanOrEqual(3);
    expect(colVertCount).toBeLessThanOrEqual(8);

    // 2. Add Hitbox -> drag vertex 0 -> verify exact delta -> insert midpoint -> right-click delete
    await page.getByTestId('collider-add-hitbox-btn').click();
    await expect(page.getByTestId('collider-poly-hitbox')).toBeVisible();
    await expect(page.getByTestId('collider-vertex-count')).toContainText('4 vertices');

    const beforeCoord = parseCoordText(
      await page.getByTestId('collider-selected-coord').textContent(),
    );

    const svgBox = await page.getByTestId('collider-svg-overlay').boundingBox();
    const handleBox = await page.getByTestId('collider-vertex-handle-0').boundingBox();
    expect(svgBox).not.toBeNull();
    expect(handleBox).not.toBeNull();

    const startX = handleBox!.x + handleBox!.width / 2;
    const startY = handleBox!.y + handleBox!.height / 2;
    const dxCss = 24;
    const dyCss = 20;

    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + dxCss, startY + dyCss, { steps: 6 });
    await page.mouse.up();

    const expectedDeltaX = (dxCss / svgBox!.width) * 64;
    const expectedDeltaY = (dyCss / svgBox!.height) * 64;
    const afterDragCoord = parseCoordText(
      await page.getByTestId('collider-selected-coord').textContent(),
    );
    expect(Math.abs(afterDragCoord.x - (beforeCoord.x + expectedDeltaX))).toBeLessThanOrEqual(0.51);
    expect(Math.abs(afterDragCoord.y - (beforeCoord.y + expectedDeltaY))).toBeLessThanOrEqual(0.51);

    // Insert vertex via edge midpoint handle -> 5 vertices
    await page.getByTestId('collider-midpoint-handle-0').click();
    await expect(page.getByTestId('collider-vertex-count')).toContainText('5 vertices');

    // Right-click newly inserted vertex -> deletes back to 4 vertices
    await page.getByTestId('collider-vertex-handle-1').click({ button: 'right' });
    await expect(page.getByTestId('collider-vertex-count')).toContainText('4 vertices');

    // Verify Matter.js JSON preview toggle works
    await page.getByTestId('collider-preview-matter-btn').click();
    await expect(page.getByTestId('collider-code-preview')).toContainText('fromPhysicsEditor');

    // 3. Download ZIP -> verify _collider.tres, _matter.json, and Zod-valid .recipe.json
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('download-zip-btn').click();
    const dl = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await dl.path())!)));

    const tresKey = Object.keys(entries).find((k) => k.endsWith('_collider.tres'));
    const matterKey = Object.keys(entries).find((k) => k.endsWith('_matter.json'));
    const recipeKey = Object.keys(entries).find((k) => k.endsWith('.recipe.json'));
    expect(tresKey).toBeTruthy();
    expect(matterKey).toBeTruthy();
    expect(recipeKey).toBeTruthy();

    const tresText = strFromU8(entries[tresKey!]!);
    expect(tresText).toContain('PackedVector2Array');

    const matterObj = JSON.parse(strFromU8(entries[matterKey!]!)) as Record<
      string,
      { fixtures?: Array<{ layer: string; isSensor: boolean }> }
    >;
    const bodyKey = Object.keys(matterObj).find((k) => k !== 'generator_info')!;
    const fixtures = matterObj[bodyKey]!.fixtures!;
    expect(fixtures.find((f) => f.layer === 'collider')?.isSensor).toBe(false);
    expect(fixtures.find((f) => f.layer === 'hitbox')?.isSensor).toBe(true);

    const parsedRecipe = AssetRecipeSchema.parse(JSON.parse(strFromU8(entries[recipeKey!]!)));
    expect(parsedRecipe.collisionShapes).toHaveLength(2);
    const savedHitboxV0 = parsedRecipe.collisionShapes?.find((s) => s.layer === 'hitbox')
      ?.vertices[0];
    expect(savedHitboxV0?.x).toBe(afterDragCoord.x);
    expect(savedHitboxV0?.y).toBe(afterDragCoord.y);

    // 4. Hard reload and confirm IndexedDB persistence of both layers + dragged vertex
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-tab-collider').click();
    await expect(page.getByTestId('collider-poly-collider')).toBeVisible();
    await expect(page.getByTestId('collider-poly-hitbox')).toBeVisible();
    await expect(page.getByTestId('collider-code-preview')).toContainText(String(afterDragCoord.x));

    // 5. Repeat vertex drag verification under deviceScaleFactor: 2 HiDPI context
    const hidpiContext = await browser.newContext({ deviceScaleFactor: 2 });
    const hidpiPage = await hidpiContext.newPage();
    try {
      await setup64x64SpriteColliderTab(hidpiPage, 'M16C HiDPI Check');
      await hidpiPage.getByTestId('collider-add-hitbox-btn').click();
      const hiBefore = parseCoordText(
        await hidpiPage.getByTestId('collider-selected-coord').textContent(),
      );
      const hiSvgBox = await hidpiPage.getByTestId('collider-svg-overlay').boundingBox();
      const hiHandleBox = await hidpiPage.getByTestId('collider-vertex-handle-0').boundingBox();
      expect(hiSvgBox).not.toBeNull();
      expect(hiHandleBox).not.toBeNull();

      const hStartX = hiHandleBox!.x + hiHandleBox!.width / 2;
      const hStartY = hiHandleBox!.y + hiHandleBox!.height / 2;
      await hidpiPage.mouse.move(hStartX, hStartY);
      await hidpiPage.mouse.down();
      await hidpiPage.mouse.move(hStartX + 24, hStartY + 24, { steps: 6 });
      await hidpiPage.mouse.up();

      const hiAfter = parseCoordText(
        await hidpiPage.getByTestId('collider-selected-coord').textContent(),
      );
      const expX = (24 / hiSvgBox!.width) * 64;
      const expY = (24 / hiSvgBox!.height) * 64;
      expect(Math.abs(hiAfter.x - (hiBefore.x + expX))).toBeLessThanOrEqual(0.51);
      expect(Math.abs(hiAfter.y - (hiBefore.y + expY))).toBeLessThanOrEqual(0.51);
    } finally {
      await hidpiContext.close();
    }

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
