import { CheckCircle2, Circle } from 'lucide-react';
import { useAppStore, type ScreenRoute } from '../../store/useAppStore';

interface PipelineStage {
  readonly id: string;
  readonly label: string;
  readonly targetScreen: Exclude<ScreenRoute['screen'], 'hub' | 'vault' | 'inspector'>;
  readonly completed: boolean;
}

/**
 * Compact guided progression ribbon shown in Director Studio and Ship to Godot,
 * surfacing live completion state from IndexedDB across the 5 game-making stages.
 */
export function GamePipelineRibbon({ currentStageId }: { readonly currentStageId?: string }) {
  const {
    activeProject,
    spriteNodes,
    entities,
    rooms,
    worldGraph,
    gameDataRegistry,
    narrativeBundle,
    syncTarget,
    navigate,
  } = useAppStore();

  if (!activeProject) {
    return null;
  }

  const hasVision =
    activeProject.artBible.palette.length > 0 &&
    activeProject.artBible.stylePrompt.trim().length > 0;
  const hasCastAndWorld =
    spriteNodes.length > 0 && (entities.length > 0 || rooms.length > 0 || worldGraph !== null);
  const hasBalanceOrNarrative = gameDataRegistry !== null || narrativeBundle !== null;
  const hasPreFlightReady = hasCastAndWorld && hasBalanceOrNarrative;
  const hasSyncedGodot = syncTarget !== null && syncTarget.lastSyncedAt !== null;

  const stages: readonly PipelineStage[] = [
    {
      id: 'vision',
      label: '1. Vision & Style',
      targetScreen: 'director',
      completed: hasVision,
    },
    {
      id: 'cast-world',
      label: '2. Cast & World',
      targetScreen: 'studio',
      completed: hasCastAndWorld,
    },
    {
      id: 'balance',
      label: '3. Balance & L10n',
      targetScreen: 'data',
      completed: hasBalanceOrNarrative,
    },
    {
      id: 'qa',
      label: '4. Pre-Flight QA',
      targetScreen: 'audit',
      completed: hasPreFlightReady,
    },
    {
      id: 'ship',
      label: '5. Ship & Play F5',
      targetScreen: 'ship',
      completed: hasSyncedGodot,
    },
  ];

  return (
    <nav
      aria-label="Game creation pipeline"
      data-testid="game-pipeline-ribbon"
      className="flex flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 py-2 text-[11px]"
    >
      <span className="mr-1 font-semibold tracking-wider text-slate-400 uppercase">Game Path:</span>
      {stages.map((stage, idx) => {
        const isCurrent = currentStageId === stage.id;
        return (
          <div key={stage.id} className="flex items-center gap-1.5">
            {idx > 0 && <span className="text-slate-600">→</span>}
            <button
              type="button"
              data-testid={`pipeline-step-${stage.id}`}
              onClick={() =>
                void navigate({ screen: stage.targetScreen, projectId: activeProject.id })
              }
              className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium transition-colors ${
                isCurrent
                  ? 'border-indigo-400/60 bg-indigo-500/20 text-indigo-100'
                  : stage.completed
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:border-emerald-400'
                    : 'border-slate-800 bg-slate-900/70 text-slate-400 hover:border-slate-600 hover:text-slate-200'
              }`}
            >
              {stage.completed ? (
                <CheckCircle2 className="h-3 w-3 text-emerald-400" />
              ) : (
                <Circle className="h-3 w-3 text-slate-500" />
              )}
              <span>{stage.label}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
