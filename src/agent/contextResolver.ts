import type { EntityDefinition } from '../domain/entitySchema';
import type { ArtBible, AudioAsset, Project, SpriteNode } from '../domain/schemas';
import type { StoredRoomRecord } from '../processing/roomLayoutCore';
import { redactSecrets } from '../providers/errors';

export interface AgentProjectIndex {
  readonly project: Project;
  readonly spriteNodes: readonly SpriteNode[];
  readonly entities: readonly EntityDefinition[];
  readonly audioAssets: readonly AudioAsset[];
  readonly rooms: readonly StoredRoomRecord[];
}

export type ResolvedContextAssetKind =
  'sprite' | 'entity' | 'shader' | 'room' | 'audio' | 'art-bible';

export interface ResolvedContextAsset {
  readonly kind: ResolvedContextAssetKind;
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly summary: string;
  readonly blobId?: string;
}

export interface MentionResolutionResult {
  readonly mentions: readonly string[];
  readonly resolved: readonly ResolvedContextAsset[];
  readonly unresolved: readonly string[];
}

/**
 * Normalizes any label or prompt snippet into Nibgrid's snake_case mention slug.
 */
export function slugifyAssetLabel(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return cleaned || 'asset';
}

function getSpriteSlug(node: SpriteNode): string {
  const raw = node.generationMeta.promptDelta.trim() || `${node.kind}_${node.generationMeta.seed}`;
  return slugifyAssetLabel(raw);
}

/**
 * Builds the flat autocomplete mention catalog for a project's Art Bible, groups,
 * entities, sprites, attached shaders, rooms, and audio assets.
 */
export function buildMentionCatalog(index: AgentProjectIndex): ResolvedContextAsset[] {
  const out: ResolvedContextAsset[] = [
    {
      kind: 'art-bible',
      id: index.project.id,
      slug: 'art_bible',
      label: '@art_bible',
      summary: `ArtBible (${index.project.artBible.artMode}, ${index.project.artBible.projection}, ${index.project.artBible.palette.length} colors)`,
      ...(index.project.artBible.goldenReferenceBlobIds[0]
        ? { blobId: index.project.artBible.goldenReferenceBlobIds[0] }
        : {}),
    },
  ];

  const seenKeys = new Set<string>([`art-bible:${index.project.id}`]);

  for (const ent of index.entities) {
    const slug = slugifyAssetLabel(ent.slug || ent.displayName);
    const key = `entity:${ent.id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      out.push({
        kind: 'entity',
        id: ent.id,
        slug,
        label: `@${slug}`,
        summary: `Entity ${ent.displayName} (${ent.bodyType}, ${ent.clips.length} clips${ent.shaderConfig ? `, shader:${ent.shaderConfig.presetId}` : ''})`,
      });
    }
    if (ent.shaderConfig) {
      const sSlug = slugifyAssetLabel(ent.shaderConfig.presetId || 'hit_flash');
      const sKey = `shader:${ent.id}:${sSlug}`;
      if (!seenKeys.has(sKey)) {
        seenKeys.add(sKey);
        out.push({
          kind: 'shader',
          id: ent.id,
          slug: sSlug,
          label: `@${sSlug}`,
          summary: `Shader ${ent.shaderConfig.presetId} attached to ${ent.slug}`,
        });
      }
    }
  }

  for (const node of index.spriteNodes) {
    const slug = getSpriteSlug(node);
    const key = `sprite:${node.id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      out.push({
        kind: 'sprite',
        id: node.id,
        slug,
        label: `@${slug}`,
        summary: `Sprite (${node.assetClass ?? 'character'}, ${node.sockets?.length ?? 0} sockets, ${node.collisionShapes?.length ?? 0} colliders)`,
        blobId: node.processedBlobId ?? node.imageBlobId,
      });
    }
    if (node.shaderConfig) {
      const sSlug = slugifyAssetLabel(node.shaderConfig.presetId || 'hit_flash');
      const sKey = `shader:${node.id}:${sSlug}`;
      if (!seenKeys.has(sKey)) {
        seenKeys.add(sKey);
        out.push({
          kind: 'shader',
          id: node.id,
          slug: sSlug,
          label: `@${sSlug}`,
          summary: `Shader ${node.shaderConfig.presetId} attached to sprite ${slug}`,
          blobId: node.processedBlobId ?? node.imageBlobId,
        });
      }
    }
  }

  for (const room of index.rooms) {
    const slug = slugifyAssetLabel(room.slug);
    const key = `room:${room.id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      out.push({
        kind: 'room',
        id: room.id,
        slug,
        label: `@${slug}`,
        summary: `Room ${room.blueprint.displayName} (${room.blueprint.cols}×${room.blueprint.rows}, ${room.blueprint.entities.length} spawns)`,
      });
    }
  }

  for (const audio of index.audioAssets) {
    const slug = slugifyAssetLabel(audio.name);
    const key = `audio:${audio.id}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      out.push({
        kind: 'audio',
        id: audio.id,
        slug,
        label: `@${slug}`,
        summary: `Audio ${audio.name} (${audio.presetId}, ${audio.durationSec.toFixed(2)}s)`,
      });
    }
  }

  return out;
}

/**
 * Extracts `@slug` and `@group` mentions (`@art_bible`, `@enemies`, `@all_sprites`)
 * from `prompt` and resolves them deterministically to deduplicated project records.
 */
export function resolveAtMentions(
  prompt: string,
  index: AgentProjectIndex,
): MentionResolutionResult {
  const tokenRegex = /(?:^|[\s(])@([a-zA-Z0-9_-]+)/g;
  const mentions: string[] = [];
  const seenMentionSet = new Set<string>();
  let match: RegExpExecArray | null = tokenRegex.exec(prompt);
  while (match !== null) {
    const tok = (match[1] ?? '').toLowerCase();
    if (tok && !seenMentionSet.has(tok)) {
      seenMentionSet.add(tok);
      mentions.push(tok);
    }
    match = tokenRegex.exec(prompt);
  }

  const catalog = buildMentionCatalog(index);
  const resolved: ResolvedContextAsset[] = [];
  const unresolved: string[] = [];
  const deduped = new Set<string>();

  const pushUnique = (item: ResolvedContextAsset) => {
    const k = `${item.kind}:${item.id}:${item.slug}`;
    if (!deduped.has(k)) {
      deduped.add(k);
      resolved.push(item);
    }
  };

  for (const rawTok of mentions) {
    const normalizedTok = slugifyAssetLabel(rawTok);
    if (normalizedTok === 'enemies') {
      const enemyItems = catalog.filter(
        (c) => c.kind === 'entity' && /enemy|goblin|skeleton|slime|bat|boss/i.test(c.slug),
      );
      const targets =
        enemyItems.length > 0 ? enemyItems : catalog.filter((c) => c.kind === 'entity').slice(1);
      if (targets.length === 0) {
        unresolved.push(rawTok);
      } else {
        targets.forEach(pushUnique);
      }
      continue;
    }

    if (normalizedTok === 'all_sprites') {
      const sprites = catalog.filter((c) => c.kind === 'sprite');
      if (sprites.length === 0) {
        unresolved.push(rawTok);
      } else {
        sprites.forEach(pushUnique);
      }
      continue;
    }

    const exact = catalog.filter((c) => c.slug === normalizedTok || c.id.toLowerCase() === rawTok);
    if (exact.length > 0) {
      exact.forEach(pushUnique);
      continue;
    }

    unresolved.push(rawTok);
  }

  return { mentions, resolved, unresolved };
}

/**
 * Compiles the active project ArtBible + optional `.nibgridrules` instructions
 * into a concise workspace rule header for the asset agent.
 */
export function buildWorkspaceRulesBlock(artBible: ArtBible, customRules?: string): string {
  const lines = [
    '# NIBGRID WORKSPACE RULES (.nibgridrules)',
    `- Art Mode: ${artBible.artMode} | Projection: ${artBible.projection} | Light Angle: ${artBible.lighting}`,
    `- Target Cell Size: ${artBible.targetWidth}x${artBible.targetHeight} px`,
    `- Locked Palette (${artBible.palette.length}): ${artBible.palette.join(', ')}`,
    `- Global Style: ${artBible.stylePrompt}`,
    `- Negative Guardrails: ${artBible.negativePrompt}`,
    `- Godot 4 Invariants: snake_case identifiers, TEXTURE_FILTER_NEAREST, source_color uniforms`,
  ];

  const cleanCustom = customRules ? redactSecrets(customRules).trim() : '';
  if (cleanCustom.length > 0) {
    lines.push('- Custom Project Rules:');
    lines.push(cleanCustom.slice(0, 1500));
  }

  return lines.join('\n');
}
