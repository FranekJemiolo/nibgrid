import { encodeWav16, runAudioPostProcessPipeline } from '../audio/pcmPostProcess';
import { synthesizeProceduralSfx } from '../audio/proceduralSynth';
import type { ProceduralSfxParams } from '../audio/types';
import type { NibgridDatabase } from '../db/database';
import { NibgridRepository } from '../db/database';
import {
  EntityDefinitionSchema,
  normalizeResSubpath,
  sanitizeEntitySlug,
  type EntityDefinition,
} from '../domain/entitySchema';
import {
  AudioAssetSchema,
  SpriteNodeSchema,
  createDefaultAudioPostProcessConfig,
  createDefaultPostProcessConfig,
  type ArtBible,
  type AudioAsset,
  type CollisionLayerShape,
  type ProviderConfig,
  type ProviderKind,
  type SpriteNode,
} from '../domain/schemas';
import { validateAndCompileGdScript } from '../export/gdscriptGenerator';
import { extractCollisionHull } from '../processing/collisionHull';
import {
  ENTITY_BLUEPRINT_GEMINI_RESPONSE_SCHEMA,
  computeOpaqueBounds,
  parseAndClampDirectorBlueprint,
  resolveSocketHintsToPixels,
  type DirectorSfxPreset,
  type EntityDirectorBlueprint,
  type EntityGenrePreset,
} from '../processing/entityDirectorBlueprint';
import { sha256Bytes } from '../processing/hash';
import { runPostProcessPipeline } from '../processing/pipeline';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../processing/png';
import {
  synthesizeProceduralSprite,
  synthesizeProceduralTurnaroundSheet,
} from '../processing/proceduralSprite';
import { computeArtBibleHash } from '../processing/projectAudit';
import { classifyProviderError, ProviderError } from './errors';
import {
  extractImageBase64FromGeminiResponse,
  resolveGeminiBaseUrl,
  type GeminiGenerateContentResponse,
} from './geminiProvider';
import { resolveParallaxTextModelId } from './parallaxGenerator';

export type DirectorStageId = 'sprite' | 'collider' | 'sockets' | 'sfx' | 'gdscript' | 'commit';
export type DirectorStageStatus = 'pending' | 'running' | 'done' | 'error';

export interface DirectorProgressEvent {
  readonly stage: DirectorStageId;
  readonly status: DirectorStageStatus;
  readonly detail?: string;
}

export interface DirectorCostEstimate {
  readonly estimatedUsd: number;
  readonly imageCalls: number;
  readonly textCalls: number;
  readonly proceduralSfxCount: number;
  readonly label: string;
}

export interface DraftBlueprintResult {
  readonly blueprint: EntityDirectorBlueprint;
  readonly costEstimate: DirectorCostEstimate;
  readonly usedMock: boolean;
}

export interface ExecuteDirectorOptions {
  readonly providerConfig: ProviderConfig;
  readonly generateGdScript?: boolean;
  readonly resSubpath?: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (event: DirectorProgressEvent) => void;
}

export interface ExecuteDirectorResult {
  readonly entity: EntityDefinition;
  readonly spriteNode: SpriteNode;
  readonly audioAssets: readonly AudioAsset[];
  readonly scriptCode: string;
  readonly usedGdScriptFallback: boolean;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('Prompt-to-Entity Director run was aborted.', 'AbortError');
  }
}

export function estimateDirectorCost(
  providerKind: ProviderKind,
  blueprint: EntityDirectorBlueprint,
  includeGdScript = true,
): DirectorCostEstimate {
  const proceduralSfxCount = blueprint.sfxSpecs.filter((s) => s.engine === 'procedural').length;
  const aiSfxCount = blueprint.sfxSpecs.length - proceduralSfxCount;

  if (providerKind === 'mock' || providerKind === 'antigravity-agent') {
    return {
      estimatedUsd: 0,
      imageCalls: 0,
      textCalls: 0,
      proceduralSfxCount: blueprint.sfxSpecs.length,
      label: `Offline Mock (${blueprint.sfxSpecs.length} Procedural SFX${includeGdScript ? ' + 1 GDScript' : ''}) • $0.00`,
    };
  }

  if (providerKind === 'antigravity-bridge') {
    return {
      estimatedUsd: 0,
      imageCalls: 1,
      textCalls: includeGdScript ? 1 : 0,
      proceduralSfxCount,
      label: `Antigravity Bridge (1 Sprite + ${blueprint.sfxSpecs.length} SFX) • $0.00 Quota`,
    };
  }

  const imageCalls = 1;
  const textCalls = includeGdScript ? 1 : 0;
  const estimatedUsd = Number(
    (imageCalls * 0.039 + textCalls * 0.001 + aiSfxCount * 0.002).toFixed(3),
  );
  return {
    estimatedUsd,
    imageCalls,
    textCalls,
    proceduralSfxCount,
    label: `1 Sprite + ${proceduralSfxCount} Procedural SFX${includeGdScript ? ' + 1 GDScript' : ''} • ~$${estimatedUsd.toFixed(2)}`,
  };
}

/**
 * Deterministic keyword-aware Stage 1 planner used in Offline Mock / Antigravity Bridge fallback.
 */
export function buildMockEntityBlueprint(
  prompt: string,
  genre: EntityGenrePreset,
): EntityDirectorBlueprint {
  const trimmed = prompt.trim() || 'Armored Goblin Scout';
  const lower = trimmed.toLowerCase();
  const baseWords = trimmed
    .replace(/[^a-zA-Z0-9\s]+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 3);
  const displayName =
    baseWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ') ||
    'Game Entity';

  const isPropOrPickup =
    genre === 'prop-interactive' ||
    /\b(chest|potion|coin|crate|barrel|door|pickup|gem|key)\b/.test(lower);
  const isRanged =
    genre === 'twin-stick' || /\b(turret|bow|archer|rifle|gun|mage|blaster|drone)\b/.test(lower);

  const sockets = isPropOrPickup
    ? [{ name: 'center', normX: 0.5, normY: 0.5, baseAngleDeg: 0 }]
    : isRanged
      ? [
          { name: 'hand_r', normX: 0.72, normY: 0.54, baseAngleDeg: 0 },
          { name: 'muzzle', normX: 0.92, normY: 0.45, baseAngleDeg: 0 },
        ]
      : [
          { name: 'hand_r', normX: 0.78, normY: 0.52, baseAngleDeg: 25 },
          { name: 'head', normX: 0.5, normY: 0.18, baseAngleDeg: 0 },
        ];

  const sfxSpecs = isPropOrPickup
    ? [
        {
          cueName: 'pickup_chime',
          category: 'sfx' as const,
          prompt: `Crisp chime sound for ${trimmed}`,
          engine: 'procedural' as const,
          proceduralPreset: 'pickup' as const,
        },
      ]
    : [
        {
          cueName: isRanged ? 'attack_shot' : 'attack_slash',
          category: 'sfx' as const,
          prompt: `Punchy weapon attack SFX for ${trimmed}`,
          engine: 'procedural' as const,
          proceduralPreset: isRanged ? ('laser' as const) : ('hit' as const),
        },
        {
          cueName: 'footstep',
          category: 'sfx' as const,
          prompt: `Ground footstep thud for ${trimmed}`,
          engine: 'procedural' as const,
          proceduralPreset: 'footstep' as const,
        },
        {
          cueName: 'hurt',
          category: 'sfx' as const,
          prompt: `Short damage grunt impact for ${trimmed}`,
          engine: 'procedural' as const,
          proceduralPreset: 'hit' as const,
        },
      ];

  return parseAndClampDirectorBlueprint(
    {
      slug: baseWords.join('_'),
      displayName,
      bodyType: isPropOrPickup ? 'Area2D' : 'CharacterBody2D',
      spritePrompt: `${trimmed}, crisp 2D game sprite silhouette, clean flat backdrop`,
      turnaroundLayout: 'single',
      generateNormalMap: true,
      colliderMode: 'convex-hull',
      includeHitbox: !isPropOrPickup,
      includeHurtbox: !isPropOrPickup,
      sockets,
      sfxSpecs,
      behavior: {
        archetype: isPropOrPickup ? 'pickup' : isRanged ? 'ranged-enemy' : 'melee-enemy',
        moveSpeed: isPropOrPickup ? 0 : genre === 'top-down' ? 120 : 95,
        maxHealth: isPropOrPickup ? 1 : 40,
        attackDamage: isPropOrPickup ? 0 : 12,
        states: isPropOrPickup ? ['IDLE', 'COLLECTED'] : ['IDLE', 'PATROL', 'ATTACK', 'HURT'],
      },
    },
    trimmed,
    genre,
  );
}

function buildSfxPresetParams(
  preset: DirectorSfxPreset | undefined,
  seed: number,
): ProceduralSfxParams {
  switch (preset) {
    case 'footstep':
      return {
        seed,
        durationSec: 0.16,
        sampleRate: 44100,
        transientGain: 0.65,
        transientDecayMs: 12,
        transientFreqHz: 240,
        bodyGain: 0.5,
        bodyShape: 'sine',
        bodyStartHz: 140,
        bodyEndHz: 55,
        bodyAttackMs: 1,
        bodyDecayMs: 75,
        fmRatio: 0,
        fmDepth: 0,
        noiseGain: 0.65,
        noiseDecayMs: 85,
        filterStartHz: 1100,
        filterEndHz: 280,
        filterQ: 1.1,
        bitDepth: 16,
        drive: 1.4,
      };
    case 'laser':
      return {
        seed,
        durationSec: 0.24,
        sampleRate: 44100,
        transientGain: 0.55,
        transientDecayMs: 10,
        transientFreqHz: 1900,
        bodyGain: 0.85,
        bodyShape: 'sawtooth',
        bodyStartHz: 1150,
        bodyEndHz: 190,
        bodyAttackMs: 1,
        bodyDecayMs: 160,
        fmRatio: 1.5,
        fmDepth: 140,
        noiseGain: 0.25,
        noiseDecayMs: 90,
        filterStartHz: 5400,
        filterEndHz: 850,
        filterQ: 2.2,
        bitDepth: 16,
        drive: 1.8,
      };
    case 'pickup':
      return {
        seed,
        durationSec: 0.28,
        sampleRate: 44100,
        transientGain: 0.4,
        transientDecayMs: 10,
        transientFreqHz: 1480,
        bodyGain: 0.85,
        bodyShape: 'triangle',
        bodyStartHz: 520,
        bodyEndHz: 1040,
        bodyAttackMs: 2,
        bodyDecayMs: 200,
        fmRatio: 2,
        fmDepth: 80,
        noiseGain: 0.08,
        noiseDecayMs: 50,
        filterStartHz: 6000,
        filterEndHz: 2600,
        filterQ: 1.2,
        bitDepth: 16,
        drive: 1.0,
      };
    case 'jump':
      return {
        seed,
        durationSec: 0.22,
        sampleRate: 44100,
        transientGain: 0.45,
        transientDecayMs: 8,
        transientFreqHz: 620,
        bodyGain: 0.8,
        bodyShape: 'square',
        bodyStartHz: 220,
        bodyEndHz: 640,
        bodyAttackMs: 2,
        bodyDecayMs: 140,
        fmRatio: 0,
        fmDepth: 0,
        noiseGain: 0.2,
        noiseDecayMs: 70,
        filterStartHz: 2800,
        filterEndHz: 1200,
        filterQ: 1.4,
        bitDepth: 16,
        drive: 1.2,
      };
    case 'hit':
    default:
      return {
        seed,
        durationSec: 0.22,
        sampleRate: 44100,
        transientGain: 0.85,
        transientDecayMs: 12,
        transientFreqHz: 1300,
        bodyGain: 0.75,
        bodyShape: 'triangle',
        bodyStartHz: 320,
        bodyEndHz: 70,
        bodyAttackMs: 1,
        bodyDecayMs: 105,
        fmRatio: 0,
        fmDepth: 0,
        noiseGain: 0.55,
        noiseDecayMs: 110,
        filterStartHz: 3800,
        filterEndHz: 520,
        filterQ: 1.6,
        bitDepth: 16,
        drive: 2.0,
      };
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
 * Phase 1: Plans a validated `EntityDirectorBlueprint` from a single natural-language prompt
 * using Gemini Flash JSON `responseSchema` or deterministic Offline Mock planning ($0.00).
 */
export async function draftEntityBlueprint(params: {
  readonly prompt: string;
  readonly genre: EntityGenrePreset;
  readonly artBible: ArtBible;
  readonly providerConfig: ProviderConfig;
  readonly signal?: AbortSignal;
}): Promise<DraftBlueprintResult> {
  const { prompt, genre, artBible, providerConfig, signal } = params;
  throwIfAborted(signal);

  if (providerConfig.kind !== 'gemini') {
    const blueprint = buildMockEntityBlueprint(prompt, genre);
    return {
      blueprint,
      costEstimate: estimateDirectorCost(providerConfig.kind, blueprint, true),
      usedMock: true,
    };
  }

  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const textModel = resolveParallaxTextModelId(providerConfig.modelId);
  const url = `${baseUrl}/models/${encodeURIComponent(textModel)}:generateContent`;
  const paletteStr =
    artBible.palette.length > 0 ? artBible.palette.join(', ') : '#1A1C2C, #EF7D57, #FFCD75';

  const plannerPrompt = [
    `You are Nibgrid's Prompt-to-Entity Director for Godot 4.`,
    `User entity request: "${prompt.trim()}"`,
    `Target game genre: ${genre}`,
    `Project Art Bible: ${artBible.artMode}, projection=${artBible.projection}, lighting=${artBible.lighting}, targetSize=${artBible.targetWidth}x${artBible.targetHeight}, palette=[${paletteStr}].`,
    `Return ONLY structured JSON matching the schema. Normalize socket anchors normX/normY cleanly inside [0.1, 0.9] relative to sprite opaque bounds.`,
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
          responseSchema: ENTITY_BLUEPRINT_GEMINI_RESPONSE_SCHEMA,
          temperature: 0.2,
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
    const parsedJson = JSON.parse(rawText) as unknown;
    const blueprint = parseAndClampDirectorBlueprint(parsedJson, prompt, genre);

    return {
      blueprint,
      costEstimate: estimateDirectorCost(providerConfig.kind, blueprint, true),
      usedMock: false,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof ProviderError) throw err;
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: providerConfig.endpointUrl,
      secrets: [providerConfig.apiKey],
    });
  }
}

async function generateSpritePngBytes(
  blueprint: EntityDirectorBlueprint,
  artBible: ArtBible,
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  throwIfAborted(signal);
  const w = artBible.targetWidth;
  const h = artBible.targetHeight;

  if (providerConfig.kind !== 'gemini') {
    if (blueprint.turnaroundLayout === '2x2') {
      const sheet = synthesizeProceduralTurnaroundSheet({
        layout: '2x2',
        palette: artBible.palette,
        seedKey: `${blueprint.slug}|${blueprint.spritePrompt}`,
        variantIndex: 0,
      });
      return encodeRgbaToPngBytes(sheet.rgba, sheet.width, sheet.height);
    }

    const blankSketch = new Uint8ClampedArray(w * h * 4);
    const rgba = synthesizeProceduralSprite({
      sketchRgba: blankSketch,
      width: w,
      height: h,
      palette: artBible.palette,
      lighting: artBible.lighting,
      artMode: artBible.artMode,
      adherence: 'balanced',
      seedKey: `${blueprint.slug}|${blueprint.spritePrompt}`,
      variantIndex: 0,
    });
    return encodeRgbaToPngBytes(rgba, w, h);
  }

  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const imageModel = providerConfig.modelId.trim() || 'gemini-2.5-flash-image';
  const url = `${baseUrl}/models/${encodeURIComponent(imageModel)}:generateContent`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': providerConfig.apiKey.trim(),
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `${blueprint.spritePrompt}. Style: ${artBible.stylePrompt}. Isolated centered 2D sprite on flat solid chroma background, ${w}x${h}.`,
              },
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['IMAGE'],
        },
      }),
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw { status: res.status, responseText: text };
    }

    const json = (await res.json()) as GeminiGenerateContentResponse;
    const { base64 } = extractImageBase64FromGeminiResponse(json);
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof ProviderError) throw err;
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: providerConfig.endpointUrl,
      secrets: [providerConfig.apiKey],
    });
  }
}

async function generateAiGdScript(
  blueprint: EntityDirectorBlueprint,
  providerConfig: ProviderConfig,
  signal?: AbortSignal,
): Promise<string | null> {
  if (providerConfig.kind !== 'gemini') {
    return null;
  }

  const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
  const textModel = resolveParallaxTextModelId(providerConfig.modelId);
  const url = `${baseUrl}/models/${encodeURIComponent(textModel)}:generateContent`;

  const socketPaths = blueprint.sockets.map((s) => `$Sockets/${s.name}`).join(', ');
  const scriptPrompt = [
    `Write a clean, strictly typed Godot 4.3+ GDScript controller for "${blueprint.displayName}".`,
    `Exact requirements:`,
    `- First line: class_name and second line: extends ${blueprint.bodyType}`,
    `- Use @export, @onready, and typed function signatures (-> void).`,
    `- NEVER use Godot 3 tokens (KinematicBody2D, export var, onready var, yield, or move_and_slide(vel)). Call move_and_slide() with zero args.`,
    `- Exact scene child paths in M25 prefab: $AnimatedSprite2D, $AnimationPlayer${blueprint.sfxSpecs.length > 0 ? ', $Audio/SfxPlayer' : ''}${socketPaths ? `, ${socketPaths}` : ''}.`,
    `- Behavior archetype=${blueprint.behavior.archetype}, move_speed=${blueprint.behavior.moveSpeed}, max_health=${blueprint.behavior.maxHealth}, attack_damage=${blueprint.behavior.attackDamage}, states=[${blueprint.behavior.states.join(', ')}].`,
    `Return ONLY valid GDScript code.`,
  ].join('\n');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': providerConfig.apiKey.trim(),
      },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: scriptPrompt }] }],
        generationConfig: { temperature: 0.15 },
      }),
      signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw { status: res.status, responseText: text };
    }
    const json = (await res.json()) as GeminiGenerateContentResponse;
    return extractTextFromGeminiResponse(json);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    if (err instanceof ProviderError) throw err;
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: providerConfig.endpointUrl,
      secrets: [providerConfig.apiKey],
    });
  }
}

/**
 * Phase 2 & 3: Executes the full abortable multi-stage Entity synthesis pipeline and commits
 * `SpriteNode`, `AudioAsset[]`, typed `.gd` script, and M25 `EntityDefinition` atomically.
 * On abort or failure, cleans up all newly created temporary blobs so zero orphans remain.
 */
export async function executeEntityDirectorPlan(
  database: NibgridDatabase,
  projectId: string,
  blueprint: EntityDirectorBlueprint,
  options: ExecuteDirectorOptions,
): Promise<ExecuteDirectorResult> {
  const repo = new NibgridRepository(database);
  const project = await repo.getProject(projectId);
  if (!project) {
    throw new Error(`Project "${projectId}" not found.`);
  }

  const {
    providerConfig,
    generateGdScript = true,
    resSubpath = 'assets/nibgrid',
    signal,
    onProgress,
  } = options;
  const createdBlobIds: string[] = [];

  const report = (stage: DirectorStageId, status: DirectorStageStatus, detail?: string) => {
    onProgress?.({ stage, status, detail });
  };

  try {
    throwIfAborted(signal);

    // Stage 1: Sprite Generation + M7 Post-Process
    report('sprite', 'running', `Generating ${blueprint.slug} sprite...`);
    const rawPngBytes = await generateSpritePngBytes(
      blueprint,
      project.artBible,
      providerConfig,
      signal,
    );
    throwIfAborted(signal);

    const rawCopy = new Uint8Array(rawPngBytes.byteLength);
    rawCopy.set(rawPngBytes);
    const rawBlob = await repo.storeBlob(
      new Blob([rawCopy.buffer], { type: 'image/png' }),
      'image/png',
    );
    createdBlobIds.push(rawBlob.id);

    const decodedRaw = await decodePngBytesToRgba(rawPngBytes);
    const ppConfig = {
      ...createDefaultPostProcessConfig(
        project.artBible.targetWidth,
        project.artBible.targetHeight,
      ),
      bgRemoval: 'color-key' as const,
      bgTolerance: 26,
      paletteSnap: project.artBible.palette.length > 0,
      selOutMode: project.artBible.artMode === 'pixel-art' ? ('outer' as const) : ('off' as const),
      resampleEnabled: true,
      resampleMode:
        project.artBible.artMode === 'pixel-art' ? ('nearest' as const) : ('area' as const),
    };
    const processed = runPostProcessPipeline(
      decodedRaw.rgba,
      decodedRaw.width,
      decodedRaw.height,
      ppConfig,
      project.artBible.palette,
    );
    const processedBuf = {
      width: processed.width,
      height: processed.height,
      data: processed.rgba,
    };
    const processedPngBytes = encodeRgbaToPngBytes(
      processedBuf.data,
      processedBuf.width,
      processedBuf.height,
    );
    const procCopy = new Uint8Array(processedPngBytes.byteLength);
    procCopy.set(processedPngBytes);
    const procBlob = await repo.storeBlob(
      new Blob([procCopy.buffer], { type: 'image/png' }),
      'image/png',
    );
    createdBlobIds.push(procBlob.id);

    report('sprite', 'done', `${processedBuf.width}×${processedBuf.height}`);
    throwIfAborted(signal);

    // Stage 2: M16 Auto-Trace Collider (+ optional Hurtbox & Hitbox)
    report('collider', 'running', 'Tracing collision hull...');
    const pivotPx = {
      x: ppConfig.pivotNorm.x * processedBuf.width,
      y: ppConfig.pivotNorm.y * processedBuf.height,
    };
    const colliderKind = blueprint.colliderMode === 'rect' ? 'aabb' : blueprint.colliderMode;
    const traced = extractCollisionHull(processedBuf, {
      kind: colliderKind,
      epsilonPx: 1.8,
      maxVertices: 8,
      pivotPx,
    });
    const bounds = computeOpaqueBounds(
      processedBuf.data,
      processedBuf.width,
      processedBuf.height,
      16,
    );

    const collisionShapes: CollisionLayerShape[] = [
      {
        id: globalThis.crypto.randomUUID(),
        name: 'Collider',
        layer: 'collider',
        kind: traced.kind,
        isSensor: false,
        visible: true,
        vertices: [...traced.vertices],
        ...(traced.capsule ? { capsule: traced.capsule } : {}),
      },
    ];

    if (blueprint.includeHurtbox) {
      collisionShapes.push({
        id: globalThis.crypto.randomUUID(),
        name: 'Hurtbox',
        layer: 'hurtbox',
        kind: 'aabb',
        isSensor: true,
        visible: true,
        vertices: [
          {
            x: Number((bounds.minX - pivotPx.x).toFixed(2)),
            y: Number((bounds.minY - pivotPx.y).toFixed(2)),
          },
          {
            x: Number((bounds.maxX - pivotPx.x).toFixed(2)),
            y: Number((bounds.minY - pivotPx.y).toFixed(2)),
          },
          {
            x: Number((bounds.maxX - pivotPx.x).toFixed(2)),
            y: Number((bounds.maxY - pivotPx.y).toFixed(2)),
          },
          {
            x: Number((bounds.minX - pivotPx.x).toFixed(2)),
            y: Number((bounds.maxY - pivotPx.y).toFixed(2)),
          },
        ],
      });
    }

    if (blueprint.includeHitbox) {
      collisionShapes.push({
        id: globalThis.crypto.randomUUID(),
        name: 'Hitbox',
        layer: 'hitbox',
        kind: 'aabb',
        isSensor: true,
        visible: true,
        activeFrames: [1, 2],
        vertices: [
          { x: 0, y: Number((bounds.minY - pivotPx.y).toFixed(2)) },
          {
            x: Number((bounds.maxX + 10 - pivotPx.x).toFixed(2)),
            y: Number((bounds.minY - pivotPx.y).toFixed(2)),
          },
          {
            x: Number((bounds.maxX + 10 - pivotPx.x).toFixed(2)),
            y: Number((bounds.maxY - pivotPx.y).toFixed(2)),
          },
          { x: 0, y: Number((bounds.maxY - pivotPx.y).toFixed(2)) },
        ],
      });
    }

    report('collider', 'done', `${collisionShapes.length} collision layer(s)`);
    throwIfAborted(signal);

    // Stage 3: M21 Named Sockets Snapped to Opaque Bounds
    report('sockets', 'running', 'Snapping named sockets...');
    const sockets = resolveSocketHintsToPixels(bounds, blueprint.sockets);
    report('sockets', 'done', `${sockets.length} socket(s)`);
    throwIfAborted(signal);

    // Stage 4: M14/M15 SFX Pack + LUFS Trim
    report('sfx', 'running', `Synthesizing ${blueprint.sfxSpecs.length} SFX cue(s)...`);
    const audioAssets: AudioAsset[] = [];
    const baseAudioPp = createDefaultAudioPostProcessConfig();
    const sfxPp = {
      ...baseAudioPp,
      trimSilence: true,
      normalizeLufs: true,
      targetLufs: -14,
    };

    for (let i = 0; i < blueprint.sfxSpecs.length; i++) {
      throwIfAborted(signal);
      const spec = blueprint.sfxSpecs[i]!;
      const synthParams = buildSfxPresetParams(spec.proceduralPreset, 2000 + i * 137);
      const rawPcm = synthesizeProceduralSfx(synthParams);
      const ppResult = runAudioPostProcessPipeline(rawPcm, sfxPp);
      const wavBytes = encodeWav16(ppResult.buffer);
      const wavCopy = new Uint8Array(wavBytes.byteLength);
      wavCopy.set(wavBytes);
      const wavBlob = await repo.storeBlob(
        new Blob([wavCopy.buffer], { type: 'audio/wav' }),
        'audio/wav',
      );
      createdBlobIds.push(wavBlob.id);

      audioAssets.push(
        AudioAssetSchema.parse({
          id: globalThis.crypto.randomUUID(),
          projectId,
          name: `${blueprint.slug}_${spec.cueName}`,
          presetId: `director-${spec.proceduralPreset ?? 'hit'}`,
          route: 'local-synth',
          modelId: 'nibgrid-procedural-sfx-v1',
          wavBlobId: wavBlob.id,
          variationBlobIds: [],
          synthParams,
          postProcess: sfxPp,
          lufs: ppResult.outputLufs,
          durationSec: Number(
            (ppResult.buffer.samples.length / ppResult.buffer.sampleRate).toFixed(3),
          ),
          createdAt: new Date().toISOString(),
        }),
      );
    }

    report('sfx', 'done', `${audioAssets.length} WAV clip(s)`);
    throwIfAborted(signal);

    // Stage 5: Typed Godot 4.3+ GDScript Generation
    let scriptCode = '';
    let usedGdScriptFallback = false;
    if (generateGdScript) {
      report('gdscript', 'running', 'Compiling typed Godot 4.3+ GDScript...');
      const aiScript = await generateAiGdScript(blueprint, providerConfig, signal);
      throwIfAborted(signal);
      const compiled = validateAndCompileGdScript(aiScript, blueprint);
      scriptCode = compiled.code;
      usedGdScriptFallback = compiled.usedFallback;
      report('gdscript', 'done', usedGdScriptFallback ? 'Typed fallback' : 'GenAI typed');
    } else {
      report('gdscript', 'done', 'Skipped');
    }
    throwIfAborted(signal);

    // Stage 6: Atomic M25 Entity Commit
    report('commit', 'running', 'Committing Entity, SpriteNode & AudioAssets...');
    const nowIsoStr = new Date().toISOString();
    const sketchSha256 = await sha256Bytes(rawPngBytes);
    const cleanSlug = sanitizeEntitySlug(blueprint.slug);
    const cleanSubpath = normalizeResSubpath(resSubpath);

    const spriteNode = SpriteNodeSchema.parse({
      id: globalThis.crypto.randomUUID(),
      projectId,
      parentId: null,
      kind: 'generation',
      assetClass: blueprint.bodyType === 'Area2D' ? 'prop' : 'character',
      imageBlobId: rawBlob.id,
      processedBlobId: procBlob.id,
      postProcessConfig: ppConfig,
      collisionShapes,
      sockets,
      recipeArtBibleHash: computeArtBibleHash(project.artBible),
      sketchSha256,
      generationMeta: {
        providerId: providerConfig.id,
        modelId: providerConfig.modelId,
        seed: 2600,
        adherence: 'balanced',
        promptDelta: blueprint.spritePrompt,
        compiledPrompt: blueprint.spritePrompt,
        createdAt: nowIsoStr,
      },
    });

    const primaryAudioId = audioAssets[0]?.id;
    const entity = EntityDefinitionSchema.parse({
      id: globalThis.crypto.randomUUID(),
      projectId,
      slug: cleanSlug,
      displayName: blueprint.displayName,
      bodyType: blueprint.bodyType,
      resSubpath: cleanSubpath,
      primarySpriteNodeId: spriteNode.id,
      clips: [
        {
          name: 'idle',
          spriteNodeId: spriteNode.id,
          fps: 8,
          loop: true,
          ...(primaryAudioId ? { frameAudioTriggers: { '0': primaryAudioId } } : {}),
        },
      ],
      audioAssetIds: audioAssets.map((a) => a.id),
      includeNormalMap: blueprint.generateNormalMap,
      ...(generateGdScript
        ? { scriptResPath: `res://${cleanSubpath}/${cleanSlug}/${cleanSlug}.gd` }
        : {}),
      ...(scriptCode ? { scriptContent: scriptCode } : {}),
      updatedAt: Date.now(),
    });

    await database.transaction(
      'rw',
      [database.spriteNodes, database.audioAssets, database.entities, database.projects],
      async () => {
        await database.spriteNodes.put(spriteNode);
        for (const audio of audioAssets) {
          await database.audioAssets.put(audio);
        }
        await database.entities.put(entity);
        await database.projects.where('id').equals(projectId).modify({ updatedAt: nowIsoStr });
      },
    );

    report('commit', 'done', `${cleanSlug}.tscn ready`);
    return {
      entity,
      spriteNode,
      audioAssets,
      scriptCode,
      usedGdScriptFallback,
    };
  } catch (err) {
    // Roll back any temporary blobs created before failure or abort so 0 orphans remain
    if (createdBlobIds.length > 0) {
      await database.blobs.bulkDelete(createdBlobIds);
      await repo.cleanupOrphanedBlobs();
    }
    throw err;
  }
}
