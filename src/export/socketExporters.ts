import { strToU8 } from 'fflate';
import type { EvaluatedSocketFrame, SocketDefinition } from '../processing/attachmentSockets';

export type SocketExportFormat = 'godot' | 'phaser' | 'pixi';

interface NormalizedSocketFrame {
  readonly frameIndex: number;
  readonly x: number;
  readonly y: number;
  readonly posX: number;
  readonly posY: number;
  readonly angleDeg: number;
  readonly rotationRad: number;
  readonly boundToMesh: boolean;
}

function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Number(value.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function degToRad(angleDeg: number): number {
  return (angleDeg * Math.PI) / 180;
}

function normalizeFps(fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return 12;
  return roundTo(fps, 2);
}

function normalizeGodotNodeName(rawName: string): string {
  const cleaned = rawName
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : 'socket';
}

function escapeGodotComment(text: string): string {
  return text.replace(/[\r\n]+/g, ' ');
}

function resolveSocketFrames(
  socket: SocketDefinition,
  evaluatedByFrame: readonly (readonly EvaluatedSocketFrame[])[],
): NormalizedSocketFrame[] {
  if (evaluatedByFrame.length === 0) {
    const restX = roundTo(socket.restPosPx.x, 2);
    const restY = roundTo(socket.restPosPx.y, 2);
    const angleDeg = roundTo(socket.baseAngleDeg, 2);
    return [
      {
        frameIndex: 0,
        x: restX,
        y: restY,
        posX: restX,
        posY: restY,
        angleDeg,
        rotationRad: roundTo(degToRad(angleDeg), 4),
        boundToMesh: false,
      },
    ];
  }

  return evaluatedByFrame.map((frameEntries, frameIndex) => {
    const match = frameEntries.find(
      (entry) => entry.socketId === socket.id || entry.name === socket.name,
    );
    if (!match) {
      const restX = roundTo(socket.restPosPx.x, 2);
      const restY = roundTo(socket.restPosPx.y, 2);
      const angleDeg = roundTo(socket.baseAngleDeg, 2);
      return {
        frameIndex,
        x: restX,
        y: restY,
        posX: restX,
        posY: restY,
        angleDeg,
        rotationRad: roundTo(degToRad(angleDeg), 4),
        boundToMesh: false,
      };
    }

    const angleDeg = roundTo(match.angleDeg, 2);
    return {
      frameIndex,
      x: roundTo(match.pivotRelativePx.x, 2),
      y: roundTo(match.pivotRelativePx.y, 2),
      posX: roundTo(match.posPx.x, 2),
      posY: roundTo(match.posPx.y, 2),
      angleDeg,
      rotationRad: roundTo(degToRad(angleDeg), 4),
      boundToMesh: match.boundToMesh,
    };
  });
}

function collectOrderedSocketRecords(
  sockets: readonly SocketDefinition[],
  evaluatedByFrame: readonly (readonly EvaluatedSocketFrame[])[],
): Array<{
  readonly socket: SocketDefinition;
  readonly frames: readonly NormalizedSocketFrame[];
}> {
  return sockets.map((socket) => ({
    socket,
    frames: resolveSocketFrames(socket, evaluatedByFrame),
  }));
}

/**
 * Generates a Godot 4 `.tscn` `Marker2D` node snippet anchored to `parent="."`
 * (matching the sprite's centered pivot node), plus AnimationPlayer keyframe comments
 * when multiple animation frames are present.
 */
export function exportGodotSocketsTscnSnippet(
  spriteSlug: string,
  sockets: readonly SocketDefinition[],
  evaluatedByFrame: readonly (readonly EvaluatedSocketFrame[])[],
): string {
  const safeSlug = escapeGodotComment(spriteSlug || 'nibgrid-sprite');
  if (sockets.length === 0) {
    return `# Nibgrid Godot 4 Attachment Sockets: ${safeSlug}\n# No attachment sockets defined.\n`;
  }

  const records = collectOrderedSocketRecords(sockets, evaluatedByFrame);
  const lines: string[] = [`# Nibgrid Godot 4 Attachment Sockets: ${safeSlug}`, ''];

  for (const { socket, frames } of records) {
    const frame0 = frames[0];
    if (!frame0) continue;
    const nodeName = normalizeGodotNodeName(socket.name);
    lines.push(`[node name="${nodeName}" type="Marker2D" parent="."]`);
    lines.push(`position = Vector2(${frame0.x}, ${frame0.y})`);
    lines.push(`rotation = ${frame0.rotationRad}`);
    lines.push('');
  }

  if (evaluatedByFrame.length > 1) {
    lines.push(`# AnimationPlayer Keyframes (${evaluatedByFrame.length} frames):`);
    for (let f = 0; f < evaluatedByFrame.length; f += 1) {
      for (const { socket, frames } of records) {
        const frame = frames[f];
        if (!frame) continue;
        const nodeName = normalizeGodotNodeName(socket.name);
        lines.push(
          `# frame ${f}: ${nodeName} -> Vector2(${frame.x}, ${frame.y}), rotation=${frame.rotationRad} (${frame.angleDeg} deg)`,
        );
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Generates a Phaser 3 JSON payload mapping each socket name to per-frame
 * pivot-relative `(x, y)` coordinates and `angleDeg` facing angles.
 */
export function exportPhaserSocketsJson(
  spriteSlug: string,
  fps: number,
  sockets: readonly SocketDefinition[],
  evaluatedByFrame: readonly (readonly EvaluatedSocketFrame[])[],
): string {
  const safeFps = normalizeFps(fps);
  const records = collectOrderedSocketRecords(sockets, evaluatedByFrame);
  const frameCount =
    evaluatedByFrame.length > 0 ? evaluatedByFrame.length : sockets.length > 0 ? 1 : 0;

  const socketsObj: Record<string, { frames: Array<{ x: number; y: number; angleDeg: number }> }> =
    {};

  for (const { socket, frames } of records) {
    socketsObj[socket.name] = {
      frames: frames.map((frame) => ({
        x: frame.x,
        y: frame.y,
        angleDeg: frame.angleDeg,
      })),
    };
  }

  return `${JSON.stringify(
    {
      app: 'nibgrid',
      engine: 'phaser3',
      sprite: spriteSlug || 'nibgrid-sprite',
      fps: safeFps,
      frameCount,
      sockets: socketsObj,
    },
    null,
    2,
  )}\n`;
}

/**
 * Generates a PixiJS JSON payload mapping each socket name to per-frame
 * pivot-relative `(x, y)` coordinates, `rotationRad`, `angleDeg`, and unit scale.
 */
export function exportPixiSocketsJson(
  spriteSlug: string,
  fps: number,
  sockets: readonly SocketDefinition[],
  evaluatedByFrame: readonly (readonly EvaluatedSocketFrame[])[],
): string {
  const safeFps = normalizeFps(fps);
  const records = collectOrderedSocketRecords(sockets, evaluatedByFrame);
  const frameCount =
    evaluatedByFrame.length > 0 ? evaluatedByFrame.length : sockets.length > 0 ? 1 : 0;

  const socketsObj: Record<
    string,
    {
      frames: Array<{
        x: number;
        y: number;
        rotationRad: number;
        angleDeg: number;
        scaleX: 1;
        scaleY: 1;
      }>;
    }
  > = {};

  for (const { socket, frames } of records) {
    socketsObj[socket.name] = {
      frames: frames.map((frame) => ({
        x: frame.x,
        y: frame.y,
        rotationRad: frame.rotationRad,
        angleDeg: frame.angleDeg,
        scaleX: 1,
        scaleY: 1,
      })),
    };
  }

  return `${JSON.stringify(
    {
      app: 'nibgrid',
      engine: 'pixijs',
      sprite: spriteSlug || 'nibgrid-sprite',
      fps: safeFps,
      frameCount,
      sockets: socketsObj,
    },
    null,
    2,
  )}\n`;
}

/**
 * Builds the canonical `<slug>_sockets.json` payload bundled inside exported sprite ZIPs.
 */
export function buildUnifiedSocketsJson(
  spriteSlug: string,
  fps: number,
  sockets: readonly SocketDefinition[],
  evaluatedByFrame: readonly (readonly EvaluatedSocketFrame[])[],
): string {
  const safeFps = normalizeFps(fps);
  const records = collectOrderedSocketRecords(sockets, evaluatedByFrame);
  const frameCount =
    evaluatedByFrame.length > 0 ? evaluatedByFrame.length : sockets.length > 0 ? 1 : 0;

  const socketsObj: Record<
    string,
    {
      id: string;
      colorHex: string | null;
      restPosPx: { x: number; y: number };
      baseAngleDeg: number;
      frames: Array<{
        frameIndex: number;
        x: number;
        y: number;
        posPx: { x: number; y: number };
        angleDeg: number;
        rotationRad: number;
        boundToMesh: boolean;
      }>;
    }
  > = {};

  for (const { socket, frames } of records) {
    socketsObj[socket.name] = {
      id: socket.id,
      colorHex: socket.colorHex ?? null,
      restPosPx: {
        x: roundTo(socket.restPosPx.x, 2),
        y: roundTo(socket.restPosPx.y, 2),
      },
      baseAngleDeg: roundTo(socket.baseAngleDeg, 2),
      frames: frames.map((frame) => ({
        frameIndex: frame.frameIndex,
        x: frame.x,
        y: frame.y,
        posPx: { x: frame.posX, y: frame.posY },
        angleDeg: frame.angleDeg,
        rotationRad: frame.rotationRad,
        boundToMesh: frame.boundToMesh,
      })),
    };
  }

  return `${JSON.stringify(
    {
      app: 'nibgrid',
      schemaVersion: '1.0.0',
      sprite: spriteSlug || 'nibgrid-sprite',
      fps: safeFps,
      frameCount,
      sockets: socketsObj,
    },
    null,
    2,
  )}\n`;
}

/**
 * Packages `<slug>_sockets.json` as UTF-8 bytes for ZIP bundling (`packageSpriteZip`).
 */
export function buildSocketExportFiles(
  spriteSlug: string,
  fps: number,
  sockets: readonly SocketDefinition[],
  evaluatedByFrame: readonly (readonly EvaluatedSocketFrame[])[],
): Record<string, Uint8Array> {
  if (sockets.length === 0) return {};
  const safeSlug = spriteSlug || 'nibgrid-sprite';
  return {
    [`${safeSlug}_sockets.json`]: strToU8(
      buildUnifiedSocketsJson(safeSlug, fps, sockets, evaluatedByFrame),
    ),
  };
}
