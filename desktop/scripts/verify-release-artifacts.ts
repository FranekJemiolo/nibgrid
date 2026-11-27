import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface VerifyReleaseArtifactsOptions {
  readonly stageDir: string;
  readonly expectedVersion?: string;
  readonly requireWebUi?: boolean;
  readonly requireCompiledExtension?: boolean;
  readonly vsixPath?: string;
}

export interface ReleaseArtifactVerificationReport {
  readonly ok: boolean;
  readonly productName: string;
  readonly version: string;
  readonly mcpToolCount: number;
  readonly webUiPresent: boolean;
  readonly compiledExtensionPresent: boolean;
  readonly vsixVerified: boolean;
  readonly scannedFileCount: number;
}

const FORBIDDEN_PATTERNS: readonly { readonly label: string; readonly regex: RegExp }[] = [
  { label: 'Google API key', regex: /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{8,}/ },
  { label: 'OpenAI/generic sk- key', regex: /(?<![A-Za-z0-9_-])sk-[0-9A-Za-z_-]{12,}/ },
  { label: 'Nibgrid token', regex: /(?<![A-Za-z0-9_-])nbg_[0-9A-Za-z_-]{6,}/ },
  { label: 'Vite localhost dev server URL', regex: /http:\/\/localhost:5173/i },
];

async function assertFileExists(absPath: string, label: string): Promise<void> {
  const info = await stat(absPath).catch(() => null);
  if (!info?.isFile() || info.size === 0) {
    throw new Error(`Required release artifact "${label}" missing or empty at "${absPath}".`);
  }
}

async function scanDirectoryForSecrets(dir: string): Promise<number> {
  let scanned = 0;
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      scanned += await scanDirectoryForSecrets(abs);
    } else if (entry.isFile() && /\.(json|html|js|css|patch)$/i.test(entry.name)) {
      const content = await readFile(abs, 'utf8');
      scanned += 1;
      for (const pat of FORBIDDEN_PATTERNS) {
        if (pat.regex.test(content)) {
          throw new Error(`Forbidden ${pat.label} found inside release artifact "${abs}".`);
        }
      }
    }
  }
  return scanned;
}

/**
 * Verifies a staged/built Nibgrid Studio desktop output directory (branding, telemetry,
 * extension package + compiled bundle + MCP catalog, web-ui assets, `.vsix` ZIP header,
 * and zero credential / localhost dev-URL leaks).
 */
export async function verifyReleaseArtifacts(
  opts: VerifyReleaseArtifactsOptions,
): Promise<ReleaseArtifactVerificationReport> {
  const root = resolve(opts.stageDir);

  const productPath = join(root, 'product.json');
  const extPkgPath = join(root, 'extensions', 'nibgrid-studio', 'package.json');
  const mcpManifestPath = join(root, 'extensions', 'nibgrid-studio', 'mcp-manifest.json');

  await assertFileExists(productPath, 'product.json');
  await assertFileExists(extPkgPath, 'extensions/nibgrid-studio/package.json');
  await assertFileExists(mcpManifestPath, 'extensions/nibgrid-studio/mcp-manifest.json');

  const product = JSON.parse(await readFile(productPath, 'utf8')) as {
    nameLong?: string;
    applicationName?: string;
    version?: string;
    telemetryEnabled?: boolean;
    enableTelemetry?: boolean;
  };
  if (product.nameLong !== 'Nibgrid Studio' || product.applicationName !== 'nibgrid') {
    throw new Error('Release product.json is missing Nibgrid Studio branding.');
  }
  if (product.telemetryEnabled !== false || product.enableTelemetry !== false) {
    throw new Error('Release product.json must disable telemetry explicitly.');
  }
  if (opts.expectedVersion && product.version !== opts.expectedVersion) {
    throw new Error(
      `Release product.json version "${product.version}" does not match expected "${opts.expectedVersion}".`,
    );
  }

  const extPkg = JSON.parse(await readFile(extPkgPath, 'utf8')) as {
    contributes?: { commands?: unknown[]; customEditors?: unknown[] };
  };
  if ((extPkg.contributes?.commands?.length ?? 0) < 4) {
    throw new Error('Release extension package.json must contribute >= 4 commands.');
  }
  if ((extPkg.contributes?.customEditors?.length ?? 0) < 3) {
    throw new Error('Release extension package.json must contribute >= 3 customEditors.');
  }

  const mcpManifest = JSON.parse(await readFile(mcpManifestPath, 'utf8')) as {
    tools?: { name: string }[];
  };
  const mcpToolCount = mcpManifest.tools?.length ?? 0;
  if (mcpToolCount < 9) {
    throw new Error(`Expected >= 9 MCP tools in release manifest, found ${mcpToolCount}.`);
  }

  const extEntryPath = join(root, 'extensions', 'nibgrid-studio', 'dist', 'extension.js');
  const mcpEntryPath = join(root, 'extensions', 'nibgrid-studio', 'dist', 'mcpToolServer.js');
  let compiledExtensionPresent = false;
  if (opts.requireCompiledExtension) {
    await assertFileExists(extEntryPath, 'extensions/nibgrid-studio/dist/extension.js');
    await assertFileExists(mcpEntryPath, 'extensions/nibgrid-studio/dist/mcpToolServer.js');
    compiledExtensionPresent = true;
  } else {
    const extStat = await stat(extEntryPath).catch(() => null);
    compiledExtensionPresent = Boolean(extStat?.isFile() && extStat.size > 0);
  }

  const webIndexPath = join(root, 'web-ui', 'index.html');
  let webUiPresent = false;
  if (opts.requireWebUi) {
    await assertFileExists(webIndexPath, 'web-ui/index.html');
    webUiPresent = true;
  } else {
    const webStat = await stat(webIndexPath).catch(() => null);
    webUiPresent = Boolean(webStat?.isFile() && webStat.size > 0);
  }

  let vsixVerified = false;
  if (opts.vsixPath) {
    const resolvedVsix = resolve(opts.vsixPath);
    await assertFileExists(resolvedVsix, 'vsix');
    const bytes = new Uint8Array(await readFile(resolvedVsix));
    if (
      bytes.byteLength < 4 ||
      bytes[0] !== 0x50 ||
      bytes[1] !== 0x4b ||
      bytes[2] !== 0x03 ||
      bytes[3] !== 0x04
    ) {
      throw new Error(`Invalid .vsix archive header at "${resolvedVsix}" (expected PK ZIP magic).`);
    }
    vsixVerified = true;
  }

  const scannedFileCount = await scanDirectoryForSecrets(root);

  return {
    ok: true,
    productName: product.nameLong,
    version: product.version ?? '0.1.0',
    mcpToolCount,
    webUiPresent,
    compiledExtensionPresent,
    vsixVerified,
    scannedFileCount,
  };
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isCliMain) {
  const args = process.argv.slice(2);
  const stageIdx = args.indexOf('--stage-dir');
  const stageDir =
    stageIdx >= 0 && args[stageIdx + 1]
      ? args[stageIdx + 1]!
      : join(process.cwd(), 'desktop', 'stage');
  const verIdx = args.indexOf('--expected-version');
  const expectedVersion = verIdx >= 0 && args[verIdx + 1] ? args[verIdx + 1]! : undefined;
  const vsixIdx = args.indexOf('--vsix');
  const vsixPath = vsixIdx >= 0 && args[vsixIdx + 1] ? args[vsixIdx + 1]! : undefined;

  const report = await verifyReleaseArtifacts({
    stageDir,
    ...(expectedVersion ? { expectedVersion } : {}),
    requireWebUi: args.includes('--require-web-ui'),
    requireCompiledExtension: args.includes('--require-ext'),
    ...(vsixPath ? { vsixPath } : {}),
  });
  console.log(JSON.stringify(report));
}
