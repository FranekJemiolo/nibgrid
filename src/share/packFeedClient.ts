import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { db, type NibgridDatabase } from '../db/database';
import {
  ArtBibleSchema,
  AudioAssetSchema,
  BlobRecordSchema,
  SpriteNodeSchema,
  type SpriteNode,
} from '../domain/schemas';
import { parseVaultPayload, VaultItemSchema, type VaultItem } from '../domain/vaultSchema';
import { sha256Bytes } from '../processing/hash';
import { importProjectSnapshotToDb, parseAndVerifyProjectSnapshot } from '../sync/projectSnapshot';

export const PACK_FEEDS_STORAGE_KEY = 'nibgrid.packFeeds.v1';

export const PackEntrySchema = z.object({
  id: z.string().trim().min(1).max(80),
  title: z.string().trim().min(1).max(120),
  author: z.string().trim().min(1).max(80),
  license: z.string().trim().min(1).max(40).default('CC0-1.0'),
  description: z.string().max(400).default(''),
  tags: z.array(z.string().trim().min(1).max(32)).default([]),
  assetCount: z.number().int().min(1),
  zipUrl: z.string().trim().min(1),
  sha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});
export type PackEntry = z.infer<typeof PackEntrySchema>;

export const PackCatalogSchema = z.object({
  feedTitle: z.string().trim().min(1).max(120),
  description: z.string().max(400).optional(),
  packs: z.array(PackEntrySchema),
});
export type PackCatalog = z.infer<typeof PackCatalogSchema>;

export const PackManifestItemSchema = z.object({
  vaultItem: VaultItemSchema,
  blobs: z
    .record(
      z.string(),
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        mimeType: z.string().min(1),
      }),
    )
    .default({}),
});

export const NibgridPackManifestSchema = z.object({
  schemaVersion: z.literal(1),
  packId: z.string().min(1),
  title: z.string().min(1),
  author: z.string().optional(),
  license: z.string().optional(),
  items: z.array(PackManifestItemSchema).min(1),
});
export type NibgridPackManifest = z.infer<typeof NibgridPackManifestSchema>;

export type ParsedPackBundle =
  | {
      readonly kind: 'vault-pack';
      readonly manifest: NibgridPackManifest;
      readonly blobsBySha: ReadonlyMap<
        string,
        { readonly sha256: string; readonly bytes: Uint8Array; readonly mimeType: string }
      >;
    }
  | {
      readonly kind: 'project-snapshot';
      readonly zipBytes: Uint8Array;
      readonly title: string;
    };

export function resolveDefaultPackFeedUrl(baseUrl?: string): string {
  const base =
    baseUrl ??
    (typeof import.meta !== 'undefined' && import.meta.env?.BASE_URL
      ? import.meta.env.BASE_URL
      : '/');
  const trimmed = base.endsWith('/') ? base : `${base}/`;
  return `${trimmed}packs/starter-catalog.json`;
}

export function resolvePackZipUrl(zipUrl: string, catalogUrl: string): string {
  if (/^https?:\/\//i.test(zipUrl)) {
    return zipUrl;
  }
  const fallbackOrigin =
    typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : 'http://localhost';
  const baseObj = /^https?:\/\//i.test(catalogUrl)
    ? new URL(catalogUrl)
    : new URL(catalogUrl, fallbackOrigin);
  return new URL(zipUrl, baseObj).toString();
}

export function loadSavedFeedUrls(defaultUrl = resolveDefaultPackFeedUrl()): string[] {
  if (typeof localStorage === 'undefined') {
    return [defaultUrl];
  }
  try {
    const raw = localStorage.getItem(PACK_FEEDS_STORAGE_KEY);
    if (!raw) return [defaultUrl];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [defaultUrl];
    const valid = parsed.filter((u): u is string => typeof u === 'string' && u.trim().length > 0);
    return valid.includes(defaultUrl) ? valid : [defaultUrl, ...valid];
  } catch {
    return [defaultUrl];
  }
}

export function saveFeedUrls(urls: readonly string[]): string[] {
  const deduped = Array.from(new Set(urls.map((u) => u.trim()).filter(Boolean)));
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(PACK_FEEDS_STORAGE_KEY, JSON.stringify(deduped));
  }
  return deduped;
}

export async function fetchPackCatalog(
  catalogUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<PackCatalog> {
  const res = await fetchFn(catalogUrl);
  if (!res.ok) {
    throw new Error(`Failed to fetch pack catalog (${res.status} ${res.statusText}).`);
  }
  const rawJson = (await res.json()) as unknown;
  const catalog = PackCatalogSchema.parse(rawJson);
  return {
    ...catalog,
    packs: catalog.packs.map((pack) => ({
      ...pack,
      zipUrl: resolvePackZipUrl(pack.zipUrl, catalogUrl),
    })),
  };
}

/**
 * Pure-TS helper building a deterministic `.nibgrid-pack.zip` from Vault items & raw blobs.
 */
export async function buildNibgridPackZip(input: {
  readonly packId: string;
  readonly title: string;
  readonly author?: string;
  readonly license?: string;
  readonly items: readonly {
    readonly vaultItem: VaultItem;
    readonly blobPayloads?: ReadonlyMap<
      string,
      { readonly bytes: Uint8Array; readonly mimeType: string }
    >;
  }[];
}): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  const manifestItems: z.infer<typeof PackManifestItemSchema>[] = [];

  for (const entry of input.items) {
    const blobs: Record<string, { path: string; sha256: string; mimeType: string }> = {};
    if (entry.blobPayloads) {
      for (const [blobId, payload] of entry.blobPayloads.entries()) {
        const sha = await sha256Bytes(payload.bytes);
        const path = `blobs/${sha}.bin`;
        files[path] = payload.bytes;
        blobs[blobId] = { path, sha256: sha, mimeType: payload.mimeType };
      }
    }
    manifestItems.push({ vaultItem: entry.vaultItem, blobs });
  }

  const manifest = NibgridPackManifestSchema.parse({
    schemaVersion: 1,
    packId: input.packId,
    title: input.title,
    ...(input.author ? { author: input.author } : {}),
    ...(input.license ? { license: input.license } : {}),
    items: manifestItems,
  });

  files['pack.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  return zipSync(files, { level: 6 });
}

export async function parseAndVerifyPackZip(
  zipBytes: Uint8Array,
  expectedSha256?: string,
): Promise<ParsedPackBundle> {
  if (expectedSha256) {
    const actualSha = await sha256Bytes(zipBytes);
    if (actualSha !== expectedSha256) {
      throw new Error(
        `Pack archive SHA-256 mismatch (expected ${expectedSha256.slice(0, 12)}, got ${actualSha.slice(0, 12)}).`,
      );
    }
  }

  const entries = unzipSync(zipBytes);
  const packJsonRaw = entries['pack.json'];
  if (!packJsonRaw) {
    const snapshot = await parseAndVerifyProjectSnapshot(zipBytes);
    return {
      kind: 'project-snapshot',
      zipBytes,
      title: snapshot.manifest.project.name,
    };
  }

  const manifest = NibgridPackManifestSchema.parse(JSON.parse(strFromU8(packJsonRaw)));
  const blobsBySha = new Map<
    string,
    { readonly sha256: string; readonly bytes: Uint8Array; readonly mimeType: string }
  >();

  for (const itemEntry of manifest.items) {
    for (const [blobId, meta] of Object.entries(itemEntry.blobs)) {
      const bytes = entries[meta.path];
      if (!bytes) {
        throw new Error(`Pack archive is missing blob "${meta.path}" for "${blobId}".`);
      }
      const actualSha = await sha256Bytes(bytes);
      if (actualSha !== meta.sha256) {
        throw new Error(`Pack blob "${blobId}" failed SHA-256 integrity check.`);
      }
      blobsBySha.set(meta.sha256, {
        sha256: meta.sha256,
        bytes,
        mimeType: meta.mimeType,
      });
    }
  }

  return {
    kind: 'vault-pack',
    manifest,
    blobsBySha,
  };
}

export async function fetchAndParsePack(
  entry: PackEntry,
  catalogUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<ParsedPackBundle> {
  const url = resolvePackZipUrl(entry.zipUrl, catalogUrl);
  const res = await fetchFn(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch pack "${entry.title}" (${res.status}).`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  return parseAndVerifyPackZip(bytes, entry.sha256);
}

function makeId(): string {
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function importPackIntoDb(
  database: NibgridDatabase = db,
  parsed: ParsedPackBundle,
  target: { readonly mode: 'project'; readonly projectId: string } | { readonly mode: 'vault' },
): Promise<{
  readonly importedCount: number;
  readonly summary: string;
}> {
  if (parsed.kind === 'project-snapshot') {
    const res = await importProjectSnapshotToDb(database, parsed.zipBytes);
    return {
      importedCount: res.spriteCount + res.audioCount + res.entityCount + 1,
      summary: `Imported project "${res.project.name}" from pack.`,
    };
  }

  const { manifest, blobsBySha } = parsed;
  let importedCount = 0;

  // Persist deduplicated blobs and construct clean VaultItems + optional target project assets
  await database.transaction(
    'rw',
    [
      database.projects,
      database.spriteNodes,
      database.audioAssets,
      database.blobs,
      database.vaultItems,
    ],
    async () => {
      const existingBlobs = await database.blobs.toArray();
      const blobBySha = new Map<string, string>(existingBlobs.map((b) => [b.sha256, b.id]));
      const now = Date.now();

      for (let idx = 0; idx < manifest.items.length; idx += 1) {
        const entry = manifest.items[idx]!;
        const oldToNewBlobId = new Map<string, string>();

        for (const [oldBlobId, ref] of Object.entries(entry.blobs)) {
          const existingId = blobBySha.get(ref.sha256);
          if (existingId) {
            oldToNewBlobId.set(oldBlobId, existingId);
            continue;
          }
          const raw = blobsBySha.get(ref.sha256);
          if (!raw) continue;
          const copy = new Uint8Array(raw.bytes.byteLength);
          copy.set(raw.bytes);
          const rec = BlobRecordSchema.parse({
            id: makeId(),
            mimeType: raw.mimeType,
            bytes: new Blob([copy.buffer], { type: raw.mimeType }),
            sha256: raw.sha256,
            createdAt: nowIso(),
          });
          await database.blobs.put(rec);
          blobBySha.set(rec.sha256, rec.id);
          oldToNewBlobId.set(oldBlobId, rec.id);
        }

        const remapBlob = (id: string) => oldToNewBlobId.get(id) ?? id;
        const rawPayload = parseVaultPayload(entry.vaultItem);
        let remappedPayloadJson = entry.vaultItem.payloadJson;

        if (rawPayload.kind === 'sprite') {
          const remappedNode = SpriteNodeSchema.parse({
            ...rawPayload.node,
            imageBlobId: remapBlob(rawPayload.node.imageBlobId),
            ...(rawPayload.node.maskBlobId
              ? { maskBlobId: remapBlob(rawPayload.node.maskBlobId) }
              : {}),
            ...(rawPayload.node.processedBlobId
              ? { processedBlobId: remapBlob(rawPayload.node.processedBlobId) }
              : {}),
          });
          remappedPayloadJson = JSON.stringify({ ...rawPayload, node: remappedNode });
        } else if (rawPayload.kind === 'sfx') {
          const remappedAudio = AudioAssetSchema.parse({
            ...rawPayload.audioAsset,
            wavBlobId: remapBlob(rawPayload.audioAsset.wavBlobId),
            variationBlobIds: rawPayload.audioAsset.variationBlobIds.map(remapBlob),
          });
          remappedPayloadJson = JSON.stringify({ ...rawPayload, audioAsset: remappedAudio });
        } else if (rawPayload.kind === 'art-bible') {
          const remappedBible = ArtBibleSchema.parse({
            ...rawPayload.artBible,
            goldenReferenceBlobIds: rawPayload.artBible.goldenReferenceBlobIds.map(remapBlob),
          });
          remappedPayloadJson = JSON.stringify({ ...rawPayload, artBible: remappedBible });
        }

        const remappedVaultItem = VaultItemSchema.parse({
          ...entry.vaultItem,
          id: makeId(),
          payloadJson: remappedPayloadJson,
          blobIds: entry.vaultItem.blobIds.map(remapBlob),
          ...(entry.vaultItem.previewBlobId
            ? { previewBlobId: remapBlob(entry.vaultItem.previewBlobId) }
            : {}),
          sourceProjectName: entry.vaultItem.sourceProjectName ?? manifest.title,
          createdAt: now + idx,
        });

        await database.vaultItems.put(remappedVaultItem);

        if (target.mode === 'project') {
          const parsedAgain = parseVaultPayload(remappedVaultItem);
          if (parsedAgain.kind === 'sprite') {
            const newNode: SpriteNode = SpriteNodeSchema.parse({
              ...parsedAgain.node,
              id: makeId(),
              projectId: target.projectId,
              parentId: null,
              generationMeta: {
                ...parsedAgain.node.generationMeta,
                createdAt: nowIso(),
              },
            });
            await database.spriteNodes.put(newNode);
          } else if (parsedAgain.kind === 'sfx') {
            await database.audioAssets.put(
              AudioAssetSchema.parse({
                ...parsedAgain.audioAsset,
                id: makeId(),
                projectId: target.projectId,
                createdAt: nowIso(),
              }),
            );
          } else if (parsedAgain.kind === 'art-bible') {
            const existingProj = await database.projects.get(target.projectId);
            if (existingProj) {
              await database.projects.put({
                ...existingProj,
                artBible: parsedAgain.artBible,
                updatedAt: nowIso(),
              });
            }
          } else {
            // Apply shader/bmfont/vfx to existing project sprite if present
            const existingNodes = await database.spriteNodes
              .where('projectId')
              .equals(target.projectId)
              .toArray();
            const targetNode = existingNodes[existingNodes.length - 1];
            if (targetNode) {
              await database.spriteNodes.put(
                SpriteNodeSchema.parse({
                  ...targetNode,
                  ...(parsedAgain.kind === 'shader'
                    ? { shaderConfig: parsedAgain.shaderConfig }
                    : {}),
                  ...(parsedAgain.kind === 'bmfont' ? { bitmapFont: parsedAgain.bitmapFont } : {}),
                  ...(parsedAgain.kind === 'vfx' ? { vfxFlipbook: parsedAgain.vfxFlipbook } : {}),
                }),
              );
            }
          }
        }
        importedCount += 1;
      }

      if (target.mode === 'project') {
        await database.projects
          .where('id')
          .equals(target.projectId)
          .modify({ updatedAt: nowIso() });
      }
    },
  );

  return {
    importedCount,
    summary: `Imported ${importedCount} asset(s) from "${parsed.manifest.title}"${target.mode === 'project' ? ' into project' : ' into Global Vault'}.`,
  };
}
