import { create } from 'zustand';

export type UxMode = 'creator' | 'pro';
export type CreatorPresetId = 'crisp-16bit' | 'cozy-handdrawn' | 'dynamic-torchlight';
export type ContextTargetKind = 'entity' | 'door' | 'ui' | 'tile' | 'sprite';

export interface ProTechnicalDefaults {
  readonly sobelBevelStrength: number;
  readonly rdpEpsilonPx: number;
}

export interface ContextualSelection {
  readonly kind: ContextTargetKind;
  readonly id: string;
  readonly label: string;
}

export interface CreatorPresetMeta {
  readonly id: CreatorPresetId;
  readonly title: string;
  readonly summary: string;
  readonly defaultFilterMode: 'pixel-art' | 'hand-drawn';
  readonly enableNormalLighting: boolean;
}

export const CURATED_CREATOR_PRESETS: readonly CreatorPresetMeta[] = [
  {
    id: 'crisp-16bit',
    title: 'Crisp 16-bit Pixel Art',
    summary: 'Integer nearest-neighbor scaling, OKLab ArtBible palette snap, clean 1px outlines.',
    defaultFilterMode: 'pixel-art',
    enableNormalLighting: false,
  },
  {
    id: 'cozy-handdrawn',
    title: 'Cozy Hand-Drawn',
    summary: 'Soft warm paper contrast, gentle anti-aliasing, organic 2D silhouette edges.',
    defaultFilterMode: 'hand-drawn',
    enableNormalLighting: false,
  },
  {
    id: 'dynamic-torchlight',
    title: 'Dynamic 2D Torchlight',
    summary: 'Pixel-locked diffuse + Sobel normal maps + LightOccluder2D PointLight2D punch.',
    defaultFilterMode: 'pixel-art',
    enableNormalLighting: true,
  },
];

const STORAGE_KEY = 'nibgrid.uxMode';

function readStoredMode(): UxMode {
  if (typeof window === 'undefined') return 'creator';
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === 'pro' ? 'pro' : 'creator';
  } catch {
    return 'creator';
  }
}

function persistMode(mode: UxMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // Ignore storage failures in restricted contexts
  }
}

interface UxModeState {
  mode: UxMode;
  activePresetId: CreatorPresetId;
  selectedContext: ContextualSelection | null;
  proDefaults: ProTechnicalDefaults;
  setMode: (mode: UxMode) => void;
  toggleMode: () => void;
  setActivePresetId: (presetId: CreatorPresetId) => void;
  setSelectedContext: (ctx: ContextualSelection | null) => void;
  setProDefaults: (patch: Partial<ProTechnicalDefaults>) => void;
}

export const useUxModeStore = create<UxModeState>((set, get) => ({
  mode: readStoredMode(),
  activePresetId: 'crisp-16bit',
  selectedContext: null,
  proDefaults: {
    sobelBevelStrength: 2.0,
    rdpEpsilonPx: 1.25,
  },
  setMode: (mode) => {
    persistMode(mode);
    set({ mode });
  },
  toggleMode: () => {
    const next: UxMode = get().mode === 'creator' ? 'pro' : 'creator';
    persistMode(next);
    set({ mode: next });
  },
  setActivePresetId: (activePresetId) => set({ activePresetId }),
  setSelectedContext: (selectedContext) => set({ selectedContext }),
  setProDefaults: (patch) =>
    set((state) => ({
      proDefaults: {
        ...state.proDefaults,
        ...patch,
      },
    })),
}));
