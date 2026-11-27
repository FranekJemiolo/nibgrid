import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  NibgridDatabase,
  NibgridRepository,
  createDefaultMockProviderConfig,
  findOrphanBlobIds,
} from '../../src/db/database';
import type { ProviderConfig } from '../../src/domain/schemas';
import {
  assembleVerticalSliceSyncFiles,
  exportGodotMainSceneTscn,
} from '../../src/export/godotMainSceneExporter';
import { createSliceJobRecord, runSliceDag } from '../../src/processing/sliceDagRunner';
import { ProviderError } from '../../src/providers/errors';
import {
  collectVerticalSliceGodotSyncFiles,
  createSliceNodeExecutor,
  draftVerticalSliceBlueprint,
} from '../../src/providers/verticalSliceDirector';

describe('M37B Godot 4 main.tscn Exporter, Slice Director & Key Redaction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('exportGodotMainSceneTscn computes exact load_steps and builds Level + HudLayer/HudRoot/HpBar hierarchy', () => {
    const withTheme = exportGodotMainSceneTscn({
      levelResPath: 'res://levels/boss_arena.tscn',
      themeResPath: 'res://ui/gothic_hud_theme.tres',
    });
    expect(withTheme).toContain('[gd_scene load_steps=3 format=3]');
    expect(withTheme).toContain('[node name="Main" type="Node2D"]');
    expect(withTheme).toContain('[node name="Level" parent="." instance=ExtResource("1_lvl")]');
    expect(withTheme).toContain('[node name="HudLayer" type="CanvasLayer" parent="."]');
    expect(withTheme).toContain('[node name="HudRoot" type="Control" parent="HudLayer"]');
    expect(withTheme).toContain('theme = ExtResource("2_thm")');
    expect(withTheme).toContain('[node name="HpBar" type="ProgressBar" parent="HudLayer/HudRoot"]');

    const withoutTheme = exportGodotMainSceneTscn({
      levelResPath: 'res://levels/boss_arena.tscn',
    });
    expect(withoutTheme).toContain('[gd_scene load_steps=2 format=3]');
    expect(withoutTheme).not.toContain('theme = ExtResource');
  });

  it('assembleVerticalSliceSyncFiles deduplicates and sorts main.tscn, levels, entities, ui and tiles cleanly', () => {
    const files = assembleVerticalSliceSyncFiles({
      mainSceneTscn: '[gd_scene load_steps=2 format=3]',
      roomFiles: [{ relativePath: 'levels/arena.tscn', content: 'room' }],
      entityFiles: [{ relativePath: 'entities/knight/knight.tscn', content: 'knight' }],
      uiFiles: [{ relativePath: 'ui/gothic_theme.tres', content: 'theme' }],
      tileFiles: [{ relativePath: 'tiles/crypt_tileset.tres', content: 'tiles' }],
      qaReportJson: '{"overallScore":95}',
    });

    const paths = files.map((f) => f.relativePath);
    expect(paths).toContain('main.tscn');
    expect(paths).toContain('levels/arena.tscn');
    expect(paths).toContain('entities/knight/knight.tscn');
    expect(paths).toContain('ui/gothic_theme.tres');
    expect(paths).toContain('tiles/crypt_tileset.tres');
    expect(paths).toContain('qa_report.json');
  });

  it('strips AIzaSySLICE999 completely from thrown ProviderError on HTTP 401 and 429 during blueprint drafting', async () => {
    const secretKey = 'AIzaSySLICE999SECRET';
    const geminiConfig: ProviderConfig = {
      id: 'gemini-byok',
      kind: 'gemini',
      displayName: 'Google Gemini Flash',
      modelId: 'gemini-2.5-flash',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: secretKey,
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    };

    for (const status of [401, 429]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status,
          text: async () => `Upstream error exposing key ${secretKey}`,
        })),
      );

      let caught: unknown;
      try {
        await draftVerticalSliceBlueprint({
          prompt: '16-bit gothic platformer boss arena',
          genre: 'side-platformer',
          providerConfig: geminiConfig,
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ProviderError);
      const pe = caught as ProviderError;
      expect(pe.message).not.toContain(secretKey);
      expect(pe.remediation).not.toContain(secretKey);
    }
  });

  it('executes full Instant Draft Vertical Slice DAG end-to-end offline and aggregates complete Godot 4 res:// tree', async () => {
    const db = new NibgridDatabase(`nibgrid-m37b-${Date.now()}-${Math.random()}`);
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M37B Full Slice');
    const mockCfg = createDefaultMockProviderConfig();

    const drafted = await draftVerticalSliceBlueprint({
      prompt:
        '16-bit gothic platformer: armored knight hero, 2 skeleton enemies, crypt stone tileset, moonlit parallax, gothic HUD, and a boss arena',
      genre: 'side-platformer',
      providerConfig: mockCfg,
    });
    expect(drafted.usedMock).toBe(true);

    const job = createSliceJobRecord(project.id, drafted.blueprint, 'instant-draft');
    const executor = createSliceNodeExecutor({
      database: db,
      projectId: project.id,
      tier: 'instant-draft',
      providerConfig: mockCfg,
    });

    const anchored = await runSliceDag(job, executor, {
      approvedAnchor: false,
      onJobUpdate: async (snap) => {
        await repo.saveSliceJob(snap);
      },
    });
    expect(anchored.status).toBe('awaiting-approval');

    const completed = await runSliceDag(anchored, executor, {
      approvedAnchor: true,
      maxConcurrency: 2,
      onJobUpdate: async (snap) => {
        await repo.saveSliceJob(snap);
      },
    });
    expect(completed.status).toBe('completed');
    expect(completed.nodes.every((n) => n.status === 'done')).toBe(true);

    const updatedProject = (await repo.getProject(project.id))!;
    const syncFiles = await collectVerticalSliceGodotSyncFiles(db, updatedProject, completed);
    const relPaths = syncFiles.map((f) => f.relativePath);

    expect(relPaths).toContain('main.tscn');
    expect(relPaths.some((p) => p.startsWith('levels/') && p.endsWith('.tscn'))).toBe(true);
    expect(relPaths.some((p) => p.startsWith('entities/') && p.endsWith('.tscn'))).toBe(true);
    expect(relPaths.some((p) => p.startsWith('ui/') && p.endsWith('_theme.tres'))).toBe(true);
    expect(relPaths.some((p) => p.startsWith('tiles/') && p.endsWith('_tileset.tres'))).toBe(true);
    expect(relPaths.some((p) => p.startsWith('parallax/') && p.endsWith('_parallax.tscn'))).toBe(
      true,
    );
    expect(relPaths).toContain('qa_report.json');

    expect(await findOrphanBlobIds(db)).toEqual([]);
    await db.delete();
  });
});
