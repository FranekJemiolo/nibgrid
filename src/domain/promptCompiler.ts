import {
  DEFAULT_NEGATIVE_PROMPT,
  type AdherenceLevel,
  type ArtBible,
  type ArtMode,
  type Lighting,
  type Projection,
} from './schemas';

export interface CompilePromptOptions {
  adherence: AdherenceLevel;
  promptDelta: string;
}

export interface CompiledPromptResult {
  positivePrompt: string;
  negativePrompt: string;
  fullCompiledPrompt: string;
}

export const MANDATORY_CUTOUT_CONSTRAINTS =
  'isolated on a solid flat contrasting background, centered full silhouette, no floor shadow';

const PROJECTION_PHRASES: Record<Projection, string> = {
  'top-down': 'strict overhead top-down 2D game projection',
  isometric: '2:1 dimetric isometric 2D game projection',
  'side-scroller': 'orthographic side-scroller 2D profile projection',
  'three-quarter': 'three-quarter RPG 2D orthographic projection',
};

const LIGHTING_PHRASES: Record<Lighting, string> = {
  'top-left': 'directional top-left key lighting with clean lower-right cast shading',
  'top-right': 'directional top-right key lighting with clean lower-left cast shading',
  overhead: 'centered overhead key lighting with balanced underside shading',
  flat: 'even flat graphic cel lighting without directional shadows',
};

const ART_MODE_PHRASES: Record<ArtMode, string> = {
  'pixel-art': 'crisp pixel-art 2D game sprite, sharp pixel clusters, clean 1px silhouette outline',
  'hd-2d': 'hand-painted HD-2D cel-shaded game sprite, crisp inked contours, rich surface shading',
};

const ADHERENCE_PHRASES: Record<AdherenceLevel, string> = {
  strict: 'strictly preserve the input sketch silhouette, pose, and exact proportions',
  balanced: 'follow the input sketch silhouette while refining cohesive game-ready sprite detail',
  loose: 'treat the input sketch as loose compositional guidance with stylized creative detail',
};

/**
 * Deterministically compiles an Art Bible style lock and per-generation parameters
 * into a reproducible positive + negative prompt pair.
 */
export function compilePrompt(
  artBible: ArtBible,
  options: CompilePromptOptions,
): CompiledPromptResult {
  const segments: string[] = [
    ART_MODE_PHRASES[artBible.artMode],
    PROJECTION_PHRASES[artBible.projection],
    LIGHTING_PHRASES[artBible.lighting],
    `target resolution ${artBible.targetWidth}x${artBible.targetHeight}`,
    ADHERENCE_PHRASES[options.adherence],
    MANDATORY_CUTOUT_CONSTRAINTS,
  ];

  if (artBible.palette.length > 0) {
    segments.push(`strict color palette [${artBible.palette.join(', ')}]`);
  }

  const styleTrimmed = artBible.stylePrompt.trim();
  if (styleTrimmed.length > 0) {
    segments.push(`art direction: ${styleTrimmed}`);
  }

  const deltaTrimmed = options.promptDelta.trim();
  if (deltaTrimmed.length > 0) {
    segments.push(`subject detail: ${deltaTrimmed}`);
  }

  const positivePrompt = segments.join('; ');

  const rawNeg = artBible.negativePrompt.trim();
  const baseNeg = rawNeg.length > 0 ? rawNeg : DEFAULT_NEGATIVE_PROMPT;
  // Always enforce cutout-safe negative tokens even if user partially clears the field
  const requiredNegTokens = DEFAULT_NEGATIVE_PROMPT.split(',').map((s) => s.trim());
  const existingLower = baseNeg.toLowerCase();
  const missingTokens = requiredNegTokens.filter(
    (token) => token.length > 0 && !existingLower.includes(token.toLowerCase()),
  );
  const negativePrompt =
    missingTokens.length > 0 ? `${baseNeg}, ${missingTokens.join(', ')}` : baseNeg;

  return {
    positivePrompt,
    negativePrompt,
    fullCompiledPrompt: `${positivePrompt} | Negative: ${negativePrompt}`,
  };
}
