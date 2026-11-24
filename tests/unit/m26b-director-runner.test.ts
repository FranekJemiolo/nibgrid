import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  OFFLINE_MOCK_PROVIDER_ID,
  findOrphanBlobIds,
} from '../../src/db/database';
import { ProviderError } from '../../src/providers/errors';
import {
  buildMockEntityBlueprint,
  draftEntityBlueprint,
  executeEntityDirectorPlan,
} from '../../src/providers/entityDirector';
import { collectEntitySyncFiles } from '../../src/sync/fsaaSyncEngine';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m26b-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return { db, repo: new NibgridRepository(db) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

describe('M26B: GenAI / Mock Prompt-to-Entity Director & Abort/Redaction Safety', () => {
  it('executes full Offline Mock build committing SpriteNode, AudioAssets, EntityDefinition & .gd script into M25 sync files', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('Director Mock Foundry');
    const providers = await repo.listProviderConfigs();
    const mockProvider = providers.find((p) => p.id === OFFLINE_MOCK_PROVIDER_ID)!;

    const draft = await draftEntityBlueprint({
      prompt: 'Armored goblin scout, 32px pixel art, sword slash, heavy boots',
      genre: 'side-platformer',
      artBible: project.artBible,
      providerConfig: mockProvider,
    });
    expect(draft.usedMock).toBe(true);
    expect(draft.costEstimate.estimatedUsd).toBe(0);

    const stagesDone: string[] = [];
    const result = await executeEntityDirectorPlan(db, project.id, draft.blueprint, {
      providerConfig: mockProvider,
      generateGdScript: true,
      onProgress: (ev) => {
        if (ev.status === 'done') stagesDone.push(ev.stage);
      },
    });

    expect(stagesDone).toEqual(['sprite', 'collider', 'sockets', 'sfx', 'gdscript', 'commit']);
    expect(result.scriptCode).toContain(`extends ${draft.blueprint.bodyType}`);
    expect(result.audioAssets.length).toBeGreaterThanOrEqual(2);
    expect(result.entity.scriptResPath).toMatch(/^res:\/\/assets\/nibgrid\/.*\.gd$/);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    const syncFiles = await collectEntitySyncFiles(
      db,
      project,
      result.entity,
      [result.spriteNode],
      result.audioAssets,
    );
    const tscnFile = syncFiles.find((f) => f.relativePath.endsWith('.tscn'));
    const gdFile = syncFiles.find((f) => f.relativePath.endsWith('.gd'));
    expect(tscnFile).toBeDefined();
    expect(gdFile).toBeDefined();

    const tscnText =
      typeof tscnFile!.content === 'string'
        ? tscnFile!.content
        : new TextDecoder().decode(tscnFile!.content);
    const loadStepsMatch = /\[gd_scene load_steps=(\d+) format=3\]/.exec(tscnText);
    const extMatches = [...tscnText.matchAll(/\[ext_resource [^\]]*id="([^"]+)"\]/g)];
    expect(Number(loadStepsMatch![1])).toBe(extMatches.length + 1);
    expect(tscnText).toContain('type="Script"');
    expect(tscnText).toContain('script = ExtResource(');
  });

  it('aborts cleanly right after collider stage leaving zero entities and zero orphan blobs', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('Abort Director Test');
    const providers = await repo.listProviderConfigs();
    const mockProvider = providers.find((p) => p.id === OFFLINE_MOCK_PROVIDER_ID)!;
    const blueprint = buildMockEntityBlueprint('Slime hazard', 'top-down');

    const controller = new AbortController();
    await expect(
      executeEntityDirectorPlan(db, project.id, blueprint, {
        providerConfig: mockProvider,
        signal: controller.signal,
        onProgress: (ev) => {
          if (ev.stage === 'collider' && ev.status === 'done') {
            controller.abort();
          }
        },
      }),
    ).rejects.toThrow();

    expect(await repo.listEntities(project.id)).toEqual([]);
    expect(await repo.listSpriteNodes(project.id)).toEqual([]);
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });

  it('redacts Gemini API key completely from HTTP 401 errors across blueprint planning and execution', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('Redaction Director Test');
    const secretKey = 'AIzaSyDIRECTOR999SECRET';
    const geminiCfg = {
      id: 'gemini-test',
      kind: 'gemini' as const,
      displayName: 'Gemini Test',
      modelId: 'gemini-2.5-flash-image',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: secretKey,
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: true,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 401,
        text: async () => `API key invalid: ${secretKey}`,
      })),
    );

    let caughtPlan: unknown;
    try {
      await draftEntityBlueprint({
        prompt: 'Goblin',
        genre: 'top-down',
        artBible: project.artBible,
        providerConfig: geminiCfg,
      });
    } catch (err) {
      caughtPlan = err;
    }
    expect(caughtPlan).toBeInstanceOf(ProviderError);
    expect((caughtPlan as ProviderError).code).toBe('UNAUTHORIZED');
    expect((caughtPlan as ProviderError).message).not.toContain(secretKey);
    expect((caughtPlan as ProviderError).remediation).not.toContain(secretKey);

    let caughtExec: unknown;
    try {
      await executeEntityDirectorPlan(
        db,
        project.id,
        buildMockEntityBlueprint('Goblin', 'top-down'),
        {
          providerConfig: geminiCfg,
        },
      );
    } catch (err) {
      caughtExec = err;
    }
    expect(caughtExec).toBeInstanceOf(ProviderError);
    expect((caughtExec as ProviderError).message).not.toContain(secretKey);
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });
});
