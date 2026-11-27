#!/usr/bin/env node
/**
 * Builds the real VS Code / Cursor / Antigravity extension entry point and the bundled
 * Nibgrid PWA Webview assets:
 *   - packages/vscode-extension/dist/vscodeMain.cjs  (CommonJS `activate` bundle, `vscode` external)
 *   - packages/vscode-extension/dist/webview/        (PWA built with a relative base path)
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as esbuildBuild } from 'esbuild';
import { build as viteBuild } from 'vite';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, '..');
const repoRoot = resolve(pkgRoot, '..', '..');

await esbuildBuild({
  entryPoints: [resolve(pkgRoot, 'src/vscodeEntry.ts')],
  outfile: resolve(pkgRoot, 'dist/vscodeMain.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['vscode'],
  sourcemap: true,
  logLevel: 'info',
});

process.env.VITE_BASE_PATH = './';
await viteBuild({
  root: repoRoot,
  configFile: resolve(repoRoot, 'vite.config.ts'),
  logLevel: 'warn',
  build: {
    outDir: resolve(pkgRoot, 'dist/webview'),
    emptyOutDir: true,
  },
});

console.log('Built dist/vscodeMain.cjs and dist/webview');
