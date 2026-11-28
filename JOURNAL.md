# Nibgrid Engineering Journal

---

## Milestone 0: Repository Scaffold, Quality Tooling & CI/CD

### Architectural Decisions & Trade-Offs

- **Strict TypeScript Configuration:** Configured `tsconfig.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, `"noImplicitAny": true`, `"noUnusedLocals": true`, and `"noUnusedParameters": true`, paired with ESLint `@typescript-eslint/no-explicit-any: "error"` across both `src/` and `tests/`. This enforces safe indexed array/buffer access up front before image-processing loops are written in M2/M3.
- **Static GitHub Pages Asset Resolution:** Configured `vite.config.ts` with `base: process.env.VITE_BASE_PATH ?? '/'` so local dev/preview serves at `/` while CI/CD builds with `VITE_BASE_PATH=/nibgrid/` for `https://franekjemiolo.github.io/nibgrid/`.
- **Single-Repo Tooling & CI Parity:** Added `.pre-commit-config.yaml` compatible with `prek` running `typecheck`, `lint`, and `format:check`, plus `.github/workflows/ci.yml` and `.github/workflows/deploy.yml`.
- **Dark Studio Shell:** Built an initial dark-mode studio shell (`bg-slate-950`) with `Projects` and `Provider Vault` navigation tabs to establish E2E boot invariants before adding domain persistence in M1.

### Verification Results

- `npm run typecheck`: passed (`tsc --noEmit`, 0 errors)
- `npm run lint`: passed (`eslint .`, 0 errors, 0 warnings)
- `npm run format:check`: passed (Prettier code style verified across `src/` and `tests/`)
- `npm run test:unit`: passed (1 test file, 2/2 tests passed in 162ms)
- `npm run test:e2e`: passed (1/1 Playwright Chromium test passed in 5.3s; 0 `console.error`, 0 `pageerror`)
- `npm run build`: passed (`dist/index.html` 0.56 kB, `dist/assets/index-CIc6YtRn.css` 13.69 kB, `dist/assets/index-DoXytVsL.js` 230.23 kB)
- `VITE_BASE_PATH=/nibgrid/ npm run build`: passed (`dist/index.html` 0.58 kB, base path `/nibgrid/` resolved cleanly)

---

## Milestone 1: Schemas, IndexedDB Persistence, Project Hub & Art Bible (Screens 1–2)

### Architectural Decisions & Trade-Offs

- **Runtime Validation & Shared SHA-256 Helper:** Implemented all domain contracts (`ArtBible`, `SpriteNode`, `Project`, `BlobRecord`, `ProviderConfig`) in `src/domain/schemas.ts` using strict Zod schemas and extracted `sha256Bytes` into `src/processing/hash.ts` so both IndexedDB blob hashing and future worker pipelines share one Web Crypto implementation.
- **Separated Binary Storage with Cascade GC:** Stored binary image assets (`Golden Reference` images and sprite artifacts) in a dedicated Dexie `blobs` table keyed by UUID with SHA-256 digests (`src/db/database.ts`). Implemented transactional `cleanupOrphanedBlobsInTx()` inside `deleteProjectCascade`, `deleteSpriteNode`, and `updateProjectArtBible` so detaching references or deleting projects never leaves orphaned binary blobs in IndexedDB.
- **Serialized Project Write Queue:** Added `enqueueProjectWrite` and `patchActiveArtBible` in `src/store/useAppStore.ts` with immediate optimistic state updates so rapid sequential form changes (e.g., changing projection, art mode, importing `.gpl`, and attaching Golden References back-to-back) never clobber earlier updates via stale React closures.
- **Hash-Based Client Routing:** Used client-side URL hash routing (`#/`, `#/project/<id>/bible`, `#/project/<id>/studio`) so static GitHub Pages deployments and full page reloads restore the active project screen straight from IndexedDB without any backend routing.

### Verification Results

- `npm run typecheck`: passed (`tsc --noEmit`, 0 errors)
- `npm run lint`: passed (`eslint .`, 0 errors, 0 warnings)
- `npm run format:check`: passed (Prettier verified across `src/` and `tests/`)
- `npm run test:unit`: passed (2 test files, 6/6 tests passed in 214ms; verified Zod constraints, `.hex`/`.gpl` parsers, and `fake-indexeddb` cascade cleanup)
- `npm run test:e2e`: passed (2/2 Playwright Chromium tests passed in 4.1s; verified project creation, Art Bible settings, 4-color `.gpl` import, Golden Reference upload, and `page.reload()` restoration from IndexedDB with 0 `console.error` / `pageerror`)
- `npm run build`: passed (`dist/assets/index-2dSSd_X0.js` 434.77 kB)
- `VITE_BASE_PATH=/nibgrid/ npm run build`: passed (`dist/index.html` 0.58 kB)

---

## Milestone 2: Sketch Ingestion, Normalization Worker & Mask Canvas (Screen 3A)

### Architectural Decisions & Trade-Offs

- **Hybrid Adaptive + Global Thresholding (`src/processing/normalize.ts`):** Pure local adaptive thresholding turns the interior of solid filled dark shapes white when the fill exceeds the local kernel radius. Combined a 2D summed-area table local mean check (`lum < localMean - 26 && lum < bgLum - 26`) with a 75th-percentile background-gated global dark threshold (`lum < min(120, bgLum - 55)`) so both fine pencil lines on uneven paper and solid silhouette fills extract cleanly on `#FFFFFF`.
- **Ink-Preserving Safe-Margin Scaling (`alignToSafeMargin`):** Implemented aspect-preserving centering within the requested `marginRatio` (`0.1` default) using nearest-neighbor on upscale and dark-pixel-minimum sampling on downscale so 1px ink lines do not drop out during downsampling.
- **Deterministic Pure-TS PNG Encoding (`src/processing/png.ts`):** Built an uncompressed-zlib RGBA PNG encoder using IEEE CRC32 and Adler32 checksums so Web Workers, Vitest Node suites, and M3 procedural sprite synthesis produce byte-identical PNGs independent of browser canvas/OS encoders.
- **Dual-Canvas Studio & Web Worker Boundary:** Separated `sketch-canvas` and translucent red `mask-canvas` backed by `Uint8ClampedArray` and `Uint8Array` buffers, bounded `CanvasHistory` (20 snapshots), and transferable-buffer messaging to `src/workers/normalize.worker.ts`.

### Verification Results

- `npm run typecheck`: passed (`tsc --noEmit`, 0 errors)
- `npm run lint`: passed (`eslint .`, 0 errors, 0 warnings)
- `npm run format:check`: passed (Prettier verified across all files)
- `npm run test:unit`: passed (3 test files, 9/9 tests passed in 226ms; verified noisy `#C8C8C8` normalization & centering, SHA-256 sensitivity, and bounded 20-step `CanvasHistory`)
- `npm run test:e2e`: passed (3/3 Playwright Chromium tests passed in 4.9s; verified raw sketch upload, Web Worker normalization, inpaint mask stroke painting, mask visibility toggle, backdrop switching, and zoom controls with 0 `console.error` / `pageerror`)
- `npm run build`: passed (`dist/assets/normalize.worker--mbxidJw.js` 5.23 kB, `dist/assets/index-CHcunJpR.js` 465.71 kB)
- `VITE_BASE_PATH=/nibgrid/ npm run build`: passed (`dist/index.html` 0.58 kB, `dist/assets/index-CvNySgcF.js` 465.72 kB)

---

## Milestone 3: Provider Interface, Prompt Compiler, Offline Mock Engine & Branching DAG (Screen 3B)

### Architectural Decisions & Trade-Offs

- **Deterministic Prompt Compiler (`src/domain/promptCompiler.ts`):** Compiled `ArtBible` projection, directional lighting, art mode, target dimensions, hex palette, style prompt, adherence directives, mandatory cutout isolation rules (`isolated on a solid flat contrasting background, centered full silhouette, no floor shadow`), `promptDelta`, and guaranteed cutout-safe negative tokens into reproducible prompts.
- **Pure Immutable DAG Engine (`src/domain/dag.ts`):** Implemented `validateDagAcyclicity`, `appendChildNode`, `forkFromAncestor`, `getAncestorPath`, `getChildren`, `deleteLeafNode`, and `buildDagTreeRows`. Enforces acyclicity, blocks self-parenting and non-leaf deletions, and preserves sibling branches safely.
- **Seeded Procedural Offline Mock Provider (`src/providers/mockProvider.ts`, `src/processing/proceduralSprite.ts`):** Built a Mulberry32-seeded procedural 2D sprite synthesizer using FNV-1a hashing (`sketchSha256 + seed + adherence + promptDelta + variantIndex`), sketch bounding-box/span-fill silhouette reconstruction, palette sorting/lighting shading, 1px silhouette outlines, and pure-TS PNG encoding so identical inputs return byte-identical PNGs across Node and Chromium. In `inpaint()` mode, strictly copies `baseImageRgba` and modifies only pixels where `mask[i] === 1`, leaving 100% of unmasked pixels byte-for-byte unchanged.
- **Branching Studio Dock & Compare Modal (`DagTreeDock.tsx`, `CompareSplitModal.tsx`, `GenerationInspector.tsx`):** Added full variant generation (`1` or `2`), masked inpainting creating child nodes (`maskBlobId` persisted in Dexie), ancestor forking, leaf deletion with orphan blob pruning, and a side-by-side split comparison modal.

### Verification Results

- `npm run typecheck`: passed (`tsc --noEmit`, 0 errors)
- `npm run lint`: passed (`eslint .`, 0 errors, 0 warnings)
- `npm run format:check`: passed (Prettier verified across all 35 source and test files)
- `npm run test:unit`: passed (4 test files, 13/13 tests passed in 258ms; verified Prompt Compiler invariants, DAG cycle/self-parent/leaf-deletion invariants, Mock Provider byte-identical determinism, and 100% unmasked pixel preservation during `inpaint()`)
- `npm run test:e2e`: passed (4/4 Playwright Chromium tests passed in 5.9s; verified full 3-level DAG flow: upload sketch -> generate 2 variants -> select Variant 2 -> mask stroke -> inpaint 3rd-level child -> side-by-side Compare modal -> `page.reload()` restoration of all 4 nodes from IndexedDB with 0 `console.error` / `pageerror`)
- `npm run build`: passed (`dist/assets/normalize.worker--mbxidJw.js` 5.23 kB, `dist/assets/index-DxPd88_i.js` 498.20 kB)
- `VITE_BASE_PATH=/nibgrid/ npm run build`: passed (`dist/index.html` 0.58 kB, `dist/assets/index-BlvFpcbT.js` 498.21 kB)

---

## Milestone 4: Live BYOK Cloud (Gemini) & Local ComfyUI Adapters

### Architectural Decisions & Trade-Offs

- **Structured Error Classification & Secret Redaction (`src/providers/errors.ts`):** Mapped HTTP `401`, `403`, `429`, `5xx`, timeouts, `AbortError`, and `TypeError` CORS/offline failures to typed `ProviderErrorCode` values. Added `redactSecrets()` across both `message` and `remediation` so user API keys and query credentials can never leak into UI error banners or console errors.
- **Pure-TS PNG Decoding via Web Streams (`src/processing/png.ts`):** Implemented `decodePngBytesToRgba()` supporting 8-bit Grayscale, RGB, Grayscale+Alpha, and RGBA PNGs with PNG scanline unfiltering (`0..4`) and `DecompressionStream('deflate')` so external Gemini and ComfyUI PNG outputs decode uniformly in both Chromium and Node Vitest without native dependencies.
- **Immutable ComfyUI Workflow Injection (`src/providers/comfyuiWorkflows.ts`):** Implemented recursive deep-clone token replacement (`{{PROMPT}}`, `{{NEGATIVE}}`, `{{SEED}}`, `{{SKETCH_FILENAME}}`, `{{MASK_FILENAME}}`, `{{DENOISE}}`) with adherence-to-denoise mapping (`strict: 0.55`, `balanced: 0.72`, `loose: 0.88`) and WebSocket + `/history/{prompt_id}` polling coordination in `ComfyUiProvider`.
- **Resilient Studio Error Handling (`SpriteStudio.tsx`, `ProviderVaultModal.tsx`):** Surfaced provider errors in a dismissible banner (`studio-error-banner`) while leaving the sketch canvas, `promptDelta`, and existing DAG nodes intact, and upgraded Provider Vault with Gemini/ComfyUI forms, workflow template editing, and live `testConnection()` diagnostics.

### Verification Results

- `npm run typecheck`: passed (`tsc --noEmit`, 0 errors)
- `npm run lint`: passed (`eslint .`, 0 errors, 0 warnings)
- `npm run format:check`: passed (Prettier verified across all source and test files)
- `npm run test:unit`: passed (5 test files, 17/17 tests passed in 274ms; verified PNG round-trip, Gemini `inlineData` serialization with Golden Refs & masks, ComfyUI non-mutating template injection, and HTTP/CORS error classification + secret redaction)
- `npm run test:e2e`: passed (5/5 Playwright Chromium tests passed in 6.6s; verified Gemini mocked generation + redacted 401 preservation and ComfyUI mocked upload/prompt/history/view/WebSocket + CORS abort hint)
- `npm run build`: passed (`dist/assets/index-CZSHvmbg.js` 519.65 kB)
- `VITE_BASE_PATH=/nibgrid/ npm run build`: passed (`dist/index.html` 0.58 kB, `dist/assets/index-CgP5Yhbu.js` 519.66 kB)

---

## Milestone 5: Client-Side Deterministic Post-Processing Stack (Screen 4A)

### Architectural Decisions & Trade-Offs

- **Pure-TS Post-Processing Pipeline (`src/processing/`):** Separated every pixel transformation (`backgroundKey.ts`, `alphaCleanup.ts`, `paletteQuantize.ts`, `resampleAndTrim.ts`, `pipeline.ts`) from DOM APIs so Vitest asserts exact pixel invariants in Node. Placed OKLab palette quantization _after_ resampling so Area-Average box downscaling never re-introduces off-palette intermediate RGB values.
- **Premultiplied Area-Average & Inverse-Distance Defringing:** Area-average downscaling accumulates premultiplied RGB weighted by pixel alpha to prevent dark edge halos around transparent borders, while `defringeInteriorRgb()` replaces edge RGB channels (`0 < alpha < 255`) using inverse-distance weighted averages from opaque interior neighbors (`alpha === 255`) within 2px.
- **Single-Threaded WASM / Lazy WebGPU Cutout (`postprocess.worker.ts`):** Dynamically imports `@huggingface/transformers` only when `Local AI Cutout` is selected and locks `env.backends.onnx.wasm.numThreads = 1` with `env.useBrowserCache = true`, avoiding `Cross-Origin-Embedder-Policy: require-corp` headers that would block live BYOK `fetch()` calls.
- **Orphan Blob Tracking (`database.ts`):** Added `processedBlobId` tracking in `cleanupOrphanedBlobsInTx()` so iterative post-processing updates prune superseded processed blobs cleanly from IndexedDB.

### Verification Results

- `npm run typecheck`: passed (`tsc --noEmit`, 0 errors)
- `npm run lint`: passed (`eslint .`, 0 errors, 0 warnings)
- `npm run format:check`: passed (Prettier verified across all files)
- `npm run test:unit`: passed (6 test files, 21/21 tests passed in 306ms; verified flood-fill cutout, `#102040` edge defringing, 100% OKLab palette snapping, and auto-trim / `64×64` resample / `50×70 -> 64×128` PoT padding)
- `npm run test:e2e`: passed (6/6 Playwright Chromium tests passed in 9.4s; verified Mock generation -> Post-Process Inspector -> Fast Color-Key + Defringe + Palette Snap + `64×64` Nearest-Neighbor -> `alpha === 0` at corner `(0, 0)`)
- `npm run build`: passed (`dist/assets/postprocess.worker-BI3peHzk.js` 10.91 kB, `dist/assets/index-9jg6mFo6.js` 551.78 kB)
- `VITE_BASE_PATH=/nibgrid/ npm run build`: passed (`dist/index.html` 0.58 kB, `dist/assets/index-DN_lqCva.js` 551.80 kB)

---

## Milestone 6: Pivot Editor, Reproducible Recipe Export & Offline PWA Release (Screen 4B)

### Architectural Decisions & Trade-Offs

- **Synchronous Export Fallback Against Debounce Races (`PostProcessInspector.tsx`):** Worker preview updates debounce by 60ms so interactive sliders remain fluid. When clicking **Download PNG**, **Download ZIP**, or **Export to Local Folder**, `getExportArtifact()` checks whether `processedArtifactRef` matches the current `pipelineKey` and computes `runPostProcessPipeline()` on demand if a debounced update is still in flight, guaranteeing exported pixels and `asset.recipe.json` metadata never drift.
- **Zero-Key Recipe Validation (`src/export/recipeBuilder.ts`):** Validated `asset.recipe.json` (`schemaVersion: "1.0.0"`) with strict Zod schemas (`AssetRecipeSchema`) and explicit regex checks ensuring API keys (`AIza...`, `sk-...`, `apiKey`) are never serialized into exported archives.
- **Base-Path-Aware Offline Service Worker (`vite.config.ts`):** Built a Vite `generateBundle` plugin emitting `dist/sw.js` that precaches all static HTML, JS, CSS, Worker, manifest, and SVG icon assets under `VITE_BASE_PATH` (`/` locally or `/nibgrid/` on GitHub Pages) while intentionally excluding optional 26.8 MB `.wasm` runtimes from install-time precache and bypassing cross-origin requests.
- **Studio Ergonomics (`SpriteStudio.tsx`):** Added non-intrusive keyboard shortcuts (`B` brush, `E` eraser, `M` mask toggle, `G` pixel grid, `Space` pan hold, `Ctrl/Cmd+Z` undo, `Ctrl/Cmd+Shift+Z` redo) gated cleanly when typing in form controls.

### Verification Results

- `npm run typecheck`: passed (`tsc --noEmit`, 0 errors)
- `npm run lint`: passed (`eslint .`, 0 errors, 0 warnings)
- `npm run format:check`: passed (Prettier verified across all files)
- `npm run test:unit`: passed (7 test files, 23/23 tests passed in 353ms; verified `AssetRecipeSchema` validation, zero secret leakage, and `fflate` ZIP round-trip with exact 8-byte PNG signature `89 50 4E 47 0D 0A 1A 0A`)
- `npm run test:e2e`: passed (8/8 Playwright Chromium tests passed in 11.0s; verified full zero-to-export journey including `Bottom-Center` pivot `(0.5, 1.0)` + `64×64` ZIP download inspection and full offline PWA reload -> Sketch -> Mock Generate -> Post-Process -> ZIP Export under `context.setOffline(true)`)
- `npm run build`: passed (`dist/sw.js` 1.71 kB, `dist/assets/index-QZYBrVyS.js` 575.20 kB)
- `VITE_BASE_PATH=/nibgrid/ npm run build`: passed (`dist/sw.js` 1.81 kB, `dist/assets/index-B2Z6U39k.js` 575.24 kB)

---

## Post-M6 Hardening & QA Audit Ledger (Phases 1–4)

### Phase 1: Memory, Graphics & IndexedDB Leak Hunt (`184fac8`)

- **Centralized Reference-Counted Blob URL Cache (`src/ui/components/blobUrlCache.ts`, `src/ui/components/BlobImage.tsx`):** Added `acquireBlobUrl` / `releaseBlobUrl` ref-counting keyed by `blobId`, revoking `URL.createObjectURL()` immediately when consumer count drops to zero (including safe cancellation if unmounted while an IndexedDB fetch is in flight). Also shortened export download revocation delay (`src/export/zipPackager.ts`) from `1000ms` to `100ms`.
- **Canvas & `ImageBitmap` Disposal (`src/ui/studio/SpriteStudio.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Zeroed temporary scratch `<canvas>` buffers (`width = 0; height = 0`) alongside `bitmap.close()` in `finally` blocks during image decode. Verified singleton Web Workers transfer underlying `ArrayBuffer`s (`[copy.buffer]`, `[result.rgba.buffer, result.pngBytes.buffer]`) and `CanvasHistory` caps at 20 `Uint8ClampedArray` clones with zero detached DOM elements.
- **Transactional IndexedDB Orphan Sweep (`src/db/database.ts`, `src/store/useAppStore.ts`):** Added `findOrphanBlobIds(db)`, invoked `cleanupOrphanedBlobsInTx()` inside `saveSpriteNode()` when existing nodes overwrite/replace blobs, added startup GC in `initialize()`, and lifted `studioAdherence` / `studioVariantCount` into project-scoped Zustand state so inspecting nodes no longer resets user parameters on return.
- **Verification:** Added `tests/unit/audit-leaks.test.ts` (2 tests) and `tests/e2e/audit-memory.spec.ts` (15 consecutive Generate → Inspect → Post-Process → Delete cycles asserting bounded unrevoked object URLs and zero console/page errors).

### Phase 2: Concurrency, Cancellation & Adversarial Edge Cases (`76fb39e`)

- **Monotonic Worker Request Guard (`src/workers/postprocessClient.ts`, `src/ui/inspector/PostProcessInspector.tsx`):** Added `createMonotonicRequestGuard()` to tag every debounced post-process request with an increasing token; stale out-of-order worker completions, progress updates, and Dexie node writes are deterministically dropped, and enabling Palette Snap on an empty Art Bible renders `empty-palette-snap-hint`.
- **Generation/Inpaint Cancellation & Cross-Project Isolation (`src/ui/studio/GenerationInspector.tsx`, `src/ui/studio/SpriteStudio.tsx`):** Added `cancel-generation-btn` (`onCancel`), aborted `generationAbortRef` automatically on unmount or `activeProject?.id` switch, handled `ProviderError` `'ABORTED'` cleanly without error banners, and deferred `maskBlob` Dexie writes in `handleInpaint` until after `adapter.inpaint()` resolves so cancelled inpaints never orphan mask blobs.
- **ComfyUI Workflow Validation & Pure-TS Fuzz Guards (`src/providers/comfyuiWorkflows.ts`, `src/ui/hub/ProviderVaultModal.tsx`, `src/processing/normalize.ts`, `src/processing/resampleAndTrim.ts`):** Exported `validateComfyUiWorkflowTemplate()` rejecting malformed JSON, non-API UI graphs missing `class_type`/`inputs`, or templates omitting `{{PROMPT}}`; hardened `estimateBackgroundLuminance` (`Math.max(1, ...)`) for `1×1` images and added dimension checks in `resampleRgba` / `autoTrimTransparent`. Confirmed zero `console.*` / `localStorage` / `sessionStorage` leaks in `src/`.
- **Verification:** Added `tests/unit/audit-edge-cases.test.ts` (5 tests) and `tests/e2e/audit-concurrency.spec.ts` (2 tests).

### Phase 3: Visual Polish, Pixel-Art Fidelity & Studio Ergonomics (`486ab0f`)

- **Mode-Aware Canvas Crispness (`src/ui/studio/SpriteStudio.tsx`, `src/ui/studio/DagTreeDock.tsx`, `src/ui/studio/CompareSplitModal.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Propagated `activeProject.artBible.artMode` (`pixel-art` vs `hd-2d`) to `imageSmoothingEnabled`, CSS `imageRendering` (`pixelated` vs `auto`), `DagTreeDock` thumbnails, and `CompareSplitModal` previews.
- **Exact Processed Pivot Alignment (`src/ui/inspector/PostProcessInspector.tsx`):** Sized the comparator stage directly from `processedSize` rather than `Math.max(rawSize, processedSize)` so `pivot-crosshair` aligns within `<= 2px` even after downscaling (e.g. `64×64`) or auto-trimming.
- **Responsive Flex/Grid Containment & Accessibility (`src/App.tsx`, `SpriteStudio.tsx`, `GenerationInspector.tsx`, `PostProcessInspector.tsx`):** Added `overflow-x-hidden` and `min-w-0` / `minmax(0, 1fr)` track sizing across studio/inspector split panes plus `aria-pressed` attributes on Studio tool buttons.
- **Verification:** Added `tests/e2e/audit-visual-polish.spec.ts` checking `scrollWidth <= innerWidth` across `1440×900`, `1280×720`, and `1024×768` viewports on all 4 screens, `"b e m g"` keyboard shortcut isolation, `pixelated` canvas styling, `Bottom-Center` crosshair alignment, and captured + inspected screenshots in `test-results/polish-screenshots/`.

### Phase 4: Final Release Gate & Documentation

- Updated `README.md` with browser compatibility notes (File System Access API vs `.zip` fallback, WebGPU vs single-threaded WASM cutout, zero-server credential isolation).
- Verified `VITE_BASE_PATH=/nibgrid/` build output (`dist/index.html`, `dist/manifest.webmanifest`, `dist/sw.js`) contains zero unprefixed root `/assets/` links.
- Final verification gate: `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:unit` (9 files, 30/30 tests), `npm run test:e2e` (12/12 Playwright Chromium tests), `npm run build`, and `VITE_BASE_PATH=/nibgrid/ npm run build` all pass with zero errors and zero warnings.

---

## Google Antigravity IDE / Agent Integration

- **Google Antigravity IDE / Agent Handoff Adapter (`src/providers/antigravityProvider.ts`, `src/db/database.ts`, `src/providers/registry.ts`):** Added built-in `antigravity-agent` provider kind alongside `offline-mock`, exposing structured Style-Locked Markdown brief generation (`buildAntigravityPromptBrief`), clipboard brief copy, sketch PNG export, direct PNG file import into the DAG (`src/ui/studio/GenerationInspector.tsx` & `SpriteStudio.tsx`), and programmatic `window.__NIBGRID_AGENT_BRIDGE__` (`getBrief`, `getState`, `importPngBase64`).
- **Workspace Customizations (`AGENTS.md`, `GEMINI.md`, `.agents/skills/nibgrid-agent-workflow/`):** Added Antigravity Customization System rules and progressive-disclosure workflow skill + isolated `--new-window` Chromium verification script (`scripts/verify-isolated-browser.mjs`) with deterministic `try / finally` cleanup and zero session leakage.

## Animated GIF89a & Spritesheet Studio

- **Pure-TS GIF89a Encoder & Spritesheet Strip Compositor (`src/processing/gif.ts`):** Implemented pure TypeScript LZW GIF89a encoding (`minCodeSize = 8`, `NETSCAPE2.0` infinite looping, GCE transparency + disposal `2`, deterministic 256-entry GCT mapping, `pingPong` loop expansion) and horizontal spritesheet strip packing testable cleanly inside Node/Vitest.
- **Animation & GIF Studio UI (`src/export/animationExporter.ts`, `src/ui/studio/AnimationStudioModal.tsx`, `DagTreeDock.tsx`, `SpriteStudio.tsx`):** Added timeline frame ordering/adding/removing, `1–24 FPS` preview playback, Ping-Pong toggle, Onion Skin canvas overlay, auto color-key cutout + OKLab Art Bible palette snap, downloadable looping `.gif` + spritesheet `.png` export, and `exportAnimatedGifBase64()` on `window.__NIBGRID_AGENT_BRIDGE__`.
- **2D Platformer Red Cat Warrior Animation Demo (`docs/demo/` & `README.md`):** Generated a 3-frame `64×64` Idle → Mid-Charge Ignited Flare → Overcharged Cyan Slash Arc sequence (`4` ping-pong steps at `6 FPS`), verified GIF89a (`3.2 KB`) and `192×64` horizontal spritesheet export via isolated Playwright headless Chromium, and documented the full walkthrough in `README.md`.

## Milestone 7: Pixel-Art Foundry (De-Mixel, Orphan Cleaner & OKLab Sel-Out)

- **Pure-TS Foundry Passes (`src/processing/types.ts`, `demixel.ts`, `orphanCleaner.ts`, `selOut.ts`):** Implemented L1 gradient autocorrelation De-Mixel grid detection + phase alignment, 4-connected BFS alpha island purging + interior 1px pepper despeckling, and OKLab 3×3 Sobel-normal directional `outer`/`inner` Sel-Out outlining with palette swatch locking.
- **Pipeline, Worker & Screen 4 UI (`src/domain/schemas.ts`, `pipeline.ts`, `postprocess.worker.ts`, `PostProcessInspector.tsx`):** Extended `PostProcessConfigSchema` with backward-compatible defaults, wired De-Mixel / Orphan / Sel-Out into `postprocess.worker.ts` and Screen 4 (`pp-demixel-badge`, `pp-orphan-badge`), and verified pixel invariants and recipe persistence via `tests/unit/m7-pixel-foundry.test.ts` and `tests/e2e/m7-pixel-foundry.spec.ts`.

## Milestone 8: WebGL2 2D Normal Map Generator & Live Point-Light Preview

- **Exact Alpha EDT & CPU Fallback Baker (`src/processing/distanceField.ts`):** Implemented `O(W·H)` Felzenszwalb–Huttenlocher EDT (`computeExactAlphaEdt`, `computeBevelHeightmap`) and `bakeNormalMapCpu` supporting `spherical-dome`, `smoothstep`, and `linear` bevel profiles plus OpenGL (`+Y`) and DirectX (`-Y`) normal Y-axis conventions.
- **2-Pass WebGL2 Controller & Screen 4B (`src/webgl/shaders/*.glsl`, `normalMapRenderer.ts`, `NormalMapPreview.tsx`):** Built zero-VBO FBO Sobel normal baking and interactive cursor-tracked Blinn-Phong point-light preview (`Lit`, `Normal`, `Height`, `Split`) with explicit `.dispose()`, `<slug>_n.png` ZIP/FS export (`zipPackager.ts`, `recipeBuilder.ts`, `fsAccess.ts`), and regression tests (`tests/unit/m8-normal-edt.test.ts`, `tests/e2e/m8-normal-webgl.spec.ts`).

## Milestone 9: MLS Puppet-Warp 2D Micro-Animator (Screen 4C)

- **Pure-TS MLS Solver, Mesh Builder & Cyclic Presets (`src/processing/mlsWarp.ts`, `spriteMesh.ts`, `animPresets.ts`):** Implemented Rigid/Similarity 2D MLS deformation (`positions` + per-vertex `rotations`), `4px`/`8px` alpha-clipped quad mesh construction with 1-cell silhouette halo + barycentric CPU fallback, and 4 closed-loop motion presets (`idle-breathe`, `wind-sway`, `hit-recoil`, `squash-stretch`).
- **WebGL2 Animator & Strip Export (`src/webgl/shaders/puppet.{vert,frag}.glsl`, `puppetRenderer.ts`, `PuppetWarpEditor.tsx`, `PostProcessInspector.tsx`):** Built interactive pin rigging/drag-preview, onion skinning, `Re-Lock Pixel Polish`, persistent `SpriteNode.puppetAnim`, `<slug>_<anim>_strip.png` + `.json` ZIP packaging, and full Vitest + Playwright verification (`tests/unit/m9-mls-warp.test.ts`, `tests/e2e/m9-puppet-warp.spec.ts`).

## Milestone 10: Google Antigravity Loopback Bridge & `.agents/skills/nibgrid`

- **Stateful Bridge Provider (`src/providers/bridgeContract.ts`, `antigravityBridgeProvider.ts`, `errors.ts`, `schemas.ts`):** Added `'antigravity-bridge'` provider kind, `GenerationMeta` `interactionId` / `interactionExpiresAt` / `usedStatefulChain` fields, `sessionStorage` ephemeral token storage with `nbg_...` redaction, 60s-TTL stateful vs. stateless chain fallback, and Provider Vault + Studio UI (`ProviderVaultModal.tsx`, `GenerationInspector.tsx`, `SpriteStudio.tsx`).
- **Critique Loop & Workspace Skill (`.agents/skills/nibgrid/SKILL.md`, `scripts/nibgrid_bridge.py`):** Authored the Art Director skill and zero-dep `127.0.0.1:4188` loopback daemon (strict Origin allowlist + `Access-Control-Allow-Private-Network: true` + `--mock` mode) and verified stateful chaining, critique delta UI, and `401` token redaction (`tests/unit/m10-antigravity-bridge.test.ts`, `tests/e2e/m10-bridge-e2e.spec.ts`).

## Milestone 11: MaxRects Atlas Packer & Godot 4 / Phaser 3 / PixiJS v8 Exporter

- **Pure-TS Packer, Deduplicator & Exporters (`src/processing/maxRects.ts`, `atlasCompositor.ts`, `src/export/atlasExporters.ts`):** Implemented BSSF MaxRects bin packing across 1..N pages, FNV-1a trimmed frame deduplication, clamped 1–2px edge extrusion, lockstep `_n.png` normal atlas compositing over `(128, 128, 255, 0)` gutters, rotation locking, and PixiJS v8 JSON, Phaser 3 Multiatlas JSON, and Godot 4 `.tres` exporters.
- **Screen 5 Atlas Workshop (`src/ui/atlas/AtlasWorkshop.tsx`, `useAppStore.ts`, `App.tsx`):** Added `#/project/:id/atlas` routing, sprite & Puppet-Warp loop selection, live packed canvas + UV bounds overlay + Albedo/Normal switcher, multi-engine ZIP bundling, and full Vitest + Playwright verification (`tests/unit/m11-atlas-packer.test.ts`, `tests/e2e/m11-atlas-e2e.spec.ts`).

---

## Post-M11 Hardening Ledger

### Audit Phase 1: WebGL2 Context-Loss, Recovery & GPU Memory Leak Prevention

- **Shared Lifecycle & Zero-Leak Helpers (`src/webgl/glUtils.ts`):** Extracted shared shader compilation (with immediate `detachShader` + `deleteShader`), texture filter setters, `checkWebGlNoError` (asserting `gl.getError() === gl.NO_ERROR` while tolerating async `CONTEXT_LOST_WEBGL`), and `WeakMap`-backed `WEBGL_lose_context` handle caching so StrictMode remounts recover cleanly while unmounts release GPU slots immediately.
- **Deterministic Recovery (`src/webgl/normalMapRenderer.ts`, `src/webgl/puppetRenderer.ts`, `NormalMapPreview.tsx`, `PuppetWarpEditor.tsx`):** Attached `webglcontextlost` (`event.preventDefault()`, halting `requestAnimationFrame` loops, raising transient restore status without permanently downgrading to CPU) and `webglcontextrestored` (recompiling programs, rebuilding VAOs/VBOs/FBOs/textures, re-uploading cached assets, and redrawing), enforced `MAX_TEXTURE_SIZE` checks, paused `PuppetWarpEditor` playback when `document.hidden === true`, and guaranteed full GPU resource disposal + `WEBGL_lose_context.loseContext()` on `.dispose()`.
- **Verification (`tests/e2e/audit-webgl-leaks.spec.ts`):** Verified 10 consecutive **Post-Process → Normal Map → Puppet Warp → Atlas Workshop** cycles keep active WebGL2 contexts `<= 2` with zero warnings or `pageerror`s, and forced `loseContext()` → `150ms` → `restoreContext()` recovery succeeds cleanly on both Normal Map and Puppet Warp.

### Audit Phase 2: Loopback Bridge Security, Cross-Module Integrity & Edge Cases

- **Loopback Bridge Hardening (`.agents/skills/nibgrid/scripts/nibgrid_bridge.py`):** Restricted server binding strictly to loopback addresses (`127.0.0.1`, `localhost`, `::1`), switched token comparison explicitly to `hmac.compare_digest`, enforced `MAX_BODY_BYTES = 25 * 1024 * 1024` returning HTTP `413 Payload Too Large` before buffering oversized bodies, and added `--token` + `create_bridge_server()`.
- **Solver, Packer & Secret Guards (`src/processing/mlsWarp.ts`, `src/providers/errors.ts`, `src/export/atlasExporters.ts`, `src/ui/atlas/AtlasWorkshop.tsx`):** Sanitized `solveMlsMesh` against coincident/extreme/Float32-overflowing pins (zero `NaN`/`Infinity`), normalized `.tres` paths to `/` with integer `Rect2(...)` bounds, caught oversized atlas packing errors into `atlas-error-banner` + locked `allowRotation` off for Godot/Normals, and enforced secret redaction inside `ProviderError`'s constructor.
- **Verification (`tests/unit/audit-m7-m11-edges.test.ts`, `tests/unit/test_nibgrid_bridge.py`):** Verified full M7 → M8 → M9 → M11 pipeline integrity, MLS coincident/extreme bounds, oversized sprite rejection, Godot `.tres` hygiene, secret redaction, and all 6 Python bridge security assertions (`ValueError` on `0.0.0.0`, `401`, `403`, `413`, `OPTIONS` PNA preflight, stateful chaining).

### Audit Phase 3: Visual Polish, High-DPI Precision & Screen 5 UX

- **Pixel-Art Fidelity & Screen 5 Interaction (`NormalMapPreview.tsx`, `PuppetWarpEditor.tsx`, `AtlasWorkshop.tsx`):** Preserved aspect ratios across interactive canvases (`canvasRef.getBoundingClientRect()`) for `<= 1px` pin accuracy under `devicePixelRatio = 2`, enforced `gl.NEAREST` and `imageSmoothingEnabled = false` in pixel-art mode with integer CSS pixel zoom on packed atlas previews, added extrusion + UV rect overlays, and added canvas click-to-highlight card selection (`data-highlighted`).
- **Verification (`tests/e2e/audit-m7-m11-polish.spec.ts`):** Verified zero horizontal overflow across `1440×900`, `1280×720`, and `1024×768` viewports, inspected Screen 4B/4C/5 screenshots in `test-results/polish-m11/`, verified `Alt+Wheel` `normal-light-z-readout` updates without page scrolling, verified `devicePixelRatio = 2` pin placement accuracy (`<= 1px`), and audited `VITE_BASE_PATH=/nibgrid/` build output (`dist/index.html`, `dist/manifest.webmanifest`, `dist/sw.js`).

### Audit Phase 4: Final Release Gate

- Verified `npm run typecheck`, `npm run lint`, `npm run format:check`, `npm run test:unit` (15 files, 51/51 tests), `python3 -m unittest tests/unit/test_nibgrid_bridge.py -v` (6/6 tests), `npm run test:e2e` (21/21 Playwright tests), and `VITE_BASE_PATH=/nibgrid/ npm run build` all pass cleanly.

---

## Milestone 12A: Seamless Tile 50% Wrap-Offset & Auto-Masking Workflow

- **Pure-TS Toroidal Math (`src/processing/seamlessTile.ts`):** Implemented `wrapOffsetBuffer` (exact involution across even and odd dimensions), `generateCrossSeamMask` (configurable seam band width, deterministic trig edge jitter, `tileX`/`tileY` flags, and strict outer 2px border lock), `computeSeamContinuity`, and separable toroidal `flattenMacroLighting`.
- **Toroidal Normal Map Synergy (`src/webgl/glUtils.ts`, `normalMapRenderer.ts`, `distanceField.ts`, `NormalMapPreview.tsx`):** Added `gl.REPEAT` wrapping + `bevelStrength = 0` when sprites are flagged `isSeamlessTile: true`.
- **Screen 4D Seamless Tile Mode (`TileAndSliceWorkshop.tsx`, `PostProcessInspector.tsx`, `schemas.ts`, `recipeBuilder.ts`):** Wired live `1×1` mask preview + `3×3` tiled preview wall, continuity score badge, guided **Wrap 50% → Seam Inpaint → Un-Wrap & Commit Node** workflow into the Sprite DAG, and `seamlessTile` recipe persistence.
- **Verification:** Verified via `tests/unit/m12a-seamless-tile.test.ts` and `tests/e2e/m12a-seamless-tile.spec.ts`.

## Milestone 12B: Visual 9-Slice UI Panel Workshop & Engine Exporters

- **Pure-TS 9-Slice Core & Exporters (`src/processing/nineSlice.ts`, `src/export/nineSliceExporters.ts`):** Implemented `autoDetectNineSliceMargins`, corner-exact `renderNineSlice` (`stretch`/`tile` edges, `stretch`/`tile`/`transparent` center), Godot 4 `StyleBoxTexture` `.tres`, Phaser 3 JSON, and PixiJS v8 JSON exporters, wired into `SpriteNode`, `AssetRecipe`, `PostProcessInspector`, and `AtlasWorkshop` (`packageAtlasZip`).
- **Screen 4D 9-Slice Mode (`src/ui/inspector/TileAndSliceWorkshop.tsx`):** Built 1px integer draggable cyan/magenta margin guides, symmetry locks (`Lock L=R`, `Lock T=B`), auto-detect button, live 4-target Stress-Test Matrix (`240×48`, `72×220`, `180×180`, and resizable box), and 1-click ZIP bundle export.
- **Verification:** Verified via `tests/unit/m12b-nine-slice.test.ts` and `tests/e2e/m12b-nine-slice.spec.ts`.

## Milestone 12C: Indexed Palette-Swap & 1D/Stacked LUT Exporter

- **Pure-TS Indexed Palette & OKLCH LUT Engine (`src/processing/paletteLut.ts`):** Implemented `countUniqueOpaqueColors`, `quantizeBufferToMaxColors` (`<= 256` OKLab color reducer), `extractIndexedSprite`, OKLCH ramp clustering (`clusterPaletteRamps`), identity-preserving OKLCH ramp evaluation (`evaluatePaletteVariant`), `encodeLutBuffer`, and `decodeIndexedSprite`.
- **Engine Shader Generators (`src/export/lutShaders.ts`):** Implemented `generateGodotPaletteSwapShader` (`filter_nearest`, half-texel `(palette_idx + 0.5)` lookup, flash uniforms) and `generatePixiPaletteSwapFilterTs` (PixiJS v8 `scaleMode = 'nearest'` + un-premultiplied UV lookup).
- **Screen 4E Workshop & Recipe Persistence (`src/ui/inspector/PaletteLutWorkshop.tsx`, `PostProcessInspector.tsx`, `schemas.ts`, `recipeBuilder.ts`):** Added **Palette-Swap & LUT** tab with 1-click `> 256`-color quantization, variant/preset manager, OKLCH Hue/Chroma/Lightness/Temperature sliders, per-swatch overrides, live `N×M` LUT strip preview, Stacked vs. Single-row toggle, `AssetRecipe.paletteLut` metadata, and 1-click ZIP export.
- **Verification:** Verified via `tests/unit/m12c-palette-lut.test.ts`, `tests/e2e/m12c-palette-lut.spec.ts`, and the full Milestone 12 regression & production build suite.

## Milestone 13: 1× Game Scale Sandbox

- **Pure-TS Procedural Biomes, Contrast Telemetry & Combat Juice (`src/processing/sandboxBiomes.ts`, `src/processing/sandboxContrast.ts`, `src/processing/sandboxState.ts`):** Implemented 5 deterministic `64×64` tiling biomes (`dark-dungeon`, `urban-asphalt`, `sunlit-meadow`, `neutral-checker`, `bright-snow`) + side-scroller parallax sets, Rec.709 1px silhouette contour contrast audits (`Strong`/`Moderate`/`Weak` + actionable Sel-Out hints), and a `dt <= 50ms`-clamped state machine (`40ms` hitstop, `110ms` flash decay, shake, knockback, and animation frame clock).
- **Zero-Allocation Canvas2D Engine & Screen 4F UI (`src/ui/inspector/sandboxEngine.ts`, `src/ui/inspector/GameSandbox.tsx`):** Built a disposable Canvas2D virtual-camera engine (`320×180`, `480×270`, `640×360` at `1×`–`4×` integer scale with zero WebGL2 allocations), `Normal`/`Value Check`/`Silhouette` lenses, grounded pivot-flipped contact shadows, `visibilitychange` pause + rAF cancellation on unmount, and input-isolated keyboard controls (`WASD`/Arrows, `F`, `H`, `Space`).
- **M9/M12 Synergy & Screen 3 Quick-Launch (`PostProcessInspector.tsx`, `PaletteLutWorkshop.tsx`, `DagTreeDock.tsx`, `SpriteStudio.tsx`, `useAppStore.ts`, `App.tsx`):** Bound M9 Puppet-Warp strips (`buildPuppetStripArtifacts`) and shared/persisted M12 LUT variant switching (`decodeIndexedSprite`) directly inside Screen 4F, and added a **"1× Preview"** pill in Screen 3's DAG dock routing straight to `#/project/:id/inspector/:nodeId?tab=sandbox`.
- **Verification:** Verified via `tests/unit/m13-game-sandbox.test.ts` and `tests/e2e/m13-sandbox-e2e.spec.ts` alongside the full unit, E2E, lint, typecheck, format, and GitHub Pages build suite.

## Milestone 14A: Pure-TS Procedural Synth, PCM Post-Processor & Google Audio Presets

- **Pure-TS Synth & PCM Post-Processor (`src/audio/proceduralSynth.ts`, `src/audio/pcmPostProcess.ts`, `src/audio/variations.ts`):** Implemented the deterministic Mulberry32 3-layer synth (Transient + FM/Subtractive Body + SVF Noise Tail), region cropping, zero-crossing silence trimming, K-weighted LUFS normalization with soft-knee true-peak limiting, equal-power seamless loop crossfading, RIFF/WAVE 16-bit encoder/decoder, and `1`/`4`/`6` anti-repetition variation generators.
- **Curated Google Audio Presets & ZIP Recipe Packager (`src/audio/googlePresets.ts`, `src/export/audioExport.ts`, `src/domain/schemas.ts`):** Added all 12 curated presets across Lyria 3/3.5, Gemini 3.8 TTS, and Gemini-to-Synth routes, extended `ProjectSchema` and `SpriteNodeSchema` with `audioBindings`, and implemented secret-redacted `AudioRecipeSchema` + `.zip` bundling.
- **Verification:** Verified via `tests/unit/m14a-audio-core.test.ts` alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build gate.

## Milestone 14B: Google Audio Provider, IndexedDB Audio Bank & Screen 6 UI

- **Google Audio Adapters & Synth Schema (`src/audio/synthResponseSchema.ts`, `src/audio/googleAudioProvider.ts`):** Added typed request builders and fetch orchestration for Lyria 3/3.5 Interactions API, Gemini 3.8 Flash/Flash-Lite TTS (`responseModalities: ["AUDIO"]`), and Gemini JSON → `ProceduralSfxParams` with single-key Provider Vault inheritance, transparent per-call cost badges, and secret-redacted HTTP diagnostics.
- **Audio Worker, Playback Engine & Dexie v2 Persistence (`src/workers/audio.worker.ts`, `src/workers/audioClient.ts`, `src/audio/playbackEngine.ts`, `src/db/database.ts`, `src/store/useAppStore.ts`):** Added transferable Web Worker execution, lazy headless-safe `AudioContext` auditioning/MP3 decoding, and `audioAssets` persistence with full cascade + orphan blob cleanup.
- **Screen 6 UI (`src/ui/audio/AudioFoundry.tsx`, `src/App.tsx`):** Built the **Audio Foundry** navigation screen with 12 clickable Google presets, vocal-tag warning chips, interactive Canvas2D waveform + Region Crop sliders, LUFS/Peak/Duration metering, Raw/Processed A/B toggle, project Audio Bank, and ZIP / File System Access export.
- **Verification:** Verified via `tests/unit/m14b-google-audio-db.test.ts`, `tests/e2e/m14b-audio-foundry.spec.ts`, and the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build suite.

## Milestone 14C: 1× Game Scale Sandbox & 9-Slice Audio-Visual Juice Binding

- **Sandbox Hit, Puppet-Warp Frame & BGM Bindings (`src/ui/inspector/sandboxEngine.ts`, `src/ui/inspector/GameSandbox.tsx`):** Added **Audio Juice** strip (`Hit SFX`, `Step / Frame SFX`, `BGM Loop`, `Mute`), synchronizing `H` hit-flash variation playback with `40ms` hitstop, M9 animation step triggers, and seamless looping background tracks cleanly cleaned up on unmount.
- **9-Slice Click SFX Auditioning (`src/ui/inspector/TileAndSliceWorkshop.tsx`):** Added **Click SFX** binding and tactile clickable matrix previews (`Wide Button`, `Tall Sidebar`, `Square Dialog`) backed by `patchProjectAudioBindings` in IndexedDB.
- **Verification:** Verified via `tests/e2e/m14c-sandbox-audio-binding.spec.ts` (including hard-reload persistence) and the full TypeScript, ESLint, Prettier, unit, Python bridge, E2E, and GitHub Pages production build gate.

## Milestone 15A: Pure-TS Vocal Sketch Analyzer & Contour-Following Synth

- **Pure-TS NSDF Pitch & Envelope Extraction (`src/audio/vocalAnalyzer.ts`):** Implemented 10ms hop analysis computing normalized `A(t)`, zero-crossing rate, clarity, and McLeod first-key-maximum NSDF `f0(t)` with parabolic lag interpolation + `extractMelodySummary()` MIDI/key/BPM inference.
- **Contour-Following Synth & Timbre Patch Schema (`src/audio/contourSynth.ts`, `src/audio/contourPatchSchema.ts`, `schemas.ts`, `audioExport.ts`):** Built `synthesizeFromContour()` + `generateContourVariations()` (voiced FM/sub vs. unvoiced SVF noise crossfading + scale snapping), 4 starter offline patches, Gemini JSON `CONTOUR_TIMBRE_RESPONSE_SCHEMA` clamping, and `audioSketch` persistence/export metadata.
- **Verification:** Verified via `tests/unit/m15a-vocal-and-contour.test.ts` alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build gate.

## Milestone 15B: AudioWorklet Mic Recorder, Multimodal Hum Router & Worker Integration

- **Inline Blob AudioWorklet Mic Recorder (`src/audio/micRecorder.ts`):** Implemented subpath-safe raw PCM mic capture (disabling echo/noise DSP, 10s max duration, live VU callbacks, and strict `track.stop()` / `URL.revokeObjectURL()` / `AudioContext.close()` teardown) alongside `ingestWavSketchBytes()`.
- **Multimodal Hum-to-Sound Router & Audio Worker (`src/audio/humToSoundProvider.ts`, `src/workers/audio.worker.ts`, `src/workers/audioClient.ts`):** Built request/fetch orchestration across `hum-to-timbre`, `hum-to-lyria` (injecting extracted BPM + dominant key), and `hum-to-tts` with API-key redaction, plus offloaded `analyze-vocal` and `contour` variation worker handlers.
- **Verification:** Verified via `tests/unit/m15b-hum-routing.test.ts` and the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build suite.

## Milestone 15C: Mic SketchPad UI, Pitch Ribbon & End-to-End Hum-to-Sandbox Loop

- **Interactive Pitch Ribbon & Mic SketchPad UI (`src/ui/audio/PitchRibbonCanvas.tsx`, `src/ui/audio/MicSketchPanel.tsx`, `src/ui/audio/AudioFoundry.tsx`):** Integrated Screen 6 `Mic Sketch` tab featuring cyan `65–1100 Hz` logarithmic pitch ribbons, amber unvoiced foley markers, hold-to-record `R` shortcut (isolated from focused text fields), `.wav` sketch upload, 6 quick intent chips, live `$0.00` contour sliders, A/B `My Hum` vs. `Transformed Sound` auditioning, IndexedDB `audioSketch` persistence, `.zip` provenance export (`sketchSha256`), and Sandbox `H` hit-flash SFX binding.
- **Verification:** Verified via `tests/e2e/m15c-hum-to-sound.spec.ts` alongside TypeScript, ESLint, Prettier, unit tests, Python loopback bridge unit tests, full Playwright E2E suite, and GitHub Pages production build.

## Milestone 16A: Pure-TS Marching Squares, Closed-Loop RDP & Convex Hull Schemas

- **Collision Geometry Extractor (`src/processing/collisionHull.ts`):** Implemented `(W+2)×(H+2)` zero-padded integer half-pixel Marching Squares (`traceMarchingSquaresContours`), antipodal-split closed RDP (`simplifyClosedPolygonRdp`), Andrew's Monotone Chain convex hull (`computeConvexHull`), shoelace area/convexity predicates (`polygonArea`, `isPolygonConvex`), capsule/AABB fitting, `maxVertices` budget relaxation, and `pivotPx` recentering (`extractCollisionHull`).
- **Schema & Recipe Integration (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `CollisionLayerShapeSchema` with `collider`/`hurtbox`/`hitbox` layer roles, sensor flags, capsule dimensions, and M9 `activeFrames` onto `SpriteNodeSchema` and `AssetRecipeSchema`.
- **Verification:** Verified via `tests/unit/m16a-collision-hull.test.ts` (square/pivot centering, concave L-shape vs convex hull, 8-vertex budget cap, edge-touching/empty guards, vertical capsule fitting) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build gate.

## Milestone 16B: Godot 4 & Matter.js / Phaser 3 Physics Exporters

- **Pure-TS Physics Exporters (`src/export/colliderExporters.ts`):** Implemented Godot 4 `ConvexPolygonShape2D` / `CapsuleShape2D` `.tres` formatting (`exportGodotColliderTres`), PhysicsEditor-compatible Phaser 3 / Matter.js fixture export (`exportMatterPhysicsJson`), individual sprite extra files (`buildColliderExportFiles`), and multi-sprite atlas export (`exportCombinedAtlasPhysicsJson`).
- **Screen 4 & Screen 5 Packaging (`src/ui/inspector/PostProcessInspector.tsx`, `src/ui/atlas/AtlasWorkshop.tsx`):** Wired `collisionShapes` persistence on `SpriteNode` and automatic bundling of `<slug>_collider.tres`, `<slug>_matter.json`, `collisionShapes` in `.recipe.json`, and `atlas_physics.json` in Screen 5 ZIP bundles.
- **Verification:** Verified via `tests/unit/m16b-collider-exporters.test.ts` alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build gate.

## Milestone 16C: Screen 4G Interactive Collider, Hitbox & Hurtbox Editor

- **Interactive Vector Overlay & Frame Sync UI (`src/ui/inspector/ColliderEditor.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/store/useAppStore.ts`):** Built Screen 4G (`Collider & Hitbox`) featuring semantic Collider/Hurtbox/Hitbox layers, Auto-Trace Silhouette & `8-Vertex Box2D Safe` preset, convexity guard badge, HiDPI-safe vertex drag/midpoint-insert/right-click-delete tools, M9 Puppet-Warp frame timeline scrubber with onion-skinning & per-frame active toggles, live Godot 4 `.tres` / Matter.js code previews, and IndexedDB persistence.
- **Verification:** Verified via `tests/e2e/m16c-collider-editor.spec.ts` (including `deviceScaleFactor: 2` HiDPI drag accuracy, ZIP bundle unpacking, and reload persistence) alongside the full TypeScript, ESLint, Prettier, unit, Python bridge, Playwright E2E, and GitHub Pages production build gate.

## Milestone 17A: Pure-TS Project Audit Engine & Art Bible Sync Hashing

- **Deterministic Sync Hashing & Audit Analyzers (`src/processing/projectAudit.ts`, `src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `PostProcessInspector.tsx`):** Implemented synchronous pure-TS `computeArtBibleHash()` + `recipeArtBibleHash` stamping on processed sprites/recipes, paired with `auditSpriteAsset()`, `auditAudioAsset()`, and `summarizeProjectAudit()` orchestrating M7 `detectPixelGrid()`, M13 `computeBiomeContrast()`, and M14 `measureApproxLufs()` with zero DOM dependencies.
- **Verification:** Verified via `tests/unit/m17a-project-audit.test.ts` (palette drift thresholds, 2× mixel detection vs. HD-2D bypass, stale Art Bible hash flagging, LUFS drift vs. clean clips, and weighted Readiness Score) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build gate.

## Milestone 17B: Deterministic Batch Recipe Runner, Cancellation & Rollback

- **Batch Dry-Run, Executor & Undo Engine (`src/processing/batchRunner.ts`):** Implemented `buildBatchDryRunSummary()`, atomic per-asset `executeBatchRecipePlan()` (`in-place` and `fork-children` modes covering palette sync, M7 Pixel Foundry, missing M16 `collider` auto-tracing preserving manual `hitbox`/`hurtbox` layers, LUT re-bake, and M14 silence trim + LUFS normalize), `AbortSignal` mid-run cancellation, and `rollbackBatchRun()` / `cleanupSupersededBatchBlobs()` orphan GC.
- **Verification:** Verified via `tests/unit/m17b-batch-runner.test.ts` (5-asset atomic batch completion, manual hitbox preservation, LUFS normalization, 2-of-6 cancellation + rollback, zero orphan blobs) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages production build gate.

## Milestone 17C: Screen 7 Project-Wide Asset Audit Matrix & Batch Runner UI

- **Screen 7 UI & Navigation (`src/ui/audit/AuditMatrixView.tsx`, `src/ui/audit/BatchRunnerDrawer.tsx`, `src/store/useAppStore.ts`, `src/App.tsx`):** Mounted the top-level **Audit** tab (`#/project/:id/audit`) displaying a weighted `0–100` Readiness Score, filter pills, dynamic Target Biome contrast auditing, 1-click jump-to-fix table cells, `$0.00 local compute` Batch Recipe Drawer with `AbortSignal` cancellation, Before → After Readiness banner, and session **Undo Batch** with automatic IndexedDB orphan cleanup.
- **Verification:** Verified via `tests/e2e/m17c-audit-batch-e2e.spec.ts` (3 sprites + quiet `-31.7 LUFS` audio clip, dynamic biome contrast updates, batch run raising Readiness Score to `97`, exact `Undo Batch` reversion, and hard-reload persistence) alongside Prettier, TypeScript, ESLint, unit tests, Python bridge unit tests, Playwright E2E, and GitHub Pages production build.

## Milestone 18A: Pure-TS Connected-Component Turnaround Slicer & Schemas

- **Connected-Component Slicer & Shared Pivot Framing (`src/processing/turnaroundSlicer.ts`):** Implemented iterative 4-connected BFS extraction (`detectTurnaroundSlots`) with speck filtering and centroid slot clustering (`2x2` quadrants and `1x4` strips), median-height scale normalization, bottom-center shared pivot blitting with endpoint-safe nearest-neighbor sampling (`sliceAndAlignTurnaround`), exact horizontal canvas mirroring (`flipBufferHorizontal`), and empty/zero-size guards.
- **Schema & Recipe Extensions (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `TurnaroundLayoutSchema`, `CardinalDirectionSchema`, and `TurnaroundMetaSchema` onto `SpriteNodeSchema` and `AssetRecipeSchema`.
- **Verification:** Verified via `tests/unit/m18a-turnaround-slicer.test.ts` (`2x2` & `1x4` extraction, floating crown merge + `2x2` speck purge, 12% height normalization & `sharedPivotPx.y - 1` alignment, exact East→West mirror, empty buffer guard) alongside Prettier, TypeScript, ESLint, unit tests, Playwright E2E, and GitHub Pages build.

## Milestone 18B: Orthographic Sheet Mode, Worker Slicing, Atomic Commit & Atlas Grouping

- **Sheet Prompt & Mock Generator (`src/domain/promptCompiler.ts`, `src/providers/types.ts`, `src/processing/proceduralSprite.ts`, `src/providers/mockProvider.ts`):** Added `sheetLayout` prompt compilation rules (`no grid lines`, `no text labels`, uniform character height) and deterministic `2x2` (`128×128`) / `1x4` (`256×64`) procedural sheet synthesis with a floating crown accessory and intentional +10% East height variance.
- **Worker Slicing & Atomic DAG Commit (`src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`, `src/domain/turnaroundCommit.ts`):** Added transferable `SLICE_TURNAROUND_SHEET` worker pipeline (`executeSliceTurnaroundJob` / `sliceTurnaroundInWorker`) and transactional `commitTurnaroundViews()` + `deleteTurnaroundDirectionGroup()` ensuring zero orphan blobs in IndexedDB.
- **Screen 3 & Screen 5 Integration (`GenerationInspector.tsx`, `SpriteStudio.tsx`, `DagTreeDock.tsx`, `AtlasWorkshop.tsx`):** Added `Single Sprite | Turnaround (2×2) | Turnaround (1×4)` Studio toggle, DAG turnaround/cardinal badges, and 1-click multi-direction group toggling in MaxRects Atlas Workshop.
- **Verification:** Verified via `tests/unit/m18b-turnaround-commit.test.ts` (prompt compilation, Mock 2x2 & 1x4 synthesis, worker slicing, atomic 4-view commit with aligned `pivotPx`, group/cascade delete leaving zero orphan blobs) alongside Prettier, TypeScript, ESLint, unit tests, Playwright E2E, and GitHub Pages build.

## Milestone 18C: Screen 4H Turnaround Slicer UI, Onion-Skin & Turntable Alignment

- **Screen 4H Interactive Slicer (`src/ui/inspector/TurnaroundSlicer.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/store/useAppStore.ts`):** Mounted the `Turnaround Slicer` inspector tab (`?tab=turnaround`, auto-focused on turnaround sheet nodes) with Worker-isolated BFS slot boxes (`#22C55E`/`#F59E0B`/`#38BDF8`/`#A855F7`), per-slot direction remapping, `Mirror East → West`, zero-allocation `35%` Onion-Skin stack + `1–6 FPS` Turntable playback anchored to `sharedPivotPx` with strict `document.hidden` / unmount rAF cleanup, and atomic **Commit 4 Linked Views** action jumping directly into Atlas Packer, 1× Sandbox, or Sprite Studio DAG.
- **Verification:** Verified end-to-end via `tests/e2e/m18c-turnaround-e2e.spec.ts` (2×2 sheet generation, 4 detected slot boxes & Onion-Skin canvas pixels, Mirror East → West, Turntable rAF lifecycle cleanup dropping active rAF count to `0` on tab switch, atomic 4-node DAG commit with shared `directionGroupId` & `pivotPx`, Screen 5 directional 1-click group toggle, and hard-reload IndexedDB persistence) alongside Prettier, TypeScript, ESLint, unit tests, Python bridge unit tests, Playwright E2E, and GitHub Pages build.

## Milestone 19A: Neutral Studio Chrome, `ScrubInput` & Floating `CanvasHud`

- **Neutral Dark Theme & Viewport-First Screen 4 (`src/styles/tokens.css`, `src/index.css`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Shifted Nibgrid chrome to color-neutral `#111113` / `#18181B` / `#222226` grays with warm `#E5A00D` studio accents, reclaimed the top canvas toolbar into a bottom-center floating `CanvasHud` (`src/ui/primitives/CanvasHud.tsx`), added Mid `#808` neutral backdrop alongside Checker/Dark/Light/Game Green, and narrowed the Screen 4A inspector into a collapsible `288px` drawer leaving `70%+` canvas area.
- **Scrubbable Numeric Controls (`src/ui/primitives/scrubMath.ts`, `src/ui/primitives/ScrubInput.tsx`, `ColliderEditor.tsx`):** Implemented `computeScrubbedValue()` (`0.1×` `Shift` precision, clamped step quantization) and interactive `ScrubInput` pills with pointer capture drag, arrow keys, and double-click inline numeric entry (`Enter`/`Escape`).
- **Verification:** Verified via `tests/unit/m19-ux-polish.test.ts` (`computeScrubbedValue` / `formatScrubValue`) and `tests/e2e/m19-ux-polish.spec.ts` (`1440×900`, `1280×720`, `1024×768` zero overflow, `>= 70%` canvas width, `ScrubInput` drag / `Shift+drag` / inline edit, and drawer collapse) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages build gate.

## Milestone 19B: Asset-Type-Aware Workspaces, `1×` PiP Biome Preview & `BeforeAfterWipe`

- **Asset Classification & Contextual Tab Bar (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/ui/inspector/workspaceTabs.ts`, `PostProcessInspector.tsx`):** Persisted `AssetClass` (`character | prop | tile | ui-panel | vfx`) on `SpriteNode` and `asset.recipe.json`, reducing Screen 4 header clutter by promoting class-relevant primary tabs (3 tabs for `ui-panel`) and tucking secondary tabs cleanly into `+ Tools` overflow.
- **Zero-WebGL2 `1×` PiP Biome Contrast Preview (`src/ui/inspector/PipBiomePreview.tsx`):** Mounted an always-on draggable `1×` Canvas2D biome preview reusing `generateBiomeTile()` and `computeBiomeContrast()` with live contrast ratio pill, biome cycling, and input-isolated `P` toggle.
- **Unified `BeforeAfterWipe` (`src/ui/primitives/BeforeAfterWipe.tsx`, `NormalMapPreview.tsx`, `PaletteLutWorkshop.tsx`):** Replaced duplicate split-pane logic across Screen 4A, Screen 4B (Flat vs. Lit Normal), and Screen 4E (Base vs. LUT Variant) with one pointer-captured `clip-path` wipe primitive supporting double-click `50%` reset and `\` toggle.
- **Verification:** Verified via `tests/unit/m19-ux-polish.test.ts` (`resolveInspectorTabs`, `inferAssetClass`) and `tests/e2e/m19-ux-polish.spec.ts` (`ui-panel` 3-tab collapse + reload persistence, `1×` PiP `P` toggle & zero WebGL2 check, `BeforeAfterWipe` drag/double-click/backslash) plus updated M12A/M12B/M14C E2E tests and the full build/lint/unit/E2E suite.

## Milestone 19C: `Cmd/Ctrl+K` Command Palette & Universal Drop Router

- **Command Palette & Fuzzy Matcher (`src/ui/command/commandRegistry.ts`, `src/ui/command/CommandPalette.tsx`, `src/App.tsx`):** Added `Cmd/Ctrl+K` and header `⌘K` quick-switcher powered by pure-TS `rankCommands()` (`"trc hull"` -> `Auto-Trace Convex Hull`), covering screen navigation, Inspector sub-tools, and live project sprites/audio assets with full keyboard navigation and clean focus restoration.
- **Universal Drag-and-Drop Router (`src/ui/command/UniversalDropOverlay.tsx`):** Added external `Files` drag detection across the workspace shell to route dropped images (Sprite Node, Golden Reference, 2×2 Turnaround Sheet, Top-8 Art Bible Palette Extractor) and audio clips into IndexedDB with zero orphan blobs on cancel/Escape.
- **Verification:** Verified via `tests/unit/m19-ux-polish.test.ts` (`rankCommands` fuzzy/prefix/asset tests) and `tests/e2e/m19-ux-polish.spec.ts` (`Control+k`, `"Audit"` -> Screen 7 navigation, `Escape` close, and strict input-focus isolation typing `p\` without firing `P` or `\` hotkeys) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages build gate.

## Milestone 20A: Pure-TS Auto-Tile Bitmask Gating, SDF Terrain Compositor & Schema

- **Pure-TS Terrain Compositor (`src/processing/autoTile.ts`):** Built zero-DOM `gateBlobMask()` (strictly 47 canonical Blob masks), `getCanonicalWang16Masks()`, `computeAutoTileGridMask()`, and deterministic seeded `composeAutoTileSheet()` packing `8×6` (`blob-47`) and `4×4` (`wang-16`) atlas sheets with `crisp-bevel`, `organic-overhang`, and `pixel-outline` edge treatments while enforcing square tile validation and 100% solid interior centers (`mask === 255` / `15`).
- **Schema & Recipe Integration (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `AutoTileConfigSchema` onto `SpriteNodeSchema` and `AssetRecipeSchema` for round-trip `.recipe.json` reproducibility.
- **Verification:** Verified via `tests/unit/m20a-autotile-core.test.ts` (exact 47 canonical masks, diagonal gating, `128×96` Blob-47 & `64×64` Wang-16 packing, opaque solid center under organic jitter, non-square guard, byte-identical determinism) alongside TypeScript, ESLint, Prettier, full unit suite, Playwright E2E, and production build.

## Milestone 20B: Godot 4 `TileSet` `.tres`, Tiled `.tsx` Exporters & Worker Offloading

- **Engine Terrain Exporters (`src/export/autoTileExporters.ts`):** Implemented `exportGodotTileSetTres()`, `exportTiledTsx()`, and `packageAutoTileZip()` emitting complete Godot 4 `.tres` peering-bit tilesets, Tiled XML `<wangsets>` (exact clockwise `N,NE,E,SE,S,SW,W,NW` `wangid` order), packed sheet PNGs, and Zod-validated `.recipe.json` metadata.
- **Dedicated Worker Pipeline (`src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Added `COMPOSE_AUTO_TILE_SHEET` with `executeComposeAutoTileJob()` and transferable `composeAutoTileInWorker()`.
- **Verification:** Verified via `tests/unit/m20b-autotile-exporters.test.ts` (Godot `.tres` Blob-47/Wang-16 peering bits, Tiled `.tsx` 47/16 `wangtile` generation, `fflate.unzipSync` PNG magic header & Zod recipe check, worker execution parity) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages build gate.

## Milestone 20C: Interactive Auto-Tile Paint-Test Workshop & Engine Bundle

- **Screen 4I Auto-Tile Terrain Generator (`src/ui/inspector/AutoTileWorkshop.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/store/useAppStore.ts`):** Registered `?tab=autotile` (promoted automatically for `tile` assets), mounted the interactive `12×8` left-paint/right-erase Canvas2D tilemap sandbox, added `Full Packed Sheet` vs. `Live 12×8 Paint Map` toggle, `ScrubInput` SDF inset/corner/jitter controls, Underlay Tile picker from project assets, IndexedDB persistence, and 1-click `.zip` Terrain Bundle export.
- **Verification:** Verified end-to-end via `tests/e2e/m20c-autotile-e2e.spec.ts` (reclassify to `tile`, clear & load sample map, interactive drag-paint, `Wang-16` 4×4 & `Blob-47` 8×6 sheet verification, Dexie save & reload persistence, and unpacked `.zip` PNG / Godot 4 `.tres` / Tiled `.tsx` / Zod `.recipe.json` validation) alongside the full final verification gate (Prettier, TypeScript, ESLint, unit tests, Python bridge unit tests, Playwright E2E, and production build).

## Milestone 21A: Pure-TS Barycentric Socket Binding, Per-Frame Mesh Tracker & Schema

- **Barycentric Socket Tracking Core (`src/processing/attachmentSockets.ts`):** Implemented zero-DOM rest-pose triangle binding (`bindSocketToRestMesh`), shortest-arc per-frame deformed position and tangent angle evaluation (`evaluateSocketAtFrame`, `evaluateSocketsAcrossFrames`), geometry conversion helpers (`extractMeshGeometry`, `interleavedPositionsToVec2`), and `sanitizeSocketName()`.
- **Schema & Recipe Provenance (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `SocketDefinitionSchema` (`^[a-z0-9_]+$`) onto `SpriteNodeSchema` and `AssetRecipeSchema`.
- **Verification:** Verified via `tests/unit/m21a-attachment-sockets.test.ts` (`(+10, -6)` + `+30°` rigid translation/rotation tracking within `±0.1px` / `±0.2°`, ±180° branch-cut wrapping, degenerate/out-of-triangle fallback, static null mesh fallback, and Zod schema validation) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages build gate.

## Milestone 21B: Godot 4, Phaser 3 & PixiJS Socket Exporters + Automatic ZIP Integration

- **Zero-DOM Engine Exporters (`src/export/socketExporters.ts`):** Implemented `exportGodotSocketsTscnSnippet()` (`Marker2D` nodes with pivot-relative `Vector2`, radians rotation, and multi-frame `AnimationPlayer` keyframe comments), `exportPhaserSocketsJson()`, `exportPixiSocketsJson()` (`rotationRad`, `angleDeg`, `scaleX: 1`, `scaleY: 1`), `buildUnifiedSocketsJson()`, and `buildSocketExportFiles()`.
- **ZIP Packager Integration (`src/export/zipPackager.ts`):** Updated `packageSpriteZip()` to automatically bundle `<slug>_sockets.json` whenever `recipe.sockets` is populated, computing rest-pose pivot-relative transforms when `evaluatedSocketsByFrame` is omitted and preserving any explicit override in `extraFiles`.
- **Verification:** Verified via `tests/unit/m21b-socket-exporters.test.ts` (Godot 4 `.tscn`, Phaser 3 JSON, PixiJS JSON, `fflate.unzipSync` ZIP round-trip with Zod `AssetRecipeSchema` check, and empty/static edge cases) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages build gate.

## Milestone 21C: Interactive Attachment Sockets Editor, Screen 4 Wiring & E2E Flow

- **Contextual Sockets Workspace (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Added `'sockets'` tab routing (primary on `'character'`, `'prop'`, and `'vfx'` classes while keeping `'ui-panel'` strictly at 3 primary tabs) and registered **"Open Attachment Sockets Editor"** in `Cmd/Ctrl+K`.
- **Interactive Socket Overlay & Screen 4 Persistence (`src/ui/inspector/SocketEditor.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Built zero-WebGL2 Canvas2D + SVG marker editor (`computeEvaluatedSocketsForSprite()`, preset & deduplicated custom IDs, `ScrubInput` base angle, `window`-captured HiDPI pointer drag, input-isolated `Delete`/`Backspace`, frame scrubber over `rasterizeDeformedMeshCpu()`, live Godot 4 / Phaser 3 / PixiJS preview tabs, explicit Dexie save, and `<slug>_sockets.json` + `.recipe.json` ZIP/folder emission).
- **Verification:** Verified end-to-end via `tests/e2e/m21c-sockets-e2e.spec.ts` (DPR 1 preset placement, marker drag, `Backspace` input isolation, exporter tab switching, Dexie save & reload persistence, `fflate.unzipSync` `<slug>_sockets.json` + `AssetRecipeSchema` validation, plus isolated `deviceScaleFactor: 2` HiDPI drag accuracy) alongside the full TypeScript, ESLint, Prettier, unit, Python bridge, Playwright E2E, and GitHub Pages build gate.

## Milestone 22A: Pure-TS 2D VFX Flipbook Synthesizer, FBM Noise & Schema

- **Pure-TS Flipbook Core (`src/processing/vfxFlipbook.ts`):** Implemented zero-DOM seeded PRNG (`mulberry32`), 2D smooth value & 3-octave FBM noise (`valueNoise2d`, `fbm2d`), 5 VFX archetypes (`'sparks'`, `'dust-puff'`, `'smoke'`, `'hit-ring'`, `'noise-dissolve'`), stretched-FBM dissolve erosion with glowing burn rim and final-frame ember guard, optional Art Bible palette snapping, and packed `cols × rows` sheet synthesis (`bakeVfxFlipbook()`).
- **Schema & Recipe Integration (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `VfxArchetypeSchema`, `VfxFlipbookConfigSchema`, and optional `vfxFlipbook` persistence on `SpriteNodeSchema` and `AssetRecipeSchema`.
- **Verification:** Verified via `tests/unit/m22a-vfx-flipbook.test.ts` (byte-identical `32×32` `4×4` sparks determinism across `seed: 101`, all 5 archetypes non-empty across every frame, monotonic opaque-to-eroded `'noise-dissolve'` progression, Art Bible palette snap, and `AssetRecipeSchema` round-trip) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages build gate.

## Milestone 22B: Godot 4 `GPUParticles2D` & PixiJS VFX Exporters + Worker/ZIP Integration

- **Engine VFX Exporters (`src/export/vfxExporters.ts`, `src/export/zipPackager.ts`):** Implemented `exportGodotVfxBundle()` (`CanvasItemMaterial` `.tres` + `GPUParticles2D` `.tscn` with `anim_speed_min/max = 1.0`), `exportPixiVfxJson()` (exact per-cell rects and archetype blend mode), `buildVfxExportFiles()`, `packageVfxFlipbookZip()`, and `PackageSpriteZipInput.vfxFlipbookBundle`.
- **Dedicated Worker Baking (`src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Added `BAKE_VFX_FLIPBOOK` (`executeBakeVfxFlipbookJob` / `bakeVfxFlipbookInWorker`) using deduplicated `Set<Transferable>` transfers to avoid `DataCloneError`.
- **Verification:** Verified via `tests/unit/m22b-vfx-exporters.test.ts` (Godot 4 `.tres`/`.tscn`, PixiJS JSON cell layout, `fflate.unzipSync` ZIP round-trip with PNG magic header and Zod `AssetRecipeSchema` check, plus Worker fallback parity) alongside the full TypeScript, ESLint, Prettier, unit, E2E, and GitHub Pages build gate.

## Milestone 22C: Interactive VFX Flipbook Baker UI, Screen 4 Wiring & E2E Flow

- **Contextual VFX Baker Tab & Palette (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registered `'vfx-baker'` as a primary tab for `'vfx'` sprites (kept in `+ Tools` overflow for non-VFX classes, leaving `'ui-panel'` at 3 primary tabs) and added **"Open 2D VFX Flipbook Baker"** to `Cmd/Ctrl+K`.
- **Interactive Canvas2D Workshop (`src/ui/inspector/VfxBaker.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Built the 3-pane VFX flipbook studio featuring 5 archetypes, `4×4`/`8×2`/`4×2` grids, `32px`/`64px` cells, `ScrubInput` (`Seed`, `Spread`, `Turbulence`, `FPS`), Core/Outer Art Bible swatch pickers, Worker baking, `document.hidden`/unmount-safe `rAF` player, Live vs. Full Sheet toggle, Godot `.tres`/`.tscn` + PixiJS JSON previewers, IndexedDB persistence, and `.zip` export.
- **Verification:** Verified end-to-end via `tests/e2e/m22c-vfx-e2e.spec.ts` (reclassify to `'vfx'`, Hit Ring archetype selection, `Spread`/`Turbulence` scrub, Play/Pause live canvas & `256×256` Full Sheet checks, `.tres`/`.tscn`/`.json` preview switching, Dexie save & reload persistence, and `fflate.unzipSync` ZIP verification against `AssetRecipeSchema`) alongside the full TypeScript, ESLint, Prettier, unit, Python bridge, Playwright E2E, and GitHub Pages build gate.

## Audit & Optimization Pass (M18–M22)

- **Bug Fixes & Memory Hygiene (`UniversalDropOverlay.tsx`, `PostProcessInspector.tsx`, `autoTile.ts`, `PipBiomePreview.tsx`, `AutoTileWorkshop.tsx`):** Added orphan-blob cleanup on failed drop imports, stabilized `PostProcessInspector` config-sync effect onto `activeProjectId` so `project.updatedAt` refreshes never reset unsaved inspector state, fixed `wang-16` `crisp-bevel` top-edge lighting check (`(mask & 12) !== 12`), made ZIP download notices accurately summarize bundled extra files, and released offscreen scratch `<canvas>` backing stores on unmount.
- **Algorithmic & React Optimizations (`vfxFlipbook.ts`, `VfxBaker.tsx`, `autoTile.ts`, `AutoTileWorkshop.tsx`, `TurnaroundSlicer.tsx`):** Hoisted frame-invariant `Float64Array` trig/FBM fields out of the flipbook frame loop, added squared-distance early-rejects and `subarray`/`set` row blits across `vfxFlipbook.ts` and `autoTile.ts`, skipped unnecessary sprite buffer transfers in `VfxBaker.tsx` outside `noise-dissolve`, keyed underlay loading cleanly on resolved `underlayBlobId` in `AutoTileWorkshop.tsx`, and eliminated duplicate synchronous main-thread BFS in `TurnaroundSlicer.tsx`.
- **Verification:** Added `wang-16` `crisp-bevel` regression coverage in `tests/unit/m20a-autotile-core.test.ts` and re-verified the entire CI suite (Prettier, ESLint, TypeScript `tsc --noEmit` & `tsc -b`, unit tests, Python bridge unit tests, Playwright E2E, and `VITE_BASE_PATH=/nibgrid/` build).

## Milestone 23A: Pure-TS Parallax Compositor, Atmospheric Depth Tinter & Blueprint Schema

- **Pure-TS Seam Wrapper & Depth Tinter (`src/processing/parallaxCompositor.ts`, `src/processing/parallaxBlueprint.ts`):** Implemented zero-DOM `makeHorizontallySeamless()`, `applyAtmosphericDepthTint()`, `processSingleParallaxLayer()`, `processParallaxStack()`, `composeParallaxPreviewFrame()`, and Zod-validated `parseAndClampParallaxBlueprint()` with Gemini `PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA` bounds clamping and back-to-front `scrollRatioX` ordering.
- **Schema, Recipe & Orphan-Blob GC (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/db/database.ts`):** Added `ParallaxLayerConfigSchema` / `ParallaxSceneConfigSchema` onto `SpriteNodeSchema` and `AssetRecipeSchema`, and extended `findOrphanBlobIds()` so parallax band PNGs and master keyframes are retained safely while superseded/deleted blobs sweep automatically.
- **Verification:** Added `tests/unit/m23a-parallax-compositor.test.ts` verifying horizontal wrap delta reduction without dark-fringe haloing, aerial perspective distance attenuation with `alpha === 0` preservation, integer camera period identity, AI blueprint clamping/sorting, and `fake-indexeddb` orphan-blob hygiene alongside Prettier, ESLint, TypeScript, full unit suite, and GitHub Pages build.

## Milestone 23B: GenAI/Antigravity Parallax Stack Generator, Engine Exporters & Worker Offloading

- **2-Stage Matched-Stack Generator (`src/providers/parallaxGenerator.ts`, `geminiProvider.ts`, `antigravityBridgeProvider.ts`):** Built `generateParallaxBlueprint()`, `generateMatchedParallaxStack()`, `regenerateParallaxBand()`, 4 biome presets (`Masovian Dusk Forest`, `Cyberpunk Rooftops`, `Volcanic Cavern`, `Pixel Meadow`), transparent cost estimator, `#FF00FF` chroma-key isolation prompts, Master Keyframe `inlineData` anchoring, procedural Offline Mock silhouettes, and strict secret redaction across Gemini BYOK & Antigravity Bridge.
- **Parallax Exporters & Worker Execution (`src/export/parallaxExporters.ts`, `src/export/zipPackager.ts`, `src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Implemented `exportGodotParallaxTscn()`, `exportParallaxManifestJson()`, `packageParallaxZip()`, `PackageSpriteZipInput.parallaxBundle`, and transferable `PROCESS_PARALLAX_LAYER` worker execution (`processParallaxLayerInWorker()`).
- **Verification:** Added `tests/unit/m23b-parallax-genai-exporters.test.ts` validating `responseSchema` & Master Keyframe `inlineData`, 401/429/500 key/token redaction, Offline Mock 3-band generation + single-band reroll, Godot 4 `Parallax2D` `.tscn`, Phaser/PixiJS JSON, `fflate.unzipSync` ZIP + `AssetRecipeSchema` validation, and Worker pixel parity.

## Milestone 23C: Interactive Parallax Background Workshop UI, Screen 4L Wiring & E2E Flow

- **Workspace Discovery (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Added `?tab=parallax` primary routing on `'tile'` sprites (overflow menu for other classes, preserving `'ui-panel'` strictly at 3 primary tabs) and registered **"Open Parallax Background Compositor"** (`act-parallax`) in `Cmd/Ctrl+K`.
- **Screen 4L Parallax Workshop (`src/ui/inspector/ParallaxWorkshop.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Built the zero-WebGL2 60 FPS Canvas2D workshop featuring AI/Offline Mock matched-stack streaming, 4 biome presets, 3/4-band toggles, Master Keyframe toggle, cost indicator, surgical per-band `↻` regeneration, reorderable layers, `ScrubInput` controls, `1× Sprite Contrast` foreground hero overlay, live Godot 4 `Parallax2D` / Phaser & PixiJS previews, Dexie persistence with `cleanupOrphanedBlobs()`, and `.zip` export.
- **Bug Fixes & Verification:** Stabilized node hydration onto `targetNode.id` (`hydratedNodeIdRef`) so saving never resets in-memory buffers prior to ZIP export, anchored `SENSITIVE_KEY_PATTERNS` (`recipeBuilder.ts`) and `redactSecrets()` (`errors.ts`) with leading boundaries so English slugs containing words like `dusk-` never false-trigger `sk-` key blocking, and verified end-to-end via `tests/e2e/m23c-parallax-e2e.spec.ts` (Vault key, Gemini route stubs, `ScrubInput` drag, single-band reroll, 401 key redaction, `.zip` inspection, reload persistence, and zero orphan blobs).

## Milestone 24A: Pure-TS Pixel Glyph Table, OKLab Sel-Out Styler & PoT Atlas Packer

- **Pure-TS Glyph Bitmaps & Styling (`src/processing/pixelGlyphTable.ts`, `src/processing/bitmapFont.ts`):** Implemented built-in `5×7` monochrome glyph masks across `ASCII 32..126` (`CHARSET_PRESETS` `'damage-numerals'`, `'hud-upper'`, `'ascii-basic'`), integer-scaled vertical fill gradients with optional OKLab Art Bible palette snap, 4-/8-connected OKLab Sel-Out outlines (`selOutDarken` + explicit override), hard-pixel drop shadows, `measureBitmapFontText()`, and deterministic Power-of-Two shelf packing (`bakeBitmapFontAtlas()`).
- **Schema & Recipe Persistence (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `BitmapFontConfigSchema` (`createDefaultBitmapFontConfig()`) onto `SpriteNodeSchema` and `AssetRecipeSchema`.
- **Verification:** Added `tests/unit/m24a-bitmap-font-core.test.ts` validating `12×17` styled `'8'` bounds & strictly darker OKLab Sel-Out outlines + non-transparent shadow row, non-overlapping 23-glyph PoT packing with byte-identical determinism, and `fake-indexeddb` node round-trip with `findOrphanBlobIds(db) === []`, alongside Prettier, ESLint, TypeScript, Playwright E2E, and GitHub Pages build.

## Milestone 24B: AngelCode BMFont Exporters, Canvas2D Font Rasterizer & Worker Baking

- **AngelCode `.fnt` + `.xml` Exporters & ZIP Integration (`src/export/bmfontExporter.ts`, `src/export/zipPackager.ts`):** Implemented `exportBmFontText()`, `exportBmFontXml()`, `buildBmFontExportFiles()`, `packageBmFontZip()`, and `PackageSpriteZipInput.bitmapFontBundle` (while removing a duplicate `parallaxBundle` check in `zipPackager.ts`).
- **Browser Font Rasterizer & Worker Offloading (`src/ui/inspector/fontRasterizer.ts`, `src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Added `loadUploadedFontFace()`, `rasterizeBrowserFontToMasks()`, and transferable `BAKE_BITMAP_FONT` worker jobs (`executeBakeBitmapFontJob` / `bakeBitmapFontInWorker`).
- **Verification:** Added `tests/unit/m24b-bmfont-exporters.test.ts` validating `.fnt` and `.xml` format parity + attribute escaping, `fflate.unzipSync` PNG/FNT/XML/Zod-recipe round-trip, and Worker parity alongside Prettier, ESLint, TypeScript, Playwright E2E, and GitHub Pages build.

## Milestone 24C: Interactive Bitmap Font & Damage Numeral Workshop UI (Screen 4M) & E2E Flow

- **Workspace Discovery (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registered `'bmfont'` (`?tab=bmfont`) as a primary tab on `'ui-panel'` assets (and inside `+ Tools` overflow elsewhere), added `"Open Bitmap Font & Damage Numeral Exporter"` (`act-bmfont`) to `Cmd/Ctrl+K`, and updated `tests/unit/m19-ux-polish.test.ts`.
- **Screen 4M Bitmap Font Workshop (`src/ui/inspector/BitmapFontWorkshop.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Built the zero-WebGL2 3-pane Canvas2D workshop featuring `5×7 Pixel` and `.TTF`/System font rasterization, charset presets (`Damage (23)`, `HUD Upper`, `ASCII (95)`), `ScrubInput` tuning for scale/Sel-Out/shadow/spacing/padding, Art Bible vertical gradient snapping, selectable biome preview with visibility-aware `rAF` floating `Crit Pop` animations, PoT `Packed Atlas` inspection, live `Godot 4 (.fnt)` / `Phaser / Pixi (.xml)` previews, IndexedDB `bitmapFont` recipe persistence, and `<slug>_bmfont.zip` + sprite ZIP bundling.
- **Verification:** Verified end-to-end via `tests/e2e/m24c-bmfont-e2e.spec.ts` (ScrubInput pointer drags, Crit Pop live rendering, PoT atlas geometry, `.fnt`/`.xml` previews, `.zip` extraction + Zod `AssetRecipeSchema` validation, reload persistence), live Screen 4M screenshot documentation (`docs/demo/23-bitmap-font-workshop.png`), and full CI verification gate.

## Milestone 25A: Entity Domain Schema, Dexie v3 Migration & Pure-TS Godot 4 Prefab Assembler

- **Entity Domain & Dexie v3 (`src/domain/entitySchema.ts`, `src/db/database.ts`):** Defined `GodotBodyType`, `EntityAnimationClip`, `EntityDefinition`, and `GodotSyncTargetRecord` Zod schemas, added `entities` and `syncTargets` tables in Dexie v3 with cascade project cleanup and blob-zero-duplication invariants.
- **Pure-TS Prefab Assembler (`src/export/godotPrefabAssembler.ts`):** Implemented `generateGodotPngImport()`, `generateCanvasTextureTres()`, and `assembleGodotEntityFiles()` emitting sorted `VirtualSyncFile[]` maps with `.png.import` sidecars, `CanvasTexture` `.tres`, `SpriteFrames` (`_frames.tres`), synchronized `AnimationLibrary` (`_anims.tres`), and complete `<slug>.tscn` prefabs.
- **Verification:** Added `tests/unit/m25a-godot-prefab.test.ts` validating `.tscn` `load_steps` & `ExtResource` IDs, M16 collider/hitbox tracks, M21 `Marker2D` socket coordinates, lossless pixel-art `.import` flags, deterministic output ordering, and Dexie v3 cascade delete with zero orphan blobs.

## Milestone 25B: SHA-256 Sync Diff Engine & File System Access API (`res://`) Writer

- **SHA-256 Diffing (`src/sync/syncDiff.ts`):** Implemented `computeSyncDiff()` partitioning generated virtual files into `added`, `modified`, and `unchangedPaths` alongside `totalBytesToWrite`.
- **FSAA Writer & Fallback (`src/sync/fsaaSyncEngine.ts`):** Implemented `bindGodotDirectory()`, permission-checked `syncFilesToGodotDirectory()` (with zero disk writes when up to date and nested folder creation), `collectEntitySyncFiles()` / `collectProjectGodotSyncFiles()`, and `buildGodotSyncZipBytes()` / `downloadGodotSyncZip()`.
- **Verification:** Added `tests/unit/m25b-sync-diff.test.ts` validating fresh vs unchanged vs 1-byte mutated SHA-256 diffs, mock `FileSystemDirectoryHandle` nested directory creation + zero-write second sync, and `fflate.unzipSync` fallback ZIP parity.

## Milestone 25C: Entity Hub UI, Global Top-Bar `GodotSyncPill` & Live `res://` Sync E2E

- **Entity Hub & Sync Pill UI (`src/ui/entities/EntityHubView.tsx`, `src/ui/entities/GodotSyncPill.tsx`, `src/App.tsx`, `src/store/useAppStore.ts`, `src/ui/command/CommandPalette.tsx`):** Added the Entities screen (`#/project/:id/entities`) featuring Entity Cards, 5 coverage dots, animation clip & audio binders, live `.tscn Preview`, single-entity sync/ZIP actions, top-bar `GodotSyncPill` with SHA-256 dry-run diff popover (`+ Added` / `~ Modified`), and `nav-entities` in `Cmd/Ctrl+K`.
- **Race-Condition Fix (`src/ui/inspector/PostProcessInspector.tsx`):** Preserved `collisionShapes` and `sockets` refs inside `handleSaveSockets()` and `handleSaveVfxFlipbook()` so switching immediately from Collider to Sockets never overwrites pending collision hulls before the debounced save flushes.
- **Verification:** Added `tests/e2e/m25c-entity-sync-e2e.spec.ts` verifying in-memory `showDirectoryPicker` sync, zero-write repeat sync, hard-reload IndexedDB persistence, and zero orphan blobs alongside live demo capture (`docs/demo/24-entity-hub-godot-sync.png`) and full CI verification.

## Milestone 26A: Pure-TS `EntityDirectorBlueprint`, Socket Snapping & Godot 4.3+ GDScript Validator

- **Blueprint Sanitizer & Opaque Socket Snapper (`src/processing/entityDirectorBlueprint.ts`):** Implemented `ENTITY_BLUEPRINT_GEMINI_RESPONSE_SCHEMA`, `parseAndClampDirectorBlueprint()`, `computeOpaqueBounds()`, and `resolveSocketHintsToPixels()` enforcing strict slug/socket/state identifiers and bounding-box clamping.
- **Godot 4.3+ GDScript Validator & Deterministic Fallback (`src/export/gdscriptGenerator.ts`):** Implemented `stripGdScriptFences()`, `validateGdScript()`, `compileDeterministicGdScript()`, and `validateAndCompileGdScript()` rejecting Godot 3 tokens (`KinematicBody2D`, `yield(`, `export var`, `onready var`, non-empty `move_and_slide(...)`) and compiling typed `.gd` controllers wired to M25 nodes.
- **Verification:** Added `tests/unit/m26a-director-blueprint.test.ts` verifying clamping, opaque-bound socket placement, valid Godot 4 acceptance, and Godot 3 rejection fallback.

## Milestone 26B: GenAI / Mock Prompt-to-Entity Director & M25 `.gd` Prefab Script Wiring

- **M25 Script Wiring (`src/domain/entitySchema.ts`, `src/export/godotPrefabAssembler.ts`, `src/sync/fsaaSyncEngine.ts`):** Added optional `scriptContent` to `EntityDefinitionSchema` and emitted `<slug>.gd` in `assembleGodotEntityFiles()` whenever `scriptResPath` + `scriptContent` exist, updating `<slug>.tscn` `ExtResource` & `load_steps`.
- **Orchestrator & Abort Safety (`src/providers/entityDirector.ts`):** Implemented `draftEntityBlueprint()`, `estimateDirectorCost()`, `buildMockEntityBlueprint()`, and abortable 6-stage `executeEntityDirectorPlan()` (`sprite`, `collider`, `sockets`, `sfx`, `gdscript`, `commit`) with atomic Dexie commit, rollback cleanup for zero orphan blobs, and `ProviderError` key redaction.
- **Verification:** Added `tests/unit/m26b-director-runner.test.ts` verifying Mock end-to-end build + `.tscn` script wiring, mid-run `AbortController` cleanup (`findOrphanBlobIds(db) === []`), and HTTP 401 API key redaction.

## Milestone 26C: `EntityDirectorModal` 3-Step UI, Entity Hub Integration & Director E2E Flow

- **Director UI & Entity Hub Wiring (`src/ui/entities/EntityDirectorModal.tsx`, `src/ui/entities/EntityHubView.tsx`, `src/ui/command/CommandPalette.tsx`):** Added the 3-step Prompt-to-Entity modal (Prompt & Genre, Editable Blueprint Review with cost badge & per-cue audio engine selection, Live 6-stage abortable Build Stream), `+ Prompt-to-Entity (AI)` CTAs, `.gd` coverage dot, read-only `.gd Script` preview tab, and `act-prompt-to-entity` palette entry.
- **Verification:** Added `tests/e2e/m26c-director-e2e.spec.ts` intercepting Gemini Blueprint, Sprite Image, and GDScript endpoints via `page.route()`, verifying all 6 build stages, `.tscn` + `.gd` FSAA sync writes, reload persistence, and zero orphan blobs alongside live demo capture (`docs/demo/25-prompt-to-entity-director.png`) and full CI verification.

## Milestone 27A: Godot 4 `canvas_item` `.gdshader` Transpiler, Presets & Schema Foundation

- **Transpiler & Offline Presets (`src/processing/gdshaderTranspiler.ts`, `src/processing/gdshaderPresets.ts`):** Added `stripShaderCodeFences`, `parseGdShaderUniforms`, `transpileGdShaderToWebGL2` (`#version 300 es` vertex/fragment codegen with Godot 3 `hint_color` diagnostics), and five Godot 4.3+ presets (`hit_flash`, `wind_sway`, `metallic_sheen`, `pixel_outline`, `water_ripple`).
- **Schema & Recipe Integration (`src/domain/schemas.ts`, `src/domain/entitySchema.ts`, `src/export/recipeBuilder.ts`):** Added `ShaderUniformValueSchema`, `ShaderConfigSchema`, and `createDefaultShaderConfig()` onto `SpriteNodeSchema`, `EntityDefinitionSchema`, and `AssetRecipeSchema`.
- **Verification:** Added `tests/unit/m27a-gdshader-transpiler.test.ts` validating `#version 300 es` output across all 5 presets, uniform bounds/color extraction, fence stripping, and invalid/Godot 3 shader rejection.

## Milestone 27B: GenAI `.gdshader` Generator, `ShaderMaterial` `.tres` Exporter & M25 Prefab Wiring

- **GenAI / Offline Generator (`src/providers/shaderGenerator.ts`):** Implemented `generateGdShader()`, `estimateShaderGenerationCost()`, and `matchPresetForShaderPrompt()` supporting Gemini BYOK, Antigravity Bridge, and deterministic offline preset matching with full API key redaction.
- **Exporter & M25 Sync Integration (`src/export/shaderExporters.ts`, `src/export/zipPackager.ts`, `src/export/godotPrefabAssembler.ts`, `src/sync/fsaaSyncEngine.ts`):** Implemented `exportGodotShaderMaterialTres()`, `buildShaderExportFiles()`, and `packageShaderZip()`, wired `shaderBundle` into `packageSpriteZip()`, and automatically attached `<slug>.gdshader` + `<slug>_mat.tres` onto `AnimatedSprite2D` in M25 `.tscn` prefabs.
- **Verification:** Added `tests/unit/m27b-shader-exporter.test.ts` testing `.tres` `Color(...)` serialization, M25 `load_steps` + `material` `.tscn` wiring, `fflate` ZIP extraction, offline keyword generation, and HTTP 401 API key redaction.

## Milestone 27C: Godot 4 Shader Studio UI (`Screen 4N`), Live WebGL2 Inspector & E2E Flow

- **Navigation & Inspector Registration (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Added `'shader'` tab (`?tab=shader`) and `act-shader-studio` command palette action, placing `Shader Studio` in primary tabs for `'character'` and `'vfx'` assets without perturbing `'ui-panel'` tab layout.
- **Live WebGL2 Studio (`src/ui/inspector/ShaderStudio.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Implemented Screen 4N with preset pills, AI prompt generation, auto-generated `ScrubInput` and `source_color` controls, 60 FPS WebGL2 preview (`forceReleaseWebGlContext()` disposal), `.gdshader` / `.tres` tabs with live compile diagnostics, Dexie persistence, and ZIP/individual downloads.
- **Verification:** Added `tests/e2e/m27c-shader-studio-e2e.spec.ts` verifying Hit Flash WebGL2 rendering + uniform scrubbing, intercepted Gemini custom shader dynamic controls, syntax error inline diagnostics, `.zip` extraction (`gdshader` + `_mat.tres` + Zod-valid `recipe.json`), and reload persistence alongside live demo capture (`docs/demo/26-godot-shader-studio.png`) and full CI verification.

## CI Tab-Wrap Fix & README End-to-End Godot 4 Workflow Showcase

- **Inspector Tab Bar Layout (`src/ui/inspector/PostProcessInspector.tsx`, `tests/e2e/m19-ux-polish.spec.ts`):** Switched horizontal primary inspector tab buttons to `meta.shortLabel` with `whitespace-nowrap` and full `title={meta.label}` tooltip so adding `'shader'` never wraps the tab strip onto a second row on `1280×720` Linux runners, and added `scrollIntoViewIfNeeded()` before scrubbing `scrub-alpha-threshold`.
- **CI Hardening (`.github/workflows/ci.yml`):** Added `python3 -m unittest tests/unit/test_nibgrid_bridge.py -v` to the GitHub Actions `verify` job.
- **README Workflow Showcase (`README.md`, `docs/demo/25b-director-gdscript-preview.png`, `docs/demo/26-godot-shader-studio.png`, `docs/demo/26b-shader-material-tres.png`):** Re-captured transparent Red Cat Warrior Shader Studio (`Metallic Sheen` + `Pixel Outline` `.tres`) and Prompt-to-Entity `.gd Script` previews and documented the full M26 → M27 → M25 Godot 4 workflow.

## Milestone 28: Global Asset Vault, Smart Asset Browser & Portable `.nibgrid.zip` Snapshots

- **Vault Schema & Dexie v4 (`src/domain/vaultSchema.ts`, `src/db/database.ts`):** Added `vaultItems` table migration, `storeBlobDeduplicated()` SHA-256 reuse, cross-project `promoteSpriteNodeToVault()` / `promoteShaderToVault()` / `importVaultItemToProject()`, and `findOrphanBlobIds()` + `cleanupOrphanedBlobsInTx()` scanning across `vaultItems`.
- **Portable `.nibgrid.zip` Snapshot Codec (`src/sync/projectSnapshot.ts`):** Implemented pure-TS `exportProjectSnapshot()` and `parseAndVerifyProjectSnapshot()` (deduplicated `blobs/<sha256>.bin`, Zod-validated `manifest.json`, pre-DB SHA-256 verification), plus atomic `importProjectSnapshotToDb()` ID remapping.
- **Vault UI & Batch Actions (`src/ui/vault/VaultAndBrowserView.tsx`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/hub/ProjectHub.tsx`, `src/ui/inspector/ShaderStudio.tsx`, `src/ui/command/CommandPalette.tsx`):** Added Global Asset Vault, Project Browser filters, bulk **Promote to Vault** and Worker-backed **Batch Re-Palette**, and 1-click `.nibgrid.zip` export/import.
- **Verification:** Added `tests/unit/m28-vault-snapshot.test.ts` (round-trip snapshot, 1-byte corruption rejection, delete-source-project Vault durability + zero orphans after Vault delete) and `tests/e2e/m28-vault-e2e.spec.ts` (cross-project Vault promotion & reuse + `.nibgrid.zip` round-trip & reload persistence).

## Milestone 29: Zero-Server URL-Hash Recipe Sharing (`#share=`) & Static GitHub Pack Feeds

- **Pure-TS URL Recipe Codec (`src/share/recipeUrlCodec.ts`):** Added Base64URL + zlib compression (`#share=v1.`) with `8192`-char limit and `65536`-byte bounded `Unzlib` decompression across `shader`, `vfx`, `bmfont`, `procedural-sfx`, and `art-bible` recipes.
- **Static Pack Feed Client & Offline Starter Pack (`src/share/packFeedClient.ts`, `public/packs/starter-catalog.json`, `public/packs/retro-rpg-starter.nibgrid-pack.zip`):** Implemented static `catalog.json` loading, relative ZIP resolution, SHA-256 verification, atomic project/Vault pack import, and custom feed `localStorage` persistence.
- **UI Integration (`src/ui/share/ShareRecipeModal.tsx`, `src/ui/share/PackFeedBrowser.tsx`, `src/ui/inspector/ShaderStudio.tsx`, `src/ui/vault/VaultAndBrowserView.tsx`, `src/App.tsx`):** Added `#share=` link generation in Screen 4N, boot/`hashchange` **Shared Recipe Detected** modal with live WebGL2/pure-TS re-bake check, and **Pack Feeds** browser tab.
- **Verification:** Added `tests/unit/m29-url-pack-share.test.ts` and `tests/e2e/m29-share-feed-e2e.spec.ts` covering URL share generation, boot re-bake & import, and offline `starter-catalog.json` pack import.

## Milestone 30: Zero-Server WebRTC P2P Direct Asset & Project Transfer

- **Pure-TS Protocol & SDP Codec (`src/p2p/p2pProtocol.ts`, `src/p2p/sdpCodec.ts`):** Implemented `16 KiB` big-endian chunk framing, `P2pReassembler` end-to-end SHA-256 verification, and compressed non-trickle `NIB-O1:` / `NIB-A1:` SDP codecs.
- **WebRTC Transport & Loopback Factory (`src/p2p/webrtcTransfer.ts`):** Implemented `P2pSenderSession` and `P2pReceiverSession` with `64 KiB` DataChannel backpressure, configurable ICE servers, and `createInMemoryLoopbackPeerFactory()` for zero-network CI verification.
- **P2P Transfer Modal (`src/ui/share/P2pTransferModal.tsx`, `src/App.tsx`, `src/ui/hub/ProjectHub.tsx`, `src/ui/vault/VaultAndBrowserView.tsx`, `src/ui/command/CommandPalette.tsx`):** Added Send/Receive tabs keeping sessions live across tab toggles, inline SVG QR visualizers, live progress, SHA-256 Verified badges, and 1-click snapshot import.
- **Verification:** Added `tests/unit/m30-p2p-protocol.test.ts` (100 KiB chunking/reassembly, 1-bit flip corruption rejection, SDP codec round-trip, full loopback transfer) and `tests/e2e/m30-p2p-e2e.spec.ts` verifying full Offer/Answer transfer & project import via injected `RTCPeerConnection` loopback.

## Milestone 31A: Pure-TS Surgical Pixel Editor Core, Mask Composite & Atomic Commit

- **Pure-TS Raster & Mask Core (`src/processing/pixelEditorCore.ts`, `src/processing/inpaintMask.ts`):** Implemented `plotPixel`, `plotBresenhamLine` with `mirrorX`, iterative `floodFillRgba`, `PixelUndoStack(50)`, `mapClientToTexel`, `paintMaskLine`, `maskToRgbaBuffer`, `maskToOverlayRgba`, `compositeInpaintResult`, and `snapMaskedPixelsToPalette`.
- **Schema, Recipe & Atomic Dexie Persist (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/db/database.ts`):** Added `inpaintHistory` and `manualPixelEditCount` to `SpriteNodeSchema` and `AssetRecipeSchema`, plus `NibgridRepository.commitProcessedSpritePixels()` with SHA-256 deduplication and inline orphan blob cleanup.
- **Verification:** Added `tests/unit/m31a-pixel-editor-core.test.ts` covering continuous mirrored diagonals, enclosed 4-connected flood fill, 3→2→1 undo/redo + depth cap, byte-identical unmasked composite preservation, and atomic IndexedDB persistence with zero orphan blobs.

## Milestone 31B: Region-Masked AI Inpainting Adapter & Offline Mock Mode

- **Inpaint Adapter (`src/providers/inpaintAdapter.ts`):** Implemented `estimateInpaintCost()`, `buildGeminiInpaintRequest()` attaching original + binary mask PNGs with Art Bible lock tokens, deterministic Offline Mock `$0.00` mode, nearest-neighbor alignment + strict `compositeInpaintResult()` merging, and automatic secret redaction across Gemini BYOK, Antigravity Bridge, and ComfyUI.
- **Verification:** Added `tests/unit/m31b-inpaint-adapter.test.ts` asserting Gemini payload structure, Offline Mock byte-identical unmasked pixel preservation, `AIzaSyINPAINT999` secret stripping on HTTP `401`/`429`, and masked Gemini PNG compositing.

## Milestone 31C: Screen 4A Pixel Micro-Editor & Region-Masked Inpainting UI

- **Screen 4A Toolbar & Canvas Integration (`src/ui/inspector/PixelMicroEditorToolbar.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Added floating tool rail (`Pencil`, `Eraser`, `Eyedropper`, `Flood Fill`, `Mirror-X`, `Mask Brush`/`Mask Eraser`, `1–3px` brush size, `Undo`/`Redo`), bottom Art Bible swatch strip (+ `Unlock Free Color`), top-center Inpaint Action Bar, HiDPI pointer-to-texel mapping, editable-input keyboard shortcut isolation, reload preservation of edited blobs, and atomic Dexie commit.
- **Verification:** Added `tests/e2e/m31c-micro-editor-e2e.spec.ts` covering Pencil + Mirror-X at `dpr: 1` & `dpr: 2`, `Cmd+Z` / `Cmd+Shift+Z`, keyboard shortcut isolation inside `inpaint-prompt-input`, intercepted Gemini masked inpainting, `.recipe.json` metadata export, hard-reload persistence, and zero orphan blobs.

## Milestone 32A: Pure-TS QA Contact Sheet Packer, Schema & Dexie v5 Cache

- **Contact Sheet Packer & Schema (`src/processing/qaContactSheet.ts`, `src/processing/artDirectorQaSchema.ts`, `src/db/database.ts`):** Implemented `packQaContactSheets()` with paginated `REF`-pinned `#808080` sheets, `pixelGlyphTable.ts` `5×7` index stamps, binary silhouette previews, SHA-256 `computeQaSheetHash()`, `parseAndResolveQaReport()` clamping + hallucination filtering, and Dexie v5 `qaReports` caching/cleanup.
- **Verification:** Added `tests/unit/m32a-qa-contact-sheet.test.ts` validating 17-sprite pagination, byte determinism, score clamping, invalid `"99"` label drop, and Dexie cache/cascade deletion with zero orphan blobs.

## Milestone 32B: Gemini Flash Vision QA Adapter & Pure-TS Offline Heuristics

- **Vision QA Adapter (`src/providers/artDirectorQa.ts`):** Implemented `estimateArtDirectorQaCost()`, `buildGeminiVisionQaRequest()`, `runOfflineHeuristicQa()` (silhouette fill ratio, edge-vs-interior luminance contrast, left/right luminance balance), and `runArtDirectorQaPass()` with SHA-256 Dexie cache hit short-circuiting, Gemini / Antigravity Bridge routing, and secret redaction.
- **Verification:** Added `tests/unit/m32b-art-director-qa.test.ts` verifying Vision payload schema, opposing light detection offline, `AIzaSyQA999` secret redaction on HTTP `401`/`429`, and zero duplicate network requests on cache hit.

## Milestone 32C: Audit Matrix Art Director QA Panel, Deep-Link Fixes & Smart Filter

- **Audit Matrix & Deep-Link Wiring (`src/ui/audit/ArtDirectorQaPanel.tsx`, `src/ui/audit/AuditMatrixView.tsx`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Added clickable contact sheet preview canvas, `Run Visual QA Pass (AI)` with transparent cost + `Cached` badges, per-sprite `Visual QA` column badges, and `?tool=pencil` Micro-Editor deep-link routing.
- **Smart Browser Filter (`src/ui/vault/VaultAndBrowserView.tsx`):** Added `Visual QA Warnings` filter chip + status option and per-card `qa:*` badges.
- **Verification:** Added `tests/e2e/m32c-art-director-e2e.spec.ts` covering contact sheet rendering, intercepted Gemini Vision QA findings, `Fix in Micro-Editor` navigation, M28 `Visual QA Warnings` filtering, hard-reload IndexedDB cache restoration, and zero orphan blobs.

## Milestone 33A: Pure-TS Procedural UI Kit Core, Slicer & Schema

- **Procedural UI Kit Synthesizer & Slicer (`src/processing/uiKitCore.ts`, `src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Implemented `bakeProceduralUiKit()` across all 7 `UiWidgetSlot` tiles, `clampNineSliceMargins()`, `#FF00FF` chroma-key `sliceUiStateSheet()`, nearest-neighbor `renderNineSliceToBuffer()`, and `UiKitStyleConfigSchema` persistence.
- **Verification:** Added `tests/unit/m33a-ui-kit-core.test.ts` validating `hover > normal > pressed` interior luminance, lower disabled saturation, margin clamping, byte determinism, and 4×2 sheet chroma slicing.

## Milestone 33B: GenAI UI State Sheet Adapter & Godot 4 `Theme` `.tres` Exporter

- **Adapter & Exporter (`src/providers/uiKitAdapter.ts`, `src/export/godotThemeExporter.ts`, `src/sync/fsaaSyncEngine.ts`):** Implemented `buildGeminiUiKitRequest()`, `generateUiKitViaAi()` with secret stripping, `exportGodotThemeTres()` (`format=3`, exact `load_steps`, 7 `StyleBoxTexture` controls, optional M24 `FontFile`), `assembleGodotUiKitFiles()`, `packageUiKitThemeZip()`, and M25 project sync integration.
- **Verification:** Added `tests/unit/m33b-godot-theme-exporter.test.ts` asserting `load_steps=16` / `15`, `.png.import` `compress/mode=0`, `.fnt` pairing, and `AIzaSyUIKIT999` secret stripping on HTTP `401`/`429`.

## Milestone 33C: Interactive Godot 4 UI Kit Workshop, M24 Font Pairing & M25 Sync

- **UI Kit Workshop & Workspace Integration (`src/ui/inspector/UiKitWorkshop.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/store/useAppStore.ts`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`):** Added `'uikit'` tab promoted on `ui-panel` assets, interactive 9-slice Hover/Pressed/Disabled button & scrubbed HP progress bar canvases, M24 Bitmap Font selector (`default_font = ExtResource("8_font")`), Art Bible color swatches + clamped margin guide canvas, `Save UI Kit to Project`, 1-click `Sync to Godot (res://)`, and `<slug>_theme.zip` bundling.
- **Verification:** Updated `tests/unit/m19-ux-polish.test.ts` for `ui-panel` primary tabs and added `tests/e2e/m33c-ui-kit-e2e.spec.ts` verifying M24 font saving & pairing, live hover/press/disabled state transitions, unzipped 7 PNGs + `.png.import` + `.fnt`/`.png` + `<slug>_theme.tres` (`load_steps=16`), Zod-validated `.recipe.json`, and hard-reload IndexedDB persistence.

## Milestone 34A: Pure-TS 15-Joint Pose Rig, Analytic 2-Bone IK, Presets & OpenPose Renderer

- **Pure-TS Pose Rig & Presets (`src/processing/poseRigCore.ts`, `src/processing/posePresets.ts`):** Implemented the 15-joint rig, `solveTwoBoneIk()` law-of-cosines IK solver, `applyJointDragWithIk()`, `interpolatePoseFrames()`, built-in `run_6f` / `melee_slash_5f` / `jump_4f` / `idle_4f` presets, `renderOpenPoseFrame()` / `renderOpenPoseStrip()`, and `sliceAndAlignPoseStrip()` ground-pivot aligner.
- **Schema & Orphan-Blob Safety (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/db/database.ts`, `src/sync/projectSnapshot.ts`):** Added `PoseClipDefinitionSchema` on `SpriteNode` / `AssetRecipe` and tracked `generatedStripBlobId` + `generatedFrameBlobIds` across GC and snapshot round-trips.
- **Verification:** Added `tests/unit/m34a-pose-rig-core.test.ts` confirming `1e-4` exact IK bone lengths on bent/stretched/zero targets, exact 0.5 interpolation midpoints, `384×64` OpenPose RGB strip layout, and uniform bottom-row ground alignment across 6 sliced frames.

## Milestone 34B: GenAI / Antigravity / ControlNet Pose Adapter & Worker Slicer

- **Adapter, Worker & ZIP Bundling (`src/providers/poseAnimationAdapter.ts`, `src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`, `src/export/zipPackager.ts`):** Implemented `buildGeminiPoseStripRequest()`, `buildGeminiSingleFrameRerollRequest()`, `generatePoseSpriteCycle()` (Gemini BYOK, Antigravity Bridge, ComfyUI ControlNet OpenPose, and `$0.00` Offline Mock mannequin mode), `regenerateSinglePoseFrame()`, transferable `SLICE_AND_ALIGN_POSE_STRIP` worker offloading, and ZIP strip/guide bundling.
- **Verification:** Added `tests/unit/m34b-pose-adapter.test.ts` asserting both `inlineData` parts in Gemini payloads, 6 aligned `64×64` Offline Mock frames, single-frame re-roll execution, and complete `AIzaSyPOSE999` secret stripping on HTTP `401`/`429`.

## Milestone 34C: Interactive 2D Pose Keyframer Workshop, Onion-Skinning & M25 Commit

- **Screen 4O Workshop & Routing (`src/ui/inspector/PoseKeyframerWorkshop.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/store/useAppStore.ts`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`):** Built the 3-pane Pose Keyframer workshop (`'pose'` tab on `character` assets & `Cmd/Ctrl+K`), draggable 15-joint IK rig with red/cyan onion-skinning, `SLICE_AND_ALIGN_POSE_STRIP` worker generation & per-frame re-roll, IndexedDB blob hydration, ZIP export, and 1-click commit into M25 `EntityAnimationClip`.
- **Verification:** Added `tests/e2e/m34c-pose-keyframer-e2e.spec.ts` testing `Run 6f` preset loading, 2-bone IK `r_wrist` dragging + elbow solve with onion-skinning, intercepted Gemini `generateContent` `384×64` `#FF00FF` strip generation (`6` aligned frames), committing `run` clip to M25 Entities, and hard-reload persistence with zero console/page errors.

## Milestone 35A: Room Layout Core, Auto-Tile Resolver, Godot 4.3 `TileMapLayer` Codec & Dexie v6

- **Room Core, DB v6 & Recipe (`src/processing/roomLayoutCore.ts`, `src/db/database.ts`, `src/store/useAppStore.ts`, `src/export/recipeBuilder.ts`):** Implemented `RoomLayoutBlueprintSchema` (12–64 × 8–32 dimensions), `sanitizeRoomPlacements()`, M20 `blob47`/`wang16` coordinate resolver (`resolveRoomAutoTileCells()`), lossless `encodeGodotTileMapData()`/`decodeGodotTileMapData()` (`2 + 12*N` little-endian bytes), Dexie `version(6)` `rooms` table with cascade cleanup, Zustand `rooms` state, and `AssetRecipe.roomLayout`.
- **Verification:** Added `tests/unit/m35a-room-layout-core.test.ts` testing Zod dimension invariants, solid-overlap spawn/entity relocation, Blob-47 & Wang-16 atlas mappings, binary `tile_map_data` round-trips, and Dexie v6 cascade deletion with zero orphan blobs.

## Milestone 35B: GenAI Room Director, Godot 4.3 `TileMapLayer` `.tscn` Exporter & M25 Sync

- **Adapter, Level Exporter & Sync (`src/providers/roomPrototyperAdapter.ts`, `src/export/godotRoomExporter.ts`, `src/sync/fsaaSyncEngine.ts`):** Added Gemini Flash JSON room blueprint generation with `$0.00` Offline Mock synthesis and `ProviderError` secret stripping, Godot 4.3+ `TileMapLayer` `.tscn` generation (`Background` Parallax2D, `Terrain`, `PlayerSpawn`, `Camera2D` room limits, `Entities` instances), `packageRoomBundleZip()` (`levels/<slug>.tscn` + `recipe.json`), and automatic inclusion of saved project rooms in `collectProjectGodotSyncFiles()`.
- **Verification:** Added `tests/unit/m35b-godot-room-exporter.test.ts` validating exact `load_steps=5`, lossless `tile_map_data` decoding, Camera2D room limits, ZIP bundle validation, `AIzaSyROOM999SECRETKEY` redaction on HTTP `401`/`429`, and M25 project sync inclusion.

## Milestone 35C: Screen 4P Room & Encounter Prototyper Workshop, Live Sync & E2E

- **UI Workshop & Routing (`src/ui/inspector/RoomPrototyperWorkshop.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/store/useAppStore.ts`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`):** Added `'room'` workshop tab on `tile` assets (+ Tools & `Cmd/Ctrl+K`), interactive Canvas2D tile/entity/spawn editor with live M20 bitmask previews, M20/M23/M25 asset bindings, Godot 4.3+ `.tscn` live preview, `Save Room to Project`, 1-click M25 `Sync Room to Godot (res://)`, and `<slug>_level_bundle.zip` export.
- **Documentation & Verification:** Updated `docs/ARCHITECTURE.md`, `JOURNAL.md`, and `README.md` (`Section 2.30`), and added `tests/e2e/m35c-room-prototyper-e2e.spec.ts` covering intercepted Gemini `24×14` room generation, solid painting + `PlayerSpawn` relocation, Level Bundle ZIP extraction + secret-free `AssetRecipeSchema` validation, M25 FSAA sync stub, and hard-reload persistence with zero console/page errors.

## Milestone 36A: Pure-TS 60 Hz Fixed-Timestep Playtest Simulation Core

- **Playtest Simulation Core (`src/processing/playtestEngineCore.ts`, `src/domain/entitySchema.ts`):** Implemented pure-TS `stepPlaytestSimulation()` handling `'side-platformer'` gravity/jumping and `'top-down'` 8-way movement, M16 Hitbox vs. Dummy Hurtbox overlap on `activeFrames` (with horizontal flip transform), hitstop freeze pauses, knockback impulse, trauma shake, M25 `frameAudioTriggers` events, and optional `EntityDefinition.playtestConfig`.
- **Verification:** Added `tests/unit/m36a-playtest-core.test.ts` proving 60 Hz floor-clamped jump arc, 8-way speed normalization, single-hit active-frame combat with exact `hitstopMs` / `flashDurationMs` / knockback, and frozen actor integration during hitstop frames.

## Milestone 36B: Entity `.gd` Stat Sync Helper & Fixed-Timestep Accumulator

- **Stat Sync & Accumulator (`src/export/playtestStatSync.ts`):** Added `applyPlaytestStatsToGdScript()`, `ensureEntityPlaytestGdScript()`, `computeHitFlashUniform()`, and spiral-safe 60 Hz `createFixedTimestepRunner()`.
- **Verification:** Added `tests/unit/m36b-playtest-stat-sync.test.ts` validating byte-exact `@export` mutation + Godot 4.3+ validation, `[0, 1]` flash decay curves, and `100ms` delta clamping.

## Milestone 36C: Interactive `EntityPlaytestStage.tsx` in Entity Hub & E2E Flow

- **Stage UI & Hub Integration (`src/ui/entities/EntityPlaytestStage.tsx`, `src/ui/entities/EntityHubView.tsx`, `src/store/useAppStore.ts`, `src/ui/command/CommandPalette.tsx`):** Added `▶ Playtest` buttons on every Entity Card and `Playtest Active Entity` in `Cmd/Ctrl+K`, integer-scaled Canvas2D stage with M27 hit-flash silhouette + M24 `5×7` damage numerals + `H` Hitbox/Hurtbox/Socket Debug Overlay, lazily resumed `AudioPlaybackEngine` triggers with Mute toggle, live `ScrubInput` game-juice sliders (`Move Speed`, `Gravity`, `Hitstop`, `Screen Shake`, `Knockback`, `Flash`, `Attack Damage`), and 1-click `Apply Stats to Entity .gd` Dexie persistence.
- **Documentation & Verification:** Updated `docs/ARCHITECTURE.md`, `JOURNAL.md`, and `README.md` (`Section 2.31`), and added `tests/e2e/m36c-playtest-e2e.spec.ts` verifying rendered pixels, `ArrowRight` + `Space` Target Dummy combat damage, `H` Debug Overlay toggle, `ScrubInput` stat sync into `.gd`, and hard-reload persistence with zero console/page errors.

## Milestone 37A: Vertical Slice Blueprint Schema, Resumable DAG Runner & Dexie v7 `sliceJobs`

- **Schema, DAG Scheduler & Store (`src/processing/verticalSliceSchema.ts`, `src/processing/sliceDagRunner.ts`, `src/db/database.ts`, `src/store/useAppStore.ts`):** Implemented `VerticalSliceBlueprintSchema`, `estimateSliceCostUsd()`, deterministic `buildSliceDagNodes()`, checkpoint-gated + `maxConcurrency = 2` resumable `runSliceDag()`, and Dexie `version(7)` `sliceJobs` persistence + Zustand hydration.
- **Verification:** Added `tests/unit/m37a-slice-dag.test.ts` proving strict clamping, `$0.00` draft cost calculation, `awaiting-approval` checkpoint halt, partial resume executing only failed `parallax_stack` + downstream `room_level` / `main_scene`, and Dexie v7 cascade cleanup with zero orphan blobs.

## Milestone 37B: Vertical Slice Director, Node Executors & Godot 4 `main.tscn` Assembler

- **Director & Exporter (`src/providers/verticalSliceDirector.ts`, `src/export/godotMainSceneExporter.ts`):** Added Gemini Flash / `$0.00` offline blueprint compiler, full M14–M37 node executor suite (`art-bible`, `golden-ref`, `tileset`, `parallax`, `entity`, `bmfont`, `ui-theme`, `room`, `main-scene`, `visual-qa`) with orphan-blob cleanup and key redaction, `exportGodotMainSceneTscn()`, and `collectVerticalSliceGodotSyncFiles()`.
- **Verification:** Added `tests/unit/m37b-main-scene.test.ts` validating exact `load_steps`, deduplicated `res://` manifest assembly, `AIzaSySLICE999` redaction on HTTP `401`/`429`, and full offline `instant-draft` execution + Godot sync collection leaving `findOrphanBlobIds(db) === []`.

## Milestone 37C: `VerticalSliceWizard.tsx`, `#share=` Integration & Full Vertical Slice E2E

- **Wizard, Command & `#share=` (`src/ui/autopilot/VerticalSliceWizard.tsx`, `src/share/recipeUrlCodec.ts`, `src/ui/share/ShareRecipeModal.tsx`, `src/App.tsx`, `src/ui/command/CommandPalette.tsx`):** Added the 3-step modal wizard (`+ Vertical Slice` header button + `Cmd/Ctrl+K` action) with `$0.00` Instant Draft / Hybrid Production / Full GenAI cost estimator, Golden Reference `1×`/`2×` + palette visual gate (`Re-Roll` / `Approve & Fan Out`), live IndexedDB-persisted DAG board with pause/abort/resume and click-to-inspect routing, M36 playtest launch, 1-click `res://main.tscn` FSAA/ZIP sync, and zero-server `#share=v1.` `vertical-slice` recipe encoding/import.
- **Documentation & Verification:** Updated `docs/ARCHITECTURE.md`, `JOURNAL.md`, and `README.md` (`Section 2.32`), and added `tests/e2e/m37c-autopilot-e2e.spec.ts` verifying prompt drafting, Golden Reference Gate pause & approval, full DAG completion, FSAA sync emitting `main.tscn` + `levels/*.tscn` + `entities/*/*.tscn` + `ui/*_theme.tres` + `tiles/*_tileset.tres` + `parallax/*_parallax.tscn`, `#share=v1.` URL generation, and hard-reload IndexedDB persistence with zero console/page errors.

## Milestone 38A: Pure-TS `@` Context Resolver, Studio Tool Registry & Dexie v8 Checkpoint Engine

- **Context, 8-Tool Registry & Rollback (`src/agent/contextResolver.ts`, `src/agent/studioToolRegistry.ts`, `src/agent/stagingTransactions.ts`, `src/db/database.ts`):** Implemented `@slug` / `@enemies` / `@all_sprites` / `@art_bible` mention resolution, `.nibgridrules` compilation, all 8 Zod-validated + Gemini-declared deterministic Studio tools executing into isolated `StagedAssetChange[]` buffers, Dexie `version(8)` `agentCheckpoints`, atomic `commitStagedTurn()` / `rejectStagedTurn()` / `restoreCheckpoint()`, and transaction-safe orphan blob cleanup.
- **Verification:** Added `tests/unit/m38a-agent-registry.test.ts` proving exact `@` resolution, unknown-token tolerance, secret redaction in `.nibgridrules`, partial accept+reject atomic commits leaving `findOrphanBlobIds(db) === []`, and byte-for-byte checkpoint rollback with zero orphan blobs.

## Milestone 38B: Asset Agent Adapter (`assetAgentAdapter.ts`), Gemini Function Calling & Key Redaction

- **Agent Planner (`src/providers/assetAgentAdapter.ts`):** Implemented `buildGeminiAgentRequest()`, `planOfflineMockAgentTurn()` (`$0.00` intent-to-tool planner), and `planAgentTurn()` across Gemini BYOK Function Calling, Antigravity Loopback Bridge (`127.0.0.1:4188`), and Offline Mock modes with strict `StudioToolCallSchema` validation and secret redaction.
- **Verification:** Added `tests/unit/m38b-agent-adapter.test.ts` validating embedded `ArtBible` rules + all 8 tool declarations, `$0.00` 2-tool offline planning for `@goblin_scout` + `@hit_flash`, Gemini `functionCall` parsing, and full removal of `AIzaSyAGENT999SECRET` on HTTP `401`/`429`.

## Milestone 38C: `AssetComposerRail.tsx`, `InlineCanvasCommand.tsx`, Shortcuts & E2E

- **UI, Shortcuts & Store (`src/store/useAppStore.ts`, `src/ui/agent/AssetComposerRail.tsx`, `src/ui/agent/InlineCanvasCommand.tsx`, `src/App.tsx`, `src/ui/command/CommandPalette.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/entities/EntityHubView.tsx`):** Added `agentCheckpoints` store hydration, right-rail Composer (`Cmd/Ctrl+L`) with `@` autocomplete, `.nibgridrules`, Tool Plan + Cost Gate, Visual Staging Diffs, and Checkpoint history, plus focused `Cmd/Ctrl+K` `InlineCanvasCommand` anchored to sprite canvases and entity cards without breaking global `Cmd/Ctrl+K` / `Cmd/Ctrl+Shift+P` navigation.
- **Documentation & Verification:** Updated `docs/ARCHITECTURE.md`, `JOURNAL.md`, and `README.md` (`Section 2.33`), and added `tests/e2e/m38c-composer-e2e.spec.ts` verifying `Control+l` `@goblin_scout` autocomplete, intercepted Gemini function-calling staging, Accept + Checkpoint creation, Restore rollback, focused Screen 4A `Control+k` inline repalette edit, and hard-reload persistence with zero console/page errors.

## Milestones 39 & 40A: VS Code `HostAdapter`, Extension MCP Server & Pluggable `ModelRouter`

- **`HostAdapter`, Extension Host & MCP Server (`src/platform/hostAdapter.ts`, `packages/vscode-extension/`):** Added typed Browser/VS Code Webview host abstraction (`getActiveHostAdapter()`), extension manifest (`packages/vscode-extension/package.json`) with Custom Editors & Activity Bar views, RPC dispatcher (`vscodeHostBridge.ts`), `activateNibgridExtension()`, and 9-tool JSON-RPC 2.0 MCP server (`mcpToolServer.ts`).
- **Unified `ModelRouter` & Verification (`packages/model-router/src/routerCore.ts`, `packages/model-router/test/m40a-model-router.test.ts`):** Implemented multi-task fallback routing (`antigravity-acp` -> local/cloud fallbacks -> `$0.00` `offline-mock`), credential scrubbing (`AIzaSyROUTER999`, `sk-test-secret-123`), and Vitest verification covering routing precedence, redaction, and MCP tool enumeration.

## Milestone 40B: Safe Antigravity MCP Auto-Linker & `ModelProvidersPanel.tsx`

- **Config Linker & UI (`packages/model-router/src/antigravityLinker.ts`, `src/ui/settings/ModelProvidersPanel.tsx`, `src/App.tsx`, `src/store/useAppStore.ts`, `src/ui/command/CommandPalette.tsx`):** Added idempotent `mcp_config.json` merger + `.bak.<ts>` backup helper rejecting malformed JSON and credential env leaks, plus the in-app Models & Providers UI with per-task `resolveModelRoute()` previews, `Ping Providers`, and persistent routing profiles in `localStorage`.
- **Verification:** Added `packages/model-router/test/m40b-antigravity-linker.test.ts` verifying sibling MCP preservation, idempotency, timestamped `.bak` creation, corrupted JSON abort without side effects, and credential rejection inside `env`.

## Milestone 40C: Standalone Nibgrid Studio Desktop Recipe, Release Pipeline & README Showcase

- **Desktop Recipe & CI (`desktop/product.json`, `desktop/patches/01-nibgrid-workbench.patch`, `desktop/scripts/build-desktop.ts`, `desktop/scripts/smoke-desktop-bundle.ts`, `.github/workflows/release-desktop.yml`, `desktop/.github/workflows/release-desktop.yml`):** Added telemetry-free VSCodium-style desktop staging, 9-tool MCP bundle generation, automated credential/integrity smoke check (`npm run smoke:desktop`), and multi-OS desktop release workflow.
- **Verification & Showcase (`tests/unit/m40c-desktop-smoke.test.ts`, `tests/e2e/m40c-provider-linker-e2e.spec.ts`, `docs/demo/27–30.png`, `README.md`):** Added desktop bundle smoke unit tests, E2E verification of `Models` task routing + Offline Mock fallback + host-bridge Antigravity linking + reload persistence with zero console/page errors, and captured/verified 4 new Playwright screenshots embedded into `README.md` (`Sections 2.31–2.34`).

## Milestone 39A: Pure-TS `HostAdapter` Interface, `BrowserHostAdapter` & Typed Extension Host RPC Bridge

- **Contracts & Browser Adapter (`src/platform/hostAdapter.ts`, `src/platform/browserHostAdapter.ts`, `src/ui/settings/ModelProvidersPanel.tsx`):** Separated pure-TS `HostAdapter` interfaces (`fs`, `secrets`, `sync`, `antigravity`, `capabilities`) + path-traversal/secret-redaction helpers cleanly from DOM/Dexie/FSAA `createBrowserHostAdapter()` and `getActiveHostAdapter()`.
- **Correlated Webview RPC (`packages/vscode-extension/src/vscodeHostBridge.ts`, `packages/vscode-extension/test/m39a-host-adapter.test.ts`):** Implemented `createInMemoryRpcPair()`, `createVscodeHostAdapter()`, and `dispatchHostRpcRequest()` with discriminated-union Zod schemas; verified concurrent out-of-order RPC round-trips, timeouts, secret redaction (`AIzaSyLEAK999KEY`, `sk-leak-token-888`), Dexie vault secrets, and FSAA `syncResFiles` with `findOrphanBlobIds(db) === []`.

## Milestone 39B: VS Code Extension Host, Custom Editors, Activity Bar Trees, `SecretStorage` & Godot Runner

- **Extension Host, Custom Editors & Trees (`packages/vscode-extension/package.json`, `packages/vscode-extension/src/extension.ts`, `packages/vscode-extension/src/customEditors.ts`, `packages/vscode-extension/src/treeProviders.ts`):** Added `createKeychainSecretStore()` (OS Keychain `SecretStorage` isolation), `runGodotWorkspaceScene()` (`execFile` with `--path` + `res://` traversal/metacharacter guards and disposal cleanup), 3 strict-CSP Webview Custom Editors (`.nibgrid.json`, `.gdshader`, `.room.json`), Activity Bar `TreeDataProvider` classes (Entities, Rooms, Visual QA), and M32 `publishQaDiagnostics()`.
- **Verification (`packages/vscode-extension/test/m39b-extension-host.test.ts`):** Mocked `vscode` APIs and `execFile` to verify Keychain isolation, secret scrubbing, CSP nonces & `</script>` escaping, tree hierarchies, Problems panel mapping (`fail -> Error`, `warn -> Warning`, `pass` excluded), and child-process cancellation on extension disposal.

## Milestone 39C: MCP / `vscode.lm` Studio Tool Server, Bundling (`build:ext`) & Dual-Host E2E

- **MCP Server, `vscode.lm` Adapter & Bundler (`packages/vscode-extension/src/mcpToolServer.ts`, `packages/vscode-extension/vite.config.ts`, `packages/vscode-extension/scripts/verify-extension-bundle.ts`, `package.json`, `.gitignore`):** Added lowercase JSON Schema export, Zod argument validation, `sync_godot_diff` confirmation gating, duplex `Content-Length`/`NDJSON` stdio framing (`startMcpStdioServer()`), `registerNibgridLanguageModelTools()`, and `npm run build:ext` bundling & offline smoke validation.
- **Verification (`packages/vscode-extension/test/m39c-mcp-tools.test.ts`, `tests/e2e/m39c-host-e2e.spec.ts`):** Verified duplex MCP streams, malformed JSON `-32700` recovery, secret scrubbing (`AIzaSyMCP39SECRET`, `sk-mcp-leak-999`, `AIzaSyERR39LEAK`), `vscode.lm` tool invocation, and Playwright E2E persistence + zero orphan blobs across both `BrowserHostAdapter` and mocked `acquireVsCodeApi()` `VscodeHostAdapter` RPC bridges.

## Milestone 41A: Automated PWA ↔ Desktop Parity Contract & Version Lock

- **Parity Verifier (`scripts/verify-parity.ts`, `package.json`, `tsconfig.json`, `eslint.config.js`, `docs/RELEASING.md`):** Implemented `evaluateParityReport()` and `runRepoParityCheck()` wired to `npm run verify:parity` enforcing version sync across all 4 manifests, disabled desktop telemetry, bundled extension presence, all 17 Screen 4A–4P tabs, all 9 MCP/`vscode.lm` tools, and `AssetRecipe` schema locking.
- **Verification (`tests/unit/m41a-parity-contract.test.ts`):** Verified exact alignment across live repo TypeScript constants and immediate failure reporting on `desktop/product.json` version drift, omitted M38 tools (`repalette_sprites`), missing tabs, or re-enabled telemetry.

## Milestone 41B: Local First-Run Configurability, Portable Settings & Release Artifact Verifier

- **First-Run Config & Settings UI (`packages/vscode-extension/src/firstRunConfig.ts`, `src/ui/settings/ModelProvidersPanel.tsx`):** Implemented Zod-validated `LocalStudioConfigSchema`, deep credential stripping (`stripSecretFieldsDeep()`), and `Export JSON` / `Import JSON` UI controls alongside shell-safe Godot 4 binary and `res://` subdirectory inputs.
- **Desktop Staging & Artifact Gates (`desktop/scripts/build-desktop.ts`, `desktop/scripts/verify-release-artifacts.ts`, `tests/unit/m41b-first-run-config.test.ts`, `tests/e2e/m41b-desktop-parity-e2e.spec.ts`):** Added `--dry-run` / `--vsix` packaging, binary/ZIP/secret/localhost artifact verification, and dual Playwright E2E testing proving strict inspector-tab, Autopilot, Composer, local-config, and zero-orphan-blob parity between Browser PWA and VS Code Desktop Webview modes.

## Milestone 41C: Checksums, Lockstep CI/CD Workflows (`ci-parity.yml`, `release.yml`) & Release Runbook

- **Checksums & Workflows (`scripts/generate-checksums.ts`, `.github/workflows/ci-parity.yml`, `.github/workflows/release.yml`, `docs/RELEASING.md`):** Added deterministic `SHA256SUMS.txt` generator, PR/`main` parity workflow, and tag/`workflow_dispatch` (`dry_run` toggle) multi-OS release pipeline packaging `macos-arm64`, `win-x64`, `linux-x64`, `.vsix`, and GitHub Pages PWA in lockstep.
- **Verification (`tests/unit/m41c-checksums.test.ts`):** Verified SHA-256 sorting & self-exclusion, YAML workflow syntax, local dry-run bundle + `.vsix` artifact verification, and full TypeScript/ESLint/Prettier/Vitest/Playwright/Pages build gates.

## Milestone 42A: Pure-TS Desktop OS Detection, Release Parser & CLI Command Builder

- **Installer Core (`src/platform/desktopInstaller.ts`, `docs/RELEASING.md`):** Added DOM-free OS/arch detection (`detectDesktopPlatform()`), GitHub `/releases/latest` parser (`parseLatestDesktopRelease()`), CLI one-liner builder (`getCliInstallCommand()`), and timeout-guarded `fetchLatestDesktopRelease()` with static fallback on `403`/`429`/offline errors.
- **Verification (`tests/unit/m42a-desktop-installer.test.ts`):** Verified OS mappings across all 4 targets, asset URL extraction for `Nibgrid-Studio-<version>-<platform>`, `curl | sh` & `irm | iex` output, HTTP `200` parsing, and HTTP `403`/offline fallbacks.

## Milestone 42B: Hardened One-Line CLI Installers (`public/install.sh` & `public/install.ps1`)

- **Installers & Workflow Naming (`public/install.sh`, `public/install.ps1`, `.github/workflows/release.yml`):** Authored strict POSIX `sh` (`set -eu`, `trap` cleanup, `shasum`/`sha256sum`) and PowerShell (`$ErrorActionPreference = "Stop"`, `Get-FileHash`) installers verifying `SHA256SUMS.txt`, aligned `release.yml` matrix across `macos-arm64.dmg`, `macos-x64.dmg`, `win-x64-setup.exe`, and `linux-x64.AppImage`, and updated `docs/RELEASING.md` + `docs/ARCHITECTURE.md`.
- **Verification (`tests/unit/m42b-cli-scripts.test.ts`):** Verified `sh -n public/install.sh` syntax cleanly and asserted exact SHA-256 verification and asset suffix parity across `install.sh`, `install.ps1`, and `release.yml`.

## Milestone 42C: Web UI `InstallDesktopModal.tsx`, PWA-Only Header Entry & E2E Flow

- **Modal, Store & Header Entry (`src/ui/desktop/InstallDesktopModal.tsx`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/command/CommandPalette.tsx`):** Added **Get Desktop App** top-bar button (hidden inside Desktop/VS Code Webview hosts), `Cmd+K` command, 4 OS switcher tabs, direct GitHub Release asset download CTA with HTTP `403`/offline fallback, 1-click CLI copy (`Copied!`), and post-install Antigravity auto-link guidance.
- **Verification (`tests/e2e/m42c-install-modal-e2e.spec.ts`):** Verified mocked `v1.2.0` release resolution across OS tabs + copy feedback, HTTP `403` rate-limit fallback with zero `pageerror`s, and desktop host hiding `nav-get-desktop-btn`.

## Loopback Bridge Hardening (`nibgrid_bridge.py` PEP 723, PNA/CORS, Mock PNG/WAV & Python Suite)

- **Hardened Bridge (`.agents/skills/nibgrid/scripts/nibgrid_bridge.py`, `.agents/skills/nibgrid/SKILL.md`, `docs/ARCHITECTURE.md`):** Upgraded the zero-dependency `uv`-compatible loopback server with PEP 723 metadata, strict `127.0.0.1` binding, `hmac.compare_digest` Bearer auth, `Origin` allowlisting (`--allow-origin` support), Chrome PNA `OPTIONS` headers, secret redaction (`redact_secrets`), deterministic stdlib RGBA PNG + 16-bit PCM WAV `--mock` payloads, live Gemini REST forwarding, and M10 `create_bridge_server()` compatibility.
- **Python Test Suite & CI Wiring (`tests/python/test_nibgrid_bridge.py`, `.github/workflows/ci-parity.yml`):** Added 9 ephemeral-port HTTP contract/security tests alongside the 6 M10 bridge tests and wired both into `ci-parity.yml`.

## Milestone 43A: Pure-TS Self-Update Checker Core (`updateCheckerCore.ts`)

- **Core Logic (`packages/vscode-extension/src/updateCheckerCore.ts`, `docs/ARCHITECTURE.md`, `docs/RELEASING.md`):** Added strict SemVer parsing/comparison (excluding pre-releases by default), 24h auto-check throttle (`shouldRunAutoUpdateCheck()`), `SHA256SUMS.txt` parser (`parseSha256Sums()`), and ETag-conditional `/releases/latest` checker (`checkForDesktopUpdate()`).
- **Verification (`packages/vscode-extension/test/m43a-update-checker.test.ts`):** Verified `1.2.0 -> 1.2.1/1.3.0/2.0.0`, equal/older/pre-release rejection, `304 Not Modified` ETag short-circuiting, `skippedVersion` gating, and HTTP `403`/`429`/network-error fallback.

## Milestone 43B: Streaming SHA-256 Verifier & Safe OS Installer Handoff (`desktopUpdater.ts`)

- **Streaming Verifier & OS Handoff (`packages/vscode-extension/src/desktopUpdater.ts`, `docs/ARCHITECTURE.md`, `docs/RELEASING.md`):** Added `verifyFileSha256()`, `downloadAndVerifyUpdate()` (isolated `os.tmpdir()` download + `crypto.timingSafeEqual` + recursive cleanup on `ChecksumMismatchError`), and shell-free `handoffVerifiedInstaller()` (`open` for macOS `.dmg`, detached `/SILENT` + app quit for Windows, atomic move + `chmod 0o755` for Linux AppImage).
- **Verification (`packages/vscode-extension/test/m43b-desktop-updater.test.ts`):** Verified streaming SHA-256 verification and OS handoff across macOS/Windows/Linux plus `ChecksumMismatchError` throw, temp dir deletion, and zero `execFile` invocations on 1-byte tampering.

## Milestone 43C: Status Bar UX, `globalState` Persistence & Command Palette Wiring

- **Extension Wiring (`packages/vscode-extension/package.json`, `packages/vscode-extension/src/extension.ts`, `docs/ARCHITECTURE.md`, `docs/RELEASING.md`):** Registered `nibgrid.checkForUpdates` and `nibgrid.updates.autoCheck`, added 10s delayed startup check with 24h throttle + `globalState` ETag/skip-version persistence, `$(cloud-download) Nibgrid v<latest>` status bar indicator, `withProgress` verified installer launch, and manual offline/rate-limit GitHub Releases fallback.
- **Verification (`packages/vscode-extension/test/m43c-extension-updates.test.ts`, `packages/vscode-extension/test/m39b-extension-host.test.ts`):** Verified 10s timer delay + clean cancellation, 24h throttle, `globalState` persistence, status bar show/hide, Skip This Version, Install Update flow, and full repo parity/unit/build gates.

## Pre-Release Checklist & Automated Post-Deploy Smoke Gate (`scripts/smoke-release.mjs`)

- **Smoke Gate & Release Workflow (`scripts/smoke-release.mjs`, `.github/workflows/release.yml`, `package.json`, `docs/RELEASING.md`, `docs/ARCHITECTURE.md`):** Added Playwright smoke verifier (`npm run smoke:release`) testing `install.sh` (`sh -n`), `install.ps1`, `manifest.webmanifest`, Service Worker offline reload, `InstallDesktopModal`, and zero console/page errors, plus exposed `deploy-pages.outputs.page_url` and added the 3-attempt CDN-retry `smoke-pages` job to `release.yml`.

## Milestone 44A: Pure-TS Normal Map & Emission Mask Baker (`normalEmissionBaker.ts`)

- **Core Pipeline (`src/processing/normalEmissionBaker.ts`, `docs/ARCHITECTURE.md`):** Implemented Zod config schemas (`NormalBakeConfigSchema`, `EmissionBakeConfigSchema`), height-field derivation (`luminance` / `alpha-bevel` / `hybrid`), 3×3 Sobel tangent-space baking (`bakeNormalMapFromRgba()`), neutral `(128, 128, 255, 0)` alpha-zero hygiene, and swatch/luminance emission extraction (`bakeEmissionMaskFromRgba()`).
- **Verification (`tests/unit/m44a-normal-emission.test.ts`):** Verified exact neutral interior normals on 16×16 solids, unit vector magnitude bounds (`0.98 <= ||N|| <= 1.02`), `invertY` G-channel flip, transparent pixel `(128, 128, 255, 0)` encoding, and isolated `#00ffcc` emission extraction.

## Milestone 44B: Godot 4 `CanvasTexture`, Normal `.import` & `LightOccluder2D` Exporter (`godotLightingExporter.ts`)

- **Exporter & Atomic Persistence (`src/export/godotLightingExporter.ts`, `src/export/godotPrefabAssembler.ts`, `src/sync/fsaaSyncEngine.ts`, `src/domain/schemas.ts`, `src/db/database.ts`, `docs/ARCHITECTURE.md`):** Implemented `exportCanvasTextureTres()`, `exportNormalMapImportFile()` (`compress/normal_map=1`), `exportLightOccluderSubResource()`, atomic `commitSpriteLightingBake()`, orphan tracking for `lightingBake` blobs, and M25 sync emission of `*_n.png`, `*_n.png.import`, `*_e.png`, and `*_canvas.tres`.
- **Verification (`tests/unit/m44b-godot-lighting.test.ts`):** Verified `load_steps` & `texture_filter`, `compress/normal_map=1`, RDP `OccluderPolygon2D` finite vertices, 0-orphan Dexie replacement, and M25 sync file output.

## Milestone 44C: Interactive WebGL2 `LightingBakerPanel.tsx` & E2E Flow

- **WebGL2 Lighting Studio & Navigation (`src/ui/lighting/LightingBakerPanel.tsx`, `src/ui/entities/EntityHubView.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`, `src/store/useAppStore.ts`, `docs/ARCHITECTURE.md`):** Built draggable `PointLight2D` WebGL2/CPU preview, 5-channel switcher (`lit`/`diffuse`/`normal`/`emission`/`occluder`), ArtBible emissive swatch extractor, and atomic **Bake & Attach to Asset** persisted to Dexie for M25 FSAA sync.
- **Verification (`tests/e2e/m44c-lighting-e2e.spec.ts`):** Verified live pointer light drag, normal strength adjustment, `_n.png`/`_n.png.import`/`_canvas.tres` FSAA sync, persistence across `page.reload()`, zero `pageerror`/`console.error`, and zero orphan blobs.

## Milestone 45A: Pure-TS World Map Graph & Softlock Auditor (`worldGraphCore.ts`)

- **Core Graph & Auditor (`src/world/worldGraphCore.ts`, `docs/ARCHITECTURE.md`):** Implemented Zod schemas (`WorldRoomNodeSchema`, `WorldPortalEdgeSchema`, `WorldGraphSchema`), `createDefaultWorldGraph()`, and `auditWorldReachability()` with fixed-point progression BFS, one-way softlock trap detection, cycle-safe traversal, missing `isStart` / dangling edge checks, and duplicate door/spawn validation.
- **Verification (`tests/unit/m45a-world-auditor.test.ts`):** Verified 4-room key-gated progression (`progressionOrder: ['boss_key']`), unreachable room flagging on missing key, one-way pit softlock detection (`softlockTrapRoomIds`), and cyclic graph termination + structural integrity flags.

## Milestone 45B: Pixel-Art Minimap Baker, Godot 4 World Exporter & Atomic Dexie Sync

- **Minimap Baker & Godot World Exporter (`src/world/minimapBaker.ts`, `src/export/godotWorldExporter.ts`, `src/export/godotRoomExporter.ts`, `src/db/database.ts`, `src/sync/fsaaSyncEngine.ts`, `docs/ARCHITECTURE.md`):** Implemented pure-TS `bakeWorldMinimapRgba()`, `exportRoomPortalNodes()` (`Area2D` portals + `Marker2D` spawns), typed `WorldTransitionManager.gd`, Dexie v9 `worldGraphs` + atomic `commitWorldGraphWithMinimap()` (0 orphan blobs), and M25 `collectProjectGodotSyncFiles()` wiring.
- **Verification (`tests/unit/m45b-minimap-godot.test.ts`):** Verified minimap RGBA dimensions/borders/doors, matching `minimap_atlas.json`, valid `Area2D`/`Marker2D` + GDScript output with zero `NaN`, atomic zero-orphan replacement, and full M25 `world/*` + `.tscn` sync output.

## Milestone 45C: Interactive `WorldMapPanel.tsx`, Tab/Parity Wiring & E2E Flow

- **World Map Editor & Navigation (`src/ui/world/WorldMapPanel.tsx`, `src/ui/inspector/workspaceTabs.ts`, `scripts/verify-parity.ts`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/inspector/RoomPrototyperWorkshop.tsx`, `src/ui/command/CommandPalette.tsx`, `docs/ARCHITECTURE.md`):** Built interactive snap-to-grid room graph, portal transition composer, 1-click BFS/DFS Softlock Audit UI with room jump links, pixelated minimap preview, and M25 `res://` world sync, registered in `ALL_INSPECTOR_TABS` & `EXPECTED_REQUIRED_INSPECTOR_TABS`.
- **Verification (`tests/e2e/m45c-world-map-e2e.spec.ts`):** Verified seeding 2 M35 rooms, connecting with `red_key` gate, catching `Issues Found` / unreachable warning before granting `red_key`, green `OK` audit after granting `red_key`, baking non-empty minimap canvas, reload persistence, zero `console.error`/`pageerror`, and zero orphan blobs.

## Milestone 46A: Game Data Schemas & Seeded Monte Carlo Simulator

- **Schemas & Balance Simulator (`src/data/gameDataSchemas.ts`, `src/data/balanceSimulator.ts`, `docs/ARCHITECTURE.md`):** Implemented Zod schemas (`WeaponItem`, `EnemyStatBlock`, `LootTable`, `ProgressionCurve`), referential validator `validateGameDataRegistry()`, deterministic Mulberry32 PRNG (`createMulberry32`), `simulateCombatTtk()`, `simulateLootEconomy()`, and `evaluateProgressionCurve()`.
- **Verification (`tests/unit/m46a-balance-sim.test.ts`):** Verified byte-identical seeded TTK/economy outputs (`seed: 42`), monotonic `p50TtkSec` reduction with increasing `baseDamage`, sponge/lethality warnings, dangling-reference validation failures, and XP progression table math.

## Milestone 46B: Godot 4 Typed `Resource` Exporter & Dexie v10 M25 Sync

- **Resource Schemas, `.tres` Instances & Sync (`src/export/godotDataExporter.ts`, `src/db/database.ts`, `src/sync/fsaaSyncEngine.ts`, `docs/ARCHITECTURE.md`):** Implemented typed `WeaponItemData.gd` / `EnemyStatData.gd` / `LootTableData.gd` schemas, escaped `format=3` `.tres` emitters, `toPlaytestCombatPatch()`, Dexie v10 `gameDataRegistries` persistence + cascade deletion, and M25 `collectProjectGodotSyncFiles()` wiring.
- **Verification (`tests/unit/m46b-godot-data.test.ts`):** Verified `format=3` / `load_steps=2` / escaped `.tres` syntax with zero `NaN`, all 3 `.gd` schema scripts, atomic Dexie persistence (0 orphans), and full `data/*` emission in M25 sync.

## Milestone 46C: Interactive `DataFoundryPanel.tsx`, Tab/Parity Wiring & E2E Flow

- **Data Foundry Studio & Playtest/Sync Wiring (`src/ui/data/DataFoundryPanel.tsx`, `src/ui/inspector/workspaceTabs.ts`, `scripts/verify-parity.ts`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`, `docs/ARCHITECTURE.md`):** Built tabbed inline editor (Items, Enemies, Loot Tables, XP Curves), live Balance Lab sidebar with Mulberry32 TTK histogram & balance warnings, **Push to M36 Playtest**, CSV/JSON downloads, and M25 `res://` `.gd`/`.tres` sync, registered in `ALL_INSPECTOR_TABS` & `EXPECTED_REQUIRED_INSPECTOR_TABS`.
- **Verification (`tests/e2e/m46c-data-foundry-e2e.spec.ts`):** Verified adding `flame_blade`, running seeded Monte Carlo TTK sim vs `goblin_scout`, writing `WeaponItemData.gd` + `flame_blade.tres` + `goblin_scout.tres` to FSAA stub, reload persistence, zero `console.error`/`pageerror`, and zero orphan blobs.

## Milestone 47A: Dialogue Graph Schemas, M24 Glyph Audit & M33 Overflow Auditor

- **Schemas & Auditors (`src/narrative/dialogueSchemas.ts`, `src/narrative/localizationAuditor.ts`, `docs/ARCHITECTURE.md`):** Implemented Zod dialogue/localization contracts (`DialogueChoice`, `DialogueNode`, `DialogueGraph`, `LocalizationTable`, `ProjectNarrativeBundle`), `validateDialogueGraph()`, Unicode codepoint-safe `auditFontGlyphCoverage()` (ignoring control/whitespace characters), and M24 advance/kerning `auditUiTextOverflow()` against M33 box constraints.
- **Verification (`tests/unit/m47a-dialogue-audit.test.ts`):** Verified dangling `nextNodeId`, unreachable node, and missing locale translation detection; Polish diacritic (`ó`, `ę`, `ł`, `ż`, `ń`) and astral codepoint (`U+1F6E1`) flagging against ASCII-only M24 fonts; and `100px` M33 button overflow detection on long German compound words.

## Milestone 47B: Godot 4 `TranslationServer` CSV, `DialogueRunner.gd` & Dexie v11 Sync

- **L10n Exporter & Dexie v11 (`src/export/godotDialogueExporter.ts`, `src/db/database.ts`, `src/sync/fsaaSyncEngine.ts`, `src/domain/schemas.ts`, `docs/ARCHITECTURE.md`):** Implemented RFC 4180 CSV exporter/parser (`exportGodotTranslationCsv`, `parseGodotTranslationCsv`), `exportDialogueGraphJson`, typed `DialogueRunner.gd` calling `tr(...)` and integrating M45 flags, Dexie v11 `narrativeBundles` transactional persistence + atomic glyph appending, raised `BitmapFontConfigSchema.customCharset` limit to 1024, and wired `localization/strings.csv` + `narrative/*` into `collectProjectGodotSyncFiles()`.
- **Verification (`tests/unit/m47b-godot-l10n.test.ts`):** Verified RFC 4180 CSV round-tripping with commas, doubled quotes, Polish diacritics, and embedded newlines; valid `dialogue_graph.json` and `DialogueRunner.gd` output with zero placeholders; and M25 virtual sync file assembly.

## Milestone 47C: Interactive `DialogueLocalizationPanel.tsx`, Tab/Parity Wiring & E2E Flow

- **Dialogue & L10n Studio (`src/ui/narrative/DialogueLocalizationPanel.tsx`, `src/ui/inspector/workspaceTabs.ts`, `scripts/verify-parity.ts`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`, `docs/ARCHITECTURE.md`):** Built branching node composer & localized preview, editable multi-locale string matrix (CSV import/export), live M24 missing-glyph + M33 text-overflow audit drawer with 1-click **Add Missing Glyphs to M24 Font** atomic Dexie repair, and M25 `res://` sync registered across `ALL_INSPECTOR_TABS`, `EXPECTED_REQUIRED_INSPECTOR_TABS`, and `Cmd+K`.
- **Verification (`tests/e2e/m47c-dialogue-e2e.spec.ts`):** Verified adding Polish dialogue (`"Stój, wędrowcze!"`), surfacing missing M24 glyph warnings (`ó`, `ę`), clearing warnings via 1-click glyph addition, syncing `localization/strings.csv` + `narrative/dialogue_graph.json` + `narrative/DialogueRunner.gd` to FSAA stub, reload persistence, zero `console.error`/`pageerror`, and zero orphan blobs.

## Milestone 48: Pure-TS Sprite Polish Pipeline, Foot-Anchor Stabilizer & Silent Quality Gate

- **Core Polish & Quality Gate (`src/processing/pixelPolish.ts`, `src/processing/frameStabilizer.ts`, `src/ai/styleLockGate.ts`, `src/ui/studio/SpriteStudio.tsx`, `src/ui/studio/GenerationInspector.tsx`, `docs/ARCHITECTURE.md`):** Implemented integer pixel-grid autocorrelation (`detectPixelGridScale`), OKLab quantization (`quantizeToArtBibleOklab`), 8-neighbor `stripOrphanPixels()`, bottom-20% COM foot-anchor frame stabilization (`stabilizeAnimationStrip`), automatic Golden Reference + approved-sprite anchor injection (`selectStyleLockAnchors`), silent max-1 auto-retry quality gate (`runWithSilentQualityGate`), and Sprite Studio `Auto-Polish` toggle.
- **Verification (`tests/unit/m48-sprite-polish.test.ts`, `tests/e2e/m48-polish-e2e.spec.ts`):** Verified exact `4x` scale detection, strict `ArtBible` OKLab quantization, 1px orphan stripping with 2x2 preservation, zero-jitter `bottomY` frame alignment, silent quality re-roll, and E2E Auto-Polish workflow with zero orphan blobs and zero page errors.

## Milestone 49: 4-Workspace UX, Creator/Pro Progressive Disclosure & 1-Click Fix-It Cards

- **4-Workspace Shell, Mode Store & Fix-It Cards (`src/ui/layout/workspaceShell.ts`, `src/state/uxModeStore.ts`, `src/ui/layout/ContextualInspector.tsx`, `src/ui/audit/fixItEngine.ts`, `src/ui/audit/FixItCardList.tsx`, `src/ui/export/ShipToGodotPanel.tsx`, `src/App.tsx`, `src/ui/audit/AuditMatrixView.tsx`, `src/ui/inspector/workspaceTabs.ts`, `scripts/verify-parity.ts`, `docs/ARCHITECTURE.md`):** Added 4 intent-driven workspace tabs (`Style & Vision`, `Cast & World`, `Play & Tune`, `Ship to Godot`), persistent `Creator | Pro` toggle hiding granular technical panels in Creator Mode behind curated presets, contextual selection inspector, and deterministic 1-click Fix-It Cards for missing M24 glyphs, M45 softlock traps, and off-palette sprites.
- **Verification (`tests/unit/m49-fixit-ux.test.ts`, `tests/e2e/m49-workspaces-e2e.spec.ts`):** Verified deterministic Fix-It state mutations clearing audit warnings, workspace mapping, Creator/Pro toggling, 1-click Fix-It execution in E2E, reload persistence, zero console/page errors, and zero orphan blobs.

## Milestone 50: Turnkey Godot 4 `GameKit` Scenes, Composable Prefabs & `addons/nibgrid_sync` Plugin

- **GameKit & EditorPlugin Exporter (`src/export/godotGameKitExporter.ts`, `src/export/godotPrefabBuilder.ts`, `src/export/godotPluginExporter.ts`, `src/sync/fsaaSyncEngine.ts`, `src/ui/export/ShipToGodotPanel.tsx`, `docs/ARCHITECTURE.md`):** Implemented 3 starter templates (`side-platformer`, `top-down-action`, `cozy-rpg`) emitting `project.godot`, `default_bus_layout.tres`, playable `main.tscn` (`GameShell.gd`), composable Entity `.tscn` prefabs (`HealthComponent`, `HurtboxComponent`, `HitboxComponent`, `AnimationPlayer`, `StateMachine`), and `addons/nibgrid_sync/` auto-scanning `EditorPlugin`, integrated directly into M25 FSAA sync and **Ship to Godot**.
- **Verification (`tests/unit/m50-godot-gamekit.test.ts`, `tests/e2e/m50-gamekit-sync-e2e.spec.ts`):** Verified valid `project.godot` InputMap/layers/integer scaling, exact `load_steps` + `AnimationPlayer` tracks in composable `.tscn` prefabs, valid `@tool extends EditorPlugin`, and full FSAA sync in E2E with zero console/page errors and zero orphan blobs.

## Milestone 51: Closed-Loop Godot 4 Project Compiler, Deletion-Aware Sync & ZIP Fallback

- **Project Compiler & Incremental Deletions (`src/export/godotProjectCompiler.ts`, `src/export/godotPluginExporter.ts`, `src/sync/syncDiff.ts`, `src/sync/fsaaSyncEngine.ts`, `src/ui/export/ShipToGodotPanel.tsx`, `docs/ARCHITECTURE.md`):** Added `validateGodotSceneGraph()` verifying all `res://` `ext_resource` targets prior to disk/ZIP export, `resolveEntityGameKitAssets()`, `removedPaths` hash pruning & `removeFilesFromDirectoryHandle()` in FSAA sync, M20/M23 bundle inclusion in `collectProjectGodotSyncFiles()`, and non-Chromium ZIP fallback in **Ship to Godot**.
- **Verification (`tests/unit/m51-godot-compiler.test.ts`, `tests/e2e/m51-godot-compiler-e2e.spec.ts`):** Verified dangling `res://` rejection, deletion-aware diffing, real asset wiring in GameKit entity prefabs, and UI badge/toggle/ZIP flows across unit and E2E suites.

## Milestone 52: Zero-Touch Asset Auto-Pipeline & Self-Healing Pre-Flight QA

- **Auto-Pipeline & Pre-Flight Auto-Heal (`src/processing/assetAutoPipeline.ts`, `src/sync/autoPipelineCommit.ts`, `src/processing/selfHealingQa.ts`, `src/sync/selfHealingCommit.ts`, `docs/ARCHITECTURE.md`):** Built deterministic single-click pipeline (`runZeroTouchAssetPipeline` -> `commitZeroTouchAssetToDb`) producing sprite + normal + emissive + collider + sockets + shader + SFX WAV + `.tscn` in one Dexie transaction, plus multi-pass `runSelfHealingPreFlight` invoked via `ship-autoheal-btn`.
- **Verification (`tests/unit/m52-auto-pipeline-heal.test.ts`, `tests/e2e/m52-auto-pipeline-e2e.spec.ts`):** Verified byte-identical auto-assembly outputs, zero orphan blobs on commit, iterative Fix-It auto-healing, and full E2E green pass.

## Milestone 53: Full-Game Reactive Autopilot DAG & Director Studio Workspace

- **17-Stage Reactive DAG & Director Studio (`src/processing/verticalSliceSchema.ts`, `src/processing/sliceDagRunner.ts`, `src/providers/verticalSliceDirector.ts`, `src/ui/director/DirectorStudioView.tsx`, `docs/ARCHITECTURE.md`):** Expanded vertical slice synthesis to multi-room `WorldGraph`, `GameDataRegistry`, `ProjectNarrativeBundle`, M52 Self-Healing QA, and GameKit ZIP/sync outputs behind selective cast invalidation and a top-level `#/project/:id/director` workspace.
- **Verification (`tests/unit/m53-director-autopilot.test.ts`, `tests/e2e/m53-director-studio-e2e.spec.ts`):** Verified selective DAG hash invalidation, 17-node multi-room GameKit synthesis (`0 broken res:// refs`), FSAA sync, reload persistence, and zero errors.

## Milestone 54: Director Verbs in Composer & MCP, Bidirectional Delta Sync & Headless Check

- **13 Studio Tools, 14 MCP Tools & Delta Sync (`src/agent/studioToolRegistry.ts`, `src/agent/stagingTransactions.ts`, `src/providers/assetAgentAdapter.ts`, `src/sync/bidirectionalSync.ts`, `packages/vscode-extension/src/extension.ts`, `docs/ARCHITECTURE.md`):** Added `create_entity_from_prompt`, `create_or_connect_room`, `tune_game_balance`, `author_dialogue_node`, and `run_preflight_autofix` across Composer (`Cmd+L`), VS Code `lm` tools, and MCP server with full rollback support, `reconcileGodotEditorDelta()`, and optional headless Godot 4 check-only integration.
- **Verification (`tests/unit/m54-director-agent-mcp.test.ts`, `tests/e2e/m54-director-composer-e2e.spec.ts`, `npm run verify:parity`):** Verified `13` Studio Tools / `14` MCP Tools parity, bidirectional delta reconciliation (`jumpVelocityPx` constraint compliance), Composer staged diff + checkpoint rollback, and extension bundle build.

## Milestone 55: Streamlined 4-Stage UX, Wired Creator/Pro Controls, Screenshots & Docs

- **Creator/Pro Control Wiring & Navigation Polish (`src/state/uxModeStore.ts`, `src/ui/layout/ContextualInspector.tsx`, `src/ui/inspector/ShaderStudio.tsx`, `src/ui/entities/EntityHubView.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/App.tsx`, `scripts/capture-readme-screenshots.mjs`):** Wired `useUxModeStore` `proDefaults` into controlled Pro Mode sliders and auto-pipeline defaults, connected curated Creator presets to live `ArtBible.artMode` updates, decluttered `prop`/`tile` primary tabs while preserving all 21 parity-tracked tabs, added `nav-director-studio`, and captured Playwright screenshots for Director Studio, Ship to Godot, and Director Composer.
- **Verification (`tests/unit/m55-ux-wiring.test.ts`, `tests/e2e/m55-ux-director-flow-e2e.spec.ts`):** Verified full pre-push verification gate (`typecheck`, `lint`, `format:check`, `verify:parity`, unit suite, VS Code extension bundle, desktop smoke check, production PWA build, and full Playwright E2E suite).
