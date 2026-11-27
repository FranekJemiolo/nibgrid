import { useEffect, useMemo, useState } from 'react';
import {
  Activity,
  CheckCircle2,
  Cpu,
  Link2,
  PlugZap,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import {
  TaskRoutingTableSchema,
  createDefaultModelProfiles,
  createDefaultTaskRoutingTable,
  probeModelProviderHealth,
  resolveModelRoute,
  type ModelProviderProfile,
  type ModelTaskKind,
  type ProviderHealthStatus,
  type TaskRoutingTable,
} from '../../../packages/model-router/src/routerCore';
import { getActiveHostAdapter } from '../../platform/hostAdapter';
import { useAppStore } from '../../store/useAppStore';

const ROUTING_STORAGE_KEY = 'nibgrid.modelRouter.v1';

const TASK_LABELS: Record<ModelTaskKind, { readonly title: string; readonly subtitle: string }> = {
  'planning-composer': {
    title: 'Planning & Asset Composer (M37/M38)',
    subtitle: 'Single-prompt Vertical Slice planning & @-mention multi-tool edits',
  },
  'sprite-inpaint': {
    title: 'Sprite & Masked Inpainting (M3/M31)',
    subtitle: 'Sprite generation, ControlNet OpenPose strips & masked region redraws',
  },
  'vision-qa': {
    title: 'Art Director Vision QA (M32)',
    subtitle: 'Paginated contact-sheet critique for lighting, palette & 1× clarity',
  },
  audio: {
    title: 'Game Audio & Lyria / SFX (M14/M15)',
    subtitle: 'Procedural 16-bit WAV foley, Lyria music & Gemini SFX cues',
  },
};

function loadPersistedRoutingTable(): TaskRoutingTable {
  if (typeof window === 'undefined') return createDefaultTaskRoutingTable();
  try {
    const raw = window.localStorage.getItem(ROUTING_STORAGE_KEY);
    if (!raw) return createDefaultTaskRoutingTable();
    const parsed = JSON.parse(raw) as unknown;
    const valid = TaskRoutingTableSchema.safeParse(parsed);
    return valid.success ? valid.data : createDefaultTaskRoutingTable();
  } catch {
    return createDefaultTaskRoutingTable();
  }
}

export function ModelProvidersPanel() {
  const { modelSettingsOpen, setModelSettingsOpen, providers, activeProject } = useAppStore();

  const [profiles] = useState<ModelProviderProfile[]>(() => createDefaultModelProfiles());
  const [routingTable, setRoutingTable] = useState<TaskRoutingTable>(loadPersistedRoutingTable);
  const [availability, setAvailability] = useState<Record<string, boolean>>({});
  const [healthMap, setHealthMap] = useState<Record<string, ProviderHealthStatus>>({});
  const [linkStatus, setLinkStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(ROUTING_STORAGE_KEY, JSON.stringify(routingTable));
    } catch {
      // Ignore storage quota restrictions
    }
  }, [routingTable]);

  // Reflect configured cloud/bridge entries in availability without emitting noisy HTTP errors
  const effectiveAvailability = useMemo<Record<string, boolean>>(() => {
    const next: Record<string, boolean> = { ...availability };
    const hasGeminiKey = providers.some(
      (p) => p.kind === 'gemini' && p.enabled && p.apiKey.trim().length > 0,
    );
    if (hasGeminiKey) next['gemini-cloud'] = true;
    next['offline-mock'] = true;
    return next;
  }, [availability, providers]);

  if (!modelSettingsOpen) {
    return null;
  }

  const handleLinkAntigravity = async () => {
    setBusy(true);
    try {
      const host = getActiveHostAdapter();
      const res = await host.antigravity.linkAntigravityMcp({
        configDir: '~/.gemini/config',
        workspacePath: activeProject?.name ?? 'nibgrid-workspace',
      });
      setLinkStatus(res.backupPath ? `${res.message} (Backup: ${res.backupPath})` : res.message);
      if (res.ok) {
        setAvailability((prev) => ({ ...prev, 'antigravity-acp': true }));
      }
    } catch (err) {
      setLinkStatus(err instanceof Error ? err.message : 'Failed to link Google Antigravity MCP.');
    } finally {
      setBusy(false);
    }
  };

  const handlePingProviders = async () => {
    setBusy(true);
    try {
      const host = getActiveHostAdapter();
      const detectRes = await host.antigravity.detectAntigravity();
      const nextAvail: Record<string, boolean> = { ...effectiveAvailability };
      const nextHealth: Record<string, ProviderHealthStatus> = {};

      for (const prof of profiles) {
        const geminiVault = providers.find((p) => p.kind === 'gemini' && p.enabled);
        const status = await probeModelProviderHealth(prof, {
          antigravityDetected: detectRes.detected || Boolean(availability['antigravity-acp']),
          secrets: geminiVault?.apiKey ? [geminiVault.apiKey] : [],
        });
        nextHealth[prof.id] = status;
        nextAvail[prof.id] = status.ok;
      }

      setAvailability(nextAvail);
      setHealthMap(nextHealth);
    } finally {
      setBusy(false);
    }
  };

  const updatePrimaryRoute = (task: ModelTaskKind, primaryId: string) => {
    setRoutingTable((prev) => ({
      ...prev,
      [task]: {
        ...prev[task],
        primaryId,
      },
    }));
  };

  return (
    <div
      data-testid="model-providers-panel"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-[#2A2A2E] bg-[#16161A] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2A2A2E] bg-[#1C1C22] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 text-amber-400 ring-1 ring-amber-500/40">
              <Cpu className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                Pluggable ModelRouter & Google Antigravity Auto-Linker
              </h2>
              <p className="text-[11px] text-zinc-400">
                Route tasks across Antigravity ACP/MCP, LiteRT (.litertlm), Ollama/LM Studio,
                ComfyUI & Cloud Keychain with $0.00 fallback
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="close-models-btn"
            onClick={() => setModelSettingsOpen(false)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 space-y-4 overflow-y-auto p-5">
          {/* 1. Google Antigravity Linker */}
          <div
            data-testid="antigravity-linker-card"
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-sky-500/40 bg-sky-950/20 p-4"
          >
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center gap-2">
                <Link2 className="h-4 w-4 text-sky-400" />
                <h3 className="text-xs font-semibold text-zinc-100">
                  Google Antigravity 1-Click MCP Integration (`~/.gemini/config/mcp_config.json`)
                </h3>
              </div>
              <p className="text-[11px] text-zinc-400">
                Safely registers Nibgrid Studio&apos;s 9 MCP tools (`run_vertical_slice`, M38 tools)
                after writing a timestamped `.bak` backup with zero credential serialization.
              </p>
              {linkStatus && (
                <p
                  data-testid="antigravity-link-status"
                  className="mt-1 rounded border border-emerald-500/40 bg-emerald-950/35 px-2.5 py-1 text-[11px] text-emerald-200"
                >
                  {linkStatus}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <button
                type="button"
                data-testid="ping-providers-btn"
                disabled={busy}
                onClick={() => void handlePingProviders()}
                className="inline-flex items-center gap-1.5 rounded border border-[#2E2E35] bg-[#1B1B20] px-3 py-1.5 text-xs font-medium text-zinc-200 hover:border-zinc-500 disabled:opacity-50"
              >
                <Activity className="h-3.5 w-3.5 text-amber-400" />
                Ping Providers
              </button>
              <button
                type="button"
                data-testid="link-antigravity-btn"
                disabled={busy}
                onClick={() => void handleLinkAntigravity()}
                className="inline-flex items-center gap-1.5 rounded bg-sky-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-sky-400 disabled:opacity-50"
              >
                <PlugZap className="h-3.5 w-3.5" />
                Link Google Antigravity
              </button>
            </div>
          </div>

          {/* 2. Provider Profiles */}
          <div data-testid="model-provider-list" className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Pluggable Model & Runtime Backends
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {profiles.map((prof) => {
                const status = healthMap[prof.id];
                const isOnline = Boolean(effectiveAvailability[prof.id]);
                return (
                  <div
                    key={prof.id}
                    data-testid={`model-profile-${prof.id}`}
                    className="rounded-lg border border-[#2A2A2E] bg-[#121216] p-3 text-xs"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-semibold text-zinc-100">{prof.displayName}</span>
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] ${
                          isOnline
                            ? 'bg-emerald-500/15 text-emerald-300'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}
                      >
                        {isOnline ? 'Online' : 'Offline · Fallback'}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-zinc-400">
                      {prof.kind === 'antigravity-acp'
                        ? `${prof.command} ${prof.args.join(' ')} (${prof.model})`
                        : prof.kind === 'litert-local'
                          ? `${prof.accelerator} · :${prof.port}`
                          : prof.kind === 'openai-compatible' || prof.kind === 'comfyui-local'
                            ? prof.baseUrl
                            : prof.kind === 'cloud-byok'
                              ? `Keychain (${prof.provider})`
                              : '$0.00 deterministic'}
                    </p>
                    {status && (
                      <p className="mt-1.5 flex items-center gap-1 text-[10px] text-zinc-300">
                        {status.ok ? (
                          <CheckCircle2 className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <RefreshCw className="h-3 w-3 text-amber-400" />
                        )}
                        {status.message}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 3. Task-Level Routing Matrix */}
          <div
            data-testid="task-routing-table"
            className="space-y-2.5 rounded-lg border border-[#2A2A2E] bg-[#121216] p-4"
          >
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Per-Task Model Routing & Automatic Fallback
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                <ShieldCheck className="h-3.5 w-3.5" />
                Zero-Crash Fallback Active
              </span>
            </div>

            <div className="space-y-2">
              {(Object.keys(TASK_LABELS) as ModelTaskKind[]).map((task) => {
                const resolved = resolveModelRoute(
                  task,
                  routingTable,
                  profiles,
                  effectiveAvailability,
                );
                return (
                  <div
                    key={task}
                    className="grid grid-cols-1 items-center gap-3 rounded border border-[#24242B] bg-[#18181E] p-2.5 sm:grid-cols-12"
                  >
                    <div className="sm:col-span-5">
                      <p className="text-xs font-semibold text-zinc-100">
                        {TASK_LABELS[task].title}
                      </p>
                      <p className="text-[10px] text-zinc-400">{TASK_LABELS[task].subtitle}</p>
                    </div>
                    <div className="sm:col-span-4">
                      <select
                        data-testid={`route-select-${task}`}
                        value={routingTable[task].primaryId}
                        onChange={(e) => updatePrimaryRoute(task, e.target.value)}
                        className="w-full rounded border border-[#2E2E35] bg-[#121216] px-2 py-1 text-xs text-zinc-100"
                      >
                        {profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.displayName}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="text-right sm:col-span-3">
                      <span
                        data-testid={`resolved-route-${task}`}
                        className="inline-block rounded border border-emerald-500/35 bg-emerald-500/10 px-2 py-0.5 font-mono text-[10px] text-emerald-300"
                      >
                        Active: {resolved.profile.displayName}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
