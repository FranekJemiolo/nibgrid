import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('M36C: Interactive In-Browser Mini-Playtest Stage in Entity Hub', () => {
  test('launches Playtest stage for goblin_scout, lands WASD/Space attack on Target Dummy, toggles Debug overlay, applies stats & persists across reload', async ({
    page,
  }) => {
    const consoleErrors: string[] = [];
    const pageErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/');

    // 1. Create Project, Sprite, M16 Box2D Collider + Hitbox, and M14 Procedural Audio
    await page.getByTestId('new-project-name').fill('M36C Playtest Lab');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sketch-upload-input').setInputFiles(RAW_SKETCH_FIXTURE);
    await page.getByTestId('variant-count-select').selectOption('1');
    await page.getByTestId('generate-btn').click();
    await expect(page.locator('[data-node-kind="generation"]')).toHaveCount(1);

    await page.getByTestId('open-postprocess-btn').click();
    await expect(page.getByTestId('postprocess-inspector')).toBeVisible();

    await page.getByTestId('inspector-tab-collider').click();
    await expect(page.getByTestId('collider-editor')).toBeVisible();
    await page.getByTestId('collider-box2d-preset-btn').click();
    await expect(page.getByTestId('collider-poly-collider')).toBeVisible();

    await page.getByTestId('nav-audio-foundry').click();
    await expect(page.getByTestId('audio-foundry')).toBeVisible();
    await page.getByTestId('audio-preset-sfx-sprite-impact').click();
    await page.getByTestId('audio-route-select').selectOption('local-synth');
    await page.getByTestId('audio-clip-name-input').fill('hit_impact');
    await page.getByTestId('audio-save-btn').click();
    await expect(page.getByTestId('audio-saved-list')).toContainText('hit_impact');

    // 2. Open Entities Hub & create goblin_scout
    await page.getByTestId('nav-entities').click();
    await expect(page.getByTestId('entity-hub-view')).toBeVisible();
    await page.getByTestId('entity-create-btn').click();
    await expect(page.getByTestId('entity-editor-drawer')).toBeVisible();

    await page.getByTestId('entity-name-input').fill('Goblin Scout');
    await page.getByTestId('entity-slug-input').fill('goblin_scout');
    const audioCheckbox = page.locator('[data-testid^="entity-audio-checkbox-"]').first();
    await audioCheckbox.check();
    await page.getByTestId('entity-save-btn').click();
    await expect(page.getByTestId('entity-card-goblin_scout')).toBeVisible();

    // 3. Click ▶ Playtest on goblin_scout & verify non-empty canvas
    await page.getByTestId('entity-playtest-goblin_scout').click();
    await expect(page.getByTestId('playtest-stage-modal')).toBeVisible();

    const stageCanvas = page.getByTestId('playtest-stage-canvas');
    await expect
      .poll(() =>
        stageCanvas.evaluate((el) => {
          const c = el as HTMLCanvasElement;
          const ctx = c.getContext('2d');
          if (!ctx || c.width === 0) return 0;
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          let opaque = 0;
          for (let i = 3; i < d.length; i += 16) {
            if ((d[i] ?? 0) > 0) opaque++;
          }
          return opaque;
        }),
      )
      .toBeGreaterThan(0);

    // 4. Move right toward Dummy and press Space to land active-frame hit
    await expect(page.getByTestId('playtest-dummy-hp')).toHaveText('Dummy HP: 100 / 100');
    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(260);
    await page.keyboard.press('Space');
    await page.waitForTimeout(180);
    await page.keyboard.up('ArrowRight');

    await expect(page.getByTestId('playtest-dummy-hp')).not.toHaveText('Dummy HP: 100 / 100');

    // 5. Toggle Hitbox Debug Overlay via 'H'
    await expect(page.getByTestId('playtest-debug-badge')).toHaveText('Debug: OFF');
    await page.keyboard.press('h');
    await expect(page.getByTestId('playtest-debug-badge')).toHaveText('Debug: ON');

    // 6. Edit Move Speed & Hitstop (ms) via ScrubInput inline editing & apply stats to .gd
    const setScrubValue = async (testId: string, val: string) => {
      const el = page.getByTestId(testId);
      await el.dblclick();
      const input = el.locator('input');
      await expect(input).toBeVisible();
      await input.fill(val);
      await input.press('Enter');
    };

    await setScrubValue('playtest-scrub-move-speed', '220');
    await setScrubValue('playtest-scrub-hitstop', '85');
    await page.getByTestId('playtest-apply-stats-btn').click();
    await expect(page.getByTestId('playtest-status-notice')).toContainText('move_speed=220.0');

    await page.getByTestId('playtest-close-btn').click();
    await expect(page.getByTestId('playtest-stage-modal')).toHaveCount(0);

    // 7. Hard-reload & verify persisted stats in Playtest Stage + .gd preview
    await page.reload();
    await expect(page.getByTestId('entity-hub-view')).toBeVisible();
    await page.getByTestId('entity-playtest-goblin_scout').click();
    await expect(page.getByTestId('playtest-scrub-move-speed')).toHaveAttribute(
      'data-value',
      '220',
    );
    await expect(page.getByTestId('playtest-scrub-hitstop')).toHaveAttribute('data-value', '85');
    await page.getByTestId('playtest-close-btn').click();

    await page.getByTestId('entity-edit-goblin_scout').click();
    await page.getByTestId('entity-tab-gdscript').click();
    await expect(page.getByTestId('entity-gdscript-preview')).toContainText(
      '@export var move_speed: float = 220.0',
    );

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
});
