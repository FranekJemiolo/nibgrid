import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { stageDesktopBundle } from '../../desktop/scripts/build-desktop';
import { verifyDesktopBundle } from '../../desktop/scripts/smoke-desktop-bundle';

describe('M40C: Standalone Nibgrid Studio Desktop Bundle Staging & Smoke Verification', () => {
  it('stages product.json, workbench patch, extension manifest & 9-tool MCP manifest with zero secrets', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'nibgrid-m40c-test-'));
    try {
      const staged = await stageDesktopBundle({
        repoRoot: process.cwd(),
        stageDir: tempDir,
      });
      expect(staged.writtenFiles).toContain('product.json');
      expect(staged.writtenFiles).toContain('extensions/nibgrid-studio/mcp-manifest.json');

      const report = await verifyDesktopBundle(tempDir);
      expect(report.ok).toBe(true);
      expect(report.productName).toBe('Nibgrid Studio');
      expect(report.mcpToolCount).toBeGreaterThanOrEqual(9);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
