import { describe, expect, it } from 'vitest';
import {
  SocketDefinitionSchema,
  createDefaultArtBible,
  createDefaultPostProcessConfig,
  type Project,
  type SpriteNode,
} from '../../src/domain/schemas';
import { AssetRecipeSchema, buildAssetRecipe } from '../../src/export/recipeBuilder';
import {
  bindSocketToRestMesh,
  evaluateSocketAtFrame,
  evaluateSocketsAcrossFrames,
  sanitizeSocketName,
  type MeshTriangle,
  type SocketDefinition,
} from '../../src/processing/attachmentSockets';
import type { Vec2 } from '../../src/processing/collisionHull';

function transformVec2(p: Vec2, dx: number, dy: number, deg: number): Vec2 {
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    x: p.x * c - p.y * s + dx,
    y: p.x * s + p.y * c + dy,
  };
}

describe('M21A: Pure-TS Barycentric Socket Tracker & Schemas', () => {
  it('tracks rigid translation (+10, -6) and rotation (+30 deg) accurately relative to pivotPx', () => {
    const restVertices: Vec2[] = [
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 20, y: 40 },
    ];
    const triangles: MeshTriangle[] = [{ i0: 0, i1: 1, i2: 2 }];
    const socket: SocketDefinition = {
      id: 'sock-1',
      name: 'hand_r',
      restPosPx: { x: 20, y: 12 },
      baseAngleDeg: -15,
      colorHex: '#F59E0B',
    };
    const pivotPx: Vec2 = { x: 16, y: 32 };

    const binding = bindSocketToRestMesh(socket, restVertices, triangles);
    expect(binding).not.toBeNull();
    expect(binding!.triIndex).toBe(0);

    const deformedVertices = restVertices.map((v) => transformVec2(v, 10, -6, 30));
    const expectedPos = transformVec2(socket.restPosPx, 10, -6, 30);

    const frame0 = evaluateSocketAtFrame(socket, binding, restVertices, triangles, pivotPx, 0);
    expect(frame0.posPx).toEqual({ x: 20, y: 12 });
    expect(frame0.pivotRelativePx).toEqual({ x: 4, y: -20 });
    expect(frame0.angleDeg).toBe(-15);
    expect(frame0.boundToMesh).toBe(true);

    const frame1 = evaluateSocketAtFrame(socket, binding, deformedVertices, triangles, pivotPx, 1);
    expect(Math.abs(frame1.posPx.x - expectedPos.x)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(frame1.posPx.y - expectedPos.y)).toBeLessThanOrEqual(0.1);
    expect(Math.abs(frame1.angleDeg - (socket.baseAngleDeg + 30))).toBeLessThanOrEqual(0.2);
    expect(Math.abs(frame1.pivotRelativePx.x - (frame1.posPx.x - pivotPx.x))).toBeLessThanOrEqual(
      0.02,
    );
    expect(Math.abs(frame1.pivotRelativePx.y - (frame1.posPx.y - pivotPx.y))).toBeLessThanOrEqual(
      0.02,
    );
    expect(frame1.boundToMesh).toBe(true);
  });

  it('wraps shortest-arc rotation cleanly across the +-180 deg branch cut', () => {
    const restVertices: Vec2[] = [
      { x: 10, y: 10 },
      { x: 0, y: 10 }, // edge points -X (+180 deg / pi rad)
      { x: 5, y: 0 },
    ];
    const triangles: MeshTriangle[] = [{ i0: 0, i1: 1, i2: 2 }];
    const socket: SocketDefinition = {
      id: 'sock-wrap',
      name: 'muzzle',
      restPosPx: { x: 5, y: 6 },
      baseAngleDeg: 0,
    };
    const binding = bindSocketToRestMesh(socket, restVertices, triangles);
    expect(binding).not.toBeNull();

    // Rotate by +10 deg so edge crosses from +180 into -170 rad equivalent
    const deformed = restVertices.map((v) => transformVec2(v, 0, 0, 10));
    const evalFrame = evaluateSocketAtFrame(
      socket,
      binding,
      deformed,
      triangles,
      { x: 0, y: 0 },
      1,
    );
    expect(Math.abs(evalFrame.angleDeg - 10)).toBeLessThanOrEqual(0.2);
  });

  it('handles out-of-triangle fallback, skips degenerate triangles, and falls back when static/empty', () => {
    const restVertices: Vec2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 }, // collinear degenerate with (0,1,2)
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    const triangles: MeshTriangle[] = [
      { i0: 0, i1: 1, i2: 2 }, // degenerate!
      { i0: 0, i1: 1, i2: 3 },
      { i0: 0, i1: 3, i2: 4 },
    ];
    const socket: SocketDefinition = {
      id: 'sock-out',
      name: 'exhaust',
      restPosPx: { x: 50, y: 4 }, // well outside triangle bounds
      baseAngleDeg: 180,
    };

    const binding = bindSocketToRestMesh(socket, restVertices, triangles);
    expect(binding).not.toBeNull();
    expect(binding!.triIndex).toBe(1); // closest centroid non-degenerate triangle
    expect(binding!.w0).toBeCloseTo(1 / 3, 5);

    const staticNull = evaluateSocketAtFrame(socket, binding, null, triangles, { x: 10, y: 20 }, 0);
    expect(staticNull.posPx).toEqual({ x: 50, y: 4 });
    expect(staticNull.pivotRelativePx).toEqual({ x: 40, y: -16 });
    expect(staticNull.angleDeg).toBe(180);
    expect(staticNull.boundToMesh).toBe(false);

    const emptyMeshBinding = bindSocketToRestMesh(socket, [], []);
    expect(emptyMeshBinding).toBeNull();
    const emptyEval = evaluateSocketAtFrame(socket, emptyMeshBinding, [], [], { x: 0, y: 0 }, 0);
    expect(emptyEval.posPx).toEqual({ x: 50, y: 4 });
    expect(emptyEval.boundToMesh).toBe(false);
    expect(Number.isNaN(emptyEval.angleDeg)).toBe(false);
  });

  it('validates SocketDefinitionSchema, sanitizeSocketName, and AssetRecipeSchema serialization', () => {
    expect(sanitizeSocketName('Hand-R (Primary!)')).toBe('hand_r_primary');
    expect(sanitizeSocketName('   ')).toBe('socket');

    expect(() =>
      SocketDefinitionSchema.parse({
        id: '1',
        name: 'Bad Name!',
        restPosPx: { x: 10, y: 20 },
      }),
    ).toThrow();

    const validSocket = SocketDefinitionSchema.parse({
      id: 's-1',
      name: 'muzzle',
      restPosPx: { x: 42, y: 18 },
      baseAngleDeg: -10,
      colorHex: '#EF4444',
    });

    const project: Project = {
      id: 'p-1',
      name: 'Socket Knight',
      artBible: createDefaultArtBible(),
      createdAt: '2026-11-24T00:00:00.000Z',
      updatedAt: '2026-11-24T00:00:00.000Z',
    };
    const node: SpriteNode = {
      id: 'n-1',
      projectId: project.id,
      parentId: null,
      kind: 'generation',
      sockets: [validSocket],
      imageBlobId: 'b-1',
      sketchSha256: 'a'.repeat(64),
      generationMeta: {
        providerId: 'offline-mock',
        modelId: 'nibgrid-procedural-v1',
        seed: 1,
        adherence: 'balanced',
        promptDelta: 'turret',
        compiledPrompt: 'turret',
        createdAt: '2026-11-24T00:00:00.000Z',
      },
    };

    const recipe = buildAssetRecipe({
      project,
      node,
      postProcess: createDefaultPostProcessConfig(64, 64),
      filename: 'turret.png',
      outputWidth: 64,
      outputHeight: 64,
      sockets: [validSocket],
    });

    const reparsed = AssetRecipeSchema.parse(recipe);
    expect(reparsed.sockets).toHaveLength(1);
    expect(reparsed.sockets?.[0]?.name).toBe('muzzle');

    const tracks = evaluateSocketsAcrossFrames([validSocket], [], [], [null], { x: 32, y: 64 });
    expect(tracks[0]?.[0]?.pivotRelativePx).toEqual({ x: 10, y: -46 });
  });
});
