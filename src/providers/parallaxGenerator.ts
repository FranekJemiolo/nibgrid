import type { ArtBible, ProviderConfig, ProviderKind } from '../domain/schemas';
import {
  PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA,
  parseAndClampParallaxBlueprint,
  type ParallaxBandBlueprint,
  type ParallaxBandRole,
  type ParallaxSceneBlueprint,
} from '../processing/parallaxBlueprint';
import { hexToRgbTuple, type RgbTuple } from '../processing/parallaxCompositor';
import {
  base64ToUint8,
  decodePngBytesToRgba,
  encodeRgbaToPngBytes,
  uint8ToBase64,
} from '../processing/png';
import type { RgbaBuffer } from '../processing/types';
import { getBridgeSessionToken, resolveBridgeBaseUrl } from './antigravityBridgeProvider';
import type { BridgeGenerateRequest } from './bridgeContract';
import { BridgeGenerateResponseSchema } from './bridgeContract';
import { ProviderError, classifyProviderError } from './errors';
import {
  extractImageBase64FromGeminiResponse,
  resolveGeminiBaseUrl,
  type GeminiGenerateContentResponse,
  type GeminiRequestPart,
} from './geminiProvider';

export interface ParallaxBiomePreset {
  readonly id: 'masovian-dusk' | 'cyberpunk-rooftops' | 'volcanic-cavern' | 'pixel-meadow';
  readonly label: string;
  readonly themePrompt: string;
  readonly skyTopHex: string;
  readonly horizonHex: string;
  readonly lightingDirection: string;
  readonly bandCount: 3 | 4;
}

export const PARALLAX_BIOME_PRESETS: readonly ParallaxBiomePreset[] = [
  {
    id: 'masovian-dusk',
    label: 'Masovian Dusk Forest',
    themePrompt:
      'Masovian pine forest valley at twilight dusk, distant mist ridges, layered conifers, dark foreground reeds',
    skyTopHex: '#181A2F',
    horizonHex: '#D97B59',
    lightingDirection: 'low sunset glow from right horizon',
    bandCount: 4,
  },
  {
    id: 'cyberpunk-rooftops',
    label: 'Cyberpunk Rooftops',
    themePrompt:
      'Neon rain-slicked cyberpunk metropolis skyline, distant megatowers, mid-level billboards and transit rails, foreground rooftop vents',
    skyTopHex: '#0F1021',
    horizonHex: '#A23982',
    lightingDirection: 'magenta-cyan rim glow from horizon haze',
    bandCount: 4,
  },
  {
    id: 'volcanic-cavern',
    label: 'Volcanic Cavern',
    themePrompt:
      'Subterranean basalt caldera cavern, glowing magma horizon, jagged obsidian stalactite arches and ember silhouettes',
    skyTopHex: '#1D1218',
    horizonHex: '#E05A2B',
    lightingDirection: 'underlit ember glow from horizon fissures',
    bandCount: 3,
  },
  {
    id: 'pixel-meadow',
    label: 'Pixel Meadow',
    themePrompt:
      'Crisp sunny retro pixel-art meadow, drifting high cumulus wisps, rolling azure foothills, leafy oak hedgerow and foreground grass',
    skyTopHex: '#3B7DD8',
    horizonHex: '#BCE0FD',
    lightingDirection: 'warm overhead morning sunlight',
    bandCount: 3,
  },
];

export interface ParallaxCostEstimate {
  readonly estimatedUsd: number;
  readonly imageCalls: number;
  readonly blueprintCalls: number;
  readonly label: string;
}

export interface GeneratedParallaxBandArtifact {
  readonly band: ParallaxBandBlueprint;
  readonly rawBuffer: RgbaBuffer;
  readonly rawPngBytes: Uint8Array;
  readonly stripChromaKey: boolean;
}

export interface GeneratedParallaxStackResult {
  readonly blueprint: ParallaxSceneBlueprint;
  readonly masterKeyframePngBytes?: Uint8Array;
  readonly bands: readonly GeneratedParallaxBandArtifact[];
}

export interface GeminiParallaxBlueprintPayload {
  contents: [{ role: 'user'; parts: [{ text: string }] }];
  generationConfig: {
    responseMimeType: 'application/json';
    responseSchema: typeof PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA;
    temperature: number;
  };
}

export interface GeminiParallaxImagePayload {
  contents: [{ role: 'user'; parts: GeminiRequestPart[] }];
  generationConfig: {
    responseModalities: ['IMAGE'];
  };
}

export function resolveParallaxTextModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed || /image/i.test(trimmed)) {
    return 'gemini-2.5-flash';
  }
  return trimmed;
}

export function estimateParallaxGenerationCost(
  providerKind: ProviderKind,
  bandCount: number,
  includeMasterKeyframe: boolean,
): ParallaxCostEstimate {
  const safeBands = Math.max(2, Math.min(6, Math.round(bandCount)));
  if (providerKind === 'mock' || providerKind === 'antigravity-agent') {
    return {
      estimatedUsd: 0,
      imageCalls: 0,
      blueprintCalls: 0,
      label: '$0.00 — Offline Mock (Deterministic)',
    };
  }
  if (providerKind === 'antigravity-bridge') {
    return {
      estimatedUsd: 0,
      imageCalls: safeBands + (includeMasterKeyframe ? 1 : 0),
      blueprintCalls: 0,
      label: '$0.00 — Antigravity Bridge Quota',
    };
  }
  if (providerKind === 'gemini') {
    const imageCalls = safeBands + (includeMasterKeyframe ? 1 : 0);
    const estimatedUsd = Number((0.039 * imageCalls + 0.001).toFixed(3));
    return {
      estimatedUsd,
      imageCalls,
      blueprintCalls: 1,
      label: `~$${estimatedUsd.toFixed(2)} — Gemini BYOK (1 blueprint + ${imageCalls} images)`,
    };
  }
  const imageCalls = safeBands + (includeMasterKeyframe ? 1 : 0);
  const estimatedUsd = Number((0.04 * imageCalls).toFixed(2));
  return {
    estimatedUsd,
    imageCalls,
    blueprintCalls: 1,
    label: `~$${estimatedUsd.toFixed(2)} — Custom Provider`,
  };
}

/**
 * Pure request builder for Stage 1 Gemini JSON blueprint planning (`responseSchema` enforced).
 */
export function buildGeminiParallaxBlueprintPayload(input: {
  themePrompt: string;
  bandCount: number;
  artBible: ArtBible;
}): GeminiParallaxBlueprintPayload {
  const bandCount = Math.max(2, Math.min(6, Math.round(input.bandCount)));
  const paletteList =
    input.artBible.palette.length > 0 ? input.artBible.palette.join(', ') : '#1A1C2C, #5D275D';

  const prompt = [
    `Plan a ${bandCount}-layer seamless 2D side-scrolling parallax background stack matching this theme:`,
    `THEME: ${input.themePrompt}`,
    `ART DIRECTION: mode=${input.artBible.artMode}, lighting=${input.artBible.lighting}, style="${input.artBible.stylePrompt}".`,
    `PALETTE SWATCHES: ${paletteList}.`,
    `ORDERING RULES:`,
    `- Return exactly ${bandCount} bands ordered back-to-front by increasing scrollRatioX (0.08..1.05).`,
    `- Use roles from ['sky-far', 'far-mountains', 'midground', 'foreground-silhouette'].`,
    `- Assign higher depthHaze (0.45..0.80) to distant layers and low/zero depthHaze (0.0..0.25) to midground/foreground.`,
    `- Keep skyTopHex and horizonHex normalized #RRGGBB colors harmonious with the Art Bible palette.`,
    `- Set horizonLinePct between 0.35 and 0.80 and give every band an explicit edgeHeightHint for horizontal seam wrapping.`,
  ].join('\n');

  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA,
      temperature: 0.4,
    },
  };
}

/**
 * Pure request builder for optional Master Style Keyframe synthesis (Stage 2a).
 */
export function buildGeminiParallaxMasterPayload(input: {
  blueprint: ParallaxSceneBlueprint;
  artBible: ArtBible;
  goldenRefImages?: readonly { bytes: Uint8Array; mimeType: string }[];
}): GeminiParallaxImagePayload {
  const parts: GeminiRequestPart[] = [
    {
      text: [
        `MASTER PARALLAX KEYFRAME REFERENCE (${input.artBible.artMode}): "${input.blueprint.sceneTitle}".`,
        `Theme: ${input.blueprint.themePrompt}.`,
        `Sky gradient top ${input.blueprint.skyTopHex} to horizon ${input.blueprint.horizonHex} at ${Math.round(input.blueprint.horizonLinePct * 100)}% from top.`,
        `Lighting: ${input.blueprint.lightingDirection} (${input.artBible.lighting}).`,
        `Palette: ${input.artBible.palette.join(', ')}.`,
        `Style: ${input.artBible.stylePrompt}. Avoid: ${input.artBible.negativePrompt}.`,
        `Compose a clear full side-scrolling 2D game background establishing cohesive color harmony, scale, and horizon alignment across all depth planes.`,
      ].join('\n'),
    },
  ];

  for (const ref of (input.goldenRefImages ?? []).slice(0, 3)) {
    parts.push({
      inlineData: {
        mimeType: ref.mimeType || 'image/png',
        data: uint8ToBase64(ref.bytes),
      },
    });
  }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

function buildBandIsolationPromptText(input: {
  blueprint: ParallaxSceneBlueprint;
  band: ParallaxBandBlueprint;
  artBible: ArtBible;
  hasMasterRef: boolean;
  variationSeed?: number;
}): string {
  const horizonPct = Math.round(input.blueprint.horizonLinePct * 100);
  return [
    `PARALLAX DEPTH BAND GENERATION (${input.artBible.artMode}): "${input.band.name}" [role=${input.band.role}].`,
    `Render ONLY this single silhouette plane: ${input.band.subjectPrompt}.`,
    `CHROMA ISOLATION: Paint the silhouette cleanly over a flat, unshaded #FF00FF magenta background so Chroma Key removal isolates transparent sky gaps cleanly.`,
    `Do NOT paint any sky gradient, sun disc, stars, ground text, borders, or other foreground/background depth bands unless explicitly part of this band.`,
    `SILHOUETTE & WRAP ALIGNMENT:`,
    `- Silhouette rule: ${input.band.silhouetteRule}.`,
    `- Horizon baseline at ${horizonPct}% from top edge.`,
    `- Edge continuity: ${input.band.edgeHeightHint} so left and right edges wrap horizontally without jumps.`,
    `STYLE CONSISTENCY: lighting=${input.blueprint.lightingDirection} (${input.artBible.lighting}), palette=[${input.artBible.palette.join(', ')}], style="${input.artBible.stylePrompt}", avoid="${input.artBible.negativePrompt}".`,
    ...(input.hasMasterRef
      ? [
          `Match brushwork, color temperature, and scale from the attached Master Keyframe reference image.`,
        ]
      : []),
    ...(typeof input.variationSeed === 'number'
      ? [`Deterministic variation seed: ${input.variationSeed}.`]
      : []),
  ].join('\n');
}

/**
 * Pure request builder for Stage 2b individual parallax band generation against the Master Keyframe
 * with `#FF00FF` chroma-key isolation and horizon/edge-height alignment rules.
 */
export function buildGeminiParallaxBandPayload(input: {
  blueprint: ParallaxSceneBlueprint;
  band: ParallaxBandBlueprint;
  artBible: ArtBible;
  masterKeyframePngBytes?: Uint8Array;
  goldenRefImages?: readonly { bytes: Uint8Array; mimeType: string }[];
  variationSeed?: number;
}): GeminiParallaxImagePayload {
  const parts: GeminiRequestPart[] = [
    {
      text: buildBandIsolationPromptText({
        blueprint: input.blueprint,
        band: input.band,
        artBible: input.artBible,
        hasMasterRef: Boolean(input.masterKeyframePngBytes),
        variationSeed: input.variationSeed,
      }),
    },
  ];

  if (input.masterKeyframePngBytes) {
    parts.push({
      inlineData: {
        mimeType: 'image/png',
        data: uint8ToBase64(input.masterKeyframePngBytes),
      },
    });
  }

  for (const ref of (input.goldenRefImages ?? []).slice(0, 3)) {
    parts.push({
      inlineData: {
        mimeType: ref.mimeType || 'image/png',
        data: uint8ToBase64(ref.bytes),
      },
    });
  }

  return {
    contents: [{ role: 'user', parts }],
    generationConfig: {
      responseModalities: ['IMAGE'],
    },
  };
}

/**
 * Pure M10 Antigravity Loopback Bridge request builder attaching master keyframe + golden refs.
 */
export function buildBridgeParallaxBandRequest(input: {
  config: ProviderConfig;
  blueprint: ParallaxSceneBlueprint;
  band: ParallaxBandBlueprint;
  artBible: ArtBible;
  masterKeyframePngBytes?: Uint8Array;
  goldenRefImages?: readonly { bytes: Uint8Array; mimeType: string }[];
  variationSeed?: number;
}): BridgeGenerateRequest {
  const refs: string[] = [];
  if (input.masterKeyframePngBytes) {
    refs.push(uint8ToBase64(input.masterKeyframePngBytes));
  }
  for (const ref of (input.goldenRefImages ?? []).slice(0, 3)) {
    refs.push(uint8ToBase64(ref.bytes));
  }

  return {
    requestId: globalThis.crypto.randomUUID(),
    modelId: input.config.modelId,
    compiledPrompt: buildBandIsolationPromptText({
      blueprint: input.blueprint,
      band: input.band,
      artBible: input.artBible,
      hasMasterRef: Boolean(input.masterKeyframePngBytes),
      variationSeed: input.variationSeed,
    }),
    promptDelta: input.band.subjectPrompt,
    negativePrompt: `${input.artBible.negativePrompt}, sky gradient, other parallax layers`,
    adherence: 'balanced',
    variants: 1,
    ...(refs.length > 0 ? { goldenRefsPngBase64: refs } : {}),
    artBibleSnapshot: {
      projection: 'side-scroller',
      lighting: input.artBible.lighting,
      artMode: input.artBible.artMode,
      palette: [...input.artBible.palette],
    },
  };
}

function matchPresetFromPrompt(themePrompt: string): ParallaxBiomePreset {
  const lower = themePrompt.toLowerCase();
  if (lower.includes('cyber') || lower.includes('neon') || lower.includes('rooftop')) {
    return PARALLAX_BIOME_PRESETS[1]!;
  }
  if (lower.includes('volcan') || lower.includes('lava') || lower.includes('cavern')) {
    return PARALLAX_BIOME_PRESETS[2]!;
  }
  if (lower.includes('meadow') || lower.includes('grass') || lower.includes('sunny')) {
    return PARALLAX_BIOME_PRESETS[3]!;
  }
  return PARALLAX_BIOME_PRESETS[0]!;
}

/**
 * Deterministic local `$0.00` blueprint planner used by Offline Mock Mode and Antigravity Bridge.
 */
export function buildLocalParallaxBlueprint(
  themePrompt: string,
  artBible: ArtBible,
  bandCount = 4,
): ParallaxSceneBlueprint {
  const preset = matchPresetFromPrompt(themePrompt);
  const clampedCount = Math.max(2, Math.min(6, Math.round(bandCount)));

  const candidateBands: Array<{
    id: string;
    name: string;
    role: ParallaxBandRole;
    scrollRatioX: number;
    depthHaze: number;
    seamBlendPx: number;
    yOffsetPx: number;
    subjectPrompt: string;
    silhouetteRule: string;
    edgeHeightHint: string;
  }> = [
    {
      id: 'band-sky-far',
      name: 'Cloud Wisps & Ridge Mist',
      role: 'sky-far',
      scrollRatioX: 0.1,
      depthHaze: 0.78,
      seamBlendPx: 24,
      yOffsetPx: 0,
      subjectPrompt: `High drifting cloud ribbons & mist strata for ${themePrompt || preset.themePrompt}`,
      silhouetteRule: 'Flat #FF00FF chroma key background, translucent-friendly soft band tops',
      edgeHeightHint: 'Left and right edges align at 38% from top',
    },
    {
      id: 'band-far-peaks',
      name:
        preset.id === 'cyberpunk-rooftops'
          ? 'Distant Megatowers'
          : preset.id === 'volcanic-cavern'
            ? 'Basalt Obsidian Spires'
            : 'Distant Ridges',
      role: 'far-mountains',
      scrollRatioX: 0.25,
      depthHaze: 0.56,
      seamBlendPx: 24,
      yOffsetPx: 0,
      subjectPrompt: `Distant horizon silhouette peaks for ${themePrompt || preset.themePrompt}`,
      silhouetteRule: 'Isolated opaque silhouette on #FF00FF chroma key sky',
      edgeHeightHint: 'Left and right ridge contours join smoothly at 58% height',
    },
    {
      id: 'band-midground',
      name:
        preset.id === 'cyberpunk-rooftops'
          ? 'Midground Skybridges'
          : preset.id === 'volcanic-cavern'
            ? 'Lava Cave Arches'
            : preset.id === 'pixel-meadow'
              ? 'Rolling Oak Hills'
              : 'Pine Timberline',
      role: 'midground',
      scrollRatioX: 0.55,
      depthHaze: 0.24,
      seamBlendPx: 24,
      yOffsetPx: 0,
      subjectPrompt: `Midground repeating structures/foliage for ${themePrompt || preset.themePrompt}`,
      silhouetteRule: 'Isolated shapes on #FF00FF chroma key with clear negative space',
      edgeHeightHint: 'Match horizon elevation seamlessly across x=0 and x=W-1 at 68%',
    },
    {
      id: 'band-foreground',
      name:
        preset.id === 'cyberpunk-rooftops'
          ? 'Foreground Rooftop Ducts'
          : preset.id === 'volcanic-cavern'
            ? 'Foreground Magma Rocks'
            : 'Foreground Grass & Reeds',
      role: 'foreground-silhouette',
      scrollRatioX: 0.9,
      depthHaze: 0.04,
      seamBlendPx: 24,
      yOffsetPx: 0,
      subjectPrompt: `Low dark framing foreground tufts for ${themePrompt || preset.themePrompt}`,
      silhouetteRule: 'Low 28% silhouette strip isolated against #FF00FF chroma key',
      edgeHeightHint: 'Low ground profile connecting seamlessly at 84% height',
    },
  ];

  const selectedBands =
    clampedCount === 3
      ? [candidateBands[1]!, candidateBands[2]!, candidateBands[3]!]
      : clampedCount === 2
        ? [candidateBands[1]!, candidateBands[2]!]
        : candidateBands.slice(0, clampedCount);

  return parseAndClampParallaxBlueprint({
    sceneTitle: preset.label,
    themePrompt: themePrompt.trim() || preset.themePrompt,
    skyTopHex: preset.skyTopHex,
    horizonHex: preset.horizonHex,
    horizonLinePct: 0.6,
    lightingDirection: `${preset.lightingDirection} (${artBible.lighting})`,
    bandCount: selectedBands.length,
    bands: selectedBands,
  });
}

function mixRgb(a: RgbTuple, b: RgbTuple, t: number): [number, number, number] {
  const k = Math.max(0, Math.min(1, t));
  return [
    Math.round(a[0] + (b[0] - a[0]) * k),
    Math.round(a[1] + (b[1] - a[1]) * k),
    Math.round(a[2] + (b[2] - a[2]) * k),
  ];
}

function hash1d(n: number, seed: number): number {
  let h = Math.imul(n, 374761393) ^ Math.imul(seed, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/**
 * Synthesizes clean, periodic, alpha-isolated parallax bands for Offline Mock Mode (`$0.00 Local`).
 */
export function synthesizeMockParallaxBand(
  band: ParallaxBandBlueprint,
  width: number,
  height: number,
  artBible: ArtBible,
  seed: number,
  skyTopHex = '#1A1C2C',
  horizonHex = '#D97B59',
): RgbaBuffer {
  const w = Math.max(32, Math.round(width));
  const h = Math.max(32, Math.round(height));
  const data = new Uint8ClampedArray(w * h * 4);

  const skyRgb = hexToRgbTuple(skyTopHex);
  const horizonRgb = hexToRgbTuple(horizonHex);
  const darkBase: RgbTuple =
    artBible.palette[0] !== undefined ? hexToRgbTuple(artBible.palette[0]) : [22, 24, 38];
  const accentRgb: RgbTuple =
    artBible.palette[2] !== undefined ? hexToRgbTuple(artBible.palette[2]) : horizonRgb;

  const baseColor =
    band.role === 'sky-far'
      ? mixRgb(skyRgb, horizonRgb, 0.72)
      : band.role === 'far-mountains'
        ? mixRgb(darkBase, horizonRgb, 0.42)
        : band.role === 'midground'
          ? mixRgb(darkBase, skyRgb, 0.35)
          : mixRgb(darkBase, [10, 12, 18], 0.45);
  const rimColor = mixRgb(baseColor, accentRgb, 0.38);

  const phaseA = hash1d(1, seed) * Math.PI * 2;
  const phaseB = hash1d(2, seed) * Math.PI * 2;
  const quantStep = artBible.artMode === 'pixel-art' ? 4 : 1;

  for (let x = 0; x < w; x++) {
    const qx = Math.floor(x / quantStep) * quantStep;
    const u = qx / w;
    const theta = u * Math.PI * 2;

    if (band.role === 'sky-far') {
      const centerY = h * (0.28 + 0.06 * Math.sin(theta * 2 + phaseA));
      const halfThick =
        h *
        Math.max(0.02, 0.045 + 0.03 * Math.cos(theta * 3 + phaseB) + 0.015 * Math.sin(theta * 5));
      const yMin = Math.max(2, Math.round(centerY - halfThick));
      const yMax = Math.min(h - 2, Math.round(centerY + halfThick));
      for (let y = yMin; y <= yMax; y++) {
        const px = (y * w + x) * 4;
        const c = y - yMin <= 2 ? rimColor : baseColor;
        data[px] = c[0];
        data[px + 1] = c[1];
        data[px + 2] = c[2];
        data[px + 3] = 210;
      }
      continue;
    }

    let contourPct = 0.65;
    if (band.role === 'far-mountains') {
      const ridge1 = Math.abs(Math.sin(theta * 2 + phaseA));
      const ridge2 = 0.45 * Math.sin(theta * 5 + phaseB);
      contourPct = 0.38 + 0.24 * (1 - ridge1) + 0.08 * ridge2;
    } else if (band.role === 'midground') {
      const trunkHash = hash1d(Math.floor((qx + (seed % 19)) / 14), seed);
      const canopy =
        Math.sin(theta * 6 + phaseA) * 0.07 +
        Math.cos(theta * 13 + phaseB) * 0.045 +
        (trunkHash > 0.45 ? -0.09 : 0.02);
      contourPct = 0.64 + canopy;
    } else {
      const tuft =
        Math.sin(theta * 8 + phaseA) * 0.045 +
        (qx % 12 < 4 ? -0.055 : 0.015) +
        Math.cos(theta * 17 + phaseB) * 0.025;
      contourPct = 0.81 + tuft;
    }

    const startY = Math.max(4, Math.min(h - 4, Math.round(h * contourPct)));
    for (let y = startY; y < h; y++) {
      const px = (y * w + x) * 4;
      const isRim = y - startY < Math.max(2, Math.round(h * 0.015));
      const c = isRim ? rimColor : baseColor;
      data[px] = c[0];
      data[px + 1] = c[1];
      data[px + 2] = c[2];
      data[px + 3] = 255;
    }
  }

  return { width: w, height: h, data };
}

function extractTextFromGeminiResponse(json: GeminiGenerateContentResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const textParts = parts
    .map((p) => p.text)
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
  if (textParts.length === 0) {
    throw new Error(json.error?.message || 'Gemini blueprint response contained no JSON text.');
  }
  return textParts.join('\n');
}

async function decodeCanonicalPng(base64Data: string): Promise<{
  rgba: RgbaBuffer;
  pngBytes: Uint8Array;
}> {
  const rawBytes = base64ToUint8(base64Data);
  const decoded = await decodePngBytesToRgba(rawBytes);
  const canonicalPng = encodeRgbaToPngBytes(decoded.rgba, decoded.width, decoded.height);
  return {
    rgba: { width: decoded.width, height: decoded.height, data: decoded.rgba },
    pngBytes: canonicalPng,
  };
}

function ensureNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Parallax generation aborted', 'AbortError');
  }
}

async function invokeGeminiBlueprint(
  config: ProviderConfig,
  payload: GeminiParallaxBlueprintPayload,
  signal?: AbortSignal,
): Promise<ParallaxSceneBlueprint> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new ProviderError({
      code: 'UNAUTHORIZED',
      status: 401,
      providerId: config.id,
      retryable: false,
      message: 'Gemini API key is required. Configure it in Provider Vault.',
      remediation: 'Open Provider Vault and enter a valid Gemini API key.',
    });
  }

  const baseUrl = resolveGeminiBaseUrl(config.endpointUrl);
  const textModel = resolveParallaxTextModelId(config.modelId);
  const url = `${baseUrl}/models/${encodeURIComponent(textModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      throw classifyProviderError(
        { status: res.status, responseText },
        { providerId: config.id, providerKind: 'gemini', endpointUrl: baseUrl, secrets: [apiKey] },
      );
    }
    const json = (await res.json()) as GeminiGenerateContentResponse;
    const rawText = extractTextFromGeminiResponse(json);
    return parseAndClampParallaxBlueprint(rawText);
  } catch (error) {
    throw classifyProviderError(error, {
      providerId: config.id,
      providerKind: 'gemini',
      endpointUrl: baseUrl,
      secrets: [apiKey],
    });
  }
}

async function invokeGeminiImage(
  config: ProviderConfig,
  payload: GeminiParallaxImagePayload,
  signal?: AbortSignal,
): Promise<{ rgba: RgbaBuffer; pngBytes: Uint8Array }> {
  const apiKey = config.apiKey.trim();
  if (!apiKey) {
    throw new ProviderError({
      code: 'UNAUTHORIZED',
      status: 401,
      providerId: config.id,
      retryable: false,
      message: 'Gemini API key is required. Configure it in Provider Vault.',
      remediation: 'Open Provider Vault and enter a valid Gemini API key.',
    });
  }

  const baseUrl = resolveGeminiBaseUrl(config.endpointUrl);
  const url = `${baseUrl}/models/${encodeURIComponent(config.modelId)}:generateContent?key=${encodeURIComponent(apiKey)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal,
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      throw classifyProviderError(
        { status: res.status, responseText },
        { providerId: config.id, providerKind: 'gemini', endpointUrl: baseUrl, secrets: [apiKey] },
      );
    }
    const json = (await res.json()) as GeminiGenerateContentResponse;
    const { base64 } = extractImageBase64FromGeminiResponse(json);
    return await decodeCanonicalPng(base64);
  } catch (error) {
    throw classifyProviderError(error, {
      providerId: config.id,
      providerKind: 'gemini',
      endpointUrl: baseUrl,
      secrets: [apiKey],
    });
  }
}

async function invokeBridgeBandImage(
  config: ProviderConfig,
  requestPayload: BridgeGenerateRequest,
  signal?: AbortSignal,
): Promise<{ rgba: RgbaBuffer; pngBytes: Uint8Array }> {
  const baseUrl = resolveBridgeBaseUrl(config.endpointUrl);
  const token = getBridgeSessionToken(config.id, config.apiKey);
  if (!token) {
    throw new ProviderError({
      code: 'UNAUTHORIZED',
      status: 401,
      providerId: config.id,
      retryable: false,
      message: 'Bridge session token is missing.',
      remediation: 'Start nibgrid_bridge.py and paste the nbg_ token in Provider Vault.',
    });
  }

  const onAbort = () => {
    void fetch(`${baseUrl}/v1/cancel/${requestPayload.requestId}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  };
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(`${baseUrl}/v1/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(requestPayload),
      signal: signal ?? AbortSignal.timeout(45_000),
    });
    if (!res.ok) {
      const responseText = await res.text().catch(() => '');
      throw classifyProviderError(
        { status: res.status, responseText },
        {
          providerId: config.id,
          providerKind: 'antigravity-bridge',
          endpointUrl: baseUrl,
          secrets: [token],
        },
      );
    }
    const parsed = BridgeGenerateResponseSchema.parse(await res.json());
    const variant = parsed.variants[0];
    if (!variant) {
      throw new Error('Bridge returned zero image variants.');
    }
    return await decodeCanonicalPng(variant.pngBase64);
  } catch (error) {
    throw classifyProviderError(error, {
      providerId: config.id,
      providerKind: 'antigravity-bridge',
      endpointUrl: baseUrl,
      secrets: [token],
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

/**
 * Generates or deterministically plans Stage 1's ordered Parallax Scene Blueprint.
 */
export async function generateParallaxBlueprint(params: {
  readonly providerConfig: ProviderConfig;
  readonly themePrompt: string;
  readonly bandCount: number;
  readonly artBible: ArtBible;
  readonly signal?: AbortSignal;
}): Promise<ParallaxSceneBlueprint> {
  ensureNotAborted(params.signal);
  if (params.providerConfig.kind === 'gemini') {
    const payload = buildGeminiParallaxBlueprintPayload({
      themePrompt: params.themePrompt,
      bandCount: params.bandCount,
      artBible: params.artBible,
    });
    return invokeGeminiBlueprint(params.providerConfig, payload, params.signal);
  }
  return buildLocalParallaxBlueprint(params.themePrompt, params.artBible, params.bandCount);
}

/**
 * Regenerates ONE individual band inside an existing blueprint & Master Keyframe without touching siblings.
 */
export async function regenerateParallaxBand(params: {
  readonly providerConfig: ProviderConfig;
  readonly blueprint: ParallaxSceneBlueprint;
  readonly band: ParallaxBandBlueprint;
  readonly artBible: ArtBible;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly masterKeyframePngBytes?: Uint8Array;
  readonly goldenRefImages?: readonly { bytes: Uint8Array; mimeType: string }[];
  readonly variationSeed?: number;
  readonly signal?: AbortSignal;
}): Promise<GeneratedParallaxBandArtifact> {
  ensureNotAborted(params.signal);
  const seed = params.variationSeed ?? Date.now() & 0xfffffff;

  if (params.providerConfig.kind === 'gemini') {
    const payload = buildGeminiParallaxBandPayload({
      blueprint: params.blueprint,
      band: params.band,
      artBible: params.artBible,
      masterKeyframePngBytes: params.masterKeyframePngBytes,
      goldenRefImages: params.goldenRefImages,
      variationSeed: seed,
    });
    const decoded = await invokeGeminiImage(params.providerConfig, payload, params.signal);
    return {
      band: params.band,
      rawBuffer: decoded.rgba,
      rawPngBytes: decoded.pngBytes,
      stripChromaKey: true,
    };
  }

  if (params.providerConfig.kind === 'antigravity-bridge') {
    const req = buildBridgeParallaxBandRequest({
      config: params.providerConfig,
      blueprint: params.blueprint,
      band: params.band,
      artBible: params.artBible,
      masterKeyframePngBytes: params.masterKeyframePngBytes,
      goldenRefImages: params.goldenRefImages,
      variationSeed: seed,
    });
    const decoded = await invokeBridgeBandImage(params.providerConfig, req, params.signal);
    return {
      band: params.band,
      rawBuffer: decoded.rgba,
      rawPngBytes: decoded.pngBytes,
      stripChromaKey: true,
    };
  }

  if (params.providerConfig.kind !== 'mock' && params.providerConfig.kind !== 'antigravity-agent') {
    throw new ProviderError({
      code: 'UNKNOWN',
      providerId: params.providerConfig.id,
      retryable: false,
      message: `Parallax stack generation is supported on Gemini BYOK, Antigravity Bridge, and Offline Mock (selected: ${params.providerConfig.displayName}).`,
      remediation: 'Switch to Offline Mock ($0.00), Gemini BYOK, or Antigravity Loopback Bridge.',
    });
  }

  // Offline Mock Mode: deterministic procedural silhouette band
  const rawBuffer = synthesizeMockParallaxBand(
    params.band,
    params.viewportWidth + params.band.seamBlendPx,
    params.viewportHeight,
    params.artBible,
    seed,
    params.blueprint.skyTopHex,
    params.blueprint.horizonHex,
  );
  return {
    band: params.band,
    rawBuffer,
    rawPngBytes: encodeRgbaToPngBytes(rawBuffer.data, rawBuffer.width, rawBuffer.height),
    stripChromaKey: false,
  };
}

/**
 * Orchestrates Stage 1 (JSON Blueprint) + Stage 2 (optional Master Keyframe & sequential per-band
 * generation streamed back via `onBandReady`), cleanly abortable and strictly redacting API secrets.
 */
export async function generateMatchedParallaxStack(params: {
  readonly providerConfig: ProviderConfig;
  readonly artBible: ArtBible;
  readonly themePrompt: string;
  readonly bandCount: 3 | 4;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  readonly includeMasterKeyframe: boolean;
  readonly goldenRefImages?: readonly { bytes: Uint8Array; mimeType: string }[];
  readonly seedBase?: number;
  readonly signal?: AbortSignal;
  readonly onStage?: (status: string) => void;
  readonly onBlueprintReady?: (blueprint: ParallaxSceneBlueprint) => void;
  readonly onBandReady?: (
    artifact: GeneratedParallaxBandArtifact,
    index: number,
    total: number,
  ) => void;
}): Promise<GeneratedParallaxStackResult> {
  ensureNotAborted(params.signal);
  params.onStage?.('Planning parallax blueprint...');
  const blueprint = await generateParallaxBlueprint({
    providerConfig: params.providerConfig,
    themePrompt: params.themePrompt,
    bandCount: params.bandCount,
    artBible: params.artBible,
    signal: params.signal,
  });
  params.onBlueprintReady?.(blueprint);

  let masterKeyframePngBytes: Uint8Array | undefined;
  if (params.includeMasterKeyframe && params.providerConfig.kind === 'gemini') {
    ensureNotAborted(params.signal);
    params.onStage?.('Painting master keyframe reference...');
    const masterPayload = buildGeminiParallaxMasterPayload({
      blueprint,
      artBible: params.artBible,
      goldenRefImages: params.goldenRefImages,
    });
    const masterImg = await invokeGeminiImage(params.providerConfig, masterPayload, params.signal);
    masterKeyframePngBytes = masterImg.pngBytes;
  }

  const artifacts: GeneratedParallaxBandArtifact[] = [];
  const total = blueprint.bands.length;
  const seedBase = params.seedBase ?? 1001;

  for (let i = 0; i < total; i++) {
    ensureNotAborted(params.signal);
    const band = blueprint.bands[i]!;
    params.onStage?.(`Generating band ${i + 1}/${total}: ${band.name}...`);
    const artifact = await regenerateParallaxBand({
      providerConfig: params.providerConfig,
      blueprint,
      band,
      artBible: params.artBible,
      viewportWidth: params.viewportWidth,
      viewportHeight: params.viewportHeight,
      masterKeyframePngBytes,
      goldenRefImages: params.goldenRefImages,
      variationSeed: seedBase + i * 97,
      signal: params.signal,
    });
    artifacts.push(artifact);
    params.onBandReady?.(artifact, i, total);
  }

  params.onStage?.(`Generated ${total} matched parallax bands.`);
  return {
    blueprint,
    ...(masterKeyframePngBytes ? { masterKeyframePngBytes } : {}),
    bands: artifacts,
  };
}
