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

