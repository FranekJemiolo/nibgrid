import { useEffect, useState } from 'react';
import { CheckCircle2, Download, Globe, Plus, RefreshCw, ShieldCheck } from 'lucide-react';
import { db } from '../../db/database';
import {
  fetchAndParsePack,
  fetchPackCatalog,
  importPackIntoDb,
  loadSavedFeedUrls,
  resolveDefaultPackFeedUrl,
  saveFeedUrls,
  type PackCatalog,
  type PackEntry,
} from '../../share/packFeedClient';
import { useAppStore } from '../../store/useAppStore';

export function PackFeedBrowser() {
  const { activeProject, refreshSpriteNodes, refreshAudioAssets, refreshVaultItems } =
    useAppStore();

  const defaultFeedUrl = resolveDefaultPackFeedUrl();
  const [feedUrls, setFeedUrls] = useState<string[]>(() => loadSavedFeedUrls(defaultFeedUrl));
  const [selectedUrl, setSelectedUrl] = useState<string>(defaultFeedUrl);
  const [customUrlInput, setCustomUrlInput] = useState('');
  const [catalog, setCatalog] = useState<PackCatalog | null>(null);
  const [loadingFeed, setLoadingFeed] = useState(false);
  const [importingPackId, setImportingPackId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadFeed = async (url: string) => {
    setLoadingFeed(true);
    setError(null);
    try {
      const cat = await fetchPackCatalog(url);
      setCatalog(cat);
    } catch (err) {
      setCatalog(null);
      setError(err instanceof Error ? err.message : 'Failed to load Pack Feed.');
    } finally {
      setLoadingFeed(false);
    }
  };

  useEffect(() => {
    void loadFeed(selectedUrl);
  }, [selectedUrl]);

  const handleAddFeed = () => {
    const trimmed = customUrlInput.trim();
    if (!trimmed) return;
    const updated = saveFeedUrls([...feedUrls, trimmed]);
    setFeedUrls(updated);
    setSelectedUrl(trimmed);
    setCustomUrlInput('');
  };

  const handleImportPack = async (entry: PackEntry) => {
    setImportingPackId(entry.id);
    setNotice(null);
    setError(null);
    try {
      const parsed = await fetchAndParsePack(entry, selectedUrl);
      const outcome = await importPackIntoDb(
        db,
        parsed,
        activeProject ? { mode: 'project', projectId: activeProject.id } : { mode: 'vault' },
      );
      await refreshVaultItems();
      if (activeProject) {
        await Promise.all([
          refreshSpriteNodes(activeProject.id),
          refreshAudioAssets(activeProject.id),
        ]);
      }
      setNotice(outcome.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Pack import failed.');
    } finally {
      setImportingPackId(null);
    }
  };

  return (
    <div data-testid="pack-feed-browser" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#2A2A2E] bg-[#1A1A1D] p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Globe className="h-4 w-4 text-amber-400" />
          <span className="text-xs font-medium text-zinc-200">Feed Source:</span>
          <select
            data-testid="pack-feed-select"
            aria-label="Pack feed catalog URL"
            value={selectedUrl}
            onChange={(e) => setSelectedUrl(e.target.value)}
            className="max-w-xs rounded border border-[#2A2A2E] bg-[#121214] px-2 py-1 text-xs text-zinc-200"
          >
            {feedUrls.map((url) => (
              <option key={url} value={url}>
                {url}
              </option>
            ))}
          </select>
          <button
            type="button"
            data-testid="pack-feed-refresh-btn"
            onClick={() => void loadFeed(selectedUrl)}
            className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loadingFeed ? 'animate-spin' : ''}`} />
            Reload
          </button>
        </div>

        <div className="flex items-center gap-1.5">
          <input
            type="url"
            data-testid="pack-custom-url-input"
            value={customUrlInput}
            onChange={(e) => setCustomUrlInput(e.target.value)}
            placeholder="Add GitHub Pages catalog.json URL..."
            className="w-64 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1 text-xs text-zinc-100 placeholder-zinc-500"
          />
          <button
            type="button"
            data-testid="pack-add-feed-btn"
            onClick={handleAddFeed}
            className="inline-flex items-center gap-1 rounded border border-[#2A2A2E] bg-[#121214] px-2.5 py-1 text-xs text-zinc-200 hover:border-zinc-500"
          >
            <Plus className="h-3.5 w-3.5" />
            Add Feed
          </button>
        </div>
      </div>

      {notice && (
        <div
          data-testid="pack-import-notice"
          className="flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-4 py-2 text-xs text-emerald-200"
        >
          <CheckCircle2 className="h-4 w-4" />
          <span>{notice}</span>
        </div>
      )}
      {error && (
        <div
          data-testid="pack-error-banner"
          className="rounded-lg border border-rose-500/40 bg-rose-950/35 px-4 py-2 text-xs text-rose-200"
        >
          {error}
        </div>
      )}

      {catalog && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-zinc-100">{catalog.feedTitle}</h3>
              {catalog.description && (
                <p className="text-xs text-zinc-400">{catalog.description}</p>
              )}
            </div>
            <span className="text-xs text-zinc-400">{catalog.packs.length} pack(s)</span>
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
            {catalog.packs.map((pack) => (
              <article
                key={pack.id}
                data-testid={`pack-card-${pack.id}`}
                className="flex flex-col justify-between rounded-xl border border-[#2A2A2E] bg-[#1A1A1D] p-4"
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <h4 className="text-sm font-semibold text-zinc-100">{pack.title}</h4>
                    <span className="shrink-0 rounded border border-emerald-500/35 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                      {pack.license}
                    </span>
                  </div>
                  <p className="text-[11px] text-zinc-400">
                    By {pack.author} · {pack.assetCount} asset(s)
                  </p>
                  {pack.description && (
                    <p className="text-xs leading-relaxed text-zinc-300">{pack.description}</p>
                  )}
                  <div className="flex flex-wrap gap-1 pt-1">
                    {pack.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded border border-[#2A2A2E] bg-[#121214] px-1.5 py-0.5 font-mono text-[10px] text-zinc-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  {pack.sha256 && (
                    <p className="flex items-center gap-1 font-mono text-[10px] text-zinc-500">
                      <ShieldCheck className="h-3 w-3 text-emerald-400" />
                      sha256:{pack.sha256.slice(0, 12)}…
                    </p>
                  )}
                </div>

                <button
                  type="button"
                  disabled={importingPackId === pack.id}
                  data-testid={`pack-import-btn-${pack.id}`}
                  onClick={() => void handleImportPack(pack)}
                  className="mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
                >
                  <Download className="h-3.5 w-3.5" />
                  {importingPackId === pack.id
                    ? 'Verifying & Importing…'
                    : activeProject
                      ? `Import Pack to ${activeProject.name}`
                      : 'Import Pack to Vault'}
                </button>
              </article>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
