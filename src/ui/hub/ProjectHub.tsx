import { useState, type FormEvent } from 'react';
import { BookOpen, FolderPlus, Layers, Paintbrush, Trash2 } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

const PROJECTION_LABELS: Record<string, string> = {
  'top-down': 'Top-Down',
  isometric: 'Isometric',
  'side-scroller': 'Side-Scroller',
  'three-quarter': 'Three-Quarter',
};

const ART_MODE_LABELS: Record<string, string> = {
  'pixel-art': 'Pixel Art',
  'hd-2d': 'HD-2D',
};

export function ProjectHub() {
  const { projects, createProject, deleteProject, navigate } = useAppStore();
  const [newName, setNewName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  const handleCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmed = newName.trim();
    if (!trimmed) {
      setFormError('Enter a project name before creating.');
      return;
    }
    setFormError(null);
    setIsCreating(true);
    try {
      const created = await createProject(trimmed);
      setNewName('');
      await navigate({ screen: 'bible', projectId: created.id });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Failed to create project.');
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div data-testid="project-hub" className="mx-auto flex w-full max-w-6xl flex-col gap-6 p-6">
      <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-6">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-center">
          <div>
            <h2 className="text-lg font-semibold text-slate-100">Project Hub</h2>
            <p className="mt-1 text-sm text-slate-400">
              Each project locks an Art Bible (projection, palette, golden style refs) and stores
              its full branching sprite DAG in IndexedDB.
            </p>
          </div>
          <form
            onSubmit={(e) => void handleCreate(e)}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              type="text"
              data-testid="new-project-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="New project name (e.g., Crypt Knight)"
              className="w-64 rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-indigo-500 focus:outline-none"
            />
            <button
              type="submit"
              data-testid="create-project-btn"
              disabled={isCreating}
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              <FolderPlus className="h-4 w-4" />
              New Project
            </button>
          </form>
        </div>
        {formError && <p className="mt-2 text-xs text-rose-400">{formError}</p>}
      </section>

      {projects.length === 0 ? (
        <div
          data-testid="empty-projects-state"
          className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 bg-slate-900/30 p-12 text-center"
        >
          <Layers className="h-10 w-10 text-slate-600" />
          <h3 className="mt-3 text-base font-medium text-slate-200">No sprite projects yet</h3>
          <p className="mt-1 max-w-md text-sm text-slate-400">
            Create your first project above to configure its Art Bible style lock and turn sketches
            into consistent 2D game sprites.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {projects.map(({ project, spriteCount }) => (
            <article
              key={project.id}
              data-testid={`project-card-${project.id}`}
              className="flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/70 p-5 transition-colors hover:border-slate-700"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-base font-semibold text-slate-100">{project.name}</h3>
                  <span className="shrink-0 rounded-full bg-slate-800 px-2.5 py-0.5 text-xs font-medium text-slate-300">
                    {spriteCount} {spriteCount === 1 ? 'node' : 'nodes'}
                  </span>
                </div>

                <div className="mt-2.5 flex flex-wrap gap-1.5 text-[11px]">
                  <span className="rounded border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-indigo-300">
                    {PROJECTION_LABELS[project.artBible.projection] ?? project.artBible.projection}
                  </span>
                  <span className="rounded border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-sky-300">
                    {ART_MODE_LABELS[project.artBible.artMode] ?? project.artBible.artMode}
                  </span>
                  <span className="rounded border border-slate-700 bg-slate-800/80 px-2 py-0.5 font-mono text-slate-300">
                    {project.artBible.targetWidth}×{project.artBible.targetHeight}
                  </span>
                </div>

                <div className="mt-4">
                  <div className="mb-1.5 flex items-center justify-between text-[11px] text-slate-400">
                    <span>Palette ({project.artBible.palette.length})</span>
                    <span>Refs ({project.artBible.goldenReferenceBlobIds.length}/3)</span>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {project.artBible.palette.length === 0 ? (
                      <span className="text-xs text-slate-500 italic">No swatches locked</span>
                    ) : (
                      project.artBible.palette
                        .slice(0, 12)
                        .map((hex) => (
                          <span
                            key={hex}
                            title={hex}
                            data-swatch={hex}
                            className="h-4 w-4 rounded-sm border border-slate-700"
                            style={{ backgroundColor: hex }}
                          />
                        ))
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-5 flex items-center gap-2 border-t border-slate-800 pt-4">
                <button
                  type="button"
                  data-testid={`open-bible-${project.id}`}
                  onClick={() => void navigate({ screen: 'bible', projectId: project.id })}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700"
                >
                  <BookOpen className="h-3.5 w-3.5" />
                  Art Bible
                </button>
                <button
                  type="button"
                  data-testid={`open-studio-${project.id}`}
                  onClick={() => void navigate({ screen: 'studio', projectId: project.id })}
                  className="inline-flex flex-1 items-center justify-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
                >
                  <Paintbrush className="h-3.5 w-3.5" />
                  Studio
                </button>
                <button
                  type="button"
                  data-testid={`delete-project-${project.id}`}
                  onClick={() => void deleteProject(project.id)}
                  className="rounded-md border border-rose-500/30 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20"
                  aria-label={`Delete ${project.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
