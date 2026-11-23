import { useEffect, useState } from 'react';
import { repository } from '../../db/database';

interface BlobImageProps {
  blobId: string;
  alt: string;
  className?: string;
  testId?: string;
}

export function BlobImage({ blobId, alt, className = '', testId }: BlobImageProps) {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let createdUrl: string | null = null;
    setMissing(false);

    void repository.getBlob(blobId).then((record) => {
      if (cancelled) return;
      if (!record) {
        setMissing(true);
        setObjectUrl(null);
        return;
      }
      createdUrl = URL.createObjectURL(record.bytes);
      setObjectUrl(createdUrl);
    });

    return () => {
      cancelled = true;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [blobId]);

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
      style={{ imageRendering: 'pixelated' }}
    />
  );
}
