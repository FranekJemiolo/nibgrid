import { useEffect, useState } from 'react';
import { repository } from '../../db/database';

interface CacheEntry {
  url: string | null;
  refCount: number;
  promise: Promise<string | null>;
}

const cache = new Map<string, CacheEntry>();

export type BlobFetcher = (blobId: string) => Promise<Blob | null>;

const defaultFetcher: BlobFetcher = async (blobId) => {
  const record = await repository.getBlob(blobId);
  return record?.bytes ?? null;
};

/**
 * Reference-counted object URL cache for IndexedDB blobs.
 * Multiple UI views displaying the same blobId share one object URL; when the last
 * consumer releases it, `URL.revokeObjectURL` is called deterministically.
 */
export function acquireBlobUrl(
  blobId: string,
  fetcher: BlobFetcher = defaultFetcher,
): Promise<string | null> {
  const existing = cache.get(blobId);
  if (existing) {
    existing.refCount += 1;
    return existing.promise;
  }

  const entry: CacheEntry = {
    url: null,
    refCount: 1,
    promise: Promise.resolve(null),
  };

  entry.promise = fetcher(blobId).then((blob) => {
    const current = cache.get(blobId);
    if (!blob || !current || current !== entry || current.refCount <= 0) {
      if (current === entry && current.refCount <= 0) {
        cache.delete(blobId);
      }
      return null;
    }

    const url = URL.createObjectURL(blob);
    current.url = url;
    return url;
  });

  cache.set(blobId, entry);
  return entry.promise;
}

export function releaseBlobUrl(blobId: string): void {
  const entry = cache.get(blobId);
  if (!entry) return;

  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
      entry.url = null;
    }
    cache.delete(blobId);
  }
}

export function getActiveBlobUrlCount(): number {
  let active = 0;
  for (const entry of cache.values()) {
    if (entry.url !== null) {
      active += 1;
    }
  }
  return active;
}

export function clearBlobUrlCacheForTests(): void {
  for (const entry of cache.values()) {
    if (entry.url) {
      URL.revokeObjectURL(entry.url);
    }
  }
  cache.clear();
}

export function useBlobUrl(blobId: string): { objectUrl: string | null; missing: boolean } {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setMissing(false);
    setObjectUrl(null);

    void acquireBlobUrl(blobId).then((url) => {
      if (cancelled) return;
      if (!url) {
        setMissing(true);
        setObjectUrl(null);
        return;
      }
      setObjectUrl(url);
    });

    return () => {
      cancelled = true;
      releaseBlobUrl(blobId);
    };
  }, [blobId]);

  return { objectUrl, missing };
}
