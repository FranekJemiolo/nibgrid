import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspaceRulesBlock,
  resolveAtMentions,
  type AgentProjectIndex,
} from '../../src/agent/contextResolver';
import { STUDIO_TOOL_NAMES } from '../../src/agent/studioToolRegistry';
import { createDefaultMockProviderConfig } from '../../src/db/database';
import { EntityDefinitionSchema } from '../../src/domain/entitySchema';
import {
  createDefaultArtBible,
  createDefaultShaderConfig,
  type Project,
  type ProviderConfig,
} from '../../src/domain/schemas';
import {
  buildGeminiAgentRequest,
  planAgentTurn,
  planOfflineMockAgentTurn,
} from '../../src/providers/assetAgentAdapter';
import { ProviderError } from '../../src/providers/errors';

function createFixtureIndex(): AgentProjectIndex {
  const artBible = createDefaultArtBible();
  const project: Project = {
    id: 'proj-m38b',
    name: 'M38B Agent Fixture',
    artBible,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const entity = EntityDefinitionSchema.parse({
    id: 'ent-goblin',
    projectId: project.id,
    slug: 'goblin_scout',
    displayName: 'Goblin Scout',
    primarySpriteNodeId: 'spr-goblin',
    shaderConfig: createDefaultShaderConfig('hit_flash'),
    updatedAt: Date.now(),
  });
  return {
    project,
    spriteNodes: [],
    entities: [entity],
    audioAssets: [],
    rooms: [],
  };
}

describe('M38B: Asset Agent Adapter (Gemini Function Calling, Offline Mock & Key Redaction)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('buildGeminiAgentRequest embeds ArtBible workspace rules, resolved @ context, and all 8 tool declarations', () => {
    const index = createFixtureIndex();
    const resolved = resolveAtMentions('Add muzzle socket to @goblin_scout', index);
    const rulesBlock = buildWorkspaceRulesBlock(index.project.artBible);

    const geminiConfig: ProviderConfig = {
      id: 'gemini-byok',
      kind: 'gemini',
      displayName: 'Gemini Flash',
      modelId: 'gemini-2.5-flash',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: 'AIzaSyTESTBUILD123',
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    };

    const req = buildGeminiAgentRequest({
      prompt: 'Add muzzle socket to @goblin_scout',
      resolvedContext: resolved,
      rulesBlock,
      providerConfig: geminiConfig,
    });

    expect(req.headers['x-goog-api-key']).toBe('AIzaSyTESTBUILD123');
    expect(req.body.systemInstruction.parts[0].text).toContain(index.project.artBible.palette[0]!);
    expect(req.body.contents[0].parts[0]).toEqual(
      expect.objectContaining({
        text: expect.stringContaining('@goblin_scout'),
      }),
    );
    const declNames = req.body.tools[0].functionDeclarations.map((d) => d.name);
    for (const toolName of STUDIO_TOOL_NAMES) {
      expect(declNames).toContain(toolName);
    }
  });

  it('Offline Mock Agent plans 2 Zod-valid tool calls for socket + shader prompt with $0.00 cost', async () => {
    const index = createFixtureIndex();
    const prompt = 'Add muzzle socket to @goblin_scout and swap @hit_flash shader';
    const resolved = resolveAtMentions(prompt, index);
    const mockCfg = createDefaultMockProviderConfig();

    const plan = planOfflineMockAgentTurn(prompt, resolved, index.project.artBible);
    expect(plan.usedMock).toBe(true);
    expect(plan.estimatedUsd).toBe(0);
    expect(plan.toolCalls.map((c) => c.toolName)).toEqual([
      'add_or_move_socket',
      'update_gdshader_uniforms',
    ]);

    const viaDispatch = await planAgentTurn(prompt, resolved, index.project.artBible, mockCfg);
    expect(viaDispatch.usedMock).toBe(true);
    expect(viaDispatch.toolCalls).toHaveLength(2);
  });

  it('parses valid Gemini functionCall parts and strips AIzaSyAGENT999 completely on HTTP 401 and 429', async () => {
    const index = createFixtureIndex();
    const resolved = resolveAtMentions('Update @goblin_scout socket', index);
    const secretKey = 'AIzaSyAGENT999SECRET';

    const geminiConfig: ProviderConfig = {
      id: 'gemini-byok',
      kind: 'gemini',
      displayName: 'Gemini Flash',
      modelId: 'gemini-2.5-flash',
      endpointUrl: 'https://generativelanguage.googleapis.com/v1beta',
      apiKey: secretKey,
      enabled: true,
      capabilities: {
        supportsInpaint: true,
        supportsMultiRef: true,
        supportsSeed: false,
        isLocal: false,
      },
      updatedAt: new Date().toISOString(),
    };

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: {
                      name: 'add_or_move_socket',
                      args: {
                        targetSlug: 'goblin_scout',
                        socketName: 'cape_tip',
                        normX: 0.2,
                        normY: 0.8,
                      },
                    },
                  },
                ],
              },
            },
          ],
        }),
      })),
    );

    const plan = await planAgentTurn(
      'Add cape_tip socket to @goblin_scout',
      resolved,
      index.project.artBible,
      geminiConfig,
    );
    expect(plan.usedMock).toBe(false);
    expect(plan.toolCalls).toHaveLength(1);
    expect(plan.toolCalls[0]!.toolName).toBe('add_or_move_socket');

    for (const status of [401, 429]) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: false,
          status,
          text: async () => `Upstream failure leaking key ${secretKey}`,
        })),
      );

      let caught: unknown;
      try {
        await planAgentTurn(
          'Add cape_tip socket to @goblin_scout',
          resolved,
          index.project.artBible,
          geminiConfig,
        );
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ProviderError);
      const pe = caught as ProviderError;
      expect(pe.message).not.toContain(secretKey);
      expect(pe.remediation).not.toContain(secretKey);
    }
  });
});
