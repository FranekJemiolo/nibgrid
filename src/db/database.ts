import Dexie, { type Table } from 'dexie';
import {
  buildArtBibleVaultItem,
  buildBmfontVaultItem,
  buildSfxVaultItem,
  buildShaderVaultItem,
  buildSpriteVaultItem,
  buildVfxVaultItem,
  parseVaultPayload,
  VaultItemSchema,
  type VaultItem,
} from '../domain/vaultSchema';
import {
  EntityDefinitionSchema,
  GodotSyncTargetMetaSchema,
  type EntityDefinition,
  type GodotSyncTargetRecord,
} from '../domain/entitySchema';
import {
  ArtBibleSchema,
  AudioAssetSchema,
  AudioBindingsSchema,
  BlobRecordSchema,
  PoseClipDefinitionSchema,
  ProjectSchema,
  ProviderConfigSchema,
  SpriteNodeSchema,
  createDefaultArtBible,
  type ArtBible,
  type AssetClass,
  type AudioAsset,
  type AudioBindings,
  type BitmapFontConfig,
  type BlobRecord,
  type InpaintHistoryEntry,
  type PoseClipDefinitionSchemaType,
  type PostProcessConfig,
  type Project,
  type ProviderConfig,
  type ShaderConfig,
  type SpriteNode,
  type VfxFlipbookConfig,
} from '../domain/schemas';
import { type EmissionBakeConfig, type NormalBakeConfig } from '../processing/normalEmissionBaker';
import { sha256Bytes } from '../processing/hash';
import {
  StoredQaReportRecordSchema,
  type StoredQaReportRecord,
} from '../processing/artDirectorQaSchema';
import { StoredRoomRecordSchema, type StoredRoomRecord } from '../processing/roomLayoutCore';
import { SliceJobRecordSchema, type SliceJobRecord } from '../processing/sliceDagRunner';
import { AgentCheckpointSchema, type AgentCheckpoint } from '../agent/stagingTransactions';
import { WorldGraphSchema, type WorldGraph } from '../world/worldGraphCore';
import { GameDataRegistrySchema, type GameDataRegistry } from '../data/gameDataSchemas';

export const OFFLINE_MOCK_PROVIDER_ID = 'offline-mock';
export const ANTIGRAVITY_AGENT_PROVIDER_ID = 'antigravity-agent';

export interface ProjectSummary {
  project: Project;
  spriteCount: number;
}

export class NibgridDatabase extends Dexie {
  projects!: Table<Project, string>;
  blobs!: Table<BlobRecord, string>;
  spriteNodes!: Table<SpriteNode, string>;
  providerConfigs!: Table<ProviderConfig, string>;
  audioAssets!: Table<AudioAsset, string>;
  entities!: Table<EntityDefinition, string>;
  syncTargets!: Table<GodotSyncTargetRecord, string>;
  vaultItems!: Table<VaultItem, string>;
  qaReports!: Table<StoredQaReportRecord, string>;
  rooms!: Table<StoredRoomRecord, string>;
  sliceJobs!: Table<SliceJobRecord, string>;
  agentCheckpoints!: Table<AgentCheckpoint, string>;
  worldGraphs!: Table<WorldGraph, string>;
  gameDataRegistries!: Table<GameDataRegistry, string>;

  constructor(dbName = 'nibgrid-db') {
    super(dbName);
    this.version(1).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
    });
    this.version(2).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
    });
    this.version(3).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
    });
    this.version(4).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
      vaultItems: '&id, kind, name, createdAt',
    });
    this.version(5).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
      vaultItems: '&id, kind, name, createdAt',
      qaReports: '&projectId, sheetHash',
    });
    this.version(6).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
      vaultItems: '&id, kind, name, createdAt',
      qaReports: '&projectId, sheetHash',
      rooms: '&id, projectId, slug',
    });
    this.version(7).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
      vaultItems: '&id, kind, name, createdAt',
      qaReports: '&projectId, sheetHash',
      rooms: '&id, projectId, slug',
      sliceJobs: '&id, projectId, status, updatedAt',
    });
    this.version(8).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
      vaultItems: '&id, kind, name, createdAt',
      qaReports: '&projectId, sheetHash',
      rooms: '&id, projectId, slug',
      sliceJobs: '&id, projectId, status, updatedAt',
      agentCheckpoints: '&id, projectId, createdAt',
    });
    this.version(9).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
      vaultItems: '&id, kind, name, createdAt',
      qaReports: '&projectId, sheetHash',
      rooms: '&id, projectId, slug',
      sliceJobs: '&id, projectId, status, updatedAt',
      agentCheckpoints: '&id, projectId, createdAt',
      worldGraphs: '&projectId, id, updatedAt',
    });
    this.version(10).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
      audioAssets: 'id, projectId, presetId, createdAt',
      entities: '&id, projectId, slug',
      syncTargets: '&projectId',
      vaultItems: '&id, kind, name, createdAt',
      qaReports: '&projectId, sheetHash',
      rooms: '&id, projectId, slug',
      sliceJobs: '&id, projectId, status, updatedAt',
      agentCheckpoints: '&id, projectId, createdAt',
      worldGraphs: '&projectId, id, updatedAt',
      gameDataRegistries: '&projectId, updatedAt',
    });
  }
}

export const db = new NibgridDatabase();

function createId(): string {
  return globalThis.crypto.randomUUID();
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createDefaultMockProviderConfig(): ProviderConfig {
  return ProviderConfigSchema.parse({
    id: OFFLINE_MOCK_PROVIDER_ID,
    kind: 'mock',
    displayName: 'Offline Mock Provider',
    modelId: 'nibgrid-procedural-v1',
    endpointUrl: 'local://offline-mock',
    apiKey: '',
    enabled: true,
    capabilities: {
      supportsInpaint: true,
      supportsMultiRef: true,
      supportsSeed: true,
      isLocal: true,
    },
    updatedAt: nowIso(),
  });
}

export function createDefaultAntigravityProviderConfig(): ProviderConfig {
  return ProviderConfigSchema.parse({
    id: ANTIGRAVITY_AGENT_PROVIDER_ID,
    kind: 'antigravity-agent',
    displayName: 'Google Antigravity IDE / Agent Handoff',
    modelId: 'antigravity-ide-bridge-v1',
    endpointUrl: 'ide://antigravity-agent-bridge',
    apiKey: '',
    enabled: true,
    capabilities: {
      supportsInpaint: true,
      supportsMultiRef: true,
      supportsSeed: true,
      isLocal: true,
    },
    updatedAt: nowIso(),
  });
}

export class NibgridRepository {
  private readonly database: NibgridDatabase;

  constructor(database: NibgridDatabase = db) {
    this.database = database;
  }

  private get blobGcTables() {
    return [
      this.database.projects,
      this.database.spriteNodes,
      this.database.audioAssets,
      this.database.blobs,
      this.database.vaultItems,
      this.database.agentCheckpoints,
      this.database.worldGraphs,
    ];
  }

  async ensureDefaultProviderConfigs(): Promise<ProviderConfig[]> {
    const existing = await this.database.providerConfigs.toArray();
    if (!existing.some((cfg) => cfg.id === OFFLINE_MOCK_PROVIDER_ID)) {
      await this.database.providerConfigs.put(createDefaultMockProviderConfig());
    }
    if (!existing.some((cfg) => cfg.id === ANTIGRAVITY_AGENT_PROVIDER_ID)) {
      await this.database.providerConfigs.put(createDefaultAntigravityProviderConfig());
    }
    const all = await this.database.providerConfigs.toArray();
    const priority = (id: string): number => {
      if (id === OFFLINE_MOCK_PROVIDER_ID) return 0;
      if (id === ANTIGRAVITY_AGENT_PROVIDER_ID) return 1;
      return 2;
    };
    return all
      .map((item) => ProviderConfigSchema.parse(item))
      .sort((a, b) => priority(a.id) - priority(b.id));
  }

  async listProviderConfigs(): Promise<ProviderConfig[]> {
    return this.ensureDefaultProviderConfigs();
  }

  async saveProviderConfig(config: ProviderConfig): Promise<ProviderConfig> {
    const validated = ProviderConfigSchema.parse({
      ...config,
      updatedAt: nowIso(),
    });
    await this.database.providerConfigs.put(validated);
    return validated;
  }

  async deleteProviderConfig(id: string): Promise<void> {
    if (id === OFFLINE_MOCK_PROVIDER_ID || id === ANTIGRAVITY_AGENT_PROVIDER_ID) {
      throw new Error('Built-in local providers cannot be deleted.');
    }
    await this.database.providerConfigs.delete(id);
  }

  async createProject(name: string, artBible?: ArtBible): Promise<Project> {
    const timestamp = nowIso();
    const project = ProjectSchema.parse({
      id: createId(),
      name,
      artBible: artBible ? ArtBibleSchema.parse(artBible) : createDefaultArtBible(),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.database.projects.put(project);
    return project;
  }

  async getProject(projectId: string): Promise<Project | undefined> {
    const found = await this.database.projects.get(projectId);
    if (!found) return undefined;
    return ProjectSchema.parse(found);
  }

  async listProjectsWithCounts(): Promise<ProjectSummary[]> {
    const projects = await this.database.projects.orderBy('updatedAt').reverse().toArray();
    const nodes = await this.database.spriteNodes.toArray();

    const countByProject = new Map<string, number>();
    for (const node of nodes) {
      const validNode = SpriteNodeSchema.parse(node);
      countByProject.set(validNode.projectId, (countByProject.get(validNode.projectId) ?? 0) + 1);
    }

    return projects.map((rawProject) => {
      const project = ProjectSchema.parse(rawProject);
      return {
        project,
        spriteCount: countByProject.get(project.id) ?? 0,
      };
    });
  }

  async updateProjectMeta(
    projectId: string,
    updates: { name?: string; artBible?: ArtBible; audioBindings?: AudioBindings },
  ): Promise<Project> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      throw new Error(`Project "${projectId}" not found.`);
    }

    const updated = ProjectSchema.parse({
      ...existing,
      name: updates.name ?? existing.name,
      artBible: updates.artBible ? ArtBibleSchema.parse(updates.artBible) : existing.artBible,
      audioBindings:
        updates.audioBindings !== undefined
          ? AudioBindingsSchema.parse(updates.audioBindings)
          : existing.audioBindings,
      updatedAt: nowIso(),
    });

    await this.database.projects.put(updated);
    await this.cleanupOrphanedBlobs();
    return updated;
  }

  async updateProjectArtBible(projectId: string, artBible: ArtBible): Promise<Project> {
    return this.updateProjectMeta(projectId, { artBible });
  }

  async storeBlob(blob: Blob, explicitMimeType?: string): Promise<BlobRecord> {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);
    const sha256 = await sha256Bytes(bytes);
    const mimeType = explicitMimeType ?? (blob.type || 'application/octet-stream');

    const record = BlobRecordSchema.parse({
      id: createId(),
      mimeType,
      bytes: new Blob([bytes], { type: mimeType }),
      sha256,
      createdAt: nowIso(),
    });

    await this.database.blobs.put(record);
    return record;
  }

  async storeBlobDeduplicated(
    input: Blob | Uint8Array,
    explicitMimeType = 'application/octet-stream',
  ): Promise<BlobRecord> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
    const mimeType =
      input instanceof Uint8Array
        ? explicitMimeType
        : explicitMimeType || input.type || 'application/octet-stream';
    const sha256 = await sha256Bytes(bytes);

    const existing = await this.database.blobs.where('sha256').equals(sha256).first();
    if (existing) {
      return BlobRecordSchema.parse(existing);
    }

    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const record = BlobRecordSchema.parse({
      id: createId(),
      mimeType,
      bytes: new Blob([copy.buffer], { type: mimeType }),
      sha256,
      createdAt: nowIso(),
    });
    await this.database.blobs.put(record);
    return record;
  }

  async getBlob(blobId: string): Promise<BlobRecord | undefined> {
    const found = await this.database.blobs.get(blobId);
    if (!found) return undefined;
    return BlobRecordSchema.parse(found);
  }

  async addGoldenReference(projectId: string, file: Blob): Promise<Project> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found.`);
    }
    if (project.artBible.goldenReferenceBlobIds.length >= 3) {
      throw new Error('At most 3 Golden Reference images are allowed per project.');
    }

    const blobRecord = await this.storeBlob(file);
    const nextArtBible = ArtBibleSchema.parse({
      ...project.artBible,
      goldenReferenceBlobIds: [...project.artBible.goldenReferenceBlobIds, blobRecord.id],
    });
    return this.updateProjectArtBible(projectId, nextArtBible);
  }

  async removeGoldenReference(projectId: string, blobId: string): Promise<Project> {
    const project = await this.getProject(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found.`);
    }

    const nextIds = project.artBible.goldenReferenceBlobIds.filter((id) => id !== blobId);
    const nextArtBible = ArtBibleSchema.parse({
      ...project.artBible,
      goldenReferenceBlobIds: nextIds,
    });
    return this.updateProjectArtBible(projectId, nextArtBible);
  }

  async listSpriteNodes(projectId: string): Promise<SpriteNode[]> {
    const rows = await this.database.spriteNodes.where('projectId').equals(projectId).toArray();
    const validated = rows.map((row) => SpriteNodeSchema.parse(row));
    return validated.sort((a, b) => {
      const timeCmp = a.generationMeta.createdAt.localeCompare(b.generationMeta.createdAt);
      if (timeCmp !== 0) return timeCmp;
      const kindCmp = (a.kind === 'sketch' ? 0 : 1) - (b.kind === 'sketch' ? 0 : 1);
      if (kindCmp !== 0) return kindCmp;
      return a.id.localeCompare(b.id);
    });
  }

  async saveSpriteNode(node: SpriteNode): Promise<SpriteNode> {
    const validated = SpriteNodeSchema.parse(node);
    await this.database.transaction('rw', this.blobGcTables, async () => {
      const existing = await this.database.spriteNodes.get(validated.id);
      await this.database.spriteNodes.put(validated);
      await this.database.projects
        .where('id')
        .equals(validated.projectId)
        .modify({ updatedAt: nowIso() });
      if (existing) {
        await this.cleanupOrphanedBlobsInTx();
      }
    });
    return validated;
  }

  /**
   * Atomically reads, transforms, validates, and commits a `SpriteNode` update inside one
   * serialized Dexie `'rw'` transaction so overlapping tab/worker saves never clobber sibling fields.
   */
  async patchSpriteNode(
    nodeId: string,
    updater: (existing: SpriteNode) => SpriteNode,
  ): Promise<SpriteNode | null> {
    let updated: SpriteNode | null = null;
    await this.database.transaction('rw', this.blobGcTables, async () => {
      const existing = await this.database.spriteNodes.get(nodeId);
      if (!existing) return;
      const validated = SpriteNodeSchema.parse(updater(existing));
      await this.database.spriteNodes.put(validated);
      await this.database.projects
        .where('id')
        .equals(validated.projectId)
        .modify({ updatedAt: nowIso() });
      await this.cleanupOrphanedBlobsInTx();
      updated = validated;
    });
    return updated;
  }

  async deleteSpriteNode(nodeId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      [...this.blobGcTables, this.database.qaReports],
      async () => {
        const node = await this.database.spriteNodes.get(nodeId);
        if (!node) return;
        await this.database.spriteNodes.delete(nodeId);
        await this.database.qaReports.delete(node.projectId);
        await this.cleanupOrphanedBlobsInTx();
      },
    );
  }

  /**
   * Atomically persists edited/inpainted PNG bytes onto `SpriteNode.processedBlobId`
   * with SHA-256 deduplication and orphan blob garbage collection.
   */
  async commitProcessedSpritePixels(
    nodeId: string,
    pngBlob: Blob,
    updates: {
      manualPixelEditCount?: number;
      inpaintHistory?: readonly InpaintHistoryEntry[];
      postProcessConfig?: PostProcessConfig;
      recipeArtBibleHash?: string;
      assetClass?: AssetClass;
    } = {},
  ): Promise<SpriteNode> {
    const bytes = new Uint8Array(await pngBlob.arrayBuffer());
    const mimeType = pngBlob.type || 'image/png';
    const sha256 = await sha256Bytes(bytes);

    return this.database.transaction('rw', this.blobGcTables, async () => {
      const existingNode = await this.database.spriteNodes.get(nodeId);
      if (!existingNode) {
        throw new Error(`SpriteNode "${nodeId}" not found.`);
      }

      let blobRecord = await this.database.blobs.where('sha256').equals(sha256).first();
      if (!blobRecord) {
        const copy = new Uint8Array(bytes.byteLength);
        copy.set(bytes);
        blobRecord = BlobRecordSchema.parse({
          id: createId(),
          mimeType,
          bytes: new Blob([copy.buffer], { type: mimeType }),
          sha256,
          createdAt: nowIso(),
        });
        await this.database.blobs.put(blobRecord);
      }

      const nextNode = SpriteNodeSchema.parse({
        ...existingNode,
        processedBlobId: blobRecord.id,
        ...(updates.assetClass !== undefined ? { assetClass: updates.assetClass } : {}),
        ...(updates.postProcessConfig !== undefined
          ? { postProcessConfig: updates.postProcessConfig }
          : {}),
        ...(updates.recipeArtBibleHash !== undefined
          ? { recipeArtBibleHash: updates.recipeArtBibleHash }
          : {}),
        ...(updates.manualPixelEditCount !== undefined
          ? { manualPixelEditCount: updates.manualPixelEditCount }
          : {}),
        ...(updates.inpaintHistory !== undefined
          ? { inpaintHistory: [...updates.inpaintHistory] }
          : {}),
      });

      await this.database.spriteNodes.put(nextNode);
      await this.database.projects
        .where('id')
        .equals(nextNode.projectId)
        .modify({ updatedAt: nowIso() });
      await this.cleanupOrphanedBlobsInTx();
      return nextNode;
    });
  }

  private async upsertPngBlobInTx(bytes: Uint8Array, sha256: string): Promise<string> {
    const existing = await this.database.blobs.where('sha256').equals(sha256).first();
    if (existing) return existing.id;
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    const rec = BlobRecordSchema.parse({
      id: createId(),
      mimeType: 'image/png',
      bytes: new Blob([copy.buffer], { type: 'image/png' }),
      sha256,
      createdAt: nowIso(),
    });
    await this.database.blobs.put(rec);
    return rec.id;
  }

  /**
   * Atomically commits a processed PNG blob and updates a `SpriteNode` in a single
   * read-write transaction so background pipeline updates never race with orphan GC.
   */
  async patchSpriteNodeWithProcessedBlob(
    nodeId: string,
    pngBlob: Blob,
    updater: (existing: SpriteNode, processedBlobId: string) => SpriteNode,
  ): Promise<SpriteNode | null> {
    const bytes = new Uint8Array(await pngBlob.arrayBuffer());
    const sha256 = await sha256Bytes(bytes);

    let updated: SpriteNode | null = null;
    await this.database.transaction('rw', this.blobGcTables, async () => {
      const existing = await this.database.spriteNodes.get(nodeId);
      if (!existing) return;
      const processedBlobId = await this.upsertPngBlobInTx(bytes, sha256);
      const validated = SpriteNodeSchema.parse(updater(existing, processedBlobId));
      await this.database.spriteNodes.put(validated);
      await this.database.projects
        .where('id')
        .equals(validated.projectId)
        .modify({ updatedAt: nowIso() });
      await this.cleanupOrphanedBlobsInTx();
      updated = validated;
    });
    return updated;
  }

  /**
   * Atomically persists generated Pose Keyframer frame blobs + horizontal strip blob onto
   * `SpriteNode.poseClip` in a single Dexie transaction so blobs cannot be garbage-collected mid-save.
   */
  async commitPoseClipFrames(
    nodeId: string,
    clipBase: PoseClipDefinitionSchemaType,
    framePngBlobs: readonly Blob[],
    stripPngBlob: Blob,
    assetClass?: AssetClass,
  ): Promise<{ node: SpriteNode; poseClip: PoseClipDefinitionSchemaType }> {
    const framePayloads = await Promise.all(
      framePngBlobs.map(async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        return { bytes, sha256: await sha256Bytes(bytes) };
      }),
    );
    const stripBytes = new Uint8Array(await stripPngBlob.arrayBuffer());
    const stripSha = await sha256Bytes(stripBytes);

    let result: { node: SpriteNode; poseClip: PoseClipDefinitionSchemaType } | null = null;
    await this.database.transaction('rw', this.blobGcTables, async () => {
      const existingNode = await this.database.spriteNodes.get(nodeId);
      if (!existingNode) {
        throw new Error(`SpriteNode "${nodeId}" not found.`);
      }
      const frameBlobIds: string[] = [];
      for (const payload of framePayloads) {
        frameBlobIds.push(await this.upsertPngBlobInTx(payload.bytes, payload.sha256));
      }
      const stripBlobId = await this.upsertPngBlobInTx(stripBytes, stripSha);
      const nextClip = PoseClipDefinitionSchema.parse({
        ...clipBase,
        generatedFrameBlobIds: frameBlobIds,
        generatedStripBlobId: stripBlobId,
      });
      const nextNode = SpriteNodeSchema.parse({
        ...existingNode,
        ...(assetClass !== undefined ? { assetClass } : {}),
        poseClip: nextClip,
      });
      await this.database.spriteNodes.put(nextNode);
      await this.database.projects
        .where('id')
        .equals(nextNode.projectId)
        .modify({ updatedAt: nowIso() });
      await this.cleanupOrphanedBlobsInTx();
      result = { node: nextNode, poseClip: nextClip };
    });

    if (!result) {
      throw new Error(`Failed to commit pose clip frames for SpriteNode "${nodeId}".`);
    }
    return result;
  }

  /**
   * Atomically persists baked M44 `_n.png` (and optional `_e.png`) blobs + lighting metadata
   * onto `SpriteNode.lightingBake` with SHA-256 deduplication and zero-orphan cleanup.
   */
  async commitSpriteLightingBake(
    nodeId: string,
    opts: {
      readonly normalPngBlob: Blob;
      readonly emissionPngBlob?: Blob | null;
      readonly normalConfig: NormalBakeConfig;
      readonly emissionConfig: EmissionBakeConfig;
      readonly emissivePixelCount: number;
      readonly occluderVertexCount: number;
    },
  ): Promise<SpriteNode> {
    const normalBytes = new Uint8Array(await opts.normalPngBlob.arrayBuffer());
    const normalSha = await sha256Bytes(normalBytes);
    const emissionBytes = opts.emissionPngBlob
      ? new Uint8Array(await opts.emissionPngBlob.arrayBuffer())
      : null;
    const emissionSha = emissionBytes ? await sha256Bytes(emissionBytes) : null;

    return this.database.transaction('rw', this.blobGcTables, async () => {
      const existingNode = await this.database.spriteNodes.get(nodeId);
      if (!existingNode) {
        throw new Error(`SpriteNode "${nodeId}" not found.`);
      }

      const normalBlobId = await this.upsertPngBlobInTx(normalBytes, normalSha);
      const emissionBlobId =
        emissionBytes && emissionSha
          ? await this.upsertPngBlobInTx(emissionBytes, emissionSha)
          : undefined;

      const nextNode = SpriteNodeSchema.parse({
        ...existingNode,
        lightingBake: {
          normalBlobId,
          ...(emissionBlobId ? { emissionBlobId } : {}),
          normalConfig: opts.normalConfig,
          emissionConfig: opts.emissionConfig,
          emissivePixelCount: opts.emissivePixelCount,
          occluderVertexCount: opts.occluderVertexCount,
          bakedAt: nowIso(),
        },
      });

      await this.database.spriteNodes.put(nextNode);
      await this.database.projects
        .where('id')
        .equals(nextNode.projectId)
        .modify({ updatedAt: nowIso() });
      await this.cleanupOrphanedBlobsInTx();
      return nextNode;
    });
  }

  async listAudioAssets(projectId: string): Promise<AudioAsset[]> {
    const rows = await this.database.audioAssets.where('projectId').equals(projectId).toArray();
    return rows
      .map((row) => AudioAssetSchema.parse(row))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveAudioAsset(asset: AudioAsset): Promise<AudioAsset> {
    const validated = AudioAssetSchema.parse(asset);
    await this.database.transaction('rw', this.blobGcTables, async () => {
      const existing = await this.database.audioAssets.get(validated.id);
      await this.database.audioAssets.put(validated);
      await this.database.projects
        .where('id')
        .equals(validated.projectId)
        .modify({ updatedAt: nowIso() });
      if (existing) {
        await this.cleanupOrphanedBlobsInTx();
      }
    });
    return validated;
  }

  async deleteAudioAsset(assetId: string): Promise<void> {
    await this.database.transaction('rw', this.blobGcTables, async () => {
      const found = await this.database.audioAssets.get(assetId);
      if (!found) return;
      await this.database.audioAssets.delete(assetId);
      await this.cleanupOrphanedBlobsInTx();
    });
  }

  async listEntities(projectId: string): Promise<EntityDefinition[]> {
    const rows = await this.database.entities.where('projectId').equals(projectId).toArray();
    return rows
      .map((row) => EntityDefinitionSchema.parse(row))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveEntity(entity: EntityDefinition): Promise<EntityDefinition> {
    const validated = EntityDefinitionSchema.parse(entity);
    await this.database.transaction(
      'rw',
      [this.database.entities, this.database.projects],
      async () => {
        await this.database.entities.put(validated);
        await this.database.projects
          .where('id')
          .equals(validated.projectId)
          .modify({ updatedAt: nowIso() });
      },
    );
    return validated;
  }

  async deleteEntity(entityId: string): Promise<void> {
    await this.database.entities.delete(entityId);
  }

  async listRooms(projectId: string): Promise<StoredRoomRecord[]> {
    const rows = await this.database.rooms.where('projectId').equals(projectId).toArray();
    return rows
      .map((row) => StoredRoomRecordSchema.parse(row))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async saveRoom(room: StoredRoomRecord): Promise<StoredRoomRecord> {
    const validated = StoredRoomRecordSchema.parse(room);
    await this.database.transaction(
      'rw',
      [this.database.rooms, this.database.projects],
      async () => {
        await this.database.rooms.put(validated);
        await this.database.projects
          .where('id')
          .equals(validated.projectId)
          .modify({ updatedAt: nowIso() });
      },
    );
    return validated;
  }

  async deleteRoom(roomId: string): Promise<void> {
    await this.database.rooms.delete(roomId);
  }

  async listSliceJobs(projectId: string): Promise<SliceJobRecord[]> {
    const rows = await this.database.sliceJobs.where('projectId').equals(projectId).toArray();
    return rows
      .map((row) => SliceJobRecordSchema.parse(row))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getSliceJob(jobId: string): Promise<SliceJobRecord | undefined> {
    const found = await this.database.sliceJobs.get(jobId);
    return found ? SliceJobRecordSchema.parse(found) : undefined;
  }

  async saveSliceJob(job: SliceJobRecord): Promise<SliceJobRecord> {
    const validated = SliceJobRecordSchema.parse(job);
    await this.database.transaction(
      'rw',
      [this.database.sliceJobs, this.database.projects],
      async () => {
        await this.database.sliceJobs.put(validated);
        await this.database.projects
          .where('id')
          .equals(validated.projectId)
          .modify({ updatedAt: nowIso() });
      },
    );
    return validated;
  }

  async deleteSliceJob(jobId: string): Promise<void> {
    await this.database.sliceJobs.delete(jobId);
  }

  async getSyncTarget(projectId: string): Promise<GodotSyncTargetRecord | undefined> {
    const found = await this.database.syncTargets.get(projectId);
    if (!found) return undefined;
    const meta = GodotSyncTargetMetaSchema.parse({
      projectId: found.projectId,
      folderName: found.folderName,
      lastSyncedHashes: found.lastSyncedHashes ?? {},
      lastSyncedAt: found.lastSyncedAt ?? null,
    });
    return {
      ...meta,
      directoryHandle: found.directoryHandle ?? null,
    };
  }

  async saveSyncTarget(record: GodotSyncTargetRecord): Promise<GodotSyncTargetRecord> {
    const meta = GodotSyncTargetMetaSchema.parse({
      projectId: record.projectId,
      folderName: record.folderName,
      lastSyncedHashes: record.lastSyncedHashes ?? {},
      lastSyncedAt: record.lastSyncedAt ?? null,
    });
    const toStore: GodotSyncTargetRecord = {
      ...meta,
      directoryHandle: record.directoryHandle ?? null,
    };
    try {
      await this.database.syncTargets.put(toStore);
    } catch {
      // Non-cloneable mock directory handles (e.g. Playwright/Vitest stubs) still persist metadata cleanly.
      await this.database.syncTargets.put({ ...meta, directoryHandle: null });
    }
    return toStore;
  }

  async clearSyncTarget(projectId: string): Promise<void> {
    await this.database.syncTargets.delete(projectId);
  }

  async listVaultItems(): Promise<VaultItem[]> {
    const rows = await this.database.vaultItems.orderBy('createdAt').reverse().toArray();
    return rows.map((row) => VaultItemSchema.parse(row));
  }

  async getVaultItem(id: string): Promise<VaultItem | undefined> {
    const found = await this.database.vaultItems.get(id);
    return found ? VaultItemSchema.parse(found) : undefined;
  }

  async saveVaultItem(item: VaultItem): Promise<VaultItem> {
    const validated = VaultItemSchema.parse(item);
    await this.database.vaultItems.put(validated);
    return validated;
  }

  async getWorldGraph(projectId: string): Promise<WorldGraph | undefined> {
    const found = await this.database.worldGraphs.get(projectId);
    return found ? WorldGraphSchema.parse(found) : undefined;
  }

  async saveWorldGraph(graph: WorldGraph): Promise<WorldGraph> {
    const validated = WorldGraphSchema.parse({
      ...graph,
      updatedAt: graph.updatedAt || Date.now(),
    });
    await this.database.transaction(
      'rw',
      [this.database.worldGraphs, this.database.projects],
      async () => {
        await this.database.worldGraphs.put(validated);
        await this.database.projects
          .where('id')
          .equals(validated.projectId)
          .modify({ updatedAt: nowIso() });
      },
    );
    return validated;
  }

  /**
   * Atomically commits the `WorldGraph` and its baked pixel-art `minimap.png` blob + atlas JSON
   * in one Dexie transaction so replaced minimap blobs are garbage-collected with zero orphans.
   */
  async commitWorldGraphWithMinimap(
    graph: WorldGraph,
    minimapPngBlob: Blob,
    minimapAtlasJson: string,
  ): Promise<WorldGraph> {
    const bytes = new Uint8Array(await minimapPngBlob.arrayBuffer());
    const sha256 = await sha256Bytes(bytes);

    return this.database.transaction('rw', this.blobGcTables, async () => {
      const minimapBlobId = await this.upsertPngBlobInTx(bytes, sha256);
      const nextGraph = WorldGraphSchema.parse({
        ...graph,
        minimapBlobId,
        minimapAtlasJson,
        updatedAt: Date.now(),
      });
      await this.database.worldGraphs.put(nextGraph);
      await this.database.projects
        .where('id')
        .equals(nextGraph.projectId)
        .modify({ updatedAt: nowIso() });
      await this.cleanupOrphanedBlobsInTx();
      return nextGraph;
    });
  }

  async getGameDataRegistry(projectId: string): Promise<GameDataRegistry | undefined> {
    const found = await this.database.gameDataRegistries.get(projectId);
    return found ? GameDataRegistrySchema.parse(found) : undefined;
  }

  async saveGameDataRegistry(registry: GameDataRegistry): Promise<GameDataRegistry> {
    const validated = GameDataRegistrySchema.parse({
      ...registry,
      updatedAt: registry.updatedAt || Date.now(),
    });
    await this.database.transaction(
      'rw',
      [this.database.gameDataRegistries, this.database.projects],
      async () => {
        await this.database.gameDataRegistries.put(validated);
        await this.database.projects
          .where('id')
          .equals(validated.projectId)
          .modify({ updatedAt: nowIso() });
      },
    );
    return validated;
  }

  async deleteVaultItem(id: string): Promise<void> {
    await this.database.transaction('rw', this.blobGcTables, async () => {
      const found = await this.database.vaultItems.get(id);
      if (!found) return;
      await this.database.vaultItems.delete(id);
      await this.cleanupOrphanedBlobsInTx();
    });
  }

  async promoteSpriteNodeToVault(
    node: SpriteNode,
    options?: {
      readonly name?: string;
      readonly tags?: readonly string[];
      readonly sourceProjectName?: string;
    },
  ): Promise<VaultItem> {
    const label =
      options?.name?.trim() ||
      node.generationMeta.promptDelta.trim() ||
      `${node.kind} #${node.generationMeta.seed}`;
    const item = buildSpriteVaultItem({
      id: createId(),
      name: label.slice(0, 120),
      node,
      tags: options?.tags,
      sourceProjectName: options?.sourceProjectName,
    });
    return this.saveVaultItem(item);
  }

  async promoteShaderToVault(
    name: string,
    shaderConfig: ShaderConfig,
    options?: { readonly tags?: readonly string[]; readonly sourceProjectName?: string },
  ): Promise<VaultItem> {
    const item = buildShaderVaultItem({
      id: createId(),
      name: name.trim().slice(0, 120) || `Shader (${shaderConfig.presetId})`,
      shaderConfig,
      tags: options?.tags,
      sourceProjectName: options?.sourceProjectName,
    });
    return this.saveVaultItem(item);
  }

  async promoteBmfontToVault(
    name: string,
    bitmapFont: BitmapFontConfig,
    options?: { readonly tags?: readonly string[]; readonly sourceProjectName?: string },
  ): Promise<VaultItem> {
    const item = buildBmfontVaultItem({
      id: createId(),
      name: name.trim().slice(0, 120) || bitmapFont.fontName,
      bitmapFont,
      tags: options?.tags,
      sourceProjectName: options?.sourceProjectName,
    });
    return this.saveVaultItem(item);
  }

  async promoteVfxToVault(
    name: string,
    vfxFlipbook: VfxFlipbookConfig,
    options?: { readonly tags?: readonly string[]; readonly sourceProjectName?: string },
  ): Promise<VaultItem> {
    const item = buildVfxVaultItem({
      id: createId(),
      name: name.trim().slice(0, 120) || `VFX (${vfxFlipbook.archetype})`,
      vfxFlipbook,
      tags: options?.tags,
      sourceProjectName: options?.sourceProjectName,
    });
    return this.saveVaultItem(item);
  }

  async promoteSfxToVault(
    asset: AudioAsset,
    options?: {
      readonly name?: string;
      readonly tags?: readonly string[];
      readonly sourceProjectName?: string;
    },
  ): Promise<VaultItem> {
    const item = buildSfxVaultItem({
      id: createId(),
      name: (options?.name?.trim() || asset.name).slice(0, 120),
      audioAsset: asset,
      tags: options?.tags,
      sourceProjectName: options?.sourceProjectName,
    });
    return this.saveVaultItem(item);
  }

  async promoteArtBibleToVault(
    name: string,
    artBible: ArtBible,
    options?: { readonly tags?: readonly string[]; readonly sourceProjectName?: string },
  ): Promise<VaultItem> {
    const item = buildArtBibleVaultItem({
      id: createId(),
      name: name.trim().slice(0, 120) || 'Art Bible Style Lock',
      artBible,
      tags: options?.tags,
      sourceProjectName: options?.sourceProjectName,
    });
    return this.saveVaultItem(item);
  }

  async importVaultItemToProject(
    vaultItemId: string,
    targetProjectId: string,
    options?: { readonly targetSpriteNodeId?: string },
  ): Promise<{
    readonly kind: VaultItem['kind'];
    readonly spriteNode?: SpriteNode;
    readonly audioAsset?: AudioAsset;
  }> {
    const vaultItem = await this.getVaultItem(vaultItemId);
    if (!vaultItem) {
      throw new Error(`Vault item "${vaultItemId}" not found.`);
    }
    const targetProject = await this.getProject(targetProjectId);
    if (!targetProject) {
      throw new Error(`Target project "${targetProjectId}" not found.`);
    }

    const payload = parseVaultPayload(vaultItem);
    if (payload.kind === 'sprite') {
      const clonedNode = SpriteNodeSchema.parse({
        ...payload.node,
        id: createId(),
        projectId: targetProjectId,
        parentId: null,
        generationMeta: {
          ...payload.node.generationMeta,
          promptDelta: payload.node.generationMeta.promptDelta || vaultItem.name,
          createdAt: nowIso(),
        },
      });
      const saved = await this.saveSpriteNode(clonedNode);
      return { kind: 'sprite', spriteNode: saved };
    }

    if (payload.kind === 'sfx') {
      const clonedAudio = AudioAssetSchema.parse({
        ...payload.audioAsset,
        id: createId(),
        projectId: targetProjectId,
        createdAt: nowIso(),
      });
      const saved = await this.saveAudioAsset(clonedAudio);
      return { kind: 'sfx', audioAsset: saved };
    }

    if (payload.kind === 'art-bible') {
      await this.updateProjectArtBible(targetProjectId, payload.artBible);
      return { kind: 'art-bible' };
    }

    // shader | bmfont | vfx apply to a selected or latest sprite node in the project
    const projectNodes = await this.listSpriteNodes(targetProjectId);
    const chosenNode =
      (options?.targetSpriteNodeId
        ? projectNodes.find((n) => n.id === options.targetSpriteNodeId)
        : undefined) ?? projectNodes[projectNodes.length - 1];

    if (!chosenNode) {
      throw new Error(
        `Create or import a sprite in "${targetProject.name}" before applying "${vaultItem.name}".`,
      );
    }

    const updatedNode = SpriteNodeSchema.parse({
      ...chosenNode,
      ...(payload.kind === 'shader' ? { shaderConfig: payload.shaderConfig } : {}),
      ...(payload.kind === 'bmfont' ? { bitmapFont: payload.bitmapFont } : {}),
      ...(payload.kind === 'vfx' ? { vfxFlipbook: payload.vfxFlipbook } : {}),
    });
    const saved = await this.saveSpriteNode(updatedNode);
    return { kind: payload.kind, spriteNode: saved };
  }

  async deleteProjectCascade(projectId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      [
        ...this.blobGcTables,
        this.database.entities,
        this.database.rooms,
        this.database.sliceJobs,
        this.database.syncTargets,
        this.database.qaReports,
        this.database.gameDataRegistries,
      ],
      async () => {
        await this.database.spriteNodes.where('projectId').equals(projectId).delete();
        await this.database.audioAssets.where('projectId').equals(projectId).delete();
        await this.database.entities.where('projectId').equals(projectId).delete();
        await this.database.rooms.where('projectId').equals(projectId).delete();
        await this.database.sliceJobs.where('projectId').equals(projectId).delete();
        await this.database.agentCheckpoints.where('projectId').equals(projectId).delete();
        await this.database.worldGraphs.delete(projectId);
        await this.database.gameDataRegistries.delete(projectId);
        await this.database.syncTargets.delete(projectId);
        await this.database.qaReports.delete(projectId);
        await this.database.projects.delete(projectId);
        await this.cleanupOrphanedBlobsInTx();
      },
    );
  }

  async listAgentCheckpoints(projectId: string): Promise<AgentCheckpoint[]> {
    const rows = await this.database.agentCheckpoints
      .where('projectId')
      .equals(projectId)
      .toArray();
    return rows
      .map((row) => AgentCheckpointSchema.parse(row))
      .sort((a, b) => b.createdAt - a.createdAt);
  }

  async getAgentCheckpoint(id: string): Promise<AgentCheckpoint | undefined> {
    const found = await this.database.agentCheckpoints.get(id);
    return found ? AgentCheckpointSchema.parse(found) : undefined;
  }

  async saveAgentCheckpoint(record: AgentCheckpoint): Promise<AgentCheckpoint> {
    const validated = AgentCheckpointSchema.parse(record);
    await this.database.agentCheckpoints.put(validated);
    return validated;
  }

  async deleteAgentCheckpoint(id: string): Promise<void> {
    await this.database.agentCheckpoints.delete(id);
  }

  async getQaReport(projectId: string): Promise<StoredQaReportRecord | undefined> {
    const found = await this.database.qaReports.get(projectId);
    return found ? StoredQaReportRecordSchema.parse(found) : undefined;
  }

  async saveQaReport(record: StoredQaReportRecord): Promise<StoredQaReportRecord> {
    const validated = StoredQaReportRecordSchema.parse(record);
    await this.database.qaReports.put(validated);
    return validated;
  }

  async deleteQaReport(projectId: string): Promise<void> {
    await this.database.qaReports.delete(projectId);
  }

  async cleanupOrphanedBlobs(): Promise<number> {
    return this.database.transaction('rw', this.blobGcTables, async () =>
      this.cleanupOrphanedBlobsInTx(),
    );
  }

  private async cleanupOrphanedBlobsInTx(): Promise<number> {
    const orphanedIds = await findOrphanBlobIds(this.database);
    if (orphanedIds.length > 0) {
      await this.database.blobs.bulkDelete(orphanedIds);
    }
    return orphanedIds.length;
  }
}

/**
 * Pure integrity check scanning all projects, sprite nodes, and audio assets to identify
 * unreferenced binary blobs in the `blobs` table.
 */
export async function findOrphanBlobIds(database: NibgridDatabase = db): Promise<string[]> {
  const referencedBlobIds = new Set<string>();
  const allProjects = await database.projects.toArray();
  for (const proj of allProjects) {
    for (const blobId of proj.artBible.goldenReferenceBlobIds) {
      referencedBlobIds.add(blobId);
    }
  }

  const allNodes = await database.spriteNodes.toArray();
  for (const node of allNodes) {
    referencedBlobIds.add(node.imageBlobId);
    if (node.maskBlobId) {
      referencedBlobIds.add(node.maskBlobId);
    }
    if (node.processedBlobId) {
      referencedBlobIds.add(node.processedBlobId);
    }
    if (node.lightingBake?.normalBlobId) {
      referencedBlobIds.add(node.lightingBake.normalBlobId);
    }
    if (node.lightingBake?.emissionBlobId) {
      referencedBlobIds.add(node.lightingBake.emissionBlobId);
    }
    if (node.parallaxScene?.masterKeyframeBlobId) {
      referencedBlobIds.add(node.parallaxScene.masterKeyframeBlobId);
    }
    for (const layer of node.parallaxScene?.layers ?? []) {
      if (layer.blobId) {
        referencedBlobIds.add(layer.blobId);
      }
    }
    if (node.poseClip?.generatedStripBlobId) {
      referencedBlobIds.add(node.poseClip.generatedStripBlobId);
    }
    for (const frameBlobId of node.poseClip?.generatedFrameBlobIds ?? []) {
      referencedBlobIds.add(frameBlobId);
    }
  }

  const allAudio = await database.audioAssets.toArray();
  for (const asset of allAudio) {
    referencedBlobIds.add(asset.wavBlobId);
    for (const varBlobId of asset.variationBlobIds) {
      referencedBlobIds.add(varBlobId);
    }
  }

  const allVaultItems = await database.vaultItems.toArray();
  for (const item of allVaultItems) {
    for (const blobId of item.blobIds ?? []) {
      referencedBlobIds.add(blobId);
    }
    if (item.previewBlobId) {
      referencedBlobIds.add(item.previewBlobId);
    }
  }

  const allCheckpoints = await database.agentCheckpoints.toArray();
  for (const checkpoint of allCheckpoints) {
    for (const blobId of checkpoint.referencedBlobIds ?? []) {
      referencedBlobIds.add(blobId);
    }
  }

  const allWorldGraphs = await database.worldGraphs.toArray();
  for (const worldGraph of allWorldGraphs) {
    if (worldGraph.minimapBlobId) {
      referencedBlobIds.add(worldGraph.minimapBlobId);
    }
  }

  const allBlobIds = await database.blobs.toCollection().primaryKeys();
  return allBlobIds.filter((id) => !referencedBlobIds.has(id));
}

export const repository = new NibgridRepository(db);
