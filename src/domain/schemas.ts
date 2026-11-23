import { z } from 'zod';

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
});
export type GenerationMeta = z.infer<typeof GenerationMetaSchema>;

export const SpriteNodeSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  kind: SpriteNodeKindSchema,
  imageBlobId: z.string().min(1),
  maskBlobId: z.string().min(1).optional(),
  sketchSha256: z.string().regex(/^[0-9a-f]{64}$/, 'sketchSha256 must be a 64-char hex SHA-256'),
  generationMeta: GenerationMetaSchema,
});
export type SpriteNode = z.infer<typeof SpriteNodeSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().trim().min(1, 'Project name is required').max(120),
  artBible: ArtBibleSchema,
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

export const ProviderKindSchema = z.enum(['mock', 'openai-compatible', 'comfyui', 'custom-http']);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const ProviderConfigSchema = z.object({
  id: z.string().min(1),
  kind: ProviderKindSchema,
  displayName: z.string().trim().min(1),
  modelId: z.string().trim().min(1),
  endpointUrl: z.string(),
  apiKey: z.string(),
  enabled: z.boolean(),
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
