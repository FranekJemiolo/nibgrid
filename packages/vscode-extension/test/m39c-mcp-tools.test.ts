import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { STUDIO_TOOL_NAMES } from '../../../src/agent/studioToolRegistry';
import {
  handleMcpJsonRpcRequestAsync,
  NIBGRID_MCP_TOOLS,
  registerNibgridLanguageModelTools,
  startMcpStdioServer,
} from '../src/mcpToolServer';

function encodeLspFrame(payload: unknown): string {
  const json = JSON.stringify(payload);
  const bytes = Buffer.byteLength(json, 'utf8');
  return `Content-Length: ${bytes}\r\n\r\n${json}`;
}

function decodeLspFrames(raw: string): Record<string, unknown>[] {
  const results: Record<string, unknown>[] = [];
  let cursor = raw;
  while (cursor.length > 0) {
    const match = /^Content-Length:\s*(\d+)\r?\n\r?\n/i.exec(cursor);
    if (!match) break;
    const bodyStart = match[0].length;
    const len = Number.parseInt(match[1]!, 10);
    const buf = Buffer.from(cursor.slice(bodyStart), 'utf8');
    if (buf.byteLength < len) break;
    const body = buf.subarray(0, len).toString('utf8');
    results.push(JSON.parse(body) as Record<string, unknown>);
    cursor = buf.subarray(len).toString('utf8');
  }
  return results;
}

describe('M39C: MCP Tool Server (Content-Length & NDJSON stdio), Confirmation Gating & vscode.lm Integration', () => {
  it('handles initialize, tools/list, and tools/call over Content-Length & NDJSON duplex streams without crashing on malformed input', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const chunks: string[] = [];
    output.setEncoding('utf8');
    output.on('data', (c: string) => chunks.push(c));

    const executor = vi.fn(async (toolName: string, args: Record<string, unknown>) => {
      if (toolName === 'repalette_sprites' && Array.isArray(args.targetSlugs)) {
        return {
          ok: true,
          updated: args.targetSlugs,
          note: 'Snapped cleanly with key AIzaSyMCP39SECRET and token sk-mcp-leak-999',
        };
      }
      return { ok: true, tool: toolName, args };
    });

    const server = startMcpStdioServer(input, output, {
      toolExecutor: executor,
      knownSecrets: ['custom-secret-token'],
    });

    input.write(encodeLspFrame({ jsonrpc: '2.0', id: 1, method: 'initialize' }));
    input.write(encodeLspFrame({ jsonrpc: '2.0', id: 2, method: 'tools/list' }));
    input.write(
      encodeLspFrame({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'repalette_sprites',
          arguments: { targetSlugs: ['armored_knight'], outlineTintHex: '#1A1C2C' },
        },
      }),
    );

    await new Promise((r) => setTimeout(r, 30));

    const frames = decodeLspFrames(chunks.join(''));
    expect(frames).toHaveLength(3);

    const listTools = (
      frames[1]!.result as { tools: { name: string; inputSchema: { type: string } }[] }
    ).tools;
    for (const m38Tool of STUDIO_TOOL_NAMES) {
      expect(listTools.map((t) => t.name)).toContain(m38Tool);
    }
    expect(listTools.map((t) => t.name)).toContain('run_vertical_slice');
    expect(listTools.every((t) => t.inputSchema.type === 'object')).toBe(true);

    const callText = (frames[2]!.result as { content: { text: string }[] }).content[0]?.text ?? '';
    expect(callText).toContain('armored_knight');
    expect(callText).not.toContain('AIzaSyMCP39SECRET');
    expect(callText).not.toContain('sk-mcp-leak-999');
    expect(callText).toContain('[REDACTED]');

    // Switch to NDJSON invalid args + malformed JSON line
    const ndChunks: string[] = [];
    const ndInput = new PassThrough();
    const ndOutput = new PassThrough();
    ndOutput.setEncoding('utf8');
    ndOutput.on('data', (c: string) => ndChunks.push(c));
    const ndServer = startMcpStdioServer(ndInput, ndOutput);

    ndInput.write('{broken json\n');
    ndInput.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'tools/call',
        params: {
          name: 'add_or_move_socket',
          arguments: { targetSlug: 'knight', socketName: 'INVALID CAPS!' },
        },
      })}\n`,
    );

    await new Promise((r) => setTimeout(r, 30));
    const ndLines = ndChunks
      .join('')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(ndLines[0]?.error).toMatchObject({ code: -32700 });
    expect((ndLines[1]?.result as { isError?: boolean })?.isError).toBe(true);

    server.dispose();
    ndServer.dispose();
  });

  it('gates sync_godot_diff behind explicit confirmation unless confirmed: true or autoConfirmSync: true, and redacts executor errors', async () => {
    const execSpy = vi.fn(async () => ({ synced: true }));

    const gated = await handleMcpJsonRpcRequestAsync(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'sync_godot_diff', arguments: { scope: 'all' } },
      },
      { toolExecutor: execSpy },
    );
    const gatedText = (gated?.result?.content as { text: string }[])[0]!.text;
    expect(JSON.parse(gatedText)).toMatchObject({
      ok: false,
      requiresConfirmation: true,
      synced: false,
    });
    expect(execSpy).not.toHaveBeenCalled();

    const confirmed = await handleMcpJsonRpcRequestAsync(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'sync_godot_diff', arguments: { scope: 'all', confirmed: true } },
      },
      { toolExecutor: execSpy },
    );
    expect(execSpy).toHaveBeenCalledTimes(1);
    const okText = (confirmed?.result?.content as { text: string }[])[0]!.text;
    expect(JSON.parse(okText)).toMatchObject({ synced: true });

    const crashed = await handleMcpJsonRpcRequestAsync(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'run_vertical_slice', arguments: { prompt: 'dungeon boss' } },
      },
      {
        knownSecrets: ['my-super-secret'],
        toolExecutor: async () => {
          throw new Error('Failed using AIzaSyERR39LEAK and my-super-secret!');
        },
      },
    );
    expect(crashed?.result?.isError).toBe(true);
    const errText = (crashed?.result?.content as { text: string }[])[0]!.text;
    expect(errText).not.toContain('AIzaSyERR39LEAK');
    expect(errText).not.toContain('my-super-secret');
    expect(errText).toContain('[REDACTED]');
  });

  it('registers all 9 tools via registerNibgridLanguageModelTools on mocked vscode.lm', async () => {
    const registered = new Map<
      string,
      {
        invoke: (opts: {
          input: Record<string, unknown>;
        }) => Promise<{ content: readonly { value: string }[] }>;
      }
    >();
    const disposables = registerNibgridLanguageModelTools(
      {
        registerTool: (name, impl) => {
          registered.set(name, impl);
          return { dispose: () => undefined };
        },
      },
      { autoConfirmSync: true },
    );

    expect(disposables).toHaveLength(NIBGRID_MCP_TOOLS.length);
    expect(registered.has('nibgrid_recompute_colliders')).toBe(true);
    expect(registered.has('nibgrid_run_vertical_slice')).toBe(true);

    const out = await registered.get('nibgrid_recompute_colliders')!.invoke({
      input: { targetSlug: 'armored_knight', kind: 'convex-hull' },
    });
    expect(out.content[0]?.value).toContain('armored_knight');
  });
});
