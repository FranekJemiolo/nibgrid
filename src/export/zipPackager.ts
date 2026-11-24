import { strToU8, zipSync } from 'fflate';
import type { EvaluatedSocketFrame } from '../processing/attachmentSockets';
import {
  buildParallaxExportFiles,
  type ParallaxExportLayer,
  type ParallaxExportOptions,
} from './parallaxExporters';
import type { AssetRecipe } from './recipeBuilder';
import { buildSocketExportFiles } from './socketExporters';
import { buildVfxExportFiles, type VfxExportMetaOpts } from './vfxExporters';

export function toAssetSlug(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized.length > 0 ? normalized : 'nibgrid-sprite';
}

export interface PackageSpriteZipInput {
  slug: string;
  pngBytes: Uint8Array;
  recipe: AssetRecipe;
  normalPngBytes?: Uint8Array;
  extraFiles?: Record<string, Uint8Array>;
  evaluatedSocketsByFrame?: readonly (readonly EvaluatedSocketFrame[])[];
  socketFps?: number;
  vfxFlipbookBundle?: {
    readonly sheetPngBytes: Uint8Array;
    readonly opts: VfxExportMetaOpts;
    readonly fps?: number;
  };
  parallaxBundle?: {
    readonly layers: readonly ParallaxExportLayer[];
    readonly opts: ParallaxExportOptions;
  };
}

/**
 * Bundles `<slug>.png`, optional `<slug>_n.png`, extra strip/JSON artifacts,
 * optional `<slug>_sockets.json`, and `<slug>.recipe.json` into a ZIP archive via `fflate`.
 */
export function packageSpriteZip(input: PackageSpriteZipInput): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [`${input.slug}.png`]: input.pngBytes,
    [`${input.slug}.recipe.json`]: strToU8(`${JSON.stringify(input.recipe, null, 2)}\n`),
  };
  if (input.normalPngBytes) {
    files[`${input.slug}_n.png`] = input.normalPngBytes;
  }
  if (input.extraFiles) {
    for (const [name, bytes] of Object.entries(input.extraFiles)) {
      files[name] = bytes;
    }
  }

  const sockets = input.recipe.sockets ?? [];
  const socketsFilename = `${input.slug}_sockets.json`;
  if (sockets.length > 0 && !files[socketsFilename]) {
    const pivotPx = input.recipe.output.pivotPx;
    const evaluatedFrames =
      input.evaluatedSocketsByFrame && input.evaluatedSocketsByFrame.length > 0
        ? input.evaluatedSocketsByFrame
        : [
            sockets.map((socket) => ({
              socketId: socket.id,
              name: socket.name,
              frameIndex: 0,
              posPx: socket.restPosPx,
              pivotRelativePx: {
                x: Number((socket.restPosPx.x - pivotPx.x).toFixed(2)),
                y: Number((socket.restPosPx.y - pivotPx.y).toFixed(2)),
              },
              angleDeg: socket.baseAngleDeg,
              boundToMesh: false,
            })),
          ];
    const fps = input.socketFps ?? input.recipe.puppetAnim?.fps ?? 12;
    Object.assign(files, buildSocketExportFiles(input.slug, fps, sockets, evaluatedFrames));
  }

  if (input.vfxFlipbookBundle) {
    Object.assign(
      files,
      buildVfxExportFiles(
        input.slug,
        input.vfxFlipbookBundle.sheetPngBytes,
        input.vfxFlipbookBundle.opts,
        input.vfxFlipbookBundle.fps ?? 16,
      ),
    );
  }

  if (input.parallaxBundle && input.parallaxBundle.layers.length > 0) {
    Object.assign(
      files,
      buildParallaxExportFiles(input.slug, input.parallaxBundle.layers, input.parallaxBundle.opts),
    );
  }

  if (input.parallaxBundle && input.parallaxBundle.layers.length > 0) {
    Object.assign(
      files,
      buildParallaxExportFiles(input.slug, input.parallaxBundle.layers, input.parallaxBundle.opts),
    );
  }

  return zipSync(files, { level: 6 });
}

export function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  window.setTimeout(() => URL.revokeObjectURL(url), 100);
}
