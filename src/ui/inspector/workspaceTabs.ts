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
};

export const ALL_INSPECTOR_TABS: readonly InspectorTab[] = [
  'postprocess',
  'normal',
  'puppet',
  'sockets',
  'vfx-baker',
  'tile-slice',
  'autotile',
  'parallax',
  'palette-lut',
  'collider',
  'sandbox',
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
      primary = ['postprocess', 'tile-slice', 'autotile', 'parallax', 'normal', 'palette-lut'];
      break;
    case 'ui-panel':
      primary = ['postprocess', 'tile-slice', 'palette-lut'];
      break;
    case 'vfx':
      primary = ['postprocess', 'vfx-baker', 'puppet', 'sockets', 'palette-lut', 'sandbox'];
      break;
    case 'character':
    default:
      primary = [
        'postprocess',
        'normal',
        'puppet',
        'sockets',
        'collider',
        'palette-lut',
        'sandbox',
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
