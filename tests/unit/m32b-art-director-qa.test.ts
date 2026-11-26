import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NibgridDatabase, NibgridRepository } from '../../src/db/database';
import { createDefaultArtBible, ProviderConfigSchema } from '../../src/domain/schemas';
import type { QaSpriteEntry } from '../../src/processing/qaContactSheet';
import type { RgbaBuffer } from '../../src/processing/types';
import {
  buildGeminiVisionQaRequest,
  estimateArtDirectorQaCost,
  runArtDirectorQaPass,
  runOfflineHeuristicQa,
} from '../../src/providers/artDirectorQa';
import { ProviderError } from '../../src/providers/errors';

function makeLitSprite(side: 'left' | 'right'): RgbaBuffer {
  const w = 16;
  const h = 16;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 2; y < h - 2; y++) {
    for (let x = 2; x < w - 2; x++) {
      const idx = (y * w + x) * 4;
      const isBorder = x === 2 || y === 2 || x === w - 3 || y === h - 3;
      const lit = side === 'left' ? x < w / 2 : x >= w / 2;
      const v = isBorder ? 24 : lit ? 235 : 85;
      data[idx] = v;
      data[idx + 1] = v;
      data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const databasesToCleanup: NibgridDatabase[] = [];

function createTestDb(): { db: NibgridDatabase; repo: NibgridRepository } {
  const database = new NibgridDatabase(`nibgrid-m32b-test-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(database);
  return { db: database, repo: new NibgridRepository(database) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (databasesToCleanup.length > 0) {
    const database = databasesToCleanup.pop();
    if (database) {
      database.close();
      await database.delete();
    }
  }
});

describe('M32B Vision-LLM Art Director QA Adapter & Offline Heuristics', () => {
  it('builds Gemini Vision QA payload with inlineData PNG, ArtBible rules, and strict responseSchema', () => {
    const bible = {
      ...createDefaultArtBible(),
      projection: 'side-scroller' as const,
      lighting: 'top-left' as const,
      palette: ['#1A1C2C', '#FFCD75', '#B13E53'],
    };
    const payload = buildGeminiVisionQaRequest('SHEET_PNG_B64', bible, {
      REF: 'ref-0',
      '01': 'sprite-hero',
      '02': 'sprite-goblin',
    });

    expect(payload.generationConfig.responseMimeType).toBe('application/json');
    expect(payload.generationConfig.responseSchema.required).toEqual([
      'overallScore',
      'globalNotes',
      'findings',
    ]);
    expect(payload.contents[0].parts[0].text).toContain('side-scroller');
    expect(payload.contents[0].parts[0].text).toContain('top-left');
    expect(payload.contents[0].parts[0].text).toContain('02=sprite-goblin');
    expect(payload.contents[0].parts[1].inlineData.data).toBe('SHEET_PNG_B64');
  });

  it('runs deterministic Offline Heuristic QA flagging opposing light balance while passing matched sprites', () => {
    const bible = {
      ...createDefaultArtBible(),
      lighting: 'top-left' as const,
    };
    const entries: QaSpriteEntry[] = [
      { spriteId: 'ref-0', slug: '00-ref', isGoldenRef: true, buffer: makeLitSprite('left') },
      { spriteId: 's-1', slug: '01-hero', buffer: makeLitSprite('left') },
      { spriteId: 's-2', slug: '02-goblin', buffer: makeLitSprite('right') },
    ];

    const report = runOfflineHeuristicQa(entries, bible, 'hash-offline', 1700000000000);
    expect(report.overallScore).toBeGreaterThanOrEqual(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    expect(report.findings.length).toBe(2);
    expect(report.findings.find((f) => f.spriteId === 's-1')?.severity).toBe('pass');
    expect(report.findings.find((f) => f.spriteId === 's-2')).toMatchObject({
      severity: 'warn',
      category: 'light-angle',
      suggestedFix: 'micro-editor',
    });
    expect(estimateArtDirectorQaCost('mock', 1).estimatedUsd).toBe(0);
  });

  it('strips dummy key AIzaSyQA999 on HTTP 401 and 429 errors cleanly', async () => {
    const { db, repo } = createTestDb();
    const project = await repo.createProject('M32 Secret Guard', createDefaultArtBible());
    const dummyKey = 'AIzaSyQA999';
    const entries: QaSpriteEntry[] = [
      { spriteId: 's-1', slug: '01-hero', buffer: makeLitSprite('left') },
    ];

    const geminiCfg = ProviderConfigSchema.parse({
      id: 'gemini-qa',
      kind: 'gemini',
      displayName: 'Gemini Flash',
      modelId: 'gemini-2.5-flash',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: dummyKey,
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    });

    for (const status of [401, 429]) {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        new Response(`Auth failure with key ${dummyKey}`, { status }),
      );
      let caught: unknown;
      try {
        await runArtDirectorQaPass(db, project.id, entries, project.artBible, geminiCfg);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ProviderError);
      const err = caught as ProviderError;
      expect(err.message).not.toContain(dummyKey);
      expect(err.remediation).not.toContain(dummyKey);
    }
  });

  it('hits Dexie SHA-256 cache on repeated unchanged calls (zero duplicate Gemini fetches)', async () => {
    const { db, repo } = createTestDb();
    const project = await repo.createProject('M32 Cache Hit', createDefaultArtBible());
    const entries: QaSpriteEntry[] = [
      { spriteId: 's-1', slug: '01-hero', buffer: makeLitSprite('left') },
      { spriteId: 's-2', slug: '02-goblin', buffer: makeLitSprite('right') },
    ];

    const geminiCfg = ProviderConfigSchema.parse({
      id: 'gemini-qa',
      kind: 'gemini',
      displayName: 'Gemini Flash',
      modelId: 'gemini-2.5-flash',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaSyQA999',
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      overallScore: 86,
                      globalNotes: 'Good cast palette alignment; cell 02 lighting inverted.',
                      findings: [
                        {
                          indexLabel: '01',
                          severity: 'pass',
                          category: 'style-drift',
                          summary: 'Matches Art Bible cleanly.',
                          suggestedFix: 'post-process',
                        },
                        {
                          indexLabel: '02',
                          severity: 'warn',
                          category: 'light-angle',
                          summary: 'Right-lit highlights clash with top-left light.',
                          suggestedFix: 'micro-editor',
                        },
                      ],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    const first = await runArtDirectorQaPass(db, project.id, entries, project.artBible, geminiCfg);
    expect(first.fromCache).toBe(false);
    expect(first.report.overallScore).toBe(86);
    expect(first.report.findings.find((f) => f.indexLabel === '02')?.spriteId).toBe('s-2');
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const second = await runArtDirectorQaPass(db, project.id, entries, project.artBible, geminiCfg);
    expect(second.fromCache).toBe(true);
    expect(second.report.overallScore).toBe(86);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
