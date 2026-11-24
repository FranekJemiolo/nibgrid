import {
  normalizeResSubpath,
  sanitizeEntitySlug,
  type EntityDefinition,
} from '../domain/entitySchema';

export interface VirtualSyncFile {
  readonly relativePath: string;
  readonly content: Uint8Array | string;
}

export interface EntityAssemblySpriteFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly normalBytes?: Uint8Array;
  readonly spriteNodeId?: string;
}

export interface EntityAssemblyAudioFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
  readonly audioAssetId?: string;
}

export interface EntityAssemblyColliderPolygon {
  readonly layer: 'collider' | 'hurtbox' | 'hitbox';
  readonly points: readonly { readonly x: number; readonly y: number }[];
  readonly activeFrames?: readonly number[];
}

export interface EntityAssemblySocket {
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly angleDeg: number;
}

export interface EntityAssemblyInput {
  readonly entity: EntityDefinition;
  readonly isPixelArt: boolean;
  readonly spriteFiles: readonly EntityAssemblySpriteFile[];
  readonly audioFiles: readonly EntityAssemblyAudioFile[];
  readonly colliderPolygons: readonly EntityAssemblyColliderPolygon[];
  readonly sockets: readonly EntityAssemblySocket[];
}

function roundTo(n: number, decimals = 4): number {
  if (!Number.isFinite(n)) return 0;
  const rounded = Number(n.toFixed(decimals));
  return Object.is(rounded, -0) ? 0 : rounded;
}

function sanitizeFilename(raw: string, fallback: string): string {
  const base = raw.replace(/\\/g, '/').split('/').pop()?.trim() ?? '';
  const cleaned = base.replace(/[^a-zA-Z0-9._-]+/g, '_');
  return cleaned.length > 0 && cleaned !== '.' && cleaned !== '..' ? cleaned : fallback;
}

function sanitizeGodotIdentifier(raw: string, fallback: string): string {
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return cleaned.length > 0 ? cleaned : fallback;
}

function toPascalCase(slug: string): string {
  const parts = slug
    .split(/[^a-zA-Z0-9]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return 'NibgridEntity';
  const joined = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  return /^[0-9]/.test(joined) ? `Entity${joined}` : joined;
}

function escapeGodotString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function formatPackedVector2Array(
  points: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): string {
  const nums = points.flatMap((pt) => [String(roundTo(pt.x, 2)), String(roundTo(pt.y, 2))]);
  return `PackedVector2Array(${nums.join(', ')})`;
}

/**
 * Generates a Godot 4 `.png.import` sidecar so pixel-art textures load lossless without mipmap blur.
 */
export function generateGodotPngImport(resPath: string, isPixelArt: boolean): string {
  return [
    '[remap]',
    'importer="texture"',
    'type="CompressedTexture2D"',
    '',
    '[deps]',
    `source_file="${escapeGodotString(resPath)}"`,
    '',
    '[params]',
    `compress/mode=${isPixelArt ? 0 : 2}`,
    'compress/high_quality=false',
    `mipmaps/generate=${isPixelArt ? 'false' : 'true'}`,
    'process/fix_alpha_border=true',
    'process/premult_alpha=false',
    '',
  ].join('\n');
}

/**
 * Generates a Godot 4 `CanvasTexture` `.tres` pairing diffuse albedo and `_n.png` normal map.
 */
export function generateCanvasTextureTres(
  diffuseResPath: string,
  normalResPath: string,
  isPixelArt: boolean,
): string {
  const textureFilter = isPixelArt ? 1 : 2;
  return [
    '[gd_resource type="CanvasTexture" load_steps=3 format=3]',
    '',
    `[ext_resource type="Texture2D" path="${escapeGodotString(diffuseResPath)}" id="1_diff"]`,
    `[ext_resource type="Texture2D" path="${escapeGodotString(normalResPath)}" id="2_norm"]`,
    '',
    '[resource]',
    'diffuse_texture = ExtResource("1_diff")',
    'normal_texture = ExtResource("2_norm")',
    `texture_filter = ${textureFilter}`,
    '',
  ].join('\n');
}

interface PreparedSpriteAsset {
  readonly spriteNodeId?: string;
  readonly textureResPath: string;
}

/**
 * Pure-TS assembler producing a deterministic sorted set of Godot 4 prefab files:
 * sprites, `.png.import` sidecars, optional `CanvasTexture` `.tres`, WAV audio,
 * `<slug>_frames.tres` (`SpriteFrames`), `<slug>_anims.tres` (`AnimationLibrary`), and `<slug>.tscn`.
 */
export function assembleGodotEntityFiles(input: EntityAssemblyInput): readonly VirtualSyncFile[] {
  const slug = sanitizeEntitySlug(input.entity.slug || input.entity.displayName);
  const cleanSubpath = normalizeResSubpath(input.entity.resSubpath);
  const baseDir = `${cleanSubpath}/${slug}`;
  const resDir = `res://${baseDir}`;
  const textureFilter = input.isPixelArt ? 1 : 2;

  const files: VirtualSyncFile[] = [];
  const preparedSprites: PreparedSpriteAsset[] = [];
  const usedFilenames = new Set<string>();

  const claimUniqueFilename = (rawName: string, fallback: string): string => {
    const clean = sanitizeFilename(rawName, fallback);
    if (!usedFilenames.has(clean)) {
      usedFilenames.add(clean);
      return clean;
    }
    const dotIdx = clean.lastIndexOf('.');
    const stem = dotIdx > 0 ? clean.slice(0, dotIdx) : clean;
    const ext = dotIdx > 0 ? clean.slice(dotIdx) : '';
    let counter = 2;
    while (usedFilenames.has(`${stem}_${counter}${ext}`)) {
      counter++;
    }
    const unique = `${stem}_${counter}${ext}`;
    usedFilenames.add(unique);
    return unique;
  };

  for (let i = 0; i < input.spriteFiles.length; i++) {
    const sprite = input.spriteFiles[i]!;
    const filename = claimUniqueFilename(sprite.filename, `${slug}_${i}.png`);
    const diffuseRel = `${baseDir}/${filename}`;
    const diffuseRes = `${resDir}/${filename}`;

    files.push({ relativePath: diffuseRel, content: sprite.bytes });
    files.push({
      relativePath: `${diffuseRel}.import`,
      content: generateGodotPngImport(diffuseRes, input.isPixelArt),
    });

    if (sprite.normalBytes) {
      const stem = filename.replace(/\.png$/i, '');
      const normalFilename = claimUniqueFilename(`${stem}_n.png`, `${slug}_${i}_n.png`);
      const normalRel = `${baseDir}/${normalFilename}`;
      const normalRes = `${resDir}/${normalFilename}`;
      files.push({ relativePath: normalRel, content: sprite.normalBytes });
      files.push({
        relativePath: `${normalRel}.import`,
        content: generateGodotPngImport(normalRes, input.isPixelArt),
      });

      const canvasTresFilename = claimUniqueFilename(
        `${stem}_canvas.tres`,
        `${slug}_${i}_canvas.tres`,
      );
      const canvasRel = `${baseDir}/${canvasTresFilename}`;
      const canvasRes = `${resDir}/${canvasTresFilename}`;
      files.push({
        relativePath: canvasRel,
        content: generateCanvasTextureTres(diffuseRes, normalRes, input.isPixelArt),
      });
      preparedSprites.push({ spriteNodeId: sprite.spriteNodeId, textureResPath: canvasRes });
    } else {
      preparedSprites.push({ spriteNodeId: sprite.spriteNodeId, textureResPath: diffuseRes });
    }
  }

  const audioEntries: Array<{ readonly resPath: string; readonly audioAssetId?: string }> = [];
  for (let i = 0; i < input.audioFiles.length; i++) {
    const audio = input.audioFiles[i]!;
    const filename = claimUniqueFilename(audio.filename, `${slug}_sfx_${i}.wav`);
    const relPath = `${baseDir}/${filename}`;
    files.push({ relativePath: relPath, content: audio.bytes });
    audioEntries.push({ resPath: `${resDir}/${filename}`, audioAssetId: audio.audioAssetId });
  }

  // Resolve effective clips (at least 1 idle/default clip if clips array is empty and a sprite exists)
  const effectiveClips =
    input.entity.clips.length > 0
      ? input.entity.clips.map((c, idx) => ({
          name: sanitizeGodotIdentifier(c.name, `clip_${idx}`),
          spriteNodeId: c.spriteNodeId,
          fps: Number.isFinite(c.fps) && c.fps > 0 ? c.fps : 8,
          loop: Boolean(c.loop),
          frameAudioTriggers: c.frameAudioTriggers,
        }))
      : [
          {
            name: 'idle',
            spriteNodeId: input.entity.primarySpriteNodeId,
            fps: 8,
            loop: true,
            frameAudioTriggers: undefined,
          },
        ];

  const resolveTextureResForClip = (spriteNodeId: string, clipIdx: number): string | null => {
    const byNode = preparedSprites.find((s) => s.spriteNodeId === spriteNodeId);
    if (byNode) return byNode.textureResPath;
    if (preparedSprites[clipIdx]) return preparedSprites[clipIdx]!.textureResPath;
    return preparedSprites[0]?.textureResPath ?? null;
  };

  // 1. Emit <slug>_frames.tres (SpriteFrames)
  const framesRel = `${baseDir}/${slug}_frames.tres`;
  const framesRes = `${resDir}/${slug}_frames.tres`;
  const frameExtIds = new Map<string, string>();
  const frameExtLines: string[] = [];
  let nextFramesExt = 1;
  for (const sprite of preparedSprites) {
    if (!frameExtIds.has(sprite.textureResPath)) {
      const id = `${nextFramesExt++}_tex`;
      frameExtIds.set(sprite.textureResPath, id);
      frameExtLines.push(
        `[ext_resource type="Texture2D" path="${escapeGodotString(sprite.textureResPath)}" id="${id}"]`,
      );
    }
  }

  const animationsBlocks = effectiveClips.map((clip, idx) => {
    const texRes = resolveTextureResForClip(clip.spriteNodeId, idx);
    const extId = texRes ? frameExtIds.get(texRes) : undefined;
    const framesArray = extId ? `{\n"duration": 1.0,\n"texture": ExtResource("${extId}")\n}` : '';
    return `{\n"frames": [${framesArray}],\n"loop": ${clip.loop ? 'true' : 'false'},\n"name": &"${clip.name}",\n"speed": ${clip.fps.toFixed(1)}\n}`;
  });

  const framesLoadSteps = 1 + frameExtLines.length;
  const framesTres = [
    `[gd_resource type="SpriteFrames" load_steps=${framesLoadSteps} format=3]`,
    '',
    ...frameExtLines,
    ...(frameExtLines.length > 0 ? [''] : []),
    '[resource]',
    `animations = [${animationsBlocks.join(', ')}]`,
    '',
  ].join('\n');
  files.push({ relativePath: framesRel, content: framesTres });

  // 2. Emit <slug>_anims.tres (AnimationLibrary syncing hitboxes, sockets & SFX)
  const animsRel = `${baseDir}/${slug}_anims.tres`;
  const animsRes = `${resDir}/${slug}_anims.tres`;
  const hitboxPolys = input.colliderPolygons.filter((p) => p.layer === 'hitbox');
  const animSubResources: string[] = [];
  const dataEntries: string[] = [];

  for (let clipIdx = 0; clipIdx < effectiveClips.length; clipIdx++) {
    const clip = effectiveClips[clipIdx]!;
    const fps = clip.fps;
    const stepTime = roundTo(1 / fps, 4);
    const triggerKeys = clip.frameAudioTriggers
      ? Object.keys(clip.frameAudioTriggers)
          .map((k) => Number(k))
          .filter((n) => Number.isInteger(n) && n >= 0)
      : [];
    const activeFrames = hitboxPolys.flatMap((h) => h.activeFrames ?? []);
    const maxFrameIdx = Math.max(0, ...activeFrames, ...triggerKeys);
    const lengthSec = roundTo(Math.max(stepTime, (maxFrameIdx + 1) / fps), 4);

    const animId = `Animation_${clip.name}_${clipIdx}`;
    const trackLines: string[] = [];
    let trackIdx = 0;

    // Hitbox active-frame toggle track
    if (hitboxPolys.length > 0) {
      const sortedUnique = Array.from(new Set(activeFrames)).sort((a, b) => a - b);
      const times: number[] = [];
      const values: string[] = [];
      if (sortedUnique.length > 0) {
        const frameCount = maxFrameIdx + 1;
        const activeSet = new Set(sortedUnique);
        for (let f = 0; f < frameCount; f++) {
          times.push(roundTo(f / fps, 4));
          values.push(activeSet.has(f) ? 'false' : 'true');
        }
      } else {
        times.push(0);
        values.push('false');
      }
      const transitions = times.map(() => '1').join(', ');
      trackLines.push(
        `tracks/${trackIdx}/type = "value"`,
        `tracks/${trackIdx}/imported = false`,
        `tracks/${trackIdx}/enabled = true`,
        `tracks/${trackIdx}/path = NodePath("Hitbox/CollisionPolygon2D:disabled")`,
        `tracks/${trackIdx}/interp = 0`,
        `tracks/${trackIdx}/loop_wrap = true`,
        `tracks/${trackIdx}/keys = {\n"times": PackedFloat32Array(${times.join(', ')}),\n"transitions": PackedFloat32Array(${transitions}),\n"update": 1,\n"values": [${values.join(', ')}]\n}`,
      );
      trackIdx++;
    }

    // Socket Marker2D position & rotation tracks
    for (let si = 0; si < input.sockets.length; si++) {
      const socket = input.sockets[si]!;
      const sockName = sanitizeGodotIdentifier(socket.name, `socket_${si}`);
      const px = roundTo(socket.x, 2);
      const py = roundTo(socket.y, 2);
      const rad = roundTo((socket.angleDeg * Math.PI) / 180, 4);

      trackLines.push(
        `tracks/${trackIdx}/type = "value"`,
        `tracks/${trackIdx}/imported = false`,
        `tracks/${trackIdx}/enabled = true`,
        `tracks/${trackIdx}/path = NodePath("Sockets/${sockName}:position")`,
        `tracks/${trackIdx}/interp = 1`,
        `tracks/${trackIdx}/loop_wrap = true`,
        `tracks/${trackIdx}/keys = {\n"times": PackedFloat32Array(0),\n"transitions": PackedFloat32Array(1),\n"update": 0,\n"values": [Vector2(${px}, ${py})]\n}`,
      );
      trackIdx++;

      trackLines.push(
        `tracks/${trackIdx}/type = "value"`,
        `tracks/${trackIdx}/imported = false`,
        `tracks/${trackIdx}/enabled = true`,
        `tracks/${trackIdx}/path = NodePath("Sockets/${sockName}:rotation")`,
        `tracks/${trackIdx}/interp = 1`,
        `tracks/${trackIdx}/loop_wrap = true`,
        `tracks/${trackIdx}/keys = {\n"times": PackedFloat32Array(0),\n"transitions": PackedFloat32Array(1),\n"update": 0,\n"values": [${rad}]\n}`,
      );
      trackIdx++;
    }

    // Frame-bound AudioStreamPlayer2D.play() method track
    if (triggerKeys.length > 0 || (audioEntries.length > 0 && clipIdx === 0)) {
      const sfxFrames =
        triggerKeys.length > 0 ? Array.from(new Set(triggerKeys)).sort((a, b) => a - b) : [0];
      const times = sfxFrames.map((f) => roundTo(f / fps, 4));
      const methodEntries = times.map(() => `{\n"args": [],\n"method": &"play"\n}`);
      const transitions = times.map(() => '1').join(', ');
      trackLines.push(
        `tracks/${trackIdx}/type = "method"`,
        `tracks/${trackIdx}/imported = false`,
        `tracks/${trackIdx}/enabled = true`,
        `tracks/${trackIdx}/path = NodePath("Audio/SfxPlayer")`,
        `tracks/${trackIdx}/interp = 1`,
        `tracks/${trackIdx}/loop_wrap = true`,
        `tracks/${trackIdx}/keys = {\n"times": PackedFloat32Array(${times.join(', ')}),\n"transitions": PackedFloat32Array(${transitions}),\n"values": [${methodEntries.join(', ')}]\n}`,
      );
      trackIdx++;
    }

    animSubResources.push(
      [
        `[sub_resource type="Animation" id="${animId}"]`,
        `resource_name = "${clip.name}"`,
        `length = ${lengthSec}`,
        `loop_mode = ${clip.loop ? 1 : 0}`,
        `step = ${stepTime}`,
        ...trackLines,
      ].join('\n'),
    );
    dataEntries.push(`&"${clip.name}": SubResource("${animId}")`);
  }

  const animsLoadSteps = 1 + animSubResources.length;
  const animsTres = [
    `[gd_resource type="AnimationLibrary" load_steps=${animsLoadSteps} format=3]`,
    '',
    ...animSubResources,
    '',
    '[resource]',
    `_data = {\n${dataEntries.join(',\n')}\n}`,
    '',
  ].join('\n');
  files.push({ relativePath: animsRel, content: animsTres });

  // 3. Emit <slug>.tscn (Complete Godot 4 Prefab)
  const tscnRel = `${baseDir}/${slug}.tscn`;
  const tscnExtResources: string[] = [
    `[ext_resource type="SpriteFrames" path="${escapeGodotString(framesRes)}" id="1_frames"]`,
    `[ext_resource type="AnimationLibrary" path="${escapeGodotString(animsRes)}" id="2_anims"]`,
  ];
  let nextTscnExt = 3;
  let audioExtId: string | null = null;
  if (audioEntries.length > 0) {
    audioExtId = `${nextTscnExt++}_audio`;
    tscnExtResources.push(
      `[ext_resource type="AudioStream" path="${escapeGodotString(audioEntries[0]!.resPath)}" id="${audioExtId}"]`,
    );
  }
  let scriptExtId: string | null = null;
  if (input.entity.scriptResPath && input.entity.scriptResPath.trim().length > 0) {
    scriptExtId = `${nextTscnExt++}_script`;
    tscnExtResources.push(
      `[ext_resource type="Script" path="${escapeGodotString(input.entity.scriptResPath.trim())}" id="${scriptExtId}"]`,
    );
  }

  const tscnLoadSteps = 1 + tscnExtResources.length;
  const rootName = toPascalCase(slug);
  const firstClipName = effectiveClips[0]?.name ?? 'idle';

  const nodeBlocks: string[] = [
    [
      `[node name="${rootName}" type="${input.entity.bodyType}"]`,
      ...(scriptExtId ? [`script = ExtResource("${scriptExtId}")`] : []),
    ].join('\n'),
    [
      `[node name="AnimatedSprite2D" type="AnimatedSprite2D" parent="."]`,
      `texture_filter = ${textureFilter}`,
      `sprite_frames = ExtResource("1_frames")`,
      `animation = &"${firstClipName}"`,
    ].join('\n'),
  ];

  const solidColliders = input.colliderPolygons.filter((p) => p.layer === 'collider');
  solidColliders.forEach((poly, idx) => {
    const nodeName = idx === 0 ? 'CollisionPolygon2D' : `CollisionPolygon2D_${idx + 1}`;
    nodeBlocks.push(
      [
        `[node name="${nodeName}" type="CollisionPolygon2D" parent="."]`,
        `polygon = ${formatPackedVector2Array(poly.points)}`,
      ].join('\n'),
    );
  });

  const hurtboxes = input.colliderPolygons.filter((p) => p.layer === 'hurtbox');
  if (hurtboxes.length > 0) {
    nodeBlocks.push(`[node name="Hurtbox" type="Area2D" parent="."]`);
    hurtboxes.forEach((poly, idx) => {
      const nodeName = idx === 0 ? 'CollisionPolygon2D' : `CollisionPolygon2D_${idx + 1}`;
      nodeBlocks.push(
        [
          `[node name="${nodeName}" type="CollisionPolygon2D" parent="Hurtbox"]`,
          `polygon = ${formatPackedVector2Array(poly.points)}`,
        ].join('\n'),
      );
    });
  }

  if (hitboxPolys.length > 0) {
    nodeBlocks.push(`[node name="Hitbox" type="Area2D" parent="."]`);
    hitboxPolys.forEach((poly, idx) => {
      const nodeName = idx === 0 ? 'CollisionPolygon2D' : `CollisionPolygon2D_${idx + 1}`;
      nodeBlocks.push(
        [
          `[node name="${nodeName}" type="CollisionPolygon2D" parent="Hitbox"]`,
          `disabled = true`,
          `polygon = ${formatPackedVector2Array(poly.points)}`,
        ].join('\n'),
      );
    });
  }

  if (input.sockets.length > 0) {
    nodeBlocks.push(`[node name="Sockets" type="Node2D" parent="."]`);
    input.sockets.forEach((socket, idx) => {
      const sockName = sanitizeGodotIdentifier(socket.name, `socket_${idx}`);
      const rad = roundTo((socket.angleDeg * Math.PI) / 180, 4);
      nodeBlocks.push(
        [
          `[node name="${sockName}" type="Marker2D" parent="Sockets"]`,
          `position = Vector2(${roundTo(socket.x, 2)}, ${roundTo(socket.y, 2)})`,
          `rotation = ${rad}`,
        ].join('\n'),
      );
    });
  }

  if (audioExtId) {
    nodeBlocks.push(`[node name="Audio" type="Node2D" parent="."]`);
    nodeBlocks.push(
      [
        `[node name="SfxPlayer" type="AudioStreamPlayer2D" parent="Audio"]`,
        `stream = ExtResource("${audioExtId}")`,
      ].join('\n'),
    );
  }

  nodeBlocks.push(
    [
      `[node name="AnimationPlayer" type="AnimationPlayer" parent="."]`,
      `libraries = {\n&"": ExtResource("2_anims")\n}`,
    ].join('\n'),
  );

  const tscnContent = [
    `[gd_scene load_steps=${tscnLoadSteps} format=3]`,
    '',
    ...tscnExtResources,
    '',
    ...nodeBlocks.map((block) => `${block}\n`),
  ].join('\n');
  files.push({ relativePath: tscnRel, content: tscnContent });

  return [...files].sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}
