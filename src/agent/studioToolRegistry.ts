import { z } from 'zod';
import { encodeWav16 } from '../audio/pcmPostProcess';
import { synthesizeProceduralSfx } from '../audio/proceduralSynth';
import type { ProceduralSfxParams } from '../audio/types';
import { NibgridRepository, type NibgridDatabase } from '../db/database';
import {
  EntityDefinitionSchema,
  sanitizeEntitySlug,
  type EntityDefinition,
} from '../domain/entitySchema';
import {
  AudioAssetSchema,
  SocketDefinitionSchema,
  SpriteNodeSchema,
  createDefaultAudioPostProcessConfig,
  createDefaultShaderConfig,
  type AudioAsset,
  type ProviderConfig,
  type ProviderKind,
  type SpriteNode,
} from '../domain/schemas';
import { extractCollisionHull } from '../processing/collisionHull';
import {
  GDSHADER_PRESETS,
  getGdShaderPreset,
  type GdShaderPresetId,
} from '../processing/gdshaderPresets';
import { transpileGdShaderToWebGL2 } from '../processing/gdshaderTranspiler';
import { quantizeToPaletteOklab } from '../processing/paletteQuantize';
import { hexToRgbaColor } from '../processing/pixelEditorCore';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../processing/png';
import {
  RoomLayoutBlueprintSchema,
  StoredRoomRecordSchema,
  sanitizeRoomPlacements,
} from '../processing/roomLayoutCore';
import { estimateInpaintCost, runRegionInpaint } from '../providers/inpaintAdapter';
import { collectProjectGodotSyncFiles } from '../sync/fsaaSyncEngine';
import { computeSyncDiff } from '../sync/syncDiff';
import { slugifyAssetLabel } from './contextResolver';

export const STUDIO_TOOL_NAMES = [
  'inpaint_sprite_region',
  'repalette_sprites',
  'update_gdshader_uniforms',
  'add_or_move_socket',
  'recompute_colliders',
  'generate_sfx_cue',
  'patch_room_layout',
  'sync_godot_diff',
] as const;

export type StudioToolName = (typeof STUDIO_TOOL_NAMES)[number];

export const InpaintSpriteRegionArgsSchema = z.object({
  targetSlug: z.string().min(1),
  promptDelta: z.string().min(1),
  snapToPalette: z.boolean().optional(),
  maskRegion: z.enum(['center', 'upper', 'lower', 'full']).optional(),
});

export const RepaletteSpritesArgsSchema = z.object({
  targetSlugs: z.array(z.string().min(1)).min(1).max(8),
  outlineTintHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  dither: z.boolean().optional(),
});

export const UpdateGdShaderUniformsArgsSchema = z.object({
  targetSlug: z.string().min(1),
  presetId: z.string().min(1).optional(),
  tintHex: z
    .string()
    .regex(/^#[0-9A-Fa-f]{6}$/)
    .optional(),
  uniformOverrides: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  gdshaderSource: z.string().min(10).optional(),
});

export const AddOrMoveSocketArgsSchema = z.object({
  targetSlug: z.string().min(1),
  socketName: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9_]+$/),
  normX: z.number().min(0).max(1).optional(),
  normY: z.number().min(0).max(1).optional(),
  baseAngleDeg: z.number().min(-360).max(360).optional(),
});

export const RecomputeCollidersArgsSchema = z.object({
  targetSlug: z.string().min(1),
  kind: z.enum(['convex-hull', 'polygon', 'aabb', 'capsule']).optional(),
  maxVertices: z.number().int().min(3).max(32).optional(),
  addHitbox: z.boolean().optional(),
});

export const GenerateSfxCueArgsSchema = z.object({
  cueName: z.string().trim().min(1).max(64),
  proceduralPreset: z.enum(['attack', 'hit', 'jump', 'pickup', 'footstep']).optional(),
  attachEntitySlug: z.string().optional(),
  clipName: z.string().optional(),
  frameIndex: z.number().int().min(0).max(64).optional(),
});

export const PatchRoomLayoutArgsSchema = z.object({
  roomSlug: z.string().min(1),
  addPlatforms: z
    .array(
      z.object({
        row: z.number().int().min(1).max(31),
        startCol: z.number().int().min(0).max(63),
        endCol: z.number().int().min(0).max(63),
      }),
    )
    .optional(),
  spawnEntities: z
    .array(
      z.object({
        entitySlug: z.string().min(1),
        cellX: z.number().int().min(0).max(63),
        cellY: z.number().int().min(0).max(31),
      }),
    )
    .optional(),
  clearEntitySlug: z.string().optional(),
});

export const SyncGodotDiffArgsSchema = z.object({
  scope: z.enum(['all', 'entities', 'rooms']).default('all'),
});

export const STUDIO_TOOL_SCHEMAS = {
  inpaint_sprite_region: InpaintSpriteRegionArgsSchema,
  repalette_sprites: RepaletteSpritesArgsSchema,
  update_gdshader_uniforms: UpdateGdShaderUniformsArgsSchema,
  add_or_move_socket: AddOrMoveSocketArgsSchema,
  recompute_colliders: RecomputeCollidersArgsSchema,
  generate_sfx_cue: GenerateSfxCueArgsSchema,
  patch_room_layout: PatchRoomLayoutArgsSchema,
  sync_godot_diff: SyncGodotDiffArgsSchema,
} as const;

export const StudioToolCallSchema = z.discriminatedUnion('toolName', [
  z.object({ toolName: z.literal('inpaint_sprite_region'), args: InpaintSpriteRegionArgsSchema }),
  z.object({ toolName: z.literal('repalette_sprites'), args: RepaletteSpritesArgsSchema }),
  z.object({
    toolName: z.literal('update_gdshader_uniforms'),
    args: UpdateGdShaderUniformsArgsSchema,
  }),
  z.object({ toolName: z.literal('add_or_move_socket'), args: AddOrMoveSocketArgsSchema }),
  z.object({ toolName: z.literal('recompute_colliders'), args: RecomputeCollidersArgsSchema }),
  z.object({ toolName: z.literal('generate_sfx_cue'), args: GenerateSfxCueArgsSchema }),
  z.object({ toolName: z.literal('patch_room_layout'), args: PatchRoomLayoutArgsSchema }),
  z.object({ toolName: z.literal('sync_godot_diff'), args: SyncGodotDiffArgsSchema }),
]);
export type StudioToolCall = z.infer<typeof StudioToolCallSchema>;

export const STUDIO_GEMINI_TOOL_DECLARATIONS = [
  {
    name: 'inpaint_sprite_region',
    description:
      'Redraw a localized mask region on a sprite while keeping unmasked pixels byte-identical.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetSlug: { type: 'STRING' },
        promptDelta: { type: 'STRING' },
        snapToPalette: { type: 'BOOLEAN' },
        maskRegion: { type: 'STRING', enum: ['center', 'upper', 'lower', 'full'] },
      },
      required: ['targetSlug', 'promptDelta'],
    },
  },
  {
    name: 'repalette_sprites',
    description:
      'Deterministically snap sprites to the locked ArtBible OKLab palette or apply an outline tint.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetSlugs: { type: 'ARRAY', items: { type: 'STRING' } },
        outlineTintHex: { type: 'STRING' },
        dither: { type: 'BOOLEAN' },
      },
      required: ['targetSlugs'],
    },
  },
  {
    name: 'update_gdshader_uniforms',
    description:
      'Update a Godot 4 canvas_item .gdshader source or uniform color/float values on an entity or sprite.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetSlug: { type: 'STRING' },
        presetId: { type: 'STRING' },
        tintHex: { type: 'STRING' },
        gdshaderSource: { type: 'STRING' },
      },
      required: ['targetSlug'],
    },
  },
  {
    name: 'add_or_move_socket',
    description:
      'Add or reposition a normalized M21 attachment Marker2D socket (hand_r, muzzle, cape_tip, exhaust) on a sprite.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetSlug: { type: 'STRING' },
        socketName: { type: 'STRING' },
        normX: { type: 'NUMBER' },
        normY: { type: 'NUMBER' },
        baseAngleDeg: { type: 'NUMBER' },
      },
      required: ['targetSlug', 'socketName', 'normX', 'normY'],
    },
  },
  {
    name: 'recompute_colliders',
    description:
      'Rebuild Marching Squares + RDP M16 collision hulls and optional attack hitboxes on a sprite.',
    parameters: {
      type: 'OBJECT',
      properties: {
        targetSlug: { type: 'STRING' },
        kind: { type: 'STRING', enum: ['convex-hull', 'polygon', 'aabb', 'capsule'] },
        maxVertices: { type: 'INTEGER' },
        addHitbox: { type: 'BOOLEAN' },
      },
      required: ['targetSlug'],
    },
  },
  {
    name: 'generate_sfx_cue',
    description:
      'Synthesize a procedural 16-bit WAV SFX cue and optionally bind it to an Entity animation clip frame.',
    parameters: {
      type: 'OBJECT',
      properties: {
        cueName: { type: 'STRING' },
        proceduralPreset: { type: 'STRING', enum: ['attack', 'hit', 'jump', 'pickup', 'footstep'] },
        attachEntitySlug: { type: 'STRING' },
        clipName: { type: 'STRING' },
        frameIndex: { type: 'INTEGER' },
      },
      required: ['cueName', 'proceduralPreset'],
    },
  },
  {
    name: 'patch_room_layout',
    description:
      'Add platforms or entity spawn coordinates to an M35 TileMapLayer room while sanitizing overlaps.',
    parameters: {
      type: 'OBJECT',
      properties: {
        roomSlug: { type: 'STRING' },
      },
      required: ['roomSlug'],
    },
  },
  {
    name: 'sync_godot_diff',
    description:
      'Preview pending Godot 4 res:// file changes requiring explicit user confirmation before disk sync.',
    parameters: {
      type: 'OBJECT',
      properties: {
        scope: { type: 'STRING', enum: ['all', 'entities', 'rooms'] },
      },
      required: ['scope'],
    },
  },
] as const;

export const StagedAssetPatchSchema = z.discriminatedUnion('patchKind', [
  z.object({
    patchKind: z.literal('sprite-node'),
    spriteNode: SpriteNodeSchema,
  }),
  z.object({
    patchKind: z.literal('entity-def'),
    entity: EntityDefinitionSchema,
  }),
  z.object({
    patchKind: z.literal('audio-asset'),
    audioAsset: AudioAssetSchema,
    updatedEntity: EntityDefinitionSchema.optional(),
  }),
  z.object({
    patchKind: z.literal('room-record'),
    room: StoredRoomRecordSchema,
  }),
  z.object({
    patchKind: z.literal('sync-preview'),
    changedPathCount: z.number().int().nonnegative(),
  }),
]);
export type StagedAssetPatch = z.infer<typeof StagedAssetPatchSchema>;

export const StagedAssetChangeSchema = z.object({
  changeId: z.string().min(1),
  toolName: z.enum(STUDIO_TOOL_NAMES),
  targetId: z.string().min(1),
  targetSlug: z.string().min(1),
  kind: z.enum(['sprite', 'shader', 'audio', 'entity', 'room']),
  summary: z.string().min(1),
  beforeBlobId: z.string().min(1).optional(),
  afterBlobId: z.string().min(1).optional(),
  textDiff: z
    .object({
      before: z.string(),
      after: z.string(),
    })
    .optional(),
  requiresExplicitConfirm: z.boolean().optional(),
  estimatedUsd: z.number().nonnegative(),
  status: z.enum(['pending', 'accepted', 'rejected']),
  patch: StagedAssetPatchSchema,
});
export type StagedAssetChange = z.infer<typeof StagedAssetChangeSchema>;

export function estimateToolCallCostUsd(call: StudioToolCall, providerKind: ProviderKind): number {
  if (call.toolName === 'inpaint_sprite_region') {
    return estimateInpaintCost(providerKind).estimatedUsd;
  }
  return 0;
}

function buildMaskForRegion(
  width: number,
  height: number,
  region: 'center' | 'upper' | 'lower' | 'full',
): Uint8Array {
  const mask = new Uint8Array(width * height);
  const yStart = region === 'lower' ? Math.floor(height * 0.45) : 0;
  const yEnd = region === 'upper' ? Math.ceil(height * 0.55) : height;
  const xStart = region === 'center' ? Math.floor(width * 0.2) : 0;
  const xEnd = region === 'center' ? Math.ceil(width * 0.8) : width;

  for (let y = yStart; y < yEnd; y++) {
    for (let x = xStart; x < xEnd; x++) {
      mask[y * width + x] = 1;
    }
  }
  return mask;
}

function resolveEntityOrSpriteTarget(
  slugOrId: string,
  entities: readonly EntityDefinition[],
  spriteNodes: readonly SpriteNode[],
): { entity?: EntityDefinition; spriteNode?: SpriteNode } {
  const norm = slugifyAssetLabel(slugOrId);
  const entity =
    entities.find((e) => e.id === slugOrId || slugifyAssetLabel(e.slug) === norm) ??
    entities.find((e) => slugifyAssetLabel(e.displayName) === norm);

  const spriteNode =
    (entity
      ? spriteNodes.find((s) => s.id === entity.primarySpriteNodeId)
      : spriteNodes.find(
          (s) =>
            s.id === slugOrId ||
            slugifyAssetLabel(
              s.generationMeta.promptDelta || `${s.kind}_${s.generationMeta.seed}`,
            ) === norm,
        )) ?? spriteNodes[spriteNodes.length - 1];

  return { entity, spriteNode };
}

function buildGdShaderUniformPatch(source: string, tintHex?: string): string {
  if (!tintHex) return source;
  const c = hexToRgbaColor(tintHex);
  const r = (c[0] / 255).toFixed(3);
  const g = (c[1] / 255).toFixed(3);
  const b = (c[2] / 255).toFixed(3);
  const vec4Literal = `vec4(${r}, ${g}, ${b}, 1.0)`;

  if (/uniform\s+vec4\s+[A-Za-z0-9_]*color[A-Za-z0-9_]*\s*:[^=;]*=/i.test(source)) {
    return source.replace(
      /(uniform\s+vec4\s+[A-Za-z0-9_]*color[A-Za-z0-9_]*\s*:[^=;]*=\s*)([^;]+)(;)/i,
      `$1${vec4Literal}$3`,
    );
  }
  return `${source.trimEnd()}\nuniform vec4 tint_override : source_color = ${vec4Literal};\n`;
}

/**
 * Executes a validated `StudioToolCall` into an isolated `StagedAssetChange` buffer.
 * Never mutates `spriteNodes`, `entities`, `audioAssets`, or `rooms` directly—only
 * writes deduplicated temporary output blobs to `blobs` until committed or purged.
 */
export async function executeStagedToolCall(
  database: NibgridDatabase,
  projectId: string,
  call: StudioToolCall,
  providerConfig: ProviderConfig,
  options: { readonly customMask?: Uint8Array } = {},
): Promise<StagedAssetChange[]> {
  const repo = new NibgridRepository(database);
  const project = await repo.getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const [spriteNodes, entities, audioAssets, rooms] = await Promise.all([
    repo.listSpriteNodes(projectId),
    repo.listEntities(projectId),
    repo.listAudioAssets(projectId),
    repo.listRooms(projectId),
  ]);

  const estimatedUsd = estimateToolCallCostUsd(call, providerConfig.kind);

  switch (call.toolName) {
    case 'inpaint_sprite_region': {
      const { spriteNode } = resolveEntityOrSpriteTarget(
        call.args.targetSlug,
        entities,
        spriteNodes,
      );
      if (!spriteNode) {
        throw new Error(`Target sprite "${call.args.targetSlug}" not found for inpainting.`);
      }
      const beforeBlobId = spriteNode.processedBlobId ?? spriteNode.imageBlobId;
      const blobRec = await repo.getBlob(beforeBlobId);
      if (!blobRec) {
        throw new Error(`Blob "${beforeBlobId}" not found.`);
      }
      const decoded = await decodePngBytesToRgba(new Uint8Array(await blobRec.bytes.arrayBuffer()));
      const mask =
        options.customMask && options.customMask.length === decoded.width * decoded.height
          ? options.customMask
          : buildMaskForRegion(decoded.width, decoded.height, call.args.maskRegion ?? 'upper');

      const inpaintRes = await runRegionInpaint(
        { width: decoded.width, height: decoded.height, data: decoded.rgba },
        mask,
        call.args.promptDelta,
        project.artBible,
        providerConfig,
        { snapToPalette: call.args.snapToPalette ?? true },
      );

      const outPng = encodeRgbaToPngBytes(
        inpaintRes.buffer.data,
        inpaintRes.buffer.width,
        inpaintRes.buffer.height,
      );
      const outBlob = await repo.storeBlobDeduplicated(outPng, 'image/png');
      const nextNode = SpriteNodeSchema.parse({
        ...spriteNode,
        processedBlobId: outBlob.id,
        inpaintHistory: [
          ...(spriteNode.inpaintHistory ?? []),
          {
            id: globalThis.crypto.randomUUID(),
            promptDelta: call.args.promptDelta,
            providerId: providerConfig.id,
            maskedPixels: inpaintRes.maskedPixels,
            createdAt: new Date().toISOString(),
          },
        ],
      });

      return [
        {
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'inpaint_sprite_region',
          targetId: spriteNode.id,
          targetSlug: slugifyAssetLabel(call.args.targetSlug),
          kind: 'sprite',
          summary: `Inpainted region "${call.args.promptDelta}" (${inpaintRes.maskedPixels} px)`,
          beforeBlobId,
          afterBlobId: outBlob.id,
          estimatedUsd,
          status: 'pending',
          patch: { patchKind: 'sprite-node', spriteNode: nextNode },
        },
      ];
    }

    case 'repalette_sprites': {
      const staged: StagedAssetChange[] = [];
      for (const targetSlug of call.args.targetSlugs) {
        const { spriteNode } = resolveEntityOrSpriteTarget(targetSlug, entities, spriteNodes);
        if (!spriteNode) continue;
        const beforeBlobId = spriteNode.processedBlobId ?? spriteNode.imageBlobId;
        const blobRec = await repo.getBlob(beforeBlobId);
        if (!blobRec) continue;

        const decoded = await decodePngBytesToRgba(
          new Uint8Array(await blobRec.bytes.arrayBuffer()),
        );
        const quantized = quantizeToPaletteOklab(
          decoded.rgba,
          decoded.width,
          decoded.height,
          project.artBible.palette,
          { dither: call.args.dither ?? false },
        );

        // If an outline tint hex is requested, recolor 1px silhouette boundary pixels cleanly
        if (call.args.outlineTintHex) {
          const tint = hexToRgbaColor(call.args.outlineTintHex);
          const w = decoded.width;
          const h = decoded.height;
          for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
              const p = (y * w + x) * 4;
              if ((quantized[p + 3] ?? 0) < 128) continue;
              const isEdge =
                x === 0 ||
                x === w - 1 ||
                y === 0 ||
                y === h - 1 ||
                (quantized[((y - 1) * w + x) * 4 + 3] ?? 0) < 128 ||
                (quantized[((y + 1) * w + x) * 4 + 3] ?? 0) < 128 ||
                (quantized[(y * w + (x - 1)) * 4 + 3] ?? 0) < 128 ||
                (quantized[(y * w + (x + 1)) * 4 + 3] ?? 0) < 128;
              if (isEdge) {
                quantized[p] = tint[0];
                quantized[p + 1] = tint[1];
                quantized[p + 2] = tint[2];
              }
            }
          }
        }

        const outPng = encodeRgbaToPngBytes(quantized, decoded.width, decoded.height);
        const outBlob = await repo.storeBlobDeduplicated(outPng, 'image/png');
        const nextNode = SpriteNodeSchema.parse({
          ...spriteNode,
          processedBlobId: outBlob.id,
        });
        staged.push({
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'repalette_sprites',
          targetId: spriteNode.id,
          targetSlug: slugifyAssetLabel(targetSlug),
          kind: 'sprite',
          summary: call.args.outlineTintHex
            ? `Snapped to ArtBible palette + ${call.args.outlineTintHex} outline`
            : `Snapped pixels to locked ArtBible palette (${project.artBible.palette.length} colors)`,
          beforeBlobId,
          afterBlobId: outBlob.id,
          estimatedUsd: 0,
          status: 'pending',
          patch: { patchKind: 'sprite-node', spriteNode: nextNode },
        });
      }
      if (staged.length === 0) {
        throw new Error('No matching sprites found to repalette.');
      }
      return staged;
    }

    case 'update_gdshader_uniforms': {
      const { entity, spriteNode } = resolveEntityOrSpriteTarget(
        call.args.targetSlug,
        entities,
        spriteNodes,
      );
      if (!entity && !spriteNode) {
        throw new Error(`Target "${call.args.targetSlug}" not found for shader update.`);
      }

      const preset: GdShaderPresetId =
        call.args.presetId && GDSHADER_PRESETS.some((p) => p.id === call.args.presetId)
          ? (call.args.presetId as GdShaderPresetId)
          : 'hit_flash';
      const currentShader =
        entity?.shaderConfig ?? spriteNode?.shaderConfig ?? createDefaultShaderConfig(preset);
      const baseSource =
        call.args.gdshaderSource ??
        currentShader.gdshaderSource ??
        getGdShaderPreset(preset).source;
      const nextSource = buildGdShaderUniformPatch(baseSource, call.args.tintHex);

      const transpiled = transpileGdShaderToWebGL2(nextSource);
      if (!transpiled.ok) {
        throw new Error(`Invalid Godot 4 shader patch: ${transpiled.errors[0]}`);
      }

      const nextUniformValues: Record<string, number | readonly number[] | boolean> = {
        ...currentShader.uniformValues,
      };
      if (call.args.uniformOverrides) {
        for (const [k, v] of Object.entries(call.args.uniformOverrides)) {
          if (typeof v === 'number' || typeof v === 'boolean') {
            nextUniformValues[k] = v;
          }
        }
      }

      const nextShader = {
        ...currentShader,
        presetId: preset,
        gdshaderSource: nextSource,
        uniformValues: nextUniformValues,
      };

      if (entity) {
        const nextEntity = EntityDefinitionSchema.parse({
          ...entity,
          shaderConfig: nextShader,
          updatedAt: Date.now(),
        });
        return [
          {
            changeId: globalThis.crypto.randomUUID(),
            toolName: 'update_gdshader_uniforms',
            targetId: entity.id,
            targetSlug: entity.slug,
            kind: 'shader',
            summary: `Updated ${preset} .gdshader${call.args.tintHex ? ` (tint ${call.args.tintHex})` : ''}`,
            textDiff: { before: currentShader.gdshaderSource, after: nextSource },
            estimatedUsd: 0,
            status: 'pending',
            patch: { patchKind: 'entity-def', entity: nextEntity },
          },
        ];
      }

      const targetSprite = spriteNode!;
      const nextNode = SpriteNodeSchema.parse({
        ...targetSprite,
        shaderConfig: nextShader,
      });
      return [
        {
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'update_gdshader_uniforms',
          targetId: targetSprite.id,
          targetSlug: slugifyAssetLabel(call.args.targetSlug),
          kind: 'shader',
          summary: `Updated ${preset} shader${call.args.tintHex ? ` (${call.args.tintHex})` : ''}`,
          textDiff: { before: currentShader.gdshaderSource, after: nextSource },
          estimatedUsd: 0,
          status: 'pending',
          patch: { patchKind: 'sprite-node', spriteNode: nextNode },
        },
      ];
    }

    case 'add_or_move_socket': {
      const { spriteNode } = resolveEntityOrSpriteTarget(
        call.args.targetSlug,
        entities,
        spriteNodes,
      );
      if (!spriteNode) {
        throw new Error(`Target sprite "${call.args.targetSlug}" not found for socket edit.`);
      }
      const w = spriteNode.postProcessConfig?.targetWidth ?? project.artBible.targetWidth ?? 64;
      const h = spriteNode.postProcessConfig?.targetHeight ?? project.artBible.targetHeight ?? 64;
      const beforeSockets = spriteNode.sockets ?? [];
      const existingIdx = beforeSockets.findIndex((s) => s.name === call.args.socketName);
      const nextSocket = SocketDefinitionSchema.parse({
        id: existingIdx >= 0 ? beforeSockets[existingIdx]!.id : globalThis.crypto.randomUUID(),
        name: call.args.socketName,
        restPosPx: {
          x: Math.round((call.args.normX ?? 0.5) * w),
          y: Math.round((call.args.normY ?? 0.5) * h),
        },
        baseAngleDeg: call.args.baseAngleDeg ?? 0,
      });

      const nextSockets = [...beforeSockets];
      if (existingIdx >= 0) {
        nextSockets[existingIdx] = nextSocket;
      } else {
        nextSockets.push(nextSocket);
      }
      const nextNode = SpriteNodeSchema.parse({
        ...spriteNode,
        sockets: nextSockets,
      });

      return [
        {
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'add_or_move_socket',
          targetId: spriteNode.id,
          targetSlug: slugifyAssetLabel(call.args.targetSlug),
          kind: 'entity',
          summary: `${existingIdx >= 0 ? 'Moved' : 'Added'} M21 Marker2D socket "${nextSocket.name}" (${nextSocket.restPosPx.x}, ${nextSocket.restPosPx.y})`,
          textDiff: {
            before: JSON.stringify(beforeSockets, null, 2),
            after: JSON.stringify(nextSockets, null, 2),
          },
          estimatedUsd: 0,
          status: 'pending',
          patch: { patchKind: 'sprite-node', spriteNode: nextNode },
        },
      ];
    }

    case 'recompute_colliders': {
      const { spriteNode } = resolveEntityOrSpriteTarget(
        call.args.targetSlug,
        entities,
        spriteNodes,
      );
      if (!spriteNode) {
        throw new Error(`Target sprite "${call.args.targetSlug}" not found for collider trace.`);
      }
      const blobId = spriteNode.processedBlobId ?? spriteNode.imageBlobId;
      const blobRec = await repo.getBlob(blobId);
      if (!blobRec) {
        throw new Error(`Blob "${blobId}" not found.`);
      }
      const decoded = await decodePngBytesToRgba(new Uint8Array(await blobRec.bytes.arrayBuffer()));
      const pivotNorm = spriteNode.postProcessConfig?.pivotNorm ?? { x: 0.5, y: 1 };
      const pivotPx = {
        x: Math.round(pivotNorm.x * decoded.width),
        y: Math.round(pivotNorm.y * decoded.height),
      };
      const hull = extractCollisionHull(
        { width: decoded.width, height: decoded.height, data: decoded.rgba },
        {
          kind: call.args.kind ?? 'convex-hull',
          maxVertices: call.args.maxVertices ?? 8,
          pivotPx,
        },
      );

      const shapes = [
        {
          id: globalThis.crypto.randomUUID(),
          layer: 'collider' as const,
          kind: hull.kind,
          points: hull.vertices.map((v) => ({ x: v.x, y: v.y })),
          ...(hull.capsule
            ? { capsuleRadius: hull.capsule.radius, capsuleHeight: hull.capsule.height }
            : {}),
        },
      ];

      const beforeShapes = spriteNode.collisionShapes ?? [];
      const nextNode = SpriteNodeSchema.parse({
        ...spriteNode,
        collisionShapes: shapes,
      });

      return [
        {
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'recompute_colliders',
          targetId: spriteNode.id,
          targetSlug: slugifyAssetLabel(call.args.targetSlug),
          kind: 'entity',
          summary: `Rebuilt ${hull.kind} collider (${hull.vertices.length} verts)`,
          textDiff: {
            before: JSON.stringify(beforeShapes, null, 2),
            after: JSON.stringify(shapes, null, 2),
          },
          estimatedUsd: 0,
          status: 'pending',
          patch: { patchKind: 'sprite-node', spriteNode: nextNode },
        },
      ];
    }

    case 'generate_sfx_cue': {
      const presetKind = call.args.proceduralPreset ?? 'hit';
      const synthParams: ProceduralSfxParams = {
        seed: Math.floor(Math.random() * 100000) + 101,
        durationSec: presetKind === 'footstep' ? 0.16 : presetKind === 'jump' ? 0.28 : 0.32,
        sampleRate: 44100,
        transientGain: 0.65,
        transientDecayMs: 14,
        transientFreqHz: presetKind === 'pickup' ? 1400 : presetKind === 'attack' ? 900 : 480,
        bodyGain: 0.75,
        bodyShape:
          presetKind === 'attack' ? 'sawtooth' : presetKind === 'pickup' ? 'sine' : 'triangle',
        bodyStartHz: presetKind === 'jump' ? 220 : presetKind === 'pickup' ? 520 : 340,
        bodyEndHz: presetKind === 'jump' ? 680 : presetKind === 'pickup' ? 1040 : 95,
        bodyAttackMs: 4,
        bodyDecayMs: 180,
        fmRatio: 1.5,
        fmDepth: 110,
        noiseGain: presetKind === 'footstep' ? 0.55 : 0.25,
        noiseDecayMs: 90,
        filterStartHz: 3200,
        filterEndHz: 750,
        filterQ: 2.0,
        bitDepth: 12,
        drive: 1.4,
      };
      const pcm = synthesizeProceduralSfx(synthParams);
      const wavBytes = encodeWav16(pcm);
      const wavBlob = await repo.storeBlobDeduplicated(wavBytes, 'audio/wav');
      const slug = sanitizeEntitySlug(call.args.cueName);
      const frameIdx = call.args.frameIndex ?? 0;

      const audioAsset: AudioAsset = AudioAssetSchema.parse({
        id: globalThis.crypto.randomUUID(),
        projectId,
        name: slug,
        presetId: `agent-${presetKind}`,
        route: 'local-synth',
        modelId: 'procedural-synth-v1',
        wavBlobId: wavBlob.id,
        variationBlobIds: [wavBlob.id],
        synthParams,
        postProcess: createDefaultAudioPostProcessConfig(),
        lufs: -14,
        durationSec: Number((pcm.samples.length / Math.max(1, pcm.sampleRate)).toFixed(3)),
        createdAt: new Date().toISOString(),
      });

      let updatedEntity: EntityDefinition | undefined;
      if (call.args.attachEntitySlug) {
        const ent = entities.find(
          (e) => slugifyAssetLabel(e.slug) === slugifyAssetLabel(call.args.attachEntitySlug!),
        );
        if (ent && ent.clips.length > 0) {
          const clipTarget =
            (call.args.clipName
              ? ent.clips.find((c) => c.name === call.args.clipName)
              : undefined) ?? ent.clips[0]!;
          updatedEntity = EntityDefinitionSchema.parse({
            ...ent,
            audioAssetIds: Array.from(new Set([...ent.audioAssetIds, audioAsset.id])),
            clips: ent.clips.map((c) =>
              c.name === clipTarget.name
                ? {
                    ...c,
                    frameAudioTriggers: {
                      ...(c.frameAudioTriggers ?? {}),
                      [String(frameIdx)]: audioAsset.id,
                    },
                  }
                : c,
            ),
            updatedAt: Date.now(),
          });
        }
      }

      return [
        {
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'generate_sfx_cue',
          targetId: audioAsset.id,
          targetSlug: slug,
          kind: 'audio',
          summary: `Synthesized procedural "${slug}.wav"${updatedEntity ? ` bound to ${updatedEntity.slug}` : ''}`,
          afterBlobId: wavBlob.id,
          estimatedUsd: 0,
          status: 'pending',
          patch: {
            patchKind: 'audio-asset',
            audioAsset,
            ...(updatedEntity ? { updatedEntity } : {}),
          },
        },
      ];
    }

    case 'patch_room_layout': {
      const room =
        rooms.find(
          (r) =>
            r.id === call.args.roomSlug ||
            slugifyAssetLabel(r.slug) === slugifyAssetLabel(call.args.roomSlug),
        ) ?? rooms[0];
      if (!room) {
        throw new Error(`Room "${call.args.roomSlug}" not found.`);
      }

      const nextCells = room.blueprint.cells.map((row) => [...row]);
      for (const plat of call.args.addPlatforms ?? []) {
        const r = Math.max(0, Math.min(room.blueprint.rows - 1, plat.row));
        const c0 = Math.max(0, Math.min(room.blueprint.cols - 1, plat.startCol));
        const c1 = Math.max(c0, Math.min(room.blueprint.cols - 1, plat.endCol));
        for (let c = c0; c <= c1; c++) {
          nextCells[r]![c] = 2;
        }
      }

      let nextEntities = [...room.blueprint.entities];
      if (call.args.clearEntitySlug) {
        const rem = slugifyAssetLabel(call.args.clearEntitySlug);
        nextEntities = nextEntities.filter((e) => slugifyAssetLabel(e.entitySlug) !== rem);
      }
      for (const sp of call.args.spawnEntities ?? []) {
        nextEntities.push({
          id: globalThis.crypto.randomUUID(),
          entitySlug: sanitizeEntitySlug(sp.entitySlug),
          cellX: sp.cellX,
          cellY: sp.cellY,
        });
      }

      const nextBlueprint = RoomLayoutBlueprintSchema.parse(
        sanitizeRoomPlacements({
          ...room.blueprint,
          cells: nextCells,
          entities: nextEntities,
        }),
      );
      const nextRoom = StoredRoomRecordSchema.parse({
        ...room,
        blueprint: nextBlueprint,
        updatedAt: Date.now(),
      });

      return [
        {
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'patch_room_layout',
          targetId: room.id,
          targetSlug: room.slug,
          kind: 'room',
          summary: `Patched M35 room "${room.slug}" (${nextBlueprint.entities.length} spawns)`,
          textDiff: {
            before: JSON.stringify(
              { entities: room.blueprint.entities.length, cells: room.blueprint.cells.length },
              null,
              2,
            ),
            after: JSON.stringify(
              { entities: nextBlueprint.entities.length, cells: nextBlueprint.cells.length },
              null,
              2,
            ),
          },
          estimatedUsd: 0,
          status: 'pending',
          patch: { patchKind: 'room-record', room: nextRoom },
        },
      ];
    }

    case 'sync_godot_diff': {
      const syncTarget = await repo.getSyncTarget(projectId);
      const files = await collectProjectGodotSyncFiles(
        database,
        project,
        entities,
        spriteNodes,
        audioAssets,
        rooms,
      );
      const { plan } = await computeSyncDiff(files, syncTarget?.lastSyncedHashes ?? {});
      const changedCount = plan.added.length + plan.modified.length;

      return [
        {
          changeId: globalThis.crypto.randomUUID(),
          toolName: 'sync_godot_diff',
          targetId: projectId,
          targetSlug: 'godot_res_sync',
          kind: 'entity',
          summary: `Ready to sync ${changedCount} changed Godot res:// files (${files.length} total)`,
          textDiff: {
            before: `${Object.keys(syncTarget?.lastSyncedHashes ?? {}).length} previously synced files`,
            after:
              [...plan.added, ...plan.modified].map((f) => f.relativePath).join('\n') ||
              'Up to date',
          },
          requiresExplicitConfirm: true,
          estimatedUsd: 0,
          status: 'pending',
          patch: { patchKind: 'sync-preview', changedPathCount: changedCount },
        },
      ];
    }
  }
}
