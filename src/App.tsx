import { useState } from 'react';
import { FolderKanban, KeyRound, Layers, ShieldCheck } from 'lucide-react';

type ActiveSection = 'projects' | 'vault';

export function App() {
  const [activeSection, setActiveSection] = useState<ActiveSection>('projects');

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100">
      <header
        data-testid="app-header"
        className="flex h-14 items-center justify-between border-b border-slate-800 bg-slate-900/90 px-4 backdrop-blur"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400 ring-1 ring-indigo-500/40">
            <Layers className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-slate-100">Nibgrid</h1>
            <p className="text-[11px] text-slate-400">Local-First Style-Locked 2D Sprite Studio</p>
          </div>
        </div>

        <nav className="flex items-center gap-2" aria-label="Primary navigation">
          <button
            type="button"
            data-testid="nav-projects"
            onClick={() => setActiveSection('projects')}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeSection === 'projects'
                ? 'bg-indigo-600 text-white'
                : 'text-slate-300 hover:bg-slate-800 hover:text-white'
            }`}
          >
            <FolderKanban className="h-3.5 w-3.5" />
            Projects
          </button>
          <button
            type="button"
            data-testid="nav-provider-vault"
            onClick={() => setActiveSection('vault')}
            className={`inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
              activeSection === 'vault'
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

      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-6">
        {activeSection === 'projects' ? (
          <section
            data-testid="projects-shell"
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-6"
          >
            <h2 className="text-base font-semibold text-slate-100">Project Hub</h2>
            <p className="mt-1 text-sm text-slate-400">
              Studio shell initialized. IndexedDB project persistence and Art Bible editor unlock in
              Milestone 1.
            </p>
          </section>
        ) : (
          <section
            data-testid="vault-shell"
            className="rounded-xl border border-slate-800 bg-slate-900/60 p-6"
          >
            <h2 className="text-base font-semibold text-slate-100">Provider Vault</h2>
            <p className="mt-1 text-sm text-slate-400">
              Local-only BYOK/BYOM configuration vault. IndexedDB storage and Offline Mock Provider
              registration unlock in Milestone 1.
            </p>
          </section>
        )}
      </main>
    </div>
  );
}
