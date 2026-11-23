import { repository } from '../db/database';
import { createDefaultPostProcessConfig, type ArtBible, type SpriteNode } from '../domain/schemas';
import { composeSpritesheetStrip, encodeAnimatedGif, type GifFrameInput } from '../processing/gif';
import { runPostProcessPipeline } from '../processing/pipeline';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../processing/png';

export interface AnimationBuildOptions {
  targetSize: number;
  autoCutout: boolean;
  tolerance: number;
  paletteSnap: boolean;
  fps: number;
  pingPong: boolean;
}

export interface DecodedRgbaImage {
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface SpriteAnimationArtifacts {
  frames: GifFrameInput[];
  gifBytes: Uint8Array;
  spritesheetPngBytes: Uint8Array;
  width: number;
  height: number;
}

function hasAnyTransparentPixel(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if ((rgba[i] ?? 255) < 255) return true;
  }
  return false;
}

export async function decodeBlobToNativeRgba(blob: Blob): Promise<DecodedRgbaImage> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  try {
    return await decodePngBytesToRgba(bytes);
  } catch {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    try {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D context unavailable');
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      return {
        rgba: new Uint8ClampedArray(data.data),
        width: bitmap.width,
        height: bitmap.height,
      };
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

/**
 * Selects default ordered animation source nodes (all generation/inpaint nodes chronologically,
 * falling back to root sketch if no generated nodes exist yet).
 */
export function selectDefaultAnimationNodeIds(nodes: readonly SpriteNode[]): string[] {
  const synthesized = nodes.filter((n) => n.kind !== 'sketch');
  const source = synthesized.length > 0 ? synthesized : nodes;
  return source.map((n) => n.id);
}

/**
 * Builds deterministic animated GIF89a bytes and a horizontal PNG spritesheet strip
 * from a sequence of DAG sprite nodes using the shared post-processing pipeline.
 */
export async function buildSpriteAnimationArtifacts(
  orderedNodes: readonly SpriteNode[],
  artBible: ArtBible,
  options: AnimationBuildOptions,
): Promise<SpriteAnimationArtifacts> {
  if (orderedNodes.length === 0) {
    throw new Error('Select at least one sprite frame to build an animation.');
  }

  const targetDim = Math.max(16, Math.min(512, Math.round(options.targetSize)));
  const frames: GifFrameInput[] = [];

  for (const node of orderedNodes) {
    const blobRecord = await repository.getBlob(node.imageBlobId);
    if (!blobRecord) {
      throw new Error(`Missing blob for sprite node ${node.id}`);
    }
    const decoded = await decodeBlobToNativeRgba(blobRecord.bytes);
    const alreadyCutout = hasAnyTransparentPixel(decoded.rgba);
    const baseCfg = createDefaultPostProcessConfig(targetDim, targetDim);
    const useColorKey = options.autoCutout && !alreadyCutout;

    const processed = runPostProcessPipeline(
      decoded.rgba,
      decoded.width,
      decoded.height,
      {
        ...baseCfg,
        bgRemoval: useColorKey ? 'color-key' : 'none',
        bgTolerance: options.tolerance,
        bgContiguous: true,
        defringe: useColorKey,
        paletteSnap: options.paletteSnap && artBible.palette.length > 0,
        resampleEnabled: decoded.width !== targetDim || decoded.height !== targetDim,
        resampleMode: artBible.artMode === 'pixel-art' ? 'nearest' : 'area',
        targetWidth: targetDim,
        targetHeight: targetDim,
      },
      artBible.palette,
    );

    frames.push({
      rgba: processed.rgba,
      width: processed.width,
      height: processed.height,
    });
  }

  const gifBytes = encodeAnimatedGif(frames, {
    fps: options.fps,
    loop: true,
    pingPong: options.pingPong,
  });
  const strip = composeSpritesheetStrip(frames);
  const spritesheetPngBytes = encodeRgbaToPngBytes(strip.rgba, strip.width, strip.height);

  return {
    frames,
    gifBytes,
    spritesheetPngBytes,
    width: targetDim,
    height: targetDim,
  };
}
