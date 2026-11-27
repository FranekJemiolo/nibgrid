import { z } from 'zod';
import {
  BIT_E,
  BIT_W,
  computeAutoTileGridMask,
  gateBlobMask,
  getCanonicalBlob47Masks,
  getCanonicalWang16Masks,
} from './autoTile';

export const RoomCellKindSchema = z.union([z.literal(0), z.literal(1), z.literal(2)]);
export type RoomCellKind = z.infer<typeof RoomCellKindSchema>;

export const RoomTileSetModeSchema = z.enum(['wang16', 'blob47']);
export type RoomTileSetMode = z.infer<typeof RoomTileSetModeSchema>;

export const RoomEntityPlacementSchema = z.object({
  id: z.string().min(1),
  entitySlug: z.string().min(1),
  cellX: z.number().int().nonnegative(),
  cellY: z.number().int().nonnegative(),
  patrolSpanCells: z.number().int().min(0).max(32).optional(),
  facing: z.enum(['left', 'right']).optional(),
});
export type RoomEntityPlacement = z.infer<typeof RoomEntityPlacementSchema>;

export const RoomLayoutBlueprintSchema = z
  .object({
    slug: z.string().min(1),
    displayName: z.string().min(1),
    prompt: z.string(),
    cols: z.number().int().min(12).max(64),
    rows: z.number().int().min(8).max(32),
    tileSizePx: z.number().int().min(8).max(128),
    cells: z.array(z.array(RoomCellKindSchema)),
    playerSpawn: z.object({
      cellX: z.number().int().nonnegative(),
      cellY: z.number().int().nonnegative(),
    }),
    entities: z.array(RoomEntityPlacementSchema),
    notes: z.string().optional(),
  })
  .superRefine((bp, ctx) => {
    if (bp.cells.length !== bp.rows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['cells'],
        message: `Expected ${bp.rows} rows in cells matrix, received ${bp.cells.length}.`,
      });
      return;
    }
    for (let r = 0; r < bp.cells.length; r++) {
      if (bp.cells[r]!.length !== bp.cols) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['cells', r],
          message: `Row ${r} expected ${bp.cols} columns, received ${bp.cells[r]!.length}.`,
        });
      }
    }
    if (bp.playerSpawn.cellX >= bp.cols) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['playerSpawn', 'cellX'],
        message: `playerSpawn.cellX (${bp.playerSpawn.cellX}) exceeds cols - 1 (${bp.cols - 1}).`,
      });
    }
    if (bp.playerSpawn.cellY >= bp.rows) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['playerSpawn', 'cellY'],
        message: `playerSpawn.cellY (${bp.playerSpawn.cellY}) exceeds rows - 1 (${bp.rows - 1}).`,
      });
    }
  });
export type RoomLayoutBlueprint = z.infer<typeof RoomLayoutBlueprintSchema>;

export const StoredRoomRecordSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  slug: z.string().min(1),
  tileSetNodeId: z.string().nullable().default(null),
  tileSetMode: RoomTileSetModeSchema.default('blob47'),
  parallaxNodeId: z.string().nullable().default(null),
  blueprint: RoomLayoutBlueprintSchema,
  updatedAt: z.number().int().nonnegative(),
});
export type StoredRoomRecord = z.infer<typeof StoredRoomRecordSchema>;

export const ROOM_BLUEPRINT_GEMINI_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    slug: { type: 'STRING' },
    displayName: { type: 'STRING' },
    gridRows: {
      type: 'ARRAY',
      items: { type: 'STRING' },
    },
    playerSpawn: {
      type: 'OBJECT',
      properties: {
        cellX: { type: 'INTEGER' },
        cellY: { type: 'INTEGER' },
      },
      required: ['cellX', 'cellY'],
    },
    entities: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          entitySlug: { type: 'STRING' },
          cellX: { type: 'INTEGER' },
          cellY: { type: 'INTEGER' },
          patrolSpanCells: { type: 'INTEGER' },
          facing: { type: 'STRING', enum: ['left', 'right'] },
        },
        required: ['entitySlug', 'cellX', 'cellY'],
      },
    },
    notes: { type: 'STRING' },
  },
  required: ['slug', 'displayName', 'gridRows', 'playerSpawn', 'entities'],
} as const;

export interface EncodableTileMapCell {
  readonly x: number;
  readonly y: number;
  readonly sourceId: number;
  readonly atlasX: number;
  readonly atlasY: number;
  readonly altTile: number;
}

export interface ResolvedRoomTileCell extends EncodableTileMapCell {
  readonly kind: 1 | 2;
  readonly mask: number;
}

export function sanitizeRoomSlug(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 48) : 'dungeon_room';
}

function clampInt(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return min;
  return Math.max(min, Math.min(max, Math.round(val)));
}

function findNearestWalkableCell(
  cells: readonly (readonly RoomCellKind[])[],
  startX: number,
  startY: number,
  cols: number,
  rows: number,
): { cellX: number; cellY: number } {
  const sx = clampInt(startX, 0, cols - 1);
  const sy = clampInt(startY, 0, rows - 1);
  const startKind = cells[sy]?.[sx] ?? 0;
  if (startKind !== 1) {
    return { cellX: sx, cellY: sy };
  }

  // Prefer searching upward in the same column first so ground spawns rise cleanly above solid tiles.
  for (let y = sy - 1; y >= 0; y--) {
    if (cells[y]?.[sx] === 0) {
      return { cellX: sx, cellY: y };
    }
  }

  // Deterministic BFS for nearest empty cell (0), then fallback to platform cell (2).
  const visited = new Uint8Array(cols * rows);
  const queue: [number, number][] = [[sx, sy]];
  visited[sy * cols + sx] = 1;
  let fallbackPlatform: { cellX: number; cellY: number } | null = null;
  const dirs: readonly [number, number][] = [
    [0, -1],
    [-1, 0],
    [1, 0],
    [0, 1],
  ];

  let head = 0;
  while (head < queue.length) {
    const [cx, cy] = queue[head++]!;
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const idx = ny * cols + nx;
      if (visited[idx]) continue;
      visited[idx] = 1;
      const kind = cells[ny]?.[nx] ?? 0;
      if (kind === 0) {
        return { cellX: nx, cellY: ny };
      }
      if (kind === 2 && !fallbackPlatform) {
        fallbackPlatform = { cellX: nx, cellY: ny };
      }
      queue.push([nx, ny]);
    }
  }

  return fallbackPlatform ?? { cellX: Math.min(1, cols - 1), cellY: Math.min(1, rows - 1) };
}

/**
 * Ensures `playerSpawn` and all entity spawns stay inside room bounds and never overlap a solid tile (`1`).
 * Searches upward first, then uses deterministic BFS for the nearest non-solid cell, and deduplicates IDs.
 */
export function sanitizeRoomPlacements(blueprint: RoomLayoutBlueprint): RoomLayoutBlueprint {
  const { cols, rows, cells } = blueprint;
  const fixedSpawn = findNearestWalkableCell(
    cells,
    blueprint.playerSpawn.cellX,
    blueprint.playerSpawn.cellY,
    cols,
    rows,
  );

  const usedIds = new Set<string>();
  const fixedEntities: RoomEntityPlacement[] = blueprint.entities.map((ent, index) => {
    const slug = sanitizeRoomSlug(ent.entitySlug);
    const pos = findNearestWalkableCell(cells, ent.cellX, ent.cellY, cols, rows);
    let candidateId = ent.id.trim() || `${slug}_${index + 1}`;
    let suffix = 2;
    while (usedIds.has(candidateId)) {
      candidateId = `${slug}_${index + 1}_${suffix++}`;
    }
    usedIds.add(candidateId);
    return {
      id: candidateId,
      entitySlug: slug,
      cellX: pos.cellX,
      cellY: pos.cellY,
      ...(ent.patrolSpanCells !== undefined
        ? { patrolSpanCells: clampInt(ent.patrolSpanCells, 0, 32) }
        : {}),
      ...(ent.facing ? { facing: ent.facing } : {}),
    };
  });

  return RoomLayoutBlueprintSchema.parse({
    ...blueprint,
    slug: sanitizeRoomSlug(blueprint.slug),
    displayName: blueprint.displayName.trim() || 'Room Arena',
    cells: cells.map((row) => [...row]),
    playerSpawn: fixedSpawn,
    entities: fixedEntities,
  });
}

function coerceCellKind(value: unknown): RoomCellKind {
  if (value === 1 || value === '1') return 1;
  if (value === 2 || value === '2') return 2;
  return 0;
}

/**
 * Parses raw GenAI JSON (`gridRows` string array or `cells` numeric matrix) into a strictly sized,
 * bounds-checked `RoomLayoutBlueprint` with valid non-solid spawn coordinates.
 */
export function parseAndClampRoomBlueprint(
  raw: unknown,
  opts: {
    readonly fallbackPrompt: string;
    readonly cols: number;
    readonly rows: number;
    readonly tileSizePx: number;
    readonly availableEntitySlugs?: readonly string[];
  },
): RoomLayoutBlueprint {
  const cols = clampInt(opts.cols, 12, 64);
  const rows = clampInt(opts.rows, 8, 32);
  const tileSizePx = clampInt(opts.tileSizePx, 8, 128);
  const obj = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};

  const rawDisplayName =
    typeof obj.displayName === 'string' && obj.displayName.trim().length > 0
      ? obj.displayName.trim()
      : 'Prototyped Room';
  const rawSlug =
    typeof obj.slug === 'string' && obj.slug.trim().length > 0 ? obj.slug : rawDisplayName;

  const cells: RoomCellKind[][] = [];
  if (Array.isArray(obj.cells)) {
    for (let r = 0; r < rows; r++) {
      const rawRow = Array.isArray(obj.cells[r]) ? (obj.cells[r] as unknown[]) : [];
      const row: RoomCellKind[] = [];
      for (let c = 0; c < cols; c++) {
        row.push(coerceCellKind(rawRow[c]));
      }
      cells.push(row);
    }
  } else if (Array.isArray(obj.gridRows)) {
    for (let r = 0; r < rows; r++) {
      const line = typeof obj.gridRows[r] === 'string' ? (obj.gridRows[r] as string).trim() : '';
      const compact = line.replace(/\s+/g, '');
      const row: RoomCellKind[] = [];
      for (let c = 0; c < cols; c++) {
        const ch = compact[c];
        row.push(ch === '#' || ch === 'X' || ch === '1' ? 1 : ch === '-' || ch === '2' ? 2 : 0);
      }
      cells.push(row);
    }
  } else {
    for (let r = 0; r < rows; r++) {
      const row: RoomCellKind[] = [];
      for (let c = 0; c < cols; c++) {
        row.push(r === 0 || r === rows - 1 || c === 0 || c === cols - 1 ? 1 : 0);
      }
      cells.push(row);
    }
  }

  const rawSpawn =
    typeof obj.playerSpawn === 'object' && obj.playerSpawn !== null
      ? (obj.playerSpawn as Record<string, unknown>)
      : {};
  const spawnX = clampInt(typeof rawSpawn.cellX === 'number' ? rawSpawn.cellX : 2, 0, cols - 1);
  const spawnY = clampInt(
    typeof rawSpawn.cellY === 'number' ? rawSpawn.cellY : Math.max(1, rows - 2),
    0,
    rows - 1,
  );

  const fallbackSlug =
    opts.availableEntitySlugs && opts.availableEntitySlugs.length > 0
      ? sanitizeRoomSlug(opts.availableEntitySlugs[0]!)
      : 'goblin_scout';

  const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
  const entities: RoomEntityPlacement[] = rawEntities.slice(0, 64).map((entry, idx) => {
    const rec =
      typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    const slug =
      typeof rec.entitySlug === 'string' && rec.entitySlug.trim().length > 0
        ? sanitizeRoomSlug(rec.entitySlug)
        : fallbackSlug;
    return {
      id:
        typeof rec.id === 'string' && rec.id.trim().length > 0
          ? rec.id.trim()
          : `${slug}_${idx + 1}`,
      entitySlug: slug,
      cellX: clampInt(typeof rec.cellX === 'number' ? rec.cellX : cols - 3, 0, cols - 1),
      cellY: clampInt(
        typeof rec.cellY === 'number' ? rec.cellY : Math.max(1, rows - 2),
        0,
        rows - 1,
      ),
      ...(typeof rec.patrolSpanCells === 'number'
        ? { patrolSpanCells: clampInt(rec.patrolSpanCells, 0, 32) }
        : {}),
      ...(rec.facing === 'left' || rec.facing === 'right' ? { facing: rec.facing } : {}),
    };
  });

  const base: RoomLayoutBlueprint = {
    slug: sanitizeRoomSlug(rawSlug),
    displayName: rawDisplayName,
    prompt: opts.fallbackPrompt,
    cols,
    rows,
    tileSizePx,
    cells,
    playerSpawn: { cellX: spawnX, cellY: spawnY },
    entities,
    ...(typeof obj.notes === 'string' && obj.notes.trim().length > 0
      ? { notes: obj.notes.trim() }
      : {}),
  };

  return sanitizeRoomPlacements(base);
}

/**
 * Resolves every non-empty terrain cell (`1` = solid, `2` = one-way platform) into M20 auto-tile
 * bitmasks and atlas coordinates (`blob47` = 8×6 grid, `wang16` = 4×4 grid).
 */
export function resolveRoomAutoTileCells(
  blueprint: RoomLayoutBlueprint,
  tileSetMode: RoomTileSetMode = 'blob47',
): ResolvedRoomTileCell[] {
  const { cols, rows, cells } = blueprint;
  const solidGrid = new Array<boolean>(cols * rows).fill(false);
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      if (cells[y]?.[x] === 1) {
        solidGrid[y * cols + x] = true;
      }
    }
  }

  const autoMode = tileSetMode === 'wang16' ? 'wang-16' : 'blob-47';
  const columns = tileSetMode === 'wang16' ? 4 : 8;
  const canonicalMasks =
    tileSetMode === 'wang16' ? getCanonicalWang16Masks() : getCanonicalBlob47Masks();
  const maskToIdx = new Map<number, number>(canonicalMasks.map((m, i) => [m, i]));

  const out: ResolvedRoomTileCell[] = [];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const kind = cells[y]?.[x] ?? 0;
      if (kind === 0) continue;

      let mask: number;
      if (kind === 1) {
        mask = computeAutoTileGridMask(solidGrid, cols, rows, x, y, autoMode);
        if (tileSetMode === 'wang16' && mask === 0) {
          // Wang-16 mask 0 is reserved for completely empty transparency in M20.
          mask = 15;
        }
      } else {
        // One-way platform: connect horizontally to adjacent terrain/platforms with open top/bottom.
        const hasLeft = x > 0 && (cells[y]?.[x - 1] ?? 0) !== 0;
        const hasRight = x + 1 < cols && (cells[y]?.[x + 1] ?? 0) !== 0;
        if (tileSetMode === 'wang16') {
          mask = (hasLeft ? 8 : 0) | (hasRight ? 4 : 0);
          if (mask === 0) mask = 12;
        } else {
          mask = gateBlobMask((hasLeft ? BIT_W : 0) | (hasRight ? BIT_E : 0));
        }
      }

      const atlasIdx = maskToIdx.get(mask) ?? 0;
      out.push({
        x,
        y,
        sourceId: 0,
        atlasX: atlasIdx % columns,
        atlasY: Math.floor(atlasIdx / columns),
        altTile: 0,
        kind,
        mask,
      });
    }
  }

  return out;
}

/**
 * Encodes TileMapLayer cell placements into Godot 4.3+ `tile_map_data` binary layout:
 * uint16 version header (`0`) followed by 12-byte little-endian records per cell:
 * `[int16 x, int16 y, uint16 sourceId, int16 atlasX, int16 atlasY, uint16 altTile]`.
 */
export function encodeGodotTileMapData(cells: readonly EncodableTileMapCell[]): Uint8Array {
  const bytes = new Uint8Array(2 + cells.length * 12);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0, true);

  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i]!;
    const offset = 2 + i * 12;
    view.setInt16(offset, cell.x, true);
    view.setInt16(offset + 2, cell.y, true);
    view.setUint16(offset + 4, cell.sourceId, true);
    view.setInt16(offset + 6, cell.atlasX, true);
    view.setInt16(offset + 8, cell.atlasY, true);
    view.setUint16(offset + 10, cell.altTile, true);
  }

  return bytes;
}

/**
 * Decodes Godot 4.3+ `tile_map_data` little-endian `PackedByteArray` bytes back into cell records.
 */
export function decodeGodotTileMapData(bytes: Uint8Array): {
  readonly version: number;
  readonly cells: EncodableTileMapCell[];
} {
  if (bytes.length < 2 || (bytes.length - 2) % 12 !== 0) {
    throw new Error(
      `Invalid Godot tile_map_data length (${bytes.length} bytes); expected 2 + N * 12.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint16(0, true);
  const count = (bytes.length - 2) / 12;
  const cells: EncodableTileMapCell[] = [];

  for (let i = 0; i < count; i++) {
    const offset = 2 + i * 12;
    cells.push({
      x: view.getInt16(offset, true),
      y: view.getInt16(offset + 2, true),
      sourceId: view.getUint16(offset + 4, true),
      atlasX: view.getInt16(offset + 6, true),
      atlasY: view.getInt16(offset + 8, true),
      altTile: view.getUint16(offset + 10, true),
    });
  }

  return { version, cells };
}
