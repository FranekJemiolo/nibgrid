import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';

export interface StageDesktopBundleOptions {
  readonly repoRoot: string;
  readonly stageDir: string;
  readonly includeWebUi?: boolean;
  readonly includeCompiledExtension?: boolean;
  readonly createVsix?: boolean;
  readonly vsixOnly?: boolean;
}

export interface StagedDesktopBundleResult {
  readonly stageDir: string;
  readonly writtenFiles: readonly string[];
  readonly vsixPath?: string;
}

async function pathExists(absPath: string): Promise<boolean> {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

async function collectFilesRecursively(
  dir: string,
  baseDir = dir,
): Promise<readonly { readonly relPath: string; readonly absPath: string }[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: { readonly relPath: string; readonly absPath: string }[] = [];
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await collectFilesRecursively(abs, baseDir);
      results.push(...nested);
    } else if (entry.isFile()) {
      results.push({ relPath: relative(baseDir, abs).replace(/\\/g, '/'), absPath: abs });
    }
  }
  return results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
}

/**
 * Stages a self-contained VSCodium-style Nibgrid Studio bundle (product branding,
 * telemetry-free patches, bundled VS Code extension + compiled dist, PWA web-ui,
 * 9-tool MCP catalog, and optional `.vsix` ZIP archive).
 */
export async function stageDesktopBundle(
  opts: StageDesktopBundleOptions,
): Promise<StagedDesktopBundleResult> {
  const repoRoot = resolve(opts.repoRoot);
  const stageDir = resolve(opts.stageDir);

  const productRaw = await readFile(join(repoRoot, 'desktop', 'product.json'), 'utf8');
  const productParsed = JSON.parse(productRaw) as { version?: string };
  const extPkgRaw = await readFile(
    join(repoRoot, 'packages', 'vscode-extension', 'package.json'),
    'utf8',
  );
  const patchRaw = await readFile(
    join(repoRoot, 'desktop', 'patches', '01-nibgrid-workbench.patch'),
    'utf8',
  );

  const extPkg = JSON.parse(extPkgRaw) as {
    version?: string;
    contributes?: { languageModelTools?: { name: string; displayName: string }[] };
  };
  const mcpManifest = {
    serverName: 'nibgrid-studio-mcp',
    version: extPkg.version ?? '0.1.0',
    tools: (extPkg.contributes?.languageModelTools ?? []).map((t) => ({
      name: t.name.replace(/^nibgrid_/, ''),
      displayName: t.displayName,
    })),
  };
  const mcpManifestRaw = `${JSON.stringify(mcpManifest, null, 2)}\n`;

  const writtenFiles: string[] = [];
  const vsixEntries: Record<string, Uint8Array> = {
    'extension/package.json': new TextEncoder().encode(extPkgRaw),
    'extension/mcp-manifest.json': new TextEncoder().encode(mcpManifestRaw),
  };

  if (!opts.vsixOnly) {
    const baseOutputs: readonly [string, string][] = [
      ['product.json', productRaw],
      ['patches/01-nibgrid-workbench.patch', patchRaw],
      ['extensions/nibgrid-studio/package.json', extPkgRaw],
      ['extensions/nibgrid-studio/mcp-manifest.json', mcpManifestRaw],
    ];
    for (const [relPath, content] of baseOutputs) {
      const absPath = join(stageDir, relPath);
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content, 'utf8');
      writtenFiles.push(relPath);
    }
  }

  if (opts.includeCompiledExtension || opts.createVsix || opts.vsixOnly) {
    const extDistDir = join(repoRoot, 'packages', 'vscode-extension', 'dist');
    if (await pathExists(extDistDir)) {
      const extDistFiles = await collectFilesRecursively(extDistDir);
      for (const f of extDistFiles) {
        const bytes = new Uint8Array(await readFile(f.absPath));
        vsixEntries[`extension/dist/${f.relPath}`] = bytes;
        if (!opts.vsixOnly && opts.includeCompiledExtension) {
          const destRel = `extensions/nibgrid-studio/dist/${f.relPath}`;
          const destAbs = join(stageDir, destRel);
          await mkdir(dirname(destAbs), { recursive: true });
          await writeFile(destAbs, bytes);
          writtenFiles.push(destRel);
        }
      }
    }
  }

  if (!opts.vsixOnly && opts.includeWebUi) {
    const rootDistDir = join(repoRoot, 'dist');
    if (await pathExists(rootDistDir)) {
      const webDestDir = join(stageDir, 'web-ui');
      await mkdir(webDestDir, { recursive: true });
      await cp(rootDistDir, webDestDir, { recursive: true });
      const webFiles = await collectFilesRecursively(webDestDir);
      for (const f of webFiles) {
        writtenFiles.push(`web-ui/${f.relPath}`);
      }
    }
  }

  let vsixPath: string | undefined;
  if (opts.createVsix || opts.vsixOnly) {
    const ver = productParsed.version ?? extPkg.version ?? '0.1.0';
    const vsixFilename = `nibgrid-studio-${ver}.vsix`;
    const vsixAbs = join(stageDir, vsixFilename);
    await mkdir(dirname(vsixAbs), { recursive: true });
    const archive = zipSync(vsixEntries, { level: 6 });
    await writeFile(vsixAbs, archive);
    writtenFiles.push(vsixFilename);
    vsixPath = vsixAbs;
  }

  return {
    stageDir,
    writtenFiles,
    ...(vsixPath ? { vsixPath } : {}),
  };
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isCliMain) {
  const args = process.argv.slice(2);
  const argIdx = args.indexOf('--stage-dir');
  const targetStage =
    argIdx >= 0 && args[argIdx + 1] ? args[argIdx + 1]! : join(process.cwd(), 'desktop', 'stage');
  const isDryRun = args.includes('--dry-run');
  const vsixOnly = args.includes('--vsix-only');
  const includeWebUi = !vsixOnly && (isDryRun || args.includes('--include-web-ui'));
  const includeCompiledExtension = !vsixOnly && (isDryRun || args.includes('--include-ext'));
  const createVsix = vsixOnly || args.includes('--vsix');

  const res = await stageDesktopBundle({
    repoRoot: process.cwd(),
    stageDir: targetStage,
    includeWebUi,
    includeCompiledExtension,
    createVsix,
    vsixOnly,
  });
  console.log(
    JSON.stringify(
      {
        ok: true,
        stageDir: res.stageDir,
        fileCount: res.writtenFiles.length,
        ...(res.vsixPath ? { vsixPath: res.vsixPath } : {}),
      },
      null,
      2,
    ),
  );
}
