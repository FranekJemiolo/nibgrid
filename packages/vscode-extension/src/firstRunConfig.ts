import { z } from 'zod';
import {
  TaskRoutingTableSchema,
  createDefaultTaskRoutingTable,
  redactSecretsInText,
} from '../../model-router/src/routerCore';

export const LOCAL_STUDIO_CONFIG_SCHEMA_VERSION = '1.0.0' as const;

const UNSAFE_GODOT_BIN_CHARS = /[;&|$`<>!\n\r\0]/;

export const LocalPreferredProviderSchema = z.enum([
  'antigravity-acp',
  'litert-local',
  'ollama-local',
  'comfyui-local',
  'offline-mock',
]);
export type LocalPreferredProvider = z.infer<typeof LocalPreferredProviderSchema>;

export const LocalStudioConfigSchema = z.object({
  schemaVersion: z
    .literal(LOCAL_STUDIO_CONFIG_SCHEMA_VERSION)
    .default(LOCAL_STUDIO_CONFIG_SCHEMA_VERSION),
  preferredLocalProvider: LocalPreferredProviderSchema.default('antigravity-acp'),
  taskRoutingTable: TaskRoutingTableSchema.default(createDefaultTaskRoutingTable),
  godotBinaryPath: z
    .string()
    .trim()
    .min(1)
    .max(260)
    .refine(
      (val) => !UNSAFE_GODOT_BIN_CHARS.test(val),
      'Godot binary path contains unsafe shell characters.',
    )
    .default('godot'),
  defaultResSyncSubdir: z
    .string()
    .trim()
    .min(1)
    .max(160)
    .refine(
      (val) =>
        !val.includes('\0') &&
        !val.includes('..') &&
        !val.startsWith('/') &&
        !val.startsWith('\\') &&
        !/^[A-Za-z]:/.test(val),
      'defaultResSyncSubdir must be a safe workspace-relative path.',
    )
    .default('assets/nibgrid'),
  autoLinkAntigravityMcp: z.boolean().default(true),
  offlineMockFallback: z.literal(true).default(true),
});
export type LocalStudioConfig = z.infer<typeof LocalStudioConfigSchema>;

const SECRET_KEY_PATTERN =
  /(api[_-]?key|token|secret|password|passwd|auth|credential|private[_-]?key)/i;

/**
 * Recursively clones plain JSON objects while dropping any accidental credential keys
 * before validation or portable settings export.
 */
export function stripSecretFieldsDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripSecretFieldsDeep(item));
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (SECRET_KEY_PATTERN.test(k)) {
      continue;
    }
    out[k] = stripSecretFieldsDeep(v);
  }
  return out;
}

export function createDefaultLocalStudioConfig(): LocalStudioConfig {
  return LocalStudioConfigSchema.parse({});
}

export function validateLocalStudioConfig(raw: unknown): LocalStudioConfig {
  const sanitized = stripSecretFieldsDeep(raw ?? {});
  return LocalStudioConfigSchema.parse(sanitized);
}

/**
 * Serializes local Studio preferences (`nibgrid.settings.json`) while stripping secret keys
 * and scrubbing embedded credential patterns so the file can be safely shared in Git.
 */
export function exportPortableSettingsJson(config: unknown): string {
  const validated = validateLocalStudioConfig(config);
  const pretty = `${JSON.stringify(validated, null, 2)}\n`;
  return redactSecretsInText(pretty);
}

/**
 * Parses and validates portable `nibgrid.settings.json`, stripping any accidentally injected
 * credential keys and redacting tokens from validation errors.
 */
export function importPortableSettingsJson(jsonText: string): LocalStudioConfig {
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return validateLocalStudioConfig(parsed);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Invalid nibgrid.settings.json payload.';
    throw new Error(redactSecretsInText(msg));
  }
}
