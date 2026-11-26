import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { z } from 'zod';
import { db, NibgridRepository, type NibgridDatabase } from '../db/database';
import { EntityDefinitionSchema, type EntityDefinition } from '../domain/entitySchema';
import {
  AudioAssetSchema,
  BlobRecordSchema,
  ProjectSchema,
  SpriteNodeSchema,
  type AudioAsset,
  type BlobRecord,
  type Project,
  type SpriteNode,
} from '../domain/schemas';
import { toAssetSlug } from '../export/zipPackager';
import { sha256Bytes } from '../processing/hash';

export const SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const SnapshotBlobRefSchema = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  mimeType: z.string().min(1),
});

export const SnapshotManifestSchema = z.object({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  exportedAt: z.string().min(1),
  project: ProjectSchema,
  spriteNodes: z.array(SpriteNodeSchema),
  audioAssets: z.array(AudioAssetSchema),
  entities: z.array(EntityDefinitionSchema),
  blobRefs: z.record(z.string(), SnapshotBlobRefSchema),
  blobHashes: z.record(z.string(), z.string().regex(/^[0-9a-f]{64}$/)),
});
export type SnapshotManifest = z.infer<typeof SnapshotManifestSchema>;

export interface SnapshotBlobPayload {
  readonly id: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
  readonly sha256?: string;
}

export interface ProjectSnapshotBundle {
  readonly project: Project;
  readonly spriteNodes: readonly SpriteNode[];
  readonly audioAssets: readonly AudioAsset[];
  readonly entities: readonly EntityDefinition[];
  readonly blobs: readonly SnapshotBlobPayload[];
  readonly exportedAt?: string;
}

export interface VerifiedProjectSnapshot {
  readonly manifest: SnapshotManifest;
  readonly blobsBySha: ReadonlyMap<
    string,
    { readonly sha256: string; readonly bytes: Uint8Array; readonly mimeType: string }
  >;
}

/**
 * Pure-TS snapshot serializer packing a project, DAG sprite nodes, audio assets, entities,
 * and SHA-256 deduplicated blobs into a portable `.nibgrid.zip` archive.
 */
export async function exportProjectSnapshot(bundle: ProjectSnapshotBundle): Promise<Uint8Array> {
  const blobRefs: Record<string, { sha256: string; mimeType: string }> = {};
  const blobHashes: Record<string, string> = {};
  const files: Record<string, Uint8Array> = {};

  for (const entry of bundle.blobs) {
    const computedSha = await sha256Bytes(entry.bytes);
    if (entry.sha256 && entry.sha256 !== computedSha) {
      throw new Error(`Blob "${entry.id}" failed SHA-256 verification before export.`);
    }
    blobRefs[entry.id] = { sha256: computedSha, mimeType: entry.mimeType };
    const blobPath = `blobs/${computedSha}.bin`;
    if (!files[blobPath]) {
      files[blobPath] = entry.bytes;
      blobHashes[blobPath] = computedSha;
    }
  }

  const manifest = SnapshotManifestSchema.parse({
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    exportedAt: bundle.exportedAt ?? new Date().toISOString(),
    project: bundle.project,
    spriteNodes: [...bundle.spriteNodes],
    audioAssets: [...bundle.audioAssets],
    entities: [...bundle.entities],
    blobRefs,
    blobHashes,
  });

  files['manifest.json'] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
  return zipSync(files, { level: 6 });
}

/**
 * Pure-TS verifier that unzips `.nibgrid.zip`, validates `manifest.json` via Zod, and
 * verifies every blob entry's SHA-256 digest before touching IndexedDB.
 */
export async function parseAndVerifyProjectSnapshot(
  zipBytes: Uint8Array,
): Promise<VerifiedProjectSnapshot> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zipBytes);
  } catch (err) {
    throw new Error(
      `Invalid .nibgrid.zip archive: ${err instanceof Error ? err.message : 'failed to unzip'}`,
    );
  }

  const manifestRaw = entries['manifest.json'];
  if (!manifestRaw) {
    throw new Error('Snapshot archive is missing required manifest.json.');
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(strFromU8(manifestRaw));
  } catch {
    throw new Error('Snapshot manifest.json contains invalid JSON.');
  }

  const manifest = SnapshotManifestSchema.parse(parsedJson);
  const blobsBySha = new Map<
    string,
    { readonly sha256: string; readonly bytes: Uint8Array; readonly mimeType: string }
  >();

  for (const [blobPath, expectedSha] of Object.entries(manifest.blobHashes)) {
    const rawBytes = entries[blobPath];
    if (!rawBytes) {
      throw new Error(`Snapshot archive is missing referenced blob "${blobPath}".`);
    }
    const actualSha = await sha256Bytes(rawBytes);
    if (actualSha !== expectedSha) {
      throw new Error(
        `Snapshot SHA-256 integrity check failed for "${blobPath}" (expected ${expectedSha.slice(0, 12)}, got ${actualSha.slice(0, 12)}).`,
      );
    }
    const matchingRef = Object.values(manifest.blobRefs).find((r) => r.sha256 === expectedSha);
    blobsBySha.set(expectedSha, {
      sha256: expectedSha,
      bytes: rawBytes,
      mimeType: matchingRef?.mimeType ?? 'application/octet-stream',
    });
  }

  for (const [blobId, ref] of Object.entries(manifest.blobRefs)) {
    if (!blobsBySha.has(ref.sha256)) {
      const fallbackPath = `blobs/${ref.sha256}.bin`;
      const rawBytes = entries[fallbackPath];
      if (!rawBytes) {
        throw new Error(`Snapshot is missing blob binary for "${blobId}" (${ref.sha256}).`);
      }
      const actualSha = await sha256Bytes(rawBytes);
      if (actualSha !== ref.sha256) {
        throw new Error(`Snapshot SHA-256 mismatch for blob "${blobId}".`);
      }
      blobsBySha.set(ref.sha256, {
        sha256: ref.sha256,
        bytes: rawBytes,
        mimeType: ref.mimeType,
      });
    }
  }

  return { manifest, blobsBySha };
}

export async function exportProjectSnapshotFromDb(
  database: NibgridDatabase = db,
  projectId: string,
): Promise<{ filename: string; bytes: Uint8Array }> {
  const repo = new NibgridRepository(database);
  const project = await repo.getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found.`);
  }
  const [spriteNodes, audioAssets, entities] = await Promise.all([
    repo.listSpriteNodes(projectId),
    repo.listAudioAssets(projectId),
    repo.listEntities(projectId),
  ]);

  const blobIds = new Set<string>(project.artBible.goldenReferenceBlobIds);
  for (const node of spriteNodes) {
    blobIds.add(node.imageBlobId);
    if (node.maskBlobId) blobIds.add(node.maskBlobId);
    if (node.processedBlobId) blobIds.add(node.processedBlobId);
    if (node.parallaxScene?.masterKeyframeBlobId) {
      blobIds.add(node.parallaxScene.masterKeyframeBlobId);
    }
    for (const layer of node.parallaxScene?.layers ?? []) {
      if (layer.blobId) blobIds.add(layer.blobId);
    }
  }
  for (const audio of audioAssets) {
    blobIds.add(audio.wavBlobId);
    for (const vid of audio.variationBlobIds) {
      blobIds.add(vid);
    }
  }

  const blobs: SnapshotBlobPayload[] = [];
  for (const blobId of blobIds) {
    const rec = await repo.getBlob(blobId);
    if (!rec) continue;
    const arrBuf = await rec.bytes.arrayBuffer();
    blobs.push({
      id: rec.id,
      mimeType: rec.mimeType,
      bytes: new Uint8Array(arrBuf),
      sha256: rec.sha256,
    });
  }

  const zipBytes = await exportProjectSnapshot({
    project,
    spriteNodes,
    audioAssets,
    entities,
    blobs,
  });

  return {
    filename: `${toAssetSlug(project.name)}.nibgrid.zip`,
    bytes: zipBytes,
  };
}

function makeId(): string {
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

export async function importProjectSnapshotToDb(
  database: NibgridDatabase,
  zipBytes: Uint8Array,
  options?: { readonly importedNameSuffix?: string },
): Promise<{
  readonly project: Project;
  readonly spriteCount: number;
  readonly audioCount: number;
  readonly entityCount: number;
}> {
  const verified = await parseAndVerifyProjectSnapshot(zipBytes);
  const { manifest, blobsBySha } = verified;

  return database.transaction(
    'rw',
    [
      database.projects,
      database.spriteNodes,
      database.audioAssets,
      database.entities,
      database.blobs,
      database.vaultItems,
    ],
    async () => {
      // 1. Deduplicate binaries by SHA-256 against existing DB blobs table
      const existingBlobs = await database.blobs.toArray();
      const dbBlobBySha = new Map<string, BlobRecord>();
      for (const b of existingBlobs) {
        dbBlobBySha.set(b.sha256, b);
      }

      const oldBlobIdToNew = new Map<string, string>();
      for (const [oldBlobId, ref] of Object.entries(manifest.blobRefs)) {
        const existing = dbBlobBySha.get(ref.sha256);
        if (existing) {
          oldBlobIdToNew.set(oldBlobId, existing.id);
          continue;
        }
        const entry = blobsBySha.get(ref.sha256);
        if (!entry) {
          throw new Error(`Missing verified binary for SHA-256 ${ref.sha256}.`);
        }
        const rawCopy = new Uint8Array(entry.bytes.byteLength);
        rawCopy.set(entry.bytes);
        const newBlobRec = BlobRecordSchema.parse({
          id: makeId(),
          mimeType: entry.mimeType,
          bytes: new Blob([rawCopy.buffer], { type: entry.mimeType }),
          sha256: entry.sha256,
          createdAt: nowIso(),
        });
        await database.blobs.put(newBlobRec);
        dbBlobBySha.set(entry.sha256, newBlobRec);
        oldBlobIdToNew.set(oldBlobId, newBlobRec.id);
      }

      const mapBlobId = (oldId: string): string => oldBlobIdToNew.get(oldId) ?? oldId;

      // 2. Remap project ID on collision (or always issue clean fresh project ID so multiple imports work)
      const existingSameId = await database.projects.get(manifest.project.id);
      const newProjectId = existingSameId ? makeId() : manifest.project.id;

      const nodeIdMap = new Map<string, string>();
      for (const node of manifest.spriteNodes) {
        const existingNode = await database.spriteNodes.get(node.id);
        nodeIdMap.set(node.id, existingSameId || existingNode ? makeId() : node.id);
      }

      const audioIdMap = new Map<string, string>();
      for (const audio of manifest.audioAssets) {
        const existingAudio = await database.audioAssets.get(audio.id);
        audioIdMap.set(audio.id, existingSameId || existingAudio ? makeId() : audio.id);
      }

      const entityIdMap = new Map<string, string>();
      for (const ent of manifest.entities) {
        const existingEnt = await database.entities.get(ent.id);
        entityIdMap.set(ent.id, existingSameId || existingEnt ? makeId() : ent.id);
      }

      const timestamp = nowIso();
      const baseName = manifest.project.name;
      const nextName =
        existingSameId && options?.importedNameSuffix
          ? `${baseName} ${options.importedNameSuffix}`
          : existingSameId
            ? `${baseName} (Imported)`
            : baseName;

      const nextProject = ProjectSchema.parse({
        ...manifest.project,
        id: newProjectId,
        name: nextName.slice(0, 120),
        artBible: {
          ...manifest.project.artBible,
          goldenReferenceBlobIds: manifest.project.artBible.goldenReferenceBlobIds.map(mapBlobId),
        },
        updatedAt: timestamp,
      });
      await database.projects.put(nextProject);

      for (const node of manifest.spriteNodes) {
        const mappedNode = SpriteNodeSchema.parse({
          ...node,
          id: nodeIdMap.get(node.id) ?? node.id,
          projectId: newProjectId,
          parentId: node.parentId ? (nodeIdMap.get(node.parentId) ?? null) : null,
          imageBlobId: mapBlobId(node.imageBlobId),
          ...(node.maskBlobId ? { maskBlobId: mapBlobId(node.maskBlobId) } : {}),
          ...(node.processedBlobId ? { processedBlobId: mapBlobId(node.processedBlobId) } : {}),
          ...(node.parallaxScene
            ? {
                parallaxScene: {
                  ...node.parallaxScene,
                  ...(node.parallaxScene.masterKeyframeBlobId
                    ? {
                        masterKeyframeBlobId: mapBlobId(node.parallaxScene.masterKeyframeBlobId),
                      }
                    : {}),
                  layers: node.parallaxScene.layers.map((layer) => ({
                    ...layer,
                    ...(layer.blobId ? { blobId: mapBlobId(layer.blobId) } : {}),
                  })),
                },
              }
            : {}),
        });
        await database.spriteNodes.put(mappedNode);
      }

      for (const audio of manifest.audioAssets) {
        const mappedAudio = AudioAssetSchema.parse({
          ...audio,
          id: audioIdMap.get(audio.id) ?? audio.id,
          projectId: newProjectId,
          wavBlobId: mapBlobId(audio.wavBlobId),
          variationBlobIds: audio.variationBlobIds.map(mapBlobId),
        });
        await database.audioAssets.put(mappedAudio);
      }

      for (const entity of manifest.entities) {
        const mappedEntity = EntityDefinitionSchema.parse({
          ...entity,
          id: entityIdMap.get(entity.id) ?? entity.id,
          projectId: newProjectId,
          primarySpriteNodeId:
            nodeIdMap.get(entity.primarySpriteNodeId) ?? entity.primarySpriteNodeId,
          clips: entity.clips.map((c) => ({
            ...c,
            spriteNodeId: nodeIdMap.get(c.spriteNodeId) ?? c.spriteNodeId,
          })),
          audioAssetIds: entity.audioAssetIds.map((aid) => audioIdMap.get(aid) ?? aid),
          updatedAt: Date.now(),
        });
        await database.entities.put(mappedEntity);
      }

      return {
        project: nextProject,
        spriteCount: manifest.spriteNodes.length,
        audioCount: manifest.audioAssets.length,
        entityCount: manifest.entities.length,
      };
    },
  );
}
