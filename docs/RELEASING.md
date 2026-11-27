# Releasing Nibgrid (PWA, VS Code Extension & Nibgrid Studio Desktop)

Nibgrid ships three synchronized surfaces from the same TypeScript core and React Web UI:

1. **GitHub Pages PWA** (`https://franekjemiolo.github.io/nibgrid/`, built with `VITE_BASE_PATH=/nibgrid/`)
2. **VS Code / Cursor / Google Antigravity IDE Extension** (`packages/vscode-extension`, `.vsix`)
3. **Standalone Nibgrid Studio Desktop App** (`desktop/`, telemetry-free VSCodium-style workbench packaging the PWA + Extension)

---

## 1. Version Synchronization & Parity Contract

All four manifests MUST stay on the exact same SemVer version:

- `package.json` (`version`)
- `packages/vscode-extension/package.json` (`version`)
- `packages/model-router/package.json` (`version`)
- `desktop/product.json` (`version`)

Before cutting any release or opening a release PR, run:

```bash
npm run verify:parity
```

`scripts/verify-parity.ts` blocks on any version drift, telemetry regression, missing bundled extension ID, missing Screen 4A–4P tab in `src/ui/inspector/workspaceTabs.ts`, or unregistered M37/M38 tool in `mcpToolServer.ts`.

---

## 2. Local First-Run Settings (`nibgrid.settings.json`)

Nibgrid Studio works 100% locally on launch with zero required cloud login. Inside **Models & Providers**, users can configure:

- **Per-Task Routing:** Google Antigravity ACP/MCP, on-device LiteRT, local Ollama/LM Studio, local ComfyUI (`127.0.0.1:8188`), Cloud BYOK (stored solely in OS Keychain `SecretStorage`), or `$0.00` Offline Mock Mode.
- **Godot 4 Execution & Sync:** Custom Godot binary path (validated without shell concatenation) and default `res://` output directory.
- **Portable Export/Import:** `Export JSON` / `Import JSON` emits `nibgrid.settings.json` with all API keys and tokens automatically stripped.

---

## 3. Staging & Verifying the Desktop Bundle + `.vsix` Locally

```bash
VITE_BASE_PATH=./ npm run build
npm run build:ext
node --experimental-strip-types desktop/scripts/build-desktop.ts --dry-run --stage-dir desktop/stage --vsix
node --experimental-strip-types desktop/scripts/verify-release-artifacts.ts --stage-dir desktop/stage --require-web-ui --require-ext --vsix desktop/stage/nibgrid-studio-0.1.0.vsix
```

---

## 4. Dry-Run & Tag-Triggered GitHub Releases (`.github/workflows/release.yml`)

- **Pull Requests & `main` CI Parity (`.github/workflows/ci-parity.yml`):** Automatically runs `verify:parity`, typecheck, lint, Prettier check, Vitest unit tests, VS Code extension build (`build:ext`), desktop `--dry-run` artifact verification, Playwright PWA + Desktop Webview E2E tests, and the GitHub Pages build (`VITE_BASE_PATH=/nibgrid/`).
- **Manual Dry-Run (`workflow_dispatch` with `dry_run: true`):** Exercises `preflight-parity`, all 3 OS matrix builds (`macos-14` arm64, `windows-latest` x64, `ubuntu-latest` x64), `.vsix` packaging, and `SHA256SUMS.txt` generation (`scripts/generate-checksums.ts`) without creating a public GitHub Release or overwriting Pages.
- **Production Tag Release:**

```bash
# 1. Align versions cleanly in package.json, packages/vscode-extension/package.json,
#    packages/model-router/package.json, and desktop/product.json
npm run verify:parity

# 2. Commit version bump, tag vX.Y.Z, and push
git tag v0.1.0
git push origin main v0.1.0
```

After downloading release artifacts, verify cryptographic integrity:

```bash
# macOS
shasum -a 256 -c SHA256SUMS.txt

# Linux
sha256sum -c SHA256SUMS.txt
```
