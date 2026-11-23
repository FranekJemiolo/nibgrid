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

