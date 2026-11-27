# Releasing Nibgrid (PWA + Standalone Desktop Studio + VS Code Extension)

Nibgrid ships the **GitHub Pages PWA**, the **VS Code / Cursor / Antigravity `.vsix` extension**, and the **Standalone Nibgrid Studio Desktop App** (macOS, Windows, Linux) in lockstep from a single SemVer tag (`vX.Y.Z`).

---

## 1. Version Bump (Strict Lockstep)

Update the version string identically across all four manifests before tagging. Any mismatch will fail `npm run verify:parity` and block CI:

1. `package.json` (`"version": "X.Y.Z"`)
2. `packages/vscode-extension/package.json` (`"version": "X.Y.Z"`)
3. `packages/model-router/package.json` (`"version": "X.Y.Z"`)
4. `desktop/product.json` (`"version": "X.Y.Z"`)

Update `JOURNAL.md` with the release summary, then commit the bump:

```bash
git add package.json packages/vscode-extension/package.json packages/model-router/package.json desktop/product.json JOURNAL.md
git commit -m "chore(release): bump version to vX.Y.Z"
```

---

## 2. Local Preflight & Parity Gate

Run the full local gate before pushing a release tag:

```bash
# Typecheck, lint, formatting, and PWA <-> Desktop parity
npm run typecheck
npm run lint
npm run format:check
npm run verify:parity

# Unit, E2E, Python loopback bridge, and CLI installer syntax
npm run test:unit
npm run test:e2e
uv run python -m unittest discover -s tests/python -v
python3 -m unittest tests/unit/test_nibgrid_bridge.py -v
sh -n public/install.sh

# Desktop bundle staging, extension bundle, and production PWA build
VITE_BASE_PATH=./ npm run build
npm run build:ext
npm run smoke:desktop
node --experimental-strip-types desktop/scripts/build-desktop.ts --dry-run --stage-dir desktop/stage --vsix
node --experimental-strip-types desktop/scripts/verify-release-artifacts.ts --stage-dir desktop/stage --require-web-ui --require-ext --vsix desktop/stage/nibgrid-studio-X.Y.Z.vsix
rm -rf desktop/stage

# Production GitHub Pages build
VITE_BASE_PATH=/nibgrid/ npm run build
```

Optional local preview smoke test:

```bash
VITE_BASE_PATH=/nibgrid/ npx vite preview --host 127.0.0.1 --port 4173 --strictPort &
PREVIEW_PID=$!
SMOKE_URL=http://127.0.0.1:4173/nibgrid/ node scripts/smoke-release.mjs
kill "$PREVIEW_PID"
```

---

## 3. Running a `release.yml` Dry-Run

Before publishing a public GitHub Release, validate the multi-OS build matrix without creating a release or deploying Pages:

1. Push your branch or `main` to GitHub.
2. Open **Actions → Release Nibgrid (Desktop + Extension + PWA) (`release.yml`) → Run workflow**.
3. Keep **`dry_run: true`** (default) and click **Run workflow**.
4. Confirm all jobs succeed:
   - `preflight-parity` (typecheck, lint, format, parity, unit, E2E, `.vsix`, and `pwa-dist`)
   - `build-desktop` (`macos-14`, `macos-15-intel`, `windows-latest`, `ubuntu-latest` + `verify-release-artifacts.ts`)
   - `publish-release` (generates `SHA256SUMS.txt` and skips GitHub Release creation)

---

## 4. Tagging & Publishing (`v*.*.*`)

Once the dry-run is green on `main`, create and push an annotated SemVer tag:

```bash
git tag -a vX.Y.Z -m "Nibgrid vX.Y.Z"
git push origin main --follow-tags
```

Pushing `v*.*.*` executes the full pipeline in `.github/workflows/release.yml`:

1. **`preflight-parity`** — Blocks downstream jobs on any test, E2E, build, or parity failure.
2. **`build-desktop`** — Packages `Nibgrid-Studio-X.Y.Z-macos-arm64.dmg`, `Nibgrid-Studio-X.Y.Z-macos-x64.dmg`, `Nibgrid-Studio-X.Y.Z-win-x64-setup.exe`, and `Nibgrid-Studio-X.Y.Z-linux-x64.AppImage` (plus `.zip`/`.tar.gz` archives).
3. **`publish-release`** — Computes `SHA256SUMS.txt` via `scripts/generate-checksums.ts` and publishes the GitHub Release with all desktop binaries and `.vsix` package.
4. **`deploy-pages`** — Deploys the matching `dist/` PWA build (including `install.sh` and `install.ps1`) to GitHub Pages and exposes `outputs.page_url`.
5. **`smoke-pages`** — Runs `scripts/smoke-release.mjs` (with up to 3 CDN propagation retries) against `needs.deploy-pages.outputs.page_url`.

---

## 5. Verifying `SHA256SUMS.txt` Locally

Download the release artifact and `SHA256SUMS.txt` from the GitHub Release page, then verify integrity:

- **macOS:**
  ```bash
  shasum -a 256 -c SHA256SUMS.txt --ignore-missing
  ```
- **Linux:**
  ```bash
  sha256sum -c SHA256SUMS.txt --ignore-missing
  ```
- **Windows (PowerShell):**
  ```powershell
  $Asset = "Nibgrid-Studio-X.Y.Z-win-x64-setup.exe"
  $Expected = (Select-String -Path SHA256SUMS.txt -Pattern "  $Asset$").Line.Split(" ")[0].ToLower()
  $Actual = (Get-FileHash -Path $Asset -Algorithm SHA256).Hash.ToLower()
  if ($Expected -eq $Actual) { "OK: $Asset" } else { throw "CHECKSUM MISMATCH" }
  ```

*(The one-line CLI installers `install.sh` and `install.ps1` and the in-app M43 updater `desktopUpdater.ts` perform this SHA-256 verification automatically before installing.)*

---

## 6. Troubleshooting `smoke-pages`

| Symptom in `smoke-pages` | Likely Cause | Fix |
| :--- | :--- | :--- |
| **`GET install.sh` or `manifest.webmanifest` returns `404`** | GitHub Pages CDN still propagating or `VITE_BASE_PATH` was not `/nibgrid/`. | Wait 1–2 minutes and re-run `smoke-pages`; verify `preflight-parity` built `pwa-dist` with `VITE_BASE_PATH=/nibgrid/`. |
| **`Service Worker did not activate within 8s`** | Stale SW registration or broken `manifest.webmanifest` / `sw.js` path under `/nibgrid/`. | Run the local preview smoke test (`VITE_BASE_PATH=/nibgrid/ npx vite preview --host 127.0.0.1 --port 4173 --strictPort &` then `SMOKE_URL=http://127.0.0.1:4173/nibgrid/ npm run smoke:release`) to inspect SW errors in Chromium. |
| **`Offline reload rendered empty body`** | Missing precache entry or `Vary: Origin` mismatch on CORS `<script>`/`<link>` tags. | Check `nibgridPwaPlugin` (`PRECACHE_URLS` and `{ ignoreVary: true }` in `caches.match(...)`) in `vite.config.ts` and confirm `dist/` contains `sw.js` and `manifest.webmanifest`. |
| **`Uncaught pageerrors` or `Console errors`** | Runtime exception on cold boot or unhandled network error. | Inspect the `smoke-pages` log output for the exact stack trace; ensure external calls (e.g., `fetchLatestDesktopRelease` in `InstallDesktopModal`) degrade cleanly without throwing. |
| **`sh -n install.sh` failed** | Bash-specific syntax (`[[ ... ]]`, `local`, arrays) introduced into `public/install.sh`. | Keep `public/install.sh` strictly POSIX `sh` (`#!/usr/bin/env sh`) and re-run `sh -n public/install.sh`. |

---

## 7. CLI Installers, Web Modal & Zero-Server Self-Updates (M42–M43)

- **One-Line CLI Installers (`public/install.sh`, `public/install.ps1`):** Hosted at `https://franekjemiolo.github.io/nibgrid/install.sh` and `install.ps1`, verifying `SHA256SUMS.txt` before installing locally.
- **Browser Modal (`InstallDesktopModal.tsx`):** Accessible via **Get Desktop App** in PWA mode to download platform installers or copy CLI commands, falling back to `/releases/latest` on `403`/`429`/offline errors.
- **Zero-Server Desktop Self-Updater (`updateCheckerCore.ts`, `desktopUpdater.ts`):** Uses ETag-cached (`If-None-Match` -> `304`) GitHub Release checks throttled to 24h (`nibgrid.updates.autoCheck`), manual **Nibgrid: Check for Updates** (`nibgrid.checkForUpdates`), `crypto.timingSafeEqual` streaming SHA-256 verification, and shell-free `execFile` OS handoff.
