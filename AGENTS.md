# Nibgrid Repository Agent Instructions

Nibgrid is a 100% client-side, zero-server Bring-Your-Own-Key / Bring-Your-Own-Model (BYOK/BYOM) Progressive Web App for turning sketches into style-locked 2D game sprites.

## Non-Negotiable Architecture Rules

1. **Zero Server & Zero COEP Headers:** Never add a backend service or `Cross-Origin-Embedder-Policy: require-corp` headers (direct BYOK `fetch()` calls to Gemini and local ComfyUI must never be blocked).
2. **Pure TypeScript Core:** Keep all image-processing transforms (`Uint8ClampedArray`), OKLab palette math, DAG transitions, prompt compilation, and Zod validation inside `src/domain/` and `src/processing/` so Vitest runs in Node without DOM shims. Keep `src/workers/` thin.
3. **Strict TypeScript:** Respect `strict: true`, `noUncheckedIndexedAccess: true`, and zero `any`.
4. **Zero Key Leakage:** API keys live only in browser-local IndexedDB (`ProviderVault`), are redacted in `src/providers/errors.ts`, and must never be logged or written into `asset.recipe.json`.

## Google Antigravity IDE & Agent Integration

- **In-App Adapter (`antigravity-agent`):** Select **Google Antigravity IDE / Agent Handoff** inside Studio's Provider selector to copy structured style-locked Markdown briefs, export normalized sketch PNGs, or import agent-generated PNG sprites into the Sprite Lineage DAG.
- **Programmatic Window Bridge:** When Sprite Studio is mounted, `window.__NIBGRID_AGENT_BRIDGE__` exposes:
  - `getBrief(): string` — compiled Markdown brief with Art Bible projection, lighting, palette, and negative rules.
  - `getState()` — active project metadata, resolution, node count, and active node ID.
  - `importPngBase64(base64Png, promptDeltaOverride?)` — injects an agent-generated PNG directly into IndexedDB and the active Sprite Lineage DAG branch.
- **Skill Workflow:** Load `.agents/skills/nibgrid-agent-workflow/SKILL.md` for standard build/test gates and isolated browser verification.

## Isolated Browser Verification Rule

- When verifying local previews (`http://localhost:4173`) or GitHub Pages (`https://franekjemiolo.github.io/nibgrid/`), launch a standalone headless Playwright/Puppeteer browser (`args: ['--new-window']`) with its own ephemeral `BrowserContext` rather than requesting access to the user's running personal browser.
- Always close `page`, `context`, and `browser` inside a `try / finally` block so no Chromium processes or session state leak across runs.

## Verification Gates

Run these checks before pushing upstream:

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:e2e
VITE_BASE_PATH=/nibgrid/ npm run build
```

