import { dispatchHostRpcRequest, type HostBridgeHandlers } from './vscodeHostBridge';
import { NIBGRID_MCP_TOOLS } from './mcpToolServer';

export interface VscodeSecretStorageLike {
  get: (key: string) => Promise<string | undefined>;
  store: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export interface VscodeExtensionContextLike {
  readonly secrets: VscodeSecretStorageLike;
  readonly subscriptions: { dispose: () => void }[];
}

export interface VscodeHostApiLike {
  registerCommand: (command: string, callback: () => unknown) => { dispose: () => void };
  openNibgridPanel: (onMessage: (raw: unknown) => Promise<unknown>) => void;
  runTerminalCommand: (command: string, cwd?: string) => void;
  showMessage: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/**
 * Pure TypeScript VS Code / Cursor / Nibgrid Desktop Extension Host activation wiring
 * (zero direct `@types/vscode` compile-time lock-in).
 */
export function activateNibgridExtension(
  context: VscodeExtensionContextLike,
  hostApi: VscodeHostApiLike,
  antigravityHandlers: Pick<HostBridgeHandlers, 'detectAntigravity' | 'linkAntigravityMcp'>,
): { readonly registeredCommands: readonly string[]; readonly mcpToolCount: number } {
  const handlers: HostBridgeHandlers = {
    getSecret: async (key) => (await context.secrets.get(key)) ?? null,
    setSecret: async (key, value) => context.secrets.store(key, value),
    deleteSecret: async (key) => context.secrets.delete(key),
    detectAntigravity: antigravityHandlers.detectAntigravity,
    linkAntigravityMcp: antigravityHandlers.linkAntigravityMcp,
    runGodotSlice: async ({ workspacePath }) => {
      hostApi.runTerminalCommand('godot --path . res://main.tscn', workspacePath);
      return { launched: true };
    },
    notify: (level, message) => hostApi.showMessage(level, message),
  };

  const registeredCommands = [
    'nibgrid.openStudio',
    'nibgrid.runGodotSlice',
    'nibgrid.linkAntigravity',
  ];

  context.subscriptions.push(
    hostApi.registerCommand('nibgrid.openStudio', () => {
      hostApi.openNibgridPanel((raw) => dispatchHostRpcRequest(raw, handlers));
    }),
    hostApi.registerCommand('nibgrid.runGodotSlice', () => {
      hostApi.runTerminalCommand('godot --path . res://main.tscn');
    }),
    hostApi.registerCommand('nibgrid.linkAntigravity', async () => {
      const res = await antigravityHandlers.linkAntigravityMcp({});
      hostApi.showMessage(res.ok ? 'info' : 'error', res.message);
    }),
  );

  return {
    registeredCommands,
    mcpToolCount: NIBGRID_MCP_TOOLS.length,
  };
}
