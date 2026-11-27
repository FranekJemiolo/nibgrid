export type HostKind = 'browser' | 'vscode-webview' | 'nibgrid-desktop';

export interface HostCapabilities {
  readonly supportsDirectDiskSync: boolean;
  readonly supportsNativeKeychain: boolean;
  readonly supportsLocalProcessLaunch: boolean;
  readonly supportsMcpServer: boolean;
}

export interface HostFileEntry {
  readonly path: string;
  readonly kind: 'file' | 'directory';
  readonly sizeBytes?: number;
}

export interface HostFsAdapter {
  readonly readFile: (relativePath: string) => Promise<Uint8Array>;
  readonly readText: (relativePath: string) => Promise<string>;
  readonly writeFile: (relativePath: string, data: Uint8Array | string) => Promise<void>;
  readonly listFiles: (dirPath?: string) => Promise<readonly HostFileEntry[]>;
}

export interface HostSecretStore {
  readonly getSecret: (key: string) => Promise<string | null>;
  readonly setSecret: (key: string, value: string) => Promise<void>;
  readonly deleteSecret: (key: string) => Promise<void>;
}

/**
 * Backward-compatible alias for M40 host bridge callers.
 */
export type HostSecretsAdapter = HostSecretStore;

export interface HostSyncFile {
  readonly relativePath: string;
  readonly data: Uint8Array | string;
}

export interface HostSyncResult {
  readonly ok: boolean;
  readonly writtenCount: number;
  readonly skippedCount: number;
  readonly targetLabel: string;
  readonly writtenPaths: readonly string[];
  readonly message?: string;
}

export interface HostSyncAdapter {
  readonly syncResFiles: (
    projectId: string,
    files: readonly HostSyncFile[],
  ) => Promise<HostSyncResult>;
  readonly openEditor: (relativePath: string) => Promise<void>;
  readonly launchGodot: (opts?: {
    readonly workspacePath?: string;
    readonly scenePath?: string;
  }) => Promise<{ readonly launched: boolean; readonly pid?: number; readonly message?: string }>;
}

export interface AntigravityLinkResult {
  readonly ok: boolean;
  readonly configPath: string;
  readonly backupPath?: string;
  readonly mergedConfigJson?: string;
  readonly message: string;
}

export interface HostAntigravityBridge {
  readonly detectAntigravity: () => Promise<{
    readonly detected: boolean;
    readonly configDir: string;
  }>;
  readonly linkAntigravityMcp: (opts: {
    readonly configDir?: string;
    readonly workspacePath?: string;
  }) => Promise<AntigravityLinkResult>;
}

export interface HostAdapter {
  readonly kind: HostKind;
  readonly capabilities: HostCapabilities;
  readonly fs: HostFsAdapter;
  readonly secrets: HostSecretStore;
  readonly sync: HostSyncAdapter;
  readonly antigravity: HostAntigravityBridge;
  readonly notify: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface GlobalNibgridHostBridge {
  readonly hostKind?: HostKind;
  readonly capabilities?: Partial<HostCapabilities>;
  readonly fs?: HostFsAdapter;
  readonly secrets?: HostSecretStore;
  readonly sync?: HostSyncAdapter;
  readonly antigravity?: HostAntigravityBridge;
  readonly notify?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

export interface VscodeWebviewApiLike {
  postMessage: (msg: unknown) => void;
}

/**
 * Validates and normalizes a workspace-relative path, rejecting absolute paths,
 * Windows drive prefixes, NUL bytes, and parent directory (`..`) traversal.
 */
export function assertSafeWorkspaceRelativePath(rawPath: string): string {
  const input = String(rawPath ?? '').trim();
  if (!input || input.includes('\0')) {
    throw new Error('Workspace path cannot be empty or contain NUL bytes.');
  }
  const normalized = input.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`Absolute workspace path "${rawPath}" is not permitted.`);
  }
  const segments = normalized.split('/').filter((seg) => seg.length > 0 && seg !== '.');
  if (segments.length === 0 || segments.some((seg) => seg === '..')) {
    throw new Error(`Unsafe workspace relative path "${rawPath}".`);
  }
  return segments.join('/');
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /AIza[0-9A-Za-z_-]{6,}/g,
  /sk-[0-9A-Za-z_-]{6,}/g,
  /nbg_[0-9A-Za-z_-]{6,}/g,
  /Bearer\s+[0-9A-Za-z._-]{6,}/gi,
  /ghp_[0-9A-Za-z]{8,}/g,
];

/**
 * Scrubs explicit secret strings and known API token prefixes from error or log messages.
 */
export function redactHostSecrets(input: string, secrets: readonly string[] = []): string {
  let out = input;
  for (const secret of secrets) {
    const clean = secret.trim();
    if (clean.length >= 4) {
      out = out.split(clean).join('[REDACTED]');
    }
  }
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[REDACTED]');
  }
  return out;
}

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export function encodeBytesBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    result += B64_ALPHABET[(triplet >> 18) & 0x3f] ?? '';
    result += B64_ALPHABET[(triplet >> 12) & 0x3f] ?? '';
    result += i + 1 < bytes.length ? (B64_ALPHABET[(triplet >> 6) & 0x3f] ?? '') : '=';
    result += i + 2 < bytes.length ? (B64_ALPHABET[triplet & 0x3f] ?? '') : '=';
  }
  return result;
}

export function decodeBytesBase64(base64: string): Uint8Array {
  const clean = base64.replace(/\s+/g, '');
  if (!clean) return new Uint8Array(0);
  if (clean.length % 4 !== 0) {
    throw new Error('Invalid base64 byte payload length.');
  }
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  const out = new Uint8Array((clean.length / 4) * 3 - padding);
  let outIdx = 0;

  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_ALPHABET.indexOf(clean[i] ?? '');
    const c1 = B64_ALPHABET.indexOf(clean[i + 1] ?? '');
    const c2 = clean[i + 2] === '=' ? 0 : B64_ALPHABET.indexOf(clean[i + 2] ?? '');
    const c3 = clean[i + 3] === '=' ? 0 : B64_ALPHABET.indexOf(clean[i + 3] ?? '');
    if (c0 < 0 || c1 < 0 || c2 < 0 || c3 < 0) {
      throw new Error('Invalid base64 character in payload.');
    }
    const triplet = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3;
    out[outIdx++] = (triplet >> 16) & 0xff;
    if (clean[i + 2] !== '=') {
      out[outIdx++] = (triplet >> 8) & 0xff;
    }
    if (clean[i + 3] !== '=') {
      out[outIdx++] = triplet & 0xff;
    }
  }
  return out;
}
