import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { encodeWav16 } from '../../src/audio/pcmPostProcess';
import { AudioRecipeSchema } from '../../src/export/audioExport';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

function createChirpSketchWav(durationSec = 0.85, sampleRate = 22050): Uint8Array {
  const frameCount = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(frameCount);
  let phase = 0;
  for (let i = 0; i < frameCount; i++) {
    const t = i / frameCount;
    const freqHz = t < 0.5 ? 220 : 440;
    phase += (2 * Math.PI * freqHz) / sampleRate;
    const env = i < 400 ? i / 400 : i > frameCount - 600 ? (frameCount - i) / 600 : 1;
    samples[i] = 0.45 * env * Math.sin(phase);
  }
  return encodeWav16({ sampleRate, channels: 1, samples });
}

test.describe('M15C Hum-to-Sound Audio Sketching & Multimodal Routing', () => {
  test('uploads wav sketch, renders cyan pitch ribbon, enforces R input isolation, routes Gemini hum-to-timbre ZIP, and binds to Sandbox', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const dummyKey = 'AIzaSyHUMTEST777';
    let capturedWavInlineData = false;

    await page.route('**/v1beta/models/*:generateContent*', async (routeReq) => {
      const postJson = routeReq.request().postDataJSON() as {
        contents?: Array<{
          parts?: Array<{ text?: string; inlineData?: { mimeType?: string; data?: string } }>;
        }>;
      };
      const parts = postJson.contents?.[0]?.parts ?? [];
      capturedWavInlineData = parts.some(
        (p) => p.inlineData?.mimeType === 'audio/wav' && (p.inlineData.data?.length ?? 0) > 20,
      );

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
                      oscShape: 'sawtooth',
                      octaveShift: -1,
                      pitchSmoothMs: 15,
                      scaleQuantize: 'pentatonic',
                      fmRatio: 2.5,
                      fmDepth: 11,
                      unvoicedNoiseGain: 0.4,
                      noiseFilterHz: 2800,
                      filterQ: 2.2,
                      subOscGain: 0.35,
                      drive: 2.6,
                      bitDepth: 12,
                    }),
                  },
                ],
              },
            },
          ],
        }),
      });
    });

    await page.goto('/');

    // 1. Add single Gemini key into Provider Vault (M4 single-key reuse)
    await page.getByTestId('nav-provider-vault').click();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill(dummyKey);
    await page.getByTestId('vault-save-provider-btn').click();
    await page.getByTestId('close-vault-btn').click();

    // 2. Create project and generate a starter sprite for later Sandbox hit-flash binding
    await page.getByTestId('new-project-name').fill('M15C Hum Studio');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();
    await page.getByTestId('go-to-studio-btn').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();

    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await expect(page.getByTestId('studio-status')).toContainText('Loaded sketch');
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    // 3. Switch to Audio Foundry -> Mic Sketch tab and upload deterministic chirp .wav
    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.getByTestId('audio-foundry')).toBeVisible();
    await page.getByTestId('audio-tab-mic-sketch').click();
    await expect(page.getByTestId('pitch-ribbon-canvas')).toBeVisible();

    const chirpWav = createChirpSketchWav();
    await page.getByTestId('hum-upload-input').setInputFiles({
      name: 'chirp-hum.wav',
      mimeType: 'audio/wav',
      buffer: Buffer.from(chirpWav),
    });

    await expect(page.getByTestId('pitch-ribbon-telemetry')).toContainText('BPM');

    // Verify cyan f0(t) curve painted onto pitch-ribbon-canvas
    await expect
      .poll(async () =>
        page.getByTestId('pitch-ribbon-canvas').evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx) return false;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let cyanPixels = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i] ?? 0;
            const g = data[i + 1] ?? 0;
            const b = data[i + 2] ?? 0;
            if (r < 120 && g > 180 && b > 200) {
              cyanPixels++;
            }
          }
          return cyanPixels > 25;
        }),
      )
      .toBe(true);

    // 4. Local $0.00 Contour Follow + Octave Shift + A/B toggle
    await page.getByTestId('hum-chip-melody').click();
    await expect(page.getByTestId('hum-cost-badge')).toContainText('$0.00');
    await page.getByTestId('hum-octave-shift').fill('-1');

    // Verify indigo processed contour waveform renders cleanly
    await expect
      .poll(async () =>
        page.getByTestId('audio-waveform-canvas').evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx) return false;
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let indigoPixels = 0;
          for (let i = 0; i < data.length; i += 4) {
            if ((data[i] ?? 0) === 99 && (data[i + 1] ?? 0) === 102 && (data[i + 2] ?? 0) === 241) {
              indigoPixels++;
            }
          }
          return indigoPixels > 20;
        }),
      )
      .toBe(true);

    // Toggle A/B between Transformed Sound and My Hum and back
    await expect(page.getByTestId('hum-ab-toggle')).toContainText('Transformed Sound');
    await page.getByTestId('hum-ab-toggle').click();
    await expect(page.getByTestId('hum-ab-toggle')).toContainText('My Hum');
    await page.getByTestId('hum-ab-toggle').click();
    await expect(page.getByTestId('hum-ab-toggle')).toContainText('Transformed Sound');

    // 5. Verify 'R' shortcut isolation inside hum-prompt-input
    const promptBox = page.getByTestId('hum-prompt-input');
    await promptBox.click();
    await promptBox.fill('');
    await page.keyboard.type('retro plasma laser');
    await expect(promptBox).toHaveValue('retro plasma laser');
    await expect(page.getByTestId('hum-record-btn')).not.toContainText('Recording');

    // 6. Gemini hum-to-timbre route + inline wav payload check + 4-WAV ZIP export
    await page.getByTestId('hum-route-select').selectOption('hum-to-timbre');
    await expect(page.getByTestId('hum-cost-badge')).toContainText('$0.001');
    await page.getByTestId('hum-transform-btn').click();
    await expect.poll(() => capturedWavInlineData).toBe(true);
    await expect(page.getByTestId('audio-status-banner')).toContainText('ContourTimbrePatch');

    await page.getByTestId('audio-var-4').click();
    await expect(page.getByTestId('audio-var-pill-3')).toBeVisible();
    const dlPromise = page.waitForEvent('download');
    await page.getByTestId('audio-download-zip-btn').click();
    const dl = await dlPromise;
    const entries = unzipSync(new Uint8Array(await readFile((await dl.path())!)));

    const wavKeys = Object.keys(entries)
      .filter((k) => k.endsWith('.wav'))
      .sort();
    expect(wavKeys).toHaveLength(4);
    for (const k of wavKeys) {
      const bytes = entries[k]!;
      expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
      expect(String.fromCharCode(...bytes.slice(8, 12))).toBe('WAVE');
    }

    const recipeKey = Object.keys(entries).find((k) => k.endsWith('.audio.recipe.json'));
    expect(recipeKey).toBeTruthy();
    const rawRecipeJson = strFromU8(entries[recipeKey!]!);
    expect(rawRecipeJson).not.toContain(dummyKey);
    const parsedRecipe = AudioRecipeSchema.parse(JSON.parse(rawRecipeJson));
    expect(parsedRecipe.audioSketch?.sketchSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(parsedRecipe.audioSketch?.humRoute).toBe('hum-to-timbre');

    // 7. Save to IndexedDB -> reload -> bind to 1x Sandbox Hit-Flash ('H')
    await page.getByTestId('audio-clip-name-input').fill('Hum Plasma Laser');
    await page.getByTestId('audio-save-btn').click();
    await expect(page.locator('[data-testid^="audio-saved-item-"]')).toHaveCount(1);

    await page.waitForTimeout(250);
    await page.reload();

    await expect(page.getByTestId('audio-foundry')).toBeVisible();
    await expect(page.locator('[data-testid^="audio-saved-item-"]')).toHaveCount(1);
    await expect(page.getByTestId('audio-saved-list')).toContainText('Hum Plasma Laser');

    await page.getByTestId('nav-sprite-studio').click();
    await expect(page.getByTestId('sprite-studio')).toBeVisible();
    await page.getByTestId('dag-quick-sandbox-btn').click();
    await expect(page.getByTestId('game-sandbox-panel')).toBeVisible();

    const hitSelect = page.getByTestId('sandbox-hit-sfx-select');
    const humOptionVal = await hitSelect
      .locator('option', { hasText: 'Hum Plasma Laser' })
      .getAttribute('value');
    expect(humOptionVal).toBeTruthy();
    await hitSelect.selectOption(humOptionVal!);

    await page.keyboard.press('h');
    await expect(page.getByTestId('sandbox-canvas')).toHaveAttribute(
      'data-audio-trigger-count',
      '1',
    );
    await expect(page.getByTestId('sandbox-canvas')).toHaveAttribute(
      'data-last-played-sfx',
      humOptionVal!,
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
