import {
  buildWorkspaceRulesBlock,
  slugifyAssetLabel,
  type MentionResolutionResult,
  type ResolvedContextAsset,
} from '../agent/contextResolver';
import {
  STUDIO_GEMINI_TOOL_DECLARATIONS,
  StudioToolCallSchema,
  estimateToolCallCostUsd,
  type StudioToolCall,
} from '../agent/studioToolRegistry';
import type { ArtBible, ProviderConfig } from '../domain/schemas';
import { getBridgeSessionToken, resolveBridgeBaseUrl } from './antigravityBridgeProvider';
import { ProviderError, classifyProviderError } from './errors';
import { resolveGeminiBaseUrl } from './geminiProvider';
import { resolveParallaxTextModelId } from './parallaxGenerator';

export interface AgentTurnPlan {
  readonly planSummary: string;
  readonly toolCalls: readonly StudioToolCall[];
  readonly estimatedUsd: number;
  readonly providerLabel: string;
  readonly usedMock: boolean;
}

export interface AgentThumbnailInput {
  readonly slug: string;
  readonly mimeType: string;
  readonly base64Data: string;
}

export interface BuildGeminiAgentRequestInput {
  readonly prompt: string;
  readonly resolvedContext: MentionResolutionResult;
  readonly rulesBlock: string;
  readonly providerConfig: ProviderConfig;
  readonly thumbnails?: readonly AgentThumbnailInput[];
}

export interface GeminiAgentRequestSpec {
  readonly url: string;
  readonly modelId: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly systemInstruction: { readonly parts: [{ readonly text: string }] };
    readonly contents: [
      {
        readonly role: 'user';
        readonly parts: readonly (
          | { readonly text: string }
          | { readonly inlineData: { readonly mimeType: string; readonly data: string } }
        )[];
      },
    ];
    readonly tools: [{ readonly functionDeclarations: typeof STUDIO_GEMINI_TOOL_DECLARATIONS }];
    readonly toolConfig: { readonly functionCallingConfig: { readonly mode: 'AUTO' } };
  };
}

function formatResolvedContextText(resolvedContext: MentionResolutionResult): string {
  if (resolvedContext.resolved.length === 0) {
    return 'Resolved @ Mentions: (none explicitly mentioned — operate on active context target)';
  }
  const lines = ['Resolved @ Mentions:'];
  for (const item of resolvedContext.resolved) {
    lines.push(`- [${item.kind}] @${item.slug} (id=${item.id}): ${item.summary}`);
  }
  return lines.join('\n');
}

/**
 * Compiles a structured Gemini Flash Function Calling request embedding
 * `.nibgridrules` (`ArtBible`), resolved `@` asset context, optional PNG thumbnails,
 * and all 8 `StudioToolName` function declarations.
 */
export function buildGeminiAgentRequest(
  input: BuildGeminiAgentRequestInput,
): GeminiAgentRequestSpec {
  const baseUrl = resolveGeminiBaseUrl(input.providerConfig.endpointUrl);
  const modelId = resolveParallaxTextModelId(input.providerConfig.modelId);
  const url = `${baseUrl}/models/${encodeURIComponent(modelId)}:generateContent`;

  const userText = [
    'USER ASSET EDIT REQUEST:',
    input.prompt.trim(),
    '',
    formatResolvedContextText(input.resolvedContext),
    '',
    'Emit deterministic Studio tool calls referencing exact resolved target slugs.',
  ].join('\n');

  const parts: (
    | { readonly text: string }
    | { readonly inlineData: { readonly mimeType: string; readonly data: string } }
  )[] = [{ text: userText }];

  for (const thumb of (input.thumbnails ?? []).slice(0, 4)) {
    parts.push({
      inlineData: {
        mimeType: thumb.mimeType || 'image/png',
        data: thumb.base64Data,
      },
    });
  }

  return {
    url,
    modelId,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': input.providerConfig.apiKey.trim(),
    },
    body: {
      systemInstruction: {
        parts: [{ text: input.rulesBlock }],
      },
      contents: [{ role: 'user', parts }],
      tools: [{ functionDeclarations: STUDIO_GEMINI_TOOL_DECLARATIONS }],
      toolConfig: {
        functionCallingConfig: {
          mode: 'AUTO',
        },
      },
    },
  };
}

function extractTintHexFromPrompt(lower: string): string | undefined {
  if (/\b(emerald|toxic|green|acid|poison)\b/.test(lower)) return '#10B981';
  if (/\b(crimson|red|blood|scarlet)\b/.test(lower)) return '#DC2626';
  if (/\b(cyan|ice|frost|blue)\b/.test(lower)) return '#38BDF8';
  if (/\b(gold|amber|yellow)\b/.test(lower)) return '#F59E0B';
  if (/\b(violet|purple|arcane)\b/.test(lower)) return '#A855F7';
  const explicitHex = /#([0-9a-f]{6})\b/i.exec(lower);
  if (explicitHex?.[1]) {
    return `#${explicitHex[1].toUpperCase()}`;
  }
  return undefined;
}

function findPrimaryActorTarget(
  resolvedContext: MentionResolutionResult,
  fallbackTargetSlug?: string,
): ResolvedContextAsset | undefined {
  return (
    resolvedContext.resolved.find((r) => r.kind === 'entity' || r.kind === 'sprite') ??
    (fallbackTargetSlug
      ? {
          kind: 'sprite',
          id: fallbackTargetSlug,
          slug: slugifyAssetLabel(fallbackTargetSlug),
          label: `@${slugifyAssetLabel(fallbackTargetSlug)}`,
          summary: 'Active target',
        }
      : undefined)
  );
}

/**
 * Deterministic `$0.00` Offline Mock Agent planner converting natural-language
 * prompts + `@` mentions into Zod-validated `StudioToolCall[]` for offline editing & CI.
 */
export function planOfflineMockAgentTurn(
  prompt: string,
  resolvedContext: MentionResolutionResult,
  _artBible: ArtBible,
  options: { readonly fallbackTargetSlug?: string } = {},
): AgentTurnPlan {
  const trimmed = prompt.trim();
  const lower = trimmed.toLowerCase();
  const calls: StudioToolCall[] = [];

  const actorTargets = resolvedContext.resolved.filter(
    (r) => r.kind === 'entity' || r.kind === 'sprite',
  );
  const primaryActor = findPrimaryActorTarget(resolvedContext, options.fallbackTargetSlug);
  const shaderTarget = resolvedContext.resolved.find((r) => r.kind === 'shader');
  const roomTarget = resolvedContext.resolved.find((r) => r.kind === 'room');
  const tintHex = extractTintHexFromPrompt(lower);

  // 1. Socket tool intent
  if (/\b(socket|muzzle|hand_r|hand_l|cape_tip|exhaust|marker)\b/.test(lower) && primaryActor) {
    const socketMatch = /\b(muzzle|hand_r|hand_l|cape_tip|exhaust|head|center)\b/.exec(lower);
    const socketName = socketMatch?.[1] ?? 'muzzle';
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'add_or_move_socket',
        args: {
          targetSlug: primaryActor.slug,
          socketName,
          normX: socketName === 'cape_tip' ? 0.25 : 0.78,
          normY: socketName === 'cape_tip' ? 0.72 : 0.48,
          baseAngleDeg: 0,
        },
      }),
    );
  }

  // 2. Shader tool intent
  if (/\b(shader|hit_flash|flash|uniform|sheen|ripple|sway|outline_shader)\b/.test(lower)) {
    const targetSlug =
      primaryActor?.slug ?? shaderTarget?.slug ?? options.fallbackTargetSlug ?? 'hero';
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'update_gdshader_uniforms',
        args: {
          targetSlug,
          presetId: shaderTarget?.slug ?? 'hit_flash',
          ...(tintHex ? { tintHex } : {}),
        },
      }),
    );
  }

  // 3. Repalette / outline snap intent
  if (
    /\b(repalette|palette|snap|outline|recolor)\b/.test(lower) &&
    (actorTargets.length > 0 || primaryActor)
  ) {
    const slugs = actorTargets.length > 0 ? actorTargets.map((t) => t.slug) : [primaryActor!.slug];
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'repalette_sprites',
        args: {
          targetSlugs: Array.from(new Set(slugs)),
          ...(tintHex ? { outlineTintHex: tintHex } : {}),
          dither: false,
        },
      }),
    );
  }

  // 4. Masked Inpaint intent
  if (/\b(inpaint|redraw|visor|helmet|cape|blade|paint|draw)\b/.test(lower) && primaryActor) {
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'inpaint_sprite_region',
        args: {
          targetSlug: primaryActor.slug,
          promptDelta: trimmed || 'Clean crisp pixel art silhouette polish',
          snapToPalette: true,
          maskRegion: /\b(cape|boots|lower)\b/.test(lower) ? 'lower' : 'upper',
        },
      }),
    );
  }

  // 5. Collider recompute intent
  if (/\b(collider|hitbox|hurtbox|hull|capsule|physics)\b/.test(lower) && primaryActor) {
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'recompute_colliders',
        args: {
          targetSlug: primaryActor.slug,
          kind: /\bcapsule\b/.test(lower) ? 'capsule' : 'convex-hull',
          maxVertices: 8,
          addHitbox: true,
        },
      }),
    );
  }

  // 6. Procedural SFX cue intent
  if (/\b(sfx|sound|audio|wav|poison|drip|slash|footstep|jump|pickup)\b/.test(lower)) {
    const preset = /\bjump\b/.test(lower)
      ? 'jump'
      : /\bpickup|coin|chime\b/.test(lower)
        ? 'pickup'
        : /\bfootstep|step\b/.test(lower)
          ? 'footstep'
          : /\bslash|attack|sword|laser\b/.test(lower)
            ? 'attack'
            : 'hit';
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'generate_sfx_cue',
        args: {
          cueName: /\bpoison\b/.test(lower) ? 'poison_drip' : `agent_${preset}`,
          proceduralPreset: preset,
          ...(primaryActor?.kind === 'entity' ? { attachEntitySlug: primaryActor.slug } : {}),
          frameIndex: /\bframe\s*(\d+)/i.test(trimmed)
            ? Number(/\bframe\s*(\d+)/i.exec(trimmed)![1])
            : 0,
        },
      }),
    );
  }

  // 7. Room layout intent
  if (/\b(room|platform|spawn|arena|level)\b/.test(lower) && roomTarget) {
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'patch_room_layout',
        args: {
          roomSlug: roomTarget.slug,
          addPlatforms: [{ row: 8, startCol: 4, endCol: 10 }],
        },
      }),
    );
  }

  // 8. Godot res:// diff preview intent
  if (/\b(sync|godot|res:\/\/)\b/.test(lower)) {
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'sync_godot_diff',
        args: { scope: 'all' },
      }),
    );
  }

  // 9. Director Verb: Create entity from prompt
  if (/\b(create|spawn|add)\s+(?:an?\s+)?(?:entity|enemy|hero|npc|prop)\b/.test(lower)) {
    const slugMatch =
      /(?:named|called|enemy|hero|npc|prop)\s+([a-z][a-z0-9_]*)/i.exec(trimmed) ??
      /\b([a-z]+_[a-z0-9_]+)\b/i.exec(trimmed);
    const slug = slugMatch?.[1]?.toLowerCase() ?? 'frost_bat';
    const role = /\bhero|player\b/.test(lower)
      ? 'hero'
      : /\bprop|chest|crate\b/.test(lower)
        ? 'prop'
        : /\bnpc|merchant|guard\b/.test(lower)
          ? 'npc'
          : 'enemy';
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'create_entity_from_prompt',
        args: {
          slug,
          prompt: trimmed,
          role,
        },
      }),
    );
  }

  // 10. Director Verb: Create or connect room in WorldGraph
  if (/\b(create|add|connect)\s+(?:a\s+)?room\b/.test(lower)) {
    const roomSlugMatch = /room\s+([a-z][a-z0-9_]*)/i.exec(trimmed);
    const roomSlug = roomSlugMatch?.[1]?.toLowerCase() ?? 'crypt_annex';
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'create_or_connect_room',
        args: {
          roomSlug,
          prompt: trimmed,
        },
      }),
    );
  }

  // 11. Director Verb: Tune game balance
  if (/\b(balance|ttk|hp|nerf|buff)\b/.test(lower)) {
    const targetSlug = primaryActor?.slug ?? 'goblin_scout';
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'tune_game_balance',
        args: {
          enemySlug: targetSlug,
          targetTtkSec: /\bfaster|easier|nerf\b/.test(lower) ? 3.5 : 5.0,
        },
      }),
    );
  }

  // 12. Director Verb: Author localized dialogue node
  if (/\b(dialogue|dialog|npc line|say)\b/.test(lower)) {
    const nodeMatch = /\bnode\s+([a-z][a-z0-9_]*)/i.exec(trimmed);
    const quotedMatch = /"([^"]+)"/.exec(trimmed);
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'author_dialogue_node',
        args: {
          nodeId: nodeMatch?.[1]?.toLowerCase() ?? 'director_greet',
          speaker: primaryActor?.slug ?? 'Guard',
          enText: quotedMatch?.[1] ?? 'Watch your step in the crypt!',
          plText: 'Uważaj na siebie w krypcie!',
          deText: 'Pass in der Krypta auf!',
        },
      }),
    );
  }

  // 13. Director Verb: Pre-flight autofix
  if (/\b(autofix|self-heal|heal|preflight)\b/.test(lower)) {
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'run_preflight_autofix',
        args: { scope: 'all' },
      }),
    );
  }

  // Fallback: if no specific keyword matched cleanly, default to deterministic repalette on primary target
  if (calls.length === 0 && primaryActor) {
    calls.push(
      StudioToolCallSchema.parse({
        toolName: 'repalette_sprites',
        args: {
          targetSlugs: [primaryActor.slug],
          ...(tintHex ? { outlineTintHex: tintHex } : {}),
          dither: false,
        },
      }),
    );
  }

  return {
    planSummary:
      calls.length > 0
        ? `Offline Mock planned ${calls.length} Studio tool call(s)`
        : 'No target resolved — @ mention a sprite, entity, shader, or room',
    toolCalls: calls,
    estimatedUsd: 0,
    providerLabel: 'Offline Mock Agent ($0.00)',
    usedMock: true,
  };
}

function parseGeminiFunctionCalls(json: unknown): StudioToolCall[] {
  const root = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {};
  const candidates = Array.isArray(root.candidates) ? root.candidates : [];
  const calls: StudioToolCall[] = [];

  for (const cand of candidates) {
    const content =
      typeof cand === 'object' && cand !== null ? (cand as Record<string, unknown>).content : null;
    const parts =
      typeof content === 'object' &&
      content !== null &&
      Array.isArray((content as { parts?: unknown }).parts)
        ? ((content as { parts: unknown[] }).parts ?? [])
        : [];

    for (const part of parts) {
      if (typeof part !== 'object' || part === null) continue;
      const fc = (part as { functionCall?: { name?: unknown; args?: unknown } }).functionCall;
      if (!fc || typeof fc.name !== 'string') continue;
      const parsed = StudioToolCallSchema.safeParse({
        toolName: fc.name,
        args: typeof fc.args === 'object' && fc.args !== null ? fc.args : {},
      });
      if (parsed.success) {
        calls.push(parsed.data);
      }
    }
  }

  return calls;
}

export interface PlanAgentTurnOptions {
  readonly customRules?: string;
  readonly thumbnails?: readonly AgentThumbnailInput[];
  readonly fallbackTargetSlug?: string;
  readonly forceMock?: boolean;
  readonly signal?: AbortSignal;
}

/**
 * Plans one Asset Agent turn across Gemini Flash Function Calling (BYOK),
 * the local Antigravity Loopback Bridge (`127.0.0.1:4188`), or the `$0.00`
 * Offline Mock Agent. Redacts secrets completely on provider failure.
 */
export async function planAgentTurn(
  prompt: string,
  resolvedContext: MentionResolutionResult,
  artBible: ArtBible,
  providerConfig: ProviderConfig,
  options: PlanAgentTurnOptions = {},
): Promise<AgentTurnPlan> {
  if (
    options.forceMock ||
    providerConfig.kind === 'mock' ||
    providerConfig.kind === 'antigravity-agent'
  ) {
    return planOfflineMockAgentTurn(prompt, resolvedContext, artBible, {
      fallbackTargetSlug: options.fallbackTargetSlug,
    });
  }

  const rulesBlock = buildWorkspaceRulesBlock(artBible, options.customRules);

  if (providerConfig.kind === 'antigravity-bridge') {
    const baseUrl = resolveBridgeBaseUrl(providerConfig.endpointUrl);
    const token = getBridgeSessionToken(providerConfig.id, providerConfig.apiKey);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
        headers['x-nibgrid-token'] = token;
      }
      const res = await fetch(`${baseUrl}/agent/plan`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          prompt: prompt.trim(),
          rulesBlock,
          resolvedContext,
          tools: STUDIO_GEMINI_TOOL_DECLARATIONS,
        }),
        signal: options.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw { status: res.status, responseText: txt };
      }
      const rawJson = (await res.json()) as { toolCalls?: unknown };
      const toolCalls: StudioToolCall[] = [];
      for (const tc of Array.isArray(rawJson.toolCalls) ? rawJson.toolCalls : []) {
        const valid = StudioToolCallSchema.safeParse(tc);
        if (valid.success) toolCalls.push(valid.data);
      }
      const estimatedUsd = toolCalls.reduce(
        (sum, c) => sum + estimateToolCallCostUsd(c, 'antigravity-bridge'),
        0,
      );
      return {
        planSummary: `Antigravity Bridge planned ${toolCalls.length} tool call(s)`,
        toolCalls,
        estimatedUsd,
        providerLabel: providerConfig.displayName || 'Antigravity Bridge',
        usedMock: false,
      };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw classifyProviderError(err, {
        providerId: providerConfig.id,
        providerKind: providerConfig.kind,
        endpointUrl: providerConfig.endpointUrl,
        secrets: [providerConfig.apiKey, token],
      });
    }
  }

  // Gemini Flash Function Calling
  const reqSpec = buildGeminiAgentRequest({
    prompt,
    resolvedContext,
    rulesBlock,
    providerConfig,
    thumbnails: options.thumbnails,
  });

  try {
    const res = await fetch(reqSpec.url, {
      method: 'POST',
      headers: reqSpec.headers,
      body: JSON.stringify(reqSpec.body),
      signal: options.signal,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw { status: res.status, responseText: txt };
    }

    const json = (await res.json()) as unknown;
    const toolCalls = parseGeminiFunctionCalls(json);
    if (toolCalls.length === 0) {
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        providerId: providerConfig.id,
        retryable: true,
        message: 'Gemini returned no valid Studio tool calls for that prompt.',
        remediation: 'Mention a target asset with @slug or switch to Offline Mock Agent.',
      });
    }

    const estimatedUsd = toolCalls.reduce(
      (sum, c) => sum + estimateToolCallCostUsd(c, providerConfig.kind),
      0,
    );

    return {
      planSummary: `Gemini Flash planned ${toolCalls.length} Studio tool call(s)`,
      toolCalls,
      estimatedUsd,
      providerLabel: `${providerConfig.displayName} (${reqSpec.modelId})`,
      usedMock: false,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: providerConfig.endpointUrl,
      secrets: [providerConfig.apiKey],
    });
  }
}
