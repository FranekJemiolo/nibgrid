import { HexColorSchema } from './schemas';

/**
 * Normalizes a 6-digit hex color token (with or without leading '#') to uppercase '#RRGGBB'.
 * Throws an Error if the input is not a valid 6-digit hexadecimal color.
 */
export function normalizeHexColor(raw: string): string {
  const trimmed = raw.trim();
  const stripped = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  if (!/^[0-9a-fA-F]{6}$/.test(stripped)) {
    throw new Error(`Invalid hex color: "${raw}"`);
  }
  const normalized = `#${stripped.toUpperCase()}`;
  return HexColorSchema.parse(normalized);
}

/**
 * Deduplicates normalized hex colors while preserving first-seen order.
 */
export function deduplicateColors(colors: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const color of colors) {
    const normalized = normalizeHexColor(color);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

function stripInlineComment(line: string): string {
  const slashIdx = line.indexOf('//');
  const semiIdx = line.indexOf(';');
  let cut = line.length;
  if (slashIdx !== -1 && slashIdx < cut) cut = slashIdx;
  if (semiIdx !== -1 && semiIdx < cut) cut = semiIdx;
  return line.slice(0, cut).trim();
}

function isHexCommentLine(trimmed: string): boolean {
  if (trimmed.length === 0) return true;
  if (trimmed.startsWith('//') || trimmed.startsWith(';')) return true;
  // Treat `# ...` or `##...` as comment headers, while `#DEADBF` or `#ZZZZZZ` goes to validation.
  if (trimmed.startsWith('#')) {
    const rest = trimmed.slice(1);
    if (rest.length === 0 || /^\s/.test(rest) || rest.startsWith('#')) {
      return true;
    }
  }
  return false;
}

/**
 * Parses a newline-separated `.hex` palette file.
 * Strips comment lines, normalizes colors to uppercase `#RRGGBB`, and deduplicates entries.
 */
export function parseHexPalette(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const colors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    const cleaned = stripInlineComment(rawLine);
    if (isHexCommentLine(cleaned)) {
      continue;
    }
    const token = cleaned.split(/\s+/)[0] ?? '';
    let normalized: string;
    try {
      normalized = normalizeHexColor(token);
    } catch {
      throw new Error(`Line ${i + 1}: invalid hex color "${cleaned}"`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      colors.push(normalized);
    }
  }

  return colors;
}

function rgbChannelToHex(token: string, channelName: string, lineNumber: number): string {
  if (!/^\d+$/.test(token)) {
    throw new Error(`Line ${lineNumber}: invalid ${channelName} channel "${token}"`);
  }
  const value = Number.parseInt(token, 10);
  if (value < 0 || value > 255) {
    throw new Error(`Line ${lineNumber}: ${channelName} channel ${value} out of range 0..255`);
  }
  return value.toString(16).padStart(2, '0').toUpperCase();
}

/**
 * Parses a GIMP `.gpl` palette file.
 * Validates the `GIMP Palette` header, ignores metadata/comment lines, parses RGB triplets,
 * normalizes to uppercase `#RRGGBB`, and deduplicates colors.
 */
export function parseGplPalette(content: string): string[] {
  const lines = content.split(/\r?\n/);
  let foundHeader = false;
  const colors: string[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const trimmed = (lines[i] ?? '').trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (!foundHeader) {
      if (trimmed.toLowerCase() === 'gimp palette') {
        foundHeader = true;
        continue;
      }
      throw new Error('Invalid .gpl palette: missing "GIMP Palette" header');
    }

    if (trimmed.startsWith('#') || /^name\s*:/i.test(trimmed) || /^columns\s*:/i.test(trimmed)) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) {
      throw new Error(`Line ${lineNumber}: expected "R G B" triplet, got "${trimmed}"`);
    }

    const rHex = rgbChannelToHex(parts[0] ?? '', 'red', lineNumber);
    const gHex = rgbChannelToHex(parts[1] ?? '', 'green', lineNumber);
    const bHex = rgbChannelToHex(parts[2] ?? '', 'blue', lineNumber);

    const normalized = HexColorSchema.parse(`#${rHex}${gHex}${bHex}`);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      colors.push(normalized);
    }
  }

  if (!foundHeader) {
    throw new Error('Invalid .gpl palette: missing "GIMP Palette" header');
  }

  return colors;
}

/**
 * Dispatches palette parsing based on filename extension (`.gpl` or `.hex`).
 */
export function parsePaletteFile(filename: string, content: string): string[] {
  const lower = filename.trim().toLowerCase();
  if (lower.endsWith('.gpl')) {
    return parseGplPalette(content);
  }
  if (lower.endsWith('.hex')) {
    return parseHexPalette(content);
  }
  throw new Error(`Unsupported palette file extension for "${filename}". Expected .gpl or .hex.`);
}
