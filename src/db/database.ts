import Dexie, { type Table } from 'dexie';
import {
  ArtBibleSchema,
  BlobRecordSchema,
  ProjectSchema,
  ProviderConfigSchema,
  SpriteNodeSchema,
  createDefaultArtBible,
  type ArtBible,
  type BlobRecord,
  type Project,
  type ProviderConfig,
  type SpriteNode,
} from '../domain/schemas';
import { sha256Bytes } from '../processing/hash';

export const OFFLINE_MOCK_PROVIDER_ID = 'offline-mock';

export interface ProjectSummary {
  project: Project;
  spriteCount: number;
}

export class NibgridDatabase extends Dexie {
  projects!: Table<Project, string>;
  blobs!: Table<BlobRecord, string>;
  spriteNodes!: Table<SpriteNode, string>;
  providerConfigs!: Table<ProviderConfig, string>;

  constructor(dbName = 'nibgrid-db') {
    super(dbName);
    this.version(1).stores({
      projects: 'id, updatedAt, name',
      blobs: 'id, sha256, createdAt',
      spriteNodes: 'id, projectId, parentId, [projectId+createdAt]',
      providerConfigs: 'id, kind, updatedAt',
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

export class NibgridRepository {
  private readonly database: NibgridDatabase;

  constructor(database: NibgridDatabase = db) {
    this.database = database;
  }

  async ensureDefaultProviderConfigs(): Promise<ProviderConfig[]> {
    const existing = await this.database.providerConfigs.toArray();
    const hasMock = existing.some((cfg) => cfg.id === OFFLINE_MOCK_PROVIDER_ID);
    if (!hasMock) {
      const mockConfig = createDefaultMockProviderConfig();
      await this.database.providerConfigs.put(mockConfig);
    }
    const all = await this.database.providerConfigs.toArray();
    return all.map((item) => ProviderConfigSchema.parse(item));
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
    if (id === OFFLINE_MOCK_PROVIDER_ID) {
      throw new Error('The built-in Offline Mock Provider cannot be deleted.');
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
    updates: { name?: string; artBible?: ArtBible },
  ): Promise<Project> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      throw new Error(`Project "${projectId}" not found.`);
    }

    const updated = ProjectSchema.parse({
      ...existing,
      name: updates.name ?? existing.name,
      artBible: updates.artBible ? ArtBibleSchema.parse(updates.artBible) : existing.artBible,
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
    return validated.sort((a, b) =>
      a.generationMeta.createdAt.localeCompare(b.generationMeta.createdAt),
    );
  }

  async saveSpriteNode(node: SpriteNode): Promise<SpriteNode> {
    const validated = SpriteNodeSchema.parse(node);
    await this.database.spriteNodes.put(validated);
    await this.database.projects
      .where('id')
      .equals(validated.projectId)
      .modify({ updatedAt: nowIso() });
    return validated;
  }

  async deleteSpriteNode(nodeId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.spriteNodes,
      this.database.projects,
      this.database.blobs,
      async () => {
        const node = await this.database.spriteNodes.get(nodeId);
        if (!node) return;
        await this.database.spriteNodes.delete(nodeId);
        await this.cleanupOrphanedBlobsInTx();
      },
    );
  }

  async deleteProjectCascade(projectId: string): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.projects,
      this.database.spriteNodes,
      this.database.blobs,
      async () => {
        await this.database.spriteNodes.where('projectId').equals(projectId).delete();
        await this.database.projects.delete(projectId);
        await this.cleanupOrphanedBlobsInTx();
      },
    );
  }

  async cleanupOrphanedBlobs(): Promise<number> {
    return this.database.transaction(
      'rw',
      this.database.projects,
      this.database.spriteNodes,
      this.database.blobs,
      async () => this.cleanupOrphanedBlobsInTx(),
    );
  }

  private async cleanupOrphanedBlobsInTx(): Promise<number> {
    const referencedBlobIds = new Set<string>();
    const allProjects = await this.database.projects.toArray();
    for (const proj of allProjects) {
      for (const blobId of proj.artBible.goldenReferenceBlobIds) {
        referencedBlobIds.add(blobId);
      }
    }

    const allNodes = await this.database.spriteNodes.toArray();
    for (const node of allNodes) {
      referencedBlobIds.add(node.imageBlobId);
      if (node.maskBlobId) {
        referencedBlobIds.add(node.maskBlobId);
      }
    }

    const allBlobIds = await this.database.blobs.toCollection().primaryKeys();
    const orphanedIds = allBlobIds.filter((id) => !referencedBlobIds.has(id));
    if (orphanedIds.length > 0) {
      await this.database.blobs.bulkDelete(orphanedIds);
    }
    return orphanedIds.length;
  }
}

export const repository = new NibgridRepository(db);

