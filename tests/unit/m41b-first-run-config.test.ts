import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stageDesktopBundle } from '../../desktop/scripts/build-desktop';
import { verifyReleaseArtifacts } from '../../desktop/scripts/verify-release-artifacts';
import {
  createDefaultLocalStudioConfig,
  exportPortableSettingsJson,
  importPortableSettingsJson,
} from '../../packages/vscode-extension/src/firstRunConfig';

describe('M41B: Local First-Run Configurability, Portable Settings & Release Artifact Verifier', () => {
  it('exportPortableSettingsJson strips accidental credential fields and round-trips safely via importPortableSettingsJson', () => {
    const base = createDefaultLocalStudioConfig();
    const pollutedInput = {
      ...base,
      preferredLocalProvider: 'ollama-local',
      godotBinaryPath: '/Applications/Godot.app/Contents/MacOS/Godot',
      defaultResSyncSubdir: 'assets/characters',
      apiKey: 'AIzaSySECRETLEAK1234',
      nested: {
        token: 'sk-should-be-dropped-999',
        secretValue: 'nbg_secret_999',
      },
      // Simulate someone stuffing a token inside a freeform string that survives key pruning
      taskRoutingTable: {
        ...base.taskRoutingTable,
        'planning-composer': {
          primaryId: 'ollama-local',
          fallbacks: ['offline-mock'],
        },
      },
    };

    const exportedJson = exportPortableSettingsJson(pollutedInput);
    expect(exportedJson).not.toContain('AIzaSySECRETLEAK1234');
    expect(exportedJson).not.toContain('sk-should-be-dropped-999');
    expect(exportedJson).not.toContain('nbg_secret_999');
    expect(exportedJson).not.toContain('"apiKey"');

    const imported = importPortableSettingsJson(exportedJson);
    expect(imported.preferredLocalProvider).toBe('ollama-local');
    expect(imported.godotBinaryPath).toBe('/Applications/Godot.app/Contents/MacOS/Godot');
    expect(imported.defaultResSyncSubdir).toBe('assets/characters');
    expect(imported.taskRoutingTable['planning-composer'].primaryId).toBe('ollama-local');
    expect(imported.offlineMockFallback).toBe(true);
  });

  it('rejects unsafe Godot binary metacharacters and res:// traversal paths during settings import', () => {
    expect(() =>
      importPortableSettingsJson(JSON.stringify({ godotBinaryPath: 'godot; rm -rf /' })),
    ).toThrow(/unsafe shell characters/);

    expect(() =>
      importPortableSettingsJson(JSON.stringify({ defaultResSyncSubdir: '../outside' })),
    ).toThrow(/workspace-relative/);
  });

  it('verifyReleaseArtifacts passes on staged dry-run desktop bundle + .vsix and fails cleanly on missing files or secret leaks', async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), 'nibgrid-m41b-artifacts-'));
    try {
      const stageDir = join(tempRoot, 'stage');
      // Create minimal mock web-ui & compiled ext dirs in an isolated workspace copy OR verify directly
      const staged = await stageDesktopBundle({
        repoRoot: process.cwd(),
        stageDir,
        createVsix: true,
      });

      // Populate web-ui & compiled extension in stageDir for deterministic unit verification
      await mkdir(join(stageDir, 'web-ui'), { recursive: true });
      await writeFile(join(stageDir, 'web-ui', 'index.html'), '<!doctype html><html></html>');
      await mkdir(join(stageDir, 'extensions', 'nibgrid-studio', 'dist'), { recursive: true });
      await writeFile(
        join(stageDir, 'extensions', 'nibgrid-studio', 'dist', 'extension.js'),
        'export function activate() {}',
      );
      await writeFile(
        join(stageDir, 'extensions', 'nibgrid-studio', 'dist', 'mcpToolServer.js'),
        'export function handleMcpJsonRpcRequest() {}',
      );

      const report = await verifyReleaseArtifacts({
        stageDir,
        expectedVersion: '0.1.0',
        requireWebUi: true,
        requireCompiledExtension: true,
        vsixPath: staged.vsixPath,
      });
      expect(report.ok).toBe(true);
      expect(report.productName).toBe('Nibgrid Studio');
      expect(report.webUiPresent).toBe(true);
      expect(report.compiledExtensionPresent).toBe(true);
      expect(report.vsixVerified).toBe(true);

      // Missing web-ui must fail cleanly
      await rm(join(stageDir, 'web-ui', 'index.html'));
      await expect(verifyReleaseArtifacts({ stageDir, requireWebUi: true })).rejects.toThrow(
        /web-ui\/index\.html/,
      );

      // Restoring web-ui and injecting leaked key into staged JS must fail
      await writeFile(join(stageDir, 'web-ui', 'index.html'), '<!doctype html><html></html>');
      await writeFile(
        join(stageDir, 'extensions', 'nibgrid-studio', 'dist', 'extension.js'),
        'const leaked = "AIzaSySTAGELEAK999";',
      );
      await expect(
        verifyReleaseArtifacts({
          stageDir,
          requireWebUi: true,
          requireCompiledExtension: true,
        }),
      ).rejects.toThrow(/Google API key/);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
