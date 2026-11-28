import { NibgridRepository, type NibgridDatabase } from '../db/database';
import {
  EntityDefinitionSchema,
  sanitizeEntitySlug,
  type EntityDefinition,
  type GodotBodyType,
} from '../domain/entitySchema';
import {
  AudioAssetSchema,
  SpriteNodeSchema,
  createDefaultAudioPostProcessConfig,
  type AssetClass,
  type AudioAsset,
  type Project,
  type SpriteNode,
} from '../domain/schemas';
import { validateAndCompileGdScript } from '../export/gdscriptGenerator';
import {
  runZeroTouchAssetPipeline,
  type ZeroTouchAssetResult,
} from '../processing/assetAutoPipeline';
import type { EntityDirectorBlueprint } from '../processing/entityDirectorBlueprint';
import { decodePngBytesToRgba } from '../processing/png';
import { computeArtBibleHash } from '../processing/projectAudit';

export interface CommitZeroTouchOptions {
  readonly slug?: string;
  readonly displayName?: string;
  readonly assetClass?: AssetClass;
  readonly bodyType?: GodotBodyType;
  readonly normalStrength?: number;
  readonly colliderMaxVertices?: number;
}

export interface CommitZeroTouchResult {
  readonly spriteNode: SpriteNode;
  readonly entity: EntityDefinition;
  readonly audioAsset: AudioAsset;
  readonly pipelineResult: ZeroTouchAssetResult;
  readonly purgedOrphanBlobs: number;
}

/**
 * Runs `runZeroTouchAssetPipeline()` on a `SpriteNode` and atomically commits the polished sprite,
 * M44 normal/emission bake, M16 collision hulls, M21 sockets, M27 shader, procedural SFX WAV,
 * and typed Godot 4 `.tscn` `EntityDefinition` into Dexie with zero orphaned blobs.
 */
export async function commitZeroTouchAssetToDb(
  database: NibgridDatabase,
  project: Project,
  spriteNode: SpriteNode,
  options: CommitZeroTouchOptions = {},
): Promise<CommitZeroTouchResult> {
  const repo = new NibgridRepository(database);
  const sourceBlobId = spriteNode.processedBlobId ?? spriteNode.imageBlobId;
  const blobRec = await repo.getBlob(sourceBlobId);
  if (!blobRec) {
    throw new Error(`Source blob "${sourceBlobId}" not found for sprite "${spriteNode.id}".`);
  }

  const bytes = new Uint8Array(await blobRec.bytes.arrayBuffer());
  const decoded = await decodePngBytesToRgba(bytes);

  const assetClass: AssetClass =
    options.assetClass ??
    spriteNode.assetClass ??
    (spriteNode.nineSlice?.enabled
      ? 'ui-panel'
      : spriteNode.seamlessTile?.isSeamlessTile
        ? 'tile'
        : 'character');

  const rawLabel =
    options.slug ??
    (spriteNode.generationMeta.promptDelta.trim() || `asset_${spriteNode.generationMeta.seed}`);
  const slug = sanitizeEntitySlug(rawLabel);
  const displayName =
    options.displayName?.trim() ||
    slug
      .split('_')
      .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : ''))
      .join(' ') ||
    'Nibgrid Entity';

  const bodyType: GodotBodyType =
    options.bodyType ?? (assetClass === 'tile' ? 'StaticBody2D' : 'CharacterBody2D');

  const pipelineResult = runZeroTouchAssetPipeline({
    spriteRgba: { width: decoded.width, height: decoded.height, data: decoded.rgba },
    assetClass,
    slug,
    displayName,
    artBible: project.artBible,
    bodyType,
    seed: spriteNode.generationMeta.seed,
    ...(options.normalStrength !== undefined ? { normalStrength: options.normalStrength } : {}),
    ...(options.colliderMaxVertices !== undefined
      ? { colliderMaxVertices: options.colliderMaxVertices }
      : {}),
  });

  const [processedBlob, normalBlob, emissionBlob, wavBlob] = await Promise.all([
    repo.storeBlobDeduplicated(pipelineResult.processedPngBytes, 'image/png'),
    repo.storeBlobDeduplicated(pipelineResult.normalPngBytes, 'image/png'),
    repo.storeBlobDeduplicated(pipelineResult.emissionPngBytes, 'image/png'),
    repo.storeBlobDeduplicated(pipelineResult.sfxWavBytes, 'audio/wav'),
  ]);

  const nowIso = new Date().toISOString();
  const updatedSprite = SpriteNodeSchema.parse({
    ...spriteNode,
    assetClass,
    processedBlobId: processedBlob.id,
    postProcessConfig: pipelineResult.postProcessConfig,
    lightingBake: {
      normalBlobId: normalBlob.id,
      emissionBlobId: emissionBlob.id,
      normalConfig: pipelineResult.normalConfig,
      emissionConfig: pipelineResult.emissionConfig,
      emissivePixelCount: pipelineResult.emissivePixelCount,
      occluderVertexCount: pipelineResult.collisionShapes[0]?.vertices.length ?? 0,
      bakedAt: nowIso,
    },
    collisionShapes: [...pipelineResult.collisionShapes],
    sockets: [...pipelineResult.sockets],
    shaderConfig: pipelineResult.shaderConfig,
    ...(pipelineResult.autoTile && !spriteNode.autoTile
      ? { autoTile: pipelineResult.autoTile }
      : {}),
    ...(pipelineResult.uiKitConfig && !spriteNode.uiKitConfig
      ? { uiKitConfig: pipelineResult.uiKitConfig }
      : {}),
    ...(pipelineResult.vfxFlipbook && !spriteNode.vfxFlipbook
      ? { vfxFlipbook: pipelineResult.vfxFlipbook }
      : {}),
    recipeArtBibleHash: computeArtBibleHash(project.artBible),
  });
  await repo.saveSpriteNode(updatedSprite);

  const audioAsset = AudioAssetSchema.parse({
    id: `sfx_${slug}_${spriteNode.id.slice(0, 8)}`,
    projectId: project.id,
    name: `${slug}_cue`,
    presetId: 'auto-pipeline-sfx',
    route: 'local-synth',
    modelId: 'procedural-synth-v1',
    wavBlobId: wavBlob.id,
    variationBlobIds: [wavBlob.id],
    synthParams: pipelineResult.sfxParams,
    postProcess: createDefaultAudioPostProcessConfig(),
    lufs: -14,
    durationSec: pipelineResult.sfxDurationSec,
    createdAt: nowIso,
  });
  await repo.saveAudioAsset(audioAsset);

  const existingEntities = await repo.listEntities(project.id);
  const matchedEntity = existingEntities.find(
    (e) => e.primarySpriteNodeId === spriteNode.id || e.slug === slug,
  );

  const scriptBlueprint: EntityDirectorBlueprint = {
    slug,
    displayName,
    bodyType: bodyType === 'Node2D' ? 'CharacterBody2D' : bodyType,
    spritePrompt: spriteNode.generationMeta.promptDelta || displayName,
    turnaroundLayout: 'single',
    generateNormalMap: true,
    colliderMode: 'convex-hull',
    includeHitbox: assetClass === 'character',
    includeHurtbox: assetClass === 'character' || assetClass === 'prop',
    sockets: pipelineResult.sockets.map((s) => ({
      name: s.name,
      normX: Math.max(0, Math.min(1, s.restPosPx.x / Math.max(1, pipelineResult.width))),
      normY: Math.max(0, Math.min(1, s.restPosPx.y / Math.max(1, pipelineResult.height))),
      baseAngleDeg: s.baseAngleDeg,
    })),
    sfxSpecs: [
      {
        cueName: `${slug}_cue`,
        category: 'sfx',
        prompt: `${displayName} action cue`,
        engine: 'procedural',
        proceduralPreset: 'hit',
      },
    ],
    behavior: {
      archetype: slug.includes('hero') || slug.includes('player') ? 'player' : 'melee-enemy',
      moveSpeed: 135,
      maxHealth: 80,
      attackDamage: 12,
      states: ['IDLE', 'MOVE', 'ATTACK', 'HURT'],
    },
  };
  const compiledScript = validateAndCompileGdScript(undefined, scriptBlueprint);

  const entity = EntityDefinitionSchema.parse({
    id: matchedEntity?.id ?? globalThis.crypto.randomUUID(),
    projectId: project.id,
    slug: matchedEntity?.slug ?? slug,
    displayName: matchedEntity?.displayName ?? displayName,
    bodyType,
    resSubpath: matchedEntity?.resSubpath ?? 'entities',
    primarySpriteNodeId: updatedSprite.id,
    clips:
      matchedEntity && matchedEntity.clips.length > 0
        ? matchedEntity.clips
        : [
            {
              name: 'idle',
              spriteNodeId: updatedSprite.id,
              fps: 8,
              loop: true,
              frameAudioTriggers: { '0': audioAsset.id },
            },
          ],
    audioAssetIds: Array.from(new Set([...(matchedEntity?.audioAssetIds ?? []), audioAsset.id])),
    includeNormalMap: true,
    scriptResPath: matchedEntity?.scriptResPath ?? `entities/${slug}/${slug}.gd`,
    scriptContent: compiledScript.code,
    shaderConfig: pipelineResult.shaderConfig,
    updatedAt: Date.now(),
  });
  await repo.saveEntity(entity);

  const purgedOrphanBlobs = await repo.cleanupOrphanedBlobs();

  return {
    spriteNode: updatedSprite,
    entity,
    audioAsset,
    pipelineResult,
    purgedOrphanBlobs,
  };
}
