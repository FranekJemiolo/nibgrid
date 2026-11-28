import { describe, expect, it } from 'vitest';
import { useUxModeStore } from '../../src/state/uxModeStore';
import { ALL_INSPECTOR_TABS, resolveInspectorTabs } from '../../src/ui/inspector/workspaceTabs';

describe('M55: Creator/Pro UX Store & Decluttered Inspector Tabs', () => {
  it('stores and patches proDefaults cleanly in useUxModeStore', () => {
    const initial = useUxModeStore.getState();
    expect(initial.proDefaults.sobelBevelStrength).toBe(2.0);
    expect(initial.proDefaults.rdpEpsilonPx).toBe(1.25);

    initial.setProDefaults({ sobelBevelStrength: 3.25 });
    expect(useUxModeStore.getState().proDefaults).toEqual({
      sobelBevelStrength: 3.25,
      rdpEpsilonPx: 1.25,
    });

    initial.setProDefaults({ rdpEpsilonPx: 0.75 });
    expect(useUxModeStore.getState().proDefaults).toEqual({
      sobelBevelStrength: 3.25,
      rdpEpsilonPx: 0.75,
    });

    // Restore clean defaults
    initial.setProDefaults({ sobelBevelStrength: 2.0, rdpEpsilonPx: 1.25 });
  });

  it('keeps prop and tile primary tabs decluttered while preserving all 21 tabs across primary + overflow', () => {
    const propTabs = resolveInspectorTabs('prop', false);
    expect(propTabs.primary).toEqual([
      'postprocess',
      'normal',
      'sockets',
      'collider',
      'palette-lut',
      'sandbox',
    ]);
    expect(propTabs.overflow).toContain('data-foundry');
    expect(propTabs.overflow).toContain('dialogue-l10n');
    expect(propTabs.overflow).toContain('ship-godot');
    expect([...propTabs.primary, ...propTabs.overflow].sort()).toEqual(
      [...ALL_INSPECTOR_TABS].sort(),
    );

    const tileTabs = resolveInspectorTabs('tile', false);
    expect(tileTabs.primary).toEqual([
      'postprocess',
      'tile-slice',
      'autotile',
      'parallax',
      'room',
      'normal',
      'palette-lut',
    ]);
    expect(tileTabs.overflow).toContain('world-map');
    expect([...tileTabs.primary, ...tileTabs.overflow].sort()).toEqual(
      [...ALL_INSPECTOR_TABS].sort(),
    );
  });
});
