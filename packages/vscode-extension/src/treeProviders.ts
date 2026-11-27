import type { EntityDefinition } from '../../../src/domain/entitySchema';
import type {
  ArtDirectorFinding,
  ArtDirectorQaReport,
} from '../../../src/processing/artDirectorQaSchema';
import type { StoredRoomRecord } from '../../../src/processing/roomLayoutCore';
import { redactHostSecrets } from '../../../src/platform/hostAdapter';

export const DiagnosticSeverityValue = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
} as const;

export const TreeItemCollapsibleState = {
  None: 0,
  Collapsed: 1,
  Expanded: 2,
} as const;

export interface VscodeTreeItemLike {
  readonly id?: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly contextValue?: string;
  readonly collapsibleState: 0 | 1 | 2;
}

export interface NibgridTreeNode {
  readonly kind:
    'entity-root' | 'entity-clip' | 'room-root' | 'room-spawn' | 'qa-summary' | 'qa-finding';
  readonly item: VscodeTreeItemLike;
  readonly children?: readonly NibgridTreeNode[];
  readonly entity?: EntityDefinition;
  readonly room?: StoredRoomRecord;
  readonly finding?: ArtDirectorFinding;
}

export interface VscodeTreeDataProviderLike<T = NibgridTreeNode> {
  getTreeItem: (element: T) => VscodeTreeItemLike;
  getChildren: (element?: T) => readonly T[];
}

export interface VscodeDiagnosticLike {
  readonly message: string;
  readonly severity: number;
  readonly source: string;
  readonly code?: string;
  readonly range: {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
  };
}

export interface VscodeDiagnosticCollectionLike {
  set: (uri: string, diagnostics: readonly VscodeDiagnosticLike[]) => void;
  clear: () => void;
  delete?: (uri: string) => void;
}

export interface VscodeTreeRegistryLike {
  registerTreeDataProvider: <T>(
    viewId: string,
    provider: VscodeTreeDataProviderLike<T>,
  ) => { dispose: () => void };
}

export class EntitiesTreeProvider implements VscodeTreeDataProviderLike<NibgridTreeNode> {
  private entities: readonly EntityDefinition[];

  constructor(initial: readonly EntityDefinition[] = []) {
    this.entities = initial;
  }

  refresh(next: readonly EntityDefinition[]): void {
    this.entities = next;
  }

  getTreeItem(element: NibgridTreeNode): VscodeTreeItemLike {
    return element.item;
  }

  getChildren(element?: NibgridTreeNode): readonly NibgridTreeNode[] {
    if (element) {
      return element.children ?? [];
    }
    return this.entities.map((entity) => ({
      kind: 'entity-root',
      entity,
      item: {
        id: `entity:${entity.id}`,
        label: entity.displayName,
        description: `${entity.slug} · ${entity.bodyType} (${entity.clips.length} clips)`,
        tooltip: `res://${entity.resSubpath}/${entity.slug}/${entity.slug}.tscn`,
        contextValue: 'nibgrid-entity',
        collapsibleState:
          entity.clips.length > 0
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None,
      },
      children: entity.clips.map((clip) => ({
        kind: 'entity-clip',
        item: {
          id: `clip:${entity.id}:${clip.name}`,
          label: `${clip.name} (${clip.fps} fps)`,
          description: clip.loop ? 'loop' : 'oneshot',
          contextValue: 'nibgrid-entity-clip',
          collapsibleState: TreeItemCollapsibleState.None,
        },
      })),
    }));
  }
}

export class RoomsTreeProvider implements VscodeTreeDataProviderLike<NibgridTreeNode> {
  private rooms: readonly StoredRoomRecord[];

  constructor(initial: readonly StoredRoomRecord[] = []) {
    this.rooms = initial;
  }

  refresh(next: readonly StoredRoomRecord[]): void {
    this.rooms = next;
  }

  getTreeItem(element: NibgridTreeNode): VscodeTreeItemLike {
    return element.item;
  }

  getChildren(element?: NibgridTreeNode): readonly NibgridTreeNode[] {
    if (element) {
      return element.children ?? [];
    }
    return this.rooms.map((room) => ({
      kind: 'room-root',
      room,
      item: {
        id: `room:${room.id}`,
        label: room.blueprint.displayName,
        description: `${room.blueprint.cols}×${room.blueprint.rows} · ${room.blueprint.entities.length} spawns`,
        tooltip: `res://levels/${room.slug}.tscn`,
        contextValue: 'nibgrid-room',
        collapsibleState:
          room.blueprint.entities.length > 0
            ? TreeItemCollapsibleState.Collapsed
            : TreeItemCollapsibleState.None,
      },
      children: room.blueprint.entities.map((spawn) => ({
        kind: 'room-spawn',
        item: {
          id: `spawn:${room.id}:${spawn.id}`,
          label: `@${spawn.entitySlug}`,
          description: `cell (${spawn.cellX}, ${spawn.cellY})`,
          contextValue: 'nibgrid-room-spawn',
          collapsibleState: TreeItemCollapsibleState.None,
        },
      })),
    }));
  }
}

export class VisualQaTreeProvider implements VscodeTreeDataProviderLike<NibgridTreeNode> {
  private report: ArtDirectorQaReport | null;

  constructor(initial: ArtDirectorQaReport | null = null) {
    this.report = initial;
  }

  refresh(next: ArtDirectorQaReport | null): void {
    this.report = next;
  }

  getTreeItem(element: NibgridTreeNode): VscodeTreeItemLike {
    return element.item;
  }

  getChildren(element?: NibgridTreeNode): readonly NibgridTreeNode[] {
    if (element) {
      return element.children ?? [];
    }
    if (!this.report) {
      return [];
    }
    const findings: NibgridTreeNode[] = this.report.findings.map((finding) => ({
      kind: 'qa-finding',
      finding,
      item: {
        id: `qa:${finding.spriteId}:${finding.indexLabel}:${finding.category}`,
        label: `[${finding.indexLabel}] ${finding.category}`,
        description: `${finding.severity.toUpperCase()} · fix: ${finding.suggestedFix}`,
        tooltip: finding.summary,
        contextValue: 'nibgrid-qa-finding',
        collapsibleState: TreeItemCollapsibleState.None,
      },
    }));

    return [
      {
        kind: 'qa-summary',
        item: {
          id: `qa-summary:${this.report.sheetHash}`,
          label: `Art Director QA (${this.report.overallScore}/100)`,
          description: `${this.report.findings.length} findings`,
          tooltip: this.report.globalNotes,
          contextValue: 'nibgrid-qa-summary',
          collapsibleState:
            findings.length > 0 ? TreeItemCollapsibleState.Expanded : TreeItemCollapsibleState.None,
        },
        children: findings,
      },
    ];
  }
}

/**
 * Publishes M32 `ArtDirectorQaReport` `warn`/`fail` findings into VS Code Problems
 * (`vscode.languages.createDiagnosticCollection('nibgrid-qa')`), excluding `pass` items.
 */
export function publishQaDiagnostics(
  collection: VscodeDiagnosticCollectionLike,
  report: ArtDirectorQaReport,
  resolveSpriteUri: (spriteId: string) => string,
  opts: { readonly knownSecrets?: readonly string[] } = {},
): { readonly publishedFiles: number; readonly errorCount: number; readonly warningCount: number } {
  collection.clear();

  const grouped = new Map<string, VscodeDiagnosticLike[]>();
  let errorCount = 0;
  let warningCount = 0;

  for (const finding of report.findings) {
    if (finding.severity === 'pass') continue;

    const isError = finding.severity === 'fail';
    if (isError) {
      errorCount += 1;
    } else {
      warningCount += 1;
    }

    const uri = resolveSpriteUri(finding.spriteId);
    const list = grouped.get(uri) ?? [];
    const safeSummary = redactHostSecrets(finding.summary, opts.knownSecrets);
    list.push({
      severity: isError ? DiagnosticSeverityValue.Error : DiagnosticSeverityValue.Warning,
      source: 'Nibgrid Visual QA (M32)',
      code: finding.category,
      message: `[#${finding.indexLabel} · ${finding.category}] ${safeSummary} (Fix: ${finding.suggestedFix})`,
      range: { startLine: 0, startCharacter: 0, endLine: 0, endCharacter: 1 },
    });
    grouped.set(uri, list);
  }

  for (const [uri, diagnostics] of grouped.entries()) {
    collection.set(uri, diagnostics);
  }

  return {
    publishedFiles: grouped.size,
    errorCount,
    warningCount,
  };
}

/**
 * Registers Activity Bar TreeDataProviders for Entities (M25), Rooms (M35), and Visual QA (M32).
 */
export function registerNibgridTreeProviders(
  registry: VscodeTreeRegistryLike,
  initial: {
    readonly entities?: readonly EntityDefinition[];
    readonly rooms?: readonly StoredRoomRecord[];
    readonly qaReport?: ArtDirectorQaReport | null;
  } = {},
): {
  readonly entitiesProvider: EntitiesTreeProvider;
  readonly roomsProvider: RoomsTreeProvider;
  readonly qaProvider: VisualQaTreeProvider;
  readonly disposables: { dispose: () => void }[];
} {
  const entitiesProvider = new EntitiesTreeProvider(initial.entities ?? []);
  const roomsProvider = new RoomsTreeProvider(initial.rooms ?? []);
  const qaProvider = new VisualQaTreeProvider(initial.qaReport ?? null);

  const disposables = [
    registry.registerTreeDataProvider('nibgrid.entities', entitiesProvider),
    registry.registerTreeDataProvider('nibgrid.rooms', roomsProvider),
    registry.registerTreeDataProvider('nibgrid.qa', qaProvider),
  ];

  return {
    entitiesProvider,
    roomsProvider,
    qaProvider,
    disposables,
  };
}
