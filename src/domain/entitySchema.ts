import { z } from 'zod';
import { ShaderConfigSchema } from './schemas';

export const GodotBodyTypeSchema = z.enum([
  'CharacterBody2D',
  'StaticBody2D',
  'Area2D',
  'RigidBody2D',
  'Node2D',
]);
export type GodotBodyType = z.infer<typeof GodotBodyTypeSchema>;

export const EntityAnimationClipSchema = z.object({
  name: z.string().trim().min(1).max(64),
  spriteNodeId: z.string().min(1),
  fps: z.number().min(1).max(60).default(8),
  loop: z.boolean().default(true),
  frameAudioTriggers: z.record(z.string().regex(/^\d+$/), z.string().min(1)).optional(),
});
export type EntityAnimationClip = z.infer<typeof EntityAnimationClipSchema>;

export const EntityDefinitionSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  slug: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9_]+$/, 'Entity slug must use lowercase letters, digits, or underscores'),
  displayName: z.string().trim().min(1).max(80),
  bodyType: GodotBodyTypeSchema.default('CharacterBody2D'),
  resSubpath: z.string().trim().min(1).max(160).default('assets/nibgrid'),
  clips: z.array(EntityAnimationClipSchema).default([]),
  primarySpriteNodeId: z.string().min(1),
  audioAssetIds: z.array(z.string().min(1)).default([]),
  includeNormalMap: z.boolean().default(false),
  scriptResPath: z.string().trim().min(1).max(200).optional(),
  scriptContent: z.string().max(64000).optional(),
  shaderConfig: ShaderConfigSchema.optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type EntityDefinition = z.infer<typeof EntityDefinitionSchema>;

export const GodotSyncTargetMetaSchema = z.object({
  projectId: z.string().min(1),
  folderName: z.string().trim().min(1).max(160),
  lastSyncedHashes: z.record(z.string(), z.string()).default({}),
  lastSyncedAt: z.number().int().nonnegative().nullable().default(null),
});
export type GodotSyncTargetMeta = z.infer<typeof GodotSyncTargetMetaSchema>;

export interface FileSystemWritableLike {
  write: (data: BufferSource | Blob | string) => Promise<void>;
  close: () => Promise<void>;
}

export interface FileSystemFileHandleLike {
  readonly name?: string;
  createWritable: () => Promise<FileSystemWritableLike>;
}

export interface FileSystemDirectoryHandleLike {
  readonly name: string;
  getDirectoryHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemDirectoryHandleLike>;
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemFileHandleLike>;
  queryPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { mode?: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

export interface GodotSyncTargetRecord extends GodotSyncTargetMeta {
  readonly directoryHandle?: FileSystemDirectoryHandleLike | null;
}

/**
 * Normalizes an arbitrary entity label into a Godot-safe snake_case identifier.
 */
export function sanitizeEntitySlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return cleaned.length > 0 ? cleaned : 'entity';
}

/**
 * Normalizes a relative `res://` subfolder path (stripping leading slashes and traversal segments).
 */
export function normalizeResSubpath(raw: string): string {
  const stripped = raw
    .trim()
    .replace(/^res:\/\//i, '')
    .replace(/\\/g, '/');
  const segments = stripped
    .split('/')
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0 && seg !== '.' && seg !== '..');
  return segments.length > 0 ? segments.join('/') : 'assets/nibgrid';
}
