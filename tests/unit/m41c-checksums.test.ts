import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateSha256Manifest, writeSha256Manifest } from '../../scripts/generate-checksums';

describe('M41C: Deterministic SHA256SUMS Release Checksum Generator', () => {
  it('writes sorted SHA-256 digests matching node crypto and excludes pre-existing SHA256SUMS.txt', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nibgrid-m41c-sums-'));
    try {
      const payloadA = 'nibgrid-alpha-binary';
      const payloadB = 'nibgrid-zeta-vsix';
      await writeFile(join(dir, 'z-nibgrid-0.1.0.vsix'), payloadB, 'utf8');
      await writeFile(join(dir, 'a-nibgrid-macos-arm64.tar.gz'), payloadA, 'utf8');
      await writeFile(join(dir, 'SHA256SUMS.txt'), 'stale-content', 'utf8');

      const preview = await generateSha256Manifest(dir);
      expect(preview.entries.map((e) => e.filename)).toEqual([
        'a-nibgrid-macos-arm64.tar.gz',
        'z-nibgrid-0.1.0.vsix',
      ]);

      const expectedHashA = createHash('sha256').update(payloadA).digest('hex');
      const expectedHashB = createHash('sha256').update(payloadB).digest('hex');
      expect(preview.entries[0]?.sha256).toBe(expectedHashA);
      expect(preview.entries[1]?.sha256).toBe(expectedHashB);

      const written = await writeSha256Manifest(dir);
      const diskText = await readFile(written.outPath, 'utf8');
      expect(diskText).toBe(
        `${expectedHashA}  a-nibgrid-macos-arm64.tar.gz\n${expectedHashB}  z-nibgrid-0.1.0.vsix\n`,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
