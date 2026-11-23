import { useEffect } from 'react';
import {
  BookOpen,
  FolderKanban,
  Grid2X2,
  KeyRound,
  Layers,
  Paintbrush,
  ShieldCheck,
} from 'lucide-react';
import { parseHashRoute, useAppStore } from './store/useAppStore';
import { AtlasWorkshop } from './ui/atlas/AtlasWorkshop';
import { ArtBibleEditor } from './ui/bible/ArtBibleEditor';
import { ProjectHub } from './ui/hub/ProjectHub';
import { ProviderVaultModal } from './ui/hub/ProviderVaultModal';
import { PostProcessInspector } from './ui/inspector/PostProcessInspector';
import { SpriteStudio } from './ui/studio/SpriteStudio';

export function App() {
  const {
    route,
    activeProject,
    vaultOpen,
    isLoading,
    errorMessage,
    initialize,
    navigate,
    setVaultOpen,
    clearError,
  } = useAppStore();

  useEffect(() => {
    void initialize();
    const handleHashChange = () => {
      void navigate(parseHashRoute(window.location.hash));
    };
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, [initialize, navigate]);

  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden bg-slate-950 text-slate-100">
      <header
        data-testid="app-header"
        className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-900/90 px-4 backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => void navigate({ screen: 'hub' })}
            className="flex items-center gap-3 text-left"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/40">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h1 className="text-sm font-semibold tracking-wide text-slate-100">Nibgrid</h1>
              <p className="text-[11px] text-slate-400">
                Local-First Style-Locked 2D Sprite Studio
              </p>
            </div>
          </button>
        </div>

        <nav className="flex items-center gap-2" aria-label="Primary navigation">
          <button
            type="button"
            data-testid="nav-projects"
            onClick={() => void navigate({ screen: 'hub' })}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              route.screen === 'hub'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
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
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  route.screen === 'bible'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <BookOpen className="h-3.5 w-3.5" />
                Art Bible
              </button>
              <button
                type="button"
                data-testid="nav-sprite-studio"
                onClick={() => void navigate({ screen: 'studio', projectId: activeProject.id })}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  route.screen === 'studio' || route.screen === 'inspector'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Paintbrush className="h-3.5 w-3.5" />
                Sprite Studio
              </button>
              <button
                type="button"
                data-testid="nav-atlas-workshop"
                onClick={() => void navigate({ screen: 'atlas', projectId: activeProject.id })}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  route.screen === 'atlas'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800 hover:text-white'
                }`}
              >
                <Grid2X2 className="h-3.5 w-3.5" />
                Atlas Packer
              </button>
            </>
          )}

          <button
            type="button"
            data-testid="nav-provider-vault"
            onClick={() => setVaultOpen(!vaultOpen)}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              vaultOpen
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <KeyRound className="h-3.5 w-3.5" />
            Provider Vault
          </button>
        </nav>

        <div className="hidden items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] font-medium text-emerald-300 sm:inline-flex">
          <ShieldCheck className="h-3.5 w-3.5" />
          <span>100% Client-Side</span>
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
          <PostProcessInspector nodeId={route.nodeId} />
        ) : route.screen === 'atlas' ? (
          <AtlasWorkshop />
        ) : (
          <SpriteStudio />
        )}
      </main>

      <ProviderVaultModal />
    </div>
  );
}
