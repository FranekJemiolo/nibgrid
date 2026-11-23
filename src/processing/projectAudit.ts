import { dbToLinear, measureApproxLufs } from '../audio/pcmPostProcess';
import type { PcmBuffer } from '../audio/types';
import type { ArtBible } from '../domain/schemas';
import { detectPixelGrid } from './demixel';
import { generateBiomeTile } from './sandboxBiomes';
import { computeBiomeContrast } from './sandboxContrast';
import type { RgbaBuffer } from './types';

export type AuditSeverity = 'pass' | 'warn' | 'fail';

export type AuditCheckId =
  'palette' | 'mixel' | 'contrast' | 'collider' | 'normalMap' | 'audioLufs' | 'recipeSync';

export interface AuditCheckResult {
  readonly checkId: AuditCheckId;
  readonly severity: AuditSeverity;
  readonly metricLabel: string;
  readonly detail: string;
  readonly autoFixable: boolean;
}

export interface SpriteAuditInput {
  readonly nodeId: string;
  readonly name: string;
  readonly processedBuffer: RgbaBuffer;
  readonly artMode: 'pixel-art' | 'hd-2d';
  readonly artBiblePaletteHex: readonly string[];
  readonly currentArtBibleHash: string;
  readonly nodeArtBibleHash?: string;
  readonly requireNormalMap?: boolean;
  readonly hasNormalMap?: boolean;
  readonly hasCollider?: boolean;
  readonly biomeTile?: RgbaBuffer;
}

export type AuditAudioCategory = 'sfx' | 'ui' | 'bgm' | 'music' | 'ambience' | 'voice';

export interface AudioAuditInput {
  readonly assetId: string;
  readonly name: string;
  readonly category: AuditAudioCategory;
  readonly pcm?: PcmBuffer;
  readonly measuredLufs?: number;
  readonly targetLufs?: number;
}

export interface AssetAuditRow {
  readonly assetId: string;
  readonly assetKind: 'sprite' | 'audio';
  readonly name: string;
  readonly checks: readonly AuditCheckResult[];
  readonly worstSeverity: AuditSeverity;
  readonly isStale: boolean;
}

export interface ProjectAuditReport {
  readonly readinessScore: number;
  readonly passCount: number;
  readonly warnCount: number;
  readonly failCount: number;
  readonly staleCount: number;
  readonly rows: readonly AssetAuditRow[];
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotr(val: number, bits: number): number {
  return (val >>> bits) | (val << (32 - bits));
}

/**
 * Synchronous pure-TS SHA-256 hex digest over UTF-8 input (works in browser, Worker, and Node).
 */
export function sha256HexSync(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const bitLen = bytes.length * 8;
  const paddedLen = Math.ceil((bytes.length + 9) / 64) * 64;
  const buf = new Uint8Array(paddedLen);
  buf.set(bytes);
  buf[bytes.length] = 0x80;

  const view = new DataView(buf.buffer);
  const hiBits = Math.floor(bitLen / 0x100000000);
  const loBits = bitLen >>> 0;
  view.setUint32(paddedLen - 8, hiBits, false);
  view.setUint32(paddedLen - 4, loBits, false);

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) {
      w[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i++) {
      const w15 = w[i - 15]!;
      const w2 = w[i - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  return [h0, h1, h2, h3, h4, h5, h6, h7].map((v) => v.toString(16).padStart(8, '0')).join('');
}

/**
 * Computes canonical deterministic Art Bible fingerprint over style-defining fields.
 */
export function computeArtBibleHash(
  artBible: Pick<ArtBible, 'projection' | 'lighting' | 'artMode' | 'palette'>,
): string {
  const canonical = JSON.stringify({
    projection: artBible.projection,
    lighting: artBible.lighting,
    artMode: artBible.artMode,
    palette: artBible.palette.map((hex) => hex.trim().toUpperCase()),
  });
  return sha256HexSync(canonical);
}

function parseHexToPackedRgb(hex: string): number {
  const clean = hex.replace('#', '').trim();
  return parseInt(clean, 16) & 0xffffff;
}

const DEFAULT_AUDIT_BIOME = generateBiomeTile('dark-dungeon', 64);

/**
 * Executes pure-TS compliance & engine-readiness checks for a single processed sprite.
 */
export function auditSpriteAsset(input: SpriteAuditInput): AssetAuditRow {
  const checks: AuditCheckResult[] = [];
  const { data } = input.processedBuffer;

  // 1. Palette Compliance
  if (input.artBiblePaletteHex.length > 0) {
    const allowed = new Set(input.artBiblePaletteHex.map(parseHexToPackedRgb));
    let opaqueCount = 0;
    let offCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      if ((data[i + 3] ?? 0) < 128) continue;
      opaqueCount++;
      const packed = ((data[i] ?? 0) << 16) | ((data[i + 1] ?? 0) << 8) | (data[i + 2] ?? 0);
      if (!allowed.has(packed)) offCount++;
    }
    const offPct = opaqueCount > 0 ? (offCount / opaqueCount) * 100 : 0;
    checks.push({
      checkId: 'palette',
      severity: offCount === 0 ? 'pass' : offPct < 2 ? 'warn' : 'fail',
      metricLabel: offCount === 0 ? '100% locked' : `${offPct.toFixed(1)}% drift`,
      detail:
        offCount === 0
          ? 'All opaque pixels match the active Art Bible palette.'
          : `${offCount} opaque pixels fall outside the Art Bible palette.`,
      autoFixable: offCount > 0,
    });
  }

  // 2. Mixel Density (pixel-art projects only)
  if (input.artMode === 'pixel-art') {
    const grid = detectPixelGrid(input.processedBuffer);
    const hasMixels = (grid.cellWidth >= 2 || grid.cellHeight >= 2) && grid.confidence >= 0.65;
    checks.push({
      checkId: 'mixel',
      severity: hasMixels ? 'fail' : 'pass',
      metricLabel: hasMixels ? `${grid.cellWidth}x${grid.cellHeight} mixel` : '1x clean',
      detail: hasMixels
        ? `Detected ${grid.cellWidth}x${grid.cellHeight} sub-grid (conf ${Math.round(grid.confidence * 100)}%).`
        : 'Consistent 1x native pixel density.',
      autoFixable: hasMixels,
    });
  }

  // 3. 1x Biome Contrast
  const biomeTile = input.biomeTile ?? DEFAULT_AUDIT_BIOME;
  const contrast = computeBiomeContrast(input.processedBuffer, biomeTile);
  checks.push({
    checkId: 'contrast',
    severity:
      contrast.rating === 'strong' ? 'pass' : contrast.rating === 'moderate' ? 'warn' : 'fail',
    metricLabel: `${contrast.contrastRatio.toFixed(1)}:1`,
    detail: contrast.suggestion,
    autoFixable: contrast.rating !== 'strong',
  });

  // 4. Collider Coverage
  const hasCollider = Boolean(input.hasCollider);
  checks.push({
    checkId: 'collider',
    severity: hasCollider ? 'pass' : 'warn',
    metricLabel: hasCollider ? 'Hull ready' : 'Missing',
    detail: hasCollider
      ? 'Pivot-relative collision shape attached.'
      : 'No M16 collision hull or hitbox configured.',
    autoFixable: !hasCollider,
  });

  // 5. Normal Map Coverage (when lighting requirement enabled)
  if (input.requireNormalMap) {
    const hasNormal = Boolean(input.hasNormalMap);
    checks.push({
      checkId: 'normalMap',
      severity: hasNormal ? 'pass' : 'warn',
      metricLabel: hasNormal ? '_n.png ready' : 'Missing',
      detail: hasNormal
        ? 'Normal map synced with current sprite.'
        : 'Project lighting enabled, but _n.png has not been baked.',
      autoFixable: !hasNormal,
    });
  }

  // 6. Recipe / Art Bible Sync
  const isStale =
    Boolean(input.nodeArtBibleHash) && input.nodeArtBibleHash !== input.currentArtBibleHash;
  checks.push({
    checkId: 'recipeSync',
    severity: isStale ? 'warn' : 'pass',
    metricLabel: isStale ? 'Stale' : 'Synced',
    detail: isStale
      ? 'Art Bible changed after this sprite was last post-processed.'
      : 'Processed output matches current Art Bible hash.',
    autoFixable: isStale,
  });

  const worstSeverity: AuditSeverity = checks.some((c) => c.severity === 'fail')
    ? 'fail'
    : checks.some((c) => c.severity === 'warn')
      ? 'warn'
      : 'pass';

  return {
    assetId: input.nodeId,
    assetKind: 'sprite',
    name: input.name,
    checks,
    worstSeverity,
    isStale,
  };
}

export const CATEGORY_TARGET_LUFS: Record<AuditAudioCategory, number> = {
  ui: -12,
  sfx: -14,
  voice: -14,
  bgm: -16,
  music: -16,
  ambience: -20,
};

function measureLeadingSilenceMs(buf: PcmBuffer, thresholdDb = -48): number {
  const { samples, channels, sampleRate } = buf;
  const totalFrames = Math.floor(samples.length / channels);
  if (totalFrames === 0 || sampleRate <= 0) return 0;
  const linThresh = dbToLinear(thresholdDb);
  for (let f = 0; f < totalFrames; f++) {
    for (let c = 0; c < channels; c++) {
      if (Math.abs(samples[f * channels + c] ?? 0) >= linThresh) {
        return (f / sampleRate) * 1000;
      }
    }
  }
  return (totalFrames / sampleRate) * 1000;
}

/**
 * Audits an AudioAsset's loudness against its category LUFS target and leading-silence budget.
 */
export function auditAudioAsset(input: AudioAuditInput): AssetAuditRow {
  const targetLufs = input.targetLufs ?? CATEGORY_TARGET_LUFS[input.category];
  const lufs = input.pcm ? measureApproxLufs(input.pcm) : (input.measuredLufs ?? targetLufs);
  const leadingSilenceMs = input.pcm ? measureLeadingSilenceMs(input.pcm, -48) : 0;

  const finiteLufs = Number.isFinite(lufs);
  const drift = finiteLufs ? Math.abs(lufs - targetLufs) : Infinity;

  let severity: AuditSeverity = 'pass';
  if (!finiteLufs || drift > 3.0) {
    severity = 'fail';
  } else if (drift > 1.5 || leadingSilenceMs > 25) {
    severity = 'warn';
  }

  const metricLabel = finiteLufs ? `${lufs.toFixed(1)} LUFS` : 'Silent / -∞';
  const detail =
    severity === 'pass'
      ? `Normalized within ±1.5 LU of ${targetLufs} LUFS target.`
      : leadingSilenceMs > 25 && drift <= 1.5
        ? `Untrimmed leading silence (${Math.round(leadingSilenceMs)}ms > 25ms).`
        : `Measured ${metricLabel} vs ${targetLufs} LUFS category target.`;

  const checks: AuditCheckResult[] = [
    {
      checkId: 'audioLufs',
      severity,
      metricLabel,
      detail,
      autoFixable: severity !== 'pass',
    },
  ];

  return {
    assetId: input.assetId,
    assetKind: 'audio',
    name: input.name,
    checks,
    worstSeverity: severity,
    isStale: false,
  };
}

/**
 * Aggregates per-asset checks into a 0–100 weighted Project Readiness Score and summary counters.
 */
export function summarizeProjectAudit(rows: readonly AssetAuditRow[]): ProjectAuditReport {
  let passCount = 0;
  let warnCount = 0;
  let failCount = 0;
  let staleCount = 0;
  let totalChecks = 0;
  let weightedScore = 0;

  for (const row of rows) {
    if (row.isStale) staleCount++;
    if (row.worstSeverity === 'pass') passCount++;
    else if (row.worstSeverity === 'warn') warnCount++;
    else failCount++;

    for (const c of row.checks) {
      totalChecks++;
      if (c.severity === 'pass') weightedScore += 1;
      else if (c.severity === 'warn') weightedScore += 0.5;
    }
  }

  const readinessScore = totalChecks > 0 ? Math.round((weightedScore / totalChecks) * 100) : 100;

  return { readinessScore, passCount, warnCount, failCount, staleCount, rows };
}
