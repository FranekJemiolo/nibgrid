import {
  NibgridRepository,
  createDefaultMockProviderConfig,
  type NibgridDatabase,
} from '../db/database';
import {
  EntityDefinitionSchema,
  normalizeResSubpath,
  sanitizeEntitySlug,
  type EntityDefinition,
} from '../domain/entitySchema';
import {
  SpriteNodeSchema,
  createDefaultAutoTileConfig,
  createDefaultBitmapFontConfig,
  createDefaultParallaxSceneConfig,
  createDefaultPostProcessConfig,
  createDefaultShaderConfig,
  createDefaultUiKitConfig,
  type ArtBible,
  type Project,
  type ProviderConfig,
  type SpriteNode,
} from '../domain/schemas';
import { exportGodotTileSetTres } from '../export/autoTileExporters';
import {
  assembleVerticalSliceSyncFiles,
  exportGodotMainSceneTscn,
} from '../export/godotMainSceneExporter';
import { generateGodotPngImport, type VirtualSyncFile } from '../export/godotPrefabAssembler';
import { assembleGodotRoomFiles } from '../export/godotRoomExporter';
import { assembleGodotUiKitFiles, bakeBitmapFontFromConfig } from '../export/godotThemeExporter';
import { exportGodotParallaxTscn, safeParallaxLayerSlug } from '../export/parallaxExporters';
import { composeAutoTileSheet } from '../processing/autoTile';
import { parseAndClampDirectorBlueprint } from '../processing/entityDirectorBlueprint';
import { sha256Bytes } from '../processing/hash';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../processing/png';
import { synthesizeProceduralSprite } from '../processing/proceduralSprite';
import { computeArtBibleHash } from '../processing/projectAudit';
import { createPoseClipFromPreset } from '../processing/posePresets';
import type { SliceDagNode, SliceJobRecord, SliceNodeExecutor } from '../processing/sliceDagRunner';
import { generateRoomBlueprint } from './roomPrototyperAdapter';
import { bakeProceduralUiKit } from '../processing/uiKitCore';
import {
  VERTICAL_SLICE_GEMINI_RESPONSE_SCHEMA,
  parseAndClampVerticalSliceBlueprint,
  sanitizeSliceSlug,
  type SliceExecutionTier,
  type SliceGenre,
  type VerticalSliceBlueprint,
} from '../processing/verticalSliceSchema';
import { collectEntitySyncFiles } from '../sync/fsaaSyncEngine';
import { runArtDirectorQaPass } from './artDirectorQa';
import { executeEntityDirectorPlan } from './entityDirector';
import { ProviderError, classifyProviderError } from './errors';
import { resolveGeminiBaseUrl, type GeminiGenerateContentResponse } from './geminiProvider';
import { generateMatchedParallaxStack, resolveParallaxTextModelId } from './parallaxGenerator';
import { generatePoseSpriteCycle } from './poseAnimationAdapter';

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }
}

function extractTextFromGeminiResponse(json: GeminiGenerateContentResponse): string {
  for (const cand of json.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      const text = (part as { text?: string }).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        return text;
      }
    }
  }
  return '';
}

/**
 * Deterministic `$0.00` offline blueprint generator turning a single natural-language description
 * into a cohesive Hero + Cast + World + UI + Room `VerticalSliceBlueprint`.
 */
export function buildMockVerticalSliceBlueprint(
  prompt: string,
  genre: SliceGenre = 'side-platformer',
): VerticalSliceBlueprint {
  const trimmed =
    prompt.trim() ||
    '16-bit gothic platformer: armored knight hero, 2 skeleton enemies, crypt stone tileset, moonlit parallax, gothic HUD, and a boss arena';
  const lower = trimmed.toLowerCase();

  const isCyber = /\b(cyber|neon|sci-fi|scifi|synth|laser|robot)\b/.test(lower);
  const isMeadow = /\b(meadow|forest|slime|sunny|fantasy|village)\b/.test(lower);

  if (isCyber) {
    return parseAndClampVerticalSliceBlueprint(
      {
        projectSlug: 'neon_cyber_slice',
        genre,
        artBiblePrompt: `${trimmed}, crisp 16-bit cyberpunk pixel art`,
        artMode: 'pixel-art',
        tileSizePx: 32,
        paletteHex: ['#0F1021', '#1F244B', '#3B6EA5', '#4CC9F0', '#F72585', '#FFE066'],
        cast: [
          {
            slug: 'cyber_runner',
            role: 'hero',
            prompt: 'Cyberpunk blade runner hero with plasma katana, side view',
            bodyType: 'CharacterBody2D',
            posePreset: 'run_6f',
          },
          {
            slug: 'security_drone',
            role: 'enemy',
            prompt: 'Hovering laser security drone enemy',
            bodyType: 'CharacterBody2D',
            posePreset: 'idle_4f',
          },
          {
            slug: 'riot_bot',
            role: 'enemy',
            prompt: 'Armored riot mech sentry enemy',
            bodyType: 'CharacterBody2D',
            posePreset: 'melee_slash_5f',
          },
        ],
        terrainPrompt: 'Neon metal grating steel platform tileset',
        parallaxPrompt: 'Cyberpunk rain rooftops with glowing skyline haze',
        uiThemePrompt: 'Sleek glowing cyan sci-fi HUD',
        roomPrompt: trimmed,
        roomCols: 24,
        rows: 14,
        roomRows: 14,
      },
      { fallbackPrompt: trimmed, fallbackGenre: genre },
    );
  }

  if (isMeadow) {
    return parseAndClampVerticalSliceBlueprint(
      {
        projectSlug: 'meadow_quest_slice',
        genre,
        artBiblePrompt: `${trimmed}, crisp sunlit pixel art`,
        artMode: 'pixel-art',
        tileSizePx: 32,
        paletteHex: ['#1A1C2C', '#3B5D3F', '#6DAA2C', '#BCE0FD', '#EF7D57', '#FFCD75'],
        cast: [
          {
            slug: 'ranger_hero',
            role: 'hero',
            prompt: 'Forest ranger hero with short sword and cloak',
            bodyType: 'CharacterBody2D',
            posePreset: 'run_6f',
          },
          {
            slug: 'moss_slime',
            role: 'enemy',
            prompt: 'Bouncy mossy slime monster enemy',
            bodyType: 'CharacterBody2D',
            posePreset: 'idle_4f',
          },
          {
            slug: 'thorn_goblin',
            role: 'enemy',
            prompt: 'Goblin scout with wooden spear enemy',
            bodyType: 'CharacterBody2D',
            posePreset: 'melee_slash_5f',
          },
        ],
        terrainPrompt: 'Mossy grassy dirt embankment auto-tile terrain',
        parallaxPrompt: 'Sunny pixel meadow hills and drifting clouds',
        uiThemePrompt: 'Warm oak and gold adventure HUD',
        roomPrompt: trimmed,
        roomCols: 24,
        roomRows: 14,
      },
      { fallbackPrompt: trimmed, fallbackGenre: genre },
    );
  }

  return parseAndClampVerticalSliceBlueprint(
    {
      projectSlug: 'gothic_crypt_slice',
      genre,
      artBiblePrompt: `${trimmed}, crisp 16-bit dark gothic pixel art`,
      artMode: 'pixel-art',
      tileSizePx: 32,
      paletteHex: ['#12101B', '#27233A', '#564D73', '#9A8C98', '#E0B578', '#B8334A'],
      cast: [
        {
          slug: 'armored_knight',
          role: 'hero',
          prompt: 'Armored knight hero with longsword and tattered cape, side view',
          bodyType: 'CharacterBody2D',
          posePreset: 'run_6f',
        },
        {
          slug: 'skeleton_warrior',
          role: 'enemy',
          prompt: 'Risen skeleton warrior with rusted blade, side view',
          bodyType: 'CharacterBody2D',
          posePreset: 'melee_slash_5f',
        },
        {
          slug: 'skeleton_acolyte',
          role: 'enemy',
          prompt: 'Hooded skeleton acolyte enemy, side view',
          bodyType: 'CharacterBody2D',
          posePreset: 'idle_4f',
        },
      ],
      terrainPrompt: 'Weathered gothic crypt stone block auto-tile terrain',
      parallaxPrompt: 'Moonlit gothic cathedral arches and misty graveyard ridges',
      uiThemePrompt: 'Ornate gothic stone and crimson RPG HUD',
      roomPrompt: trimmed,
      roomCols: 24,
      roomRows: 14,
    },
    { fallbackPrompt: trimmed, fallbackGenre: genre },
  );
}

/**
 * Compiles a user's single prompt into a validated, clamped `VerticalSliceBlueprint` via
 * Gemini Flash JSON `responseSchema` or deterministic `$0.00` offline planning.
 */
export async function draftVerticalSliceBlueprint(params: {
  readonly prompt: string;
  readonly genre: SliceGenre;
  readonly providerConfig: ProviderConfig;
  readonly signal?: AbortSignal;
}): Promise<{ readonly blueprint: VerticalSliceBlueprint; readonly usedMock: boolean }> {
  throwIfAborted(params.signal);
  const { prompt, genre, providerConfig, signal } = params;

  if (providerConfig.kind !== 'gemini') {
    return {
      blueprint: buildMockVerticalSliceBlueprint(prompt, genre),
      usedMock: true,
    };
  }

  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const textModel = resolveParallaxTextModelId(providerConfig.modelId);
  const url = `${baseUrl}/models/${encodeURIComponent(textModel)}:generateContent`;

  const plannerPrompt = [
    "You are Nibgrid's Vertical Slice Autopilot Architect for Godot 4.3+.",
    `User game prompt: "${prompt.trim()}"`,
    `Target gameplay genre: ${genre}`,
    `Return ONLY JSON matching the schema.`,
    `cast[0] MUST be role='hero', followed by enemies/props (total 2 to 6 cast members).`,
    `Use lowercase snake_case slugs matching ^[a-z][a-z0-9_]*$. Clamp roomCols in [16, 48] and roomRows in [10, 24].`,
  ].join('\n');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': providerConfig.apiKey.trim(),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: plannerPrompt }] }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: VERTICAL_SLICE_GEMINI_RESPONSE_SCHEMA,
          temperature: 0.25,
        },
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw { status: res.status, responseText: text };
    }

    const json = (await res.json()) as GeminiGenerateContentResponse;
    const rawText = extractTextFromGeminiResponse(json);
    if (!rawText) {
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        providerId: providerConfig.id,
        retryable: true,
        message: 'Gemini returned an empty vertical slice blueprint.',
        remediation: 'Retry planning or switch to Instant Draft ($0.00).',
      });
    }

    const parsedJson = JSON.parse(rawText) as unknown;
    return {
      blueprint: parseAndClampVerticalSliceBlueprint(parsedJson, {
        fallbackPrompt: prompt,
        fallbackGenre: genre,
      }),
      usedMock: false,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: providerConfig.endpointUrl,
      secrets: [providerConfig.apiKey],
    });
  }
}

function toArtMode(mode: VerticalSliceBlueprint['artMode']): ArtBible['artMode'] {
  return mode === 'hd-handdrawn' ? 'hd-2d' : 'pixel-art';
}

/**
 * Creates an abort-safe, tier-aware node executor connecting every `SliceDagNode.kind`
 * cleanly into M14–M37 Nibgrid subsystems with zero orphan blobs on failure/abort.
 */
export function createSliceNodeExecutor(params: {
  readonly database: NibgridDatabase;
  readonly projectId: string;
  readonly tier: SliceExecutionTier;
  readonly providerConfig: ProviderConfig;
}): SliceNodeExecutor {
  const { database, projectId, tier, providerConfig } = params;
  const mockProvider = createDefaultMockProviderConfig();
  const repo = new NibgridRepository(database);

  const spriteProvider = tier === 'instant-draft' ? mockProvider : providerConfig;
  const fullGenAiProvider = tier === 'full-genai' ? providerConfig : mockProvider;

  return async (node: SliceDagNode, job: SliceJobRecord, signal?: AbortSignal) => {
    throwIfAborted(signal);
    const project = await repo.getProject(projectId);
    if (!project) {
      throw new Error(`Project "${projectId}" not found.`);
    }

    const bp = job.blueprint;
    const palette = bp.paletteHex ?? project.artBible.palette;
    const heroSpec = bp.cast[0]!;

    try {
      switch (node.kind) {
        case 'art-bible': {
          const nextArtBible: ArtBible = {
            ...project.artBible,
            projection: bp.genre === 'top-down' ? 'top-down' : 'side-scroller',
            artMode: toArtMode(bp.artMode),
            targetWidth: 64,
            targetHeight: 64,
            palette: [...palette],
            stylePrompt: bp.artBiblePrompt,
          };
          await repo.updateProjectArtBible(projectId, nextArtBible);
          return { artifactId: projectId };
        }

        case 'golden-ref': {
          const w = project.artBible.targetWidth || 64;
          const h = project.artBible.targetHeight || 64;
          const rgba = synthesizeProceduralSprite({
            sketchRgba: new Uint8ClampedArray(w * h * 4),
            width: w,
            height: h,
            palette,
            lighting: project.artBible.lighting,
            artMode: toArtMode(bp.artMode),
            adherence: 'balanced',
            seedKey: `slice-anchor|${bp.projectSlug}|${heroSpec.slug}|${heroSpec.prompt}`,
            variantIndex: 0,
          });
          const pngBytes = encodeRgbaToPngBytes(rgba, w, h);
          const pngCopy = new Uint8Array(pngBytes.byteLength);
          pngCopy.set(pngBytes);
          const blob = await repo.storeBlobDeduplicated(
            new Blob([pngCopy.buffer], { type: 'image/png' }),
            'image/png',
          );

          await repo.updateProjectArtBible(projectId, {
            ...project.artBible,
            goldenReferenceBlobIds: [blob.id],
          });

          const nodeRecord = SpriteNodeSchema.parse({
            id: globalThis.crypto.randomUUID(),
            projectId,
            parentId: null,
            kind: 'generation',
            assetClass: 'character',
            imageBlobId: blob.id,
            processedBlobId: blob.id,
            postProcessConfig: createDefaultPostProcessConfig(w, h),
            recipeArtBibleHash: computeArtBibleHash(project.artBible),
            sketchSha256: await sha256Bytes(pngBytes),
            generationMeta: {
              providerId: spriteProvider.id,
              modelId: spriteProvider.modelId,
              seed: 1001,
              adherence: 'balanced',
              promptDelta: heroSpec.prompt,
              compiledPrompt: `${bp.artBiblePrompt}, ${heroSpec.prompt}`,
              createdAt: new Date().toISOString(),
            },
          });
          await repo.saveSpriteNode(nodeRecord);
          return { artifactId: nodeRecord.id };
        }

        case 'tileset': {
          const size = bp.tileSizePx;
          const fill = synthesizeProceduralSprite({
            sketchRgba: new Uint8ClampedArray(size * size * 4),
            width: size,
            height: size,
            palette,
            lighting: project.artBible.lighting,
            artMode: toArtMode(bp.artMode),
            adherence: 'strict',
            seedKey: `slice-tile|${bp.projectSlug}|${bp.terrainPrompt}`,
            variantIndex: 0,
          });
          // Make terrain fill tile opaque so auto-tile sheet slices crisply
          for (let i = 3; i < fill.length; i += 4) {
            fill[i] = 255;
          }
          const pngBytes = encodeRgbaToPngBytes(fill, size, size);
          const blob = await repo.storeBlobDeduplicated(pngBytes, 'image/png');
          const tileCfg = {
            ...createDefaultAutoTileConfig(),
            mode: 'blob-47' as const,
            edgeTintHex: palette[0] ?? '#1A1C2C',
          };

          const tileNode = SpriteNodeSchema.parse({
            id: globalThis.crypto.randomUUID(),
            projectId,
            parentId: null,
            kind: 'generation',
            assetClass: 'tile',
            imageBlobId: blob.id,
            processedBlobId: blob.id,
            postProcessConfig: createDefaultPostProcessConfig(size, size),
            autoTile: tileCfg,
            recipeArtBibleHash: computeArtBibleHash(project.artBible),
            sketchSha256: await sha256Bytes(pngBytes),
            generationMeta: {
              providerId: mockProvider.id,
              modelId: mockProvider.modelId,
              seed: 2001,
              adherence: 'strict',
              promptDelta: bp.terrainPrompt,
              compiledPrompt: bp.terrainPrompt,
              createdAt: new Date().toISOString(),
            },
          });
          await repo.saveSpriteNode(tileNode);
          return { artifactId: tileNode.id };
        }

        case 'parallax': {
          const stack = await generateMatchedParallaxStack({
            providerConfig: spriteProvider,
            artBible: project.artBible,
            themePrompt: bp.parallaxPrompt,
            bandCount: 3,
            viewportWidth: 320,
            viewportHeight: 180,
            includeMasterKeyframe: false,
            signal,
          });
          throwIfAborted(signal);

          const layerConfigs = [];
          for (let i = 0; i < stack.bands.length; i++) {
            const art = stack.bands[i]!;
            const blob = await repo.storeBlobDeduplicated(art.rawPngBytes, 'image/png');
            layerConfigs.push({
              id: art.band.id,
              name: art.band.name,
              role: art.band.role,
              sourceKind: 'ai-band' as const,
              scrollRatioX: art.band.scrollRatioX,
              yOffsetPx: art.band.yOffsetPx,
              seamBlendPx: art.band.seamBlendPx,
              depthHaze: art.band.depthHaze,
              visible: true,
              blobId: blob.id,
              stripChromaKey: art.stripChromaKey,
              subjectPrompt: art.band.subjectPrompt,
            });
          }

          const firstBlobId = layerConfigs[0]?.blobId;
          if (!firstBlobId) {
            throw new Error('Parallax generator returned zero layers.');
          }

          const parallaxCfg = {
            ...createDefaultParallaxSceneConfig(),
            skyTopHex: stack.blueprint.skyTopHex,
            horizonHex: stack.blueprint.horizonHex,
            layers: layerConfigs,
          };

          const parallaxNode = SpriteNodeSchema.parse({
            id: globalThis.crypto.randomUUID(),
            projectId,
            parentId: null,
            kind: 'generation',
            assetClass: 'tile',
            imageBlobId: firstBlobId,
            processedBlobId: firstBlobId,
            postProcessConfig: createDefaultPostProcessConfig(320, 180),
            parallaxScene: parallaxCfg,
            recipeArtBibleHash: computeArtBibleHash(project.artBible),
            sketchSha256: await sha256Bytes(stack.bands[0]!.rawPngBytes),
            generationMeta: {
              providerId: spriteProvider.id,
              modelId: spriteProvider.modelId,
              seed: 3001,
              adherence: 'balanced',
              promptDelta: bp.parallaxPrompt,
              compiledPrompt: bp.parallaxPrompt,
              createdAt: new Date().toISOString(),
            },
          });
          await repo.saveSpriteNode(parallaxNode);
          return { artifactId: parallaxNode.id };
        }

        case 'entity': {
          const slug = node.metaSlug ?? heroSpec.slug;
          const member = bp.cast.find((c) => c.slug === slug) ?? heroSpec;
          const directorBp = parseAndClampDirectorBlueprint(
            {
              slug: member.slug,
              displayName: member.slug
                .split('_')
                .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
                .join(' '),
              bodyType: member.bodyType,
              spritePrompt: `${member.prompt}, ${bp.artBiblePrompt}`,
              turnaroundLayout: 'single',
              generateNormalMap: true,
              colliderMode: 'convex-hull',
              includeHitbox: member.role !== 'prop',
              includeHurtbox: member.role !== 'prop',
              sockets:
                member.role === 'prop'
                  ? [{ name: 'center', normX: 0.5, normY: 0.5, baseAngleDeg: 0 }]
                  : [
                      { name: 'hand_r', normX: 0.78, normY: 0.52, baseAngleDeg: 25 },
                      { name: 'head', normX: 0.5, normY: 0.18, baseAngleDeg: 0 },
                    ],
              sfxSpecs: [
                {
                  cueName: member.role === 'prop' ? 'pickup_chime' : 'attack_slash',
                  category: 'sfx',
                  prompt: `${member.slug} signature SFX`,
                  engine: 'procedural',
                  proceduralPreset: member.role === 'prop' ? 'pickup' : 'hit',
                },
              ],
              behavior: {
                archetype:
                  member.role === 'hero'
                    ? 'player'
                    : member.role === 'prop'
                      ? 'pickup'
                      : 'melee-enemy',
                moveSpeed: member.role === 'hero' ? 140 : 95,
                maxHealth: member.role === 'hero' ? 100 : 40,
                attackDamage: member.role === 'hero' ? 16 : 10,
                states:
                  member.role === 'prop'
                    ? ['IDLE', 'COLLECTED']
                    : ['IDLE', 'PATROL', 'ATTACK', 'HURT'],
              },
            },
            member.prompt,
            bp.genre === 'top-down' ? 'top-down' : 'side-platformer',
          );

          const res = await executeEntityDirectorPlan(database, projectId, directorBp, {
            providerConfig: spriteProvider,
            generateGdScript: true,
            resSubpath: 'entities',
            signal,
          });
          throwIfAborted(signal);

          // Optional M34 pose clip cycle + M27 hit_flash shader preset attachment
          const updatedClips = [...res.entity.clips];
          if (member.posePreset) {
            const poseClipDef = createPoseClipFromPreset(member.posePreset, 64, 64);
            const refBlobRec = await repo.getBlob(
              res.spriteNode.processedBlobId ?? res.spriteNode.imageBlobId,
            );
            if (refBlobRec) {
              const refBytes = new Uint8Array(await refBlobRec.bytes.arrayBuffer());
              const decodedRef = await decodePngBytesToRgba(refBytes);
              const goldenRefBuf = {
                width: decodedRef.width,
                height: decodedRef.height,
                data: decodedRef.rgba,
              };
              const stripResult = await generatePoseSpriteCycle(
                goldenRefBuf,
                poseClipDef,
                project.artBible,
                fullGenAiProvider,
                { signal },
              );
              const stripPng = encodeRgbaToPngBytes(
                stripResult.generatedStrip.data,
                stripResult.generatedStrip.width,
                stripResult.generatedStrip.height,
              );
              const stripBlob = await repo.storeBlobDeduplicated(stripPng, 'image/png');
              const poseSprite = SpriteNodeSchema.parse({
                ...res.spriteNode,
                id: globalThis.crypto.randomUUID(),
                parentId: res.spriteNode.id,
                imageBlobId: stripBlob.id,
                processedBlobId: stripBlob.id,
                sketchSha256: await sha256Bytes(stripPng),
              });
              await repo.saveSpriteNode(poseSprite);
              updatedClips.push({
                name: member.posePreset === 'run_6f' ? 'run' : 'attack',
                spriteNodeId: poseSprite.id,
                fps: poseClipDef.fps,
                loop: poseClipDef.loop,
              });
            }
          }

          const hitFlashShader = createDefaultShaderConfig('hit_flash');
          const enhancedEntity: EntityDefinition = EntityDefinitionSchema.parse({
            ...res.entity,
            clips: updatedClips,
            shaderConfig: hitFlashShader,
            updatedAt: Date.now(),
          });
          await repo.saveEntity(enhancedEntity);
          return { artifactId: enhancedEntity.id };
        }

        case 'bmfont': {
          const allNodes = await repo.listSpriteNodes(projectId);
          const anchor = allNodes[0];
          const fontCfg = {
            ...createDefaultBitmapFontConfig(),
            fontName: `${sanitizeSliceSlug(bp.projectSlug)}_hud`,
            topHex: palette[4] ?? '#FFCD75',
            bottomHex: palette[3] ?? '#EF7D57',
            outlineHex: palette[0] ?? '#1A1C2C',
          };
          const fallbackBytes = encodeRgbaToPngBytes(new Uint8ClampedArray(16 * 16 * 4), 16, 16);
          const fallbackBlob = anchor
            ? undefined
            : await repo.storeBlobDeduplicated(fallbackBytes, 'image/png');
          const blobId = anchor?.processedBlobId ?? anchor?.imageBlobId ?? fallbackBlob!.id;

          const bmNode = SpriteNodeSchema.parse({
            id: globalThis.crypto.randomUUID(),
            projectId,
            parentId: null,
            kind: 'generation',
            assetClass: 'ui-panel',
            imageBlobId: blobId,
            processedBlobId: blobId,
            postProcessConfig: createDefaultPostProcessConfig(64, 64),
            bitmapFont: fontCfg,
            sketchSha256: await sha256Bytes(fallbackBytes),
            generationMeta: {
              providerId: mockProvider.id,
              modelId: mockProvider.modelId,
              seed: 4001,
              adherence: 'strict',
              promptDelta: `${bp.uiThemePrompt} bitmap font`,
              compiledPrompt: `${bp.uiThemePrompt} bitmap font`,
              createdAt: new Date().toISOString(),
            },
          });
          await repo.saveSpriteNode(bmNode);
          return { artifactId: bmNode.id };
        }

        case 'ui-theme': {
          const bmNodeId = job.nodes.find((n) => n.id === 'bmfont')?.artifactId;
          const uiSlug = `${sanitizeSliceSlug(bp.projectSlug)}_hud`;
          const uiCfg = {
            ...createDefaultUiKitConfig(palette),
            slug: uiSlug,
            ...(bmNodeId ? { linkedBmFontId: bmNodeId } : {}),
          };
          const kit = bakeProceduralUiKit(uiCfg);
          const previewPng = encodeRgbaToPngBytes(
            kit.slots.button_normal.data,
            kit.slots.button_normal.width,
            kit.slots.button_normal.height,
          );
          const previewBlob = await repo.storeBlobDeduplicated(previewPng, 'image/png');

          const uiNode = SpriteNodeSchema.parse({
            id: globalThis.crypto.randomUUID(),
            projectId,
            parentId: null,
            kind: 'generation',
            assetClass: 'ui-panel',
            imageBlobId: previewBlob.id,
            processedBlobId: previewBlob.id,
            postProcessConfig: createDefaultPostProcessConfig(
              kit.slots.button_normal.width,
              kit.slots.button_normal.height,
            ),
            uiKitConfig: uiCfg,
            sketchSha256: await sha256Bytes(previewPng),
            generationMeta: {
              providerId: mockProvider.id,
              modelId: mockProvider.modelId,
              seed: 5001,
              adherence: 'strict',
              promptDelta: bp.uiThemePrompt,
              compiledPrompt: bp.uiThemePrompt,
              createdAt: new Date().toISOString(),
            },
          });
          await repo.saveSpriteNode(uiNode);
          return { artifactId: uiNode.id };
        }

        case 'room': {
          const tileSetNodeId =
            job.nodes.find((n) => n.id === 'terrain_tileset')?.artifactId ?? null;
          const parallaxNodeId =
            job.nodes.find((n) => n.id === 'parallax_stack')?.artifactId ?? null;
          const res = await generateRoomBlueprint({
            prompt: bp.roomPrompt,
            cols: bp.roomCols,
            rows: bp.roomRows,
            tileSizePx: bp.tileSizePx,
            artBible: project.artBible,
            availableEntitySlugs: bp.cast.map((c) => c.slug),
            providerConfig: spriteProvider,
            signal,
          });
          throwIfAborted(signal);
          const savedRoom = await repo.saveRoom({
            id: globalThis.crypto.randomUUID(),
            projectId,
            slug: sanitizeSliceSlug(`${bp.projectSlug}_arena`),
            tileSetNodeId,
            tileSetMode: 'blob47',
            parallaxNodeId,
            blueprint: {
              ...res.blueprint,
              slug: sanitizeSliceSlug(`${bp.projectSlug}_arena`),
            },
            updatedAt: Date.now(),
          });
          return { artifactId: savedRoom.id };
        }

        case 'main-scene': {
          const roomList = await repo.listRooms(projectId);
          const roomSlug = roomList[0]?.slug ?? sanitizeSliceSlug(`${bp.projectSlug}_arena`);
          const uiSlug = `${sanitizeSliceSlug(bp.projectSlug)}_hud`;
          exportGodotMainSceneTscn({
            levelResPath: `res://levels/${roomSlug}.tscn`,
            themeResPath: `res://ui/${uiSlug}_theme.tres`,
          });
          return { artifactId: 'main.tscn' };
        }

        case 'visual-qa': {
          const nodes = await repo.listSpriteNodes(projectId);
          const entityList = await repo.listEntities(projectId);
          const entityNodeIds = new Set(entityList.map((e) => e.primarySpriteNodeId));
          const castNodes = nodes.filter((n) => entityNodeIds.has(n.id));
          const selected = castNodes.length > 0 ? castNodes : nodes.slice(0, 4);
          if (selected.length === 0) return { artifactId: 'qa_skipped' };

          const entries = [];
          for (const sp of selected) {
            const rec = await repo.getBlob(sp.processedBlobId ?? sp.imageBlobId);
            if (!rec) continue;
            try {
              const bytes = new Uint8Array(await rec.bytes.arrayBuffer());
              const decoded = await decodePngBytesToRgba(bytes);
              entries.push({
                spriteId: sp.id,
                slug: sanitizeSliceSlug(sp.generationMeta.promptDelta || sp.id),
                buffer: {
                  width: decoded.width,
                  height: decoded.height,
                  data: decoded.rgba,
                },
              });
            } catch {
              // skip non-PNG
            }
          }
          if (entries.length === 0) return { artifactId: 'qa_skipped' };

          const qa = await runArtDirectorQaPass(
            database,
            projectId,
            entries,
            project.artBible,
            mockProvider,
            { signal, forceRefresh: true },
          );
          return { artifactId: qa.report.sheetHash };
        }
      }
    } catch (err) {
      await repo.cleanupOrphanedBlobs().catch(() => undefined);
      throw err;
    }
  };
}

/**
 * Collects the complete deduplicated `VirtualSyncFile[]` tree for a completed or active
 * `SliceJobRecord` (`main.tscn`, `levels/<slug>.tscn`, `entities/<slug>/<slug>.tscn`,
 * `tiles/<slug>_tileset.tres`, `parallax/<slug>_parallax.tscn`, `ui/<slug>_theme.tres`, and `qa_report.json`).
 */
export async function collectVerticalSliceGodotSyncFiles(
  database: NibgridDatabase,
  project: Project,
  job: SliceJobRecord,
): Promise<readonly VirtualSyncFile[]> {
  const repo = new NibgridRepository(database);
  const [entities, spriteNodes, audioAssets, rooms, qaReport] = await Promise.all([
    repo.listEntities(project.id),
    repo.listSpriteNodes(project.id),
    repo.listAudioAssets(project.id),
    repo.listRooms(project.id),
    repo.getQaReport(project.id),
  ]);

  const isPixelArt = project.artBible.artMode === 'pixel-art';
  const nodeById = new Map(spriteNodes.map((n) => [n.id, n]));
  const baseSlug = sanitizeSliceSlug(job.blueprint.projectSlug);

  // 1. Entities (`entities/<slug>/<slug>.tscn`, `.gd`, `.gdshader`, `.wav`, `.import`)
  const entityFiles: VirtualSyncFile[] = [];
  const entityResPaths: Record<string, string> = {};
  for (const ent of entities) {
    const slug = sanitizeEntitySlug(ent.slug || ent.displayName);
    const subpath = normalizeResSubpath(ent.resSubpath);
    entityResPaths[slug] = `res://${subpath}/${slug}/${slug}.tscn`;
    const files = await collectEntitySyncFiles(database, project, ent, spriteNodes, audioAssets);
    entityFiles.push(...files);
  }

  // 2. M20 Tileset (`tiles/<slug>_tileset.tres` + PNG + `.import`)
  const tileFiles: VirtualSyncFile[] = [];
  const tileNodeId = job.nodes.find((n) => n.id === 'terrain_tileset')?.artifactId;
  const tileNode = tileNodeId ? nodeById.get(tileNodeId) : undefined;
  let tileSetResPath: string | undefined;
  if (tileNode?.autoTile) {
    const blobRec = await repo.getBlob(tileNode.processedBlobId ?? tileNode.imageBlobId);
    if (blobRec) {
      const bytes = new Uint8Array(await blobRec.bytes.arrayBuffer());
      const decoded = await decodePngBytesToRgba(bytes);
      const sheetRes = composeAutoTileSheet(
        { width: decoded.width, height: decoded.height, data: decoded.rgba },
        null,
        {
          mode: 'blob-47',
          edgeStyle: tileNode.autoTile.edgeStyle,
          borderWidthPx: tileNode.autoTile.borderWidthPx,
          cornerRadiusPx: tileNode.autoTile.cornerRadiusPx,
          jitterPx: tileNode.autoTile.jitterPx,
          edgeTintHex: tileNode.autoTile.edgeTintHex,
          seed: tileNode.autoTile.seed,
        },
      );
      const sheetPng = encodeRgbaToPngBytes(
        sheetRes.sheet.data,
        sheetRes.sheet.width,
        sheetRes.sheet.height,
      );
      const texRel = `tiles/${baseSlug}_autotile_blob-47.png`;
      const tresRel = `tiles/${baseSlug}_tileset.tres`;
      tileSetResPath = `res://${tresRel}`;
      tileFiles.push(
        { relativePath: texRel, content: sheetPng },
        {
          relativePath: `${texRel}.import`,
          content: generateGodotPngImport(`res://${texRel}`, isPixelArt),
        },
        {
          relativePath: tresRel,
          content: exportGodotTileSetTres({
            assetName: `${baseSlug}_tiles`,
            textureFilename: texRel,
            tileSize: sheetRes.tileSize,
            mode: 'blob-47',
            cells: sheetRes.cells,
          }),
        },
      );
    }
  }

  // 3. M23 Parallax (`parallax/<slug>_parallax.tscn` + layers)
  const parallaxFiles: VirtualSyncFile[] = [];
  const parallaxNodeId = job.nodes.find((n) => n.id === 'parallax_stack')?.artifactId;
  const parallaxNode: SpriteNode | undefined = parallaxNodeId
    ? nodeById.get(parallaxNodeId)
    : undefined;
  let parallaxResPath: string | undefined;
  if (parallaxNode?.parallaxScene) {
    const exportLayers = [];
    for (let i = 0; i < parallaxNode.parallaxScene.layers.length; i++) {
      const layer = parallaxNode.parallaxScene.layers[i]!;
      if (!layer.blobId) continue;
      const bRec = await repo.getBlob(layer.blobId);
      if (!bRec) continue;
      const pngBytes = new Uint8Array(await bRec.bytes.arrayBuffer());
      const decoded = await decodePngBytesToRgba(pngBytes);
      const rel = `parallax/${baseSlug}_layer_${i}_${safeParallaxLayerSlug(layer.name, i)}.png`;
      parallaxFiles.push(
        { relativePath: rel, content: pngBytes },
        {
          relativePath: `${rel}.import`,
          content: generateGodotPngImport(`res://${rel}`, isPixelArt),
        },
      );
      exportLayers.push({
        id: layer.id,
        name: layer.name,
        role: layer.role,
        scrollRatioX: layer.scrollRatioX,
        yOffsetPx: layer.yOffsetPx,
        seamBlendPx: layer.seamBlendPx,
        depthHaze: layer.depthHaze,
        buffer: { width: decoded.width, height: decoded.height, data: decoded.rgba },
      });
    }
    const pRel = `parallax/${baseSlug}_parallax.tscn`;
    parallaxResPath = `res://${pRel}`;
    parallaxFiles.push({
      relativePath: pRel,
      content: exportGodotParallaxTscn(`parallax/${baseSlug}`, exportLayers, {
        viewportWidth: 320,
        viewportHeight: 180,
        skyTopHex: parallaxNode.parallaxScene.skyTopHex,
        horizonHex: parallaxNode.parallaxScene.horizonHex,
        contrastDampening: parallaxNode.parallaxScene.contrastDampening,
        cameraSpeedPxPerSec: parallaxNode.parallaxScene.cameraSpeedPxPerSec,
        artMode: project.artBible.artMode,
      }),
    });
  }

  // 4. M33 UI Theme + M24 BMFont (`ui/<slug>_theme.tres` + 7 PNGs + `.fnt`)
  const uiFiles: VirtualSyncFile[] = [];
  const uiNodeId = job.nodes.find((n) => n.id === 'ui_theme')?.artifactId;
  const uiNode = uiNodeId
    ? nodeById.get(uiNodeId)
    : spriteNodes.find((n) => Boolean(n.uiKitConfig));
  let themeResPath: string | undefined;
  if (uiNode?.uiKitConfig) {
    const kit = bakeProceduralUiKit(uiNode.uiKitConfig);
    const fontNode = uiNode.uiKitConfig.linkedBmFontId
      ? nodeById.get(uiNode.uiKitConfig.linkedBmFontId)
      : undefined;
    const bakedFont = fontNode?.bitmapFont
      ? bakeBitmapFontFromConfig(fontNode.bitmapFont, project.artBible.palette)
      : undefined;
    const assembledUi = assembleGodotUiKitFiles(kit, {
      resSubpath: 'ui',
      isPixelArt,
      ...(bakedFont
        ? { linkedFont: { filenameBase: bakedFont.fontName || `${baseSlug}_hud`, font: bakedFont } }
        : {}),
    });
    uiFiles.push(...assembledUi);
    themeResPath = `res://ui/${sanitizeEntitySlug(kit.slug)}_theme.tres`;
  }

  // 5. M35 Room (`levels/<slug>.tscn`)
  const roomFiles: VirtualSyncFile[] = [];
  const roomId = job.nodes.find((n) => n.id === 'room_level')?.artifactId;
  const room = (roomId ? rooms.find((r) => r.id === roomId) : undefined) ?? rooms[0];
  let levelResPath = `res://levels/${baseSlug}_arena.tscn`;
  if (room) {
    levelResPath = `res://levels/${sanitizeSliceSlug(room.slug)}.tscn`;
    roomFiles.push(
      ...assembleGodotRoomFiles({
        blueprint: room.blueprint,
        tileSetMode: room.tileSetMode,
        ...(tileSetResPath ? { tileSetResPath } : {}),
        ...(parallaxResPath ? { parallaxResPath } : {}),
        entityResPaths,
        isPixelArt,
      }),
    );
  }

  // 6. M37 `main.tscn` entry scene
  const mainSceneTscn = exportGodotMainSceneTscn({
    levelResPath,
    ...(themeResPath ? { themeResPath } : {}),
    rootName: 'Main',
  });

  return assembleVerticalSliceSyncFiles({
    mainSceneTscn,
    roomFiles,
    entityFiles,
    uiFiles,
    tileFiles,
    parallaxFiles,
    ...(qaReport ? { qaReportJson: `${JSON.stringify(qaReport, null, 2)}\n` } : {}),
  });
}
