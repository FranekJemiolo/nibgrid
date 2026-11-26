import type { NibgridDatabase } from '../db/database';
import type { ArtBible, ProviderConfig, ProviderKind } from '../domain/schemas';
import {
  ART_DIRECTOR_QA_GEMINI_RESPONSE_SCHEMA,
  parseAndResolveQaReport,
  type ArtDirectorFinding,
  type ArtDirectorQaReport,
} from '../processing/artDirectorQaSchema';
import { encodeRgbaToPngBytes, uint8ToBase64 } from '../processing/png';
import { computeArtBibleHash } from '../processing/projectAudit';
import {
  computeQaSheetHash,
  packQaContactSheets,
  type QaContactSheetOptions,
  type QaContactSheetResult,
  type QaSpriteEntry,
} from '../processing/qaContactSheet';
import type { RgbaBuffer } from '../processing/types';
import { getBridgeSessionToken, resolveBridgeBaseUrl } from './antigravityBridgeProvider';
import { ProviderError, classifyProviderError } from './errors';
import { resolveGeminiBaseUrl, type GeminiGenerateContentResponse } from './geminiProvider';
import { resolveParallaxTextModelId } from './parallaxGenerator';

export interface ArtDirectorQaCostEstimate {
  readonly estimatedUsd: number;
  readonly pageCount: number;
  readonly label: string;
}

export interface ArtDirectorQaRunOptions {
  readonly forceRefresh?: boolean;
  readonly packOptions?: QaContactSheetOptions;
  readonly signal?: AbortSignal;
}

export interface ArtDirectorQaRunResult {
  readonly report: ArtDirectorQaReport;
  readonly sheets: readonly QaContactSheetResult[];
  readonly fromCache: boolean;
  readonly costEstimate: ArtDirectorQaCostEstimate;
  readonly providerLabel: string;
}

export function estimateArtDirectorQaCost(
  kind: ProviderKind,
  pageCount = 1,
): ArtDirectorQaCostEstimate {
  const safePages = Math.max(1, Math.round(pageCount));
  const sheetWord = safePages === 1 ? '1 Contact Sheet' : `${safePages} Contact Sheets`;
  switch (kind) {
    case 'mock':
    case 'antigravity-agent':
      return {
        estimatedUsd: 0,
        pageCount: safePages,
        label: 'Offline Mock • $0.00',
      };
    case 'antigravity-bridge':
      return {
        estimatedUsd: 0,
        pageCount: safePages,
        label: `${sheetWord} • $0.00 (Bridge)`,
      };
    case 'gemini': {
      const usd = Number((0.002 * safePages).toFixed(3));
      return {
        estimatedUsd: usd,
        pageCount: safePages,
        label: `${sheetWord} • ~$${usd.toFixed(3)}`,
      };
    }
    default: {
      const usd = Number((0.002 * safePages).toFixed(3));
      return {
        estimatedUsd: usd,
        pageCount: safePages,
        label: `${sheetWord} • ~$${usd.toFixed(3)}`,
      };
    }
  }
}

export interface GeminiVisionQaPayload {
  contents: [
    {
      role: 'user';
      parts: [
        { text: string },
        {
          inlineData: {
            mimeType: 'image/png';
            data: string;
          };
        },
      ];
    },
  ];
  generationConfig: {
    responseMimeType: 'application/json';
    responseSchema: typeof ART_DIRECTOR_QA_GEMINI_RESPONSE_SCHEMA;
    temperature: number;
  };
}

/**
 * Pure request builder compiling a labeled QA contact sheet PNG + ArtBible rules +
 * `indexToSpriteId` legend into a strict `responseSchema` Gemini Flash Vision payload.
 */
export function buildGeminiVisionQaRequest(
  sheetPngBase64: string,
  artBible: ArtBible,
  indexToSpriteId: Readonly<Record<string, string>>,
): GeminiVisionQaPayload {
  const legend = Object.entries(indexToSpriteId)
    .map(([idx, spriteId]) => `${idx}=${spriteId}`)
    .join(', ');
  const palette = artBible.palette.length > 0 ? artBible.palette.join(', ') : '#1A1C2C, #F4F4F4';

  const prompt = [
    'You are the Lead 2D Art Director inspecting a packed sprite QA contact sheet.',
    'Cell 0 ("REF", if present) is the Golden Style Reference; evaluate every numbered cell ("01", "02", ...) against REF and the project Art Bible.',
    `ART BIBLE RULES: projection=${artBible.projection}, lightDirection=${artBible.lighting}, artMode=${artBible.artMode}, stylePrompt="${artBible.stylePrompt}", palette=[${palette}].`,
    `CELL LEGEND: ${legend}.`,
    'Flag perceptual drift only using exact numbered indexLabel values ("01", "02", ...) from CELL LEGEND:',
    '- light-angle: highlight/shadow side disagrees with lightDirection or REF.',
    '- outline-inconsistency: outline stroke thickness/darkness clashes with cast.',
    '- silhouette-readability: muddy/fragmented 1x binary silhouette (check bottom-right thumbnail).',
    '- scale-proportion: noticeably too tiny, cropped, or inconsistent scale.',
    '- style-drift: shading language, palette harmony, or detail density diverges from REF.',
    'Return ONLY valid JSON matching the schema.',
  ].join('\n');

  return {
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: 'image/png',
              data: sheetPngBase64,
            },
          },
        ],
      },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: ART_DIRECTOR_QA_GEMINI_RESPONSE_SCHEMA,
      temperature: 0.2,
    },
  };
}

function extractTextFromGeminiJson(json: GeminiGenerateContentResponse): string {
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  for (const part of parts) {
    if (part.text && part.text.trim().length > 0) {
      return part.text;
    }
  }
  throw new Error(json.error?.message || 'Gemini Vision QA response did not include text JSON.');
}

interface SpriteMetricSnapshot {
  alphaFillRatio: number;
  lightBalanceX: number; // -1 (bright left) .. +1 (bright right)
  edgeDarkContrast: number; // interior lum - boundary lum
}

function measureSpriteMetrics(buf: RgbaBuffer): SpriteMetricSnapshot {
  const { width, height, data } = buf;
  const total = Math.max(1, width * height);
  let opaqueCount = 0;
  let weightedX = 0;
  let totalLum = 0;
  let edgeLumSum = 0;
  let edgeCount = 0;
  let interiorLumSum = 0;
  let interiorCount = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      const a = data[idx + 3] ?? 0;
      if (a <= 16) continue;
      opaqueCount++;
      const lum =
        (0.2126 * (data[idx] ?? 0) +
          0.7152 * (data[idx + 1] ?? 0) +
          0.0722 * (data[idx + 2] ?? 0)) /
        255;
      const normX = width > 1 ? (x / (width - 1)) * 2 - 1 : 0;
      weightedX += normX * lum;
      totalLum += lum;

      const isEdge =
        x === 0 ||
        y === 0 ||
        x === width - 1 ||
        y === height - 1 ||
        (data[(y * width + x - 1) * 4 + 3] ?? 0) <= 16 ||
        (data[(y * width + x + 1) * 4 + 3] ?? 0) <= 16 ||
        (data[((y - 1) * width + x) * 4 + 3] ?? 0) <= 16 ||
        (data[((y + 1) * width + x) * 4 + 3] ?? 0) <= 16;

      if (isEdge) {
        edgeLumSum += lum;
        edgeCount++;
      } else {
        interiorLumSum += lum;
        interiorCount++;
      }
    }
  }

  const avgEdge = edgeCount > 0 ? edgeLumSum / edgeCount : 0;
  const avgInterior = interiorCount > 0 ? interiorLumSum / interiorCount : avgEdge;
  return {
    alphaFillRatio: opaqueCount / total,
    lightBalanceX: totalLum > 1e-4 ? weightedX / totalLum : 0,
    edgeDarkContrast: avgInterior - avgEdge,
  };
}

/**
 * Pure-TS `$0.00` offline pixel heuristic analyzer comparing alpha silhouette clarity,
 * outline contrast, and key-light luminance balance against `ArtBible` & `REF`.
 */
export function runOfflineHeuristicQa(
  entries: readonly QaSpriteEntry[],
  artBible: ArtBible,
  sheetHash: string,
  createdAt = Date.now(),
  packOptions?: QaContactSheetOptions,
): ArtDirectorQaReport {
  const sheets = packQaContactSheets(entries, packOptions);
  const entryMap = new Map(entries.map((e) => [e.spriteId, e]));
  const refEntry = entries.find((e) => e.isGoldenRef);
  const refMetrics = refEntry ? measureSpriteMetrics(refEntry.buffer) : null;

  const expectedSign =
    artBible.lighting === 'top-left' ? -1 : artBible.lighting === 'top-right' ? 1 : 0;

  const findings: ArtDirectorFinding[] = [];
  let penaltyTotal = 0;

  for (const page of sheets) {
    for (const cell of page.cells) {
      if (cell.indexLabel === 'REF') continue;
      const entry = entryMap.get(cell.spriteId);
      if (!entry) continue;
      const metrics = measureSpriteMetrics(entry.buffer);

      if (metrics.alphaFillRatio < 0.04 || metrics.alphaFillRatio > 0.92) {
        penaltyTotal += 16;
        findings.push({
          indexLabel: cell.indexLabel,
          spriteId: cell.spriteId,
          severity: 'warn',
          category: 'silhouette-readability',
          summary: `1x silhouette fill (${Math.round(metrics.alphaFillRatio * 100)}%) risks looking ${
            metrics.alphaFillRatio < 0.04 ? 'too sparse' : 'over-filled'
          } on screen.`,
          suggestedFix: 'sandbox-1x',
        });
        continue;
      }

      if (
        expectedSign !== 0 &&
        Math.abs(metrics.lightBalanceX) > 0.14 &&
        Math.sign(metrics.lightBalanceX) !== expectedSign &&
        (!refMetrics || Math.abs(metrics.lightBalanceX - refMetrics.lightBalanceX) > 0.25)
      ) {
        penaltyTotal += 12;
        findings.push({
          indexLabel: cell.indexLabel,
          spriteId: cell.spriteId,
          severity: 'warn',
          category: 'light-angle',
          summary: `Highlight mass favors the ${metrics.lightBalanceX > 0 ? 'right' : 'left'} side, drifting from ${artBible.lighting} lighting.`,
          suggestedFix: 'micro-editor',
        });
        continue;
      }

      if (metrics.edgeDarkContrast < -0.05) {
        penaltyTotal += 10;
        findings.push({
          indexLabel: cell.indexLabel,
          spriteId: cell.spriteId,
          severity: 'warn',
          category: 'outline-inconsistency',
          summary:
            'Outer silhouette pixels are brighter than interior fill; consider Sel-Out darkening.',
          suggestedFix: 'post-process',
        });
        continue;
      }

      findings.push({
        indexLabel: cell.indexLabel,
        spriteId: cell.spriteId,
        severity: 'pass',
        category: 'style-drift',
        summary: `Consistent silhouette (${Math.round(metrics.alphaFillRatio * 100)}% fill) and ${artBible.lighting} shading.`,
        suggestedFix: 'post-process',
      });
    }
  }

  const overallScore = Math.max(0, Math.min(100, Math.round(100 - penaltyTotal)));
  const warnCount = findings.filter((f) => f.severity !== 'pass').length;
  const globalNotes =
    warnCount === 0
      ? `Offline QA inspected ${findings.length} sprite(s) against ${artBible.artMode} (${artBible.lighting}): cohesive silhouette & lighting.`
      : `Offline QA flagged ${warnCount} sprite(s) for lighting, outline, or 1x silhouette refinement.`;

  return {
    sheetHash,
    overallScore,
    globalNotes,
    findings,
    createdAt: Math.max(0, Math.round(createdAt)),
  };
}

/**
 * Packs sprites into labeled QA contact sheet(s), hits SHA-256 Dexie cache when unchanged,
 * or executes Gemini Flash Vision / Antigravity Bridge / Offline Mock QA with strict key redaction.
 */
export async function runArtDirectorQaPass(
  database: NibgridDatabase,
  projectId: string,
  entries: readonly QaSpriteEntry[],
  artBible: ArtBible,
  providerConfig: ProviderConfig,
  options: ArtDirectorQaRunOptions = {},
): Promise<ArtDirectorQaRunResult> {
  if (entries.length === 0) {
    throw new Error('Generate or decode at least one sprite before running Visual QA.');
  }

  const sheets = packQaContactSheets(entries, options.packOptions);
  const artBibleHash = computeArtBibleHash(artBible);
  const sheetHash = await computeQaSheetHash(sheets, artBibleHash);
  const costEstimate = estimateArtDirectorQaCost(providerConfig.kind, sheets.length);

  if (!options.forceRefresh) {
    const cached = await database.qaReports.get(projectId);
    if (cached && cached.sheetHash === sheetHash) {
      return {
        report: {
          sheetHash: cached.sheetHash,
          overallScore: cached.overallScore,
          globalNotes: cached.globalNotes,
          findings: cached.findings,
          createdAt: cached.createdAt,
        },
        sheets,
        fromCache: true,
        costEstimate,
        providerLabel: `${providerConfig.displayName} (Cached)`,
      };
    }
  }

  let report: ArtDirectorQaReport;
  let providerLabel: string = providerConfig.displayName;

  if (
    providerConfig.kind === 'mock' ||
    providerConfig.kind === 'antigravity-agent' ||
    providerConfig.kind === 'comfyui'
  ) {
    report = runOfflineHeuristicQa(entries, artBible, sheetHash, Date.now(), options.packOptions);
    providerLabel = 'Offline Mock ($0.00)';
  } else if (providerConfig.kind === 'antigravity-bridge') {
    const baseUrl = resolveBridgeBaseUrl(providerConfig.endpointUrl);
    const token = getBridgeSessionToken(providerConfig.id, providerConfig.apiKey);
    if (!token) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: providerConfig.id,
        retryable: false,
        message: 'Bridge token missing for Art Director Vision QA.',
        remediation: 'Open Provider Vault and configure the nbg_ bridge bearer token.',
      });
    }

    const pageReports: ArtDirectorQaReport[] = [];
    for (const page of sheets) {
      const sheetPng = encodeRgbaToPngBytes(page.sheet.data, page.sheet.width, page.sheet.height);
      try {
        const res = await fetch(`${baseUrl}/v1/qa-review`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            sheetPngBase64: uint8ToBase64(sheetPng),
            indexToSpriteId: page.indexToSpriteId,
            artBibleSnapshot: {
              projection: artBible.projection,
              lighting: artBible.lighting,
              artMode: artBible.artMode,
              palette: [...artBible.palette],
              stylePrompt: artBible.stylePrompt,
            },
          }),
          signal: options.signal,
        });
        if (!res.ok) {
          const text = await res.text().catch(() => '');
          throw classifyProviderError(
            { status: res.status, responseText: text },
            {
              providerId: providerConfig.id,
              providerKind: 'antigravity-bridge',
              endpointUrl: baseUrl,
              secrets: [token],
            },
          );
        }
        const json = (await res.json()) as unknown;
        pageReports.push(parseAndResolveQaReport(json, page.indexToSpriteId, sheetHash));
      } catch (err) {
        throw classifyProviderError(err, {
          providerId: providerConfig.id,
          providerKind: 'antigravity-bridge',
          endpointUrl: baseUrl,
          secrets: [token],
        });
      }
    }

    const mergedScore = Math.round(
      pageReports.reduce((sum, r) => sum + r.overallScore, 0) / Math.max(1, pageReports.length),
    );
    report = {
      sheetHash,
      overallScore: mergedScore,
      globalNotes: pageReports[0]?.globalNotes ?? 'Completed Antigravity Bridge Vision QA.',
      findings: pageReports.flatMap((r) => r.findings),
      createdAt: Date.now(),
    };
  } else {
    // Gemini Flash Vision
    const apiKey = providerConfig.apiKey.trim();
    if (!apiKey) {
      throw new ProviderError({
        code: 'UNAUTHORIZED',
        status: 401,
        providerId: providerConfig.id,
        retryable: false,
        message: 'Gemini API key is required for Vision QA.',
        remediation: 'Add your Gemini API key in Provider Vault or run Offline Mock ($0.00).',
      });
    }

    const baseUrl = resolveGeminiBaseUrl(providerConfig.endpointUrl);
    const visionModel = resolveParallaxTextModelId(providerConfig.modelId);
    const url = `${baseUrl}/models/${encodeURIComponent(visionModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const pageReports: ArtDirectorQaReport[] = [];
    for (const page of sheets) {
      const sheetPng = encodeRgbaToPngBytes(page.sheet.data, page.sheet.width, page.sheet.height);
      const payload = buildGeminiVisionQaRequest(
        uint8ToBase64(sheetPng),
        artBible,
        page.indexToSpriteId,
      );

      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: options.signal,
        });
        if (!res.ok) {
          const responseText = await res.text().catch(() => '');
          throw classifyProviderError(
            { status: res.status, responseText },
            {
              providerId: providerConfig.id,
              providerKind: providerConfig.kind,
              endpointUrl: baseUrl,
              secrets: [apiKey],
            },
          );
        }
        const json = (await res.json()) as GeminiGenerateContentResponse;
        const text = extractTextFromGeminiJson(json);
        pageReports.push(parseAndResolveQaReport(text, page.indexToSpriteId, sheetHash));
      } catch (err) {
        throw classifyProviderError(err, {
          providerId: providerConfig.id,
          providerKind: providerConfig.kind,
          endpointUrl: baseUrl,
          secrets: [apiKey],
        });
      }
    }

    const mergedScore = Math.round(
      pageReports.reduce((sum, r) => sum + r.overallScore, 0) / Math.max(1, pageReports.length),
    );
    report = {
      sheetHash,
      overallScore: mergedScore,
      globalNotes: pageReports[0]?.globalNotes ?? 'Completed Gemini Flash Vision Art Director QA.',
      findings: pageReports.flatMap((r) => r.findings),
      createdAt: Date.now(),
    };
  }

  await database.qaReports.put({
    ...report,
    projectId,
  });

  return {
    report,
    sheets,
    fromCache: false,
    costEstimate,
    providerLabel,
  };
}
