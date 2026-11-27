import { z } from 'zod';

export const HostRpcMethodSchema = z.enum([
  'fs.readText',
  'fs.writeText',
  'secrets.get',
  'secrets.set',
  'secrets.delete',
  'antigravity.detect',
  'antigravity.linkMcp',
  'godot.runSlice',
  'ui.notify',
]);
export type HostRpcMethod = z.infer<typeof HostRpcMethodSchema>;

export const HostRpcRequestSchema = z.object({
  id: z.string().min(1),
  method: HostRpcMethodSchema,
  params: z.record(z.string(), z.unknown()).default({}),
});
export type HostRpcRequest = z.infer<typeof HostRpcRequestSchema>;

export const HostRpcResponseSchema = z.object({
  id: z.string().min(1),
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type HostRpcResponse = z.infer<typeof HostRpcResponseSchema>;

export interface HostBridgeHandlers {
  readonly readText?: (relativePath: string) => Promise<string>;
  readonly writeText?: (relativePath: string, content: string) => Promise<void>;
  readonly getSecret: (key: string) => Promise<string | null>;
  readonly setSecret: (key: string, value: string) => Promise<void>;
  readonly deleteSecret: (key: string) => Promise<void>;
  readonly detectAntigravity: () => Promise<{ detected: boolean; configDir: string }>;
  readonly linkAntigravityMcp: (opts: { configDir?: string; workspacePath?: string }) => Promise<{
    ok: boolean;
    configPath: string;
    backupPath?: string;
    message: string;
  }>;
  readonly runGodotSlice: (opts: { workspacePath?: string }) => Promise<{ launched: boolean }>;
  readonly notify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

/**
 * Dispatches a typed Webview -> Extension Host RPC message cleanly with error catching.
 */
export async function dispatchHostRpcRequest(
  rawReq: unknown,
  handlers: HostBridgeHandlers,
): Promise<HostRpcResponse> {
  const parsed = HostRpcRequestSchema.safeParse(rawReq);
  if (!parsed.success) {
    return {
      id:
        typeof rawReq === 'object' && rawReq !== null && 'id' in rawReq
          ? String((rawReq as { id: unknown }).id)
          : 'unknown',
      error: `Invalid RPC request: ${parsed.error.issues[0]?.message ?? 'schema error'}`,
    };
  }

  const { id, method, params } = parsed.data;
  try {
    switch (method) {
      case 'secrets.get':
        return { id, result: await handlers.getSecret(String(params.key ?? '')) };
      case 'secrets.set':
        await handlers.setSecret(String(params.key ?? ''), String(params.value ?? ''));
        return { id, result: true };
      case 'secrets.delete':
        await handlers.deleteSecret(String(params.key ?? ''));
        return { id, result: true };
      case 'antigravity.detect':
        return { id, result: await handlers.detectAntigravity() };
      case 'antigravity.linkMcp':
        return {
          id,
          result: await handlers.linkAntigravityMcp({
            ...(typeof params.configDir === 'string' ? { configDir: params.configDir } : {}),
            ...(typeof params.workspacePath === 'string'
              ? { workspacePath: params.workspacePath }
              : {}),
          }),
        };
      case 'godot.runSlice':
        return {
          id,
          result: await handlers.runGodotSlice({
            ...(typeof params.workspacePath === 'string'
              ? { workspacePath: params.workspacePath }
              : {}),
          }),
        };
      case 'fs.readText':
        if (!handlers.readText) throw new Error('fs.readText not mounted');
        return { id, result: await handlers.readText(String(params.path ?? '')) };
      case 'fs.writeText':
        if (!handlers.writeText) throw new Error('fs.writeText not mounted');
        await handlers.writeText(String(params.path ?? ''), String(params.content ?? ''));
        return { id, result: true };
      case 'ui.notify':
        handlers.notify(
          params.level === 'warn' || params.level === 'error' ? params.level : 'info',
          String(params.message ?? ''),
        );
        return { id, result: true };
    }
  } catch (err) {
    return {
      id,
      error: err instanceof Error ? err.message : 'Host RPC handler failed',
    };
  }
}
