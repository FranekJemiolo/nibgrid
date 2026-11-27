import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import {
  buildWorkspaceRulesBlock,
  resolveAtMentions,
  type AgentProjectIndex,
} from '../../src/agent/contextResolver';
import {
  commitStagedTurn,
  rejectStagedTurn,
  restoreCheckpoint,
} from '../../src/agent/stagingTransactions';
import { executeStagedToolCall } from '../../src/agent/studioToolRegistry';
import {
  NibgridDatabase,
  NibgridRepository,
  createDefaultMockProviderConfig,
  findOrphanBlobIds,
} from '../../src/db/database';
import { EntityDefinitionSchema } from '../../src/domain/entitySchema';
import { SpriteNodeSchema, createDefaultShaderConfig } from '../../src/domain/schemas';
import { encodeRgbaToPngBytes } from '../../src/processing/png';
import { sha256Bytes } from '../../src/processing/hash';

describe('M38A: Pure-TS @ Context Resolver, Studio Tool Registry & Dexie v8 Checkpoint Engine', () => {
  it('resolveAtMentions resolves exact Dexie IDs and buildWorkspaceRulesBlock injects ArtBible + .nibgridrules cleanly', async () => {
    const db = new NibgridDatabase(`nibgrid-m38a-ctx-${Date.now()}`);
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M38A Context Test');

    const spritePng = encodeRgbaToPngBytes(new Uint8ClampedArray(16 * 16 * 4).fill(200), 16, 16);
    const blob = await repo.storeBlobDeduplicated(spritePng, 'image/png');
    const heroSprite = SpriteNodeSchema.parse({
      id: 'spr-hero-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'character',
      imageBlobId: blob.id,
      processedBlobId: blob.id,
      shaderConfig: createDefaultShaderConfig('hit_flash'),
      sketchSha256: await sha256Bytes(spritePng),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'mock-v1',
        seed: 7,
        adherence: 'balanced',
        promptDelta: 'hero_knight',
        compiledPrompt: 'hero_knight',
        createdAt: new Date().toISOString(),
      },
    });
    await repo.saveSpriteNode(heroSprite);

    const heroEntity = EntityDefinitionSchema.parse({
      id: 'ent-hero-1',
      projectId: project.id,
      slug: 'hero_knight',
      displayName: 'Hero Knight',
      primarySpriteNodeId: heroSprite.id,
      shaderConfig: createDefaultShaderConfig('hit_flash'),
      updatedAt: Date.now(),
    });
    await repo.saveEntity(heroEntity);

    const index: AgentProjectIndex = {
      project,
      spriteNodes: [heroSprite],
      entities: [heroEntity],
      audioAssets: [],
      rooms: [],
    };

    const resolved = resolveAtMentions(
      'Update @hero_knight and @hit_flash shader, ignore @nonexistent_ghost',
      index,
    );
    expect(resolved.mentions).toEqual(['hero_knight', 'hit_flash', 'nonexistent_ghost']);
    expect(resolved.unresolved).toEqual(['nonexistent_ghost']);
    expect(resolved.resolved.some((r) => r.kind === 'entity' && r.id === 'ent-hero-1')).toBe(true);
    expect(resolved.resolved.some((r) => r.kind === 'shader' && r.slug === 'hit_flash')).toBe(true);

    const rules = buildWorkspaceRulesBlock(
      project.artBible,
      'Always keep outlines 1px crisp pixel art.\nNever leak AIzaSySECRETKEY12345.',
    );
    expect(rules).toContain(project.artBible.palette[0]!);
    expect(rules).toContain(project.artBible.lighting);
    expect(rules).toContain('Always keep outlines 1px crisp pixel art.');
    expect(rules).not.toContain('AIzaSySECRETKEY12345');

    await db.delete();
  });

  it('stages 2 tools, commits strictly 1 accepted change, purges rejected blob, and restores pre-turn asset byte-for-byte', async () => {
    const db = new NibgridDatabase(`nibgrid-m38a-tx-${Date.now()}`);
    const repo = new NibgridRepository(db);
    const project = await repo.createProject('M38A Tx Test');
    const mockProvider = createDefaultMockProviderConfig();

    // Non-palette red square RGBA
    const rawRgba = new Uint8ClampedArray(16 * 16 * 4);
    for (let y = 2; y < 14; y++) {
      for (let x = 2; x < 14; x++) {
        const i = (y * 16 + x) * 4;
        rawRgba[i] = 250;
        rawRgba[i + 1] = 20;
        rawRgba[i + 2] = 30;
        rawRgba[i + 3] = 255;
      }
    }
    const origPng = encodeRgbaToPngBytes(rawRgba, 16, 16);
    const origBlob = await repo.storeBlobDeduplicated(origPng, 'image/png');

    const spriteNode = SpriteNodeSchema.parse({
      id: 'spr-goblin-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      assetClass: 'character',
      imageBlobId: origBlob.id,
      processedBlobId: origBlob.id,
      sketchSha256: await sha256Bytes(origPng),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'mock-v1',
        seed: 12,
        adherence: 'balanced',
        promptDelta: 'goblin_scout',
        compiledPrompt: 'goblin_scout',
        createdAt: new Date().toISOString(),
      },
    });
    await repo.saveSpriteNode(spriteNode);

    const entity = EntityDefinitionSchema.parse({
      id: 'ent-goblin-1',
      projectId: project.id,
      slug: 'goblin_scout',
      displayName: 'Goblin Scout',
      primarySpriteNodeId: spriteNode.id,
      shaderConfig: createDefaultShaderConfig('hit_flash'),
      updatedAt: Date.now(),
    });
    await repo.saveEntity(entity);

    // 1. Stage 2 changes into isolated buffer (live Dexie untouched)
    const stagedRepalette = await executeStagedToolCall(
      db,
      project.id,
      {
        toolName: 'repalette_sprites',
        args: { targetSlugs: ['goblin_scout'], outlineTintHex: '#00FF88', dither: false },
      },
      mockProvider,
    );
    const stagedSfx = await executeStagedToolCall(
      db,
      project.id,
      {
        toolName: 'generate_sfx_cue',
        args: { cueName: 'poison_drip', proceduralPreset: 'hit' },
      },
      mockProvider,
    );
    expect(stagedRepalette).toHaveLength(1);
    expect(stagedSfx).toHaveLength(1);

    // Verify live Dexie spriteNode is untouched prior to Accept
    expect((await db.spriteNodes.get(spriteNode.id))!.processedBlobId).toBe(origBlob.id);
    expect(await repo.listAudioAssets(project.id)).toHaveLength(0);

    // 2. Accept repalette, Reject SFX -> commit atomically
    const turnChanges = [
      { ...stagedRepalette[0]!, status: 'accepted' as const },
      { ...stagedSfx[0]!, status: 'rejected' as const },
    ];
    const commitRes = await commitStagedTurn(
      db,
      project.id,
      'Repalette goblin outline',
      turnChanges,
    );
    expect(commitRes.acceptedCount).toBe(1);
    expect(commitRes.rejectedCount).toBe(1);
    expect(commitRes.checkpoint).not.toBeNull();
    expect(await repo.listAudioAssets(project.id)).toHaveLength(0);

    const updatedSprite = (await db.spriteNodes.get(spriteNode.id))!;
    expect(updatedSprite.processedBlobId).toBe(stagedRepalette[0]!.afterBlobId);
    expect(updatedSprite.processedBlobId).not.toBe(origBlob.id);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    // 3. Restore Checkpoint -> byte-for-byte revert & zero orphan blobs
    const restoreRes = await restoreCheckpoint(db, commitRes.checkpoint!.id);
    expect(restoreRes.restoredRecordCount).toBeGreaterThanOrEqual(1);
    const revertedSprite = (await db.spriteNodes.get(spriteNode.id))!;
    expect(revertedSprite.processedBlobId).toBe(origBlob.id);
    expect(await repo.listAgentCheckpoints(project.id)).toEqual([]);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    // 4. Reject full turn helper cleans any unreferenced blobs
    const tempSfx = await executeStagedToolCall(
      db,
      project.id,
      {
        toolName: 'generate_sfx_cue',
        args: { cueName: 'unused_temp', proceduralPreset: 'jump' },
      },
      mockProvider,
    );
    const purged = await rejectStagedTurn(db, tempSfx);
    expect(purged).toBeGreaterThanOrEqual(1);
    expect(await findOrphanBlobIds(db)).toEqual([]);

    await db.delete();
  });
});
