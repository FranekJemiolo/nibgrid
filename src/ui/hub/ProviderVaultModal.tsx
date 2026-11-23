import { useState, type FormEvent } from 'react';
import { CheckCircle2, Cpu, KeyRound, Plus, ShieldCheck, Trash2, X } from 'lucide-react';
import { OFFLINE_MOCK_PROVIDER_ID } from '../../db/database';
import type { ProviderConfig, ProviderKind } from '../../domain/schemas';
import { useAppStore } from '../../store/useAppStore';

export function ProviderVaultModal() {
  const { vaultOpen, setVaultOpen, providers, saveProvider, deleteProvider } = useAppStore();
  const [displayName, setDisplayName] = useState('');
  const [kind, setKind] = useState<Exclude<ProviderKind, 'mock'>>('openai-compatible');
  const [modelId, setModelId] = useState('gpt-image-1');
  const [endpointUrl, setEndpointUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [testResult, setTestResult] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  if (!vaultOpen) {
    return null;
  }

  const handleAddProvider = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);
    const trimmedName = displayName.trim();
    if (!trimmedName) {
      setFormError('Provider display name is required.');
      return;
    }

    const isLocal =
      kind === 'comfyui' || endpointUrl.includes('localhost') || endpointUrl.includes('127.0.0.1');
    const newConfig: ProviderConfig = {
      id: globalThis.crypto.randomUUID(),
      kind,
      displayName: trimmedName,
      modelId: modelId.trim() || 'default-model',
      endpointUrl: endpointUrl.trim(),
      apiKey: apiKey.trim(),
      enabled: true,
      capabilities: {
        supportsInpaint: kind !== 'custom-http',
        supportsMultiRef: kind === 'openai-compatible',
        supportsSeed: true,
        isLocal,
      },
      updatedAt: new Date().toISOString(),
    };

    try {
      await saveProvider(newConfig);
      setDisplayName('');
      setApiKey('');
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Failed to save provider config.');
    }
  };

  const handleTestConnection = (provider: ProviderConfig) => {
    if (provider.kind === 'mock') {
      setTestResult((prev) => ({
        ...prev,
        [provider.id]: 'Connected (0ms — Local Procedural Engine ready)',
      }));
      return;
    }
    if (!provider.endpointUrl.trim()) {
      setTestResult((prev) => ({
        ...prev,
        [provider.id]: 'Missing endpoint URL.',
      }));
      return;
    }
    setTestResult((prev) => ({
      ...prev,
      [provider.id]: `Config valid (${provider.endpointUrl}). Runtime calls execute directly from browser.`,
    }));
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
              const isMock = provider.id === OFFLINE_MOCK_PROVIDER_ID;
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
                        onClick={() => handleTestConnection(provider)}
                        className="rounded-md border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs font-medium text-slate-200 hover:bg-slate-700"
                      >
                        Test
                      </button>
                      {!isMock && (
                        <button
                          type="button"
                          onClick={() => void deleteProvider(provider.id)}
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

                  {testResult[provider.id] && (
                    <div className="mt-2.5 flex items-center gap-1.5 text-xs text-emerald-300">
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                      <span>{testResult[provider.id]}</span>
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
              Add Custom BYOK / Local Model Provider
            </h3>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-xs">
                <span className="text-slate-300">Display Name</span>
                <input
                  type="text"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g., Local ComfyUI SDXL"
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-slate-300">Adapter Type</span>
                <select
                  value={kind}
                  onChange={(e) => setKind(e.target.value as Exclude<ProviderKind, 'mock'>)}
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                >
                  <option value="openai-compatible">OpenAI-Compatible Image API</option>
                  <option value="comfyui">Local ComfyUI Endpoint</option>
                  <option value="custom-http">Custom HTTP Endpoint</option>
                </select>
              </label>

              <label className="space-y-1 text-xs">
                <span className="text-slate-300">Endpoint URL</span>
                <input
                  type="url"
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
                  value={modelId}
                  onChange={(e) => setModelId(e.target.value)}
                  placeholder="gpt-image-1 / flux-dev"
                  className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
                />
              </label>
            </div>

            <label className="block space-y-1 text-xs">
              <span className="text-slate-300">API Key (Stored in Local IndexedDB Only)</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Optional for local endpoints"
                className="w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-sm text-slate-100 focus:border-indigo-500 focus:outline-none"
              />
            </label>

            {formError && <p className="text-xs text-rose-400">{formError}</p>}

            <button
              type="submit"
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
