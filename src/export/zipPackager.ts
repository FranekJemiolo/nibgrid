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
}

/**
 * Bundles `<slug>.png` and `<slug>.recipe.json` into a standard ZIP archive using `fflate`.
 */
export function packageSpriteZip(input: PackageSpriteZipInput): Uint8Array {
  const pngFilename = `${input.slug}.png`;
  const recipeFilename = `${input.slug}.recipe.json`;
  const recipeJson = `${JSON.stringify(input.recipe, null, 2)}\n`;

  return zipSync(
    {
      [pngFilename]: input.pngBytes,
      [recipeFilename]: strToU8(recipeJson),
    },
    { level: 6 },
  );
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
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
