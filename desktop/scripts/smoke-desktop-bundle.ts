import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stageDesktopBundle } from './build-desktop.ts';

export interface DesktopBundleSmokeReport {
  readonly ok: boolean;
  readonly productName: string;
  readonly mcpToolCount: number;
  readonly checkedFiles: readonly string[];
}

const LEAK_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{8,}/,
  /sk-[0-9A-Za-z_-]{12,}/,
  /nbg_[0-9A-Za-z_-]{6,}/,
];

/**
 * Verifies staged `product.json` branding & telemetry-disabled flags, bundled extension
 * custom editors, MCP manifest (all 9 tools), and scans every staged artifact for secret leaks.
 */
export async function verifyDesktopBundle(stageDir: string): Promise<DesktopBundleSmokeReport> {
  const root = resolve(stageDir);
  const checkedFiles = [
    'product.json',
    'patches/01-nibgrid-workbench.patch',
    'extensions/nibgrid-studio/package.json',
    'extensions/nibgrid-studio/mcp-manifest.json',
  ];

  const contents = await Promise.all(
    checkedFiles.map(async (rel) => ({
      rel,
      text: await readFile(join(root, rel), 'utf8'),
    })),
  );

  for (const item of contents) {
    for (const pattern of LEAK_PATTERNS) {
      if (pattern.test(item.text)) {
        throw new Error(`Credential pattern detected inside staged desktop file "${item.rel}"`);
      }
    }
  }

  const product = JSON.parse(contents[0]!.text) as {
    nameLong?: string;
    applicationName?: string;
    telemetryEnabled?: boolean;
    enableTelemetry?: boolean;
  };
  if (product.nameLong !== 'Nibgrid Studio' || product.applicationName !== 'nibgrid') {
    throw new Error('Staged product.json is missing Nibgrid Studio branding fields.');
  }
  if (product.telemetryEnabled !== false || product.enableTelemetry !== false) {
    throw new Error('Staged product.json must explicitly disable telemetry.');
  }

  const extPkg = JSON.parse(contents[2]!.text) as {
    contributes?: { customEditors?: unknown[] };
  };
  if ((extPkg.contributes?.customEditors?.length ?? 0) < 3) {
    throw new Error('Bundled nibgrid-studio extension must contribute >= 3 Custom Editors.');
  }

  const mcpManifest = JSON.parse(contents[3]!.text) as {
    tools?: { name: string }[];
  };
  const mcpToolCount = mcpManifest.tools?.length ?? 0;
  if (mcpToolCount < 9) {
    throw new Error(`Expected >= 9 MCP tools in mcp-manifest.json, found ${mcpToolCount}.`);
  }

  return {
    ok: true,
    productName: product.nameLong,
    mcpToolCount,
    checkedFiles,
  };
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isCliMain) {
  const argIdx = process.argv.indexOf('--stage-dir');
  if (argIdx >= 0 && process.argv[argIdx + 1]) {
    const report = await verifyDesktopBundle(process.argv[argIdx + 1]!);
    console.log(JSON.stringify(report));
  } else {
    const tempDir = await mkdtemp(join(tmpdir(), 'nibgrid-desktop-smoke-'));
    try {
      await stageDesktopBundle({ repoRoot: process.cwd(), stageDir: tempDir });
      const report = await verifyDesktopBundle(tempDir);
      console.log(JSON.stringify(report));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }
}
