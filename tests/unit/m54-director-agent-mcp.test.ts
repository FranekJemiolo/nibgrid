import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { validateGodotProjectHeadless } from '../../packages/vscode-extension/src/extension';
import { NIBGRID_MCP_TOOLS } from '../../packages/vscode-extension/src/mcpToolServer';
import { runRepoParityCheck } from '../../scripts/verify-parity';
import { buildMentionCatalog, resolveAtMentions } from '../../src/agent/contextResolver';
import { commitStagedTurn, restoreCheckpoint } from '../../src/agent/stagingTransactions';
import { STUDIO_TOOL_NAMES, executeStagedToolCall } from '../../src/agent/studioToolRegistry';
import {
  NibgridDatabase,
  NibgridRepository,
  createDefaultMockProviderConfig,
  findOrphanBlobIds,
} from '../../src/db/database';
import { planOfflineMockAgentTurn } from '../../src/providers/assetAgentAdapter';
import { applyGodotBackSyncDelta, parseGodotBackSyncDelta } from '../../src/sync/bidirectionalSync';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): NibgridDatabase {
  const db = new NibgridDatabase(`nibgrid-m54-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return db;
}

afterEach(async () => {
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

describe('M54: Director Verbs in Composer/MCP, Bidirectional Godot Sync & Headless Check', () => {
  it('maintains 1:1 parity across STUDIO_TOOL_NAMES, MCP tools, and VS Code languageModelTools', async () => {
    expect(STUDIO_TOOL_NAMES.length).toBe(13);
    expect(NIBGRID_MCP_TOOLS.length).toBe(14);
    const parity = await runRepoParityCheck(process.cwd());
    expect(parity.errors).toEqual([]);
    expect(parity.ok).toBe(true);
  });

  it('stages, commits, and rolls back all 5 Director Verbs with zero orphan blobs', async () => {
    const db = createTestDb();
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M54 Director Agent');
    const mockCfg = createDefaultMockProviderConfig();

    const prompts = [
      'create enemy frost_bat',
      'create room frost_cavern',
      'balance goblin_scout TTK faster',
      'add dialogue node crypt_intro "Beware the frost bats!"',
      'autofix preflight issues',
    ];

    for (const prompt of prompts) {
      const [spriteNodes, entities, audioAssets, rooms] = await Promise.all([
        repo.listSpriteNodes(project.id),
        repo.listEntities(project.id),
        repo.listAudioAssets(project.id),
        repo.listRooms(project.id),
      ]);
      const index = { project, spriteNodes, entities, audioAssets, rooms };
      const resolved = resolveAtMentions(prompt, index);
      expect(buildMentionCatalog(index).length).toBeGreaterThanOrEqual(1);

      const plan = planOfflineMockAgentTurn(prompt, resolved, project.artBible);
      expect(plan.toolCalls.length).toBeGreaterThanOrEqual(1);

      const staged = [];
      for (const tc of plan.toolCalls) {
        const produced = await executeStagedToolCall(db, project.id, tc, mockCfg);
        staged.push(...produced);
      }
      expect(staged.length).toBeGreaterThanOrEqual(1);

      const accepted = staged.map((s) => ({ ...s, status: 'accepted' as const }));
      const committed = await commitStagedTurn(db, project.id, prompt, accepted);
      expect(committed.acceptedCount).toBe(accepted.length);
      expect(committed.checkpoint).toBeTruthy();
    }

    const entitiesAfter = await repo.listEntities(project.id);
    const roomsAfter = await repo.listRooms(project.id);
    const worldAfter = await repo.getWorldGraph(project.id);
    const gameDataAfter = await repo.getGameDataRegistry(project.id);
    const narrativeAfter = await repo.getNarrativeBundle(project.id);

    expect(entitiesAfter.some((e) => e.slug === 'frost_bat')).toBe(true);
    expect(roomsAfter.some((r) => r.slug === 'frost_cavern')).toBe(true);
    expect(worldAfter?.rooms.length).toBeGreaterThanOrEqual(1);
    expect(gameDataAfter?.enemies[0]?.maxHp).toBeGreaterThan(0);
    expect(narrativeAfter?.graph.nodes.some((n) => n.id === 'crypt_intro')).toBe(true);

    // Restore checkpoints in reverse order -> reverts cleanly with 0 orphan blobs
    const checkpoints = await repo.listAgentCheckpoints(project.id);
    for (const cp of checkpoints) {
      await restoreCheckpoint(db, cp.id);
    }
    expect(await repo.listEntities(project.id)).toEqual([]);
    expect(await repo.listRooms(project.id)).toEqual([]);
    expect(await findOrphanBlobIds(db)).toEqual([]);
  });

  it('parses & applies Godot editor back-sync delta and runs safe headless Godot verification', async () => {
    const db = createTestDb();
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M54 BackSync');
    const mockCfg = createDefaultMockProviderConfig();

    const staged = await executeStagedToolCall(
      db,
      project.id,
      {
        toolName: 'create_entity_from_prompt',
        args: { slug: 'swift_ranger', prompt: 'forest ranger hero', role: 'hero' },
      },
      mockCfg,
    );
    await commitStagedTurn(
      db,
      project.id,
      'create ranger',
      staged.map((s) => ({ ...s, status: 'accepted' as const })),
    );

    const entities = await repo.listEntities(project.id);
    const delta = parseGodotBackSyncDelta(
      JSON.stringify({
        version: 1,
        updatedAt: Date.now(),
        entityStatOverrides: [{ slug: 'swift_ranger', moveSpeedPx: 245, attackDamage: 32 }],
        roomSpawnOverrides: [],
      }),
    );
    const merged = applyGodotBackSyncDelta({ entities, rooms: [], delta });
    expect(merged.updatedEntityCount).toBe(1);
    expect(merged.entities[0]?.playtestConfig?.moveSpeedPx).toBe(245);
    expect(merged.entities[0]?.scriptContent).toContain('@export var move_speed: float = 245.0');

    const mockExec = vi.fn((_file, _args, _opts, cb) => {
      cb?.(null, 'Godot Engine v4.3.stable', '');
      return { pid: 1234 };
    });
    const checkOk = await validateGodotProjectHeadless({
      workspacePath: '/tmp/godot_proj',
      execFileImpl: mockExec,
    });
    expect(checkOk.ok).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'godot',
      ['--headless', '--path', '/tmp/godot_proj', '--check-only', '--quit'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
  });
});
