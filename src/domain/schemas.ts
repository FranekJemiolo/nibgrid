import { z } from 'zod';
import { ContourTimbrePatchSchema } from '../audio/contourPatchSchema';
import { extractDefaultUniformValues, getGdShaderPreset } from '../processing/gdshaderPresets';
import {
  ParallaxBandBlueprintSchema,
  ParallaxBandRoleSchema,
  ParallaxSceneBlueprintSchema,
  type ParallaxBandBlueprint,
  type ParallaxBandRole,
  type ParallaxSceneBlueprint,
} from '../processing/parallaxBlueprint';

export {
  ParallaxBandBlueprintSchema,
  ParallaxBandRoleSchema,
  ParallaxSceneBlueprintSchema,
  type ParallaxBandBlueprint,
  type ParallaxBandRole,
  type ParallaxSceneBlueprint,
};

export const DEFAULT_NEGATIVE_PROMPT = 'drop shadow, floor plane, busy background, text, watermark';

export const HexColorSchema = z
  .string()
  .regex(/^#[0-9A-F]{6}$/, 'Color must be a normalized uppercase #RRGGBB hex string');

export const ProjectionSchema = z.enum(['top-down', 'isometric', 'side-scroller', 'three-quarter']);
export type Projection = z.infer<typeof ProjectionSchema>;

export const LightingSchema = z.enum(['top-left', 'top-right', 'overhead', 'flat']);
export type Lighting = z.infer<typeof LightingSchema>;

export const ArtModeSchema = z.enum(['pixel-art', 'hd-2d']);
export type ArtMode = z.infer<typeof ArtModeSchema>;

export const AdherenceSchema = z.enum(['strict', 'balanced', 'loose']);
export type AdherenceLevel = z.infer<typeof AdherenceSchema>;

export const DimensionSchema = z
  .number()
  .int('Dimension must be an integer')
  .min(16, 'Dimension must be at least 16px')
  .max(2048, 'Dimension must be at most 2048px');

export const ArtBibleSchema = z.object({
  projection: ProjectionSchema,
  lighting: LightingSchema,
  artMode: ArtModeSchema,
  targetWidth: DimensionSchema,
  targetHeight: DimensionSchema,
  palette: z.array(HexColorSchema).max(64, 'Palette supports at most 64 colors'),
  goldenReferenceBlobIds: z
    .array(z.string().min(1))
    .max(3, 'At most 3 Golden Reference images are allowed'),
  stylePrompt: z.string(),
  negativePrompt: z.string().default(DEFAULT_NEGATIVE_PROMPT),
});
export type ArtBible = z.infer<typeof ArtBibleSchema>;

export const SpriteNodeKindSchema = z.enum(['sketch', 'generation', 'inpaint']);
export type SpriteNodeKind = z.infer<typeof SpriteNodeKindSchema>;

export const GenerationMetaSchema = z.object({
  providerId: z.string().min(1),
  modelId: z.string().min(1),
  seed: z.number().int().min(0),
  adherence: AdherenceSchema,
  promptDelta: z.string(),
  compiledPrompt: z.string(),
  createdAt: z.string().min(1),
  interactionId: z.string().min(1).optional(),
  parentInteractionId: z.string().min(1).optional(),
  interactionExpiresAt: z.string().min(1).optional(),
  usedStatefulChain: z.boolean().optional(),
});
export type GenerationMeta = z.infer<typeof GenerationMetaSchema>;

export const BackgroundRemovalModeSchema = z.enum(['none', 'color-key', 'ai-rembg']);
export type BackgroundRemovalMode = z.infer<typeof BackgroundRemovalModeSchema>;

export const ResampleModeSchema = z.enum(['nearest', 'area']);
export type ResampleMode = z.infer<typeof ResampleModeSchema>;

export const ErosionConnectivitySchema = z.enum(['4-connected', '8-connected']);
export type ErosionConnectivity = z.infer<typeof ErosionConnectivitySchema>;

export const PivotNormSchema = z.object({
  x: z.number().min(0).max(1),
  y: z.number().min(0).max(1),
});
export type PivotNorm = z.infer<typeof PivotNormSchema>;

export const BevelProfileSchema = z.enum(['spherical-dome', 'smoothstep', 'linear']);
export type BevelProfileOption = z.infer<typeof BevelProfileSchema>;

export const NormalConventionSchema = z.enum(['opengl', 'directx']);
export type NormalConventionOption = z.infer<typeof NormalConventionSchema>;

export const NormalMapConfigSchema = z.object({
  enabled: z.boolean().default(false),
  bevelRadiusPx: z.number().int().min(1).max(64).default(16),
  bevelProfile: BevelProfileSchema.default('spherical-dome'),
  bevelStrength: z.number().min(0).max(10).default(2.5),
  detailStrength: z.number().min(0).max(10).default(1.2),
  convention: NormalConventionSchema.default('opengl'),
});
export type NormalMapConfig = z.infer<typeof NormalMapConfigSchema>;

export function createDefaultNormalMapConfig(): NormalMapConfig {
  return NormalMapConfigSchema.parse({});
}

export const PinRoleSchema = z.enum(['anchor', 'driver', 'tip']);
export type PinRoleOption = z.infer<typeof PinRoleSchema>;

export const MlsModeSchema = z.enum(['rigid', 'similarity']);
export type MlsModeOption = z.infer<typeof MlsModeSchema>;

export const AnimPresetSchema = z.enum([
  'idle-breathe',
  'wind-sway',
  'hit-recoil',
  'squash-stretch',
]);
export type AnimPresetOption = z.infer<typeof AnimPresetSchema>;

export const PuppetPinSchema = z.object({
  id: z.string().min(1),
  x: z.number(),
  y: z.number(),
  role: PinRoleSchema,
  label: z.string().optional(),
});
export type PuppetPinConfig = z.infer<typeof PuppetPinSchema>;

export const PuppetAnimConfigSchema = z.object({
  preset: AnimPresetSchema.default('idle-breathe'),
  mode: MlsModeSchema.default('rigid'),
  frameCount: z.number().int().min(2).max(24).default(6),
  amplitudePx: z.number().min(0.5).max(24).default(3),
  fps: z.number().int().min(1).max(30).default(8),
  loop: z.boolean().default(true),
  pingPong: z.boolean().default(false),
  paddingPx: z.number().int().min(0).max(32).default(8),
  reLockPolish: z.boolean().default(false),
  pins: z.array(PuppetPinSchema).default([]),
});
export type PuppetAnimConfig = z.infer<typeof PuppetAnimConfigSchema>;

export function createDefaultPuppetAnimConfig(): PuppetAnimConfig {
  return PuppetAnimConfigSchema.parse({});
}

export const SeamlessTileConfigSchema = z.object({
  isSeamlessTile: z.boolean().default(false),
  tileX: z.boolean().default(true),
  tileY: z.boolean().default(true),
  seamWidthPx: z.number().int().min(16).max(96).default(28),
  jitterPx: z.number().int().min(0).max(12).default(4),
  flattenEnabled: z.boolean().default(false),
  flattenRadiusPx: z.number().int().min(4).max(32).default(12),
  wrappedPendingUnwrap: z.boolean().default(false),
  continuityScore: z.number().min(0).max(100).optional(),
});
export type SeamlessTileConfig = z.infer<typeof SeamlessTileConfigSchema>;

export function createDefaultSeamlessTileConfig(): SeamlessTileConfig {
  return SeamlessTileConfigSchema.parse({});
}

export const NineSliceFillModeSchema = z.enum(['stretch', 'tile']);
export type NineSliceFillMode = z.infer<typeof NineSliceFillModeSchema>;

export const NineSliceCenterModeSchema = z.enum(['stretch', 'tile', 'transparent']);
export type NineSliceCenterMode = z.infer<typeof NineSliceCenterModeSchema>;

export const NineSliceConfigSchema = z.object({
  enabled: z.boolean().default(false),
  left: z.number().int().min(0).max(512).default(8),
  right: z.number().int().min(0).max(512).default(8),
  top: z.number().int().min(0).max(512).default(8),
  bottom: z.number().int().min(0).max(512).default(8),
  edgeMode: NineSliceFillModeSchema.default('stretch'),
  centerMode: NineSliceCenterModeSchema.default('stretch'),
  lockHorizontal: z.boolean().default(false),
  lockVertical: z.boolean().default(false),
});
export type NineSliceConfig = z.infer<typeof NineSliceConfigSchema>;

export function createDefaultNineSliceConfig(): NineSliceConfig {
  return NineSliceConfigSchema.parse({});
}

export const RampTransformSchema = z.object({
  rampId: z.string().min(1),
  hueShiftDeg: z.number().min(-180).max(180).default(0),
  chromaScale: z.number().min(0).max(2).default(1),
  lightnessShift: z.number().min(-0.4).max(0.4).default(0),
  temperatureShift: z.number().min(-0.05).max(0.05).default(0),
});
export type RampTransformConfig = z.infer<typeof RampTransformSchema>;

export const PaletteVariantRecipeSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rampTransforms: z.array(RampTransformSchema),
  overrides: z.record(z.string(), HexColorSchema).default({}),
});
export type PaletteVariantRecipe = z.infer<typeof PaletteVariantRecipeSchema>;

export const PaletteLutConfigSchema = z.object({
  mode: z.enum(['stacked', 'single']).default('stacked'),
  paletteSize: z.number().int().min(1).max(256).default(1),
  variantCount: z.number().int().min(1).max(32).default(1),
  idxFilename: z.string().min(1).optional(),
  lutFilename: z.string().min(1).optional(),
  variants: z.array(PaletteVariantRecipeSchema).default([]),
});
export type PaletteLutConfig = z.infer<typeof PaletteLutConfigSchema>;

export function createDefaultPaletteLutConfig(): PaletteLutConfig {
  return PaletteLutConfigSchema.parse({});
}

export const OscShapeSchema = z.enum(['sine', 'triangle', 'sawtooth', 'square']);

export const ProceduralSfxParamsSchema = z.object({
  seed: z.number().int().min(0).max(0xffffffff),
  durationSec: z.number().min(0.05).max(4.0),
  sampleRate: z.number().int().min(8000).max(96000).optional(),
  transientGain: z.number().min(0).max(1),
  transientDecayMs: z.number().min(2).max(40),
  transientFreqHz: z.number().min(80).max(4000),
  bodyGain: z.number().min(0).max(1),
  bodyShape: OscShapeSchema,
  bodyStartHz: z.number().min(20).max(2400),
  bodyEndHz: z.number().min(20).max(2400),
  bodyAttackMs: z.number().min(0).max(50),
  bodyDecayMs: z.number().min(15).max(2000),
  fmRatio: z.number().min(0).max(8),
  fmDepth: z.number().min(0).max(600),
  noiseGain: z.number().min(0).max(1),
  noiseDecayMs: z.number().min(15).max(2500),
  filterStartHz: z.number().min(100).max(14000),
  filterEndHz: z.number().min(80).max(12000),
  filterQ: z.number().min(0.5).max(8.0),
  bitDepth: z.number().int().min(4).max(16),
  drive: z.number().min(1.0).max(6.0),
});

export const AudioPostProcessConfigSchema = z.object({
  trimSilence: z.boolean().default(true),
  silenceThresholdDb: z.number().min(-80).max(-12).default(-48),
  fadeInMs: z.number().min(0).max(100).default(2),
  fadeOutMs: z.number().min(0).max(250).default(8),
  normalizeLufs: z.boolean().default(true),
  targetLufs: z.number().min(-32).max(-6).default(-14),
  ceilingDb: z.number().min(-6).max(0).default(-1.0),
  seamlessLoop: z.boolean().default(false),
  loopCrossfadeMs: z.number().min(10).max(1000).default(120),
  cropStartSec: z.number().min(0).default(0),
  cropEndSec: z.number().min(0).default(0),
  pitchShiftPercent: z.number().min(-50).max(50).optional(),
});

export function createDefaultAudioPostProcessConfig() {
  return AudioPostProcessConfigSchema.parse({});
}

export const GoogleAudioRouteSchema = z.enum([
  'lyria-clip',
  'lyria-full',
  'gemini-tts',
  'gemini-to-synth',
  'local-synth',
]);

export const AudioCategorySchema = z.enum(['sfx', 'ui', 'ambience', 'music', 'voice']);

export const AudioBindingsSchema = z.object({
  hitSfxId: z.string().min(1).optional(),
  stepSfxId: z.string().min(1).optional(),
  bgmLoopId: z.string().min(1).optional(),
  uiClickSfxId: z.string().min(1).optional(),
  frameSfxMap: z.record(z.string(), z.string().min(1)).optional(),
});
export type AudioBindings = z.infer<typeof AudioBindingsSchema>;

export const AudioSketchMetaSchema = z.object({
  sketchSha256: z.string().regex(/^[0-9a-f]{64}$/),
  durationSec: z.number().min(0),
  humRoute: z.string().min(1),
  contourPatch: ContourTimbrePatchSchema.optional(),
  detectedBpm: z.number().optional(),
  dominantKey: z.string().optional(),
});
export type AudioSketchMeta = z.infer<typeof AudioSketchMetaSchema>;

export const AudioAssetSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  presetId: z.string().min(1),
  route: GoogleAudioRouteSchema,
  modelId: z.string().min(1),
  wavBlobId: z.string().min(1),
  variationBlobIds: z.array(z.string().min(1)).default([]),
  synthParams: ProceduralSfxParamsSchema.optional(),
  audioSketch: AudioSketchMetaSchema.optional(),
  postProcess: AudioPostProcessConfigSchema,
  lufs: z.number(),
  durationSec: z.number().min(0),
  createdAt: z.string().min(1),
});
export type AudioAsset = z.infer<typeof AudioAssetSchema>;

export const DemixelModeSchema = z.enum(['auto', 'manual']);
export type DemixelMode = z.infer<typeof DemixelModeSchema>;

export const SelOutModeSchema = z.enum(['off', 'outer', 'inner']);
export type SelOutMode = z.infer<typeof SelOutModeSchema>;

export const PostProcessConfigSchema = z.object({
  bgRemoval: BackgroundRemovalModeSchema,
  bgTolerance: z.number().min(0).max(100),
  bgContiguous: z.boolean(),
  bgKeyColor: HexColorSchema.optional(),
  alphaThreshold: z.number().int().min(0).max(255),
  erosionRadius: z.number().int().min(0).max(2),
  erosionConnectivity: ErosionConnectivitySchema,
  defringe: z.boolean(),
  paletteSnap: z.boolean(),
  bayerDither: z.boolean(),
  ditherStrength: z.number().min(0).max(1),
  resampleEnabled: z.boolean(),
  resampleMode: ResampleModeSchema,
  targetWidth: DimensionSchema,
  targetHeight: DimensionSchema,
  autoTrim: z.boolean(),
  trimMargin: z.number().int().min(0).max(64),
  padToPot: z.boolean(),
  pivotNorm: PivotNormSchema,
  // M7: Pixel-Art Foundry (defaults keep M0-M6 behavior 100% preserved)
  demixelEnabled: z.boolean().default(false),
  demixelMode: DemixelModeSchema.default('auto'),
  demixelCellSize: z.number().int().min(1).max(32).default(4),
  orphanCleanEnabled: z.boolean().default(false),
  maxIslandPixels: z.number().int().min(1).max(16).default(2),
  removeInteriorSpecks: z.boolean().default(true),
  selOutMode: SelOutModeSchema.default('off'),
  selOutLighting: LightingSchema.default('top-left'),
  selOutLitDarken: z.number().min(0).max(0.8).default(0.16),
  selOutShadowDarken: z.number().min(0).max(0.8).default(0.36),
  selOutSnapToPalette: z.boolean().default(true),
});
export type PostProcessConfig = z.infer<typeof PostProcessConfigSchema>;

export function createDefaultPostProcessConfig(
  targetWidth = 64,
  targetHeight = 64,
): PostProcessConfig {
  return PostProcessConfigSchema.parse({
    bgRemoval: 'none',
    bgTolerance: 24,
    bgContiguous: true,
    alphaThreshold: 16,
    erosionRadius: 0,
    erosionConnectivity: '4-connected',
    defringe: false,
    paletteSnap: false,
    bayerDither: false,
    ditherStrength: 0.35,
    resampleEnabled: false,
    resampleMode: 'nearest',
    targetWidth,
    targetHeight,
    autoTrim: false,
    trimMargin: 0,
    padToPot: false,
    pivotNorm: { x: 0.5, y: 0.5 },
    demixelEnabled: false,
    demixelMode: 'auto',
    demixelCellSize: 4,
    orphanCleanEnabled: false,
    maxIslandPixels: 2,
    removeInteriorSpecks: true,
    selOutMode: 'off',
    selOutLighting: 'top-left',
    selOutLitDarken: 0.16,
    selOutShadowDarken: 0.36,
    selOutSnapToPalette: true,
  });
}

export const ColliderLayerSchema = z.enum(['collider', 'hurtbox', 'hitbox']);
export type ColliderLayer = z.infer<typeof ColliderLayerSchema>;

export const ColliderKindSchema = z.enum(['polygon', 'convex-hull', 'aabb', 'capsule']);
export type ColliderKind = z.infer<typeof ColliderKindSchema>;

export const ColliderVec2Schema = z.object({
  x: z.number(),
  y: z.number(),
});

export const CapsuleShapeSchema = z.object({
  cx: z.number(),
  cy: z.number(),
  radius: z.number().min(0),
  height: z.number().min(0),
  orientation: z.enum(['vertical', 'horizontal']),
});

export const CollisionLayerShapeSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  layer: ColliderLayerSchema,
  kind: ColliderKindSchema,
  isSensor: z.boolean(),
  visible: z.boolean().default(true),
  vertices: z.array(ColliderVec2Schema),
  capsule: CapsuleShapeSchema.optional(),
  activeFrames: z.array(z.number().int().min(0)).optional(),
  autoTraceMeta: z
    .object({
      epsilonPx: z.number().min(0.1).max(32),
      maxVertices: z.number().int().min(3).max(128).optional(),
    })
    .optional(),
});
export type CollisionLayerShape = z.infer<typeof CollisionLayerShapeSchema>;

export const TurnaroundLayoutSchema = z.enum(['2x2', '1x4']);
export type TurnaroundLayout = z.infer<typeof TurnaroundLayoutSchema>;

export const CardinalDirectionSchema = z.enum(['south', 'east', 'north', 'west']);
export type CardinalDirection = z.infer<typeof CardinalDirectionSchema>;

export const TurnaroundMetaSchema = z.object({
  isTurnaroundSheet: z.boolean().optional(),
  turnaroundLayout: TurnaroundLayoutSchema.optional(),
  directionGroupId: z.string().min(1).optional(),
  cardinalDirection: CardinalDirectionSchema.optional(),
  scaleApplied: z.number().positive().optional(),
  sharedPivotPx: z
    .object({
      x: z.number().int().min(0),
      y: z.number().int().min(0),
    })
    .optional(),
});
export type TurnaroundMeta = z.infer<typeof TurnaroundMetaSchema>;

export const AssetClassSchema = z.enum(['character', 'prop', 'tile', 'ui-panel', 'vfx']);
export type AssetClass = z.infer<typeof AssetClassSchema>;

export const AutoTileModeSchema = z.enum(['blob-47', 'wang-16']);
export type AutoTileMode = z.infer<typeof AutoTileModeSchema>;

export const AutoTileEdgeStyleSchema = z.enum(['crisp-bevel', 'organic-overhang', 'pixel-outline']);
export type AutoTileEdgeStyle = z.infer<typeof AutoTileEdgeStyleSchema>;

export const AutoTileConfigSchema = z.object({
  mode: AutoTileModeSchema.default('blob-47'),
  edgeStyle: AutoTileEdgeStyleSchema.default('organic-overhang'),
  borderWidthPx: z.number().min(0).max(32).default(3),
  cornerRadiusPx: z.number().min(0).max(32).default(4),
  jitterPx: z.number().min(0).max(16).default(1.5),
  edgeTintHex: HexColorSchema.default('#1A1C2C'),
  seed: z.number().int().min(0).max(0xffffffff).default(1337),
  underlayNodeId: z.string().min(1).optional(),
  sampleMapBits: z.string().optional(),
});
export type AutoTileConfig = z.infer<typeof AutoTileConfigSchema>;

export function createDefaultAutoTileConfig(): AutoTileConfig {
  return AutoTileConfigSchema.parse({});
}

export const SocketDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-z0-9_]+$/, 'Socket name must match ^[a-z0-9_]+$'),
  restPosPx: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
  }),
  baseAngleDeg: z.number().finite().min(-360).max(360).default(0),
  colorHex: HexColorSchema.optional(),
});
export type SocketDefinition = z.infer<typeof SocketDefinitionSchema>;

export const VfxArchetypeSchema = z.enum([
  'sparks',
  'dust-puff',
  'smoke',
  'hit-ring',
  'noise-dissolve',
]);
export type VfxArchetype = z.infer<typeof VfxArchetypeSchema>;

export const VfxFlipbookConfigSchema = z.object({
  archetype: VfxArchetypeSchema.default('sparks'),
  frameSizePx: z.number().int().min(8).max(256).default(64),
  cols: z.number().int().min(1).max(16).default(4),
  rows: z.number().int().min(1).max(16).default(4),
  seed: z.number().int().min(0).max(0xffffffff).default(101),
  spread: z.number().min(0.1).max(0.48).default(0.42),
  turbulence: z.number().min(0).max(1).default(0.35),
  fps: z.number().int().min(1).max(60).default(16),
  coreHex: HexColorSchema.default('#FFF3B0'),
  outerHex: HexColorSchema.default('#F97316'),
  useSourceSprite: z.boolean().default(true),
  snapToPalette: z.boolean().default(false),
});
export type VfxFlipbookConfig = z.infer<typeof VfxFlipbookConfigSchema>;

export function createDefaultVfxFlipbookConfig(): VfxFlipbookConfig {
  return VfxFlipbookConfigSchema.parse({});
}

export const ParallaxLayerSourceKindSchema = z.enum(['node', 'blob', 'ai-band']);
export type ParallaxLayerSourceKind = z.infer<typeof ParallaxLayerSourceKindSchema>;

export const ParallaxLayerConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1).max(80),
  role: ParallaxBandRoleSchema.optional(),
  sourceKind: ParallaxLayerSourceKindSchema,
  sourceNodeId: z.string().min(1).optional(),
  blobId: z.string().min(1).optional(),
  scrollRatioX: z.number().min(0.05).max(1.25).default(0.5),
  yOffsetPx: z.number().int().min(-512).max(512).default(0),
  seamBlendPx: z.number().int().min(0).max(64).default(24),
  depthHaze: z.number().min(0).max(1).default(0.25),
  visible: z.boolean().default(true),
  stripChromaKey: z.boolean().default(true),
  subjectPrompt: z.string().optional(),
});
export type ParallaxLayerConfig = z.infer<typeof ParallaxLayerConfigSchema>;

export const ParallaxSceneConfigSchema = z.object({
  viewportWidth: z.number().int().min(64).max(1024).default(320),
  viewportHeight: z.number().int().min(64).max(1024).default(180),
  skyTopHex: HexColorSchema.default('#1A1C2C'),
  horizonHex: HexColorSchema.default('#5D275D'),
  contrastDampening: z.number().min(0).max(1).default(0.35),
  cameraSpeedPxPerSec: z.number().min(-400).max(400).default(72),
  snapToPalette: z.boolean().default(false),
  showForegroundDummy: z.boolean().default(false),
  masterKeyframeBlobId: z.string().min(1).optional(),
  blueprint: ParallaxSceneBlueprintSchema.optional(),
  layers: z.array(ParallaxLayerConfigSchema).max(6).default([]),
});
export type ParallaxSceneConfig = z.infer<typeof ParallaxSceneConfigSchema>;

export function createDefaultParallaxSceneConfig(): ParallaxSceneConfig {
  return ParallaxSceneConfigSchema.parse({});
}

export const BitmapFontSourceKindSchema = z.enum(['builtin-5x7', 'custom-font']);
export type BitmapFontSourceKind = z.infer<typeof BitmapFontSourceKindSchema>;

export const BitmapFontCharsetPresetSchema = z.enum([
  'damage-numerals',
  'hud-upper',
  'ascii-basic',
  'custom',
]);
export type BitmapFontCharsetPreset = z.infer<typeof BitmapFontCharsetPresetSchema>;

export const BitmapFontOutlineModeSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type BitmapFontOutlineMode = z.infer<typeof BitmapFontOutlineModeSchema>;

export const BitmapFontConfigSchema = z.object({
  fontName: z.string().trim().min(1).max(64).default('nibgrid_damage'),
  sourceKind: BitmapFontSourceKindSchema.default('builtin-5x7'),
  customFontFamily: z.string().max(120).default('monospace'),
  rasterSizePx: z.number().int().min(10).max(48).default(16),
  charsetPreset: BitmapFontCharsetPresetSchema.default('damage-numerals'),
  customCharset: z.string().min(1).max(256).default('0123456789+-!%x.,CRITMS'),
  scale: z.number().int().min(1).max(4).default(2),
  topHex: HexColorSchema.default('#FFCD75'),
  bottomHex: HexColorSchema.default('#EF7D57'),
  snapToPalette: z.boolean().default(true),
  outlineMode: BitmapFontOutlineModeSchema.default(1),
  selOutDarken: z.number().min(0.1).max(0.9).default(0.55),
  useCustomOutline: z.boolean().default(false),
  outlineHex: HexColorSchema.default('#1A1C2C'),
  shadowOffsetX: z.number().int().min(-8).max(8).default(0),
  shadowOffsetY: z.number().int().min(-8).max(8).default(1),
  shadowHex: HexColorSchema.default('#1A1C2C'),
  shadowAlpha: z.number().int().min(0).max(255).default(180),
  letterSpacingPx: z.number().int().min(-4).max(16).default(1),
  paddingPx: z.number().int().min(1).max(16).default(2),
  previewText: z.string().max(160).default('-42  CRIT 128!  +15 HP'),
});
export type BitmapFontConfig = z.infer<typeof BitmapFontConfigSchema>;

export function createDefaultBitmapFontConfig(): BitmapFontConfig {
  return BitmapFontConfigSchema.parse({});
}

export const ShaderUniformValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.array(z.number()).min(2).max(4),
]);
export type ShaderUniformValue = z.infer<typeof ShaderUniformValueSchema>;

export const ShaderConfigSchema = z.object({
  presetId: z.string().min(1).max(64).default('hit_flash'),
  prompt: z.string().max(400).default(''),
  gdshaderSource: z
    .string()
    .min(1)
    .max(32000)
    .default(() => getGdShaderPreset('hit_flash').source),
  uniformValues: z
    .record(z.string(), ShaderUniformValueSchema)
    .default(() => extractDefaultUniformValues(getGdShaderPreset('hit_flash').source)),
  paused: z.boolean().default(false),
  timeScale: z.number().min(0).max(4).default(1),
});
export type ShaderConfig = z.infer<typeof ShaderConfigSchema>;

export function createDefaultShaderConfig(presetId = 'hit_flash'): ShaderConfig {
  const preset = getGdShaderPreset(presetId);
  return ShaderConfigSchema.parse({
    presetId: preset.id,
    prompt: '',
    gdshaderSource: preset.source,
    uniformValues: extractDefaultUniformValues(preset.source),
    paused: false,
    timeScale: 1,
  });
}

export const SpriteNodeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  kind: SpriteNodeKindSchema,
  assetClass: AssetClassSchema.optional(),
  autoTile: AutoTileConfigSchema.optional(),
  sockets: z.array(SocketDefinitionSchema).optional(),
  vfxFlipbook: VfxFlipbookConfigSchema.optional(),
  parallaxScene: ParallaxSceneConfigSchema.optional(),
  bitmapFont: BitmapFontConfigSchema.optional(),
  shaderConfig: ShaderConfigSchema.optional(),
  imageBlobId: z.string().min(1),
  maskBlobId: z.string().min(1).optional(),
  processedBlobId: z.string().min(1).optional(),
  postProcessConfig: PostProcessConfigSchema.optional(),
  puppetAnim: PuppetAnimConfigSchema.optional(),
  seamlessTile: SeamlessTileConfigSchema.optional(),
  nineSlice: NineSliceConfigSchema.optional(),
  paletteLut: PaletteLutConfigSchema.optional(),
  audioBindings: AudioBindingsSchema.optional(),
  collisionShapes: z.array(CollisionLayerShapeSchema).optional(),
  recipeArtBibleHash: z.string().min(1).optional(),
  turnaroundMeta: TurnaroundMetaSchema.optional(),
  sketchSha256: z.string().regex(/^[0-9a-f]{64}$/, 'sketchSha256 must be a 64-char hex SHA-256'),
  generationMeta: GenerationMetaSchema,
});
export type SpriteNode = z.infer<typeof SpriteNodeSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, 'Project name is required').max(120),
  artBible: ArtBibleSchema,
  audioBindings: AudioBindingsSchema.optional(),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

export const BlobRecordSchema = z.object({
  id: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.custom<Blob>((val) => typeof Blob !== 'undefined' && val instanceof Blob, {
    message: 'bytes must be a Blob instance',
  }),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string().min(1),
});
export type BlobRecord = z.infer<typeof BlobRecordSchema>;

export const ProviderCapabilitiesSchema = z.object({
  supportsInpaint: z.boolean(),
  supportsMultiRef: z.boolean(),
  supportsSeed: z.boolean(),
  isLocal: z.boolean(),
});
export type ProviderCapabilities = z.infer<typeof ProviderCapabilitiesSchema>;

export const ProviderKindSchema = z.enum([
  'mock',
  'antigravity-agent',
  'antigravity-bridge',
  'gemini',
  'comfyui',
  'openai-compatible',
  'custom-http',
]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: ProviderKindSchema,
  displayName: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  endpointUrl: z.string(),
  apiKey: z.string(),
  enabled: z.boolean(),
  customWorkflowJson: z.string().optional(),
  capabilities: ProviderCapabilitiesSchema,
  updatedAt: z.string().min(1),
});
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export function createDefaultArtBible(): ArtBible {
  return ArtBibleSchema.parse({
    projection: 'three-quarter',
    lighting: 'top-left',
    artMode: 'pixel-art',
    targetWidth: 128,
    targetHeight: 128,
    palette: ['#1A1C2C', '#5D275D', '#B13E53', '#EF7D57', '#FFCD75', '#F4F4F4'],
    goldenReferenceBlobIds: [],
    stylePrompt: 'crisp 2D game sprite, clean silhouettes, cohesive shading',
    negativePrompt: DEFAULT_NEGATIVE_PROMPT,
  });
}
