import { describe, expect, it } from 'vitest';
import { auditWorldReachability, type WorldGraph } from '../../src/world/worldGraphCore';

describe('M45A: World Map Graph & Pure-TS BFS/DFS Softlock Auditor', () => {
  it('passes a 4-room key-gated graph (Start -> Hall -> KeyRoom -> LockedBoss) with deterministic progressionOrder', () => {
    const graph: WorldGraph = {
      id: 'w-1',
      projectId: 'p-1',
      name: 'Cathedral Slice',
      updatedAt: 1,
      rooms: [
        {
          roomId: 'start',
          label: 'Entry Courtyard',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: [],
        },
        {
          roomId: 'hall',
          label: 'Nave Hall',
          worldGridPos: { x: 1, y: 0 },
          grantsFlags: [],
        },
        {
          roomId: 'key_room',
          label: 'Reliquary',
          worldGridPos: { x: 1, y: 1 },
          grantsFlags: ['boss_key'],
        },
        {
          roomId: 'boss',
          label: 'Bell Sanctum',
          worldGridPos: { x: 2, y: 0 },
          isGoal: true,
          grantsFlags: [],
        },
      ],
      edges: [
        {
          id: 'e-start-hall',
          fromRoomId: 'start',
          fromDoorId: 'door_east',
          toRoomId: 'hall',
          toSpawnId: 'spawn_west',
          bidirectional: true,
          requiredFlags: [],
        },
        {
          id: 'e-hall-key',
          fromRoomId: 'hall',
          fromDoorId: 'door_south',
          toRoomId: 'key_room',
          toSpawnId: 'spawn_north',
          bidirectional: true,
          requiredFlags: [],
        },
        {
          id: 'e-hall-boss',
          fromRoomId: 'hall',
          fromDoorId: 'door_east',
          toRoomId: 'boss',
          toSpawnId: 'spawn_west',
          bidirectional: true,
          requiredFlags: ['boss_key'],
        },
      ],
    };

    const report = auditWorldReachability(graph);
    expect(report.ok).toBe(true);
    expect(report.unreachableRoomIds).toEqual([]);
    expect(report.softlockTrapRoomIds).toEqual([]);
    expect(report.danglingEdgeIds).toEqual([]);
    expect(report.progressionOrder).toEqual(['boss_key']);
  });

  it('flags key-gated goal room as unreachable when boss_key is removed', () => {
    const graph: WorldGraph = {
      id: 'w-2',
      projectId: 'p-1',
      name: 'Missing Key',
      updatedAt: 1,
      rooms: [
        {
          roomId: 'start',
          label: 'Start',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: [],
        },
        {
          roomId: 'key_room',
          label: 'Empty KeyRoom',
          worldGridPos: { x: 1, y: 0 },
          grantsFlags: [],
        },
        {
          roomId: 'boss',
          label: 'LockedBoss',
          worldGridPos: { x: 2, y: 0 },
          isGoal: true,
          grantsFlags: [],
        },
      ],
      edges: [
        {
          id: 'e-1',
          fromRoomId: 'start',
          fromDoorId: 'd1',
          toRoomId: 'key_room',
          toSpawnId: 's1',
          bidirectional: true,
          requiredFlags: [],
        },
        {
          id: 'e-2',
          fromRoomId: 'key_room',
          fromDoorId: 'd2',
          toRoomId: 'boss',
          toSpawnId: 's2',
          bidirectional: true,
          requiredFlags: ['boss_key'],
        },
      ],
    };

    const report = auditWorldReachability(graph);
    expect(report.ok).toBe(false);
    expect(report.unreachableRoomIds).toEqual(['boss']);
    expect(report.progressionOrder).toEqual([]);
  });

  it('detects one-way drops into inescapable dead-end pits as softlockTrapRoomIds', () => {
    const graph: WorldGraph = {
      id: 'w-3',
      projectId: 'p-1',
      name: 'One-Way Pit',
      updatedAt: 1,
      rooms: [
        {
          roomId: 'start',
          label: 'Start Bridge',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: [],
        },
        {
          roomId: 'pit',
          label: 'Inescapable Pit',
          worldGridPos: { x: 0, y: 1 },
          grantsFlags: [],
        },
        {
          roomId: 'goal',
          label: 'Exit Gate',
          worldGridPos: { x: 1, y: 0 },
          isGoal: true,
          grantsFlags: [],
        },
      ],
      edges: [
        {
          id: 'e-drop',
          fromRoomId: 'start',
          fromDoorId: 'chute_down',
          toRoomId: 'pit',
          toSpawnId: 'pit_drop',
          bidirectional: false,
          requiredFlags: [],
        },
        {
          id: 'e-goal',
          fromRoomId: 'start',
          fromDoorId: 'east_gate',
          toRoomId: 'goal',
          toSpawnId: 'west_gate',
          bidirectional: true,
          requiredFlags: [],
        },
      ],
    };

    const report = auditWorldReachability(graph);
    expect(report.ok).toBe(false);
    expect(report.unreachableRoomIds).toEqual([]);
    expect(report.softlockTrapRoomIds).toEqual(['pit']);
  });

  it('terminates cleanly on cyclic graphs and reports dangling edges, missing start, and duplicate doors', () => {
    const cyclicWithIntegrityIssues: WorldGraph = {
      id: 'w-4',
      projectId: 'p-1',
      name: 'Cyclic Integrity Test',
      updatedAt: 1,
      rooms: [
        {
          roomId: 'a',
          label: 'A',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: ['k1'],
        },
        { roomId: 'b', label: 'B', worldGridPos: { x: 1, y: 0 }, grantsFlags: [] },
        { roomId: 'c', label: 'C', worldGridPos: { x: 1, y: 1 }, isGoal: true, grantsFlags: [] },
      ],
      edges: [
        {
          id: 'e-ab',
          fromRoomId: 'a',
          fromDoorId: 'dup_door',
          toRoomId: 'b',
          toSpawnId: 's_b',
          bidirectional: true,
          requiredFlags: [],
        },
        {
          id: 'e-bc',
          fromRoomId: 'b',
          fromDoorId: 'd_bc',
          toRoomId: 'c',
          toSpawnId: 's_c',
          bidirectional: true,
          requiredFlags: ['k1'],
        },
        {
          id: 'e-ca',
          fromRoomId: 'c',
          fromDoorId: 'd_ca',
          toRoomId: 'a',
          toSpawnId: 's_a',
          bidirectional: true,
          requiredFlags: [],
        },
        {
          id: 'e-dup',
          fromRoomId: 'a',
          fromDoorId: 'dup_door',
          toRoomId: 'c',
          toSpawnId: 's_c2',
          bidirectional: false,
          requiredFlags: ['k1'],
        },
        {
          id: 'e-dangling',
          fromRoomId: 'a',
          fromDoorId: 'broken',
          toRoomId: 'deleted_room',
          toSpawnId: 'missing',
          bidirectional: false,
          requiredFlags: [],
        },
      ],
    };

    const report = auditWorldReachability(cyclicWithIntegrityIssues);
    expect(report.ok).toBe(false);
    expect(report.danglingEdgeIds).toEqual(['e-dangling']);
    expect(report.duplicateDoorIds).toEqual(['dup_door']);
    expect(report.reachableRoomIds).toEqual(['a', 'b', 'c']);
    expect(report.softlockTrapRoomIds).toEqual([]);

    const noStartReport = auditWorldReachability({
      ...cyclicWithIntegrityIssues,
      rooms: [{ roomId: 'x', label: 'NoStart', worldGridPos: { x: 0, y: 0 }, grantsFlags: [] }],
      edges: [],
    });
    expect(noStartReport.ok).toBe(false);
    expect(noStartReport.startRoomId).toBeNull();
    expect(noStartReport.unreachableRoomIds).toEqual(['x']);
  });
});
