import { useState, type FormEvent } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cpu,
  KeyRound,
  Plus,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react';
import { ANTIGRAVITY_AGENT_PROVIDER_ID, OFFLINE_MOCK_PROVIDER_ID } from '../../db/database';
import type { ProviderConfig, ProviderKind } from '../../domain/schemas';
import {
  clearBridgeSessionToken,
  setBridgeSessionToken,
} from '../../providers/antigravityBridgeProvider';
import { DEFAULT_ANTIGRAVITY_BRIDGE_URL } from '../../providers/bridgeContract';
import { DEFAULT_COMFYUI_BASE_URL } from '../../providers/comfyuiProvider';
import {
  COMFYUI_PLACEHOLDER_TOKENS,
  DEFAULT_COMFYUI_WORKFLOW_TEMPLATE,
  validateComfyUiWorkflowTemplate,
} from '../../providers/comfyuiWorkflows';
import { DEFAULT_GEMINI_BASE_URL } from '../../providers/geminiProvider';
import { resolveProviderAdapter } from '../../providers/registry';
import { useAppStore } from '../../store/useAppStore';

type ConfigurableKind = Exclude<ProviderKind, 'mock' | 'antigravity-agent'>;

const KIND_DEFAULTS: Record<
  ConfigurableKind,
  {
    displayName: string;
    endpointUrl: string;
    modelId: string;
    supportsInpaint: boolean;
    supportsMultiRef: boolean;
    supportsSeed: boolean;
    isLocal: boolean;
  }
> = {
  gemini: {
    displayName: 'Gemini Multimodal BYOK',
    endpointUrl: DEFAULT_GEMINI_BASE_URL,
    modelId: 'gemini-2.5-flash-image',
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: false,
    isLocal: false,
  },
  'antigravity-bridge': {
    displayName: 'Google Antigravity Loopback Bridge',
    endpointUrl: DEFAULT_ANTIGRAVITY_BRIDGE_URL,
    modelId: 'gemini-2.5-flash-image',
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: true,
    isLocal: true,
  },
  comfyui: {
    displayName: 'Local ComfyUI',
    endpointUrl: DEFAULT_COMFYUI_BASE_URL,
    modelId: 'comfyui-workflow-v1',
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: true,
    isLocal: true,
  },
  'openai-compatible': {
    displayName: 'OpenAI-Compatible Image API',
    endpointUrl: 'https://api.openai.com/v1',
    modelId: 'gpt-image-1',
    supportsInpaint: true,
    supportsMultiRef: true,
    supportsSeed: true,
    isLocal: false,
  },
  'custom-http': {
    displayName: 'Custom HTTP Endpoint',
    endpointUrl: 'http://127.0.0.1:8080',
    modelId: 'custom-v1',
    supportsInpaint: false,
    supportsMultiRef: false,
    supportsSeed: true,
    isLocal: true,
  },
};

interface TestStatus {
  ok: boolean;
  message: string;
}

export function ProviderVaultModal() {
  const { vaultOpen, setVaultOpen, providers, saveProvider, deleteProvider } = useAppStore();
  const [kind, setKind] = useState<ConfigurableKind>('gemini');
  const [displayName, setDisplayName] = useState(KIND_DEFAULTS.gemini.displayName);
  const [modelId, setModelId] = useState(KIND_DEFAULTS.gemini.modelId);
  const [endpointUrl, setEndpointUrl] = useState(KIND_DEFAULTS.gemini.endpointUrl);
  const [apiKey, setApiKey] = useState('');
  const [sessionOnlyToken, setSessionOnlyToken] = useState(true);
  const [customWorkflowJson, setCustomWorkflowJson] = useState(() =>
    JSON.stringify(DEFAULT_COMFYUI_WORKFLOW_TEMPLATE, null, 2),
  );
  const [testResult, setTestResult] = useState<Record<string, TestStatus>>({});
  const [testingId, setTestingId] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  if (!vaultOpen) {
    return null;
  }

  const handleKindChange = (nextKind: ConfigurableKind) => {
    setKind(nextKind);
    const defaults = KIND_DEFAULTS[nextKind];
    setDisplayName(defaults.displayName);
    setEndpointUrl(defaults.endpointUrl);
    setModelId(defaults.modelId);
    setFormError(null);
  };

  const handleAddProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setFormError('Provider display name is required.');
      return;
    }

    if (kind === 'comfyui' && customWorkflowJson.trim()) {
      try {
        validateComfyUiWorkflowTemplate(customWorkflowJson);
      } catch (error) {
        setFormError(error instanceof Error ? error.message : 'Invalid ComfyUI workflow template.');
        return;
      }
    }

    const defaults = KIND_DEFAULTS[kind];
    const isLocal =
      defaults.isLocal || endpointUrl.includes('localhost') || endpointUrl.includes('127.0.0.1');
    const id = globalThis.crypto.randomUUID();
    const trimmedKey = apiKey.trim();
    const persistKeyInDb = kind === 'antigravity-bridge' ? !sessionOnlyToken : true;

    if (kind === 'antigravity-bridge') {
      setBridgeSessionToken(id, trimmedKey);
    }

    const newConfig: ProviderConfig = {
      id,
      kind,
      displayName: trimmedName,
      modelId: modelId.trim() || defaults.modelId,
      endpointUrl: endpointUrl.trim(),
      apiKey: persistKeyInDb ? trimmedKey : '',
      enabled: true,
      customWorkflowJson: kind === 'comfyui' ? customWorkflowJson.trim() : undefined,
      capabilities: {
        supportsInpaint: defaults.supportsInpaint,
        supportsMultiRef: defaults.supportsMultiRef,
        supportsSeed: defaults.supportsSeed,
        isLocal,
      },
      updatedAt: new Date().toISOString(),
    };

    try {
      await saveProvider(newConfig);
      setApiKey('');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Failed to save provider config.');
    }
  };

  const handleTestConnection = async (provider: ProviderConfig) => {
    setTestingId(provider.id);
    try {
      const adapter = resolveProviderAdapter(provider);
      const res = await adapter.testConnection(provider);
      setTestResult((prev) => ({
        ...prev,
        [provider.id]: {
          ok: res.ok,
          message:
            res.latencyMs !== undefined && !res.message.includes('ms')
              ? `${res.message} (${res.latencyMs}ms)`
              : res.message,
        },
      }));
    } catch (error) {
      setTestResult((prev) => ({
        ...prev,
        [provider.id]: {
          ok: false,
          message: error instanceof Error ? error.message : 'Connection check failed.',
        },
      }));
    } finally {
      setTestingId(null);
    }
  };

  return (
    <div
      data-testid="provider-vault-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="provider-vault-title"
    >
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-slate-700 bg-slate-900 shadow-2xl">
        <div className="flex items-center justify-between border-b border-slate-800 px-5 py-4">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-500/20 text-indigo-400">
              <KeyRound className="h-4 w-4" />
            </div>
            <div>
              <h2 id="provider-vault-title" className="text-base font-semibold text-slate-100">
                Provider Vault (BYOK / BYOM)
              </h2>
              <div
                data-testid="vault-privacy-badge"
                className="mt-0.5 inline-flex items-center gap-1.5 text-xs text-emerald-300"
              >
                <ShieldCheck className="h-3.5 w-3.5" />
                <span>Local-Only Storage: API keys and endpoints never leave your IndexedDB</span>
              </div>
            </div>
          </div>

          <button
            type="button"
            data-testid="close-vault-btn"
            onClick={() => setVaultOpen(false)}
            className="rounded-md p-1.5 text-slate-400 hover:bg-slate-800 hover:text-slate-100"
            aria-label="Close Provider Vault"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Registered Providers ({providers.length})
            </h3>
            {providers.map((provider) => {
              const isBuiltIn =
                provider.id === OFFLINE_MOCK_PROVIDER_ID ||
                provider.id === ANTIGRAVITY_AGENT_PROVIDER_ID;
              const status = testResult[provider.id];
              return (
                <div
                  key={provider.id}
                  data-testid={`provider-card-${provider.id}`}
                  className="rounded-lg border border-slate-800 bg-slate-950/70 p-4"
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2">
                        <Cpu className="h-4 w-4 text-indigo-400" />
                        <span className="font-medium text-slate-100">{provider.displayName}</span>
                        <span className="rounded bg-slate-800 px-2 py-0.5 font-mono text-[11px] text-slate-300">
                          {provider.modelId}
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-xs text-slate-400">
                        {provider.endpointUrl || 'No endpoint set'}
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid={`test-provider-${provider.id}`}
                        disabled={testingId === provider.id}
                        onClick={() => void handleTestConnection(provider)}
                        className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700 disabled:opacity-50"
                      >
                        {testingId === provider.id ? 'Testing...' : 'Test Connection'}
                      </button>
                      {!isBuiltIn && (
                        <button
                          type="button"
                          onClick={() => {
                            clearBridgeSessionToken(provider.id);
                            void deleteProvider(provider.id);
                          }}
                          className="rounded-md border border-rose-500/30 bg-rose-500/10 p-1.5 text-rose-300 hover:bg-rose-500/20"
                          aria-label={`Delete ${provider.displayName}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {provider.capabilities.isLocal && (
                      <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[11px] text-emerald-300">
                        Local / Zero-Cost
                      </span>
                    )}
                    {provider.capabilities.supportsInpaint && (
                      <span className="rounded-full border border-indigo-500/30 bg-indigo-500/10 px-2 py-0.5 text-[11px] text-indigo-300">
                        Mask Inpaint
                      </span>
                    )}
                    {provider.capabilities.supportsMultiRef && (
                      <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] text-amber-300">
                        Multi-Ref Style Lock
                      </span>
                    )}
                    {provider.capabilities.supportsSeed && (
                      <span className="rounded-full border border-sky-500/30 bg-sky-500/10 px-2 py-0.5 text-[11px] text-sky-300">
                        Deterministic Seed
                      </span>
                    )}
                  </div>

                  {status && (
                    <div
                      data-testid={`provider-test-status-${provider.id}`}
                      className={`mt-2.5 flex items-start gap-1.5 text-xs ${
                        status.ok ? 'text-emerald-300' : 'text-rose-300'
                      }`}
                    >
                      {status.ok ? (
                        <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      ) : (
                        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      )}
                      <span>{status.message}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <form
            onSubmit={(e) => void handleAddProvider(e)}
            className="space-y-3 rounded-lg border border-slate-800 bg-slate-950/50 p-4"
          >
            <h3 className="text-xs font-semibold tracking-wider text-slate-400 uppercase">
              Add Gemini BYOK or Local ComfyUI Provider
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-slate-300">Adapter Type</span>
                <select
                  data-testid="vault-kind-select"
                  value={kind}
                  onChange={(e) => handleKindChange(e.target.value as ConfigurableKind)}
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="gemini">Gemini Multimodal BYOK</option>
                  <option value="antigravity-bridge">
                    Antigravity Loopback Bridge (127.0.0.1:4188)
                  </option>
                  <option value="comfyui">Local ComfyUI (HTTP + WebSocket)</option>
                  <option value="openai-compatible">OpenAI-Compatible Image API</option>
                  <option value="custom-http">Custom HTTP Endpoint</option>
                </select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-slate-300">Display Name</span>
                <input
                  type="text"
                  data-testid="vault-display-name-input"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g., Gemini 2.5 Flash Image"
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-slate-300">Endpoint URL</span>
                <input
                  type="url"
                  data-testid="vault-endpoint-input"
                  value={endpointUrl}
                  onChange={(e) => setEndpointUrl(e.target.value)}
                  placeholder="http://127.0.0.1:8188"
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-slate-300">Model ID</span>
                <input
                  type="text"
                  data-testid="vault-model-input"
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="gemini-2.5-flash-image"
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>

            {kind !== 'comfyui' && (
              <div className="space-y-2">
                <label className="block space-y-1 text-xs">
                  <span className="text-slate-300">
                    {kind === 'antigravity-bridge'
                      ? 'Ephemeral Session Token (nbg_... from nibgrid_bridge.py)'
                      : 'API Key (Stored in Local IndexedDB Only)'}
                  </span>
                  <input
                    type="password"
                    data-testid="vault-api-key-input"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      kind === 'antigravity-bridge'
                        ? 'Paste nbg_... token printed in terminal'
                        : 'Enter your provider API key'
                    }
                    className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                  />
                </label>

                {kind === 'antigravity-bridge' && (
                  <div className="space-y-1.5 rounded border border-indigo-500/30 bg-indigo-950/20 p-2.5 text-[11px] text-slate-300">
                    <label className="flex items-center gap-2 text-indigo-200">
                      <input
                        type="checkbox"
                        data-testid="vault-session-only-toggle"
                        checked={sessionOnlyToken}
                        onChange={(e) => setSessionOnlyToken(e.target.checked)}
                        className="accent-indigo-500"
                      />
                      Hold token in sessionStorage only (do not write to IndexedDB)
                    </label>
                    <p className="font-mono text-[10px] text-slate-400">
                      Run locally: uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py
                    </p>
                  </div>
                )}
              </div>
            )}

            {kind === 'comfyui' && (
              <div className="space-y-1.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="font-medium text-slate-300">
                    ComfyUI API Workflow JSON (v1.0)
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    Tokens: {COMFYUI_PLACEHOLDER_TOKENS.join(' ')}
                  </span>
                </div>
                <textarea
                  rows={6}
                  data-testid="vault-workflow-textarea"
                  value={customWorkflowJson}
                  onChange={(e) => setCustomWorkflowJson(e.target.value)}
                  className="w-full rounded-md border border-slate-700 bg-slate-900 p-2.5 font-mono text-[11px] text-slate-200 focus:border-indigo-500 focus:outline-none"
                />
              </div>
            )}

            {formError && (
              <p data-testid="vault-form-error" className="text-xs text-rose-400">
                {formError}
              </p>
            )}

            <button
              type="submit"
              data-testid="vault-save-provider-btn"
              className="inline-flex items-center gap-1.5 rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
            >
              <Plus className="h-3.5 w-3.5" />
              Save to Local Vault
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
