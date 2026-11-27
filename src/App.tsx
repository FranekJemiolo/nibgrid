import { useEffect, useState } from 'react';
import {
  Archive,
  BookOpen,
  Boxes,
  ClipboardCheck,
  Command,
  FolderKanban,
  Grid2X2,
  KeyRound,
  Layers,
  Music,
  Paintbrush,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { parseHashRoute, useAppStore } from './store/useAppStore';
import { AtlasWorkshop } from './ui/atlas/AtlasWorkshop';
import { AudioFoundry } from './ui/audio/AudioFoundry';
import { AuditMatrixView } from './ui/audit/AuditMatrixView';
import { VerticalSliceWizard } from './ui/autopilot/VerticalSliceWizard';
import { ArtBibleEditor } from './ui/bible/ArtBibleEditor';
import { CommandPalette } from './ui/command/CommandPalette';
import { UniversalDropOverlay } from './ui/command/UniversalDropOverlay';
import { EntityHubView } from './ui/entities/EntityHubView';
import { GodotSyncPill } from './ui/entities/GodotSyncPill';
import { ProjectHub } from './ui/hub/ProjectHub';
import { ProviderVaultModal } from './ui/hub/ProviderVaultModal';
import { PostProcessInspector } from './ui/inspector/PostProcessInspector';
import { P2pTransferModal } from './ui/share/P2pTransferModal';
import { ShareRecipeModal } from './ui/share/ShareRecipeModal';
import { SpriteStudio } from './ui/studio/SpriteStudio';
import { VaultAndBrowserView } from './ui/vault/VaultAndBrowserView';

export function App() {
  const {
    route,
    activeProject,
    vaultOpen,
    p2pOpen,
    outgoingShareRecipe,
    isLoading,
    errorMessage,
    initialize,
    navigate,
    setVaultOpen,
    setP2pOpen,
    setAutopilotOpen,
    closeShareModal,
    clearError,
  } = useAppStore();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    void initialize();
    const handleHashChange = () => {
      void navigate(parseHashRoute(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [initialize, navigate]);

  const navButtonClass = (active: boolean) =>
    `inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
      active
        ? 'bg-[var(--accent-primary)]/15 text-[#F5B82E] ring-1 ring-[var(--accent-primary)]/45'
        : 'text-slate-300 hover:bg-slate-800 hover:text-white'
    }`;

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-[var(--bg-well)] text-[var(--text-primary)]">
      <header
        data-testid="app-header"
        className="flex h-12 items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-panel)] px-3 sm:px-4"
      >
        <div className="flex shrink-0 items-center gap-2.5">
          <button
            type="button"
            onClick={() => void navigate({ screen: 'hub' })}
            className="flex items-center gap-2.5 text-left"
          >
            <div className="flex h-7 w-7 items-center justify-center rounded-md bg-[var(--accent-primary)]/15 text-[var(--accent-primary)] ring-1 ring-[var(--accent-primary)]/40">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide text-[var(--text-primary)]">
                Nibgrid
              </h1>
              <p className="hidden text-[10px] text-[var(--text-muted)] xl:block">
                Local-First 2D Asset Foundry
              </p>
            </div>
          </button>
        </div>

        <nav
          className="flex min-w-0 items-center gap-1 overflow-x-auto"
          aria-label="Primary navigation"
        >
          <button
            type="button"
            data-testid="nav-projects"
            onClick={() => void navigate({ screen: 'hub' })}
            className={navButtonClass(route.screen === 'hub')}
          >
            <FolderKanban className="h-3.5 w-3.5" />
            Projects
          </button>

          {activeProject && (
            <>
              <button
                type="button"
                data-testid="nav-art-bible"
                onClick={() => void navigate({ screen: 'bible', projectId: activeProject.id })}
                className={navButtonClass(route.screen === 'bible')}
              >
                <BookOpen className="h-3.5 w-3.5" />
                Art Bible
              </button>
              <button
                type="button"
                data-testid="nav-sprite-studio"
                onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
                className={navButtonClass(
                  route.screen === 'studio' || route.screen === 'inspector',
                )}
              >
                <Paintbrush className="h-3.5 w-3.5" />
                Sprite Studio
              </button>
              <button
                type="button"
                data-testid="nav-atlas-workshop"
                onClick={() => void navigate({ screen: 'atlas', projectId: activeProject.id })}
                className={navButtonClass(route.screen === 'atlas')}
              >
                <Grid2X2 className="h-3.5 w-3.5" />
                Atlas Packer
              </button>
              <button
                type="button"
                data-testid="nav-audio-foundry"
                onClick={() => void navigate({ screen: 'audio', projectId: activeProject.id })}
                className={navButtonClass(route.screen === 'audio')}
              >
                <Music className="h-3.5 w-3.5" />
                Audio Foundry
              </button>
              <button
                type="button"
                data-testid="nav-audit-matrix"
                onClick={() => void navigate({ screen: 'audit', projectId: activeProject.id })}
                className={navButtonClass(route.screen === 'audit')}
              >
                <ClipboardCheck className="h-3.5 w-3.5" />
                Audit
              </button>
              <button
                type="button"
                data-testid="nav-entities"
                onClick={() => void navigate({ screen: 'entities', projectId: activeProject.id })}
                className={navButtonClass(route.screen === 'entities')}
              >
                <Boxes className="h-3.5 w-3.5" />
                Entities
              </button>
            </>
          )}

          <button
            type="button"
            data-testid="nav-vertical-slice-btn"
            onClick={() => setAutopilotOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-500/20"
            title="Vertical Slice Autopilot (Single-Prompt Game Builder)"
          >
            <Sparkles className="h-3.5 w-3.5" />+ Vertical Slice
          </button>

          <button
            type="button"
            data-testid="nav-asset-vault"
            onClick={() =>
              void navigate({
                screen: 'vault',
                ...(activeProject ? { projectId: activeProject.id } : {}),
              })
            }
            className={navButtonClass(route.screen === 'vault')}
          >
            <Archive className="h-3.5 w-3.5" />
            Vault
          </button>

          <button
            type="button"
            data-testid="nav-provider-vault"
            onClick={() => setVaultOpen(!vaultOpen)}
            className={navButtonClass(vaultOpen)}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Provider Vault
          </button>

          <button
            type="button"
            data-testid="nav-command-palette-btn"
            onClick={() => setPaletteOpen(true)}
            className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-2 py-1 text-[11px] font-medium text-slate-300 hover:border-slate-500 hover:text-white"
            title="Command Palette (Cmd/Ctrl+K)"
          >
            <Command className="h-3 w-3 text-[var(--accent-primary)]" />
            <span className="font-mono text-[10px]">⌘K</span>
          </button>
        </nav>

        <div className="flex shrink-0 items-center gap-2">
          {activeProject && <GodotSyncPill />}
          <div className="hidden shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 2xl:inline-flex">
            <ShieldCheck className="h-3.5 w-3.5" />
            <span>100% Client-Side</span>
          </div>
        </div>
      </header>

      {errorMessage && (
        <div className="mx-auto mt-4 flex w-full max-w-6xl items-center justify-between rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-xs text-rose-200">
          <span>{errorMessage}</span>
          <button type="button" onClick={clearError} className="underline hover:text-white">
            Dismiss
          </button>
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        {isLoading ? (
          <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
            Loading local IndexedDB workspace...
          </div>
        ) : route.screen === 'hub' ? (
          <ProjectHub />
        ) : route.screen === 'bible' ? (
          <ArtBibleEditor />
        ) : route.screen === 'inspector' ? (
          <PostProcessInspector
            nodeId={route.nodeId}
            initialTab={route.initialTab}
            initialPixelTool={route.initialPixelTool}
          />
        ) : route.screen === 'atlas' ? (
          <AtlasWorkshop />
        ) : route.screen === 'audio' ? (
          <AudioFoundry />
        ) : route.screen === 'audit' ? (
          <AuditMatrixView />
        ) : route.screen === 'entities' ? (
          <EntityHubView />
        ) : route.screen === 'vault' ? (
          <VaultAndBrowserView />
        ) : (
          <SpriteStudio />
        )}
      </main>

      <ProviderVaultModal />
      <P2pTransferModal open={p2pOpen} onClose={() => setP2pOpen(false)} />
      <VerticalSliceWizard />
      <ShareRecipeModal outgoingRecipe={outgoingShareRecipe} onCloseOutgoing={closeShareModal} />
      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
      <UniversalDropOverlay />
    </div>
  );
}
