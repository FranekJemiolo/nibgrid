import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface ExtensionBundleSmokeReport {
  readonly ok: boolean;
  readonly commandCount: number;
  readonly customEditorCount: number;
  readonly mcpToolCount: number;
  readonly bundleFiles: readonly string[];
}

const LEAK_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{8,}/,
  /sk-[0-9A-Za-z_-]{12,}/,
  /nbg_[0-9A-Za-z_-]{6,}/,
];

/**
 * Verifies the compiled VS Code Extension + MCP Server bundle (`dist/extension.js`,
 * `dist/mcpToolServer.js`), extension manifest contributions, and lowercase JSON Schemas.
 */
export async function verifyExtensionBundle(
  extRoot = resolve(process.cwd(), 'packages/vscode-extension'),
): Promise<ExtensionBundleSmokeReport> {
  const pkgRaw = await readFile(join(extRoot, 'package.json'), 'utf8');
  const pkg = JSON.parse(pkgRaw) as {
    main?: string;
    contributes?: {
      commands?: { command: string }[];
      customEditors?: { viewType: string }[];
      languageModelTools?: { name: string }[];
    };
  };

  const commands = pkg.contributes?.commands ?? [];
  const customEditors = pkg.contributes?.customEditors ?? [];
  const lmTools = pkg.contributes?.languageModelTools ?? [];

  if (commands.length < 4) {
    throw new Error(`Expected >= 4 extension commands, found ${commands.length}.`);
  }
  if (customEditors.length < 3) {
    throw new Error(`Expected >= 3 customEditors, found ${customEditors.length}.`);
  }
  if (lmTools.length < 9) {
    throw new Error(`Expected >= 9 languageModelTools, found ${lmTools.length}.`);
  }

  const bundleFiles = ['dist/extension.js', 'dist/mcpToolServer.js', 'dist/vscodeMain.cjs'];
  for (const rel of bundleFiles) {
    const abs = join(extRoot, rel);
    const info = await stat(abs);
    if (!info.isFile() || info.size === 0) {
      throw new Error(`Missing or empty compiled extension artifact "${rel}".`);
    }
    const content = await readFile(abs, 'utf8');
    for (const rx of LEAK_PATTERNS) {
      if (rx.test(content)) {
        throw new Error(`Credential pattern detected in compiled artifact "${rel}".`);
      }
    }
  }

  const mcpUrl = pathToFileURL(join(extRoot, 'dist/mcpToolServer.js')).href;
  const mcpMod = (await import(mcpUrl)) as {
    handleMcpJsonRpcRequest: (req: {
      jsonrpc: '2.0';
      id: number;
      method: string;
      params?: Record<string, unknown>;
    }) => {
      result?: {
        protocolVersion?: string;
        tools?: { name: string; inputSchema: { type?: string } }[];
      };
    };
  };

  const init = mcpMod.handleMcpJsonRpcRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
  });
  if (!init.result?.protocolVersion) {
    throw new Error('Bundled MCP server initialize response missing protocolVersion.');
  }

  const listed = mcpMod.handleMcpJsonRpcRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/list',
  });
  const tools = listed.result?.tools ?? [];
  if (tools.length < 9) {
    throw new Error(`Expected >= 9 MCP tools from bundled server, found ${tools.length}.`);
  }
  for (const tool of tools) {
    if (tool.inputSchema?.type !== 'object') {
      throw new Error(`Tool "${tool.name}" expected lowercase inputSchema.type "object".`);
    }
  }

  return {
    ok: true,
    commandCount: commands.length,
    customEditorCount: customEditors.length,
    mcpToolCount: tools.length,
    bundleFiles,
  };
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isCliMain) {
  const report = await verifyExtensionBundle();
  console.log(JSON.stringify(report));
}
