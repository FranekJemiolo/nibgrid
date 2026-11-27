import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import {
  createSliceJobRecord,
  runSliceDag,
  type SliceNodeExecutor,
} from '../../src/processing/sliceDagRunner';
import {
  estimateSliceCostUsd,
  parseAndClampVerticalSliceBlueprint,
} from '../../src/processing/verticalSliceSchema';

describe('M37A VerticalSliceBlueprint, Resumable DAG Runner & Dexie v7 sliceJobs', () => {
  it('parses & clamps VerticalSliceBlueprint dimensions, roles, unique snake_case slugs and computes tier costs', () => {
    const clamped = parseAndClampVerticalSliceBlueprint(
      {
        projectSlug: '16-Bit Gothic Crypt!',
        genre: 'side-platformer',
        artBiblePrompt: '16-bit gothic platformer',
        artMode: 'pixel-art',
        tileSizePx: 29,
        cast: [
          {
            slug: 'Armored Knight!',
            role: 'enemy',
            prompt: 'Hero knight',
            bodyType: 'CharacterBody2D',
          },
          {
            slug: 'Armored Knight!',
            role: 'enemy',
            prompt: 'Second entity',
            bodyType: 'CharacterBody2D',
          },
          {
            slug: 'Skeleton Archer',
            role: 'enemy',
            prompt: 'Bone archer',
            bodyType: 'CharacterBody2D',
          },
        ],
        terrainPrompt: 'stone brick',
        parallaxPrompt: 'moonlit crypt',
        uiThemePrompt: 'gothic hud',
        roomPrompt: 'boss arena',
        roomCols: 99,
        roomRows: 3,
      },
      { fallbackPrompt: 'gothic fallback' },
    );

    expect(clamped.projectSlug).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(clamped.tileSizePx).toBe(32);
    expect(clamped.roomCols).toBe(48);
    expect(clamped.roomRows).toBe(10);
    expect(clamped.cast[0]?.role).toBe('hero');
    expect(new Set(clamped.cast.map((c) => c.slug)).size).toBe(3);

    const draftCost = estimateSliceCostUsd(clamped, 'instant-draft');
    const hybridCost = estimateSliceCostUsd(clamped, 'hybrid-prod');
    const fullCost = estimateSliceCostUsd(clamped, 'full-genai');

    expect(draftCost.totalUsd).toBe(0);
    expect(hybridCost.totalUsd).toBeGreaterThan(0);
    expect(fullCost.totalUsd).toBeGreaterThan(hybridCost.totalUsd);
  });

  it('halts strictly at awaiting-approval before fan-out, then resumes failed branches without re-running completed nodes', async () => {
    const blueprint = parseAndClampVerticalSliceBlueprint({
      projectSlug: 'gothic_slice',
      genre: 'side-platformer',
      artBiblePrompt: 'gothic',
      artMode: 'pixel-art',
      tileSizePx: 32,
      cast: [
        {
          slug: 'armored_knight',
          role: 'hero',
          prompt: 'knight hero',
          bodyType: 'CharacterBody2D',
        },
        {
          slug: 'skeleton_guard',
          role: 'enemy',
          prompt: 'skeleton sword',
          bodyType: 'CharacterBody2D',
        },
        {
          slug: 'skeleton_archer',
          role: 'enemy',
          prompt: 'skeleton bow',
          bodyType: 'CharacterBody2D',
        },
      ],
      terrainPrompt: 'stone',
      parallaxPrompt: 'moonlit ruins',
      uiThemePrompt: 'gothic hud',
      roomPrompt: 'boss arena',
      roomCols: 24,
      roomRows: 14,
    });

    const initialJob = createSliceJobRecord('proj-1', blueprint, 'instant-draft', 'job-1');
    const firstPassExecuted: string[] = [];

    const checkpointExecutor: SliceNodeExecutor = async (node) => {
      firstPassExecuted.push(node.id);
      return { artifactId: `art_${node.id}` };
    };

    const pausedJob = await runSliceDag(initialJob, checkpointExecutor, {
      approvedAnchor: false,
      maxConcurrency: 2,
    });

    expect(firstPassExecuted).toEqual(['art_bible', 'golden_ref_hero']);
    expect(pausedJob.status).toBe('awaiting-approval');
    expect(pausedJob.nodes.find((n) => n.id === 'golden_ref_hero')?.status).toBe(
      'awaiting-approval',
    );
    expect(
      pausedJob.nodes
        .filter((n) => !['art_bible', 'golden_ref_hero'].includes(n.id))
        .every((n) => n.status === 'pending'),
    ).toBe(true);

    // Stage 2: Approve & Fan Out, injecting a transient failure on parallax_stack
    const fanoutExecuted: string[] = [];
    const failingParallaxExecutor: SliceNodeExecutor = async (node) => {
      fanoutExecuted.push(node.id);
      if (node.id === 'parallax_stack') {
        throw new Error('Transient 429 rate limit');
      }
      return { artifactId: `art_${node.id}` };
    };

    const failedJob = await runSliceDag(pausedJob, failingParallaxExecutor, {
      approvedAnchor: true,
      maxConcurrency: 2,
    });

    expect(failedJob.status).toBe('failed');
    expect(fanoutExecuted).not.toContain('art_bible');
    expect(fanoutExecuted).not.toContain('golden_ref_hero');
    expect(failedJob.nodes.find((n) => n.id === 'parallax_stack')?.status).toBe('failed');
    // Downstream dependents of parallax_stack MUST remain pending (never ran while dep failed)
    expect(failedJob.nodes.find((n) => n.id === 'room_level')?.status).toBe('pending');
    expect(failedJob.nodes.find((n) => n.id === 'main_scene')?.status).toBe('pending');
    // Independent branches complete cleanly
    expect(failedJob.nodes.find((n) => n.id === 'terrain_tileset')?.status).toBe('done');
    expect(failedJob.nodes.find((n) => n.id === 'ui_theme')?.status).toBe('done');
    expect(failedJob.nodes.find((n) => n.id === 'visual_qa')?.status).toBe('done');

    // Stage 3: Resume after failure with healthy executor -> runs ONLY parallax_stack, room_level, main_scene!
    const resumedExecuted: string[] = [];
    const healthyExecutor: SliceNodeExecutor = async (node) => {
      resumedExecuted.push(node.id);
      return { artifactId: `art_${node.id}` };
    };

    const completedJob = await runSliceDag(failedJob, healthyExecutor, {
      approvedAnchor: true,
      maxConcurrency: 2,
    });

    expect(completedJob.status).toBe('completed');
    expect(resumedExecuted).toEqual(['parallax_stack', 'room_level', 'main_scene']);
    expect(completedJob.nodes.every((n) => n.status === 'done')).toBe(true);
  });

  it('persists SliceJobRecord in Dexie v7 and cascades cleanly on deleteProjectCascade with zero orphan blobs', async () => {
    const db = new NibgridDatabase(`nibgrid-m37a-${Date.now()}-${Math.random()}`);
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M37A Slice Project');
    const bp = parseAndClampVerticalSliceBlueprint({}, { fallbackPrompt: 'gothic slice' });
    const job = createSliceJobRecord(project.id, bp, 'instant-draft');

    await repo.saveSliceJob(job);
    const listed = await repo.listSliceJobs(project.id);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(job.id);

    await repo.deleteProjectCascade(project.id);
    expect(await repo.listSliceJobs(project.id)).toHaveLength(0);
    expect(await findOrphanBlobIds(db)).toEqual([]);
    await db.delete();
  });
});
