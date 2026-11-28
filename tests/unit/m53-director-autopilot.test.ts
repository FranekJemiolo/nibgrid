import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  createDefaultMockProviderConfig,
} from '../../src/db/database';
import { validateGodotSceneGraph } from '../../src/export/godotProjectCompiler';
import {
  createSliceJobRecord,
  invalidateStaleDagNodes,
  runSliceDag,
} from '../../src/processing/sliceDagRunner';
import {
  buildMockVerticalSliceBlueprint,
  collectVerticalSliceGodotSyncFiles,
  createSliceNodeExecutor,
} from '../../src/providers/verticalSliceDirector';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): NibgridDatabase {
  const db = new NibgridDatabase(`nibgrid-m53-${globalThis.crypto.randomUUID()}`);
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

describe('M53: Full-Game Reactive Autopilot DAG & Director Studio Core', () => {
  it('appends full-game nodes for multi-room-dungeon scope and invalidates only affected branches on edit', () => {
    const bp = {
      ...buildMockVerticalSliceBlueprint(
        '16-bit gothic platformer knight and skeletons',
        'side-platformer',
      ),
      scope: 'multi-room-dungeon' as const,
      includeFullGameKit: true,
    };
    const job = createSliceJobRecord('proj-m53', bp, 'instant-draft');
    const ids = job.nodes.map((n) => n.id);

    expect(ids).toContain('world_graph');
    expect(ids).toContain('game_data');
    expect(ids).toContain('narrative_l10n');
    expect(ids).toContain('self_heal_qa');
    expect(ids).toContain('gamekit_bundle');

    const completedJob = {
      ...job,
      status: 'completed' as const,
      nodes: job.nodes.map((n) => ({ ...n, status: 'done' as const })),
    };

    // Edit only terrainPrompt -> terrain_tileset + downstream room_level/world_graph/main_scene/self_heal_qa/gamekit_bundle invalidate,
    // while unrelated branches (parallax_stack, bmfont, ui_theme, entities) remain done!
    const editedBp = {
      ...bp,
      terrainPrompt: 'Volcanic obsidian cavern bricks',
    };
    const invalidated = invalidateStaleDagNodes(completedJob, editedBp);
    const byId = new Map(invalidated.nodes.map((n) => [n.id, n.status]));

    expect(byId.get('terrain_tileset')).toBe('pending');
    expect(byId.get('room_level')).toBe('pending');
    expect(byId.get('world_graph')).toBe('pending');
    expect(byId.get('gamekit_bundle')).toBe('pending');
    expect(byId.get('parallax_stack')).toBe('done');
    expect(byId.get('bmfont')).toBe('done');
    expect(byId.get('ui_theme')).toBe('done');
  });

  it('executes full-game DAG end-to-end and compiles a zero-broken-ref Godot 4 GameKit tree', async () => {
    const db = createTestDb();
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M53 Full Game');

    const bp = {
      ...buildMockVerticalSliceBlueprint(
        '16-bit gothic platformer knight and skeletons',
        'side-platformer',
      ),
      scope: 'multi-room-dungeon' as const,
      includeFullGameKit: true,
    };
    const initialJob = createSliceJobRecord(project.id, bp, 'instant-draft');
    const mockCfg = createDefaultMockProviderConfig();
    const executor = createSliceNodeExecutor({
      database: db,
      projectId: project.id,
      tier: 'instant-draft',
      providerConfig: mockCfg,
    });

    const gatedJob = await runSliceDag(initialJob, executor, { approvedAnchor: false });
    expect(gatedJob.status).toBe('awaiting-approval');

    const completedJob = await runSliceDag(gatedJob, executor, { approvedAnchor: true });
    expect(completedJob.status).toBe('completed');
    expect(completedJob.nodes.every((n) => n.status === 'done')).toBe(true);

    const freshProj = (await repo.getProject(project.id))!;
    const files = await collectVerticalSliceGodotSyncFiles(db, freshProj, completedJob);
    const paths = files.map((f) => f.relativePath);

    expect(paths).toContain('project.godot');
    expect(paths).toContain('main.tscn');
    expect(paths).toContain('default_bus_layout.tres');
    expect(paths).toContain('world/WorldTransitionManager.gd');
    expect(paths).toContain('world/minimap.png');
    expect(paths).toContain('data/schemas/EnemyStatData.gd');
    expect(paths).toContain('localization/strings.csv');
    expect(paths).toContain('addons/nibgrid_sync/plugin.cfg');
    expect(
      paths.filter((p) => p.startsWith('levels/') && p.endsWith('.tscn')).length,
    ).toBeGreaterThanOrEqual(3);

    const validation = validateGodotSceneGraph(files);
    expect(validation.brokenReferences).toEqual([]);
    expect(validation.ok).toBe(true);
  });
});
