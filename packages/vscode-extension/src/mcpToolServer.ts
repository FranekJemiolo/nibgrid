import type { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import {
  STUDIO_GEMINI_TOOL_DECLARATIONS,
  STUDIO_TOOL_SCHEMAS,
} from '../../../src/agent/studioToolRegistry';
import { redactHostSecrets } from '../../../src/platform/hostAdapter';

export const RunVerticalSliceArgsSchema = z.object({
  prompt: z.string().min(1),
  genre: z.enum(['side-platformer', 'top-down', 'twin-stick']).optional(),
  tier: z.enum(['instant-draft', 'hybrid-prod', 'full-genai']).optional(),
});

const SyncGodotMcpArgsSchema = STUDIO_TOOL_SCHEMAS.sync_godot_diff.extend({
  confirmed: z.boolean().optional(),
});

export const MCP_TOOL_ARG_SCHEMAS: Readonly<Record<string, z.ZodTypeAny>> = {
  ...STUDIO_TOOL_SCHEMAS,
  sync_godot_diff: SyncGodotMcpArgsSchema,
  run_vertical_slice: RunVerticalSliceArgsSchema,
};

function toStandardJsonSchema(node: unknown): unknown {
  if (Array.isArray(node)) {
    return node.map((item) => toStandardJsonSchema(item));
  }
  if (!node || typeof node !== 'object') {
    return node;
  }
  const obj = node as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'type' && typeof v === 'string') {
      out[k] = v.toLowerCase();
    } else {
      out[k] = toStandardJsonSchema(v);
    }
  }
  return out;
}

export interface McpToolSpec {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Exposes all 8 M38 Studio tools plus M37 `run_vertical_slice` with normalized
 * lowercase JSON Schema definitions for MCP and `vscode.lm` tool callers.
 */
export const NIBGRID_MCP_TOOLS: readonly McpToolSpec[] = [
  ...STUDIO_GEMINI_TOOL_DECLARATIONS.map((decl) => {
    const converted = toStandardJsonSchema(decl.parameters) as Record<string, unknown>;
    if (decl.name === 'sync_godot_diff' && converted.properties) {
      return {
        name: decl.name,
        description: decl.description,
        inputSchema: {
          ...converted,
          properties: {
            ...(converted.properties as Record<string, unknown>),
            confirmed: { type: 'boolean' },
          },
        },
      };
    }
    return {
      name: decl.name,
      description: decl.description,
      inputSchema: converted,
    };
  }),
  {
    name: 'run_vertical_slice',
    description:
      'Generate a complete Godot 4.3+ vertical slice (ArtBible, Hero, Entities, Tileset, Parallax, UI Theme, Room, main.tscn) from one prompt.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        genre: { type: 'string', enum: ['side-platformer', 'top-down', 'twin-stick'] },
        tier: { type: 'string', enum: ['instant-draft', 'hybrid-prod', 'full-genai'] },
      },
      required: ['prompt'],
    },
  },
];

export interface McpJsonRpcRequest {
  readonly jsonrpc: '2.0';
  readonly id?: string | number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
}

export interface McpJsonRpcResponse {
  readonly jsonrpc: '2.0';
  readonly id: string | number | null;
  readonly result?: Record<string, unknown>;
  readonly error?: { readonly code: number; readonly message: string };
}

export interface McpServerOptions {
  readonly autoConfirmSync?: boolean;
  readonly knownSecrets?: readonly string[];
  readonly toolExecutor?: (
    toolName: string,
    validatedArgs: Record<string, unknown>,
  ) => Promise<Record<string, unknown>> | Record<string, unknown>;
}

function validateAndAuthorizeToolCall(
  toolName: string,
  rawArgs: unknown,
  opts: McpServerOptions,
):
  | {
      readonly ok: true;
      readonly args: Record<string, unknown>;
      readonly requiresConfirmation?: false;
    }
  | {
      readonly ok: true;
      readonly args: Record<string, unknown>;
      readonly requiresConfirmation: true;
    }
  | { readonly ok: false; readonly message: string } {
  const schema = MCP_TOOL_ARG_SCHEMAS[toolName];
  if (!schema) {
    return { ok: false, message: `Unknown Nibgrid MCP tool "${toolName}"` };
  }

  const parsed = schema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const fieldPath = issue?.path?.length ? `${issue.path.join('.')}: ` : '';
    return {
      ok: false,
      message: `Invalid arguments for "${toolName}": ${fieldPath}${issue?.message ?? 'validation error'}`,
    };
  }

  const validatedArgs = parsed.data as Record<string, unknown>;
  if (toolName === 'sync_godot_diff' && !opts.autoConfirmSync && validatedArgs.confirmed !== true) {
    return { ok: true, args: validatedArgs, requiresConfirmation: true };
  }

  return { ok: true, args: validatedArgs };
}

/**
 * Synchronous MCP JSON-RPC 2.0 handler (`initialize`, `tools/list`, `tools/call`)
 * with Zod argument validation, `sync_godot_diff` confirmation gating, and secret redaction.
 */
export function handleMcpJsonRpcRequest(
  req: McpJsonRpcRequest,
  opts: McpServerOptions = {},
): McpJsonRpcResponse {
  const id = req.id ?? null;
  const scrub = (text: string): string => redactHostSecrets(text, opts.knownSecrets);

  if (req.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
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
      id,
      result: {
        tools: NIBGRID_MCP_TOOLS,
      },
    };
  }

  if (req.method === 'tools/call') {
    const toolName = String(req.params?.name ?? '');
    const rawArgs = req.params?.arguments ?? {};
    const found = NIBGRID_MCP_TOOLS.find((t) => t.name === toolName);
    if (!found) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32602, message: scrub(`Unknown Nibgrid MCP tool "${toolName}"`) },
      };
    }

    const check = validateAndAuthorizeToolCall(toolName, rawArgs, opts);
    if (!check.ok) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: scrub(check.message) }],
        },
      };
    }

    if (check.requiresConfirmation) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          content: [
            {
              type: 'text',
              text: scrub(
                JSON.stringify({
                  ok: false,
                  requiresConfirmation: true,
                  synced: false,
                  tool: found.name,
                  message:
                    'Explicit user confirmation is required before syncing Godot res:// files (pass confirmed: true or set autoConfirmSync: true).',
                }),
              ),
            },
          ],
        },
      };
    }

    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: scrub(
              JSON.stringify({
                ok: true,
                tool: found.name,
                staged: true,
                args: check.args,
                note: 'Executed via Nibgrid Studio MCP bridge',
              }),
            ),
          },
        ],
      },
    };
  }

  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: scrub(`Method "${req.method}" not found`) },
  };
}

/**
 * Async MCP JSON-RPC 2.0 handler supporting custom async `toolExecutor` callbacks,
 * notification tolerance (`notifications/initialized`), structured tool errors, and redaction.
 */
export async function handleMcpJsonRpcRequestAsync(
  req: McpJsonRpcRequest,
  opts: McpServerOptions = {},
): Promise<McpJsonRpcResponse | null> {
  if (req.method.startsWith('notifications/') && req.id === undefined) {
    return null;
  }

  if (req.method !== 'tools/call') {
    return handleMcpJsonRpcRequest(req, opts);
  }

  const id = req.id ?? null;
  const scrub = (text: string): string => redactHostSecrets(text, opts.knownSecrets);
  const toolName = String(req.params?.name ?? '');
  const rawArgs = req.params?.arguments ?? {};
  const found = NIBGRID_MCP_TOOLS.find((t) => t.name === toolName);
  if (!found) {
    return {
      jsonrpc: '2.0',
      id,
      error: { code: -32602, message: scrub(`Unknown Nibgrid MCP tool "${toolName}"`) },
    };
  }

  const check = validateAndAuthorizeToolCall(toolName, rawArgs, opts);
  if (!check.ok) {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: scrub(check.message) }],
      },
    };
  }

  if (check.requiresConfirmation) {
    return handleMcpJsonRpcRequest(req, opts);
  }

  try {
    const payload = opts.toolExecutor
      ? await opts.toolExecutor(found.name, check.args)
      : {
          ok: true,
          tool: found.name,
          staged: true,
          args: check.args,
          note: 'Executed via Nibgrid Studio MCP bridge',
        };
    return {
      jsonrpc: '2.0',
      id,
      result: {
        content: [
          {
            type: 'text',
            text: scrub(JSON.stringify(payload)),
          },
        ],
      },
    };
  } catch (err) {
    const rawMsg = err instanceof Error ? err.message : 'MCP tool execution failed';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        isError: true,
        content: [{ type: 'text', text: scrub(rawMsg) }],
      },
    };
  }
}

/**
 * Starts a duplex stdio MCP server over any Node `Readable`/`Writable` stream pair,
 * supporting both `Content-Length` framing and newline-delimited JSON (`NDJSON`).
 */
export function startMcpStdioServer(
  input: Readable,
  output: Writable,
  opts: McpServerOptions = {},
): { readonly dispose: () => void } {
  let buffer = Buffer.alloc(0);

  const sendFramed = (resp: McpJsonRpcResponse, useContentLength: boolean) => {
    const json = JSON.stringify(resp);
    if (useContentLength) {
      const byteLen = Buffer.byteLength(json, 'utf8');
      output.write(`Content-Length: ${byteLen}\r\n\r\n${json}`, 'utf8');
    } else {
      output.write(`${json}\n`, 'utf8');
    }
  };

  const processMessageText = async (rawJson: string, useContentLength: boolean) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawJson);
    } catch {
      sendFramed(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error: invalid JSON-RPC payload' },
        },
        useContentLength,
      );
      return;
    }

    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof (parsed as { method?: unknown }).method !== 'string'
    ) {
      sendFramed(
        {
          jsonrpc: '2.0',
          id: null,
          error: { code: -32600, message: 'Invalid Request' },
        },
        useContentLength,
      );
      return;
    }

    const resp = await handleMcpJsonRpcRequestAsync(parsed as McpJsonRpcRequest, opts);
    if (resp) {
      sendFramed(resp, useContentLength);
    }
  };

  let processingChain = Promise.resolve();

  const drainBuffer = () => {
    while (buffer.length > 0) {
      const asText = buffer.toString('utf8');
      const clMatch = /^Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(asText);
      if (clMatch) {
        const headerByteLen = Buffer.byteLength(clMatch[0], 'utf8');
        const bodyLen = Number.parseInt(clMatch[1]!, 10);
        if (buffer.length < headerByteLen + bodyLen) {
          return;
        }
        const bodyText = buffer.subarray(headerByteLen, headerByteLen + bodyLen).toString('utf8');
        buffer = buffer.subarray(headerByteLen + bodyLen);
        processingChain = processingChain.then(() => processMessageText(bodyText, true));
        continue;
      }

      // If it looks like an incomplete Content-Length header, wait for more bytes
      if (
        /^Content-Length:/i.test(asText) &&
        !asText.includes('\n\n') &&
        !asText.includes('\r\n\r\n')
      ) {
        return;
      }

      const newlineIdx = buffer.indexOf(0x0a);
      if (newlineIdx === -1) {
        return;
      }
      const line = buffer.subarray(0, newlineIdx).toString('utf8').trim();
      buffer = buffer.subarray(newlineIdx + 1);
      if (!line) continue;
      processingChain = processingChain.then(() => processMessageText(line, false));
    }
  };

  const onData = (chunk: Buffer | string) => {
    const nextChunk = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    buffer = Buffer.concat([buffer, nextChunk]);
    drainBuffer();
  };

  input.on('data', onData);

  return {
    dispose: () => {
      input.off('data', onData);
    },
  };
}

export interface VscodeLmToolLike {
  readonly invoke: (
    options: { readonly input: Record<string, unknown> },
    token?: unknown,
  ) => Promise<{ readonly content: readonly { readonly value: string }[] }>;
}

export interface VscodeLmRegistryLike {
  registerTool?: (name: string, tool: VscodeLmToolLike) => { dispose: () => void };
}

/**
 * Registers Nibgrid Studio tools into `vscode.lm.registerTool` (`nibgrid_<name>`)
 * when running inside VS Code 1.93+, Cursor, or Google Antigravity IDE.
 */
export function registerNibgridLanguageModelTools(
  vscodeLm: VscodeLmRegistryLike | undefined,
  opts: McpServerOptions = {},
): { dispose: () => void }[] {
  if (!vscodeLm?.registerTool) {
    return [];
  }

  return NIBGRID_MCP_TOOLS.map((spec) =>
    vscodeLm.registerTool!(`nibgrid_${spec.name}`, {
      invoke: async (options) => {
        const resp = await handleMcpJsonRpcRequestAsync(
          {
            jsonrpc: '2.0',
            id: globalThis.crypto.randomUUID(),
            method: 'tools/call',
            params: {
              name: spec.name,
              arguments: options.input ?? {},
            },
          },
          opts,
        );
        const content = (resp?.result?.content as { text?: string }[] | undefined) ?? [];
        const text =
          content[0]?.text ??
          redactHostSecrets(resp?.error?.message ?? 'MCP tool failed', opts.knownSecrets);
        return {
          content: [{ value: text }],
        };
      },
    }),
  );
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(process.argv[1]!).href === import.meta.url;

if (isCliMain && process.argv.includes('--stdio')) {
  startMcpStdioServer(process.stdin, process.stdout);
}
