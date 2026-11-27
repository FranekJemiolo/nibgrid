import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface Sha256ManifestEntry {
  readonly filename: string;
  readonly sha256: string;
  readonly bytes: number;
}

export interface Sha256ManifestResult {
  readonly entries: readonly Sha256ManifestEntry[];
  readonly manifestText: string;
}

/**
 * Computes deterministic alphabetical SHA-256 digests (`<hex>  <filename>`) across
 * top-level release files inside `dirPath`.
 */
export async function generateSha256Manifest(
  dirPath: string,
  opts: { readonly excludeNames?: readonly string[] } = {},
): Promise<Sha256ManifestResult> {
  const root = resolve(dirPath);
  const excluded = new Set(opts.excludeNames ?? ['SHA256SUMS.txt']);
  const dirEntries = await readdir(root, { withFileTypes: true });

  const fileNames = dirEntries
    .filter((entry) => entry.isFile() && !excluded.has(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  const entries: Sha256ManifestEntry[] = [];
  for (const filename of fileNames) {
    const bytes = new Uint8Array(await readFile(join(root, filename)));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    entries.push({ filename, sha256, bytes: bytes.byteLength });
  }

  const lines = entries.map((e) => `${e.sha256}  ${e.filename}`);
  const manifestText = lines.length > 0 ? `${lines.join('\n')}\n` : '';

  return { entries, manifestText };
}

export async function writeSha256Manifest(
  dirPath: string,
  outPath = join(resolve(dirPath), 'SHA256SUMS.txt'),
): Promise<Sha256ManifestResult & { readonly outPath: string }> {
  const res = await generateSha256Manifest(dirPath);
  const resolvedOut = resolve(outPath);
  await writeFile(resolvedOut, res.manifestText, 'utf8');
  return { ...res, outPath: resolvedOut };
}

const isCliMain =
  typeof process !== 'undefined' &&
  Boolean(process.argv[1]) &&
  pathToFileURL(resolve(process.argv[1]!)).href === import.meta.url;

if (isCliMain) {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const dirPath = dirIdx >= 0 && args[dirIdx + 1] ? args[dirIdx + 1]! : process.cwd();
  const outIdx = args.indexOf('--out');
  const outPath =
    outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : join(resolve(dirPath), 'SHA256SUMS.txt');

  const result = await writeSha256Manifest(dirPath, outPath);
  console.log(
    JSON.stringify({
      ok: true,
      outPath: result.outPath,
      fileCount: result.entries.length,
    }),
  );
}
