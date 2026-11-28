import { encodeWav16 } from '../audio/pcmPostProcess';
import { synthesizeProceduralSfx } from '../audio/proceduralSynth';
import type { ProceduralSfxParams } from '../audio/types';
import type { GodotBodyType } from '../domain/entitySchema';
import {
  CollisionLayerShapeSchema,
  createDefaultAutoTileConfig,
  createDefaultPostProcessConfig,
  createDefaultShaderConfig,
  createDefaultUiKitConfig,
  createDefaultVfxFlipbookConfig,
  type ArtBible,
  type AssetClass,
  type AutoTileConfig,
  type CollisionLayerShape,
  type PostProcessConfig,
  type ShaderConfig,
  type SocketDefinition,
  type UiKitStyleConfigSchemaType,
  type VfxFlipbookConfig,
} from '../domain/schemas';
import { removeBackgroundColorKey } from './backgroundKey';
import { extractCollisionHull } from './collisionHull';
import {
  computeOpaqueBounds,
  resolveSocketHintsToPixels,
  type DirectorSocketHint,
} from './entityDirectorBlueprint';
import {
  bakeEmissionMaskFromRgba,
  bakeNormalMapFromRgba,
  createDefaultEmissionBakeConfig,
  createDefaultNormalBakeConfig,
  type EmissionBakeConfig,
  type NormalBakeConfig,
} from './normalEmissionBaker';
import { runAutoPixelPolishPipeline } from './pixelPolish';
import { encodeRgbaToPngBytes } from './png';
import type { RgbaBuffer } from './types';

export interface ZeroTouchAssetInput {
  readonly spriteRgba: RgbaBuffer;
  readonly assetClass: AssetClass;
  readonly slug: string;
  readonly displayName: string;
  readonly artBible: ArtBible;
  readonly bodyType?: GodotBodyType;
  readonly seed?: number;
  readonly normalStrength?: number;
  readonly colliderMaxVertices?: number;
}

export interface ZeroTouchAssetResult {
  readonly width: number;
  readonly height: number;
  readonly processedRgba: Uint8ClampedArray;
  readonly processedPngBytes: Uint8Array;
  readonly normalPngBytes: Uint8Array;
  readonly emissionPngBytes: Uint8Array;
  readonly emissivePixelCount: number;
  readonly normalConfig: NormalBakeConfig;
  readonly emissionConfig: EmissionBakeConfig;
  readonly sfxWavBytes: Uint8Array;
  readonly sfxParams: ProceduralSfxParams;
  readonly sfxDurationSec: number;
  readonly collisionShapes: readonly CollisionLayerShape[];
  readonly sockets: readonly SocketDefinition[];
  readonly shaderConfig: ShaderConfig;
  readonly postProcessConfig: PostProcessConfig;
  readonly autoTile?: AutoTileConfig;
  readonly uiKitConfig?: UiKitStyleConfigSchemaType;
  readonly vfxFlipbook?: VfxFlipbookConfig;
  readonly summarySteps: readonly string[];
}

function hasOpaqueBorderCorners(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  if (width < 2 || height < 2) return false;
  const corners = [
    0,
    (width - 1) * 4,
    (height - 1) * width * 4,
    ((height - 1) * width + (width - 1)) * 4,
  ];
  let opaqueCorners = 0;
  for (const idx of corners) {
    if ((rgba[idx + 3] ?? 0) >= 200) {
      opaqueCorners++;
    }
  }
  return opaqueCorners >= 3;
}

function buildSocketHintsForClass(assetClass: AssetClass): readonly DirectorSocketHint[] {
  if (assetClass === 'character') {
    return [
      { name: 'feet', normX: 0.5, normY: 0.96, baseAngleDeg: 0 },
      { name: 'center', normX: 0.5, normY: 0.5, baseAngleDeg: 0 },
      { name: 'hand_r', normX: 0.78, normY: 0.56, baseAngleDeg: 0 },
      { name: 'head', normX: 0.5, normY: 0.16, baseAngleDeg: 0 },
    ];
  }
  if (assetClass === 'vfx') {
    return [{ name: 'center', normX: 0.5, normY: 0.5, baseAngleDeg: 0 }];
  }
  return [
    { name: 'center', normX: 0.5, normY: 0.5, baseAngleDeg: 0 },
    { name: 'origin', normX: 0.5, normY: 0.95, baseAngleDeg: 0 },
  ];
}

function buildAutoSfxParams(assetClass: AssetClass, seed: number): ProceduralSfxParams {
  const isImpact = assetClass === 'character' || assetClass === 'vfx';
  return {
    seed: Math.max(1, Math.round(seed)),
    durationSec: isImpact ? 0.28 : 0.2,
    sampleRate: 44100,
    transientGain: isImpact ? 0.65 : 0.4,
    transientDecayMs: 14,
    transientFreqHz: assetClass === 'ui-panel' ? 1100 : 520,
    bodyGain: 0.72,
    bodyShape: assetClass === 'ui-panel' ? 'sine' : 'triangle',
    bodyStartHz: assetClass === 'ui-panel' ? 660 : 320,
    bodyEndHz: assetClass === 'ui-panel' ? 880 : 110,
    bodyAttackMs: 4,
    bodyDecayMs: 160,
    fmRatio: 1.5,
    fmDepth: 95,
    noiseGain: assetClass === 'vfx' ? 0.45 : 0.2,
    noiseDecayMs: 85,
    filterStartHz: 3200,
    filterEndHz: 750,
    filterQ: 1.8,
    bitDepth: 12,
    drive: 1.3,
  };
}

/**
 * Class-driven zero-touch deterministic ($0.00) asset assembly pipeline.
 * Takes a raw sprite buffer and runs Cutout -> Pixel Polish -> OKLab Palette Lock ->
 * Normal & Emission Bake -> Convex Hull / Hurtbox / Hitbox -> Opaque-Bound Sockets ->
 * Hit-Flash Shader -> Procedural SFX -> Class-Specific Configs.
 */
export function runZeroTouchAssetPipeline(input: ZeroTouchAssetInput): ZeroTouchAssetResult {
  const { width, height } = input.spriteRgba;
  const summarySteps: string[] = [];

  // 1. Cutout if solid backdrop corners exist
  let workingRgba: Uint8ClampedArray = new Uint8ClampedArray(input.spriteRgba.data);
  if (input.assetClass !== 'tile' && hasOpaqueBorderCorners(workingRgba, width, height)) {
    workingRgba = removeBackgroundColorKey(workingRgba, width, height, {
      contiguous: true,
      tolerance: 14,
    });
    summarySteps.push('Cutout');
  }

  // 2. Pixel Polish + ArtBible OKLab Palette Quantization
  const paletteHex =
    input.artBible.palette.length > 0 ? input.artBible.palette : ['#1A1C2C', '#FFCD75'];
  const polished = runAutoPixelPolishPipeline(workingRgba, width, height, paletteHex, {
    dither: 'none',
    minNeighbors: input.assetClass === 'tile' ? 1 : 2,
  });
  summarySteps.push('Palette Lock');

  const pivotNorm = input.assetClass === 'character' ? { x: 0.5, y: 1.0 } : { x: 0.5, y: 0.5 };
  const pivotPx = {
    x: Math.round(pivotNorm.x * width),
    y: Math.round(pivotNorm.y * height),
  };

  // 3. Normal Map & Emission Mask Bake (M44)
  const normalConfig: NormalBakeConfig = {
    ...createDefaultNormalBakeConfig(),
    strength: input.normalStrength ?? 1.6,
    sharpenPixelArt: input.artBible.artMode === 'pixel-art',
  };
  const emissionConfig: EmissionBakeConfig = {
    ...createDefaultEmissionBakeConfig(),
    mode: 'luminance-threshold',
    minLuminance: 0.72,
    minSaturation: 0.45,
  };
  const normalRgba = bakeNormalMapFromRgba(polished.data, width, height, normalConfig);
  const emissionRes = bakeEmissionMaskFromRgba(polished.data, width, height, emissionConfig);
  summarySteps.push('Normal & Emission');

  // 4. Collision Hull + Semantic Hurtbox / Hitbox (M16)
  const maxVerts = input.colliderMaxVertices ?? 8;
  const hull = extractCollisionHull(
    { width, height, data: polished.data },
    {
      kind: 'convex-hull',
      maxVertices: maxVerts,
      pivotPx,
    },
  );

  const bounds = computeOpaqueBounds(polished.data, width, height);
  const relLeft = bounds.minX - pivotPx.x;
  const relRight = bounds.maxX + 1 - pivotPx.x;
  const relTop = bounds.minY - pivotPx.y;
  const relBottom = bounds.maxY + 1 - pivotPx.y;
  const rectVerts = [
    { x: relLeft, y: relTop },
    { x: relRight, y: relTop },
    { x: relRight, y: relBottom },
    { x: relLeft, y: relBottom },
  ];

  const fallbackVerts = hull.vertices.length >= 3 ? hull.vertices : rectVerts;
  const collisionShapes: CollisionLayerShape[] = [
    CollisionLayerShapeSchema.parse({
      id: `col_${input.slug}_body`,
      name: `${input.displayName} Body`,
      layer: 'collider',
      kind: hull.vertices.length >= 3 ? hull.kind : 'aabb',
      isSensor: false,
      visible: true,
      vertices: fallbackVerts.map((v) => ({ x: v.x, y: v.y })),
      autoTraceMeta: { epsilonPx: 1.25, maxVertices: maxVerts },
    }),
  ];

  if (input.assetClass === 'character' || input.assetClass === 'prop') {
    collisionShapes.push(
      CollisionLayerShapeSchema.parse({
        id: `hurt_${input.slug}`,
        name: `${input.displayName} Hurtbox`,
        layer: 'hurtbox',
        kind: 'aabb',
        isSensor: true,
        visible: true,
        vertices: rectVerts,
      }),
    );
  }

  if (input.assetClass === 'character') {
    const reachW = Math.max(8, Math.round(bounds.width * 0.55));
    const attackTop = Math.round(relTop + bounds.height * 0.2);
    const attackBottom = Math.round(relTop + bounds.height * 0.75);
    collisionShapes.push(
      CollisionLayerShapeSchema.parse({
        id: `hit_${input.slug}`,
        name: `${input.displayName} Hitbox`,
        layer: 'hitbox',
        kind: 'aabb',
        isSensor: true,
        visible: true,
        activeFrames: [1, 2],
        vertices: [
          { x: 0, y: attackTop },
          { x: reachW, y: attackTop },
          { x: reachW, y: attackBottom },
          { x: 0, y: attackBottom },
        ],
      }),
    );
  }
  summarySteps.push('Collider');

  // 5. Opaque-Bound Semantic Sockets (M21/M26)
  const sockets = resolveSocketHintsToPixels(bounds, buildSocketHintsForClass(input.assetClass));
  summarySteps.push('Sockets');

  // 6. Godot 4 Shader & PostProcess Config
  const shaderConfig = createDefaultShaderConfig('hit_flash');
  const postProcessConfig: PostProcessConfig = {
    ...createDefaultPostProcessConfig(width, height),
    bgRemoval: 'color-key',
    bgTolerance: 14,
    bgContiguous: true,
    defringe: true,
    paletteSnap: paletteHex.length > 0,
    bayerDither: false,
    demixelEnabled: true,
    demixelMode: 'auto',
    orphanCleanEnabled: true,
    maxIslandPixels: 2,
    removeInteriorSpecks: true,
    selOutMode: 'outer',
    selOutLighting: input.artBible.lighting,
    pivotNorm,
  };
  summarySteps.push('Shader');

  // 7. Procedural SFX
  const sfxParams = buildAutoSfxParams(input.assetClass, input.seed ?? 1047);
  const sfxPcm = synthesizeProceduralSfx(sfxParams);
  const sfxWavBytes = encodeWav16(sfxPcm);
  const sfxDurationSec = Number(
    (sfxPcm.samples.length / Math.max(1, sfxPcm.sampleRate)).toFixed(3),
  );
  summarySteps.push('SFX');

  // 8. Class-specific configs
  const autoTile = input.assetClass === 'tile' ? createDefaultAutoTileConfig() : undefined;
  const uiKitConfig = input.assetClass === 'ui-panel' ? createDefaultUiKitConfig() : undefined;
  const vfxFlipbook = input.assetClass === 'vfx' ? createDefaultVfxFlipbookConfig() : undefined;

  return {
    width,
    height,
    processedRgba: polished.data,
    processedPngBytes: encodeRgbaToPngBytes(polished.data, width, height),
    normalPngBytes: encodeRgbaToPngBytes(normalRgba, width, height),
    emissionPngBytes: encodeRgbaToPngBytes(emissionRes.rgba, width, height),
    emissivePixelCount: emissionRes.emissivePixelCount,
    normalConfig,
    emissionConfig,
    sfxWavBytes,
    sfxParams,
    sfxDurationSec,
    collisionShapes,
    sockets,
    shaderConfig,
    postProcessConfig,
    ...(autoTile ? { autoTile } : {}),
    ...(uiKitConfig ? { uiKitConfig } : {}),
    ...(vfxFlipbook ? { vfxFlipbook } : {}),
    summarySteps,
  };
}
