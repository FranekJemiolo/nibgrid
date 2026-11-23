import type { AssetRecipe } from './recipeBuilder';

interface FileSystemWritableLike {
  write: (data: BufferSource | Blob | string) => Promise<void>;
  close: () => Promise<void>;
}

interface FileSystemFileHandleLike {
  createWritable: () => Promise<FileSystemWritableLike>;
}

interface FileSystemDirectoryHandleLike {
  name: string;
  getFileHandle: (
    name: string,
    options?: { create?: boolean },
  ) => Promise<FileSystemFileHandleLike>;
}

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandleLike>;
};

export function supportsFileSystemAccess(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
  );
}

export interface ExportToDirectoryInput {
  slug: string;
  pngBytes: Uint8Array;
  recipe: AssetRecipe;
}

/**
 * Writes `<slug>.png` and `<slug>.recipe.json` directly into a user-selected local
 * game project directory via the File System Access API (Chrome/Edge).
 */
export async function exportBundleToDirectory(
  input: ExportToDirectoryInput,
): Promise<{ directoryName: string }> {
  const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker;
  if (!picker) {
    throw new Error(
      'File System Access API (showDirectoryPicker) is only supported in Chromium-based browsers.',
    );
  }

  const dirHandle = await picker({ mode: 'readwrite' });

  const pngHandle = await dirHandle.getFileHandle(`${input.slug}.png`, { create: true });
  const pngWritable = await pngHandle.createWritable();
  const pngCopy = new Uint8Array(input.pngBytes.byteLength);
  pngCopy.set(input.pngBytes);
  await pngWritable.write(pngCopy.buffer);
  await pngWritable.close();

  const recipeHandle = await dirHandle.getFileHandle(`${input.slug}.recipe.json`, {
    create: true,
  });
  const recipeWritable = await recipeHandle.createWritable();
  await recipeWritable.write(`${JSON.stringify(input.recipe, null, 2)}\n`);
  await recipeWritable.close();

  return { directoryName: dirHandle.name };
}
