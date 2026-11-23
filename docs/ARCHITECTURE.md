# Nibgrid Architecture

## 1. Module Boundaries

- `src/domain/`: Pure TypeScript domain contracts, Zod runtime schemas, palette parsers (`.hex`, GIMP `.gpl`), deterministic prompt compiler, and DAG state engine. Runs identically in Node (Vitest) and browser contexts without DOM or Canvas dependencies.
- `src/processing/`: Pure TypeScript pixel-buffer (`Uint8ClampedArray`) image transforms, adaptive thresholding, ink bounding-box alignment, SHA-256 hashing (`crypto.subtle`), deterministic PNG encoding/decoding, canvas undo/redo history, and procedural sprite synthesis.
- `src/workers/`: Thin Dedicated Web Worker wrappers (`normalize.worker.ts`, `postprocess.worker.ts`) executing `src/processing/` math off the main UI thread (plus lazy WebGPU / single-threaded WASM segmentation without COEP headers).
- `src/db/`: Typed Dexie.js IndexedDB persistence layer with runtime Zod validation and explicit cascade deletion for orphaned binary blobs.
- `src/providers/`: `ProviderAdapter` contract, built-in `OfflineMockProvider`, `AntigravityAgentProvider` (Google Antigravity IDE / Agent Handoff + `window.__NIBGRID_AGENT_BRIDGE__`), `GeminiProvider` (direct browser BYOK multimodal REST client), `ComfyUiProvider` (local HTTP + WebSocket workflow runner with versioned JSON templates), and `ProviderError` classifier with secret redaction.
- `src/export/`: Reproducible `asset.recipe.json` (v1.0.0) Zod builder, `fflate` ZIP bundler, and File System Access API local folder writer.
- `src/store/`: Zustand store coordinating active project state, studio viewport controls, and persistence synchronization.
- `src/ui/`: React 19 UI organized into four screens:
  - `src/ui/hub/`: Screen 1 — Project Hub & Local Provider Vault
  - `src/ui/bible/`: Screen 2 — Art Bible ("Style Lock") Editor
  - `src/ui/studio/`: Screen 3 — Sprite Studio (Sketch/Mask Canvas, Viewport, Generation Inspector, Branching DAG Dock & Compare View)
  - `src/ui/inspector/`: Screen 4 — Post-Processing Stack, Split-Screen Comparator, Pivot Editor & Export Bar

## 2. IndexedDB Schema (`NibgridDatabase`)

Stored locally in IndexedDB via Dexie.js:

| Table | Key & Indexes | Stored Payload |
| --- | --- | --- |
| `projects` | `id`, `updatedAt`, `name` | Project metadata + validated `ArtBible` configuration |
| `blobs` | `id`, `sha256`, `createdAt` | Binary `Blob` (`image/png`, etc.), `mimeType`, `sha256` |
| `spriteNodes` | `id`, `projectId`, `parentId`, `[projectId+createdAt]` | Immutable DAG node linking `imageBlobId`, optional `maskBlobId`, `sketchSha256`, and `generationMeta` |
| `providerConfigs` | `id`, `kind`, `updatedAt` | Local BYOK/BYOM provider settings and capabilities |

**Orphan Blob Cleanup:** Binary blobs are stored separately from metadata rows. Whenever a Golden Reference is detached, a leaf node is deleted, or an entire project is deleted, `database.ts` computes reachable blob IDs across all remaining `projects` and `spriteNodes` and deletes unreferenced rows from `blobs`.

## 3. Worker Boundary

Image normalization (`extractLinesAndContrast` and `alignToSafeMargin`) runs in `normalize.worker.ts` using transferable `ArrayBuffer` payloads where applicable. The worker itself contains zero UI or IndexedDB logic and strictly delegates to pure functions in `src/processing/`.

## 4. Core Domain Contracts

- **`ArtBible`**: Enforces strict projection, lighting, art mode, dimensions (`16..2048`), normalized uppercase `#RRGGBB` palette (`0..64`), `0..3` Golden Reference blob IDs, and cutout-safe negative prompts.
- **`SpriteNode`**: Enforces valid parent-child DAG lineage (`kind: 'sketch' | 'generation' | 'inpaint'`), SHA-256 sketch fingerprints, and complete generation metadata (`providerId`, `modelId`, `seed`, `adherence`, `promptDelta`, `compiledPrompt`).
- **`ProviderAdapter`**: Standardized async interface (`testConnection`, `estimateCost`, `generate`, `inpaint`) supporting `AbortSignal` cancellation and capability negotiation.

## 5. Live Provider Adapters & Security Boundaries (Milestone 4)

- **Zero-Proxy Browser Fetch & No Strict COEP:** Nibgrid never injects `Cross-Origin-Embedder-Policy: require-corp` headers so direct client-side `fetch()` calls to Gemini REST endpoints and local ComfyUI servers are never blocked.
- **Gemini Multimodal BYOK (`src/providers/geminiProvider.ts`):** Serializes the compiled Art Bible prompt, normalized sketch PNG, up to 3 Golden Reference blobs (and parent render + binary mask PNG for `inpaint()`) into Gemini `inlineData` parts targeting `responseModalities: ["IMAGE"]`.
- **Local ComfyUI Runner (`src/providers/comfyuiProvider.ts` & `comfyuiWorkflows.ts`):** Uploads PNG inputs via `POST /upload/image`, clones and injects versioned v1.0 API workflow graphs (`{{PROMPT}}`, `{{NEGATIVE}}`, `{{SEED}}`, `{{SKETCH_FILENAME}}`, `{{MASK_FILENAME}}`, `{{DENOISE}}` mapped from `strict: 0.55`, `balanced: 0.72`, `loose: 0.88`), queues via `POST /prompt`, listens on `/ws?clientId=...` with `/history/{prompt_id}` polling fallback, and retrieves renders from `/view`.
- **Error Classification & Secret Redaction (`src/providers/errors.ts`):** Classifies HTTP `401`/`403`/`429`/`5xx`, timeouts, and `TypeError` CORS/offline errors into actionable `ProviderError` codes (e.g., ComfyUI `--enable-cors-header "*"` remediation) and strips API keys (`AIza...`, `sk-...`, query parameters, and explicit vault secrets) before surfacing diagnostics.

## 6. Deterministic Post-Processing Stack (Milestone 5)

All image-manipulation stages operate on raw `Uint8ClampedArray` buffers in `src/processing/` and run off the main thread in `src/workers/postprocess.worker.ts`:

1. **Background Removal (`backgroundKey.ts` / `postprocess.worker.ts`):**
   - **Fast Color-Key:** Border-seeded 4-connected BFS flood-fill (or global mode) using corner-sampled RGB distance within `0..100` tolerance.
   - **Local AI Cutout (Optional):** Lazy-loaded via `@huggingface/transformers` (`briaai/RMBG-1.4`) inside the worker with Browser Cache API persistence, WebGPU-first selection, and explicit single-threaded WASM (`numThreads = 1`) fallback so COEP headers are never required.
2. **Alpha Cleanup & Interior-RGB Defringing (`alphaCleanup.ts`):** Applies alpha threshold cutoff (`0..255`), 0–2px 4/8-connected morphological alpha erosion, and inverse-distance weighted interior RGB color decontamination on semi-transparent edge pixels (`0 < alpha < 255`).
3. **Resample, Auto-Trim & PoT Padding (`resampleAndTrim.ts`):** Nearest-Neighbor crisp scaling and premultiplied-alpha Area-Average box filtering, tight transparent bounding-box auto-trimming with configurable margin, and Power-of-Two padding.
4. **Perceptual OKLab Palette Quantization (`paletteQuantize.ts`):** Maps non-transparent pixels in OKLab color space to exact Art Bible `#RRGGBB` entries with optional 4×4 Ordered Bayer dithering, leaving `alpha === 0` pixels untouched.

## 7. Reproducible Export (`asset.recipe.json` v1.0.0) & Offline PWA (Milestone 6)

- **`asset.recipe.json` Specification (`src/export/recipeBuilder.ts`):**
  Every exported bundle (`<slug>.png` + `<slug>.recipe.json`) is validated against `AssetRecipeSchema`:
  - `schemaVersion`: `"1.0.0"`, `app`: `"nibgrid"`, `exportedAt`
  - `project`: `{ id, name }`
  - `artBible`: `{ projection, lighting, artMode, targetWidth, targetHeight, palette, stylePrompt, negativePrompt }`
  - `source`: `{ sketchSha256, normalizedWidth, normalizedHeight }`
  - `generation`: `{ providerId, modelId, seed, adherence, promptDelta, compiledPrompt, parentNodeId }` (validated to contain zero API key or credential fields)
  - `postProcess`: full `PostProcessConfig` snapshot (`bgRemoval`, alpha cleanup, defringe, OKLab palette snap, resampling, trim, PoT)
  - `output`: `{ filename, width, height, pivotPx: { x, y }, pivotNorm: { x, y } }`
- **Bundling & Direct Repo Export (`zipPackager.ts` & `fsAccess.ts`):** Uses `fflate.zipSync` for client-side ZIP downloads and `window.showDirectoryPicker()` (where supported) to write directly into a local game project directory.
- **Zero-Server Offline PWA (`vite.config.ts`, `public/manifest.webmanifest`, `src/main.tsx`):** A custom Vite build plugin emits `dist/sw.js` precaching static HTML, JS, CSS, Worker bundles, manifest, and icon under `VITE_BASE_PATH` while leaving large optional `.wasm` model runtimes lazy-cached on demand and bypassing cross-origin API calls.

