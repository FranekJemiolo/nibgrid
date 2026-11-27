import { describe, expect, it } from 'vitest';
import { STUDIO_TOOL_NAMES } from '../../src/agent/studioToolRegistry';
import { RECIPE_SCHEMA_VERSION } from '../../src/export/recipeBuilder';
import { ALL_INSPECTOR_TABS } from '../../src/ui/inspector/workspaceTabs';
import { NIBGRID_MCP_TOOLS } from '../../packages/vscode-extension/src/mcpToolServer';
import {
  collectRepoParityInput,
  evaluateParityReport,
  runRepoParityCheck,
} from '../../scripts/verify-parity';

describe('M41A: PWA <-> Desktop Version Lock & Feature Parity Contract', () => {
  it('passes parity across aligned manifests, Screen 4A-4P workspaceTabs, M38 tools, MCP registrations & recipe schema', async () => {
    const input = await collectRepoParityInput(process.cwd());
    expect(input.workspaceTabs).toEqual([...ALL_INSPECTOR_TABS]);
    expect(input.studioToolNames).toEqual([...STUDIO_TOOL_NAMES]);
    expect(input.mcpToolNames).toEqual(NIBGRID_MCP_TOOLS.map((t) => t.name));
    expect(input.recipeSchemaVersion).toBe(RECIPE_SCHEMA_VERSION);

    const report = await runRepoParityCheck(process.cwd());
    expect(report).toEqual({
      ok: true,
      version: input.rootVersion,
      errors: [],
      summary: {
        tabCount: ALL_INSPECTOR_TABS.length,
        studioToolCount: STUDIO_TOOL_NAMES.length,
        mcpToolCount: NIBGRID_MCP_TOOLS.length,
        recipeSchemaVersion: RECIPE_SCHEMA_VERSION,
      },
    });
  });

  it('fails parity immediately when desktop/product.json version drifts from root package.json', async () => {
    const base = await collectRepoParityInput(process.cwd());
    const drifted = evaluateParityReport({
      ...base,
      desktopProductVersion: '0.2.0',
    });

    expect(drifted.ok).toBe(false);
    expect(drifted.errors.some((e) => e.includes('desktop/product.json'))).toBe(true);
    expect(drifted.errors.some((e) => e.includes('0.2.0'))).toBe(true);
  });

  it('fails parity when an M38 tool or workspace tab is omitted, or telemetry is re-enabled', async () => {
    const base = await collectRepoParityInput(process.cwd());

    const missingTool = evaluateParityReport({
      ...base,
      mcpToolNames: base.mcpToolNames.filter((name) => name !== 'repalette_sprites'),
      desktopTelemetryEnabled: true,
      desktopBundledExtensionIds: [],
      workspaceTabs: base.workspaceTabs.filter((tab) => tab !== 'uikit'),
    });

    expect(missingTool.ok).toBe(false);
    expect(missingTool.errors.some((e) => e.includes('repalette_sprites'))).toBe(true);
    expect(missingTool.errors.some((e) => e.includes('telemetryEnabled'))).toBe(true);
    expect(missingTool.errors.some((e) => e.includes('builtInExtensions'))).toBe(true);
    expect(missingTool.errors.some((e) => e.includes('uikit'))).toBe(true);
  });
});
