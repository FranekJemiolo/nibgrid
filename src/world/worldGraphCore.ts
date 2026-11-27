import { z } from 'zod';

export const WorldGridPosSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});
export type WorldGridPos = z.infer<typeof WorldGridPosSchema>;

export const WorldRoomNodeSchema = z.object({
  roomId: z.string().min(1),
  label: z.string().min(1),
  worldGridPos: WorldGridPosSchema,
  isStart: z.boolean().optional(),
  isGoal: z.boolean().optional(),
  grantsFlags: z.array(z.string().min(1)).default([]),
});
export type WorldRoomNode = z.infer<typeof WorldRoomNodeSchema>;

export const WorldPortalEdgeSchema = z.object({
  id: z.string().min(1),
  fromRoomId: z.string().min(1),
  fromDoorId: z.string().min(1),
  toRoomId: z.string().min(1),
  toSpawnId: z.string().min(1),
  bidirectional: z.boolean().default(true),
  requiredFlags: z.array(z.string().min(1)).default([]),
});
export type WorldPortalEdge = z.infer<typeof WorldPortalEdgeSchema>;

export const WorldGraphSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  name: z.string().min(1).default('World Map'),
  rooms: z.array(WorldRoomNodeSchema),
  edges: z.array(WorldPortalEdgeSchema),
  minimapBlobId: z.string().min(1).optional(),
  minimapAtlasJson: z.string().optional(),
  updatedAt: z.number().int().nonnegative(),
});
export type WorldGraph = z.infer<typeof WorldGraphSchema>;

export interface WorldAuditReport {
  readonly ok: boolean;
  readonly startRoomId: string | null;
  readonly reachableRoomIds: readonly string[];
  readonly unreachableRoomIds: readonly string[];
  readonly softlockTrapRoomIds: readonly string[];
  readonly danglingEdgeIds: readonly string[];
  readonly duplicateDoorIds: readonly string[];
  readonly duplicateSpawnIds: readonly string[];
  readonly progressionOrder: readonly string[];
}

export function normalizeWorldFlag(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

export function createDefaultWorldGraph(
  projectId: string,
  rooms: readonly { id: string; slug: string; displayName: string }[] = [],
): WorldGraph {
  const nodes: WorldRoomNode[] = rooms.map((room, index) => ({
    roomId: room.id,
    label: room.displayName || room.slug || `Room ${index + 1}`,
    worldGridPos: {
      x: index % 4,
      y: Math.floor(index / 4),
    },
    ...(index === 0 ? { isStart: true } : {}),
    ...(rooms.length > 1 && index === rooms.length - 1 ? { isGoal: true } : {}),
    grantsFlags: [],
  }));

  return WorldGraphSchema.parse({
    id: `world-${projectId}`,
    projectId,
    name: 'World Map',
    rooms: nodes,
    edges: [],
    updatedAt: Date.now(),
  });
}

interface DirectedPortalStep {
  readonly toRoomId: string;
  readonly requiredFlags: readonly string[];
}

function hasAllRequiredFlags(
  requiredFlags: readonly string[],
  ownedFlags: ReadonlySet<string>,
): boolean {
  for (const flag of requiredFlags) {
    const clean = normalizeWorldFlag(flag);
    if (clean && !ownedFlags.has(clean)) {
      return false;
    }
  }
  return true;
}

/**
 * Pure-TS deterministic BFS/DFS progression and softlock reachability auditor.
 * Guarantees termination on cyclic graphs and catches missing start nodes,
 * dangling portals, duplicate door/spawn IDs, unreachable rooms, and one-way traps.
 */
export function auditWorldReachability(graph: WorldGraph): WorldAuditReport {
  const roomById = new Map<string, WorldRoomNode>();
  for (const room of graph.rooms) {
    if (!roomById.has(room.roomId)) {
      roomById.set(room.roomId, room);
    }
  }

  const startRoomId = graph.rooms.find((r) => r.isStart === true)?.roomId ?? null;

  const danglingEdgeIds: string[] = [];
  const duplicateDoorIds: string[] = [];
  const duplicateSpawnIds: string[] = [];
  const seenDoorKeys = new Set<string>();
  const seenSpawnKeys = new Set<string>();
  const adjacency = new Map<string, DirectedPortalStep[]>();

  for (const room of graph.rooms) {
    adjacency.set(room.roomId, []);
  }

  for (const edge of graph.edges) {
    const hasFrom = roomById.has(edge.fromRoomId);
    const hasTo = roomById.has(edge.toRoomId);
    if (!hasFrom || !hasTo) {
      danglingEdgeIds.push(edge.id);
      continue;
    }

    const doorKey = `${edge.fromRoomId}::${edge.fromDoorId}`;
    if (seenDoorKeys.has(doorKey)) {
      duplicateDoorIds.push(edge.fromDoorId);
    } else {
      seenDoorKeys.add(doorKey);
    }

    const spawnKey = `${edge.toRoomId}::${edge.toSpawnId}`;
    if (seenSpawnKeys.has(spawnKey)) {
      duplicateSpawnIds.push(edge.toSpawnId);
    } else {
      seenSpawnKeys.add(spawnKey);
    }

    const normalizedFlags = edge.requiredFlags.map(normalizeWorldFlag).filter(Boolean);
    adjacency.get(edge.fromRoomId)?.push({
      toRoomId: edge.toRoomId,
      requiredFlags: normalizedFlags,
    });

    if (edge.bidirectional) {
      adjacency.get(edge.toRoomId)?.push({
        toRoomId: edge.fromRoomId,
        requiredFlags: normalizedFlags,
      });
    }
  }

  if (!startRoomId) {
    return {
      ok: false,
      startRoomId: null,
      reachableRoomIds: [],
      unreachableRoomIds: graph.rooms.map((r) => r.roomId),
      softlockTrapRoomIds: [],
      danglingEdgeIds,
      duplicateDoorIds,
      duplicateSpawnIds,
      progressionOrder: [],
    };
  }

  // Fixed-point progression BFS from startRoomId
  const ownedFlags = new Set<string>();
  const progressionOrder: string[] = [];
  const reachable = new Set<string>();
  const flagsAtFirstReach = new Map<string, Set<string>>();

  let progressed = true;
  while (progressed) {
    progressed = false;
    const prePassFlags = new Set(ownedFlags);
    const visited = new Set<string>([startRoomId]);
    const queue: string[] = [startRoomId];
    let head = 0;

    while (head < queue.length) {
      const currentId = queue[head++]!;
      const node = roomById.get(currentId);
      if (!node) continue;

      if (!reachable.has(currentId)) {
        reachable.add(currentId);
        const snapshot = new Set(prePassFlags);
        for (const f of node.grantsFlags) {
          const clean = normalizeWorldFlag(f);
          if (clean) snapshot.add(clean);
        }
        flagsAtFirstReach.set(currentId, snapshot);
      }

      for (const f of node.grantsFlags) {
        const clean = normalizeWorldFlag(f);
        if (clean && !ownedFlags.has(clean)) {
          ownedFlags.add(clean);
          progressionOrder.push(clean);
          progressed = true;
        }
      }

      for (const step of adjacency.get(currentId) ?? []) {
        if (!visited.has(step.toRoomId) && hasAllRequiredFlags(step.requiredFlags, ownedFlags)) {
          visited.add(step.toRoomId);
          queue.push(step.toRoomId);
        }
      }
    }
  }

  const reachableRoomIds: string[] = [];
  const unreachableRoomIds: string[] = [];
  for (const room of graph.rooms) {
    if (reachable.has(room.roomId)) {
      reachableRoomIds.push(room.roomId);
    } else {
      unreachableRoomIds.push(room.roomId);
    }
  }

  // Softlock trap detection: every reachable non-goal room must still reach a Goal or Start hub
  const safeTargets = new Set<string>([startRoomId]);
  for (const room of graph.rooms) {
    if (room.isGoal) {
      safeTargets.add(room.roomId);
    }
  }

  const softlockTrapRoomIds: string[] = [];
  for (const roomId of reachableRoomIds) {
    if (safeTargets.has(roomId)) continue;

    const localFlags = new Set(flagsAtFirstReach.get(roomId) ?? []);
    const roomNode = roomById.get(roomId);
    if (roomNode) {
      for (const f of roomNode.grantsFlags) {
        const clean = normalizeWorldFlag(f);
        if (clean) localFlags.add(clean);
      }
    }

    let escaped = false;
    let localProgressed = true;
    while (localProgressed && !escaped) {
      localProgressed = false;
      const visited = new Set<string>([roomId]);
      const queue: string[] = [roomId];
      let head = 0;

      while (head < queue.length) {
        const currentId = queue[head++]!;
        if (currentId !== roomId && safeTargets.has(currentId)) {
          escaped = true;
          break;
        }
        const curNode = roomById.get(currentId);
        if (curNode) {
          for (const f of curNode.grantsFlags) {
            const clean = normalizeWorldFlag(f);
            if (clean && !localFlags.has(clean)) {
              localFlags.add(clean);
              localProgressed = true;
            }
          }
        }
        for (const step of adjacency.get(currentId) ?? []) {
          if (!visited.has(step.toRoomId) && hasAllRequiredFlags(step.requiredFlags, localFlags)) {
            visited.add(step.toRoomId);
            queue.push(step.toRoomId);
          }
        }
      }
    }

    if (!escaped) {
      softlockTrapRoomIds.push(roomId);
    }
  }

  const ok =
    Boolean(startRoomId) &&
    unreachableRoomIds.length === 0 &&
    softlockTrapRoomIds.length === 0 &&
    danglingEdgeIds.length === 0 &&
    duplicateDoorIds.length === 0 &&
    duplicateSpawnIds.length === 0;

  return {
    ok,
    startRoomId,
    reachableRoomIds,
    unreachableRoomIds,
    softlockTrapRoomIds,
    danglingEdgeIds,
    duplicateDoorIds,
    duplicateSpawnIds,
    progressionOrder,
  };
}
