import { z } from 'zod';

export const ModelTaskKindSchema = z.enum([
  'planning-composer',
  'sprite-inpaint',
  'vision-qa',
  'audio',
]);
export type ModelTaskKind = z.infer<typeof ModelTaskKindSchema>;

export const AntigravityAcpProfileSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('antigravity-acp'),
  displayName: z.string().min(1),
  command: z.string().min(1).default('antigravity'),
  args: z.array(z.string()).default(['acp']),
  configDir: z.string().min(1).default('~/.gemini/config'),
  model: z.string().min(1).default('gemini-2.5-flash'),
});

export const LiteRtLocalProfileSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('litert-local'),
  displayName: z.string().min(1),
  modelPath: z.string().min(1).default('models/gemma-4-26b.litertlm'),
  port: z.number().int().min(1024).max(65535).default(8765),
  accelerator: z.enum(['metal', 'cuda', 'cpu']).default('metal'),
});

export const OpenAiCompatibleProfileSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('openai-compatible'),
  displayName: z.string().min(1),
  baseUrl: z.string().url().default('http://127.0.0.1:11434/v1'),
  model: z.string().min(1).default('qwen2.5-coder:14b'),
  apiKeySecretRef: z.string().min(1).optional(),
});

export const ComfyUiLocalProfileSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('comfyui-local'),
  displayName: z.string().min(1),
  baseUrl: z.string().url().default('http://127.0.0.1:8188'),
  workflowId: z.string().min(1).default('pixel_sprite_controlnet'),
});

export const CloudByokProfileSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('cloud-byok'),
  displayName: z.string().min(1),
  provider: z.enum(['gemini', 'anthropic', 'openai', 'openrouter']),
  model: z.string().min(1),
  secretKeyRef: z.string().min(1),
});

export const OfflineMockProfileSchema = z.object({
  id: z.string().min(1),
  kind: z.literal('offline-mock'),
  displayName: z.string().min(1),
});

export const ModelProviderProfileSchema = z.discriminatedUnion('kind', [
  AntigravityAcpProfileSchema,
  LiteRtLocalProfileSchema,
  OpenAiCompatibleProfileSchema,
  ComfyUiLocalProfileSchema,
  CloudByokProfileSchema,
  OfflineMockProfileSchema,
]);
export type ModelProviderProfile = z.infer<typeof ModelProviderProfileSchema>;

export const TaskRouteRuleSchema = z.object({
  primaryId: z.string().min(1),
  fallbacks: z.array(z.string().min(1)).default(['offline-mock']),
});
export type TaskRouteRule = z.infer<typeof TaskRouteRuleSchema>;

export const TaskRoutingTableSchema = z.object({
  'planning-composer': TaskRouteRuleSchema,
  'sprite-inpaint': TaskRouteRuleSchema,
  'vision-qa': TaskRouteRuleSchema,
  audio: TaskRouteRuleSchema,
});
export type TaskRoutingTable = z.infer<typeof TaskRoutingTableSchema>;

export const DEFAULT_OFFLINE_MOCK_PROFILE: ModelProviderProfile = {
  id: 'offline-mock',
  kind: 'offline-mock',
  displayName: 'Offline Procedural / Mock ($0.00)',
};

export function createDefaultModelProfiles(): ModelProviderProfile[] {
  return [
    {
      id: 'antigravity-acp',
      kind: 'antigravity-acp',
      displayName: 'Google Antigravity (ACP / MCP)',
      command: 'antigravity',
      args: ['acp'],
      configDir: '~/.gemini/config',
      model: 'gemini-2.5-flash',
    },
    {
      id: 'litert-local',
      kind: 'litert-local',
      displayName: 'On-Device LiteRT (Gemma 4)',
      modelPath: 'models/gemma-4-26b.litertlm',
      port: 8765,
      accelerator: 'metal',
    },
    {
      id: 'ollama-local',
      kind: 'openai-compatible',
      displayName: 'Ollama / LM Studio (Local OpenAI API)',
      baseUrl: 'http://127.0.0.1:11434/v1',
      model: 'qwen2.5-coder:14b',
    },
    {
      id: 'comfyui-local',
      kind: 'comfyui-local',
      displayName: 'Local ComfyUI (127.0.0.1:8188)',
      baseUrl: 'http://127.0.0.1:8188',
      workflowId: 'pixel_sprite_controlnet',
    },
    {
      id: 'gemini-cloud',
      kind: 'cloud-byok',
      displayName: 'Gemini Cloud BYOK (Keychain)',
      provider: 'gemini',
      model: 'gemini-2.5-flash',
      secretKeyRef: 'nibgrid.secret.gemini',
    },
    DEFAULT_OFFLINE_MOCK_PROFILE,
  ];
}

export function createDefaultTaskRoutingTable(): TaskRoutingTable {
  return {
    'planning-composer': {
      primaryId: 'antigravity-acp',
      fallbacks: ['litert-local', 'ollama-local', 'gemini-cloud', 'offline-mock'],
    },
    'sprite-inpaint': {
      primaryId: 'comfyui-local',
      fallbacks: ['antigravity-acp', 'gemini-cloud', 'offline-mock'],
    },
    'vision-qa': {
      primaryId: 'gemini-cloud',
      fallbacks: ['antigravity-acp', 'litert-local', 'offline-mock'],
    },
    audio: {
      primaryId: 'gemini-cloud',
      fallbacks: ['offline-mock'],
    },
  };
}

export interface ResolvedModelRoute {
  readonly task: ModelTaskKind;
  readonly profile: ModelProviderProfile;
  readonly usedFallback: boolean;
  readonly triedIds: readonly string[];
}

/**
 * Deterministically selects the best available provider for `task` by checking `primaryId`,
 * stepping through `fallbacks`, and always terminating cleanly at `offline-mock` (`$0.00`).
 */
export function resolveModelRoute(
  task: ModelTaskKind,
  routingTable: TaskRoutingTable,
  profiles: readonly ModelProviderProfile[],
  availability: Readonly<Record<string, boolean>>,
): ResolvedModelRoute {
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const rule = routingTable[task];
  const candidates = [rule.primaryId, ...rule.fallbacks, 'offline-mock'];
  const triedIds: string[] = [];
  const seen = new Set<string>();

  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    triedIds.push(id);

    const prof = byId.get(id);
    if (!prof) continue;

    if (prof.kind === 'offline-mock' || availability[id] === true) {
      return {
        task,
        profile: prof,
        usedFallback: id !== rule.primaryId,
        triedIds,
      };
    }
  }

  return {
    task,
    profile: byId.get('offline-mock') ?? DEFAULT_OFFLINE_MOCK_PROFILE,
    usedFallback: rule.primaryId !== 'offline-mock',
    triedIds,
  };
}

const SECRET_TOKEN_REGEXES: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{6,}/g,
  /sk-[0-9A-Za-z_-]{6,}/g,
  /nbg_[0-9A-Za-z_-]{6,}/g,
  /Bearer\s+[0-9A-Za-z._-]{6,}/gi,
];

/**
 * Scrubs explicit secret strings and standard credential patterns without altering normal prose.
 */
export function redactSecretsInText(input: string, secrets: readonly string[] = []): string {
  let out = input;
  for (const raw of secrets) {
    const clean = raw.trim();
    if (clean.length >= 4) {
      out = out.split(clean).join('[REDACTED]');
    }
  }
  for (const rx of SECRET_TOKEN_REGEXES) {
    out = out.replace(rx, '[REDACTED]');
  }
  return out;
}

export interface ProviderHealthStatus {
  readonly providerId: string;
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly message: string;
}

/**
 * Probing helper usable offline/in-Node with optional injected `fetchImpl`; never throws or leaks secrets.
 */
export async function probeModelProviderHealth(
  profile: ModelProviderProfile,
  opts: {
    readonly fetchImpl?: typeof fetch;
    readonly secrets?: readonly string[];
    readonly antigravityDetected?: boolean;
  } = {},
): Promise<ProviderHealthStatus> {
  const start = Date.now();
  if (profile.kind === 'offline-mock') {
    return {
      providerId: profile.id,
      ok: true,
      latencyMs: 0,
      message: 'Always ready ($0.00 deterministic offline fallback)',
    };
  }
  if (profile.kind === 'antigravity-acp') {
    const ok = Boolean(opts.antigravityDetected);
    return {
      providerId: profile.id,
      ok,
      latencyMs: Date.now() - start,
      message: ok ? 'Antigravity MCP/ACP ready' : 'Antigravity CLI/config not linked',
    };
  }
  if (profile.kind === 'cloud-byok') {
    const hasSecret = (opts.secrets ?? []).some((s) => s.trim().length > 0);
    return {
      providerId: profile.id,
      ok: hasSecret,
      latencyMs: Date.now() - start,
      message: hasSecret ? `${profile.provider} key stored securely` : 'No API key configured',
    };
  }

  const probeUrl =
    profile.kind === 'litert-local'
      ? `http://127.0.0.1:${profile.port}/health`
      : profile.kind === 'comfyui-local'
        ? `${profile.baseUrl.replace(/\/+$/, '')}/system_stats`
        : `${profile.baseUrl.replace(/\/+$/, '')}/models`;

  if (!opts.fetchImpl) {
    return {
      providerId: profile.id,
      ok: false,
      latencyMs: 0,
      message: 'Offline (health check skipped)',
    };
  }

  try {
    const res = await opts.fetchImpl(probeUrl, { method: 'GET' });
    return {
      providerId: profile.id,
      ok: res.ok,
      latencyMs: Date.now() - start,
      message: res.ok ? `Reachable (HTTP ${res.status})` : `HTTP ${res.status}`,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unreachable';
    return {
      providerId: profile.id,
      ok: false,
      latencyMs: Date.now() - start,
      message: redactSecretsInText(msg, opts.secrets),
    };
  }
}
