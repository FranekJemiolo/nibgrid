import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { encodeRgbaToPngBytes, uint8ToBase64 } from '../../src/processing/png';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

function buildSyntheticChromaStripBase64(frameCount = 6, fw = 64, fh = 64): string {
  const width = fw * frameCount;
  const height = fh;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = 255;
    data[i + 1] = 0;
    data[i + 2] = 255;
    data[i + 3] = 255;
  }

  for (let f = 0; f < frameCount; f++) {
    const cx = f * fw + 32;
    const bob = (f % 3) * 3;
    for (let y = 14 + bob; y < 56 + bob; y++) {
      for (let x = cx - 9; x <= cx + 9; x++) {
        if (y < 0 || y >= height) continue;
        const idx = (y * width + x) * 4;
        data[idx] = 255;
        data[idx + 1] = 205;
        data[idx + 2] = 117;
        data[idx + 3] = 255;
      }
    }
  }

  const pngBytes = encodeRgbaToPngBytes(data, width, height);
  return uint8ToBase64(pngBytes);
}

test.describe('M34C: 2D Stick-Figure Pose Keyframer Workshop (Screen 4O)', () => {
  test('poses 15-joint IK rig with onion-skinning, generates 6-frame Gemini strip, commits to M25 Entity & persists on reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let capturedGeminiPartsCount = 0;
    const fakeStripB64 = buildSyntheticChromaStripBase64(6, 64, 64);

    await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
      const body = route.request().postDataJSON() as {
        contents?: Array<{ parts?: Array<{ inlineData?: unknown; text?: string }> }>;
      };
      const parts = body.contents?.[0]?.parts ?? [];
      capturedGeminiPartsCount = parts.filter((p) => Boolean(p.inlineData)).length;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'image/png',
                      data: fakeStripB64,
                    },
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

    // Configure Gemini provider key in Provider Vault
    await page.getByTestId('nav-provider-vault').click();
    await expect(page.getByTestId('provider-vault-modal')).toBeVisible();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-display-name-input').fill('Gemini Pose Test');
    await page.getByTestId('vault-model-input').fill('gemini-2.5-flash-image');
    await page.getByTestId('vault-api-key-input').fill('AIzaSyM34PoseTestKey999');
    await page.getByTestId('vault-save-provider-btn').click();
    await page.getByTestId('close-vault-btn').click();

    await page.getByTestId('new-project-name').fill('M34C Pose Hero');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    // Switch to primary Pose Rig tab on character class
    await page.getByTestId('inspector-tab-pose').click();
    await expect(page.getByTestId('pose-keyframer-panel')).toBeVisible();

    // Load Run 6f preset & confirm onion-skin overlays active
    await page.getByTestId('pose-preset-run_6f').click();
    await expect(page.getByTestId('pose-frame-count')).toHaveText('6 frames');
    await expect(page.getByTestId('pose-onion-prev-rig')).toBeVisible();
    await expect(page.getByTestId('pose-onion-next-rig')).toBeVisible();

    // Drag r_wrist with 2-Bone IK enabled and verify wrist + elbow update
    const wrist = page.getByTestId('pose-joint-r_wrist');
    const elbow = page.getByTestId('pose-joint-r_elbow');
    const wristBeforeX = Number(await wrist.getAttribute('data-x'));
    const elbowBeforeX = Number(await elbow.getAttribute('data-x'));

    const wristBox = await wrist.boundingBox();
    expect(wristBox).not.toBeNull();
    await page.mouse.move(wristBox!.x + wristBox!.width / 2, wristBox!.y + wristBox!.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      wristBox!.x + wristBox!.width / 2 - 42,
      wristBox!.y + wristBox!.height / 2 - 24,
      { steps: 6 },
    );
    await page.mouse.up();

    const wristAfterX = Number(await wrist.getAttribute('data-x'));
    const elbowAfterX = Number(await elbow.getAttribute('data-x'));
    expect(Math.abs(wristAfterX - wristBeforeX)).toBeGreaterThan(0.03);
    expect(Math.abs(elbowAfterX - elbowBeforeX)).toBeGreaterThan(0.005);

    // Select Gemini Pose Test provider & click Generate Sprite Cycle
    const providerSelect = page.getByTestId('pose-provider-select');
    const providerOptions = await providerSelect.locator('option').all();
    let geminiOptVal = '';
    for (const opt of providerOptions) {
      if ((await opt.innerText()).includes('Gemini Pose Test')) {
        geminiOptVal = (await opt.getAttribute('value')) ?? '';
        break;
      }
    }
    expect(geminiOptVal).toBeTruthy();
    await providerSelect.selectOption(geminiOptVal);

    await page.getByTestId('pose-generate-btn').click();
    await expect(page.getByTestId('pose-generated-count')).toHaveText('6/6');
    expect(capturedGeminiPartsCount).toBe(2);

    for (let i = 0; i < 6; i++) {
      await expect(page.getByTestId(`pose-frame-thumb-${i}`)).toBeVisible();
    }

    // Commit clip to M25 Entity & verify inside Entities Hub
    await page.getByTestId('pose-commit-entity-btn').click();
    await expect(page.getByTestId('pose-status-notice')).toContainText('"run"');

    await page.getByTestId('nav-entities').click();
    await expect(page.getByTestId('entity-hub-view')).toBeVisible();
    const entityCard = page.getByTestId('entity-card-m34c_pose_hero');
    await expect(entityCard).toBeVisible();
    await expect(entityCard).toContainText('1 clip');

    // Return to Pose Rig tab & reload to confirm full IndexedDB persistence
    await page.getByTestId('nav-sprite-studio').click();
    await page.getByTestId('open-postprocess-btn').click();
    await page.getByTestId('inspector-tab-pose').click();
    await page.reload();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    await page.getByTestId('inspector-tab-pose').click();

    await expect(page.getByTestId('pose-keyframer-panel')).toBeVisible();
    await expect(page.getByTestId('pose-generated-count')).toHaveText('6/6');
    const reloadedWristX = Number(
      await page.getByTestId('pose-joint-r_wrist').getAttribute('data-x'),
    );
    expect(reloadedWristX).toBeCloseTo(wristAfterX, 3);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
