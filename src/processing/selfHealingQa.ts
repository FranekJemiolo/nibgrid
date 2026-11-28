import { evaluateSpriteQuality } from '../ai/styleLockGate';
import { simulateCombatTtk } from '../data/balanceSimulator';
import type { GameDataRegistry } from '../data/gameDataSchemas';
import type { ProjectNarrativeBundle } from '../narrative/dialogueSchemas';
import { auditFontGlyphCoverage, buildCharsetCodepointSet } from '../narrative/localizationAuditor';
import {
  applyMissingGlyphFix,
  applyOffPaletteFix,
  applySoftlockTrapFix,
} from '../ui/audit/fixItEngine';
import { auditWorldReachability, type WorldGraph } from '../world/worldGraphCore';
import { extractCollisionHull, type ExtractedCollisionShape } from './collisionHull';

export interface SelfHealSpriteInput {
  readonly id: string;
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly hasCollider: boolean;
}

export interface SelfHealFixRecord {
  readonly kind:
    'off-palette' | 'missing-collider' | 'softlock-trap' | 'combat-balance' | 'missing-glyph';
  readonly targetId: string;
  readonly summary: string;
}

export interface SelfHealUnresolvedItem {
  readonly kind: 'unreachable-room' | 'empty-sprite';
  readonly targetId: string;
  readonly summary: string;
}

export interface SelfHealingInput {
  readonly paletteHex: readonly string[];
  readonly sprites?: readonly SelfHealSpriteInput[];
  readonly worldGraph?: WorldGraph | null;
  readonly gameData?: GameDataRegistry | null;
  readonly narrativeBundle?: ProjectNarrativeBundle | null;
  readonly targetTtkSec?: { readonly min: number; readonly max: number; readonly ideal: number };
}

export interface SelfHealingReport {
  readonly beforeIssueCount: number;
  readonly afterIssueCount: number;
  readonly appliedFixes: readonly SelfHealFixRecord[];
  readonly unresolvedReviewItems: readonly SelfHealUnresolvedItem[];
  readonly healedSprites: Readonly<Record<string, Uint8ClampedArray>>;
  readonly healedColliders: Readonly<Record<string, ExtractedCollisionShape>>;
  readonly healedWorldGraph: WorldGraph | null;
  readonly healedGameData: GameDataRegistry | null;
  readonly healedNarrativeBundle: ProjectNarrativeBundle | null;
}

/**
 * Pure-TS autonomous pre-sync repair pass across sprites, colliders, world reachability,
 * combat TTK balance, and narrative font glyph coverage.
 */
export function runSelfHealingPreFlight(input: SelfHealingInput): SelfHealingReport {
  const appliedFixes: SelfHealFixRecord[] = [];
  const unresolvedReviewItems: SelfHealUnresolvedItem[] = [];
  const healedSprites: Record<string, Uint8ClampedArray> = {};
  const healedColliders: Record<string, ExtractedCollisionShape> = {};

  let beforeIssueCount = 0;

  // 1. Sprite palette drift & missing colliders
  for (const sprite of input.sprites ?? []) {
    let workingData = sprite.data;
    const quality = evaluateSpriteQuality(
      workingData,
      sprite.width,
      sprite.height,
      input.paletteHex,
      {
        oklabTolerance: 0.03,
        maxDriftPct: 0.05,
      },
    );

    if (quality.isEmptyFrame) {
      beforeIssueCount++;
      unresolvedReviewItems.push({
        kind: 'empty-sprite',
        targetId: sprite.id,
        summary: `${sprite.name} has zero opaque pixels and needs regeneration.`,
      });
      continue;
    }

    if (quality.offPalettePixelCount > 0 && input.paletteHex.length > 0) {
      beforeIssueCount++;
      workingData = applyOffPaletteFix(workingData, sprite.width, sprite.height, input.paletteHex);
      healedSprites[sprite.id] = workingData;
      appliedFixes.push({
        kind: 'off-palette',
        targetId: sprite.id,
        summary: `Snapped ${quality.offPalettePixelCount} off-palette pixels on "${sprite.name}" to ArtBible.`,
      });
    }

    if (!sprite.hasCollider) {
      beforeIssueCount++;
      const hull = extractCollisionHull(
        { width: sprite.width, height: sprite.height, data: workingData },
        {
          kind: 'convex-hull',
          maxVertices: 8,
          pivotPx: { x: Math.round(sprite.width / 2), y: Math.round(sprite.height / 2) },
        },
      );
      if (hull.vertices.length >= 3) {
        healedColliders[sprite.id] = hull;
        appliedFixes.push({
          kind: 'missing-collider',
          targetId: sprite.id,
          summary: `Auto-traced ${hull.vertices.length}-vertex convex hull collider for "${sprite.name}".`,
        });
      }
    }
  }

  // 2. World Graph softlock repair (M45)
  let healedWorldGraph: WorldGraph | null = input.worldGraph ?? null;
  if (healedWorldGraph) {
    const worldAudit = auditWorldReachability(healedWorldGraph);
    for (const trapId of worldAudit.softlockTrapRoomIds) {
      beforeIssueCount++;
      healedWorldGraph = applySoftlockTrapFix(healedWorldGraph, trapId);
      appliedFixes.push({
        kind: 'softlock-trap',
        targetId: trapId,
        summary: `Converted incoming portal to "${trapId}" into bidirectional escape route.`,
      });
    }

    const postWorldAudit = auditWorldReachability(healedWorldGraph);
    for (const unreachableId of postWorldAudit.unreachableRoomIds) {
      beforeIssueCount++;
      unresolvedReviewItems.push({
        kind: 'unreachable-room',
        targetId: unreachableId,
        summary: `Room "${unreachableId}" has no incoming portal edge from Start.`,
      });
    }
  }

  // 3. Game Data TTK balance calibration (M46)
  let healedGameData: GameDataRegistry | null = input.gameData ?? null;
  if (healedGameData && healedGameData.items.length > 0 && healedGameData.enemies.length > 0) {
    const minTtk = input.targetTtkSec?.min ?? 1.5;
    const maxTtk = input.targetTtkSec?.max ?? 15.0;
    const idealTtk = input.targetTtkSec?.ideal ?? 5.0;
    const baselineWeapon = healedGameData.items[0]!;
    const playerBaseline = { maxHp: 100, armor: 2 };

    let mutatedEnemies = false;
    const nextEnemies = healedGameData.enemies.map((enemy) => {
      const sim = simulateCombatTtk(playerBaseline, baselineWeapon, enemy, {
        runs: 250,
        seed: 42,
      });
      if (sim.p50TtkSec >= minTtk && sim.p50TtkSec <= maxTtk) {
        return enemy;
      }
      beforeIssueCount++;
      const targetHp = Math.max(10, Math.round(sim.effectiveDps * idealTtk));
      mutatedEnemies = true;
      appliedFixes.push({
        kind: 'combat-balance',
        targetId: enemy.id,
        summary: `Balanced "${enemy.displayName || enemy.id}" HP (${enemy.maxHp} -> ${targetHp}) to bring median TTK from ${sim.p50TtkSec.toFixed(1)}s into ~${idealTtk.toFixed(1)}s.`,
      });
      return {
        ...enemy,
        maxHp: targetHp,
      };
    });

    if (mutatedEnemies) {
      healedGameData = {
        ...healedGameData,
        enemies: nextEnemies,
        updatedAt: Date.now(),
      };
    }
  }

  // 4. Narrative Font Glyph Coverage (M47)
  let healedNarrativeBundle: ProjectNarrativeBundle | null = input.narrativeBundle ?? null;
  if (healedNarrativeBundle) {
    const glyphReport = auditFontGlyphCoverage(
      healedNarrativeBundle.localization,
      buildCharsetCodepointSet(healedNarrativeBundle.fontCharset),
    );
    if (!glyphReport.ok && glyphReport.missingChars.length > 0) {
      beforeIssueCount++;
      healedNarrativeBundle = applyMissingGlyphFix(healedNarrativeBundle);
      appliedFixes.push({
        kind: 'missing-glyph',
        targetId: 'font_charset',
        summary: `Added ${glyphReport.missingChars.length} missing glyph(s) to M24 Bitmap Font charset.`,
      });
    }
  }

  return {
    beforeIssueCount,
    afterIssueCount: unresolvedReviewItems.length,
    appliedFixes,
    unresolvedReviewItems,
    healedSprites,
    healedColliders,
    healedWorldGraph,
    healedGameData,
    healedNarrativeBundle,
  };
}
