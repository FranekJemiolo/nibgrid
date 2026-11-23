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

Start the optional loopback bridge with:

```bash
uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py
# Or offline smoke test mode:
uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --mock
```

Strict security rules enforced by `scripts/nibgrid_bridge.py`:

- Bind ONLY to `127.0.0.1` (default port `4188`).
- Require the fresh ephemeral `Authorization: Bearer nbg_...` token printed to stdout on startup.
- Allow only `https://franekjemiolo.github.io`, `http://localhost:*`, and `http://127.0.0.1:*` origins, returning `Access-Control-Allow-Private-Network: true` on `OPTIONS` preflights.
- Never write API keys, OAuth tokens, or session tokens into `.nibgrid/`, `result.json`, or any tracked Git file.

