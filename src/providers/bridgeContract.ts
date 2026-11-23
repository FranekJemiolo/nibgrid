import { z } from 'zod';

export const DEFAULT_ANTIGRAVITY_BRIDGE_URL = 'http://127.0.0.1:4188';
export const BRIDGE_MIN_TTL_MS = 60_000;

export const BridgeHealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string().min(1),
  models: z.array(z.string().min(1)).default([]),
  supportsStatefulInteractions: z.boolean().default(true),
});
export type BridgeHealthResponse = z.infer<typeof BridgeHealthResponseSchema>;

export const BridgeGenerateRequestSchema = z.object({
  requestId: z.string().min(1),
  modelId: z.string().min(1),
  previousInteractionId: z.string().min(1).optional(),
  compiledPrompt: z.string(),
  promptDelta: z.string(),
  negativePrompt: z.string(),
  adherence: z.enum(['strict', 'balanced', 'loose']),
  variants: z.union([z.literal(1), z.literal(2)]),
  sketchPngBase64: z.string().optional(),
  goldenRefsPngBase64: z.array(z.string()).optional(),
  maskPngBase64: z.string().optional(),
  artBibleSnapshot: z.object({
    projection: z.string(),
    lighting: z.string(),
    artMode: z.enum(['pixel-art', 'hd-2d']),
    palette: z.array(z.string()),
  }),
});
export type BridgeGenerateRequest = z.infer<typeof BridgeGenerateRequestSchema>;

export const BridgeImageVariantSchema = z.object({
  pngBase64: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  interactionId: z.string().min(1),
  interactionExpiresAt: z.string().min(1),
  modelId: z.string().min(1),
});
export type BridgeImageVariant = z.infer<typeof BridgeImageVariantSchema>;

export const BridgeGenerateResponseSchema = z.object({
  requestId: z.string().min(1),
  variants: z.array(BridgeImageVariantSchema).min(1),
  usedStatefulChain: z.boolean(),
  latencyMs: z.number().nonnegative().default(0),
});
export type BridgeGenerateResponse = z.infer<typeof BridgeGenerateResponseSchema>;

export const BridgeDriftFlagSchema = z.enum([
  'projection_drift',
  'lighting_mismatch',
  'palette_violation',
  'background_not_flat',
  'cropped_silhouette',
]);
export type BridgeDriftFlag = z.infer<typeof BridgeDriftFlagSchema>;

export const BridgeCritiqueResponseSchema = z.object({
  passed: z.boolean(),
  score: z.number().min(0).max(100),
  driftFlags: z.array(BridgeDriftFlagSchema),
  suggestedPromptDelta: z.string(),
  rationale: z.string(),
});
export type BridgeCritiqueResponse = z.infer<typeof BridgeCritiqueResponseSchema>;
