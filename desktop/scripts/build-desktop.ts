import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface StageDesktopBundleOptions {
  readonly repoRoot: string;
  readonly stageDir: string;
}

export interface StagedDesktopBundleResult {
  readonly stageDir: string;
  readonly writtenFiles: readonly string[];
}

/**
 * Stages a self-contained VSCodium-style Nibgrid Studio bundle (product branding,
 * telemetry-free patches, bundled VS Code extension manifest & 9-tool MCP catalog)
 * ready for Code-OSS packaging or CI offline verification.
 */
export async function stageDesktopBundle(
  opts: StageDesktopBundleOptions,
): Promise<StagedDesktopBundleResult> {
  const repoRoot = resolve(opts.repoRoot);
  const stageDir = resolve(opts.stageDir);

  const productRaw = await readFile(join(repoRoot, 'desktop', 'product.json'), 'utf8');
  const extPkgRaw = await readFile(
    join(repoRoot, 'packages', 'vscode-extension', 'package.json'),
    'utf8',
  );
  const patchRaw = await readFile(
    join(repoRoot, 'desktop', 'patches', '01-nibgrid-workbench.patch'),
    'utf8',
  );

  const extPkg = JSON.parse(extPkgRaw) as {
    contributes?: { languageModelTools?: { name: string; displayName: string }[] };
  };
  const mcpManifest = {
    serverName: 'nibgrid-studio-mcp',
    version: '0.1.0',
    tools: (extPkg.contributes?.languageModelTools ?? []).map((t) => ({
      name: t.name.replace(/^nibgrid_/, ''),
      displayName: t.displayName,
    })),
  };

  const outputs: readonly [string, string][] = [
    ['product.json', productRaw],
    ['patches/01-nibgrid-workbench.patch', patchRaw],
    ['extensions/nibgrid-studio/package.json', extPkgRaw],
    ['extensions/nibgrid-studio/mcp-manifest.json', `${JSON.stringify(mcpManifest, null, 2)}\n`],
  ];

  const writtenFiles: string[] = [];
  for (const [relPath, content] of outputs) {
    const absPath = join(stageDir, relPath);
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, content, 'utf8');
    writtenFiles.push(relPath);
  }

  return {
    stageDir,
    writtenFiles,
  };
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isCliMain) {
  const argIdx = process.argv.indexOf('--stage-dir');
  const targetStage =
    argIdx >= 0 && process.argv[argIdx + 1]
      ? process.argv[argIdx + 1]!
      : join(process.cwd(), 'desktop', 'stage');
  const res = await stageDesktopBundle({ repoRoot: process.cwd(), stageDir: targetStage });
  console.log(
    JSON.stringify({ ok: true, stageDir: res.stageDir, files: res.writtenFiles }, null, 2),
  );
}
