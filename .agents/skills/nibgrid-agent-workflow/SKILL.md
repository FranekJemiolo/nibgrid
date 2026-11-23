---
name: nibgrid-agent-workflow
description: >-
  Use this skill when developing, testing, or driving Nibgrid inside Google
  Antigravity IDE or external AI coding tools, including generating or importing
  style-locked 2D sprites into the Nibgrid DAG via the Antigravity IDE Handoff
  bridge and running isolated headless Chromium verification against localhost
  or GitHub Pages without session leakage.
---

# Nibgrid Agent Workflow & IDE Bridge

Use this workflow to integrate Google Antigravity IDE / external coding agents seamlessly with Nibgrid's local-first UI and verification suite.

## 1. Using Nibgrid from Google Antigravity IDE (Asset Workflow)

1. Open Nibgrid (`npm run dev` locally or `https://franekjemiolo.github.io/nibgrid/`).
2. Create a project and configure its **Art Bible** (`projection`, `lighting`, `artMode`, target size, and hex/GPL palette).
3. In **Sprite Studio**, select **Google Antigravity IDE / Agent Handoff** (`antigravity-agent`) in the **Provider** dropdown.
4. Click **Copy Prompt Brief** (`copy-agent-brief-btn`) and optionally **Export Sketch PNG** (`download-agent-sketch-btn`).
5. Generate or refine the sprite PNG using Antigravity's image tooling (`image-generator`) following the compiled brief constraints.
6. Import the output back into the Sprite Lineage DAG either via **Import Agent PNG into DAG** (`import-agent-sprite-input`) or programmatically in Playwright/automation via:
   - `window.__NIBGRID_AGENT_BRIDGE__.getBrief()`
   - `window.__NIBGRID_AGENT_BRIDGE__.getState()`
   - `window.__NIBGRID_AGENT_BRIDGE__.importPngBase64(base64Png, promptDelta)`

## 2. Isolated Browser Verification (Zero Session Leakage)

Always verify live URLs in an isolated new headless browser window rather than connecting to a user's running browser profile:

```bash
node .agents/skills/nibgrid-agent-workflow/scripts/verify-isolated-browser.mjs https://franekjemiolo.github.io/nibgrid/
```

Or against a local Vite preview server:

```bash
npm run preview
# In another shell:
node .agents/skills/nibgrid-agent-workflow/scripts/verify-isolated-browser.mjs http://localhost:4173/
```

The verification script launches Chromium with `args: ['--new-window']`, creates a fresh `BrowserContext`, exercises M0–M6 end-to-end (including `Google Antigravity IDE / Agent Handoff` PNG bridge import), checks `consoleErrors === 0`, `pageErrors === 0`, and `httpErrors === 0`, and strictly closes `page`, `context`, and `browser` inside `finally`.

## 3. Repository CI Verification Gates

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:e2e
VITE_BASE_PATH=/nibgrid/ npm run build
```

