import type { ProviderKind } from '../domain/schemas';

export type ProviderErrorCode =
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'TIMEOUT'
  | 'CORS_OR_OFFLINE'
  | 'ABORTED'
  | 'INVALID_RESPONSE'
  | 'UNKNOWN';

export interface ProviderErrorOptions {
  code: ProviderErrorCode;
  message: string;
  remediation: string;
  providerId: string;
  status?: number;
  retryable: boolean;
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly remediation: string;
  readonly providerId: string;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(options: ProviderErrorOptions) {
    super(options.message);
    this.name = 'ProviderError';
    this.code = options.code;
    this.remediation = options.remediation;
    this.providerId = options.providerId;
    this.status = options.status;
    this.retryable = options.retryable;
  }
}

export interface HttpStatusErrorInput {
  status: number;
  responseText?: string;
}

export interface ClassifyErrorContext {
  providerId: string;
  providerKind: ProviderKind;
  endpointUrl?: string;
  secrets?: readonly (string | undefined)[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Strips explicit API keys and common provider token patterns so secrets
 * never appear in error messages, toast notifications, or logs.
 */
export function redactSecrets(
  input: string,
  secrets: readonly (string | undefined)[] = [],
): string {
  let sanitized = input;

  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed) continue;
    sanitized = sanitized.replace(new RegExp(escapeRegExp(trimmed), 'g'), '[REDACTED_KEY]');
    const encoded = encodeURIComponent(trimmed);
    if (encoded !== trimmed) {
      sanitized = sanitized.replace(new RegExp(escapeRegExp(encoded), 'g'), '[REDACTED_KEY]');
    }
  }

  sanitized = sanitized
    .replace(/AIza[0-9A-Za-z_-]{6,}/g, '[REDACTED_KEY]')
    .replace(/sk-[0-9A-Za-z_-]{10,}/g, '[REDACTED_KEY]')
    .replace(/([?&](?:key|api_key|token)=)[^&\s"']+/gi, '$1[REDACTED_KEY]');

  return sanitized;
}

function isHttpStatusInput(error: unknown): error is HttpStatusErrorInput {
  return (
    typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof (error as { status: unknown }).status === 'number'
  );
}

export function classifyProviderError(
  error: unknown,
  context: ClassifyErrorContext,
): ProviderError {
  const { providerId, providerKind, endpointUrl, secrets = [] } = context;

  if (error instanceof ProviderError) {
    return new ProviderError({
      code: error.code,
      message: redactSecrets(error.message, secrets),
      remediation: redactSecrets(error.remediation, secrets),
      providerId: error.providerId,
      status: error.status,
      retryable: error.retryable,
    });
  }

  if (isHttpStatusInput(error)) {
    const status = error.status;
    const detail = error.responseText
      ? redactSecrets(error.responseText.slice(0, 240), secrets)
      : '';

    if (status === 401) {
      return new ProviderError({
        code: 'UNAUTHORIZED',
        status,
        providerId,
        retryable: false,
        message: `Unauthorized (HTTP 401): Provider rejected credentials.${detail ? ` ${detail}` : ''}`,
        remediation: 'Open Provider Vault and verify that your API key is valid and active.',
      });
    }
    if (status === 403) {
      return new ProviderError({
        code: 'FORBIDDEN',
        status,
        providerId,
        retryable: false,
        message: `Access forbidden (HTTP 403).${detail ? ` ${detail}` : ''}`,
        remediation: 'Verify API key permissions, billing quota, and selected model access.',
      });
    }
    if (status === 429) {
      return new ProviderError({
        code: 'RATE_LIMITED',
        status,
        providerId,
        retryable: true,
        message: `Rate limit exceeded (HTTP 429).${detail ? ` ${detail}` : ''}`,
        remediation: 'Wait a few seconds and retry, or reduce concurrent variant count.',
      });
    }
    if (status >= 500) {
      return new ProviderError({
        code: 'SERVER_ERROR',
        status,
        providerId,
        retryable: true,
        message: `Provider server error (HTTP ${status}).${detail ? ` ${detail}` : ''}`,
        remediation: 'Retry shortly or switch to the Offline Mock Provider.',
      });
    }
    return new ProviderError({
      code: 'UNKNOWN',
      status,
      providerId,
      retryable: false,
      message: `Request failed (HTTP ${status}).${detail ? ` ${detail}` : ''}`,
      remediation: 'Check endpoint URL, model ID, and request settings in Provider Vault.',
    });
  }

  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ProviderError({
      code: 'ABORTED',
      providerId,
      retryable: false,
      message: 'Generation request was cancelled.',
      remediation: 'Click Generate again when ready.',
    });
  }

  const rawMessage = error instanceof Error ? error.message : String(error);
  const cleanMessage = redactSecrets(rawMessage, secrets);

  if (
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    /timeout|timed out/i.test(cleanMessage)
  ) {
    return new ProviderError({
      code: 'TIMEOUT',
      providerId,
      retryable: true,
      message: `Request timed out: ${cleanMessage}`,
      remediation: 'Check local server responsiveness or network connection and retry.',
    });
  }

  if (
    error instanceof TypeError ||
    /failed to fetch|networkerror|load failed|cors|err_connection/i.test(cleanMessage)
  ) {
    const isComfy = providerKind === 'comfyui';
    const remediation = isComfy
      ? 'Start ComfyUI with CORS enabled: python main.py --enable-cors-header "*"'
      : `Verify network connectivity and CORS headers for ${endpointUrl || 'the provider endpoint'}.`;
    return new ProviderError({
      code: 'CORS_OR_OFFLINE',
      providerId,
      retryable: true,
      message: isComfy
        ? `Cannot reach ComfyUI (${cleanMessage}). ${remediation}`
        : `Network or CORS error: ${cleanMessage}`,
      remediation,
    });
  }

  return new ProviderError({
    code: 'UNKNOWN',
    providerId,
    retryable: false,
    message: cleanMessage || 'Unexpected provider failure.',
    remediation: 'Inspect Provider Vault settings or check the browser console.',
  });
}
