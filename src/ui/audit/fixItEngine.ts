import { evaluateSpriteQuality } from '../../ai/styleLockGate';
import type { ProjectNarrativeBundle } from '../../narrative/dialogueSchemas';
import {
  auditFontGlyphCoverage,
  buildCharsetCodepointSet,
} from '../../narrative/localizationAuditor';
import { quantizeToArtBibleOklab } from '../../processing/pixelPolish';
import { auditWorldReachability, type WorldGraph } from '../../world/worldGraphCore';

export type FixItCard =
  | {
      readonly kind: 'missing-glyph';
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly actionLabel: string;
      readonly missingChars: readonly string[];
    }
  | {
      readonly kind: 'softlock-trap';
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly actionLabel: string;
      readonly trapRoomId: string;
    }
  | {
      readonly kind: 'off-palette';
      readonly id: string;
      readonly title: string;
      readonly description: string;
      readonly actionLabel: string;
      readonly spriteId: string;
      readonly offPalettePixelCount: number;
    };

export interface FixItAuditInput {
  readonly narrativeBundle?: ProjectNarrativeBundle | null;
  readonly worldGraph?: WorldGraph | null;
  readonly paletteHex: readonly string[];
  readonly sprites?: readonly {
    readonly id: string;
    readonly name: string;
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
  }[];
}

/**
 * Translates technical M17, M32, M45, and M47 findings into plain-English 1-click Fix-It Cards.
 */
export function buildFixItCards(input: FixItAuditInput): FixItCard[] {
  const cards: FixItCard[] = [];

  if (input.narrativeBundle) {
    const glyphReport = auditFontGlyphCoverage(
      input.narrativeBundle.localization,
      buildCharsetCodepointSet(input.narrativeBundle.fontCharset),
    );
    if (!glyphReport.ok && glyphReport.missingChars.length > 0) {
      const sample = glyphReport.missingChars.slice(0, 8).join(', ');
      cards.push({
        kind: 'missing-glyph',
        id: 'missing-glyphs',
        title: `${glyphReport.missingChars.length} glyph(s) missing from M24 Bitmap Font`,
        description: `Missing characters (${sample}) will render as blank tofu boxes unless baked into your font charset.`,
        actionLabel: 'Add to Font',
        missingChars: glyphReport.missingChars,
      });
    }
  }

  if (input.worldGraph) {
    const worldReport = auditWorldReachability(input.worldGraph);
    for (const trapRoomId of worldReport.softlockTrapRoomIds) {
      const node = input.worldGraph.rooms.find((r) => r.roomId === trapRoomId);
      const label = node?.label || trapRoomId;
      cards.push({
        kind: 'softlock-trap',
        id: `softlock-${trapRoomId}`,
        title: `${label} has no way back to Start`,
        description: `Players entering "${label}" face a one-way softlock trap with no return route to Start or Goal.`,
        actionLabel: 'Make Door Bidirectional',
        trapRoomId,
      });
    }
  }

  for (const sprite of input.sprites ?? []) {
    const quality = evaluateSpriteQuality(
      sprite.data,
      sprite.width,
      sprite.height,
      input.paletteHex,
      { oklabTolerance: 0.03, maxDriftPct: 0.05 },
    );
    if (quality.offPalettePixelCount > 0) {
      cards.push({
        kind: 'off-palette',
        id: `off-palette-${sprite.id}`,
        title: `${sprite.name} has ${quality.offPalettePixelCount} off-palette pixels`,
        description: `Colors drift outside the project Art Bible palette and can look inconsistent next to other assets.`,
        actionLabel: 'Snap to ArtBible',
        spriteId: sprite.id,
        offPalettePixelCount: quality.offPalettePixelCount,
      });
    }
  }

  return cards;
}

/**
 * Pure Fix-It resolver appending missing Unicode codepoints to the project's M24 font charset.
 */
export function applyMissingGlyphFix(bundle: ProjectNarrativeBundle): ProjectNarrativeBundle {
  const report = auditFontGlyphCoverage(
    bundle.localization,
    buildCharsetCodepointSet(bundle.fontCharset),
  );
  if (report.ok) return bundle;
  const merged = Array.from(
    new Set([...Array.from(bundle.fontCharset), ...report.missingChars]),
  ).join('');
  return {
    ...bundle,
    fontCharset: merged,
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Pure Fix-It resolver converting incoming one-way portal edges into `trapRoomId` into
 * bidirectional portals (or linking a return portal to `startRoom`) so players can escape cleanly.
 */
export function applySoftlockTrapFix(graph: WorldGraph, trapRoomId: string): WorldGraph {
  let flippedAny = false;
  const nextEdges = graph.edges.map((edge) => {
    if (edge.toRoomId === trapRoomId && !edge.bidirectional) {
      flippedAny = true;
      return { ...edge, bidirectional: true };
    }
    return edge;
  });

  if (!flippedAny) {
    const fallbackTarget = graph.rooms.find((r) => r.isStart)?.roomId ?? graph.rooms[0]?.roomId;
    if (fallbackTarget && fallbackTarget !== trapRoomId) {
      nextEdges.push({
        id: `fix_return_${trapRoomId}`,
        fromRoomId: trapRoomId,
        fromDoorId: 'fix_exit',
        toRoomId: fallbackTarget,
        toSpawnId: 'fix_return_spawn',
        requiredFlags: [],
        bidirectional: false,
      });
    }
  }

  return {
    ...graph,
    edges: nextEdges,
    updatedAt: Date.now(),
  };
}

/**
 * Pure Fix-It resolver snapping off-palette pixels strictly to `paletteHex` in OKLab space.
 */
export function applyOffPaletteFix(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  paletteHex: readonly string[],
): Uint8ClampedArray {
  return quantizeToArtBibleOklab(rgba, width, height, paletteHex, { dither: 'none' });
}
