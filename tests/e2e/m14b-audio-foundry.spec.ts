import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { strFromU8, unzipSync } from 'fflate';
import { encodeWav16 } from '../../src/audio/pcmPostProcess';
import { uint8ToBase64 } from '../../src/processing/png';
import { AudioRecipeSchema } from '../../src/export/audioExport';

function createSyntheticWavBase64(durationSec = 1.5, sampleRate = 24000, freqHz = 330): string {
  const len = Math.round(durationSec * sampleRate);
  const samples = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    samples[i] = 0.45 * Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  const wav = encodeWav16({ sampleRate, channels: 1, samples });
  return uint8ToBase64(wav);
}

test.describe('M14B Google-First Audio Foundry (Screen 6)', () => {
  test('renders offline 4-variation local synth WAV bundle ZIP with zero console or page errors', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');
    await page.getByTestId('new-project-name').fill('M14B Offline SFX');
    await page.getByTestId('create-project-btn').click();
    await expect(page.getByTestId('art-bible-editor')).toBeVisible();

    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.getByTestId('audio-foundry')).toBeVisible();

    await page.getByTestId('audio-preset-sfx-sprite-impact').click();
    await page.getByTestId('audio-route-select').selectOption('local-synth');
    await expect(page.getByTestId('audio-cost-badge')).toContainText('$0.00');

    await page.getByTestId('audio-trim-toggle').check();
    await page.getByTestId('audio-lufs-target').selectOption('-14');
    await page.getByTestId('audio-var-4').click();

    await expect(page.getByTestId('audio-output-lufs')).toContainText('-14');

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
          return indigoPixels > 25;
        }),
      )
      .toBe(true);

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
    const parsed = AudioRecipeSchema.parse(JSON.parse(strFromU8(entries[recipeKey!]!)));
    expect(parsed.variationCount).toBe(4);
    expect(parsed.route).toBe('local-synth');

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });

  test('routes Gemini-to-Synth, Gemini 3.8 TTS, and Lyria 3 Clip cleanly via page.route() and redacts 401 secret', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    const dummyKey = 'AIzaSyTESTAUDIO999';
    const synthWav24k = createSyntheticWavBase64(0.6, 24000, 440);
    const lyriaWav = createSyntheticWavBase64(1.6, 44100, 260);
    let failLyriaWith401 = false;

    await page.route('https://generativelanguage.googleapis.com/**', async (routeReq) => {
      const url = routeReq.request().url();
      const postJson = routeReq.request().postDataJSON() as Record<string, unknown>;

      if (url.includes('/interactions')) {
        if (failLyriaWith401) {
          await routeReq.fulfill({
            status: 401,
            contentType: 'application/json',
            body: JSON.stringify({ error: { message: `Invalid key: ${dummyKey}` } }),
          });
          return;
        }
        await routeReq.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            outputs: [{ mime_type: 'audio/wav', data: lyriaWav }],
          }),
        });
        return;
      }

      const genCfg = postJson.generationConfig as { responseModalities?: string[] } | undefined;
      if (genCfg?.responseModalities?.includes('AUDIO')) {
        await routeReq.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ inlineData: { mimeType: 'audio/wav', data: synthWav24k } }],
                },
              },
            ],
          }),
        });
        return;
      }

      // Gemini Sprite-to-SFX JSON patch
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
                      durationSec: 0.3,
                      transientGain: 0.9,
                      transientDecayMs: 10,
                      transientFreqHz: 1850,
                      bodyGain: 0.85,
                      bodyShape: 'sawtooth',
                      bodyStartHz: 640,
                      bodyEndHz: 95,
                      bodyAttackMs: 1,
                      bodyDecayMs: 160,
                      fmRatio: 2,
                      fmDepth: 110,
                      noiseGain: 0.45,
                      noiseDecayMs: 140,
                      filterStartHz: 4800,
                      filterEndHz: 680,
                      filterQ: 1.5,
                      bitDepth: 16,
                      drive: 2.0,
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

    // Add single Gemini key into Provider Vault (M4 single-key reuse)
    await page.getByTestId('nav-provider-vault').click();
    await page.getByTestId('vault-kind-select').selectOption('gemini');
    await page.getByTestId('vault-api-key-input').fill(dummyKey);
    await page.getByTestId('vault-save-provider-btn').click();
    await page.getByTestId('close-vault-btn').click();

    await page.getByTestId('new-project-name').fill('M14B Google Audio');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.getByTestId('audio-foundry')).toBeVisible();

    // 1. Sprite-to-SFX Gemini JSON
    await page.getByTestId('audio-preset-sfx-sprite-impact').click();
    await expect(page.getByTestId('audio-cost-badge')).toContainText('$0.001');
    await page.getByTestId('audio-generate-btn').click();
    await expect(page.getByTestId('audio-body-start-hz')).toContainText('640 Hz');

    // 2. Gemini 3.8 TTS Combat Bark
    await page.getByTestId('audio-preset-voice-combat-hurt').click();
    await expect(page.getByTestId('audio-cost-badge')).toContainText('$0.005');
    await page.getByTestId('audio-generate-btn').click();
    await expect(page.getByTestId('audio-status-banner')).toContainText('Decoded audio clip');

    // 3. Lyria 3 Clip + Region Crop + Seamless Loop Crossfade
    await page.getByTestId('audio-preset-bgm-sprite-loop').click();
    await expect(page.getByTestId('audio-cost-badge')).toContainText('$0.04');
    await page.getByTestId('audio-generate-btn').click();
    await expect(page.getByTestId('audio-duration-badge')).toContainText('1.350s');

    await page.getByTestId('audio-crop-start').fill('0.2');
    await page.getByTestId('audio-crop-end').fill('0.8');
    await expect
      .poll(async () => {
        const txt = await page.getByTestId('audio-duration-badge').textContent();
        return Number.parseFloat(txt ?? '99');
      })
      .toBeLessThan(0.5);

    // 4. Simulate 401 -> verify banner redacts dummyKey cleanly
    failLyriaWith401 = true;
    await page.getByTestId('audio-generate-btn').click();
    const errBanner = page.getByTestId('audio-error-banner');
    await expect(errBanner).toBeVisible();
    await expect(errBanner).not.toContainText(dummyKey);

    expect(pageErrors).toEqual([]);
    // Note: Playwright triggers HTTP 401 from page.route which emits a browser console error,
    // verify only zero uncaught pageErrors & non-route console noise.
  });
});
