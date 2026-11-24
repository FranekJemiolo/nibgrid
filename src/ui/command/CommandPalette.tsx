import { useEffect, useMemo, useRef, useState } from 'react';
import { Command, CornerDownLeft, FileAudio, Image, Search, Sparkles } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { rankCommands, type CommandCategory, type CommandItem } from './commandRegistry';

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const CATEGORY_LABEL: Record<CommandCategory, string> = {
  action: 'Action',
  navigation: 'Navigate',
  asset: 'Asset',
};

export function CommandPalette({ open, onOpenChange }: CommandPaletteProps) {
  const { route, activeProject, spriteNodes, audioAssets, navigate, setVaultOpen } = useAppStore();

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement | null>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  // Global Cmd/Ctrl+K shortcut
  useEffect(() => {
    const handleGlobalKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener('keydown', handleGlobalKeyDown);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown);
  }, [open, onOpenChange]);

  // Capture/restore focus cleanly
  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement as HTMLElement | null;
      setQuery('');
      setSelectedIndex(0);
      window.setTimeout(() => {
        inputRef.current?.focus();
      }, 0);
      return;
    }
    const prev = previousFocusRef.current;
    if (prev && typeof prev.focus === 'function' && document.contains(prev)) {
      prev.focus();
    }
    previousFocusRef.current = null;
  }, [open]);

  const activeOrLatestNodeId =
    route.screen === 'inspector' ? route.nodeId : spriteNodes[spriteNodes.length - 1]?.id;

  const commands = useMemo<CommandItem[]>(() => {
    const list: CommandItem[] = [];

    if (activeProject && activeOrLatestNodeId) {
      const targetId = activeOrLatestNodeId;
      const projId = activeProject.id;
      list.push(
        {
          id: 'act-auto-trace-hull',
          title: 'Auto-Trace Convex Hull',
          subtitle: 'Open Screen 4G Collider & Hitbox Editor',
          category: 'action',
          keywords: ['trc', 'hull', 'collider', 'physics', 'hitbox', 'marching'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'collider',
            }),
        },
        {
          id: 'act-sandbox',
          title: 'Open 1× Game Scale Sandbox',
          subtitle: 'Test sprite & VFX against live biomes',
          category: 'action',
          keywords: ['biome', 'contrast', 'sandbox', 'hit-flash', '1x'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'sandbox',
            }),
        },
        {
          id: 'act-tile-slice',
          title: 'Open Seamless Tile & 9-Slice Workshop',
          subtitle: '50% wrap-offset healing and UI panel slicing',
          category: 'action',
          keywords: ['tile', 'seamless', '9-slice', 'ui'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'tile-slice',
            }),
        },
        {
          id: 'act-autotile',
          title: 'Open Auto-Tile Terrain Generator',
          subtitle: 'Blob-47 & Wang-16 tileset generator, Godot .tres, Tiled .tsx',
          category: 'action',
          keywords: ['autotile', 'blob', 'wang', 'godot', 'tiled', 'terrain'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'autotile',
            }),
        },
        {
          id: 'act-palette-lut',
          title: 'Open Palette-Swap & LUT Workshop',
          subtitle: 'OKLCH faction variants and GPU lookup strip',
          category: 'action',
          keywords: ['lut', 'palette', 'faction', 'color'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'palette-lut',
            }),
        },
        {
          id: 'act-normal',
          title: 'Open 2D Lighting & Normal Map',
          subtitle: 'Interactive point-light preview and normal export',
          category: 'action',
          keywords: ['normal', 'lighting', 'webgl2', 'bevel'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'normal',
            }),
        },
        {
          id: 'act-puppet',
          title: 'Open Puppet Warp Animator',
          subtitle: 'Real-time MLS mesh rigging and animation export',
          category: 'action',
          keywords: ['puppet', 'warp', 'animation', 'rig', 'gif'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'puppet',
            }),
        },
        {
          id: 'act-sockets',
          title: 'Open Attachment Sockets Editor',
          subtitle: 'Bind hand_r, muzzle & exhaust sockets to mesh deformation',
          category: 'action',
          keywords: ['socket', 'attachment', 'muzzle', 'hand_r', 'exhaust', 'marker2d'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'sockets',
            }),
        },
        {
          id: 'act-vfx-baker',
          title: 'Open 2D VFX Flipbook Baker',
          subtitle: 'Synthesize sparks, smoke, hit rings & noise dissolve particle sheets',
          category: 'action',
          keywords: ['vfx', 'particle', 'flipbook', 'sparks', 'smoke', 'dissolve', 'godot'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'vfx-baker',
            }),
        },
        {
          id: 'act-turnaround',
          title: 'Open Turnaround Slicer',
          subtitle: '4-view orthographic extraction and turntable preview',
          category: 'action',
          keywords: ['turnaround', 'sheet', 'slice', 'orthographic'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: targetId,
              initialTab: 'turnaround',
            }),
        },
      );
    }

    if (activeProject) {
      const projId = activeProject.id;
      list.push(
        {
          id: 'nav-audit',
          title: 'Project Asset Audit Matrix',
          subtitle: 'Check palette drift, mixel density, contrast, and batch fix',
          category: 'navigation',
          keywords: ['audit', 'batch', 'score', 'readiness'],
          execute: () => navigate({ screen: 'audit', projectId: projId }),
        },
        {
          id: 'nav-studio',
          title: 'Sprite Studio & Generation DAG',
          subtitle: 'Sketch pad, turnaround prompt mode, and variation tree',
          category: 'navigation',
          keywords: ['studio', 'sketch', 'generate', 'dag'],
          execute: () => navigate({ screen: 'studio', projectId: projId }),
        },
        {
          id: 'nav-bible',
          title: 'Art Bible Editor',
          subtitle: 'Style palette, lighting, projection, and golden references',
          category: 'navigation',
          keywords: ['bible', 'palette', 'style', 'reference'],
          execute: () => navigate({ screen: 'bible', projectId: projId }),
        },
        {
          id: 'nav-atlas',
          title: 'MaxRects Sprite Atlas Packer',
          subtitle: 'Pack sprite sheets for Godot, Phaser, and Unity',
          category: 'navigation',
          keywords: ['atlas', 'pack', 'spritesheet', 'maxrects'],
          execute: () => navigate({ screen: 'atlas', projectId: projId }),
        },
        {
          id: 'nav-audio',
          title: 'Audio Foundry & Hum-to-Sound',
          subtitle: 'Procedural SFX synth, Lyria, Gemini TTS, and mic sketch',
          category: 'navigation',
          keywords: ['audio', 'sfx', 'sound', 'hum', 'mic'],
          execute: () => navigate({ screen: 'audio', projectId: projId }),
        },
      );
    }

    list.push(
      {
        id: 'nav-hub',
        title: 'Projects Hub',
        subtitle: 'Switch or create a local Nibgrid project',
        category: 'navigation',
        keywords: ['projects', 'hub', 'home'],
        execute: () => navigate({ screen: 'hub' }),
      },
      {
        id: 'act-provider-vault',
        title: 'Open Provider Vault (BYOK / Bridge)',
        subtitle: 'Manage local bridges, ComfyUI, and API providers',
        category: 'action',
        keywords: ['provider', 'vault', 'api', 'key', 'bridge'],
        execute: () => setVaultOpen(true),
      },
    );

    if (activeProject) {
      const projId = activeProject.id;
      for (const node of spriteNodes) {
        const dirTag = node.turnaroundMeta?.cardinalDirection
          ? ` (${node.turnaroundMeta.cardinalDirection})`
          : '';
        list.push({
          id: `asset-sprite-${node.id}`,
          title: `${node.generationMeta.promptDelta || `${node.kind} #${node.generationMeta.seed}`}${dirTag}`,
          subtitle: `Sprite ${node.kind} · seed #${node.generationMeta.seed}`,
          category: 'asset',
          keywords: ['sprite', node.kind, node.assetClass ?? 'character'],
          execute: () =>
            navigate({
              screen: 'inspector',
              projectId: projId,
              nodeId: node.id,
            }),
        });
      }

      for (const clip of audioAssets) {
        list.push({
          id: `asset-audio-${clip.id}`,
          title: clip.name,
          subtitle: `Audio ${clip.route} · ${clip.durationSec.toFixed(2)}s`,
          category: 'asset',
          keywords: ['audio', clip.route, clip.presetId],
          execute: () => navigate({ screen: 'audio', projectId: projId }),
        });
      }
    }

    return list;
  }, [activeProject, activeOrLatestNodeId, spriteNodes, audioAssets, navigate, setVaultOpen]);

  const ranked = useMemo(() => rankCommands(query, commands), [query, commands]);
  const safeSelectedIdx =
    ranked.length === 0 ? -1 : Math.max(0, Math.min(ranked.length - 1, selectedIndex));

  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  if (!open) return null;

  const executeItem = (item: CommandItem) => {
    onOpenChange(false);
    void item.execute();
  };

  return (
    <div
      data-testid="command-palette"
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/70 px-4 pt-20 backdrop-blur-xs"
      onClick={() => onOpenChange(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-panel)] shadow-2xl"
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--border-hairline)] px-3.5 py-2.5">
          <Search className="h-4 w-4 text-[var(--text-muted)]" />
          <input
            ref={inputRef}
            type="text"
            data-testid="command-palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                onOpenChange(false);
              } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (ranked.length > 0) {
                  setSelectedIndex((idx) => (idx + 1) % ranked.length);
                }
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (ranked.length > 0) {
                  setSelectedIndex((idx) => (idx - 1 + ranked.length) % ranked.length);
                }
              } else if (e.key === 'Enter' && safeSelectedIdx >= 0) {
                e.preventDefault();
                const target = ranked[safeSelectedIdx];
                if (target) executeItem(target);
              }
            }}
            placeholder="Jump to screen, action, or asset (e.g. 'Audit', 'trc hull')..."
            className="flex-1 bg-transparent text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
          />
          <kbd className="rounded border border-[var(--border-hairline)] bg-[var(--bg-elevated)] px-1.5 py-0.5 font-mono text-[10px] text-[var(--text-muted)]">
            ESC
          </kbd>
        </div>

        <div
          data-testid="command-palette-list"
          className="max-h-80 overflow-y-auto p-1.5"
          role="listbox"
        >
          {ranked.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-[var(--text-muted)]">
              No matching commands or project assets.
            </div>
          ) : (
            ranked.map((item, idx) => {
              const selected = idx === safeSelectedIdx;
              return (
                <button
                  key={item.id}
                  type="button"
                  data-testid={`command-item-${item.id}`}
                  role="option"
                  aria-selected={selected}
                  onMouseEnter={() => setSelectedIndex(idx)}
                  onClick={() => executeItem(item)}
                  className={`flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left transition-colors ${
                    selected
                      ? 'bg-[var(--accent-primary)]/18 text-[#F5B82E]'
                      : 'text-[var(--text-primary)] hover:bg-[var(--bg-elevated)]'
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    {item.category === 'action' ? (
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-[var(--accent-primary)]" />
                    ) : item.category === 'asset' ? (
                      item.id.startsWith('asset-audio-') ? (
                        <FileAudio className="h-3.5 w-3.5 shrink-0 text-cyan-400" />
                      ) : (
                        <Image className="h-3.5 w-3.5 shrink-0 text-emerald-400" />
                      )
                    ) : (
                      <Command className="h-3.5 w-3.5 shrink-0 text-[var(--text-muted)]" />
                    )}
                    <div className="min-w-0">
                      <div className="truncate text-xs font-medium">{item.title}</div>
                      {item.subtitle && (
                        <div className="truncate text-[11px] text-[var(--text-muted)]">
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    <span className="rounded border border-[var(--border-hairline)] bg-[var(--bg-well)] px-1.5 py-0.5 text-[10px] text-[var(--text-muted)]">
                      {CATEGORY_LABEL[item.category]}
                    </span>
                    {selected && <CornerDownLeft className="h-3 w-3 opacity-75" />}
                  </div>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
