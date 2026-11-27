---
name: nibgrid
description: >
  Drive Nibgrid's 2D game asset foundry and Godot 4 vertical-slice pipeline from
  Google Antigravity IDE or Cursor. Covers starting the zero-dependency
  nibgrid_bridge.py loopback server (--mock or live), pairing with the GitHub
  Pages PWA, and invoking Nibgrid's M38/M39 MCP Studio Tools for sprites,
  palettes, colliders, sockets, shaders, SFX, room layouts, vertical slices,
  and res:// sync.
---

# Nibgrid Studio Skill

Use this skill when the user wants to generate, edit, audit, or sync 2D game
assets (sprites, auto-tile terrain, parallax layers, `.gdshader` effects, SFX,
`TileMapLayer` rooms, or full Godot 4 vertical slices) using **Nibgrid**.

---

## 1. Local Loopback Bridge (`nibgrid_bridge.py`)

The bridge connects the static GitHub Pages PWA (`https://franekjemiolo.github.io/nibgrid/`)
or local dev server (`http://localhost:5173`) to local models or deterministic
offline mocks over `127.0.0.1:4188` with zero external Python dependencies (`uv` PEP 723).

### Start Commands

* **Offline Mock Mode (`$0.00`, deterministic PNG/WAV/JSON — ideal for CI & layout tests):**
  ```bash
  uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --mock
  ```
* **Live Mode (uses `GEMINI_API_KEY` from local shell environment):**
  ```bash
  export GEMINI_API_KEY="your-key-here"
  uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --port 4188
  ```
* **Optional Flags:**
  * `--port <int>`: Override default loopback port (`4188`).
  * `--token <str>`: Provide an explicit Bearer token (defaults to ephemeral `nbg_<secrets.token_urlsafe(24)>`).
  * `--allow-origin <url>`: Append an additional exact allowed browser `Origin` (repeatable).

### Security & Pairing Rules

1. Binds strictly to `127.0.0.1` (never `0.0.0.0`).
2. Enforces exact `Origin` allowlisting (`https://franekjemiolo.github.io`, `http://localhost:5173`, `http://127.0.0.1:5173`, `http://localhost:4173`, `http://127.0.0.1:4173`, plus `--allow-origin`) and Chrome Private Network Access (`Access-Control-Allow-Private-Network: true`, `Vary: Origin`, `Cache-Control: no-store`).
3. Requires constant-time `Authorization: Bearer <token>` (`hmac.compare_digest`) on all `POST` endpoints. Copy the ephemeral token printed to `stdout` into **Nibgrid → Provider Vault → Antigravity Bridge**.
4. Enforces `MAX_BODY_BYTES` (`16 MiB` in CLI mode) and redacts secrets via `redact_secrets()`. Never commit API keys or Bearer tokens into `.nibgrid/`, `result.json`, `recipe.json`, or `mcp_config.json`.

### HTTP Endpoints

| Method & Path | Auth | Purpose |
| :--- | :--- | :--- |
| `GET /v1/health` | None (CLI mode) | Health check (`{"status":"ok","ok":true,"bridge":"nibgrid-loopback","mock":...,"authRequired":true}`) |
| `POST /v1/image/generate` | Bearer | Generate sprite / parallax / pose strip (`imageBase64` PNG) |
| `POST /v1/image/inpaint` | Bearer | Masked region redraw for M31 Micro-Editor |
| `POST /v1/audio/generate` | Bearer | Generate 16-bit mono PCM SFX (`audioBase64` WAV in `--mock` mode) |
| `POST /v1/llm/json` | Bearer | Structured JSON blueprints (M26 Entity, M35 Room, M37 Vertical Slice) |
| `POST /v1/vision/qa` | Bearer | M32 Vision-LLM Art Director QA contact-sheet audit |

Legacy M10 compatibility routes (`/v1/generate`, `/v1/inpaint`, `/v1/critique`, `/v1/cancel/<requestId>`) are also served for stateful `interactionId` chains and `create_bridge_server()` test harnesses.

---

## 2. Nibgrid MCP Studio Tools (M38 / M39)

When Nibgrid's VS Code Extension (`packages/vscode-extension`) or Standalone
Desktop App (**Nibgrid Studio**) is installed, register its stdio MCP server in
`~/.gemini/config/mcp_config.json` (or click **Settings → Models & Providers → Link Google Antigravity** inside Nibgrid Studio to merge safely with automatic backup):

```json
{
  "mcpServers": {
    "nibgrid": {
      "command": "node",
      "args": [
        "<path-to-repo>/packages/vscode-extension/dist/mcpToolServer.js"
      ]
    }
  }
}
```

### Available Studio Tools

All mutating tools write into Nibgrid's isolated staging buffer (`StagedAssetChange[]`)
so the user can review Visual Diffs and Accept, Reject, or Restore Checkpoints:

| Tool Name | Milestone | What It Does |
| :--- | :--- | :--- |
| `inpaint_sprite_region` | M31 | Redraws a masked sprite region while preserving unmasked pixels byte-for-byte. |
| `repalette_sprites` | M7 / M11 | Deterministic OKLab palette swap against the active `ArtBible`. |
| `update_gdshader_uniforms` | M27 | Patches `.gdshader` source or default uniform values (e.g., `hit_flash`). |
| `add_or_move_socket` | M21 | Adds or repositions named `Marker2D` sockets (`hand_r`, `muzzle`, `exhaust`). |
| `recompute_colliders` | M16 | Rebuilds RDP collision hulls and clip `activeFrames` hitboxes/hurtboxes. |
| `generate_sfx_cue` | M14 / M15 | Generates procedural or AI WAV cues and binds them to entity animation frames. |
| `patch_room_layout` | M35 | Updates `TileMapLayer` terrain cells, platforms, or entity spawns in a room. |
| `sync_godot_diff` | M25 | Syncs SHA-256 changed files to `res://` (**requires explicit user confirmation**). |
| `run_vertical_slice` | M37 / M39 | Plans and executes a resumable multi-asset vertical slice workflow (tileset, parallax, entities, UI, audio, `main.tscn`). |

---

## 3. Agent Workflow Guidelines

1. **Prefer `--mock` for Dry Runs:** When verifying pipelines, layouts, or Godot `.tscn` wiring, start `nibgrid_bridge.py --mock` or select Nibgrid's `instant-draft` (`$0.00`) tier before spending live image/audio tokens.
2. **Respect `ArtBible` Cohesion:** Always reference the project's active `ArtBible` (palette, projection, pixel density, light direction) before calling `inpaint_sprite_region` or `repalette_sprites`.
3. **Never Bypass Confirmation on Disk Sync:** Always summarize changed `res://` paths before invoking `sync_godot_diff`.

---

## 4. Verification & Troubleshooting

```bash
# 1. Verify Python bridge syntax & unit tests (zero external deps)
uv run python -m py_compile .agents/skills/nibgrid/scripts/nibgrid_bridge.py
uv run python -m unittest discover -s tests/python -v
python3 -m unittest tests/unit/test_nibgrid_bridge.py -v

# 2. Verify running bridge health
curl -s http://127.0.0.1:4188/v1/health

# 3. Verify PWA <-> Desktop tool & version parity
npm run verify:parity
```

---

## 5. File-Based Workspace Contract (`.nibgrid/`)

When running file-based sprite jobs via `.nibgrid/`:

- `.nibgrid/art_bible.json` & `.nibgrid/refs/` define locked camera projection, lighting, palette, and Golden References.
- `.nibgrid/jobs/{jobId}/` holds `job.json`, `sketch.png`, optional `mask.png`, and `output/` (`variant_{i}.png`, `result.json`, `critique.json`).
- **Critique Threshold:** If `critique.json` reports `score < 80`, populate `suggestedPromptDelta` with a surgical single-pass correction and do **not** exceed 2 autonomous retry passes without user confirmation.
- **Batch Restyling:** When restyling exported assets from `*.recipe.json`, preserve `source.sketchSha256`, `output.pivotNorm`, and `postProcess` parameters.
