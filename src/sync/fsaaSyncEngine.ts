import { zipSync } from 'fflate';
import { NibgridRepository, db, type NibgridDatabase } from '../db/database';
import {
  normalizeResSubpath,
  sanitizeEntitySlug,
  type EntityDefinition,
  type FileSystemDirectoryHandleLike,
  type GodotSyncTargetRecord,
} from '../domain/entitySchema';
import type { AudioAsset, Project, SpriteNode } from '../domain/schemas';
import {
  assembleGodotEntityFiles,
  type EntityAssemblyAudioFile,
  type EntityAssemblyColliderPolygon,
  type EntityAssemblySocket,
  type EntityAssemblySpriteFile,
  type VirtualSyncFile,
} from '../export/godotPrefabAssembler';
import { assembleGodotRoomFiles } from '../export/godotRoomExporter';
import { assembleGodotUiKitFiles, bakeBitmapFontFromConfig } from '../export/godotThemeExporter';
import { assembleGodotWorldFiles, exportRoomPortalNodes } from '../export/godotWorldExporter';
import { toAssetSlug, triggerBlobDownload } from '../export/zipPackager';
import { bakeNormalMapCpu } from '../processing/distanceField';
import { decodePngBytesToRgba, encodeRgbaToPngBytes } from '../processing/png';
import { sanitizeRoomSlug, type StoredRoomRecord } from '../processing/roomLayoutCore';
import { bakeProceduralUiKit } from '../processing/uiKitCore';
import {
  bakeWorldMinimapRgba,
  deriveMinimapPaletteFromArtBible,
  type MinimapAtlas,
  type RoomCellGrid,
} from '../world/minimapBaker';
import { computeSyncDiff, virtualFileToBytes, type SyncDiffPlan } from './syncDiff';

type WindowWithDirectoryPicker = Window & {
  showDirectoryPicker?: (options?: {
    mode?: 'read' | 'readwrite';
  }) => Promise<FileSystemDirectoryHandleLike>;
};

/**
 * Runtime cache holding handles that cannot be structured-cloned into IndexedDB
 * (for example in-memory Playwright or Vitest stubs) keyed by project ID.
 */
const inMemoryHandles = new Map<string, FileSystemDirectoryHandleLike>();

export function isFsaaSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'showDirectoryPicker' in window &&
    typeof (window as WindowWithDirectoryPicker).showDirectoryPicker === 'function'
  );
}

export function clearInMemorySyncHandles(): void {
  inMemoryHandles.clear();
}

export function setInMemoryDirectoryHandle(
  projectId: string,
  handle: FileSystemDirectoryHandleLike | null,
): void {
  if (handle) {
    inMemoryHandles.set(projectId, handle);
  } else {
    inMemoryHandles.delete(projectId);
  }
}

export async function bindGodotDirectory(
  database: NibgridDatabase = db,
  projectId: string,
): Promise<GodotSyncTargetRecord> {
  if (!isFsaaSupported()) {
    throw new Error(
      'File System Access API (showDirectoryPicker) is only supported in Chromium browsers.',
    );
  }
  const picker = (window as WindowWithDirectoryPicker).showDirectoryPicker!;
  const handle = await picker({ mode: 'readwrite' });

  const repo = new NibgridRepository(database);
  const existing = await repo.getSyncTarget(projectId);
  const sameFolder = existing && existing.folderName === handle.name;

  inMemoryHandles.set(projectId, handle);

  return repo.saveSyncTarget({
    projectId,
    folderName: handle.name || 'godot_res',
    lastSyncedHashes: sameFolder ? existing.lastSyncedHashes : {},
    lastSyncedAt: sameFolder ? existing.lastSyncedAt : null,
    directoryHandle: handle,
  });
}

export async function getBoundDirectoryHandle(
  database: NibgridDatabase = db,
  projectId: string,
): Promise<FileSystemDirectoryHandleLike | null> {
  const repo = new NibgridRepository(database);
  const record = await repo.getSyncTarget(projectId);
  if (record?.directoryHandle) {
    return record.directoryHandle;
  }
  return inMemoryHandles.get(projectId) ?? null;
}

export async function writeFilesToDirectoryHandle(
  rootHandle: FileSystemDirectoryHandleLike,
  files: readonly VirtualSyncFile[],
): Promise<number> {
  let writtenCount = 0;

  for (const file of files) {
    const segments = file.relativePath
      .replace(/\\/g, '/')
      .split('/')
      .filter((s) => s.length > 0 && s !== '.');
    if (segments.length === 0 || segments.some((s) => s === '..')) {
      throw new Error(`Unsafe relative sync path "${file.relativePath}"`);
    }

    const fileName = segments.pop()!;
    let currentDir = rootHandle;
    for (const dirSeg of segments) {
      currentDir = await currentDir.getDirectoryHandle(dirSeg, { create: true });
    }

    const fileHandle = await currentDir.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable();
    const bytes = virtualFileToBytes(file);
    const bufferCopy = new Uint8Array(bytes.byteLength);
    bufferCopy.set(bytes);
    await writable.write(bufferCopy.buffer);
    await writable.close();
    writtenCount++;
  }

  return writtenCount;
}

export interface GodotSyncExecutionResult {
  readonly plan: SyncDiffPlan;
  readonly writtenCount: number;
  readonly folderName: string;
  readonly syncedAt: number;
  readonly record: GodotSyncTargetRecord;
}

/**
 * Executes a SHA-256 diffed incremental sync to a bound Godot `res://` directory handle,
 * writing ONLY `added` and `modified` files so untouched textures do not trigger re-imports.
 */
export async function syncFilesToGodotDirectory(
  database: NibgridDatabase,
  projectId: string,
  files: readonly VirtualSyncFile[],
): Promise<GodotSyncExecutionResult> {
  const repo = new NibgridRepository(database);
  const existing = await repo.getSyncTarget(projectId);
  const rootHandle = existing?.directoryHandle ?? inMemoryHandles.get(projectId) ?? null;

  if (!rootHandle) {
    throw new Error('No local Godot res:// directory handle is currently bound or accessible.');
  }

  if (rootHandle.queryPermission) {
    const state = await rootHandle.queryPermission({ mode: 'readwrite' });
    if (state !== 'granted') {
      const requested = rootHandle.requestPermission
        ? await rootHandle.requestPermission({ mode: 'readwrite' })
        : 'denied';
      if (requested !== 'granted') {
        throw new Error('Read-write permission to the bound Godot folder was denied.');
      }
    }
  }

  const previousHashes = existing?.lastSyncedHashes ?? {};
  const { plan, nextHashes } = await computeSyncDiff(files, previousHashes);
  const toWrite = [...plan.added, ...plan.modified];

  const writtenCount =
    toWrite.length > 0 ? await writeFilesToDirectoryHandle(rootHandle, toWrite) : 0;

  const syncedAt = Date.now();
  const updatedRecord = await repo.saveSyncTarget({
    projectId,
    folderName: existing?.folderName || rootHandle.name || 'godot_res',
    lastSyncedHashes: nextHashes,
    lastSyncedAt:
      toWrite.length > 0 || !existing || existing.lastSyncedAt === null
        ? syncedAt
        : existing.lastSyncedAt,
    directoryHandle: rootHandle,
  });

  return {
    plan,
    writtenCount,
    folderName: updatedRecord.folderName,
    syncedAt,
    record: updatedRecord,
  };
}

/**
 * Encodes a virtual Godot sync bundle into deterministic ZIP bytes matching the `res://` tree.
 */
export function buildGodotSyncZipBytes(files: readonly VirtualSyncFile[]): Uint8Array {
  const zipEntries: Record<string, Uint8Array> = {};
  for (const file of files) {
    zipEntries[file.relativePath] = virtualFileToBytes(file);
  }
  return zipSync(zipEntries, { level: 6 });
}

export function downloadGodotSyncZip(projectSlug: string, files: readonly VirtualSyncFile[]): void {
  const zipBytes = buildGodotSyncZipBytes(files);
  const copy = new Uint8Array(zipBytes.byteLength);
  copy.set(zipBytes);
  triggerBlobDownload(
    new Blob([copy.buffer], { type: 'application/zip' }),
    `${toAssetSlug(projectSlug || 'godot_sync')}_godot_sync.zip`,
  );
}

function readPngDimensionsFromHeader(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return null;
  const w =
    (((bytes[16] ?? 0) << 24) |
      ((bytes[17] ?? 0) << 16) |
      ((bytes[18] ?? 0) << 8) |
      (bytes[19] ?? 0)) >>>
    0;
  const h =
    (((bytes[20] ?? 0) << 24) |
      ((bytes[21] ?? 0) << 16) |
      ((bytes[22] ?? 0) << 8) |
      (bytes[23] ?? 0)) >>>
    0;
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  const buf = await blob.arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Reads referenced sprite & audio blobs from Dexie and assembles all virtual Godot 4 files
 * for a single `EntityDefinition`.
 */
export async function collectEntitySyncFiles(
  database: NibgridDatabase,
  project: Project,
  entity: EntityDefinition,
  spriteNodes: readonly SpriteNode[],
  audioAssets: readonly AudioAsset[],
): Promise<readonly VirtualSyncFile[]> {
  const repo = new NibgridRepository(database);
  const slug = sanitizeEntitySlug(entity.slug || entity.displayName);
  const isPixelArt = project.artBible.artMode === 'pixel-art';
  const nodeById = new Map(spriteNodes.map((n) => [n.id, n]));
  const audioById = new Map(audioAssets.map((a) => [a.id, a]));

  const referencedNodeIds: string[] = [entity.primarySpriteNodeId];
  for (const clip of entity.clips) {
    if (!referencedNodeIds.includes(clip.spriteNodeId)) {
      referencedNodeIds.push(clip.spriteNodeId);
    }
  }

  const spriteFiles: EntityAssemblySpriteFile[] = [];
  let primaryDimensions: { width: number; height: number } | null = null;

  for (let i = 0; i < referencedNodeIds.length; i++) {
    const nodeId = referencedNodeIds[i]!;
    const node = nodeById.get(nodeId);
    if (!node) continue;

    const blobId = node.processedBlobId ?? node.imageBlobId;
    const blobRec = await repo.getBlob(blobId);
    if (!blobRec) continue;

    const bytes = await readBlobBytes(blobRec.bytes);
    const dims = readPngDimensionsFromHeader(bytes);
    if (i === 0 && dims) {
      primaryDimensions = dims;
    }

    let normalBytes: Uint8Array | undefined;
    let emissionBytes: Uint8Array | undefined;

    if (node.lightingBake?.normalBlobId) {
      const bakedNormRec = await repo.getBlob(node.lightingBake.normalBlobId);
      if (bakedNormRec) {
        normalBytes = await readBlobBytes(bakedNormRec.bytes);
      }
    }
    if (node.lightingBake?.emissionBlobId) {
      const bakedEmissRec = await repo.getBlob(node.lightingBake.emissionBlobId);
      if (bakedEmissRec) {
        emissionBytes = await readBlobBytes(bakedEmissRec.bytes);
      }
    }

    if (!normalBytes && entity.includeNormalMap) {
      try {
        const decoded = await decodePngBytesToRgba(bytes);
        if (i === 0) {
          primaryDimensions = { width: decoded.width, height: decoded.height };
        }
        const normalBuf = bakeNormalMapCpu(
          { width: decoded.width, height: decoded.height, data: decoded.rgba },
          {
            bevelRadiusPx: 6,
            bevelProfile: 'smoothstep',
            bevelStrength: 1.0,
            detailStrength: 0.35,
            convention: 'opengl',
          },
        );
        normalBytes = encodeRgbaToPngBytes(normalBuf.data, normalBuf.width, normalBuf.height);
      } catch {
        normalBytes = undefined;
      }
    }

    const matchingClip = entity.clips.find((c) => c.spriteNodeId === nodeId);
    const clipSuffix = matchingClip ? `_${sanitizeEntitySlug(matchingClip.name)}` : '';
    const filename = i === 0 ? `${slug}.png` : `${slug}${clipSuffix || `_v${i}`}.png`;

    spriteFiles.push({
      spriteNodeId: node.id,
      filename,
      bytes,
      ...(normalBytes ? { normalBytes } : {}),
      ...(emissionBytes ? { emissionBytes } : {}),
    });
  }

  const audioFiles: EntityAssemblyAudioFile[] = [];
  for (let i = 0; i < entity.audioAssetIds.length; i++) {
    const audioId = entity.audioAssetIds[i]!;
    const asset = audioById.get(audioId);
    if (!asset) continue;
    const wavRec = await repo.getBlob(asset.wavBlobId);
    if (!wavRec) continue;
    const bytes = await readBlobBytes(wavRec.bytes);
    const baseName = toAssetSlug(asset.name || `${slug}_sfx_${i}`);
    audioFiles.push({
      audioAssetId: asset.id,
      filename: `${baseName}.wav`,
      bytes,
    });
  }

  const primaryNode = nodeById.get(entity.primarySpriteNodeId);
  const colliderPolygons: EntityAssemblyColliderPolygon[] = (
    primaryNode?.collisionShapes ?? []
  ).map((shape) => ({
    layer: shape.layer,
    points: shape.vertices,
    ...(shape.activeFrames ? { activeFrames: shape.activeFrames } : {}),
  }));

  const pivotNorm = primaryNode?.postProcessConfig?.pivotNorm ?? { x: 0.5, y: 0.5 };
  const refW = primaryDimensions?.width ?? project.artBible.targetWidth;
  const refH = primaryDimensions?.height ?? project.artBible.targetHeight;
  const pivotX = pivotNorm.x * refW;
  const pivotY = pivotNorm.y * refH;

  const sockets: EntityAssemblySocket[] = (primaryNode?.sockets ?? []).map((s) => ({
    name: s.name,
    x: s.restPosPx.x - pivotX,
    y: s.restPosPx.y - pivotY,
    angleDeg: s.baseAngleDeg,
  }));

  const effectiveShader = entity.shaderConfig ?? primaryNode?.shaderConfig;

  return assembleGodotEntityFiles({
    entity,
    isPixelArt,
    spriteFiles,
    audioFiles,
    colliderPolygons,
    sockets,
    ...(entity.scriptContent ? { scriptContent: entity.scriptContent } : {}),
    ...(effectiveShader ? { shaderConfig: effectiveShader } : {}),
  });
}

/**
 * Aggregates deterministic Godot 4 virtual files across every `EntityDefinition`,
 * saved M33 `uiKitConfig` node, and saved M35 `StoredRoomRecord` in a project.
 */
export async function collectProjectGodotSyncFiles(
  database: NibgridDatabase,
  project: Project,
  entities: readonly EntityDefinition[],
  spriteNodes: readonly SpriteNode[],
  audioAssets: readonly AudioAsset[],
  rooms?: readonly StoredRoomRecord[],
): Promise<readonly VirtualSyncFile[]> {
  const deduped = new Map<string, VirtualSyncFile>();
  const entityResPaths: Record<string, string> = {};
  for (const entity of entities) {
    const slug = sanitizeEntitySlug(entity.slug || entity.displayName);
    const cleanSubpath = normalizeResSubpath(entity.resSubpath);
    entityResPaths[slug] = `res://${cleanSubpath}/${slug}/${slug}.tscn`;
    const entityFiles = await collectEntitySyncFiles(
      database,
      project,
      entity,
      spriteNodes,
      audioAssets,
    );
    for (const file of entityFiles) {
      deduped.set(file.relativePath, file);
    }
  }

  const isPixelArt = project.artBible.artMode === 'pixel-art';
  const nodeById = new Map(spriteNodes.map((n) => [n.id, n]));
  for (const node of spriteNodes) {
    if (!node.uiKitConfig) continue;
    const kit = bakeProceduralUiKit(node.uiKitConfig);
    const linkedFontNode = node.uiKitConfig.linkedBmFontId
      ? nodeById.get(node.uiKitConfig.linkedBmFontId)
      : undefined;
    const linkedBmFont = linkedFontNode?.bitmapFont
      ? bakeBitmapFontFromConfig(linkedFontNode.bitmapFont, project.artBible.palette)
      : node.uiKitConfig.linkedBmFontId === 'builtin-hud-font'
        ? bakeBitmapFontFromConfig(
            {
              fontName: 'hud_font',
              sourceKind: 'builtin-5x7',
              customFontFamily: 'monospace',
              rasterSizePx: 16,
              charsetPreset: 'hud-upper',
              customCharset: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ+-!%x.,:/ ',
              scale: 2,
              topHex: '#FFCD75',
              bottomHex: '#EF7D57',
              snapToPalette: true,
              outlineMode: 1,
              selOutDarken: 0.55,
              useCustomOutline: false,
              outlineHex: '#1A1C2C',
              shadowOffsetX: 0,
              shadowOffsetY: 1,
              shadowHex: '#1A1C2C',
              shadowAlpha: 180,
              letterSpacingPx: 1,
              paddingPx: 2,
              previewText: 'HP 100/100',
            },
            project.artBible.palette,
          )
        : undefined;

    const uiFiles = assembleGodotUiKitFiles(kit, {
      isPixelArt,
      ...(linkedBmFont
        ? {
            linkedFont: {
              filenameBase: linkedBmFont.fontName || 'hud_font',
              font: linkedBmFont,
            },
          }
        : {}),
    });
    for (const file of uiFiles) {
      deduped.set(file.relativePath, file);
    }
  }

  const repo = new NibgridRepository(database);
  const effectiveRooms = rooms ?? (await repo.listRooms(project.id));
  const worldGraph = await repo.getWorldGraph(project.id);
  const roomSlugById = new Map<string, string>();
  for (const room of effectiveRooms) {
    roomSlugById.set(room.id, sanitizeRoomSlug(room.slug || room.blueprint.slug));
  }

  for (const room of effectiveRooms) {
    const tileNode = room.tileSetNodeId ? nodeById.get(room.tileSetNodeId) : undefined;
    const parallaxNode = room.parallaxNodeId ? nodeById.get(room.parallaxNodeId) : undefined;
    const tileSetResPath = tileNode
      ? `res://tilesets/${sanitizeRoomSlug(tileNode.generationMeta.promptDelta || tileNode.id)}_tileset.tres`
      : undefined;
    const parallaxResPath = parallaxNode
      ? `res://parallax/${sanitizeRoomSlug(parallaxNode.generationMeta.promptDelta || parallaxNode.id)}_parallax.tscn`
      : undefined;
    const portalNodesSnippet = worldGraph
      ? exportRoomPortalNodes(room.id, worldGraph.edges, roomSlugById, {
          cols: room.blueprint.cols,
          rows: room.blueprint.rows,
          tileSizePx: room.blueprint.tileSizePx,
        })
      : undefined;

    const roomFiles = assembleGodotRoomFiles({
      blueprint: room.blueprint,
      tileSetMode: room.tileSetMode,
      ...(tileSetResPath ? { tileSetResPath } : {}),
      ...(parallaxResPath ? { parallaxResPath } : {}),
      ...(portalNodesSnippet ? { portalNodesSnippet } : {}),
      entityResPaths,
      isPixelArt,
    });
    for (const file of roomFiles) {
      deduped.set(file.relativePath, file);
    }
  }

  if (worldGraph && (worldGraph.rooms.length > 0 || worldGraph.edges.length > 0)) {
    const grids = new Map<string, RoomCellGrid>(effectiveRooms.map((r) => [r.id, r.blueprint]));
    const palette = deriveMinimapPaletteFromArtBible(project.artBible.palette);
    const baked = bakeWorldMinimapRgba(worldGraph, grids, { pxPerTile: 2, palette });

    let minimapPngBytes: Uint8Array | null = null;
    if (worldGraph.minimapBlobId) {
      const rec = await repo.getBlob(worldGraph.minimapBlobId);
      if (rec) {
        minimapPngBytes = await readBlobBytes(rec.bytes);
      }
    }
    if (!minimapPngBytes) {
      minimapPngBytes = encodeRgbaToPngBytes(baked.rgba, baked.width, baked.height);
    }

    let minimapAtlas: MinimapAtlas = baked.atlas;
    if (worldGraph.minimapAtlasJson) {
      try {
        const parsed = JSON.parse(worldGraph.minimapAtlasJson) as MinimapAtlas;
        if (parsed && typeof parsed === 'object' && parsed.rooms) {
          minimapAtlas = parsed;
        }
      } catch {
        minimapAtlas = baked.atlas;
      }
    }

    const worldFiles = assembleGodotWorldFiles({
      graph: worldGraph,
      roomSlugById,
      minimapPngBytes,
      minimapAtlas,
    });
    for (const file of worldFiles) {
      deduped.set(file.relativePath, file);
    }
  }

  return Array.from(deduped.values()).sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}
