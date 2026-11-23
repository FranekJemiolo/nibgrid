import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildGeminiToSynthRequest,
  buildGeminiTtsRequest,
  buildLyriaInteractionRequest,
  estimateGoogleAudioCost,
  invokeGoogleAudioRoute,
} from '../../src/audio/googleAudioProvider';
import { PROCEDURAL_SFX_RESPONSE_SCHEMA } from '../../src/audio/synthResponseSchema';
import { NibgridDatabase, NibgridRepository, findOrphanBlobIds } from '../../src/db/database';
import { createDefaultAudioPostProcessConfig } from '../../src/domain/schemas';
import { ProviderError } from '../../src/providers/errors';

const databasesToCleanup: NibgridDatabase[] = [];

function createTestRepo(): { db: NibgridDatabase; repo: NibgridRepository } {
  const db = new NibgridDatabase(`nibgrid-m14b-${globalThis.crypto.randomUUID()}`);
  databasesToCleanup.push(db);
  return { db, repo: new NibgridRepository(db) };
}

afterEach(async () => {
  vi.restoreAllMocks();
  while (databasesToCleanup.length > 0) {
    const db = databasesToCleanup.pop();
    if (db) {
      db.close();
      await db.delete();
    }
  }
});

describe('M14B Google Audio Request Builders, Secret Redaction & Dexie Persistence', () => {
  it('builds exact Lyria Interactions API, Gemini 3.8 TTS, and Gemini Structured Output payloads + cost estimates', () => {
    expect(estimateGoogleAudioCost('local-synth').label).toContain('$0.00');
    expect(estimateGoogleAudioCost('gemini-to-synth').label).toContain('$0.001');
    expect(estimateGoogleAudioCost('gemini-tts').label).toContain('$0.005');
    expect(estimateGoogleAudioCost('lyria-clip').label).toContain('$0.04');
    expect(estimateGoogleAudioCost('lyria-full', 'lyria-3.5').label).toContain('$0.08');

    const lyria = buildLyriaInteractionRequest({
      modelId: 'lyria-3-clip-preview',
      prompt: '16-bit boss loop',
      referenceImages: [{ base64: 'AABBCC==', mimeType: 'image/png' }],
    });
    expect(lyria.url).toContain('/interactions');
    expect(lyria.payload.model).toBe('lyria-3-clip-preview');
    expect(lyria.payload.input).toEqual([
      { type: 'text', text: '16-bit boss loop' },
      { type: 'image', data: 'AABBCC==', mime_type: 'image/png' },
    ]);

    const tts = buildGeminiTtsRequest({
      modelId: 'gemini-3.8-flash-tts',
      voiceName: 'Fenrir',
      styleDirection: 'Short warrior grunt',
      script: '<grunt> Agh!',
    });
    expect(tts.url).toContain('/models/gemini-3.8-flash-tts:generateContent');
    expect(tts.payload.generationConfig).toEqual({
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: 'Fenrir',
          },
        },
      },
    });

    const synthReq = buildGeminiToSynthRequest({
      modelId: 'gemini-2.5-flash',
      prompt: 'punchy metal clash',
      spritePngBase64: 'PNGDATA==',
    });
    expect(synthReq.url).toContain('/models/gemini-2.5-flash:generateContent');
    expect(synthReq.payload.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseSchema: PROCEDURAL_SFX_RESPONSE_SCHEMA,
    });
  });

  it('redacts Gemini API key AIzaSyTESTAUDIO999 from thrown 401/429/500 ProviderError diagnostics', async () => {
    const dummySecret = 'AIzaSyTESTAUDIO999';
    for (const status of [401, 429, 500]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status,
          text: async () => `Upstream error for key=${dummySecret} (${status})`,
        })),
      );

      let caught: unknown;
      try {
        await invokeGoogleAudioRoute({
          route: 'lyria-clip',
          modelId: 'lyria-3-clip-preview',
          apiKey: dummySecret,
          prompt: 'test track',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ProviderError);
      const pe = caught as ProviderError;
      expect(pe.status).toBe(status);
      expect(pe.message).not.toContain(dummySecret);
      expect(pe.remediation).not.toContain(dummySecret);
    }
  });

  it('persists AudioAsset + WAV blobs cleanly in Dexie and leaves zero orphan blobs on deletion', async () => {
    const { db, repo } = createTestRepo();
    const project = await repo.createProject('M14B Audio Test');

    const mainBlob = await repo.storeBlob(
      new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' }),
      'audio/wav',
    );
    const v1Blob = await repo.storeBlob(
      new Blob([new Uint8Array([5, 6])], { type: 'audio/wav' }),
      'audio/wav',
    );
    const v2Blob = await repo.storeBlob(
      new Blob([new Uint8Array([7, 8])], { type: 'audio/wav' }),
      'audio/wav',
    );

    await repo.saveAudioAsset({
      id: 'sfx-1',
      projectId: project.id,
      name: 'Hit Impact',
      presetId: 'sfx-sprite-impact',
      route: 'local-synth',
      modelId: 'nibgrid-synth-v1',
      wavBlobId: mainBlob.id,
      variationBlobIds: [v1Blob.id, v2Blob.id],
      postProcess: createDefaultAudioPostProcessConfig(),
      lufs: -14.1,
      durationSec: 0.25,
      createdAt: new Date().toISOString(),
    });

    expect(await findOrphanBlobIds(db)).toEqual([]);
    const list = await repo.listAudioAssets(project.id);
    expect(list).toHaveLength(1);
    expect(list[0]!.variationBlobIds).toHaveLength(2);

    await repo.deleteAudioAsset('sfx-1');
    expect(await repo.listAudioAssets(project.id)).toHaveLength(0);
    expect(await findOrphanBlobIds(db)).toEqual([]);
    expect(await db.blobs.count()).toBe(0);
  });
});
