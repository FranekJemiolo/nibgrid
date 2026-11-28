import { describe, expect, it } from 'vitest';
import { createDefaultProjectNarrative } from '../../src/narrative/dialogueSchemas';
import {
  auditFontGlyphCoverage,
  buildCharsetCodepointSet,
} from '../../src/narrative/localizationAuditor';
import { evaluateSpriteQuality } from '../../src/ai/styleLockGate';
import { useUxModeStore } from '../../src/state/uxModeStore';
import {
  applyMissingGlyphFix,
  applyOffPaletteFix,
  applySoftlockTrapFix,
  buildFixItCards,
} from '../../src/ui/audit/fixItEngine';
import { resolveWorkspaceForScreen } from '../../src/ui/layout/workspaceShell';
import { auditWorldReachability, type WorldGraph } from '../../src/world/worldGraphCore';

describe('M49: 4-Workspace Routing, Creator/Pro Mode & Fix-It Engine', () => {
  it('maps screens cleanly into the 4 intent-driven workspaces and toggles Creator/Pro mode', () => {
    expect(resolveWorkspaceForScreen('bible')).toBe('style-vision');
    expect(resolveWorkspaceForScreen('studio')).toBe('cast-world');
    expect(resolveWorkspaceForScreen('entities')).toBe('cast-world');
    expect(resolveWorkspaceForScreen('dialogue')).toBe('cast-world');
    expect(resolveWorkspaceForScreen('data')).toBe('play-tune');
    expect(resolveWorkspaceForScreen('ship')).toBe('ship-godot');

    const store = useUxModeStore.getState();
    store.setMode('creator');
    expect(useUxModeStore.getState().mode).toBe('creator');
    store.toggleMode();
    expect(useUxModeStore.getState().mode).toBe('pro');
    store.setMode('creator');
  });

  it('Fix-It MissingGlyphFix mutates charset deterministically and clears M24 glyph warnings', () => {
    const base = createDefaultProjectNarrative('p1');
    const broken = {
      ...base,
      localization: {
        ...base.localization,
        strings: {
          ...base.localization.strings,
          DLG_GUARD_GREET_01: {
            en: 'Halt, traveler!',
            pl: 'Stój, wędrowcze! Złóż broń.',
            de: 'Halt, Reisender!',
          },
        },
      },
    };

    const cardsBefore = buildFixItCards({
      narrativeBundle: broken,
      paletteHex: ['#1A1C2C'],
    });
    expect(cardsBefore.some((c) => c.kind === 'missing-glyph')).toBe(true);

    const fixed = applyMissingGlyphFix(broken);
    const reportAfter = auditFontGlyphCoverage(
      fixed.localization,
      buildCharsetCodepointSet(fixed.fontCharset),
    );
    expect(reportAfter.ok).toBe(true);
    expect(buildFixItCards({ narrativeBundle: fixed, paletteHex: ['#1A1C2C'] })).toEqual([]);
  });

  it('Fix-It SoftlockTrapFix clears M45 one-way trap warnings and OffPaletteFix snaps colors to ArtBible', () => {
    const graph: WorldGraph = {
      id: 'w1',
      projectId: 'p1',
      name: 'World',
      rooms: [
        {
          roomId: 'start',
          label: 'Start',
          worldGridPos: { x: 0, y: 0 },
          isStart: true,
          grantsFlags: [],
        },
        { roomId: 'pit', label: 'Trap Pit', worldGridPos: { x: 1, y: 0 }, grantsFlags: [] },
        {
          roomId: 'exit',
          label: 'Goal',
          worldGridPos: { x: 0, y: 1 },
          isGoal: true,
          grantsFlags: [],
        },
      ],
      edges: [
        {
          id: 'e_pit',
          fromRoomId: 'start',
          fromDoorId: 'down',
          toRoomId: 'pit',
          toSpawnId: 'top',
          requiredFlags: [],
          bidirectional: false,
        },
        {
          id: 'e_goal',
          fromRoomId: 'start',
          fromDoorId: 'east',
          toRoomId: 'exit',
          toSpawnId: 'west',
          requiredFlags: [],
          bidirectional: true,
        },
      ],
      updatedAt: 1,
    };

    const w = 4;
    const h = 4;
    const offRgba = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      offRgba[i * 4] = 0;
      offRgba[i * 4 + 1] = 255;
      offRgba[i * 4 + 2] = 0;
      offRgba[i * 4 + 3] = 255;
    }

    const palette = ['#1A1C2C', '#FFCD75'];
    const cardsBefore = buildFixItCards({
      worldGraph: graph,
      paletteHex: palette,
      sprites: [{ id: 's1', name: 'Goblin Scout', width: w, height: h, data: offRgba }],
    });
    expect(cardsBefore.some((c) => c.kind === 'softlock-trap')).toBe(true);
    expect(cardsBefore.some((c) => c.kind === 'off-palette')).toBe(true);

    const fixedGraph = applySoftlockTrapFix(graph, 'pit');
    expect(auditWorldReachability(fixedGraph).softlockTrapRoomIds).toEqual([]);

    const snapped = applyOffPaletteFix(offRgba, w, h, palette);
    const qualityAfter = evaluateSpriteQuality(snapped, w, h, palette, {
      oklabTolerance: 0.03,
      maxDriftPct: 0.05,
    });
    expect(qualityAfter.offPalettePixelCount).toBe(0);
    expect(
      buildFixItCards({
        worldGraph: fixedGraph,
        paletteHex: palette,
        sprites: [{ id: 's1', name: 'Goblin Scout', width: w, height: h, data: snapped }],
      }),
    ).toEqual([]);
  });
});
