import { normalizeResSubpath, sanitizeEntitySlug } from '../domain/entitySchema';
import type { VirtualSyncFile } from './godotPrefabAssembler';

export interface GodotBrokenRef {
  readonly filePath: string;
  readonly missingResPath: string;
}

export interface GodotGraphValidationReport {
  readonly ok: boolean;
  readonly totalFiles: number;
  readonly checkedReferences: number;
  readonly brokenReferences: readonly GodotBrokenRef[];
}

export interface ResolvedEntityGameKitAssets {
  readonly spriteResPath?: string;
  readonly canvasTextureResPath?: string;
  readonly shaderMatResPath?: string;
  readonly audioResPath?: string;
}

const textDecoder = new TextDecoder();

function decodeSyncFileText(file: VirtualSyncFile): string {
  return typeof file.content === 'string' ? file.content : textDecoder.decode(file.content);
}

function normalizeRelPath(raw: string): string {
  return raw.replace(/^res:\/\//i, '').replace(/^\/+/, '');
}

function extractResReferences(filePath: string, content: string): string[] {
  const refs: string[] = [];
  const lines = content.split(/\r?\n/);
  const lower = filePath.toLowerCase();

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith(';') || trimmed.startsWith('#')) {
      continue;
    }

    // [ext_resource type="..." path="res://..." id="..."]
    if (trimmed.startsWith('[ext_resource')) {
      const extMatch = /\bpath\s*=\s*"res:\/\/([^"]+)"/.exec(trimmed);
      if (extMatch?.[1]) {
        refs.push(normalizeRelPath(extMatch[1]));
      }
      continue;
    }

    if (lower === 'project.godot') {
      const singleResMatch =
        /^(?:run\/main_scene|audio\/buses\/default_bus_layout|[A-Za-z0-9_]+)\s*=\s*"\*?res:\/\/([^"]+)"/.exec(
          trimmed,
        );
      if (singleResMatch?.[1]) {
        refs.push(normalizeRelPath(singleResMatch[1]));
        continue;
      }

      if (trimmed.startsWith('enabled=PackedStringArray(')) {
        const packedMatch = /PackedStringArray\(([^)]*)\)/.exec(trimmed);
        if (packedMatch?.[1]) {
          const itemRegex = /"res:\/\/([^"]+)"/g;
          let m: RegExpExecArray | null;
          while ((m = itemRegex.exec(packedMatch[1])) !== null) {
            if (m[1]) {
              refs.push(normalizeRelPath(m[1]));
            }
          }
        }
      }
    }
  }

  return refs;
}

/**
 * Validates referential integrity across an assembled Godot 4 virtual filesystem:
 * every `res://...` reference in `.tscn`, `.tres`, and `project.godot` must resolve
 * to a file present in `files`.
 */
export function validateGodotSceneGraph(
  files: readonly VirtualSyncFile[],
): GodotGraphValidationReport {
  const filePathSet = new Set(files.map((f) => normalizeRelPath(f.relativePath)));
  const brokenReferences: GodotBrokenRef[] = [];
  let checkedReferences = 0;

  for (const file of files) {
    const rel = normalizeRelPath(file.relativePath);
    const lower = rel.toLowerCase();
    if (!lower.endsWith('.tscn') && !lower.endsWith('.tres') && lower !== 'project.godot') {
      continue;
    }
    const text = decodeSyncFileText(file);
    const refs = extractResReferences(rel, text);
    for (const refPath of refs) {
      checkedReferences++;
      if (!filePathSet.has(refPath)) {
        brokenReferences.push({
          filePath: rel,
          missingResPath: `res://${refPath}`,
        });
      }
    }
  }

  return {
    ok: brokenReferences.length === 0,
    totalFiles: files.length,
    checkedReferences,
    brokenReferences,
  };
}

/**
 * Resolves real emitted entity textures, `CanvasTexture`, `ShaderMaterial`, and `.wav` cues
 * from `files` so M50 composable GameKit prefabs wire directly to authored assets.
 */
export function resolveEntityGameKitAssets(
  entitySlug: string,
  resSubpath: string,
  files: readonly VirtualSyncFile[],
): ResolvedEntityGameKitAssets {
  const slug = sanitizeEntitySlug(entitySlug);
  const baseDir = `${normalizeResSubpath(resSubpath)}/${slug}`;
  const prefix = `${baseDir}/`;

  const scoped = files
    .map((f) => normalizeRelPath(f.relativePath))
    .filter((p) => p.startsWith(prefix));

  const preferredCanvas = `${baseDir}/${slug}_canvas.tres`;
  const canvasPath =
    scoped.find((p) => p === preferredCanvas) ?? scoped.find((p) => p.endsWith('_canvas.tres'));

  const preferredSprite = `${baseDir}/${slug}.png`;
  const spritePath =
    scoped.find((p) => p === preferredSprite) ??
    scoped.find((p) => p.endsWith('.png') && !p.endsWith('_n.png') && !p.endsWith('_e.png'));

  const preferredMat = `${baseDir}/${slug}_mat.tres`;
  const shaderMatPath =
    scoped.find((p) => p === preferredMat) ?? scoped.find((p) => p.endsWith('_mat.tres'));

  const audioPath = scoped.find((p) => p.endsWith('.wav'));

  return {
    ...(spritePath ? { spriteResPath: `res://${spritePath}` } : {}),
    ...(canvasPath ? { canvasTextureResPath: `res://${canvasPath}` } : {}),
    ...(shaderMatPath ? { shaderMatResPath: `res://${shaderMatPath}` } : {}),
    ...(audioPath ? { audioResPath: `res://${audioPath}` } : {}),
  };
}
