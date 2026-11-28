import type { ScreenRoute } from '../../store/useAppStore';

export type WorkspaceId = 'style-vision' | 'cast-world' | 'play-tune' | 'ship-godot';

export interface WorkspaceShellMeta {
  readonly id: WorkspaceId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly defaultScreen: Exclude<ScreenRoute['screen'], 'hub' | 'vault' | 'inspector'>;
  readonly memberScreens: readonly ScreenRoute['screen'][];
}

export const WORKSPACE_SHELL_ITEMS: readonly WorkspaceShellMeta[] = [
  {
    id: 'style-vision',
    label: '1. Style & Vision',
    shortLabel: 'Style & Vision',
    description: 'Director Studio, ArtBible, Golden References, Bitmap Font & UI Theme.',
    defaultScreen: 'director',
    memberScreens: ['director', 'bible'],
  },
  {
    id: 'cast-world',
    label: '2. Cast & World',
    shortLabel: 'Cast & World',
    description: 'Sprites, Entities, Lighting, Rooms, World Map, Dialogue & Audio.',
    defaultScreen: 'studio',
    memberScreens: [
      'studio',
      'inspector',
      'entities',
      'world',
      'dialogue',
      'audio',
      'atlas',
      'audit',
    ],
  },
  {
    id: 'play-tune',
    label: '3. Play & Tune',
    shortLabel: 'Play & Tune',
    description: 'Data Foundry, Monte Carlo Balance Lab & 60 Hz Playtest.',
    defaultScreen: 'data',
    memberScreens: ['data'],
  },
  {
    id: 'ship-godot',
    label: '4. Ship to Godot',
    shortLabel: 'Ship to Godot',
    description: 'Turnkey Godot 4 GameKit, live res:// sync & EditorPlugin.',
    defaultScreen: 'ship',
    memberScreens: ['ship'],
  },
];

/**
 * Resolves which of the 4 top-level intent-driven workspaces owns `screen`.
 */
export function resolveWorkspaceForScreen(screen: ScreenRoute['screen']): WorkspaceId {
  for (const item of WORKSPACE_SHELL_ITEMS) {
    if (item.memberScreens.includes(screen)) {
      return item.id;
    }
  }
  return 'cast-world';
}
