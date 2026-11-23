import { strToU8, zipSync } from 'fflate';
import { z } from 'zod';
import type { AudioVariationArtifact } from '../audio/variations';
import {
  AudioPostProcessConfigSchema,
  GoogleAudioRouteSchema,
  ProceduralSfxParamsSchema,
} from '../domain/schemas';
import { redactSecrets } from '../providers/errors';
import type { AudioPostProcessConfig, GoogleAudioRoute, ProceduralSfxParams } from '../audio/types';

export const AudioRecipeSchema = z.object({
  schemaVersion: z.literal('1.0.0'),
  exportedAt: z.string().min(1),
  assetName: z.string().min(1),
  presetId: z.string().min(1),
  route: GoogleAudioRouteSchema,
  modelId: z.string().min(1),
  promptOrScript: z.string(),
  synthParams: ProceduralSfxParamsSchema.optional(),
  postProcess: AudioPostProcessConfigSchema,
  variationCount: z.number().int().min(1).max(6),
  sampleRate: z.number().int().min(8000),
  durationSec: z.number().min(0),
  outputLufs: z.number(),
  peakDb: z.number(),
  files: z.array(z.string().min(1)).min(1),
});
export type AudioRecipe = z.infer<typeof AudioRecipeSchema>;

const SECRET_LEAK_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{8,}/,
  /sk-[0-9A-Za-z_-]{12,}/,
  /xi_[0-9A-Za-z_-]{8,}/,
  /nbg_[0-9A-Za-z_-]{6,}/,
];

export function buildAudioRecipe(input: {
  readonly slug: string;
  readonly assetName: string;
  readonly presetId: string;
  readonly route: GoogleAudioRoute;
  readonly modelId: string;
  readonly promptOrScript: string;
  readonly synthParams?: ProceduralSfxParams;
  readonly postProcess: AudioPostProcessConfig;
  readonly variations: readonly AudioVariationArtifact[];
  readonly secretsToRedact?: readonly (string | undefined)[];
}): AudioRecipe {
  const first = input.variations[0];
  const sampleRate = first?.buffer.sampleRate ?? 44100;
  const totalFrames = first ? Math.floor(first.buffer.samples.length / first.buffer.channels) : 0;
  const durationSec = Number((totalFrames / Math.max(1, sampleRate)).toFixed(4));
  const files = input.variations.map((v) => `${input.slug}${v.filenameSuffix}`);
  const cleanPrompt = redactSecrets(input.promptOrScript, input.secretsToRedact);

  const rawRecipe: AudioRecipe = {
    schemaVersion: '1.0.0',
    exportedAt: new Date().toISOString(),
    assetName: input.assetName,
    presetId: input.presetId,
    route: input.route,
    modelId: input.modelId,
    promptOrScript: cleanPrompt,
    ...(input.synthParams ? { synthParams: input.synthParams } : {}),
    postProcess: input.postProcess,
    variationCount: input.variations.length,
    sampleRate,
    durationSec,
    outputLufs:
      first && Number.isFinite(first.outputLufs) ? Number(first.outputLufs.toFixed(2)) : -60,
    peakDb: first && Number.isFinite(first.peakDb) ? Number(first.peakDb.toFixed(2)) : -60,
    files,
  };

  const validated = AudioRecipeSchema.parse(rawRecipe);
  const serialized = JSON.stringify(validated);
  for (const pat of SECRET_LEAK_PATTERNS) {
    if (pat.test(serialized)) {
      throw new Error('Security Error: API key or token detected inside audio.recipe.json.');
    }
  }
  return validated;
}

export function packageAudioZip(input: {
  readonly slug: string;
  readonly variations: readonly AudioVariationArtifact[];
  readonly recipe: AudioRecipe;
}): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const v of input.variations) {
    entries[`${input.slug}${v.filenameSuffix}`] = v.wavBytes;
  }
  entries[`${input.slug}.audio.recipe.json`] = strToU8(
    `${JSON.stringify(input.recipe, null, 2)}\n`,
  );
  return zipSync(entries, { level: 6 });
}
