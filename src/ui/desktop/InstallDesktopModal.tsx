import { useEffect, useState } from 'react';
import {
  Check,
  Copy,
  Download,
  ExternalLink,
  Laptop,
  ShieldCheck,
  Terminal,
  X,
} from 'lucide-react';
import {
  DESKTOP_PLATFORMS,
  DESKTOP_PLATFORM_META,
  detectDesktopPlatform,
  fetchLatestDesktopRelease,
  getCliInstallCommand,
  getLatestReleasesFallbackUrl,
  type DesktopPlatform,
  type FetchDesktopReleaseResult,
} from '../../platform/desktopInstaller';
import { useAppStore } from '../../store/useAppStore';

function detectInitialPlatform(): DesktopPlatform {
  if (typeof navigator === 'undefined') {
    return 'macos-arm64';
  }
  const navWithUaData = navigator as Navigator & {
    userAgentData?: { platform?: string };
  };
  return detectDesktopPlatform({
    uaDataPlatform: navWithUaData.userAgentData?.platform,
    platform: navigator.platform,
    userAgent: navigator.userAgent,
  });
}

export function InstallDesktopModal() {
  const { installDesktopOpen, setInstallDesktopOpen } = useAppStore();

  const [selectedPlatform, setSelectedPlatform] = useState<DesktopPlatform>(detectInitialPlatform);
  const [releaseState, setReleaseState] = useState<FetchDesktopReleaseResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!installDesktopOpen) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    void fetchLatestDesktopRelease().then((res) => {
      if (cancelled) return;
      setReleaseState(res);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [installDesktopOpen]);

  if (!installDesktopOpen) {
    return null;
  }

  const meta = DESKTOP_PLATFORM_META[selectedPlatform];
  const cliCommand = getCliInstallCommand(selectedPlatform);
  const okRelease = releaseState?.status === 'ok' ? releaseState.release : null;
  const matchedAsset = okRelease?.assetsByPlatform[selectedPlatform];
  const fallbackUrl =
    releaseState?.status === 'fallback' ? releaseState.fallbackUrl : getLatestReleasesFallbackUrl();
  const primaryHref = matchedAsset?.downloadUrl ?? fallbackUrl;

  const handleCopyCli = async () => {
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(cliCommand);
      }
    } catch {
      // Clipboard API may be blocked in restricted contexts; still confirm command focus
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  return (
    <div
      data-testid="install-desktop-modal"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
    >
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-[#2A2A2E] bg-[#16161A] shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#2A2A2E] bg-[#1C1C22] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15 text-emerald-400 ring-1 ring-emerald-500/40">
              <Laptop className="h-4 w-4" />
            </div>
            <div>
              <h2 className="text-sm font-semibold text-zinc-100">
                Get Nibgrid Studio Desktop App
              </h2>
              <p className="text-[11px] text-zinc-400">
                Standalone VS Code-based workbench with OS Keychain secrets, direct Godot 4 launch
                &amp; Antigravity MCP
              </p>
            </div>
          </div>
          <button
            type="button"
            data-testid="close-install-desktop-btn"
            onClick={() => setInstallDesktopOpen(false)}
            className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 overflow-y-auto p-5">
          {/* OS Platform Tabs */}
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
            {DESKTOP_PLATFORMS.map((platform) => {
              const pMeta = DESKTOP_PLATFORM_META[platform];
              const active = selectedPlatform === platform;
              return (
                <button
                  key={platform}
                  type="button"
                  data-testid={`install-platform-tab-${platform}`}
                  onClick={() => {
                    setSelectedPlatform(platform);
                    setCopied(false);
                  }}
                  className={`rounded-md border px-2.5 py-2 text-xs font-medium transition-colors ${
                    active
                      ? 'border-emerald-500/60 bg-emerald-500/15 text-emerald-200'
                      : 'border-[#2A2A2E] bg-[#121216] text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
                  }`}
                >
                  {pMeta.label}
                </button>
              );
            })}
          </div>

          {/* Direct Download CTA */}
          <div className="rounded-lg border border-[#2A2A2E] bg-[#121216] p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="text-xs font-semibold text-zinc-200">
                Direct Installer ({meta.label})
              </div>
              {okRelease ? (
                <span
                  data-testid="install-version-badge"
                  className="rounded bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] text-emerald-300"
                >
                  v{okRelease.version}
                </span>
              ) : (
                <span className="rounded bg-zinc-800 px-2 py-0.5 font-mono text-[11px] text-zinc-400">
                  {loading ? 'Checking latest release…' : 'GitHub Releases'}
                </span>
              )}
            </div>

            {releaseState?.status === 'fallback' && (
              <p
                data-testid="install-fallback-notice"
                className="rounded border border-amber-500/35 bg-amber-950/30 px-2.5 py-1.5 text-[11px] text-amber-200"
              >
                Live GitHub Release metadata unavailable ({releaseState.reason}). Use the direct
                GitHub Releases page or CLI installer below.
              </p>
            )}

            <a
              data-testid="install-primary-download-link"
              href={primaryHref}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-xs font-semibold text-zinc-950 hover:bg-emerald-400"
            >
              {matchedAsset && okRelease ? (
                <>
                  <Download className="h-4 w-4" />
                  Download Nibgrid Studio v{okRelease.version} for {meta.label}
                </>
              ) : (
                <>
                  <ExternalLink className="h-4 w-4" />
                  View Latest Release on GitHub
                </>
              )}
            </a>
          </div>

          {/* Copyable CLI One-Liner */}
          <div className="rounded-lg border border-[#2A2A2E] bg-[#121216] p-4 space-y-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-xs font-semibold text-zinc-200">
                <Terminal className="h-3.5 w-3.5 text-sky-400" />
                <span>
                  One-Line CLI Installer ({meta.shellKind === 'ps1' ? 'PowerShell' : 'POSIX sh'})
                </span>
              </div>
              <span className="inline-flex items-center gap-1 text-[10px] text-emerald-300">
                <ShieldCheck className="h-3 w-3" />
                Auto SHA-256 Verified
              </span>
            </div>

            <div className="flex items-center gap-2 rounded border border-[#24242B] bg-[#0C0C0F] px-3 py-2">
              <code
                data-testid="install-cli-command"
                className="min-w-0 flex-1 overflow-x-auto font-mono text-[11px] text-sky-200 whitespace-nowrap"
              >
                {cliCommand}
              </code>
              <button
                type="button"
                data-testid="install-copy-cli-btn"
                onClick={() => void handleCopyCli()}
                className="inline-flex shrink-0 items-center gap-1 rounded border border-[#2E2E35] bg-[#1B1B20] px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:border-zinc-500"
              >
                {copied ? (
                  <>
                    <Check className="h-3 w-3 text-emerald-400" />
                    Copied!
                  </>
                ) : (
                  <>
                    <Copy className="h-3 w-3" />
                    Copy
                  </>
                )}
              </button>
            </div>
            <p className="text-[11px] text-zinc-400">
              Downloads the matching release binary and verifies <code>SHA256SUMS.txt</code>{' '}
              automatically before installing.
            </p>
          </div>

          {/* Post-Install Tip */}
          <div className="rounded-lg border border-sky-500/30 bg-sky-950/20 px-3.5 py-2.5 text-[11px] text-sky-200">
            <strong>Post-Install Tip:</strong> After launching Nibgrid Studio, click{' '}
            <strong>Models &amp; Providers → Link Google Antigravity</strong> to automatically wire{' '}
            <code>~/.gemini/config/mcp_config.json</code>.
          </div>
        </div>
      </div>
    </div>
  );
}
