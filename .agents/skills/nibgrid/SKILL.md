---
name: nibgrid
description: >
  Orchestrate 2D game sprite generation, Art Bible visual critique, stateful
  interaction_id iteration, and batch recipe re-runs for Nibgrid projects inside
  this workspace. Trigger when the user mentions Nibgrid, sprite jobs in
  .nibgrid/jobs/, Art Bible compliance checks, or starting the local Nibgrid
  loopback bridge.
---

# Nibgrid 2D Sprite Pipeline Skill

## Role

Act as a disciplined 2D Technical Art Director and deterministic pipeline runner for Nibgrid. Never improvise visual styles that contradict `.nibgrid/art_bible.json`.

## Workspace Contract

All file-based handoffs between the Nibgrid PWA (via File System Access API) and Antigravity live under `.nibgrid/`:

```text
.nibgrid/
├── art_bible.json            # Locked projection, lighting, palette, and Golden Refs
├── refs/                     # Golden Reference PNGs referenced by art_bible.json
└── jobs/{jobId}/
    ├── job.json              # Input spec: sketch path, parentInteractionId, promptDelta
    ├── sketch.png            # Normalized input sketch (or parent render)
    ├── mask.png              # Optional binary inpaint mask (white = edit, black = keep)
    └── output/
        ├── variant_0.png     # Generated sprite output
        ├── result.json       # Contains interactionId, modelId, promptUsed, createdAt
        └── critique.json     # Art Bible compliance report + suggested next promptDelta
```

## Core Workflows

### 1. Execute a Pending Sprite Job

1. Read `.nibgrid/art_bible.json` and `.nibgrid/jobs/{jobId}/job.json`.
2. If `job.json` includes a non-expired `previousInteractionId`, chain the image generation call statefully using that handle and pass only the delta edit (plus `mask.png` if present).
3. Otherwise, pass `sketch.png`, all Golden References in `.nibgrid/refs/`, and the compiled Art Bible rules (always enforcing: flat uniform contrasting background, centered full silhouette, no drop shadow, no floor plane).
4. Write generated PNG(s) to `output/variant_{i}.png` and write `output/result.json` recording the exact returned `interactionId`, `modelId`, and ISO timestamp.

### 2. Run Art Bible Critique (Auto-Review Gate)

Inspect each generated `output/variant_{i}.png` visually against `.nibgrid/art_bible.json` and write `output/critique.json` checking five strict invariants:

- **Projection Lock:** Does camera angle match `art_bible.projection`?
- **Lighting Lock:** Do highlights and shadows follow `art_bible.lighting`?
- **Cutout Readiness:** Is the background flat and uniform with zero floor shadows?
- **Silhouette Integrity:** Is the entire sprite inside frame with margin on all 4 sides?
- **Palette Cohesion:** Do dominant hues align with `art_bible.palette`?

If `score < 80`, populate `suggestedPromptDelta` with a surgical, single-pass correction (e.g., `"remove cast shadow under boots, shift key light strictly to top-left"`). Do **NOT** exceed 2 autonomous retry passes without user confirmation.

### 3. Batch Restyle from `asset.recipe.json`

When asked to restyle existing exported assets after an Art Bible update:

1. Locate all `*.recipe.json` files in the target asset folder.
2. Preserve each asset's original `source.sketchSha256`, `output.pivotNorm`, and `postProcess` parameters.
3. Queue fresh `.nibgrid/jobs/` entries referencing the updated `art_bible.json` and summarize all modified assets in a Markdown diff table.

### 4. Local Loopback Bridge Guardrails

Start the optional zero-dependency (`uv` PEP 723) loopback bridge with:

```bash
uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py
# Or deterministic offline mock mode (stdlib PNG & PCM WAV):
uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --mock
# Custom port / additional Origin:
uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --port 4188 --allow-origin http://localhost:3000
```

Strict security & protocol rules enforced by `scripts/nibgrid_bridge.py`:

- Bind ONLY to `127.0.0.1` (`DEFAULT_PORT = 4188`).
- Require the fresh ephemeral `Authorization: Bearer nbg_...` token printed to stdout on startup on all `POST` endpoints (`/v1/image/generate`, `/v1/image/inpaint`, `/v1/audio/generate`, `/v1/llm/json`, `/v1/vision/qa`, `/v1/generate`, `/v1/inpaint`, `/v1/critique`, `/v1/cancel/<id>`), verified via `hmac.compare_digest`.
- Serve `GET /v1/health` unauthenticated by default in CLI mode (`status: "ok"`, `mock`, `authRequired: true`) and allow only `https://franekjemiolo.github.io`, `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `http://127.0.0.1:4173` (plus explicit `--allow-origin` values), returning `Access-Control-Allow-Private-Network: true`, `Vary: Origin`, and `Cache-Control: no-store` on CORS/PNA preflights.
- Enforce `MAX_BODY_BYTES` (`16 MiB` in CLI mode) and redact API keys/tokens via `redact_secrets()` before logging or returning upstream errors; never write API keys, OAuth tokens, or session tokens into `.nibgrid/`, `result.json`, or any tracked Git file.

