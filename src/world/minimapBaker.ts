import { normalizeWorldFlag, type WorldGraph, type WorldRoomNode } from './worldGraphCore';

export interface RoomCellGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cells: readonly (readonly (0 | 1 | 2)[])[];
  readonly playerSpawn?: { readonly cellX: number; readonly cellY: number };
}

export interface MinimapPalette {
  readonly background: readonly [number, number, number, number];
  readonly floor: readonly [number, number, number, number];
  readonly wall: readonly [number, number, number, number];
  readonly platform: readonly [number, number, number, number];
  readonly border: readonly [number, number, number, number];
  readonly door: readonly [number, number, number, number];
  readonly start: readonly [number, number, number, number];
  readonly goal: readonly [number, number, number, number];
}

export interface MinimapAtlasRoomEntry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly label: string;
  readonly isStart: boolean;
  readonly isGoal: boolean;
}

export interface MinimapAtlas {
  readonly version: number;
  readonly pxPerTile: 1 | 2;
  readonly width: number;
  readonly height: number;
  readonly rooms: Readonly<Record<string, MinimapAtlasRoomEntry>>;
}

const DEFAULT_MINIMAP_PALETTE: MinimapPalette = {
  background: [15, 18, 28, 255],
  floor: [38, 49, 71, 255],
  wall: [132, 152, 186, 255],
  platform: [216, 169, 79, 255],
  border: [226, 232, 240, 255],
  door: [245, 184, 46, 255],
  start: [52, 211, 153, 255],
  goal: [244, 63, 94, 255],
};

function parseHexRgba(hex: string): readonly [number, number, number, number] | null {
  const clean = hex.trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) return null;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return [r, g, b, 255];
}

function luma(c: readonly [number, number, number, number]): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Snaps minimap fill/border/highlight colors to the project's ArtBible palette while
 * preserving clear value contrast between background, walls, doors, Start, and Goal.
 */
export function deriveMinimapPaletteFromArtBible(paletteHex: readonly string[]): MinimapPalette {
  const parsed = paletteHex
    .map(parseHexRgba)
    .filter((c): c is readonly [number, number, number, number] => c !== null)
    .sort((a, b) => luma(a) - luma(b));

  if (parsed.length < 3) {
    return DEFAULT_MINIMAP_PALETTE;
  }

  const darkest = parsed[0]!;
  const mid = parsed[Math.floor(parsed.length / 2)]!;
  const brightest = parsed[parsed.length - 1]!;
  const accent = parsed[Math.max(1, parsed.length - 2)] ?? brightest;

  return {
    background: [Math.min(darkest[0], 32), Math.min(darkest[1], 36), Math.min(darkest[2], 48), 255],
    floor: [
      Math.round((darkest[0] + mid[0]) * 0.45),
      Math.round((darkest[1] + mid[1]) * 0.45),
      Math.round((darkest[2] + mid[2]) * 0.45),
      255,
    ],
    wall: accent,
    platform: mid,
    border: brightest,
    door: [245, 184, 46, 255],
    start: [52, 211, 153, 255],
    goal: [244, 63, 94, 255],
  };
}

function setPx(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  color: readonly [number, number, number, number],
): void {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= imgW || yi >= imgH) return;
  const idx = (yi * imgW + xi) * 4;
  rgba[idx] = color[0];
  rgba[idx + 1] = color[1];
  rgba[idx + 2] = color[2];
  rgba[idx + 3] = color[3];
}

function fillRect(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: readonly [number, number, number, number],
): void {
  for (let py = y; py < y + h; py++) {
    for (let px = x; px < x + w; px++) {
      setPx(rgba, imgW, imgH, px, py, color);
    }
  }
}

function drawLine(
  rgba: Uint8ClampedArray,
  imgW: number,
  imgH: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: readonly [number, number, number, number],
): void {
  let cx = Math.round(x0);
  let cy = Math.round(y0);
  const tx = Math.round(x1);
  const ty = Math.round(y1);
  const dx = Math.abs(tx - cx);
  const dy = Math.abs(ty - cy);
  const sx = cx < tx ? 1 : -1;
  const sy = cy < ty ? 1 : -1;
  let err = dx - dy;

  for (let steps = 0; steps < (imgW + imgH) * 2; steps++) {
    setPx(rgba, imgW, imgH, cx, cy, color);
    if (cx === tx && cy === ty) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      cx += sx;
    }
    if (e2 < dx) {
      err += dx;
      cy += sy;
    }
  }
}

/**
 * Pure-TS pixel-art minimap baker converting connected M35 room grids and `WorldGraph`
 * coordinates into a crisp RGBA buffer plus `minimap_atlas.json` fog-of-war metadata.
 */
export function bakeWorldMinimapRgba(
  graph: WorldGraph,
  roomGridsById: ReadonlyMap<string, RoomCellGrid>,
  opts: { readonly pxPerTile?: 1 | 2; readonly palette?: MinimapPalette } = {},
): {
  readonly rgba: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
  readonly atlas: MinimapAtlas;
} {
  const pxPerTile: 1 | 2 = opts.pxPerTile === 2 ? 2 : 1;
  const palette = opts.palette ?? DEFAULT_MINIMAP_PALETTE;

  if (graph.rooms.length === 0) {
    const emptyW = 16;
    const emptyH = 16;
    const rgba = new Uint8ClampedArray(emptyW * emptyH * 4);
    fillRect(rgba, emptyW, emptyH, 0, 0, emptyW, emptyH, palette.background);
    return {
      rgba,
      width: emptyW,
      height: emptyH,
      atlas: {
        version: 1,
        pxPerTile,
        width: emptyW,
        height: emptyH,
        rooms: {},
      },
    };
  }

  let minGX = Number.POSITIVE_INFINITY;
  let maxGX = Number.NEGATIVE_INFINITY;
  let minGY = Number.POSITIVE_INFINITY;
  let maxGY = Number.NEGATIVE_INFINITY;
  let maxInnerW = 12 * pxPerTile;
  let maxInnerH = 8 * pxPerTile;

  const roomSizes = new Map<string, { cols: number; rows: number; boxW: number; boxH: number }>();
  for (const room of graph.rooms) {
    minGX = Math.min(minGX, room.worldGridPos.x);
    maxGX = Math.max(maxGX, room.worldGridPos.x);
    minGY = Math.min(minGY, room.worldGridPos.y);
    maxGY = Math.max(maxGY, room.worldGridPos.y);

    const grid = roomGridsById.get(room.roomId);
    const cols = Math.max(1, grid?.cols ?? 16);
    const rows = Math.max(1, grid?.rows ?? 10);
    const innerW = cols * pxPerTile;
    const innerH = rows * pxPerTile;
    maxInnerW = Math.max(maxInnerW, innerW);
    maxInnerH = Math.max(maxInnerH, innerH);
    roomSizes.set(room.roomId, {
      cols,
      rows,
      boxW: innerW + 2,
      boxH: innerH + 2,
    });
  }

  const outerPad = 4;
  const gap = 6;
  const slotW = maxInnerW + 2 + gap;
  const slotH = maxInnerH + 2 + gap;
  const gridSpanX = maxGX - minGX + 1;
  const gridSpanY = maxGY - minGY + 1;

  const width = outerPad * 2 + gridSpanX * slotW - gap;
  const height = outerPad * 2 + gridSpanY * slotH - gap;
  const rgba = new Uint8ClampedArray(width * height * 4);
  fillRect(rgba, width, height, 0, 0, width, height, palette.background);

  const rectsByRoomId = new Map<string, MinimapAtlasRoomEntry>();
  const roomById = new Map<string, WorldRoomNode>();

  for (const room of graph.rooms) {
    roomById.set(room.roomId, room);
    const size = roomSizes.get(room.roomId)!;
    const gx = room.worldGridPos.x - minGX;
    const gy = room.worldGridPos.y - minGY;
    const rx = outerPad + gx * slotW;
    const ry = outerPad + gy * slotH;
    const rw = size.boxW;
    const rh = size.boxH;

    // 1px border + room floor fill
    fillRect(rgba, width, height, rx, ry, rw, rh, palette.border);
    fillRect(rgba, width, height, rx + 1, ry + 1, rw - 2, rh - 2, palette.floor);

    const grid = roomGridsById.get(room.roomId);
    if (grid) {
      for (let cy = 0; cy < size.rows; cy++) {
        for (let cx = 0; cx < size.cols; cx++) {
          const cell = grid.cells[cy]?.[cx] ?? 0;
          if (cell === 1) {
            fillRect(
              rgba,
              width,
              height,
              rx + 1 + cx * pxPerTile,
              ry + 1 + cy * pxPerTile,
              pxPerTile,
              pxPerTile,
              palette.wall,
            );
          } else if (cell === 2) {
            fillRect(
              rgba,
              width,
              height,
              rx + 1 + cx * pxPerTile,
              ry + 1 + cy * pxPerTile,
              pxPerTile,
              pxPerTile,
              palette.platform,
            );
          }
        }
      }
    }

    if (room.isStart) {
      fillRect(
        rgba,
        width,
        height,
        rx + Math.max(2, Math.floor(rw / 2) - 1),
        ry + Math.max(2, Math.floor(rh / 2) - 1),
        2,
        2,
        palette.start,
      );
    } else if (room.isGoal) {
      fillRect(
        rgba,
        width,
        height,
        rx + Math.max(2, Math.floor(rw / 2) - 1),
        ry + Math.max(2, Math.floor(rh / 2) - 1),
        2,
        2,
        palette.goal,
      );
    }

    rectsByRoomId.set(room.roomId, {
      x: rx,
      y: ry,
      width: rw,
      height: rh,
      label: room.label,
      isStart: Boolean(room.isStart),
      isGoal: Boolean(room.isGoal),
    });
  }

  // Draw portal connector lines and crisp 2x2 door pips on room boundaries
  for (const edge of graph.edges) {
    const fromRect = rectsByRoomId.get(edge.fromRoomId);
    const toRect = rectsByRoomId.get(edge.toRoomId);
    if (!fromRect || !toRect) continue;

    const fx = fromRect.x + Math.floor(fromRect.width / 2);
    const fy = fromRect.y + Math.floor(fromRect.height / 2);
    const tx = toRect.x + Math.floor(toRect.width / 2);
    const ty = toRect.y + Math.floor(toRect.height / 2);

    const dx = tx - fx;
    const dy = ty - fy;
    let fromPipX = fx;
    let fromPipY = fy;
    let toPipX = tx;
    let toPipY = ty;

    if (Math.abs(dx) >= Math.abs(dy)) {
      if (dx >= 0) {
        fromPipX = fromRect.x + fromRect.width - 1;
        toPipX = toRect.x;
      } else {
        fromPipX = fromRect.x;
        toPipX = toRect.x + toRect.width - 1;
      }
    } else if (dy >= 0) {
      fromPipY = fromRect.y + fromRect.height - 1;
      toPipY = toRect.y;
    } else {
      fromPipY = fromRect.y;
      toPipY = toRect.y + toRect.height - 1;
    }

    drawLine(rgba, width, height, fromPipX, fromPipY, toPipX, toPipY, palette.door);

    const doorColor =
      edge.requiredFlags.map(normalizeWorldFlag).filter(Boolean).length > 0
        ? palette.goal
        : palette.door;
    fillRect(rgba, width, height, fromPipX - 1, fromPipY - 1, 2, 2, doorColor);
    fillRect(rgba, width, height, toPipX - 1, toPipY - 1, 2, 2, doorColor);
  }

  const atlasRooms: Record<string, MinimapAtlasRoomEntry> = {};
  for (const room of graph.rooms) {
    const entry = rectsByRoomId.get(room.roomId);
    if (entry) {
      atlasRooms[room.roomId] = entry;
    }
  }

  return {
    rgba,
    width,
    height,
    atlas: {
      version: 1,
      pxPerTile,
      width,
      height,
      rooms: atlasRooms,
    },
  };
}
