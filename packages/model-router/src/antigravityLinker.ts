import { z } from 'zod';

const SECRET_ENV_KEY_REGEX = /(api_?key|secret|token|password|auth)/i;
const SECRET_VALUE_REGEX = /(AIza[0-9A-Za-z_-]{6,}|sk-[0-9A-Za-z_-]{6,}|nbg_[0-9A-Za-z_-]{6,})/;

export const McpServerEntrySchema = z
  .object({
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((entry, ctx) => {
    for (const [k, v] of Object.entries(entry.env ?? {})) {
      if (SECRET_ENV_KEY_REGEX.test(k) || SECRET_VALUE_REGEX.test(v)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['env', k],
          message: `Refusing to store credential-like env entry "${k}" inside mcp_config.json`,
        });
      }
    }
  });
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

export interface ConfigFsAdapter {
  readonly exists: (filePath: string) => Promise<boolean>;
  readonly readText: (filePath: string) => Promise<string>;
  readonly writeText: (filePath: string, content: string) => Promise<void>;
}

/**
 * Builds a credential-free Nibgrid Studio MCP server entry for `~/.gemini/config/mcp_config.json`.
 */
export function buildNibgridMcpEntry(opts: {
  readonly nodePath?: string;
  readonly mcpEntryScriptPath: string;
  readonly workspacePath?: string;
}): McpServerEntry {
  return McpServerEntrySchema.parse({
    command: opts.nodePath?.trim() || 'node',
    args: ['--experimental-strip-types', opts.mcpEntryScriptPath.trim()],
    ...(opts.workspacePath ? { env: { NIBGRID_WORKSPACE: opts.workspacePath.trim() } } : {}),
  });
}

/**
 * Parses `existingJsonText` (or initializes `{ mcpServers: {} }`), idempotently sets
 * `mcpServers[serverName]`, and preserves every unrelated top-level key and sibling MCP server.
 * Throws cleanly on malformed JSON instead of overwriting user configuration.
 */
export function mergeAntigravityMcpConfig(
  existingJsonText: string | null | undefined,
  entry: McpServerEntry,
  serverName = 'nibgrid',
): string {
  const validEntry = McpServerEntrySchema.parse(entry);
  let root: Record<string, unknown> = {};

  const trimmed = existingJsonText?.trim() ?? '';
  if (trimmed.length > 0) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      throw new Error(
        `Refusing to overwrite malformed mcp_config.json: ${
          err instanceof Error ? err.message : 'invalid JSON'
        }`,
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('Refusing to overwrite mcp_config.json: root must be a JSON object.');
    }
    root = { ...(parsed as Record<string, unknown>) };
  }

  const prevServers =
    typeof root.mcpServers === 'object' &&
    root.mcpServers !== null &&
    !Array.isArray(root.mcpServers)
      ? { ...(root.mcpServers as Record<string, unknown>) }
      : {};

  prevServers[serverName] = validEntry;
  root.mcpServers = prevServers;

  return `${JSON.stringify(root, null, 2)}\n`;
}

export interface LinkAntigravityResult {
  readonly configPath: string;
  readonly backupPath?: string;
  readonly mergedJson: string;
}

/**
 * Safely merges Nibgrid's MCP entry into `<configDir>/mcp_config.json`:
 * 1. Validates and merges existing JSON in memory first (throws cleanly if corrupted).
 * 2. Writes a timestamped `.bak.<ts>` backup whenever an existing file is present.
 * 3. Writes the merged `mcp_config.json`.
 */
export async function linkAntigravityConfigWithBackup(
  fsAdapter: ConfigFsAdapter,
  configDir: string,
  entry: McpServerEntry,
  nowIso: string = new Date().toISOString(),
  serverName = 'nibgrid',
): Promise<LinkAntigravityResult> {
  const cleanDir = configDir.replace(/\/+$/, '');
  const configPath = `${cleanDir}/mcp_config.json`;
  const hasExisting = await fsAdapter.exists(configPath);
  const existingText = hasExisting ? await fsAdapter.readText(configPath) : null;

  const mergedJson = mergeAntigravityMcpConfig(existingText, entry, serverName);

  let backupPath: string | undefined;
  if (hasExisting && existingText !== null) {
    const safeStamp = nowIso.replace(/[:.]/g, '-');
    backupPath = `${cleanDir}/mcp_config.json.bak.${safeStamp}`;
    await fsAdapter.writeText(backupPath, existingText);
  }

  await fsAdapter.writeText(configPath, mergedJson);
  return {
    configPath,
    ...(backupPath ? { backupPath } : {}),
    mergedJson,
  };
}
