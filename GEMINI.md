# Nibgrid Workspace Instructions for Google Antigravity

When working on this repository inside Google Antigravity IDE or Antigravity CLI (`agy`):

- Follow every rule and verification gate in [AGENTS.md](./AGENTS.md).
- Activate the workspace skill `.agents/skills/nibgrid-agent-workflow/SKILL.md` when testing the UI, generating sprite variants for a user project via `antigravity-agent`, or verifying the live GitHub Pages deployment (`https://franekjemiolo.github.io/nibgrid/`).
- Use the standalone script `.agents/skills/nibgrid-agent-workflow/scripts/verify-isolated-browser.mjs` so browser verification always starts in a fresh headless window and closes `page`, `context`, and `browser` in `finally` with zero session leakage.

