import { describe, expect, it } from 'vitest';
import {
  buildNibgridMcpEntry,
  linkAntigravityConfigWithBackup,
  mergeAntigravityMcpConfig,
  type ConfigFsAdapter,
} from '../src/antigravityLinker';

function createMemoryFs(initial: Record<string, string> = {}): {
  readonly fs: ConfigFsAdapter;
  readonly files: Map<string, string>;
} {
  const files = new Map<string, string>(Object.entries(initial));
  return {
    files,
    fs: {
      exists: async (p) => files.has(p),
      readText: async (p) => {
        const val = files.get(p);
        if (val === undefined) throw new Error(`ENOENT: ${p}`);
        return val;
      },
      writeText: async (p, content) => {
        files.set(p, content);
      },
    },
  };
}

describe('M40B: Safe ~/.gemini/config/mcp_config.json Antigravity Auto-Linker', () => {
  it('merges into existing mcp_config.json preserving sibling servers and custom keys idempotently', () => {
    const existing = JSON.stringify(
      {
        theme: 'dark-obsidian',
        telemetryDisabled: true,
        mcpServers: {
          filesystem: {
            command: 'npx',
            args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
          },
        },
      },
      null,
      2,
    );

    const entry = buildNibgridMcpEntry({
      mcpEntryScriptPath: '/opt/nibgrid/mcpToolServer.ts',
      workspacePath: '/games/crypt',
    });

    const once = mergeAntigravityMcpConfig(existing, entry);
    const twice = mergeAntigravityMcpConfig(once, entry);
    expect(twice).toBe(once);

    const parsed = JSON.parse(once) as {
      theme: string;
      telemetryDisabled: boolean;
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.theme).toBe('dark-obsidian');
    expect(parsed.telemetryDisabled).toBe(true);
    expect(parsed.mcpServers.filesystem?.command).toBe('npx');
    expect(parsed.mcpServers.nibgrid?.command).toBe('node');
  });

  it('linkAntigravityConfigWithBackup creates timestamped .bak before writing and throws on malformed JSON without mutating FS', async () => {
    const configDir = '/Users/dev/.gemini/config';
    const origContent = JSON.stringify({
      mcpServers: { git: { command: 'uvx', args: ['mcp-server-git'] } },
    });
    const { fs, files } = createMemoryFs({
      [`${configDir}/mcp_config.json`]: origContent,
    });

    const entry = buildNibgridMcpEntry({ mcpEntryScriptPath: '/app/mcp.ts' });
    const res = await linkAntigravityConfigWithBackup(
      fs,
      configDir,
      entry,
      '2026-11-27T12:00:00.000Z',
    );
    expect(res.backupPath).toBe(`${configDir}/mcp_config.json.bak.2026-11-27T12-00-00-000Z`);
    expect(files.get(res.backupPath!)).toBe(origContent);
    expect(JSON.parse(files.get(res.configPath)!).mcpServers.git.command).toBe('uvx');
    expect(JSON.parse(files.get(res.configPath)!).mcpServers.nibgrid.command).toBe('node');

    // Malformed existing config must reject cleanly BEFORE writing backup or config
    const brokenFs = createMemoryFs({
      [`${configDir}/mcp_config.json`]: '{ "mcpServers": broken-json',
    });
    await expect(
      linkAntigravityConfigWithBackup(brokenFs.fs, configDir, entry, '2026-11-27T12:05:00.000Z'),
    ).rejects.toThrow(/malformed/i);
    expect(brokenFs.files.size).toBe(1);
    expect(brokenFs.files.get(`${configDir}/mcp_config.json`)).toBe('{ "mcpServers": broken-json');
  });

  it('rejects secret/API-key values inside MCP entry env cleanly', () => {
    expect(() =>
      buildNibgridMcpEntry({
        mcpEntryScriptPath: '/app/mcp.ts',
        workspacePath: 'AIzaSySECRETLEAK123',
      }),
    ).toThrow(/credential/i);
  });
});
