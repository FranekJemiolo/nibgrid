import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { EntityDefinition } from '../../../src/domain/entitySchema';
import type { ArtDirectorQaReport } from '../../../src/processing/artDirectorQaSchema';
import type { StoredRoomRecord } from '../../../src/processing/roomLayoutCore';
import {
  buildNibgridWebviewHtml,
  NIBGRID_CUSTOM_EDITOR_VIEW_TYPES,
  registerNibgridCustomEditors,
  type VscodeCustomTextEditorProviderLike,
} from '../src/customEditors';
import {
  activateNibgridExtension,
  createKeychainSecretStore,
  runGodotWorkspaceScene,
  type ExecFileLike,
} from '../src/extension';
import {
  DiagnosticSeverityValue,
  EntitiesTreeProvider,
  publishQaDiagnostics,
  RoomsTreeProvider,
  VisualQaTreeProvider,
  type VscodeDiagnosticLike,
} from '../src/treeProviders';
import { dispatchHostRpcRequest } from '../src/vscodeHostBridge';

describe('M39B: VS Code Extension Host, Custom Editors, Activity Bar Trees & Safe Godot Runner', () => {
  it('stores API keys exclusively in context.secrets SecretStorage, never workspaceState, and scrubs RPC errors', async () => {
    const secretMap = new Map<string, string>();
    const workspaceStateWrites: string[] = [];

    const secretStorage = {
      get: async (key: string) => secretMap.get(key),
      store: async (key: string, val: string) => {
        secretMap.set(key, val);
      },
      delete: async (key: string) => {
        secretMap.delete(key);
      },
    };

    const keychain = createKeychainSecretStore(secretStorage);
    await keychain.setSecret('nibgrid.secret.gemini', 'AIzaSyKEYCHAIN39TOKEN');
    expect(await keychain.getSecret('nibgrid.secret.gemini')).toBe('AIzaSyKEYCHAIN39TOKEN');
    expect(workspaceStateWrites).toEqual([]);

    const errorResp = await dispatchHostRpcRequest(
      { id: 'err-1', method: 'readFile', params: { path: 'missing.txt' } },
      {
        readFile: async () => {
          throw new Error('Upstream failure using AIzaSyKEYCHAIN39TOKEN in header');
        },
        getSecret: keychain.getSecret,
        setSecret: keychain.setSecret,
        deleteSecret: keychain.deleteSecret,
        detectAntigravity: async () => ({ detected: false, configDir: '~/.gemini/config' }),
        linkAntigravityMcp: async () => ({ ok: true, configPath: '', message: 'ok' }),
        notify: () => undefined,
      },
      { knownSecrets: keychain.getKnownSecrets() },
    );

    expect(errorResp.error).not.toContain('AIzaSyKEYCHAIN39TOKEN');
    expect(errorResp.error).toContain('[REDACTED]');

    await keychain.deleteSecret('nibgrid.secret.gemini');
    expect(await keychain.getSecret('nibgrid.secret.gemini')).toBeNull();
  });

  it('registers Custom Editors (.nibgrid.json, .gdshader, .room.json) with strict CSP nonces & RPC bridge', async () => {
    const registered = new Map<string, VscodeCustomTextEditorProviderLike>();
    const postedToWebview: unknown[] = [];
    let receiveHandler: ((msg: unknown) => unknown) | null = null;

    const disposables = registerNibgridCustomEditors(
      {
        registerCustomEditorProvider: (viewType, provider) => {
          registered.set(viewType, provider);
          return { dispose: () => undefined };
        },
      },
      {
        getSecret: async () => 'hidden-key',
        setSecret: async () => undefined,
        deleteSecret: async () => undefined,
        detectAntigravity: async () => ({ detected: true, configDir: '~/.gemini/config' }),
        linkAntigravityMcp: async () => ({ ok: true, configPath: 'c', message: 'linked' }),
        notify: () => undefined,
      },
      { nonceFactory: () => 'nonce39btest' },
    );

    expect(disposables).toHaveLength(3);
    expect(Array.from(registered.keys())).toEqual([
      NIBGRID_CUSTOM_EDITOR_VIEW_TYPES.spriteRecipe,
      NIBGRID_CUSTOM_EDITOR_VIEW_TYPES.gdshader,
      NIBGRID_CUSTOM_EDITOR_VIEW_TYPES.roomBlueprint,
    ]);

    const shaderProvider = registered.get(NIBGRID_CUSTOM_EDITOR_VIEW_TYPES.gdshader)!;
    const webview = {
      html: '',
      cspSource: 'vscode-webview://test',
      postMessage: async (m: unknown) => {
        postedToWebview.push(m);
        return true;
      },
      onDidReceiveMessage: (fn: (m: unknown) => unknown) => {
        receiveHandler = fn;
        return { dispose: () => undefined };
      },
    };
    await shaderProvider.resolveCustomTextEditor(
      {
        uri: {
          fsPath: '/workspace/flash.gdshader',
          toString: () => 'file:///workspace/flash.gdshader',
        },
        getText: () => 'shader_type canvas_item;',
      },
      { webview, onDidDispose: () => ({ dispose: () => undefined }) },
    );

    expect(webview.html).toContain(`default-src 'none'`);
    expect(webview.html).toContain(`script-src 'nonce-nonce39btest'`);
    expect(webview.html).toContain('acquireVsCodeApi()');

    // Verify </script> XSS escaping inside initial payload
    const xssHtml = buildNibgridWebviewHtml({
      cspSource: 'vscode-webview://x',
      nonce: 'abc123',
      scriptUri: 'app.js',
      editorMode: 'sprite-recipe',
      documentPath: 'hero.nibgrid.json',
      initialPayloadJson: '{"note":"</script><script>alert(1)</script>"}',
    });
    expect(xssHtml).not.toContain('</script><script>');

    await receiveHandler!({ id: 'rpc-detect', method: 'detectAntigravity', params: {} });
    expect(postedToWebview[0]).toEqual({
      id: 'rpc-detect',
      ok: true,
      result: { detected: true, configDir: '~/.gemini/config' },
    });
  });

  it('builds Entities, Rooms & Visual QA TreeProviders and populates Problems Diagnostics without pass items', () => {
    const entity: EntityDefinition = {
      id: 'ent-1',
      projectId: 'proj-1',
      slug: 'armored_knight',
      displayName: 'Armored Knight',
      bodyType: 'CharacterBody2D',
      resSubpath: 'assets/nibgrid',
      clips: [{ name: 'idle', spriteNodeId: 's-1', fps: 8, loop: true }],
      primarySpriteNodeId: 's-1',
      audioAssetIds: [],
      includeNormalMap: false,
      updatedAt: 100,
    };
    const room: StoredRoomRecord = {
      id: 'room-1',
      projectId: 'proj-1',
      slug: 'boss_arena',
      tileSetNodeId: null,
      tileSetMode: 'blob47',
      parallaxNodeId: null,
      updatedAt: 200,
      blueprint: {
        slug: 'boss_arena',
        displayName: 'Boss Arena',
        prompt: 'stone arena',
        cols: 16,
        rows: 10,
        tileSizePx: 16,
        cells: Array.from({ length: 10 }, () => Array.from({ length: 16 }, () => 0 as const)),
        playerSpawn: { cellX: 2, cellY: 7 },
        entities: [{ id: 'sp-1', entitySlug: 'armored_knight', cellX: 8, cellY: 7 }],
      },
    };
    const report: ArtDirectorQaReport = {
      sheetHash: 'abc123',
      overallScore: 78,
      globalNotes: 'Knight light matches; slime highlight shifted.',
      createdAt: 300,
      findings: [
        {
          indexLabel: '01',
          spriteId: 'sprite-knight',
          severity: 'pass',
          category: 'style-drift',
          summary: 'Clean palette match',
          suggestedFix: 'micro-editor',
        },
        {
          indexLabel: '02',
          spriteId: 'sprite-slime',
          severity: 'warn',
          category: 'light-angle',
          summary: 'Highlight flipped using secret AIzaSyDIAG39KEY',
          suggestedFix: 'post-process',
        },
        {
          indexLabel: '03',
          spriteId: 'sprite-goblin',
          severity: 'fail',
          category: 'silhouette-readability',
          summary: 'Muddy silhouette at 1x scale',
          suggestedFix: 'sandbox-1x',
        },
      ],
    };

    const entitiesTree = new EntitiesTreeProvider([entity]);
    const entityRoots = entitiesTree.getChildren();
    expect(entityRoots[0]?.item.label).toBe('Armored Knight');
    expect(entitiesTree.getChildren(entityRoots[0])).toHaveLength(1);

    const roomsTree = new RoomsTreeProvider([room]);
    const roomRoots = roomsTree.getChildren();
    expect(roomRoots[0]?.item.label).toBe('Boss Arena');
    expect(roomsTree.getChildren(roomRoots[0])[0]?.item.label).toBe('@armored_knight');

    const qaTree = new VisualQaTreeProvider(report);
    const qaRoots = qaTree.getChildren();
    expect(qaRoots[0]?.item.label).toContain('78/100');
    expect(qaTree.getChildren(qaRoots[0])).toHaveLength(3);

    const diagnosticsStore = new Map<string, readonly VscodeDiagnosticLike[]>();
    let clearedCount = 0;
    const stats = publishQaDiagnostics(
      {
        clear: () => {
          clearedCount += 1;
          diagnosticsStore.clear();
        },
        set: (uri, diags) => {
          diagnosticsStore.set(uri, diags);
        },
      },
      report,
      (spriteId) => `file:///workspace/res/sprites/${spriteId}.png`,
    );

    expect(clearedCount).toBe(1);
    expect(stats).toEqual({ publishedFiles: 2, errorCount: 1, warningCount: 1 });
    expect(diagnosticsStore.has('file:///workspace/res/sprites/sprite-knight.png')).toBe(false);
    const slimeDiags = diagnosticsStore.get('file:///workspace/res/sprites/sprite-slime.png')!;
    expect(slimeDiags[0]?.severity).toBe(DiagnosticSeverityValue.Warning);
    expect(slimeDiags[0]?.message).not.toContain('AIzaSyDIAG39KEY');
    expect(slimeDiags[0]?.message).toContain('[REDACTED]');
    const goblinDiags = diagnosticsStore.get('file:///workspace/res/sprites/sprite-goblin.png')!;
    expect(goblinDiags[0]?.severity).toBe(DiagnosticSeverityValue.Error);
  });

  it('launches Godot via execFile with exact [--path, workspace, res://main.tscn], blocks unsafe inputs & cancels on disposal', () => {
    const execCalls: { file: string; args: readonly string[] }[] = [];
    const killSpy = vi.fn(() => true);
    const mockExecFile: ExecFileLike = (file, args) => {
      execCalls.push({ file, args });
      return { pid: 9001, kill: killSpy };
    };

    const subscriptions: { dispose: () => void }[] = [];
    const commands = new Map<string, () => unknown>();

    const res = activateNibgridExtension(
      {
        secrets: {
          get: async () => undefined,
          store: async () => undefined,
          delete: async () => undefined,
        },
        subscriptions,
      },
      {
        registerCommand: (cmd, cb) => {
          commands.set(cmd, cb);
          return { dispose: () => undefined };
        },
        openNibgridPanel: () => undefined,
        showMessage: () => undefined,
      },
      {
        workspacePath: './godot_demo',
        execFileImpl: mockExecFile,
        detectAntigravity: async () => ({ detected: false, configDir: '~/.gemini/config' }),
        linkAntigravityMcp: async () => ({ ok: true, configPath: 'c', message: 'ok' }),
      },
    );

    expect(res.registeredCommands).toEqual([
      'nibgrid.openStudio',
      'nibgrid.syncGodot',
      'nibgrid.runGodotSlice',
      'nibgrid.linkAntigravity',
    ]);

    commands.get('nibgrid.runGodotSlice')!();
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual({
      file: 'godot',
      args: ['--path', resolve('./godot_demo'), 'res://main.tscn'],
    });

    expect(() =>
      runGodotWorkspaceScene({
        workspacePath: './godot_demo',
        scenePath: 'res://../secret.tscn',
        execFileImpl: mockExecFile,
      }),
    ).toThrow(/Invalid Godot/);

    expect(() =>
      runGodotWorkspaceScene({
        workspacePath: './godot_demo',
        godotBinary: 'godot; rm -rf /',
        execFileImpl: mockExecFile,
      }),
    ).toThrow(/Unsafe Godot/);

    // Disposing extension cleanly kills tracked child processes
    for (const sub of subscriptions) sub.dispose();
    expect(killSpy).toHaveBeenCalledWith('SIGTERM');
  });
});
