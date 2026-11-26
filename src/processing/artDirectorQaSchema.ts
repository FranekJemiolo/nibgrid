import { z } from 'zod';

export const QaIssueCategorySchema = z.enum([
  'style-drift',
  'light-angle',
  'outline-inconsistency',
  'silhouette-readability',
  'scale-proportion',
]);
export type QaIssueCategory = z.infer<typeof QaIssueCategorySchema>;

export const QaSeveritySchema = z.enum(['pass', 'warn', 'fail']);
export type QaSeverity = z.infer<typeof QaSeveritySchema>;

export const QaQuickFixTargetSchema = z.enum([
  'micro-editor',
  'post-process',
  'sandbox-1x',
  'regenerate',
]);
export type QaQuickFixTarget = z.infer<typeof QaQuickFixTargetSchema>;

export const ArtDirectorFindingSchema = z.object({
  indexLabel: z.string().min(1),
  spriteId: z.string().min(1),
  severity: QaSeveritySchema,
  category: QaIssueCategorySchema,
  summary: z.string().min(1).max(320),
  suggestedFix: QaQuickFixTargetSchema,
});
export type ArtDirectorFinding = z.infer<typeof ArtDirectorFindingSchema>;

export const ArtDirectorQaReportSchema = z.object({
  sheetHash: z.string().min(1),
  overallScore: z.number().int().min(0).max(100),
  globalNotes: z.string(),
  findings: z.array(ArtDirectorFindingSchema),
  createdAt: z.number().int().nonnegative(),
});
export type ArtDirectorQaReport = z.infer<typeof ArtDirectorQaReportSchema>;

export const StoredQaReportRecordSchema = ArtDirectorQaReportSchema.extend({
  projectId: z.string().min(1),
});
export type StoredQaReportRecord = z.infer<typeof StoredQaReportRecordSchema>;

export const ART_DIRECTOR_QA_GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    overallScore: { type: 'INTEGER' },
    globalNotes: { type: 'STRING' },
    findings: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          indexLabel: { type: 'STRING' },
          severity: { type: 'STRING', enum: ['pass', 'warn', 'fail'] },
          category: {
            type: 'STRING',
            enum: [
              'style-drift',
              'light-angle',
              'outline-inconsistency',
              'silhouette-readability',
              'scale-proportion',
            ],
          },
          summary: { type: 'STRING' },
          suggestedFix: {
            type: 'STRING',
            enum: ['micro-editor', 'post-process', 'sandbox-1x', 'regenerate'],
          },
        },
        required: ['indexLabel', 'severity', 'category', 'summary', 'suggestedFix'],
      },
    },
  },
  required: ['overallScore', 'globalNotes', 'findings'],
} as const;

function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match?.[1] ? match[1].trim() : trimmed;
}

function normalizeLabelLookup(
  rawLabel: string,
  indexToSpriteId: Readonly<Record<string, string>>,
): { label: string; spriteId: string } | null {
  const cleaned = rawLabel.trim();
  if (!cleaned) return null;
  if (indexToSpriteId[cleaned]) {
    return { label: cleaned, spriteId: indexToSpriteId[cleaned]! };
  }
  const upper = cleaned.toUpperCase();
  if (indexToSpriteId[upper]) {
    return { label: upper, spriteId: indexToSpriteId[upper]! };
  }
  if (/^\d+$/.test(cleaned)) {
    const padded = cleaned.padStart(2, '0');
    if (indexToSpriteId[padded]) {
      return { label: padded, spriteId: indexToSpriteId[padded]! };
    }
  }
  return null;
}

/**
 * Validates raw Vision QA output, clamps `overallScore` to `[0, 100]`,
 * resolves `indexLabel -> spriteId`, and drops hallucinated/unknown indices cleanly.
 */
export function parseAndResolveQaReport(
  raw: unknown,
  indexToSpriteId: Readonly<Record<string, string>>,
  sheetHash: string,
  createdAt = Date.now(),
): ArtDirectorQaReport {
  let obj: unknown = raw;
  if (typeof raw === 'string') {
    obj = JSON.parse(stripCodeFences(raw));
  }
  const rec = (obj && typeof obj === 'object' ? obj : {}) as Record<string, unknown>;

  const rawScore = Number(rec.overallScore);
  const clampedScore = Number.isFinite(rawScore)
    ? Math.max(0, Math.min(100, Math.round(rawScore)))
    : 75;

  const globalNotes =
    typeof rec.globalNotes === 'string' && rec.globalNotes.trim().length > 0
      ? rec.globalNotes.trim().slice(0, 600)
      : 'Reviewed sprite cast consistency against Art Bible.';

  const rawFindings = Array.isArray(rec.findings) ? rec.findings : [];
  const findings: ArtDirectorFinding[] = [];

  for (const item of rawFindings) {
    if (!item || typeof item !== 'object') continue;
    const f = item as Record<string, unknown>;
    const rawLabel = typeof f.indexLabel === 'string' ? f.indexLabel : String(f.indexLabel ?? '');
    const resolved = normalizeLabelLookup(rawLabel, indexToSpriteId);
    if (!resolved || resolved.label === 'REF') continue;

    const sevParsed = QaSeveritySchema.safeParse(f.severity);
    const catParsed = QaIssueCategorySchema.safeParse(f.category);
    const fixParsed = QaQuickFixTargetSchema.safeParse(f.suggestedFix);

    const summary =
      typeof f.summary === 'string' && f.summary.trim().length > 0
        ? f.summary.trim().slice(0, 320)
        : 'Sprite inspected against project Art Bible.';

    findings.push({
      indexLabel: resolved.label,
      spriteId: resolved.spriteId,
      severity: sevParsed.success ? sevParsed.data : 'warn',
      category: catParsed.success ? catParsed.data : 'style-drift',
      summary,
      suggestedFix: fixParsed.success ? fixParsed.data : 'micro-editor',
    });
  }

  return ArtDirectorQaReportSchema.parse({
    sheetHash,
    overallScore: clampedScore,
    globalNotes,
    findings,
    createdAt: Math.max(0, Math.round(createdAt)),
  });
}
