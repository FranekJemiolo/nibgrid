import { z } from 'zod';
import {
  ArtBibleSchema,
  AudioAssetSchema,
  BitmapFontConfigSchema,
  ShaderConfigSchema,
  SpriteNodeSchema,
  VfxFlipbookConfigSchema,
  type ArtBible,
  type AudioAsset,
  type BitmapFontConfig,
  type ShaderConfig,
  type SpriteNode,
  type VfxFlipbookConfig,
} from './schemas';

export const VaultItemKindSchema = z.enum([
  'sprite',
  'shader',
  'bmfont',
  'sfx',
  'vfx',
  'art-bible',
]);
export type VaultItemKind = z.infer<typeof VaultItemKindSchema>;

export const VaultItemSchema = z.object({
  id: z.string().min(1),
  kind: VaultItemKindSchema,
  name: z.string().trim().min(1).max(120),
  tags: z.array(z.string().trim().min(1).max(32)).default([]),
  payloadJson: z.string().min(2),
  blobIds: z.array(z.string().min(1)).default([]),
  previewBlobId: z.string().min(1).optional(),
  sourceProjectName: z.string().max(120).optional(),
  createdAt: z.number().int().nonnegative(),
});
export type VaultItem = z.infer<typeof VaultItemSchema>;

export const SpriteVaultPayloadSchema = z.object({
  kind: z.literal('sprite'),
  node: SpriteNodeSchema,
  blobMeta: z.record(z.string(), z.object({ mimeType: z.string(), sha256: z.string() })).optional(),
});

export const ShaderVaultPayloadSchema = z.object({
  kind: z.literal('shader'),
  shaderConfig: ShaderConfigSchema,
});

export const BmfontVaultPayloadSchema = z.object({
  kind: z.literal('bmfont'),
  bitmapFont: BitmapFontConfigSchema,
});

export const VfxVaultPayloadSchema = z.object({
  kind: z.literal('vfx'),
  vfxFlipbook: VfxFlipbookConfigSchema,
});

export const SfxVaultPayloadSchema = z.object({
  kind: z.literal('sfx'),
  audioAsset: AudioAssetSchema,
});

export const ArtBibleVaultPayloadSchema = z.object({
  kind: z.literal('art-bible'),
  artBible: ArtBibleSchema,
});

export const VaultPayloadSchema = z.discriminatedUnion('kind', [
  SpriteVaultPayloadSchema,
  ShaderVaultPayloadSchema,
  BmfontVaultPayloadSchema,
  VfxVaultPayloadSchema,
  SfxVaultPayloadSchema,
  ArtBibleVaultPayloadSchema,
]);
export type VaultPayload = z.infer<typeof VaultPayloadSchema>;

function normalizeTags(tags: readonly string[]): string[] {
  const unique = new Set<string>();
  for (const tag of tags) {
    const clean = tag.trim().toLowerCase().slice(0, 32);
    if (clean.length > 0) unique.add(clean);
  }
  return Array.from(unique);
}

export function collectSpriteNodeBlobIds(node: SpriteNode): string[] {
  const ids = new Set<string>();
  ids.add(node.imageBlobId);
  if (node.maskBlobId) ids.add(node.maskBlobId);
  if (node.processedBlobId) ids.add(node.processedBlobId);
  if (node.parallaxScene?.masterKeyframeBlobId) {
    ids.add(node.parallaxScene.masterKeyframeBlobId);
  }
  for (const layer of node.parallaxScene?.layers ?? []) {
    if (layer.blobId) ids.add(layer.blobId);
  }
  return Array.from(ids);
}

export function collectAudioAssetBlobIds(asset: AudioAsset): string[] {
  const ids = new Set<string>();
  ids.add(asset.wavBlobId);
  for (const vid of asset.variationBlobIds) {
    ids.add(vid);
  }
  return Array.from(ids);
}

export function buildSpriteVaultItem(input: {
  id: string;
  name: string;
  node: SpriteNode;
  tags?: readonly string[];
  sourceProjectName?: string;
  createdAt?: number;
}): VaultItem {
  const blobIds = collectSpriteNodeBlobIds(input.node);
  const previewBlobId = input.node.processedBlobId ?? input.node.imageBlobId;
  const payload: VaultPayload = {
    kind: 'sprite',
    node: input.node,
  };
  return VaultItemSchema.parse({
    id: input.id,
    kind: 'sprite',
    name: input.name,
    tags: normalizeTags([...(input.tags ?? []), input.node.assetClass ?? 'sprite']),
    payloadJson: JSON.stringify(payload),
    blobIds,
    previewBlobId,
    ...(input.sourceProjectName ? { sourceProjectName: input.sourceProjectName } : {}),
    createdAt: input.createdAt ?? Date.now(),
  });
}

export function buildShaderVaultItem(input: {
  id: string;
  name: string;
  shaderConfig: ShaderConfig;
  tags?: readonly string[];
  sourceProjectName?: string;
  createdAt?: number;
}): VaultItem {
  const payload: VaultPayload = {
    kind: 'shader',
    shaderConfig: input.shaderConfig,
  };
  return VaultItemSchema.parse({
    id: input.id,
    kind: 'shader',
    name: input.name,
    tags: normalizeTags([...(input.tags ?? []), 'gdshader', input.shaderConfig.presetId]),
    payloadJson: JSON.stringify(payload),
    blobIds: [],
    ...(input.sourceProjectName ? { sourceProjectName: input.sourceProjectName } : {}),
    createdAt: input.createdAt ?? Date.now(),
  });
}

export function buildBmfontVaultItem(input: {
  id: string;
  name: string;
  bitmapFont: BitmapFontConfig;
  tags?: readonly string[];
  sourceProjectName?: string;
  createdAt?: number;
}): VaultItem {
  const payload: VaultPayload = {
    kind: 'bmfont',
    bitmapFont: input.bitmapFont,
  };
  return VaultItemSchema.parse({
    id: input.id,
    kind: 'bmfont',
    name: input.name,
    tags: normalizeTags([...(input.tags ?? []), 'bmfont', input.bitmapFont.charsetPreset]),
    payloadJson: JSON.stringify(payload),
    blobIds: [],
    ...(input.sourceProjectName ? { sourceProjectName: input.sourceProjectName } : {}),
    createdAt: input.createdAt ?? Date.now(),
  });
}

export function buildVfxVaultItem(input: {
  id: string;
  name: string;
  vfxFlipbook: VfxFlipbookConfig;
  tags?: readonly string[];
  sourceProjectName?: string;
  createdAt?: number;
}): VaultItem {
  const payload: VaultPayload = {
    kind: 'vfx',
    vfxFlipbook: input.vfxFlipbook,
  };
  return VaultItemSchema.parse({
    id: input.id,
    kind: 'vfx',
    name: input.name,
    tags: normalizeTags([...(input.tags ?? []), 'vfx', input.vfxFlipbook.archetype]),
    payloadJson: JSON.stringify(payload),
    blobIds: [],
    ...(input.sourceProjectName ? { sourceProjectName: input.sourceProjectName } : {}),
    createdAt: input.createdAt ?? Date.now(),
  });
}

export function buildSfxVaultItem(input: {
  id: string;
  name: string;
  audioAsset: AudioAsset;
  tags?: readonly string[];
  sourceProjectName?: string;
  createdAt?: number;
}): VaultItem {
  const payload: VaultPayload = {
    kind: 'sfx',
    audioAsset: input.audioAsset,
  };
  return VaultItemSchema.parse({
    id: input.id,
    kind: 'sfx',
    name: input.name,
    tags: normalizeTags([...(input.tags ?? []), input.audioAsset.route, input.audioAsset.presetId]),
    payloadJson: JSON.stringify(payload),
    blobIds: collectAudioAssetBlobIds(input.audioAsset),
    ...(input.sourceProjectName ? { sourceProjectName: input.sourceProjectName } : {}),
    createdAt: input.createdAt ?? Date.now(),
  });
}

export function buildArtBibleVaultItem(input: {
  id: string;
  name: string;
  artBible: ArtBible;
  tags?: readonly string[];
  sourceProjectName?: string;
  createdAt?: number;
}): VaultItem {
  const payload: VaultPayload = {
    kind: 'art-bible',
    artBible: input.artBible,
  };
  return VaultItemSchema.parse({
    id: input.id,
    kind: 'art-bible',
    name: input.name,
    tags: normalizeTags([...(input.tags ?? []), input.artBible.artMode, input.artBible.projection]),
    payloadJson: JSON.stringify(payload),
    blobIds: [...input.artBible.goldenReferenceBlobIds],
    ...(input.sourceProjectName ? { sourceProjectName: input.sourceProjectName } : {}),
    createdAt: input.createdAt ?? Date.now(),
  });
}

export function parseVaultPayload(item: Pick<VaultItem, 'payloadJson'>): VaultPayload {
  return VaultPayloadSchema.parse(JSON.parse(item.payloadJson));
}
