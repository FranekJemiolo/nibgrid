import { describe, expect, it } from 'vitest';
import type { AssetClass } from '../../src/domain/schemas';
import { rankCommands, type CommandItem } from '../../src/ui/command/commandRegistry';
import {
  ALL_INSPECTOR_TABS,
  inferAssetClass,
  resolveInspectorTabs,
} from '../../src/ui/inspector/workspaceTabs';
import { computeScrubbedValue, formatScrubValue } from '../../src/ui/primitives/scrubMath';

describe('M19A: ScrubInput pure-TS math', () => {
  it('computes quantized scrub increments and clamps cleanly within [min, max]', () => {
    expect(
      computeScrubbedValue({
        value: 50,
        deltaPx: 40,
        step: 1,
        min: 0,
        max: 100,
      }),
    ).toBe(60);

    expect(
      computeScrubbedValue({
        value: 95,
        deltaPx: 100,
        step: 1,
        min: 0,
        max: 100,
      }),
    ).toBe(100);

    expect(
      computeScrubbedValue({
        value: 5,
        deltaPx: -100,
        step: 1,
        min: 0,
        max: 100,
      }),
    ).toBe(0);
  });

  it('applies 0.1x precision step in Shift fineMode without floating-point drift', () => {
    const coarse = computeScrubbedValue({
      value: 0.2,
      deltaPx: 40,
      step: 0.02,
      min: 0,
      max: 1,
      fineMode: false,
    });
    expect(coarse).toBe(0.4);

    const fine = computeScrubbedValue({
      value: 0.2,
      deltaPx: 40,
      step: 0.02,
      min: 0,
      max: 1,
      fineMode: true,
    });
    expect(fine).toBe(0.22);

    const exactIntegerFine = computeScrubbedValue({
      value: 16,
      deltaPx: 80,
      step: 1,
      min: 0,
      max: 255,
      fineMode: true,
      decimals: 0,
    });
    expect(exactIntegerFine).toBe(18);
  });

  it('guards non-finite inputs and negative zero', () => {
    expect(
      computeScrubbedValue({
        value: Number.NaN,
        deltaPx: 0,
        step: 0.1,
        min: 0,
        max: 10,
      }),
    ).toBe(0);

    const zero = computeScrubbedValue({
      value: 0,
      deltaPx: 0,
      step: 0.1,
      min: -1,
      max: 1,
    });
    expect(Object.is(zero, -0)).toBe(false);
    expect(formatScrubValue(0.25, 2, 'px')).toBe('0.25 px');
  });
});

describe('M19B: Asset-type-aware inspector tab resolution', () => {
  const classes: readonly AssetClass[] = ['character', 'prop', 'tile', 'ui-panel', 'vfx'];

  it('partitions all inspector tabs cleanly with zero duplicates across all 5 asset classes', () => {
    for (const cls of classes) {
      const { primary, overflow } = resolveInspectorTabs(cls, false);
      const union = [...primary, ...overflow];
      expect(new Set(union).size).toBe(ALL_INSPECTOR_TABS.length);
      expect(union.sort()).toEqual([...ALL_INSPECTOR_TABS].sort());
      expect(primary[0]).toBe('postprocess');
    }
  });

  it('collapses ui-panel strictly to 3 primary tabs and promotes turnaround for sheets', () => {
    const uiTabs = resolveInspectorTabs('ui-panel', false);
    expect(uiTabs.primary).toEqual(['postprocess', 'tile-slice', 'palette-lut']);
    expect(uiTabs.overflow.length).toBe(ALL_INSPECTOR_TABS.length - 3);

    const sheetTabs = resolveInspectorTabs('character', true);
    expect(sheetTabs.primary[0]).toBe('postprocess');
    expect(sheetTabs.primary[1]).toBe('turnaround');
    expect(sheetTabs.overflow).not.toContain('turnaround');
  });

  it('infers assetClass accurately from explicit value or enabled tile/slice flags', () => {
    expect(inferAssetClass(undefined)).toBe('character');
    expect(inferAssetClass({ assetClass: 'vfx' })).toBe('vfx');
    expect(inferAssetClass({ nineSlice: { enabled: true } as never })).toBe('ui-panel');
    expect(inferAssetClass({ seamlessTile: { isSeamlessTile: true } as never })).toBe('tile');
    expect(
      inferAssetClass({
        assetClass: 'prop',
        nineSlice: { enabled: true } as never,
      }),
    ).toBe('prop');
  });
});

describe('M19C: Command Palette fuzzy/prefix ranking', () => {
  const sampleItems: CommandItem[] = [
    {
      id: 'nav-hub',
      title: 'Projects Hub',
      category: 'navigation',
      execute: () => {},
    },
    {
      id: 'act-sandbox',
      title: 'Open 1× Game Scale Sandbox',
      subtitle: 'Biome preview and contrast audit',
      category: 'action',
      keywords: ['sandbox', 'biome'],
      execute: () => {},
    },
    {
      id: 'act-auto-trace',
      title: 'Auto-Trace Convex Hull',
      subtitle: 'Collider & Hitbox geometry',
      category: 'action',
      keywords: ['collider', 'physics'],
      execute: () => {},
    },
    {
      id: 'asset-knight',
      title: 'Armored Knight Idle',
      subtitle: 'Sprite generation · seed #42',
      category: 'asset',
      keywords: ['sprite', 'character'],
      execute: () => {},
    },
  ];

  it('ranks "Auto-Trace Convex Hull" #1 for "trc hull"', () => {
    const ranked = rankCommands('trc hull', sampleItems);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]?.id).toBe('act-auto-trace');
  });

  it('preserves default order on empty query and matches project assets accurately', () => {
    expect(rankCommands('   ', sampleItems).map((i) => i.id)).toEqual(sampleItems.map((i) => i.id));
    const assetMatch = rankCommands('knight 42', sampleItems);
    expect(assetMatch).toHaveLength(1);
    expect(assetMatch[0]?.id).toBe('asset-knight');
  });
});
