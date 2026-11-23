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
- **Pure-TS Post-Processing Pipeline (`src/processing/`):** Separated every pixel transformation (`backgroundKey.ts`, `alphaCleanup.ts`, `paletteQuantize.ts`, `resampleAndTrim.ts`, `pipeline.ts`) from DOM APIs so Vitest asserts exact pixel invariants in Node. Placed OKLab palette quantization *after* resampling so Area-Average box downscaling never re-introduces off-palette intermediate RGB values.
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

