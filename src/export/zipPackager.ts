import { strToU8, zipSync } from 'fflate';
import type { AssetRecipe } from './recipeBuilder';

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
}

/**
 * Bundles `<slug>.png`, optional `<slug>_n.png`, extra strip/JSON artifacts,
 * and `<slug>.recipe.json` into a ZIP archive via `fflate`.
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
