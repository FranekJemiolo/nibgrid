import type { ArtMode } from '../../domain/schemas';
import { useBlobUrl } from './blobUrlCache';

interface BlobImageProps {
  blobId: string;
  alt: string;
  artMode?: ArtMode;
  className?: string;
  testId?: string;
}

export function BlobImage({
  blobId,
  alt,
  artMode = 'pixel-art',
  className = '',
  testId,
}: BlobImageProps) {
  const { objectUrl, missing } = useBlobUrl(blobId);

  if (missing) {
    return (
      <div
        data-testid={testId}
        className={`flex items-center justify-center bg-slate-800 text-[10px] text-rose-400 ${className}`}
      >
        Missing Blob
      </div>
    );
  }

  if (!objectUrl) {
    return (
      <div
        data-testid={testId}
        className={`animate-pulse bg-slate-800/80 ${className}`}
        aria-label={alt}
      />
    );
  }

  return (
    <img
      data-testid={testId}
      src={objectUrl}
      alt={alt}
      className={className}
      style={{ imageRendering: artMode === 'pixel-art' ? 'pixelated' : 'auto' }}
    />
  );
}
