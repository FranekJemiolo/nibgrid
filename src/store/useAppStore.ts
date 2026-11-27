import { create } from 'zustand';
import { OFFLINE_MOCK_PROVIDER_ID, repository, type ProjectSummary } from '../db/database';
import type { EntityDefinition, GodotSyncTargetRecord } from '../domain/entitySchema';
import type {
  AdherenceLevel,
  ArtBible,
  AudioAsset,
  AudioBindings,
  Project,
  ProviderConfig,
  ShaderConfig,
  SpriteNode,
} from '../domain/schemas';
import type { AgentCheckpoint } from '../agent/stagingTransactions';
import type { VaultItem } from '../domain/vaultSchema';
import type { StoredRoomRecord } from '../processing/roomLayoutCore';
import type { SliceJobRecord } from '../processing/sliceDagRunner';
import type { PixelTool } from '../processing/pixelEditorCore';
import type { ShareableRecipe } from '../share/recipeUrlCodec';
import type { WorldGraph } from '../world/worldGraphCore';
import type { GameDataRegistry } from '../data/gameDataSchemas';
import type { ProjectNarrativeBundle } from '../narrative/dialogueSchemas';

export type InspectorTab =
  | 'postprocess'
  | 'normal'
  | 'puppet'
  | 'pose'
  | 'sockets'
  | 'vfx-baker'
  | 'tile-slice'
  | 'autotile'
  | 'parallax'
  | 'room'
  | 'world-map'
  | 'data-foundry'
  | 'dialogue-l10n'
  | 'bmfont'
  | 'uikit'
  | 'palette-lut'
  | 'collider'
  | 'sandbox'
  | 'shader'
  | 'turnaround';

export type ScreenRoute =
  | { screen: 'hub' }
  | { screen: 'bible'; projectId: string }
  | { screen: 'studio'; projectId: string }
  | {
      screen: 'inspector';
      projectId: string;
      nodeId: string;
      initialTab?: InspectorTab;
      initialPixelTool?: PixelTool;
    }
  | { screen: 'atlas'; projectId: string }
  | { screen: 'audio'; projectId: string }
  | { screen: 'audit'; projectId: string }
  | { screen: 'entities'; projectId: string; playtestEntityId?: string }
  | { screen: 'world'; projectId: string }
  | { screen: 'data'; projectId: string }
  | { screen: 'dialogue'; projectId: string }
  | { screen: 'vault'; projectId?: string };

const VALID_PIXEL_TOOLS = new Set<PixelTool>([
  'pencil',
  'eraser',
  'eyedropper',
  'fill',
  'mask-brush',
  'mask-eraser',
]);

const VALID_INSPECTOR_TABS = new Set<InspectorTab>([
  'postprocess',
  'normal',
  'puppet',
  'pose',
  'sockets',
  'vfx-baker',
  'tile-slice',
  'autotile',
  'parallax',
  'room',
  'world-map',
  'data-foundry',
  'dialogue-l10n',
  'bmfont',
  'uikit',
  'palette-lut',
  'collider',
  'sandbox',
  'shader',
  'turnaround',
]);

export function parseHashRoute(hash: string): ScreenRoute {
  const raw = hash.replace(/^#/, '');
  const [cleaned, query] = raw.split('?');
  const path = cleaned ?? '';
  const bibleMatch = /^\/project\/([^/]+)\/bible$/.exec(path);
  if (bibleMatch?.[1]) {
    return { screen: 'bible', projectId: bibleMatch[1] };
  }
  const studioMatch = /^\/project\/([^/]+)\/studio$/.exec(path);
  if (studioMatch?.[1]) {
    return { screen: 'studio', projectId: studioMatch[1] };
  }
  const inspectorMatch = /^\/project\/([^/]+)\/inspector\/([^/]+)$/.exec(path);
  if (inspectorMatch?.[1] && inspectorMatch[2]) {
    const params = query ? new URLSearchParams(query) : null;
    const rawTab = params?.get('tab') as InspectorTab | null;
    const initialTab = rawTab && VALID_INSPECTOR_TABS.has(rawTab) ? rawTab : undefined;
    const rawTool = params?.get('tool') as PixelTool | null;
    const initialPixelTool = rawTool && VALID_PIXEL_TOOLS.has(rawTool) ? rawTool : undefined;
    return {
      screen: 'inspector',
      projectId: inspectorMatch[1],
      nodeId: inspectorMatch[2],
      ...(initialTab ? { initialTab } : {}),
      ...(initialPixelTool ? { initialPixelTool } : {}),
    };
  }
  const atlasMatch = /^\/project\/([^/]+)\/atlas$/.exec(path);
  if (atlasMatch?.[1]) {
    return { screen: 'atlas', projectId: atlasMatch[1] };
  }
  const audioMatch = /^\/project\/([^/]+)\/audio$/.exec(path);
  if (audioMatch?.[1]) {
    return { screen: 'audio', projectId: audioMatch[1] };
  }
  const auditMatch = /^\/project\/([^/]+)\/audit$/.exec(path);
  if (auditMatch?.[1]) {
    return { screen: 'audit', projectId: auditMatch[1] };
  }
  const entitiesMatch = /^\/project\/([^/]+)\/entities$/.exec(path);
  if (entitiesMatch?.[1]) {
    const params = query ? new URLSearchParams(query) : null;
    const playtestEntityId = params?.get('playtest')?.trim() || undefined;
    return {
      screen: 'entities',
      projectId: entitiesMatch[1],
      ...(playtestEntityId ? { playtestEntityId } : {}),
    };
  }
  const projectVaultMatch = /^\/project\/([^/]+)\/vault$/.exec(path);
  if (projectVaultMatch?.[1]) {
    return { screen: 'vault', projectId: projectVaultMatch[1] };
  }
  const worldMatch = /^\/project\/([^/]+)\/world$/.exec(path);
  if (worldMatch?.[1]) {
    return { screen: 'world', projectId: worldMatch[1] };
  }
  const dataMatch = /^\/project\/([^/]+)\/data$/.exec(path);
  if (dataMatch?.[1]) {
    return { screen: 'data', projectId: dataMatch[1] };
  }
  const dialogueMatch = /^\/project\/([^/]+)\/dialogue$/.exec(path);
  if (dialogueMatch?.[1]) {
    return { screen: 'dialogue', projectId: dialogueMatch[1] };
  }
  if (path === '/vault') {
    return { screen: 'vault' };
  }
  return { screen: 'hub' };
}

export function formatHashRoute(route: ScreenRoute): string {
  if (route.screen === 'bible') {
    return `#/project/${route.projectId}/bible`;
  }
  if (route.screen === 'studio') {
    return `#/project/${route.projectId}/studio`;
  }
  if (route.screen === 'inspector') {
    const base = `#/project/${route.projectId}/inspector/${route.nodeId}`;
    const sp = new URLSearchParams();
    if (route.initialTab) sp.set('tab', route.initialTab);
    if (route.initialPixelTool) sp.set('tool', route.initialPixelTool);
    const qs = sp.toString();
    return qs ? `${base}?${qs}` : base;
  }
  if (route.screen === 'atlas') {
    return `#/project/${route.projectId}/atlas`;
  }
  if (route.screen === 'audio') {
    return `#/project/${route.projectId}/audio`;
  }
  if (route.screen === 'audit') {
    return `#/project/${route.projectId}/audit`;
  }
  if (route.screen === 'entities') {
    const base = `#/project/${route.projectId}/entities`;
    return route.playtestEntityId
      ? `${base}?playtest=${encodeURIComponent(route.playtestEntityId)}`
      : base;
  }
  if (route.screen === 'world') {
    return `#/project/${route.projectId}/world`;
  }
  if (route.screen === 'data') {
    return `#/project/${route.projectId}/data`;
  }
  if (route.screen === 'dialogue') {
    return `#/project/${route.projectId}/dialogue`;
  }
  if (route.screen === 'vault') {
    return route.projectId ? `#/project/${route.projectId}/vault` : '#/vault';
  }
  return '#/';
}

export interface InlineAgentTarget {
  readonly kind: 'sprite' | 'entity' | 'room';
  readonly id: string;
  readonly slug: string;
}

interface AppState {
  route: ScreenRoute;
  projects: ProjectSummary[];
  activeProject: Project | null;
  spriteNodes: SpriteNode[];
  audioAssets: AudioAsset[];
  entities: EntityDefinition[];
  rooms: StoredRoomRecord[];
  worldGraph: WorldGraph | null;
  gameDataRegistry: GameDataRegistry | null;
  narrativeBundle: ProjectNarrativeBundle | null;
  focusedRoomId: string | null;
  sliceJobs: SliceJobRecord[];
  agentCheckpoints: AgentCheckpoint[];
  syncTarget: GodotSyncTargetRecord | null;
  vaultItems: VaultItem[];
  outgoingShareRecipe: ShareableRecipe | null;
  p2pOpen: boolean;
  autopilotOpen: boolean;
  composerOpen: boolean;
  modelSettingsOpen: boolean;
  installDesktopOpen: boolean;
  lightingBakerOpen: boolean;
  inlineCommandTarget: InlineAgentTarget | null;
  workspaceRulesText: string;
  providers: ProviderConfig[];
  selectedProviderId: string;
  studioAdherence: AdherenceLevel;
  studioVariantCount: 1 | 2;
  vaultOpen: boolean;
  isLoading: boolean;
  errorMessage: string | null;

  initialize: () => Promise<void>;
  navigate: (route: ScreenRoute) => Promise<void>;
  setVaultOpen: (open: boolean) => void;
  setP2pOpen: (open: boolean) => void;
  setAutopilotOpen: (open: boolean) => void;
  setComposerOpen: (open: boolean) => void;
  setModelSettingsOpen: (open: boolean) => void;
  setInstallDesktopOpen: (open: boolean) => void;
  setLightingBakerOpen: (open: boolean) => void;
  setInlineCommandTarget: (target: InlineAgentTarget | null) => void;
  setWorkspaceRulesText: (text: string) => void;
  openShareModal: (recipe: ShareableRecipe) => void;
  closeShareModal: () => void;
  clearError: () => void;

  refreshProjects: () => Promise<void>;
  createProject: (name: string) => Promise<Project>;
  deleteProject: (projectId: string) => Promise<void>;
  patchActiveArtBible: (patch: Partial<ArtBible>) => Promise<void>;
  updateActiveArtBible: (artBible: ArtBible) => Promise<void>;
  updateActiveProjectName: (name: string) => Promise<void>;
  addGoldenReference: (file: File) => Promise<void>;
  removeGoldenReference: (blobId: string) => Promise<void>;

  refreshProviders: () => Promise<void>;
  saveProvider: (config: ProviderConfig) => Promise<void>;
  deleteProvider: (id: string) => Promise<void>;
  setSelectedProviderId: (id: string) => void;
  setStudioAdherence: (adherence: AdherenceLevel) => void;
  setStudioVariantCount: (count: 1 | 2) => void;

  refreshSpriteNodes: (projectId: string) => Promise<void>;
  refreshAudioAssets: (projectId: string) => Promise<void>;
  saveAudioAssetRecord: (asset: AudioAsset) => Promise<AudioAsset>;
  deleteAudioAssetRecord: (assetId: string, projectId: string) => Promise<void>;
  patchProjectAudioBindings: (patch: Partial<AudioBindings>) => Promise<void>;

  refreshEntities: (projectId: string) => Promise<void>;
  saveEntityRecord: (entity: EntityDefinition) => Promise<EntityDefinition>;
  deleteEntityRecord: (entityId: string, projectId: string) => Promise<void>;
  refreshRooms: (projectId: string) => Promise<void>;
  saveRoomRecord: (room: StoredRoomRecord) => Promise<StoredRoomRecord>;
  deleteRoomRecord: (roomId: string, projectId: string) => Promise<void>;
  setFocusedRoomId: (roomId: string | null) => void;
  refreshWorldGraph: (projectId: string) => Promise<void>;
  saveWorldGraphRecord: (graph: WorldGraph) => Promise<WorldGraph>;
  commitWorldGraphMinimap: (
    graph: WorldGraph,
    pngBlob: Blob,
    atlasJson: string,
  ) => Promise<WorldGraph>;
  refreshGameDataRegistry: (projectId: string) => Promise<void>;
  saveGameDataRegistryRecord: (registry: GameDataRegistry) => Promise<GameDataRegistry>;
  refreshNarrativeBundle: (projectId: string) => Promise<void>;
  saveNarrativeBundleRecord: (bundle: ProjectNarrativeBundle) => Promise<ProjectNarrativeBundle>;
  appendNarrativeFontGlyphs: (
    projectId: string,
    missingChars: readonly string[],
  ) => Promise<ProjectNarrativeBundle>;
  refreshSliceJobs: (projectId: string) => Promise<void>;
  saveSliceJobRecord: (job: SliceJobRecord) => Promise<SliceJobRecord>;
  deleteSliceJobRecord: (jobId: string, projectId: string) => Promise<void>;
  refreshAgentCheckpoints: (projectId: string) => Promise<void>;
  refreshSyncTarget: (projectId: string) => Promise<void>;

  refreshVaultItems: () => Promise<void>;
  deleteVaultItemRecord: (vaultItemId: string) => Promise<void>;
  promoteSpriteToVault: (
    node: SpriteNode,
    options?: { name?: string; tags?: readonly string[]; sourceProjectName?: string },
  ) => Promise<VaultItem>;
  promoteShaderToVault: (
    name: string,
    shaderConfig: ShaderConfig,
    options?: { tags?: readonly string[]; sourceProjectName?: string },
  ) => Promise<VaultItem>;
  importVaultItemToActiveProject: (
    vaultItemId: string,
    options?: { targetSpriteNodeId?: string },
  ) => Promise<{ kind: VaultItem['kind']; spriteNode?: SpriteNode; audioAsset?: AudioAsset }>;
}

let projectWriteQueue: Promise<void> = Promise.resolve();

function enqueueProjectWrite<T>(fn: () => Promise<T>): Promise<T> {
  const next = projectWriteQueue.then(fn, fn);
  projectWriteQueue = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

export const useAppStore = create<AppState>((set, get) => ({
  route: typeof window !== 'undefined' ? parseHashRoute(window.location.hash) : { screen: 'hub' },
  projects: [],
  activeProject: null,
  spriteNodes: [],
  audioAssets: [],
  entities: [],
  rooms: [],
  worldGraph: null,
  gameDataRegistry: null,
  narrativeBundle: null,
  focusedRoomId: null,
  sliceJobs: [],
  agentCheckpoints: [],
  syncTarget: null,
  vaultItems: [],
  outgoingShareRecipe: null,
  p2pOpen: false,
  autopilotOpen: false,
  composerOpen: false,
  modelSettingsOpen: false,
  installDesktopOpen: false,
  lightingBakerOpen: false,
  inlineCommandTarget: null,
  workspaceRulesText: '',
  providers: [],
  selectedProviderId: OFFLINE_MOCK_PROVIDER_ID,
  studioAdherence: 'balanced',
  studioVariantCount: 2,
  vaultOpen: false,
  isLoading: true,
  errorMessage: null,

  initialize: async () => {
    set({ isLoading: true, errorMessage: null });
    try {
      await repository.cleanupOrphanedBlobs();
      const [projects, providers, vaultItems] = await Promise.all([
        repository.listProjectsWithCounts(),
        repository.listProviderConfigs(),
        repository.listVaultItems(),
      ]);

      const initialRoute: ScreenRoute =
        typeof window !== 'undefined' ? parseHashRoute(window.location.hash) : { screen: 'hub' };

      if (initialRoute.screen === 'vault') {
        const project = initialRoute.projectId
          ? await repository.getProject(initialRoute.projectId)
          : undefined;
        if (project) {
          const [
            spriteNodes,
            audioAssets,
            entities,
            rooms,
            sliceJobs,
            agentCheckpoints,
            syncTarget,
            worldGraph,
            gameDataRegistry,
            narrativeBundle,
          ] = await Promise.all([
            repository.listSpriteNodes(project.id),
            repository.listAudioAssets(project.id),
            repository.listEntities(project.id),
            repository.listRooms(project.id),
            repository.listSliceJobs(project.id),
            repository.listAgentCheckpoints(project.id),
            repository.getSyncTarget(project.id),
            repository.getWorldGraph(project.id),
            repository.getGameDataRegistry(project.id),
            repository.getNarrativeBundle(project.id),
          ]);
          set({
            route: initialRoute,
            projects,
            providers,
            vaultItems,
            activeProject: project,
            spriteNodes,
            audioAssets,
            entities,
            rooms,
            worldGraph: worldGraph ?? null,
            gameDataRegistry: gameDataRegistry ?? null,
            narrativeBundle: narrativeBundle ?? null,
            sliceJobs,
            agentCheckpoints,
            syncTarget: syncTarget ?? null,
            isLoading: false,
          });
          return;
        }
        set({
          route: { screen: 'vault' },
          projects,
          providers,
          vaultItems,
          activeProject: null,
          spriteNodes: [],
          audioAssets: [],
          entities: [],
          rooms: [],
          worldGraph: null,
          gameDataRegistry: null,
          narrativeBundle: null,
          sliceJobs: [],
          agentCheckpoints: [],
          syncTarget: null,
          isLoading: false,
        });
        return;
      }

      if (initialRoute.screen !== 'hub') {
        const project = await repository.getProject(initialRoute.projectId);
        if (project) {
          const [
            spriteNodes,
            audioAssets,
            entities,
            rooms,
            sliceJobs,
            agentCheckpoints,
            syncTarget,
            worldGraph,
            gameDataRegistry,
            narrativeBundle,
          ] = await Promise.all([
            repository.listSpriteNodes(project.id),
            repository.listAudioAssets(project.id),
            repository.listEntities(project.id),
            repository.listRooms(project.id),
            repository.listSliceJobs(project.id),
            repository.listAgentCheckpoints(project.id),
            repository.getSyncTarget(project.id),
            repository.getWorldGraph(project.id),
            repository.getGameDataRegistry(project.id),
            repository.getNarrativeBundle(project.id),
          ]);
          set({
            route: initialRoute,
            projects,
            providers,
            vaultItems,
            activeProject: project,
            spriteNodes,
            audioAssets,
            entities,
            rooms,
            worldGraph: worldGraph ?? null,
            gameDataRegistry: gameDataRegistry ?? null,
            narrativeBundle: narrativeBundle ?? null,
            sliceJobs,
            agentCheckpoints,
            syncTarget: syncTarget ?? null,
            isLoading: false,
          });
          return;
        }
        if (typeof window !== 'undefined' && !window.location.hash.startsWith('#share=')) {
          window.location.hash = '#/';
        }
      }

      set({
        route: { screen: 'hub' },
        projects,
        providers,
        vaultItems,
        activeProject: null,
        spriteNodes: [],
        audioAssets: [],
        entities: [],
        rooms: [],
        worldGraph: null,
        gameDataRegistry: null,
        sliceJobs: [],
        agentCheckpoints: [],
        syncTarget: null,
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        errorMessage: error instanceof Error ? error.message : 'Failed to initialize store',
      });
    }
  },

  navigate: async (route) => {
    if (typeof window !== 'undefined') {
      const targetHash = formatHashRoute(route);
      if (window.location.hash !== targetHash && !window.location.hash.startsWith('#share=')) {
        window.location.hash = targetHash;
      }
    }

    if (route.screen === 'vault') {
      const [projects, vaultItems] = await Promise.all([
        repository.listProjectsWithCounts(),
        repository.listVaultItems(),
      ]);
      const targetProjectId = route.projectId ?? get().activeProject?.id;
      const project = targetProjectId ? await repository.getProject(targetProjectId) : undefined;
      if (project) {
        const [
          spriteNodes,
          audioAssets,
          entities,
          rooms,
          sliceJobs,
          agentCheckpoints,
          syncTarget,
          worldGraph,
          gameDataRegistry,
          narrativeBundle,
        ] = await Promise.all([
          repository.listSpriteNodes(project.id),
          repository.listAudioAssets(project.id),
          repository.listEntities(project.id),
          repository.listRooms(project.id),
          repository.listSliceJobs(project.id),
          repository.listAgentCheckpoints(project.id),
          repository.getSyncTarget(project.id),
          repository.getWorldGraph(project.id),
          repository.getGameDataRegistry(project.id),
          repository.getNarrativeBundle(project.id),
        ]);
        set({
          route: { screen: 'vault', projectId: project.id },
          projects,
          vaultItems,
          activeProject: project,
          spriteNodes,
          audioAssets,
          entities,
          rooms,
          worldGraph: worldGraph ?? null,
          gameDataRegistry: gameDataRegistry ?? null,
          narrativeBundle: narrativeBundle ?? null,
          sliceJobs,
          agentCheckpoints,
          syncTarget: syncTarget ?? null,
          errorMessage: null,
        });
      } else {
        set({
          route: { screen: 'vault' },
          projects,
          vaultItems,
          activeProject: null,
          spriteNodes: [],
          audioAssets: [],
          entities: [],
          rooms: [],
          worldGraph: null,
          gameDataRegistry: null,
          narrativeBundle: null,
          sliceJobs: [],
          agentCheckpoints: [],
          syncTarget: null,
          errorMessage: null,
        });
      }
      return;
    }

    if (route.screen === 'hub') {
      const projects = await repository.listProjectsWithCounts();
      set({
        route,
        projects,
        activeProject: null,
        spriteNodes: [],
        audioAssets: [],
        entities: [],
        rooms: [],
        worldGraph: null,
        gameDataRegistry: null,
        narrativeBundle: null,
        sliceJobs: [],
        agentCheckpoints: [],
        syncTarget: null,
        errorMessage: null,
      });
      return;
    }

    const project = await repository.getProject(route.projectId);
    if (!project) {
      if (typeof window !== 'undefined') {
        window.location.hash = '#/';
      }
      const projects = await repository.listProjectsWithCounts();
      set({
        route: { screen: 'hub' },
        projects,
        activeProject: null,
        spriteNodes: [],
        audioAssets: [],
        entities: [],
        rooms: [],
        worldGraph: null,
        gameDataRegistry: null,
        narrativeBundle: null,
        sliceJobs: [],
        agentCheckpoints: [],
        syncTarget: null,
        errorMessage: `Project "${route.projectId}" was not found.`,
      });
      return;
    }

    const prevProjectId = get().activeProject?.id;
    const isSwitchingProject = prevProjectId !== project.id;
    const [
      spriteNodes,
      audioAssets,
      entities,
      rooms,
      sliceJobs,
      agentCheckpoints,
      syncTarget,
      worldGraph,
      gameDataRegistry,
      narrativeBundle,
    ] = await Promise.all([
      repository.listSpriteNodes(project.id),
      repository.listAudioAssets(project.id),
      repository.listEntities(project.id),
      repository.listRooms(project.id),
      repository.listSliceJobs(project.id),
      repository.listAgentCheckpoints(project.id),
      repository.getSyncTarget(project.id),
      repository.getWorldGraph(project.id),
      repository.getGameDataRegistry(project.id),
      repository.getNarrativeBundle(project.id),
    ]);
    set({
      route,
      activeProject: project,
      spriteNodes,
      audioAssets,
      entities,
      rooms,
      worldGraph: worldGraph ?? null,
      gameDataRegistry: gameDataRegistry ?? null,
      narrativeBundle: narrativeBundle ?? null,
      sliceJobs,
      agentCheckpoints,
      syncTarget: syncTarget ?? null,
      errorMessage: null,
      ...(isSwitchingProject ? { studioAdherence: 'balanced', studioVariantCount: 2 } : {}),
    });
  },

  setVaultOpen: (open) => set({ vaultOpen: open }),
  setP2pOpen: (open) => set({ p2pOpen: open }),
  setAutopilotOpen: (open) => set({ autopilotOpen: open }),
  setComposerOpen: (open) => set({ composerOpen: open }),
  setModelSettingsOpen: (open) => set({ modelSettingsOpen: open }),
  setInstallDesktopOpen: (open) => set({ installDesktopOpen: open }),
  setLightingBakerOpen: (open) => set({ lightingBakerOpen: open }),
  setInlineCommandTarget: (target) => set({ inlineCommandTarget: target }),
  setWorkspaceRulesText: (text) => set({ workspaceRulesText: text }),
  openShareModal: (recipe) => set({ outgoingShareRecipe: recipe }),
  closeShareModal: () => set({ outgoingShareRecipe: null }),
  clearError: () => set({ errorMessage: null }),

  refreshProjects: async () => {
    const projects = await repository.listProjectsWithCounts();
    set({ projects });
  },

  createProject: async (name) => {
    const trimmed = name.trim();
    const project = await repository.createProject(trimmed);
    const projects = await repository.listProjectsWithCounts();
    set({ projects, errorMessage: null });
    return project;
  },

  deleteProject: async (projectId) => {
    await repository.deleteProjectCascade(projectId);
    const projects = await repository.listProjectsWithCounts();
    const { activeProject } = get();
    if (activeProject?.id === projectId) {
      if (typeof window !== 'undefined') {
        window.location.hash = '#/';
      }
      set({
        route: { screen: 'hub' },
        activeProject: null,
        spriteNodes: [],
        audioAssets: [],
        entities: [],
        rooms: [],
        worldGraph: null,
        gameDataRegistry: null,
        narrativeBundle: null,
        sliceJobs: [],
        agentCheckpoints: [],
        syncTarget: null,
        projects,
      });
    } else {
      set({ projects });
    }
  },

  patchActiveArtBible: async (patch) => {
    const activeProject = get().activeProject;
    if (!activeProject) return;
    const merged: ArtBible = { ...activeProject.artBible, ...patch };
    const optimistic: Project = {
      ...activeProject,
      artBible: merged,
      updatedAt: new Date().toISOString(),
    };
    set({ activeProject: optimistic, errorMessage: null });

    await enqueueProjectWrite(async () => {
      const latest = get().activeProject;
      if (!latest || latest.id !== activeProject.id) return;
      const updated = await repository.updateProjectArtBible(latest.id, latest.artBible);
      const projects = await repository.listProjectsWithCounts();
      const postWriteLatest = get().activeProject;
      if (postWriteLatest && postWriteLatest.id === updated.id) {
        set({
          activeProject: {
            ...updated,
            artBible: postWriteLatest.artBible,
          },
          projects,
          errorMessage: null,
        });
      } else {
        set({ projects, errorMessage: null });
      }
    });
  },

  updateActiveArtBible: async (artBible) => {
    await get().patchActiveArtBible(artBible);
  },

  updateActiveProjectName: async (name) => {
    const activeProject = get().activeProject;
    if (!activeProject) return;
    const trimmed = name.trim();
    if (!trimmed) return;
    await enqueueProjectWrite(async () => {
      const updated = await repository.updateProjectMeta(activeProject.id, { name: trimmed });
      const projects = await repository.listProjectsWithCounts();
      set({ activeProject: updated, projects, errorMessage: null });
    });
  },

  addGoldenReference: async (file) => {
    const activeProject = get().activeProject;
    if (!activeProject) return;
    await enqueueProjectWrite(async () => {
      const updated = await repository.addGoldenReference(activeProject.id, file);
      const projects = await repository.listProjectsWithCounts();
      set({ activeProject: updated, projects, errorMessage: null });
    });
  },

  removeGoldenReference: async (blobId) => {
    const activeProject = get().activeProject;
    if (!activeProject) return;
    await enqueueProjectWrite(async () => {
      const updated = await repository.removeGoldenReference(activeProject.id, blobId);
      const projects = await repository.listProjectsWithCounts();
      set({ activeProject: updated, projects, errorMessage: null });
    });
  },

  refreshProviders: async () => {
    const providers = await repository.listProviderConfigs();
    set({ providers });
  },

  saveProvider: async (config) => {
    await repository.saveProviderConfig(config);
    const providers = await repository.listProviderConfigs();
    set({ providers });
  },

  deleteProvider: async (id) => {
    await repository.deleteProviderConfig(id);
    const providers = await repository.listProviderConfigs();
    const nextSelected =
      get().selectedProviderId === id ? OFFLINE_MOCK_PROVIDER_ID : get().selectedProviderId;
    set({ providers, selectedProviderId: nextSelected });
  },

  setSelectedProviderId: (id) => set({ selectedProviderId: id }),
  setStudioAdherence: (studioAdherence) => set({ studioAdherence }),
  setStudioVariantCount: (studioVariantCount) => set({ studioVariantCount }),

  refreshSpriteNodes: async (projectId) => {
    const [spriteNodes, projects] = await Promise.all([
      repository.listSpriteNodes(projectId),
      repository.listProjectsWithCounts(),
    ]);
    set({ spriteNodes, projects });
  },

  refreshAudioAssets: async (projectId) => {
    const audioAssets = await repository.listAudioAssets(projectId);
    set({ audioAssets });
  },

  saveAudioAssetRecord: async (asset) => {
    const saved = await repository.saveAudioAsset(asset);
    const audioAssets = await repository.listAudioAssets(saved.projectId);
    set({ audioAssets });
    return saved;
  },

  deleteAudioAssetRecord: async (assetId, projectId) => {
    await repository.deleteAudioAsset(assetId);
    const audioAssets = await repository.listAudioAssets(projectId);
    set({ audioAssets });
  },

  patchProjectAudioBindings: async (patch) => {
    const activeProject = get().activeProject;
    if (!activeProject) return;
    const merged: AudioBindings = { ...(activeProject.audioBindings ?? {}), ...patch };
    const optimistic: Project = {
      ...activeProject,
      audioBindings: merged,
      updatedAt: new Date().toISOString(),
    };
    set({ activeProject: optimistic, errorMessage: null });

    await enqueueProjectWrite(async () => {
      const latest = get().activeProject;
      if (!latest || latest.id !== activeProject.id) return;
      const updated = await repository.updateProjectMeta(latest.id, {
        audioBindings: latest.audioBindings ?? merged,
      });
      const projects = await repository.listProjectsWithCounts();
      const postWriteLatest = get().activeProject;
      if (postWriteLatest && postWriteLatest.id === updated.id) {
        set({
          activeProject: {
            ...updated,
            audioBindings: postWriteLatest.audioBindings,
          },
          projects,
          errorMessage: null,
        });
      } else {
        set({ projects, errorMessage: null });
      }
    });
  },

  refreshEntities: async (projectId) => {
    const entities = await repository.listEntities(projectId);
    set({ entities });
  },

  saveEntityRecord: async (entity) => {
    const saved = await repository.saveEntity(entity);
    const entities = await repository.listEntities(saved.projectId);
    set({ entities });
    return saved;
  },

  deleteEntityRecord: async (entityId, projectId) => {
    await repository.deleteEntity(entityId);
    const entities = await repository.listEntities(projectId);
    set({ entities });
  },

  refreshRooms: async (projectId) => {
    const rooms = await repository.listRooms(projectId);
    set({ rooms });
  },

  saveRoomRecord: async (room) => {
    const saved = await repository.saveRoom(room);
    const rooms = await repository.listRooms(saved.projectId);
    set({ rooms });
    return saved;
  },

  deleteRoomRecord: async (roomId, projectId) => {
    await repository.deleteRoom(roomId);
    const rooms = await repository.listRooms(projectId);
    set({ rooms });
  },

  setFocusedRoomId: (roomId) => set({ focusedRoomId: roomId }),

  refreshWorldGraph: async (projectId) => {
    const worldGraph = await repository.getWorldGraph(projectId);
    set({ worldGraph: worldGraph ?? null });
  },

  saveWorldGraphRecord: async (graph) => {
    const saved = await repository.saveWorldGraph(graph);
    set({ worldGraph: saved });
    return saved;
  },

  commitWorldGraphMinimap: async (graph, pngBlob, atlasJson) => {
    const committed = await repository.commitWorldGraphWithMinimap(graph, pngBlob, atlasJson);
    set({ worldGraph: committed });
    return committed;
  },

  refreshGameDataRegistry: async (projectId) => {
    const gameDataRegistry = await repository.getGameDataRegistry(projectId);
    set({ gameDataRegistry: gameDataRegistry ?? null });
  },

  saveGameDataRegistryRecord: async (registry) => {
    const saved = await repository.saveGameDataRegistry(registry);
    set({ gameDataRegistry: saved });
    return saved;
  },

  refreshNarrativeBundle: async (projectId) => {
    const narrativeBundle = await repository.getNarrativeBundle(projectId);
    set({ narrativeBundle: narrativeBundle ?? null });
  },

  saveNarrativeBundleRecord: async (bundle) => {
    const saved = await repository.saveNarrativeBundle(bundle);
    set({ narrativeBundle: saved });
    return saved;
  },

  appendNarrativeFontGlyphs: async (projectId, missingChars) => {
    const updated = await repository.appendNarrativeFontGlyphs(projectId, missingChars);
    const spriteNodes = await repository.listSpriteNodes(projectId);
    set({ narrativeBundle: updated, spriteNodes });
    return updated;
  },

  refreshSliceJobs: async (projectId) => {
    const sliceJobs = await repository.listSliceJobs(projectId);
    set({ sliceJobs });
  },

  saveSliceJobRecord: async (job) => {
    const saved = await repository.saveSliceJob(job);
    const sliceJobs = await repository.listSliceJobs(saved.projectId);
    set({ sliceJobs });
    return saved;
  },

  deleteSliceJobRecord: async (jobId, projectId) => {
    await repository.deleteSliceJob(jobId);
    const sliceJobs = await repository.listSliceJobs(projectId);
    set({ sliceJobs });
  },

  refreshAgentCheckpoints: async (projectId) => {
    const agentCheckpoints = await repository.listAgentCheckpoints(projectId);
    set({ agentCheckpoints });
  },

  refreshSyncTarget: async (projectId) => {
    const target = await repository.getSyncTarget(projectId);
    set({ syncTarget: target ?? null });
  },

  refreshVaultItems: async () => {
    const vaultItems = await repository.listVaultItems();
    set({ vaultItems });
  },

  deleteVaultItemRecord: async (vaultItemId) => {
    await repository.deleteVaultItem(vaultItemId);
    const vaultItems = await repository.listVaultItems();
    set({ vaultItems });
  },

  promoteSpriteToVault: async (node, options) => {
    const saved = await repository.promoteSpriteNodeToVault(node, {
      ...options,
      sourceProjectName: options?.sourceProjectName ?? get().activeProject?.name,
    });
    const vaultItems = await repository.listVaultItems();
    set({ vaultItems });
    return saved;
  },

  promoteShaderToVault: async (name, shaderConfig, options) => {
    const saved = await repository.promoteShaderToVault(name, shaderConfig, {
      ...options,
      sourceProjectName: options?.sourceProjectName ?? get().activeProject?.name,
    });
    const vaultItems = await repository.listVaultItems();
    set({ vaultItems });
    return saved;
  },

  importVaultItemToActiveProject: async (vaultItemId, options) => {
    const activeProject = get().activeProject;
    if (!activeProject) {
      throw new Error('Select or open a project before importing from the Global Vault.');
    }
    const result = await repository.importVaultItemToProject(
      vaultItemId,
      activeProject.id,
      options,
    );
    const [spriteNodes, audioAssets, projects, updatedProject] = await Promise.all([
      repository.listSpriteNodes(activeProject.id),
      repository.listAudioAssets(activeProject.id),
      repository.listProjectsWithCounts(),
      repository.getProject(activeProject.id),
    ]);
    set({
      spriteNodes,
      audioAssets,
      projects,
      ...(updatedProject ? { activeProject: updatedProject } : {}),
    });
    return result;
  },
}));
