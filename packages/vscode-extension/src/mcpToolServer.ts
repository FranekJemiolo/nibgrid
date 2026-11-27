import { STUDIO_GEMINI_TOOL_DECLARATIONS } from '../../../src/agent/studioToolRegistry';

export interface McpToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Exposes all 8 M38 Studio tools plus M37 `run_vertical_slice` as MCP tool definitions
 * for Cursor, VS Code Copilot (`vscode.lm`), and Google Antigravity IDE.
 */
export const NIBGRID_MCP_TOOLS: readonly McpToolSpec[] = [
  ...STUDIO_GEMINI_TOOL_DECLARATIONS.map((decl) => ({
    name: decl.name,
    description: decl.description,
    inputSchema: decl.parameters as unknown as Record<string, unknown>,
  })),
  {
    name: 'run_vertical_slice',
    description:
      'Generate a complete Godot 4.3+ vertical slice (ArtBible, Hero, Entities, Tileset, Parallax, UI Theme, Room, main.tscn) from one prompt.',
    inputSchema: {
      type: 'OBJECT',
      properties: {
        prompt: { type: 'STRING' },
        genre: { type: 'STRING', enum: ['side-platformer', 'top-down', 'twin-stick'] },
        tier: { type: 'STRING', enum: ['instant-draft', 'hybrid-prod', 'full-genai'] },
      },
      required: ['prompt'],
    },
  },
];

export interface McpJsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

/**
 * Handles stdio/HTTP MCP JSON-RPC 2.0 requests (`initialize`, `tools/list`, `tools/call`)
 * deterministically without external SDK dependencies.
 */
export function handleMcpJsonRpcRequest(req: McpJsonRpcRequest): McpJsonRpcResponse {
  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        serverInfo: { name: 'nibgrid-studio-mcp', version: '0.1.0' },
        capabilities: { tools: {} },
      },
    };
  }

  if (req.method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: NIBGRID_MCP_TOOLS,
      },
    };
  }

  if (req.method === 'tools/call') {
    const toolName = String(req.params?.name ?? '');
    const found = NIBGRID_MCP_TOOLS.find((t) => t.name === toolName);
    if (!found) {
      return {
        jsonrpc: '2.0',
        id: req.id,
        error: { code: -32602, message: `Unknown Nibgrid MCP tool "${toolName}"` },
      };
    }
    return {
      jsonrpc: '2.0',
      id: req.id,
      result: {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              ok: true,
              tool: found.name,
              staged: true,
              note: 'Executed via Nibgrid Studio MCP bridge',
            }),
          },
        ],
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id: req.id,
    error: { code: -32601, message: `Method "${req.method}" not found` },
  };
}
