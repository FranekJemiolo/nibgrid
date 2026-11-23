import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const RAW_SKETCH_FIXTURE = resolve(process.cwd(), 'tests/e2e/fixtures/raw-sketch.png');

test.describe('Post-M11 Audit Phase 1: WebGL2 Context-Loss, Recovery & Leak Prevention', () => {
  test('cycles Post-Process -> Normal Map -> Puppet Warp -> Atlas 10x with <=2 active WebGL2 contexts and recovers from forced context loss', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const uniqueContexts = new Set<WebGL2RenderingContext>();
      let totalGetContextCalls = 0;
      const origGetContext = HTMLCanvasElement.prototype.getContext;

      HTMLCanvasElement.prototype.getContext = function patchedGetContext(
        this: HTMLCanvasElement,
        type: string,
        attrs?: unknown,
      ) {
        const ctx = origGetContext.call(
          this,
          type as never,
          attrs as never,
        ) as RenderingContext | null;
        if (ctx && (type === 'webgl2' || type === 'webgl')) {
          totalGetContextCalls += 1;
          uniqueContexts.add(ctx as WebGL2RenderingContext);
        }
        return ctx;
      } as typeof HTMLCanvasElement.prototype.getContext;

      (
        window as unknown as {
          __webglAudit: {
            getActiveCount: () => number;
            getTotalUniqueCount: () => number;
            getTotalCalls: () => number;
          };
        }
      ).__webglAudit = {
        getActiveCount: () => {
          let active = 0;
          for (const ctx of uniqueContexts) {
            if (!ctx.isContextLost()) active += 1;
          }
          return active;
        },
        getTotalUniqueCount: () => uniqueContexts.size,
        getTotalCalls: () => totalGetContextCalls,
      };
    });

    const consoleErrors: string[] = [];
    const tooManyWarnings: string[] = [];
    const pageErrors: string[] = [];

    page.on('console', (msg) => {
      const text = msg.text();
      if (msg.type() === 'error') {
        consoleErrors.push(text);
      }
      if (/too many active/i.test(text)) {
        tooManyWarnings.push(text);
      }
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));

    await page.goto('/');

    // Create project, upload fixture, generate 1 sprite variant, and enter Inspector
    await page.getByTestId('new-project-name').fill('Audit WebGL Project');
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

    // Wait for initial sprite processing
    await page.getByTestId('pp-bg-mode').selectOption('color-key');
    await expect
      .poll(async () =>
        page.getByTestId('processed-preview-canvas').evaluate((el) => {
          const ctx = (el as HTMLCanvasElement).getContext('2d')!;
          return ctx.getImageData(0, 0, 1, 1).data[3] ?? 255;
        }),
      )
      .toBe(0);

    // Cycle 10x: Post-Process -> Normal Map -> Puppet Warp -> Atlas Workshop -> Studio -> Inspector
    for (let cycle = 0; cycle < 10; cycle++) {
      await page.getByTestId('inspector-tab-normal').click();
      await expect(page.getByTestId('normal-map-preview-panel')).toBeVisible();

      const activeAfterNormal = await page.evaluate(() =>
        (
          window as unknown as { __webglAudit: { getActiveCount: () => number } }
        ).__webglAudit.getActiveCount(),
      );
      expect(activeAfterNormal).toBeLessThanOrEqual(2);

      await page.getByTestId('inspector-tab-puppet').click();
      await expect(page.getByTestId('puppet-warp-panel')).toBeVisible();

      const activeAfterPuppet = await page.evaluate(() =>
        (
          window as unknown as { __webglAudit: { getActiveCount: () => number } }
        ).__webglAudit.getActiveCount(),
      );
      expect(activeAfterPuppet).toBeLessThanOrEqual(2);

      await page.getByTestId('nav-atlas-workshop').click();
      await expect(page.getByTestId('atlas-workshop')).toBeVisible();

      const activeInAtlas = await page.evaluate(() =>
        (
          window as unknown as { __webglAudit: { getActiveCount: () => number } }
        ).__webglAudit.getActiveCount(),
      );
      expect(activeInAtlas).toBeLessThanOrEqual(2);

      await page.getByTestId('nav-sprite-studio').click();
      await expect(page.getByTestId('sprite-studio')).toBeVisible();
      await page.getByTestId('open-postprocess-btn').click();
      await expect(page.getByTestId('postprocess-inspector')).toBeVisible();
    }

    expect(tooManyWarnings).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);

    // Forced context loss & recovery on Normal Map (Screen 4B)
    await page.getByTestId('inspector-tab-normal').click();
    await expect(page.getByTestId('normal-map-preview-panel')).toBeVisible();

    const normalExtSupported = await page.getByTestId('normal-preview-canvas').evaluate((el) => {
      const gl = (el as HTMLCanvasElement).getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      // Cache handle before loseContext() because gl.getExtension returns null while lost
      (window as unknown as { __auditLoseExt?: WEBGL_lose_context }).__auditLoseExt = ext;
      ext.loseContext();
      return true;
    });
    expect(normalExtSupported).toBe(true);

    await page.waitForTimeout(150);
    await expect(page.getByTestId('normal-context-status')).toBeVisible();

    await page.evaluate(() => {
      (
        window as unknown as { __auditLoseExt?: WEBGL_lose_context }
      ).__auditLoseExt?.restoreContext();
    });

    await expect(page.getByTestId('normal-context-status')).toHaveCount(0);

    const normalStageBox = await page.getByTestId('normal-light-stage').boundingBox();
    expect(normalStageBox).not.toBeNull();
    await page.mouse.move(
      normalStageBox!.x + normalStageBox!.width * 0.65,
      normalStageBox!.y + normalStageBox!.height * 0.4,
    );

    await expect
      .poll(async () =>
        page.getByTestId('normal-preview-canvas').evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const gl = canvas.getContext('webgl2');
          if (!gl || gl.isContextLost()) return 0;
          const px = new Uint8Array(canvas.width * canvas.height * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let nonZero = 0;
          for (let i = 3; i < px.length; i += 4) {
            if ((px[i] ?? 0) > 0) nonZero += 1;
          }
          return nonZero;
        }),
      )
      .toBeGreaterThan(20);

    // Forced context loss & recovery on Puppet Warp (Screen 4C)
    await page.getByTestId('inspector-tab-puppet').click();
    await expect(page.getByTestId('puppet-warp-panel')).toBeVisible();

    // Wait for initial WebGL2 puppet frame render
    await expect
      .poll(async () =>
        page.getByTestId('puppet-pin-canvas').evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const gl = canvas.getContext('webgl2');
          if (!gl || gl.isContextLost()) return 0;
          const px = new Uint8Array(canvas.width * canvas.height * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let nonZero = 0;
          for (let i = 3; i < px.length; i += 4) {
            if ((px[i] ?? 0) > 0) nonZero += 1;
          }
          return nonZero;
        }),
      )
      .toBeGreaterThan(20);

    const puppetExtSupported = await page.getByTestId('puppet-pin-canvas').evaluate((el) => {
      const gl = (el as HTMLCanvasElement).getContext('webgl2');
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      (window as unknown as { __auditPuppetLoseExt?: WEBGL_lose_context }).__auditPuppetLoseExt =
        ext;
      ext.loseContext();
      return true;
    });
    expect(puppetExtSupported).toBe(true);

    await page.waitForTimeout(150);
    await expect(page.getByTestId('puppet-context-status')).toBeVisible();

    await page.evaluate(() => {
      (
        window as unknown as { __auditPuppetLoseExt?: WEBGL_lose_context }
      ).__auditPuppetLoseExt?.restoreContext();
    });

    await expect(page.getByTestId('puppet-context-status')).toHaveCount(0);

    await expect
      .poll(async () =>
        page.getByTestId('puppet-pin-canvas').evaluate((el) => {
          const canvas = el as HTMLCanvasElement;
          const gl = canvas.getContext('webgl2');
          if (!gl || gl.isContextLost()) return 0;
          const px = new Uint8Array(canvas.width * canvas.height * 4);
          gl.bindFramebuffer(gl.FRAMEBUFFER, null);
          gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let nonZero = 0;
          for (let i = 3; i < px.length; i += 4) {
            if ((px[i] ?? 0) > 0) nonZero += 1;
          }
          return nonZero;
        }),
      )
      .toBeGreaterThan(20);

    expect(tooManyWarnings).toEqual([]);
    expect(pageErrors).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
});
