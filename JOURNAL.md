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

