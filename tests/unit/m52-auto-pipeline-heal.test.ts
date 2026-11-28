import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultGameDataRegistry } from '../../src/data/gameDataSchemas';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import { SpriteNodeSchema, createDefaultArtBible } from '../../src/domain/schemas';
import { createDefaultProjectNarrative } from '../../src/narrative/dialogueSchemas';
import { runZeroTouchAssetPipeline } from '../../src/processing/assetAutoPipeline';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import { runSelfHealingPreFlight } from '../../src/processing/selfHealingQa';
import { commitZeroTouchAssetToDb } from '../../src/sync/autoPipelineCommit';
import type { WorldGraph } from '../../src/world/worldGraphCore';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): NibgridDatabase {
  const db = new NibgridDatabase(`nibgrid-m52-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return db;
}

function makeCharacterRgba(width: number, height: number): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 6; y < height - 4; y++) {
    for (let x = 8; x < width - 8; x++) {
      const i = (y * width + x) * 4;
      rgba[i] = y < 14 ? 255 : 220;
      rgba[i + 1] = y < 14 ? 205 : 60;
      rgba[i + 2] = y < 14 ? 117 : 80;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
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

describe('M52: Zero-Touch Class Asset Auto-Pipeline & Self-Healing Pre-Sync QA Engine', () => {
  it('runs deterministic zero-touch pipeline producing normal/emission, convex hull + hit/hurtboxes, sockets, shader & SFX WAV', () => {
    const artBible = {
      ...createDefaultArtBible(),
      targetWidth: 32,
      targetHeight: 32,
      palette: ['#1A1C2C', '#DF3E50', '#FFCD75', '#FFFFFF'],
    };
    const rgba = makeCharacterRgba(32, 32);

    const res = runZeroTouchAssetPipeline({
      spriteRgba: { width: 32, height: 32, data: rgba },
      assetClass: 'character',
      slug: 'crimson_knight',
      displayName: 'Crimson Knight',
      artBible,
      seed: 777,
    });

    expect(res.processedPngBytes.length).toBeGreaterThan(20);
    expect(res.normalPngBytes.length).toBeGreaterThan(20);
    expect(res.emissionPngBytes.length).toBeGreaterThan(20);
    expect(res.sfxWavBytes.slice(0, 4)).toEqual(new Uint8Array([82, 73, 70, 70])); // RIFF
    expect(res.collisionShapes.some((s) => s.layer === 'collider')).toBe(true);
    expect(res.collisionShapes.some((s) => s.layer === 'hurtbox')).toBe(true);
    expect(res.collisionShapes.some((s) => s.layer === 'hitbox')).toBe(true);
    expect(res.sockets.some((s) => s.name === 'feet')).toBe(true);
    expect(res.sockets.some((s) => s.name === 'hand_r')).toBe(true);
    expect(res.shaderConfig.presetId).toBe('hit_flash');
    expect(res.summarySteps).toContain('Palette Lock');
    expect(res.summarySteps).toContain('Collider');
  });

  it('commits zero-touch assembly to Dexie with EntityDefinition + typed GDScript and zero orphan blobs', async () => {
    const db = createTestDb();
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M52 Auto Commit', {
      ...createDefaultArtBible(),
      targetWidth: 32,
      targetHeight: 32,
      palette: ['#1A1C2C', '#DF3E50', '#FFCD75'],
    });

    const pngBytes = encodeRgbaToPngBytes(makeCharacterRgba(32, 32), 32, 32);
    const blob = await repo.storeBlobDeduplicated(pngBytes, 'image/png');
    const node = SpriteNodeSchema.parse({
      id: 'node-auto-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      imageBlobId: blob.id,
      sketchSha256: 'd'.repeat(64),
      generationMeta: {
        providerId: 'mock',
        modelId: 'mock-1',
        seed: 55,
        adherence: 'balanced',
        promptDelta: 'crimson_knight',
        compiledPrompt: 'crimson knight',
        createdAt: '2026-11-28T12:00:00.000Z',
      },
    });
    await repo.saveSpriteNode(node);

    const committed = await commitZeroTouchAssetToDb(db, project, node);
    expect(committed.entity.slug).toBe('crimson_knight');
    expect(committed.entity.scriptContent).toContain('extends CharacterBody2D');
    expect(committed.entity.audioAssetIds).toContain(committed.audioAsset.id);
    expect(committed.spriteNode.lightingBake?.normalBlobId).toBeTruthy();
    expect(committed.spriteNode.collisionShapes?.length).toBeGreaterThanOrEqual(2);
    expect(committed.spriteNode.sockets?.length).toBeGreaterThanOrEqual(3);

    const orphans = await findOrphanBlobIds(db);
    expect(orphans).toEqual([]);
  });

  it('autonomously heals off-palette drift, missing colliders, softlock traps, sponge enemy TTK, and missing Polish glyphs', () => {
    const palette = ['#1A1C2C', '#FFCD75'];
    const offRgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 2; y < 14; y++) {
      for (let x = 2; x < 14; x++) {
        const i = (y * 16 + x) * 4;
        offRgba[i] = 0;
        offRgba[i + 1] = 255;
        offRgba[i + 2] = 0;
        offRgba[i + 3] = 255;
      }
    }

    const graph: WorldGraph = {
      id: 'w-m52',
      projectId: 'p1',
      name: 'World',
      rooms: [
        {
          roomId: 'start',
          label: 'Start',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: [],
        },
        { roomId: 'trap', label: 'Pit', worldGridPos: { x: 1, y: 0 }, grantsFlags: [] },
        {
          roomId: 'goal',
          label: 'Boss',
          worldGridPos: { x: 0, y: 1 },
          isGoal: true,
          grantsFlags: [],
        },
      ],
      edges: [
        {
          id: 'e1',
          fromRoomId: 'start',
          fromDoorId: 'east',
          toRoomId: 'trap',
          toSpawnId: 'west',
          requiredFlags: [],
          bidirectional: false,
        },
        {
          id: 'e2',
          fromRoomId: 'start',
          fromDoorId: 'south',
          toRoomId: 'goal',
          toSpawnId: 'north',
          requiredFlags: [],
          bidirectional: true,
        },
      ],
      updatedAt: 1,
    };

    const baseData = createDefaultGameDataRegistry('p1');
    const spongeData = {
      ...baseData,
      enemies: [
        {
          ...baseData.enemies[0]!,
          maxHp: 9999,
        },
      ],
    };

    const baseNarrative = createDefaultProjectNarrative('p1');
    const brokenNarrative = {
      ...baseNarrative,
      localization: {
        ...baseNarrative.localization,
        strings: {
          ...baseNarrative.localization.strings,
          DLG_TRAP_01: {
            en: 'Beware!',
            pl: 'Stój, wędrowcze! Złóż broń.',
            de: 'Achtung!',
          },
        },
      },
    };

    const report = runSelfHealingPreFlight({
      paletteHex: palette,
      sprites: [
        { id: 's1', name: 'Slime', width: 16, height: 16, data: offRgba, hasCollider: false },
      ],
      worldGraph: graph,
      gameData: spongeData,
      narrativeBundle: brokenNarrative,
    });

    expect(report.beforeIssueCount).toBe(5);
    expect(report.afterIssueCount).toBe(0);
    expect(report.appliedFixes.map((f) => f.kind).sort()).toEqual([
      'combat-balance',
      'missing-collider',
      'missing-glyph',
      'off-palette',
      'softlock-trap',
    ]);
    expect(report.healedColliders['s1']?.vertices.length).toBeGreaterThanOrEqual(3);
    expect(report.healedGameData?.enemies[0]?.maxHp).toBeLessThan(1000);
    expect(report.healedNarrativeBundle?.fontCharset).toContain('ł');
  });
});
