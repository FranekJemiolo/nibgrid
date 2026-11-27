import { describe, expect, it } from 'vitest';
import {
  createDefaultModelProfiles,
  createDefaultTaskRoutingTable,
  redactSecretsInText,
  resolveModelRoute,
} from '../src/routerCore';
import {
  handleMcpJsonRpcRequest,
  NIBGRID_MCP_TOOLS,
} from '../../vscode-extension/src/mcpToolServer';

describe('M40A: Pure-TS ModelRouter, Fallback Routing, Secret Redaction & VS Code MCP Tools', () => {
  it('resolveModelRoute prefers antigravity-acp, falls back to ollama-local, and always falls back cleanly to offline-mock', () => {
    const profiles = createDefaultModelProfiles();
    const table = createDefaultTaskRoutingTable();

    // 1. Primary available -> selects antigravity-acp
    const direct = resolveModelRoute('planning-composer', table, profiles, {
      'antigravity-acp': true,
      'ollama-local': true,
    });
    expect(direct.profile.kind).toBe('antigravity-acp');
    expect(direct.usedFallback).toBe(false);

    // 2. Antigravity & LiteRT offline, Ollama online -> falls back to openai-compatible
    const ollamaFallback = resolveModelRoute('planning-composer', table, profiles, {
      'antigravity-acp': false,
      'litert-local': false,
      'ollama-local': true,
    });
    expect(ollamaFallback.profile.id).toBe('ollama-local');
    expect(ollamaFallback.profile.kind).toBe('openai-compatible');
    expect(ollamaFallback.usedFallback).toBe(true);

    // 3. All external providers offline -> guarantees $0.00 offline-mock without throwing
    const offline = resolveModelRoute('planning-composer', table, profiles, {});
    expect(offline.profile.kind).toBe('offline-mock');
    expect(offline.usedFallback).toBe(true);
  });

  it('redactSecretsInText strips AIzaSyROUTER999 and sk-test-secret-123 cleanly without mutating prose', () => {
    const raw =
      'Local router error while contacting endpoint with key AIzaSyROUTER999 and token sk-test-secret-123.';
    const redacted = redactSecretsInText(raw, ['AIzaSyROUTER999', 'sk-test-secret-123']);
    expect(redacted).not.toContain('AIzaSyROUTER999');
    expect(redacted).not.toContain('sk-test-secret-123');
    expect(redacted).toContain('Local router error while contacting endpoint with key');
  });

  it('MCP Tool Server exposes all 9 Nibgrid Studio & Vertical Slice tools over JSON-RPC 2.0', () => {
    const init = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 1, method: 'initialize' });
    expect(init.error).toBeUndefined();
    expect(init.result).toHaveProperty('protocolVersion');

    const listed = handleMcpJsonRpcRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const tools = (listed.result?.tools ?? []) as { name: string }[];
    expect(tools).toHaveLength(NIBGRID_MCP_TOOLS.length);
    expect(tools.map((t) => t.name)).toContain('run_vertical_slice');
    expect(tools.map((t) => t.name)).toContain('repalette_sprites');
  });
});
