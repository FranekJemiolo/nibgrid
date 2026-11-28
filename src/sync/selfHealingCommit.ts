import { NibgridRepository, type NibgridDatabase } from '../db/database';
import { createDefaultGameDataRegistry } from '../data/gameDataSchemas';
import { CollisionLayerShapeSchema, SpriteNodeSchema, type Project } from '../domain/schemas';
import { createDefaultProjectNarrative } from '../narrative/dialogueSchemas';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../processing/png';
import { computeArtBibleHash } from '../processing/projectAudit';
import {
  runSelfHealingPreFlight,
  type SelfHealSpriteInput,
  type SelfHealingReport,
} from '../processing/selfHealingQa';

export interface CommitSelfHealResult {
  readonly report: SelfHealingReport;
  readonly persistedUpdates: number;
  readonly purgedOrphanBlobs: number;
}

/**
 * Decodes active project sprites, runs `runSelfHealingPreFlight()`, and commits all
 * repaired sprites, colliders, world graphs, game data, and narrative bundles into Dexie
 * with zero orphan blobs.
 */
export async function runAndCommitSelfHealingPreFlight(
  database: NibgridDatabase,
  project: Project,
): Promise<CommitSelfHealResult> {
  const repo = new NibgridRepository(database);
  const [spriteNodes, worldGraph, existingGameData, existingNarrative] = await Promise.all([
    repo.listSpriteNodes(project.id),
    repo.getWorldGraph(project.id),
    repo.getGameDataRegistry(project.id),
    repo.getNarrativeBundle(project.id),
  ]);

  const gameData = existingGameData ?? createDefaultGameDataRegistry(project.id);
  const narrativeBundle = existingNarrative ?? createDefaultProjectNarrative(project.id);

  const spriteInputs: SelfHealSpriteInput[] = [];
  const dimsBySpriteId = new Map<string, { readonly width: number; readonly height: number }>();

  for (const node of spriteNodes) {
    if (node.kind === 'sketch') continue;
    const blobId = node.processedBlobId ?? node.imageBlobId;
    const rec = await repo.getBlob(blobId);
    if (!rec) continue;
    try {
      const decoded = await decodePngBytesToRgba(new Uint8Array(await rec.bytes.arrayBuffer()));
      dimsBySpriteId.set(node.id, { width: decoded.width, height: decoded.height });
      spriteInputs.push({
        id: node.id,
        name: node.generationMeta.promptDelta || node.id,
        width: decoded.width,
        height: decoded.height,
        data: decoded.rgba,
        hasCollider: (node.collisionShapes?.length ?? 0) > 0,
      });
    } catch {
      // Skip non-PNG blobs
    }
  }

  const report = runSelfHealingPreFlight({
    paletteHex: project.artBible.palette,
    sprites: spriteInputs,
    worldGraph,
    gameData,
    narrativeBundle,
  });

  let persistedUpdates = 0;
  const artHash = computeArtBibleHash(project.artBible);

  for (const node of spriteNodes) {
    const healedRgba = report.healedSprites[node.id];
    const healedHull = report.healedColliders[node.id];
    if (!healedRgba && !healedHull) continue;

    let nextBlobId = node.processedBlobId;
    if (healedRgba) {
      const dims = dimsBySpriteId.get(node.id);
      if (dims) {
        const png = encodeRgbaToPngBytes(healedRgba, dims.width, dims.height);
        const stored = await repo.storeBlobDeduplicated(png, 'image/png');
        nextBlobId = stored.id;
      }
    }

    const nextShapes = healedHull
      ? [
          ...(node.collisionShapes ?? []),
          CollisionLayerShapeSchema.parse({
            id: `col_heal_${node.id.slice(0, 8)}`,
            name: 'Auto-Healed Collider',
            layer: 'collider',
            kind: healedHull.kind,
            isSensor: false,
            visible: true,
            vertices: healedHull.vertices.map((v) => ({ x: v.x, y: v.y })),
          }),
        ]
      : node.collisionShapes;

    const updated = SpriteNodeSchema.parse({
      ...node,
      ...(nextBlobId ? { processedBlobId: nextBlobId } : {}),
      ...(nextShapes ? { collisionShapes: nextShapes } : {}),
      recipeArtBibleHash: artHash,
    });
    await repo.saveSpriteNode(updated);
    persistedUpdates++;
  }

  if (report.healedWorldGraph && report.appliedFixes.some((f) => f.kind === 'softlock-trap')) {
    await repo.saveWorldGraph(report.healedWorldGraph);
    persistedUpdates++;
  }

  if (report.healedGameData && report.appliedFixes.some((f) => f.kind === 'combat-balance')) {
    await repo.saveGameDataRegistry(report.healedGameData);
    persistedUpdates++;
  }

  if (report.healedNarrativeBundle && report.appliedFixes.some((f) => f.kind === 'missing-glyph')) {
    await repo.saveNarrativeBundle(report.healedNarrativeBundle);
    persistedUpdates++;
  }

  const purgedOrphanBlobs = await repo.cleanupOrphanedBlobs();

  return {
    report,
    persistedUpdates,
    purgedOrphanBlobs,
  };
}
