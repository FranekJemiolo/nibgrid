import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../../../');
const require = createRequire(resolve(repoRoot, 'package.json'));
const { chromium } = require('playwright');

const targetUrl = process.argv[2] ?? 'https://franekjemiolo.github.io/nibgrid/';
const rawSketchFixture = resolve(repoRoot, 'tests/e2e/fixtures/raw-sketch.png');

// 1x1 opaque sprite PNG used only to verify Antigravity IDE bridge import & DAG persistence
const SAMPLE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function main() {
  let browser = null;
  let context = null;
  let page = null;

  const consoleErrors = [];
  const pageErrors = [];
  const httpErrors = [];

  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--new-window'],
    });
    context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    page = await context.newPage();

    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(err.message));
    page.on('response', (res) => {
      if (res.status() >= 400) httpErrors.push(`${res.status()} ${res.url()}`);
    });

    const response = await page.goto(targetUrl, { waitUntil: 'networkidle' });
    assert.ok(response && response.status() === 200, `Expected HTTP 200 for ${targetUrl}`);
    await page.getByTestId('app-header').waitFor({ state: 'visible' });
    await page.getByTestId('project-hub').waitFor({ state: 'visible' });

    // Create project -> Studio -> select Antigravity IDE adapter -> test programmatic bridge
    await page.getByTestId('new-project-name').fill('Antigravity Bridge Check');
    await page.getByTestId('create-project-btn').click();
    await page.getByTestId('go-to-studio-btn').click();
    await page.getByTestId('sprite-studio').waitFor({ state: 'visible' });

    await page.getByTestId('sketch-upload-input').setInputFiles(rawSketchFixture);
    await page.getByTestId('provider-select').selectOption('antigravity-agent');
    await page.getByTestId('antigravity-handoff-panel').waitFor({ state: 'visible' });

    const bridgeSummary = await page.evaluate(async (pngB64) => {
      const bridge = window.__NIBGRID_AGENT_BRIDGE__;
      if (!bridge) throw new Error('window.__NIBGRID_AGENT_BRIDGE__ is not registered');
      const brief = bridge.getBrief();
      const importedNodeId = await bridge.importPngBase64(pngB64, 'antigravity-ide bridge test');
      const afterState = bridge.getState();
      return {
        briefHasTitle: brief.includes('Nibgrid -> Google Antigravity IDE Sprite Brief'),
        importedNodeId,
        nodeCount: afterState.nodeCount,
        selectedProviderId: afterState.selectedProviderId,
      };
    }, SAMPLE_PNG_BASE64);

    assert.ok(bridgeSummary.briefHasTitle, 'Missing formatted Antigravity IDE prompt brief');
    assert.ok(bridgeSummary.importedNodeId.length > 0, 'Bridge did not return imported node ID');
    assert.ok(bridgeSummary.nodeCount >= 2, 'Expected root sketch + imported Antigravity node');
    assert.deepEqual(consoleErrors, [], `Console errors: ${consoleErrors.join('; ')}`);
    assert.deepEqual(pageErrors, [], `Page errors: ${pageErrors.join('; ')}`);
    assert.deepEqual(httpErrors, [], `HTTP >= 400 errors: ${httpErrors.join('; ')}`);

    console.log(
      JSON.stringify(
        {
          ok: true,
          targetUrl,
          ...bridgeSummary,
          consoleErrorsCount: consoleErrors.length,
          pageErrorsCount: pageErrors.length,
          httpErrorsCount: httpErrors.length,
        },
        null,
        2,
      ),
    );
  } finally {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

