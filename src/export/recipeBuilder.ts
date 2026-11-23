import { z } from 'zod';
import {
  AdherenceSchema,
  AnimPresetSchema,
  ArtModeSchema,
  BevelProfileSchema,
  DimensionSchema,
  HexColorSchema,
  LightingSchema,
  MlsModeSchema,
  NineSliceConfigSchema,
  NormalConventionSchema,
  PaletteLutConfigSchema,
  PivotNormSchema,
  PostProcessConfigSchema,
  ProjectionSchema,
  PuppetPinSchema,
  SeamlessTileConfigSchema,
  type NineSliceConfig,
  type NormalMapConfig,
  type PaletteLutConfig,
  type PostProcessConfig,
  type Project,
  type PuppetAnimConfig,
  type SeamlessTileConfig,
  type SpriteNode,
} from '../domain/schemas';

export const RECIPE_SCHEMA_VERSION = '1.0.0' as const;

export const PivotPxSchema = z.object({
  x: z.number().int().min(0),
  y: z.number().int().min(0),
});
export type PivotPx = z.infer<typeof PivotPxSchema>;

export const AssetRecipeSchema = z.object({
  schemaVersion: z.literal(RECIPE_SCHEMA_VERSION),
  exportedAt: z.string().min(1),
  app: z.literal('nibgrid'),
  project: z.object({
    id: z.string().min(1),
    name: z.string().min(1),
  }),
  artBible: z.object({
    projection: ProjectionSchema,
    lighting: LightingSchema,
    artMode: ArtModeSchema,
    targetWidth: DimensionSchema,
    targetHeight: DimensionSchema,
    palette: z.array(HexColorSchema).max(64),
    stylePrompt: z.string(),
    negativePrompt: z.string(),
  }),
  source: z.object({
    sketchSha256: z.string().regex(/^[0-9a-f]{64}$/),
    normalizedWidth: z.number().int().positive(),
    normalizedHeight: z.number().int().positive(),
  }),
  generation: z.object({
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    seed: z.number().int().min(0),
    adherence: AdherenceSchema,
    promptDelta: z.string(),
    compiledPrompt: z.string(),
    parentNodeId: z.string().nullable(),
  }),
  postProcess: PostProcessConfigSchema,
  output: z.object({
    filename: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    pivotPx: PivotPxSchema,
    pivotNorm: PivotNormSchema,
  }),
  normalMap: z
    .object({
      enabled: z.boolean(),
      filename: z.string().min(1),
      bevelRadiusPx: z.number().int().min(1).max(64),
      bevelProfile: BevelProfileSchema,
      bevelStrength: z.number().min(0).max(10),
      detailStrength: z.number().min(0).max(10),
      convention: NormalConventionSchema,
    })
    .optional(),
  puppetAnim: z
    .object({
      preset: AnimPresetSchema,
      mode: MlsModeSchema,
      frameCount: z.number().int().min(2).max(24),
      amplitudePx: z.number().min(0.5).max(24),
      fps: z.number().int().min(1).max(30),
      loop: z.boolean(),
      pingPong: z.boolean(),
      paddingPx: z.number().int().min(0).max(32),
      reLockPolish: z.boolean(),
      stripFilename: z.string().min(1),
      atlasJsonFilename: z.string().min(1),
      pins: z.array(PuppetPinSchema),
    })
    .optional(),
  seamlessTile: SeamlessTileConfigSchema.optional(),
  nineSlice: NineSliceConfigSchema.optional(),
  paletteLut: PaletteLutConfigSchema.optional(),
});

export type AssetRecipe = z.infer<typeof AssetRecipeSchema>;

export function computePivotPx(
  pivotNorm: { x: number; y: number },
  width: number,
  height: number,
): PivotPx {
  return {
    x: Math.max(0, Math.min(width, Math.round(pivotNorm.x * width))),
    y: Math.max(0, Math.min(height, Math.round(pivotNorm.y * height))),
  };
}

export interface BuildAssetRecipeInput {
  project: Project;
  node: SpriteNode;
  postProcess: PostProcessConfig;
  filename: string;
  outputWidth: number;
  outputHeight: number;
  normalizedWidth?: number;
  normalizedHeight?: number;
  exportedAt?: string;
  normalMap?: NormalMapConfig & { filename: string };
  puppetAnim?: PuppetAnimConfig & { stripFilename: string; atlasJsonFilename: string };
  seamlessTile?: SeamlessTileConfig;
  nineSlice?: NineSliceConfig;
  paletteLut?: PaletteLutConfig;
}

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{8,}/,
  /sk-[0-9A-Za-z_-]{12,}/,
  /nbg_[0-9A-Za-z_-]{6,}/,
  /"apiKey"\s*:/i,
];

/**
 * Builds and strictly validates `asset.recipe.json` (v1.0.0) without ever including
 * API keys, endpoint credentials, or secrets.
 */
export function buildAssetRecipe(input: BuildAssetRecipeInput): AssetRecipe {
  const { project, node, postProcess, filename, outputWidth, outputHeight } = input;
  const pivotPx = computePivotPx(postProcess.pivotNorm, outputWidth, outputHeight);

  const recipe = AssetRecipeSchema.parse({
    schemaVersion: RECIPE_SCHEMA_VERSION,
    exportedAt: input.exportedAt ?? new Date().toISOString(),
    app: 'nibgrid',
    project: {
      id: project.id,
      name: project.name,
    },
    artBible: {
      projection: project.artBible.projection,
      lighting: project.artBible.lighting,
      artMode: project.artBible.artMode,
      targetWidth: project.artBible.targetWidth,
      targetHeight: project.artBible.targetHeight,
      palette: [...project.artBible.palette],
      stylePrompt: project.artBible.stylePrompt,
      negativePrompt: project.artBible.negativePrompt,
    },
    source: {
      sketchSha256: node.sketchSha256,
      normalizedWidth: input.normalizedWidth ?? project.artBible.targetWidth,
      normalizedHeight: input.normalizedHeight ?? project.artBible.targetHeight,
    },
    generation: {
      providerId: node.generationMeta.providerId,
      modelId: node.generationMeta.modelId,
      seed: node.generationMeta.seed,
      adherence: node.generationMeta.adherence,
      promptDelta: node.generationMeta.promptDelta,
      compiledPrompt: node.generationMeta.compiledPrompt,
      parentNodeId: node.parentId,
    },
    postProcess: PostProcessConfigSchema.parse(postProcess),
    output: {
      filename,
      width: outputWidth,
      height: outputHeight,
      pivotPx,
      pivotNorm: {
        x: postProcess.pivotNorm.x,
        y: postProcess.pivotNorm.y,
      },
    },
    ...(input.normalMap?.enabled ? { normalMap: input.normalMap } : {}),
    ...(input.puppetAnim && input.puppetAnim.pins.length > 0
      ? { puppetAnim: input.puppetAnim }
      : {}),
    ...(input.seamlessTile?.isSeamlessTile || node.seamlessTile?.isSeamlessTile
      ? { seamlessTile: input.seamlessTile ?? node.seamlessTile }
      : {}),
    ...(input.nineSlice?.enabled || node.nineSlice?.enabled
      ? { nineSlice: input.nineSlice ?? node.nineSlice }
      : {}),
    ...(input.paletteLut || node.paletteLut
      ? { paletteLut: input.paletteLut ?? node.paletteLut }
      : {}),
  });

  const serialized = JSON.stringify(recipe);
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (pattern.test(serialized)) {
      throw new Error('Refusing to serialize recipe containing sensitive key material.');
    }
  }

  return recipe;
}
