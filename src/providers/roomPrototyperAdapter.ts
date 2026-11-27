import type { ArtBible, ProviderConfig, ProviderKind } from '../domain/schemas';
import {
  ROOM_BLUEPRINT_GEMINI_RESPONSE_SCHEMA,
  parseAndClampRoomBlueprint,
  sanitizeRoomPlacements,
  sanitizeRoomSlug,
  type RoomCellKind,
  type RoomEntityPlacement,
  type RoomLayoutBlueprint,
} from '../processing/roomLayoutCore';
import { classifyProviderError, ProviderError } from './errors';
import { resolveGeminiBaseUrl, type GeminiGenerateContentResponse } from './geminiProvider';
import { resolveParallaxTextModelId } from './parallaxGenerator';

export interface RoomStarterPreset {
  readonly id: string;
  readonly label: string;
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
}

export const ROOM_STARTER_PRESETS: readonly RoomStarterPreset[] = [
  {
    id: 'side-scroller-arena',
    label: 'Side-Scroller Arena',
    prompt:
      'Dungeon boss arena with two stone pillars, raised side platforms, and goblin scouts guarding a chest',
    cols: 24,
    rows: 14,
  },
  {
    id: 'top-down-dungeon',
    label: 'Top-Down Dungeon Room',
    prompt:
      'Top-down stone sanctum with corner pillars, center altar platform, and patrolling skeleton sentries',
    cols: 20,
    rows: 14,
  },
  {
    id: 'vertical-shaft',
    label: 'Vertical Shaft',
    prompt:
      'Tall vertical cavern shaft with alternating one-way wooden ledges, alcoves, and perched ambushers',
    cols: 16,
    rows: 24,
  },
  {
    id: 'treasure-vault',
    label: 'Treasure Vault',
    prompt:
      'Symmetrical fortified treasure vault with elevated central chest plinth and twin guard posts',
    cols: 22,
    rows: 12,
  },
];

export interface RoomCostEstimate {
  readonly usd: number;
  readonly label: string;
}

export function estimateRoomPrototyperCost(providerKind: ProviderKind): RoomCostEstimate {
  if (providerKind === 'gemini') {
    return { usd: 0.001, label: '~$0.001' };
  }
  if (providerKind === 'mock') {
    return { usd: 0, label: 'Offline Mock • $0.00' };
  }
  return { usd: 0, label: 'Local • $0.00' };
}

export interface GeminiRoomBlueprintRequest {
  readonly url: string;
  readonly modelId: string;
  readonly headers: Record<string, string>;
  readonly body: {
    contents: [{ role: 'user'; parts: [{ text: string }] }];
    generationConfig: {
      responseMimeType: 'application/json';
      responseSchema: typeof ROOM_BLUEPRINT_GEMINI_RESPONSE_SCHEMA;
      temperature: number;
    };
  };
}

export function buildGeminiRoomBlueprintRequest(params: {
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly tileSizePx: number;
  readonly artBible: ArtBible;
  readonly availableEntitySlugs: readonly string[];
  readonly providerConfig: ProviderConfig;
}): GeminiRoomBlueprintRequest {
  const baseUrl = resolveGeminiBaseUrl(params.providerConfig.endpointUrl);
  const textModel = resolveParallaxTextModelId(params.providerConfig.modelId);
  const url = `${baseUrl}/models/${encodeURIComponent(textModel)}:generateContent`;
  const entityList =
    params.availableEntitySlugs.length > 0
      ? params.availableEntitySlugs.map(sanitizeRoomSlug).join(', ')
      : 'goblin_scout, treasure_chest';

  const plannerPrompt = [
    "You are Nibgrid's Godot 4 TileMapLayer Room & Encounter Director.",
    `User room request: "${params.prompt.trim()}"`,
    `Grid dimensions: exact cols=${params.cols}, exact rows=${params.rows}, tileSizePx=${params.tileSizePx}.`,
    `Art Bible context: artMode=${params.artBible.artMode}, projection=${params.artBible.projection}, lighting=${params.artBible.lighting}.`,
    `Available Entity Prefab Slugs: [${entityList}]. Prefer spawning entities from this list.`,
    `Return ONLY JSON matching the schema.`,
    `gridRows must contain exactly ${params.rows} strings, each exactly ${params.cols} characters long using '0' (empty), '1' (solid terrain), or '2' (one-way platform).`,
    `Ensure playerSpawn and every entity spawn sit on empty ('0') or platform ('2') cells, never inside solid ('1') tiles.`,
  ].join('\n');

  return {
    url,
    modelId: textModel,
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': params.providerConfig.apiKey.trim(),
    },
    body: {
      contents: [{ role: 'user', parts: [{ text: plannerPrompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: ROOM_BLUEPRINT_GEMINI_RESPONSE_SCHEMA,
        temperature: 0.25,
      },
    },
  };
}

function hashStringFnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Deterministic $0.00 offline room generator producing playable 2D platformer, shaft, vault,
 * or top-down dungeon layouts tuned to the prompt & available M25 entities.
 */
export function generateMockRoomBlueprint(params: {
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly tileSizePx: number;
  readonly availableEntitySlugs?: readonly string[];
}): RoomLayoutBlueprint {
  const cols = Math.max(12, Math.min(64, Math.round(params.cols)));
  const rows = Math.max(8, Math.min(32, Math.round(params.rows)));
  const tileSizePx = Math.max(8, Math.min(128, Math.round(params.tileSizePx)));
  const trimmedPrompt = params.prompt.trim() || 'Stone dungeon arena with raised platforms';
  const lower = trimmedPrompt.toLowerCase();
  const seed = hashStringFnv1a(`${lower}|${cols}x${rows}`);

  const cells: RoomCellKind[][] = Array.from({ length: rows }, (_, y) =>
    Array.from({ length: cols }, (_, x) => {
      if (y === 0 || y === rows - 1 || x === 0 || x === cols - 1) return 1;
      return 0;
    }),
  );

  const floorY = rows - 2;
  const isTopDown = /\b(top-down|topdown|sanctum|crypt|corridor|courtyard)\b/.test(lower);
  const isShaft = /\b(shaft|tower|climb|vertical|well)\b/.test(lower) || rows > cols;
  const isVault = /\b(vault|treasure|shrine|plinth)\b/.test(lower);

  if (isTopDown) {
    const midX = Math.floor(cols / 2);
    const midY = Math.floor(rows / 2);
    const offsets: readonly [number, number][] = [
      [Math.max(3, Math.floor(cols * 0.25)), Math.max(3, Math.floor(rows * 0.3))],
      [Math.min(cols - 4, Math.floor(cols * 0.75)), Math.max(3, Math.floor(rows * 0.3))],
      [Math.max(3, Math.floor(cols * 0.25)), Math.min(rows - 4, Math.floor(rows * 0.7))],
      [Math.min(cols - 4, Math.floor(cols * 0.75)), Math.min(rows - 4, Math.floor(rows * 0.7))],
    ];
    for (const [px, py] of offsets) {
      cells[py]![px] = 1;
    }
    for (let x = midX - 1; x <= midX + 1; x++) {
      if (x > 1 && x < cols - 2) {
        cells[midY]![x] = 2;
      }
    }
  } else if (isShaft) {
    for (let y = rows - 4; y >= 3; y -= 3) {
      const leftSide = ((rows - y + seed) & 1) === 0;
      const startX = leftSide ? 2 : Math.max(2, Math.floor(cols * 0.45));
      const endX = leftSide ? Math.min(cols - 3, Math.floor(cols * 0.55)) : cols - 3;
      for (let x = startX; x <= endX; x++) {
        cells[y]![x] = 2;
      }
    }
  } else if (isVault) {
    const midX = Math.floor(cols / 2);
    for (let x = midX - 2; x <= midX + 2; x++) {
      cells[floorY]![x] = 1;
      if (floorY - 2 >= 2) {
        cells[floorY - 2]![x] = 2;
      }
    }
    if (cols >= 16) {
      for (let y = floorY - 3; y <= floorY; y++) {
        cells[y]![4] = 1;
        cells[y]![cols - 5] = 1;
      }
    }
  } else {
    // Side-scroller arena: raised side platforms + twin stone pillars
    const leftEnd = Math.min(cols - 4, Math.max(5, Math.floor(cols * 0.28)));
    const rightStart = Math.max(leftEnd + 2, Math.floor(cols * 0.72));
    const platY = Math.max(3, rows - 5);
    for (let x = 2; x <= leftEnd; x++) {
      cells[platY]![x] = 2;
    }
    for (let x = rightStart; x <= cols - 3; x++) {
      cells[platY]![x] = 2;
    }

    const pillarL = Math.max(4, Math.floor(cols * 0.34));
    const pillarR = Math.min(cols - 5, Math.floor(cols * 0.66));
    for (let y = Math.max(3, floorY - 2); y <= floorY; y++) {
      cells[y]![pillarL] = 1;
      cells[y]![pillarR] = 1;
    }
    // Bridge ledge between pillars when wide enough
    if (pillarR - pillarL >= 5 && rows >= 12) {
      const bridgeY = Math.max(3, floorY - 4);
      for (let x = pillarL + 1; x <= pillarR - 1; x++) {
        cells[bridgeY]![x] = 2;
      }
    }
  }

  const slugs =
    params.availableEntitySlugs && params.availableEntitySlugs.length > 0
      ? params.availableEntitySlugs.map(sanitizeRoomSlug)
      : ['goblin_scout', 'treasure_chest'];

  const entities: RoomEntityPlacement[] = [];
  const enemySlug = slugs[0] ?? 'goblin_scout';
  const secondarySlug = slugs[1] ?? enemySlug;

  const spawnPoints: Array<{ x: number; y: number; facing: 'left' | 'right'; slug: string }> = [
    {
      x: Math.max(3, Math.floor(cols * 0.45)),
      y: isTopDown ? Math.floor(rows * 0.35) : floorY,
      facing: 'left',
      slug: enemySlug,
    },
    {
      x: Math.min(cols - 3, Math.floor(cols * 0.72)),
      y: isTopDown ? Math.floor(rows * 0.65) : floorY,
      facing: 'left',
      slug: enemySlug,
    },
    {
      x: Math.floor(cols * 0.5),
      y: isTopDown ? Math.floor(rows * 0.5) : Math.max(2, rows - 6),
      facing: 'right',
      slug: secondarySlug,
    },
  ];

  spawnPoints.forEach((pt, idx) => {
    entities.push({
      id: `${pt.slug}_${idx + 1}`,
      entitySlug: pt.slug,
      cellX: pt.x,
      cellY: pt.y,
      patrolSpanCells: pt.slug.includes('chest') ? 0 : 3,
      facing: pt.facing,
    });
  });

  const baseWords = trimmedPrompt
    .replace(/[^a-zA-Z0-9\s]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  const displayName =
    baseWords.length > 0
      ? baseWords.map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ')
      : 'Prototyped Arena';

  return sanitizeRoomPlacements({
    slug: sanitizeRoomSlug(displayName),
    displayName,
    prompt: trimmedPrompt,
    cols,
    rows,
    tileSizePx,
    cells,
    playerSpawn: {
      cellX: 2,
      cellY: isTopDown ? Math.floor(rows / 2) : floorY,
    },
    entities,
    notes: 'Deterministic $0.00 offline blueprint layout',
  });
}

function extractTextFromGeminiResponse(json: GeminiGenerateContentResponse): string {
  for (const cand of json.candidates ?? []) {
    for (const part of cand.content?.parts ?? []) {
      const text = (part as { text?: string }).text;
      if (typeof text === 'string' && text.trim().length > 0) {
        return text;
      }
    }
  }
  return '';
}

export interface GenerateRoomBlueprintResult {
  readonly blueprint: RoomLayoutBlueprint;
  readonly costEstimate: RoomCostEstimate;
  readonly usedMock: boolean;
}

/**
 * Generates a bounds-validated `RoomLayoutBlueprint` using Gemini Flash JSON `responseSchema`
 * or deterministic $0.00 Offline Mock synthesis, stripping any provider secrets from failures.
 */
export async function generateRoomBlueprint(params: {
  readonly prompt: string;
  readonly cols: number;
  readonly rows: number;
  readonly tileSizePx: number;
  readonly artBible: ArtBible;
  readonly availableEntitySlugs: readonly string[];
  readonly providerConfig: ProviderConfig;
  readonly signal?: AbortSignal;
}): Promise<GenerateRoomBlueprintResult> {
  if (params.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const { providerConfig } = params;
  const costEstimate = estimateRoomPrototyperCost(providerConfig.kind);

  if (providerConfig.kind !== 'gemini') {
    return {
      blueprint: generateMockRoomBlueprint(params),
      costEstimate,
      usedMock: true,
    };
  }

  const req = buildGeminiRoomBlueprintRequest(params);

  try {
    const res = await fetch(req.url, {
      method: 'POST',
      headers: req.headers,
      body: JSON.stringify(req.body),
      signal: params.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw { status: res.status, responseText: text };
    }

    const json = (await res.json()) as GeminiGenerateContentResponse;
    const rawText = extractTextFromGeminiResponse(json);
    if (!rawText) {
      throw new ProviderError({
        code: 'INVALID_RESPONSE',
        message: 'Gemini returned an empty room blueprint payload.',
        remediation: 'Retry room generation or switch to Offline Mock.',
        providerId: providerConfig.id,
        retryable: true,
      });
    }

    const parsedJson = JSON.parse(rawText) as unknown;
    const blueprint = parseAndClampRoomBlueprint(parsedJson, {
      fallbackPrompt: params.prompt,
      cols: params.cols,
      rows: params.rows,
      tileSizePx: params.tileSizePx,
      availableEntitySlugs: params.availableEntitySlugs,
    });

    return {
      blueprint,
      costEstimate,
      usedMock: false,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw err;
    }
    throw classifyProviderError(err, {
      providerId: providerConfig.id,
      providerKind: providerConfig.kind,
      endpointUrl: providerConfig.endpointUrl,
      secrets: [providerConfig.apiKey],
    });
  }
}
