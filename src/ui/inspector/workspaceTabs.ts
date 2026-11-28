import type { AssetClass, SpriteNode } from '../../domain/schemas';
import type { InspectorTab } from '../../store/useAppStore';

export interface InspectorTabMeta {
  readonly id: InspectorTab;
  readonly label: string;
  readonly shortLabel: string;
  readonly testId: string;
}

export const INSPECTOR_TAB_META: Record<InspectorTab, InspectorTabMeta> = {
  postprocess: {
    id: 'postprocess',
    label: 'Post-Process',
    shortLabel: 'Polish',
    testId: 'inspector-tab-postprocess',
  },
  turnaround: {
    id: 'turnaround',
    label: 'Turnaround Slicer',
    shortLabel: 'Turnaround',
    testId: 'inspector-tab-turnaround',
  },
  normal: {
    id: 'normal',
    label: '2D Lighting & Normal Map',
    shortLabel: 'Normal',
    testId: 'inspector-tab-normal',
  },
  puppet: {
    id: 'puppet',
    label: 'Puppet Warp Animator',
    shortLabel: 'Animate',
    testId: 'inspector-tab-puppet',
  },
  pose: {
    id: 'pose',
    label: 'Pose Keyframer (AI)',
    shortLabel: 'Pose Rig',
    testId: 'inspector-tab-pose',
  },
  sockets: {
    id: 'sockets',
    label: 'Attachment Sockets',
    shortLabel: 'Sockets',
    testId: 'inspector-tab-sockets',
  },
  'vfx-baker': {
    id: 'vfx-baker',
    label: 'VFX Baker',
    shortLabel: 'VFX',
    testId: 'inspector-tab-vfx-baker',
  },
  'tile-slice': {
    id: 'tile-slice',
    label: 'Tile & 9-Slice',
    shortLabel: 'Tile & 9-Slice',
    testId: 'inspector-tab-tile-slice',
  },
  autotile: {
    id: 'autotile',
    label: 'Auto-Tile',
    shortLabel: 'Auto-Tile',
    testId: 'inspector-tab-autotile',
  },
  parallax: {
    id: 'parallax',
    label: 'Parallax BG',
    shortLabel: 'Parallax',
    testId: 'inspector-tab-parallax',
  },
  room: {
    id: 'room',
    label: 'Room & Encounter Prototyper',
    shortLabel: 'Room Builder',
    testId: 'inspector-tab-room',
  },
  'world-map': {
    id: 'world-map',
    label: 'World Map & Softlock Auditor',
    shortLabel: 'World Map',
    testId: 'inspector-tab-world-map',
  },
  'data-foundry': {
    id: 'data-foundry',
    label: 'Game Data Foundry & Balance Lab',
    shortLabel: 'Data Foundry',
    testId: 'inspector-tab-data-foundry',
  },
  'dialogue-l10n': {
    id: 'dialogue-l10n',
    label: 'Dialogue & Localization Studio',
    shortLabel: 'Dialogue & L10n',
    testId: 'inspector-tab-dialogue-l10n',
  },
  'ship-godot': {
    id: 'ship-godot',
    label: 'Ship to Godot (GameKit)',
    shortLabel: 'Ship to Godot',
    testId: 'inspector-tab-ship-godot',
  },
  bmfont: {
    id: 'bmfont',
    label: 'Bitmap Font',
    shortLabel: 'BMFont',
    testId: 'inspector-tab-bmfont',
  },
  uikit: {
    id: 'uikit',
    label: 'Godot 4 UI Kit & Theme',
    shortLabel: 'UI Kit',
    testId: 'inspector-tab-uikit',
  },
  'palette-lut': {
    id: 'palette-lut',
    label: 'Palette-Swap & LUT',
    shortLabel: 'Palette LUT',
    testId: 'inspector-tab-palette-lut',
  },
  collider: {
    id: 'collider',
    label: 'Collider & Hitbox',
    shortLabel: 'Collider',
    testId: 'inspector-tab-collider',
  },
  sandbox: {
    id: 'sandbox',
    label: 'Game Sandbox',
    shortLabel: 'Sandbox',
    testId: 'inspector-tab-sandbox',
  },
  shader: {
    id: 'shader',
    label: 'Godot 4 Shader Studio',
    shortLabel: 'Shader Studio',
    testId: 'inspector-tab-shader',
  },
};

export const ALL_INSPECTOR_TABS: readonly InspectorTab[] = [
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
  'ship-godot',
  'bmfont',
  'uikit',
  'palette-lut',
  'collider',
  'sandbox',
  'shader',
  'turnaround',
];

export const ASSET_CLASS_OPTIONS: readonly { value: AssetClass; label: string }[] = [
  { value: 'character', label: 'Character' },
  { value: 'prop', label: 'Prop' },
  { value: 'tile', label: 'Tile / Terrain' },
  { value: 'ui-panel', label: 'UI Panel' },
  { value: 'vfx', label: 'VFX' },
];

export function inferAssetClass(
  node?: Pick<SpriteNode, 'assetClass' | 'nineSlice' | 'seamlessTile'>,
): AssetClass {
  if (node?.assetClass) return node.assetClass;
  if (node?.nineSlice?.enabled) return 'ui-panel';
  if (node?.seamlessTile?.isSeamlessTile) return 'tile';
  return 'character';
}

export function resolveInspectorTabs(
  assetClass: AssetClass,
  isTurnaroundSheet: boolean,
): { primary: InspectorTab[]; overflow: InspectorTab[] } {
  let primary: InspectorTab[];
  switch (assetClass) {
    case 'prop':
      primary = ['postprocess', 'normal', 'sockets', 'collider', 'palette-lut', 'sandbox'];
      break;
    case 'tile':
      primary = [
        'postprocess',
        'tile-slice',
        'autotile',
        'parallax',
        'room',
        'normal',
        'palette-lut',
      ];
      break;
    case 'ui-panel':
      primary = ['postprocess', 'tile-slice', 'bmfont', 'uikit', 'palette-lut'];
      break;
    case 'vfx':
      primary = [
        'postprocess',
        'vfx-baker',
        'shader',
        'puppet',
        'sockets',
        'palette-lut',
        'sandbox',
      ];
      break;
    case 'character':
    default:
      primary = [
        'postprocess',
        'normal',
        'puppet',
        'pose',
        'sockets',
        'collider',
        'palette-lut',
        'sandbox',
        'shader',
      ];
      break;
  }

  if (isTurnaroundSheet && !primary.includes('turnaround')) {
    primary = ['postprocess', 'turnaround', ...primary.slice(1)];
  }

  const primarySet = new Set(primary);
  const overflow = ALL_INSPECTOR_TABS.filter((tab) => !primarySet.has(tab));
  return { primary, overflow };
}
