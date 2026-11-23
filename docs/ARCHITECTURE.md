# Nibgrid Architecture

## 1. Module Boundaries

- `src/domain/`: Pure TypeScript domain contracts, Zod runtime schemas, palette parsers (`.hex`, GIMP `.gpl`), deterministic prompt compiler, and DAG state engine. Runs identically in Node (Vitest) and browser contexts without DOM or Canvas dependencies.
- `src/processing/`: Pure TypeScript pixel-buffer (`Uint8ClampedArray`) image transforms, adaptive thresholding, ink bounding-box alignment, SHA-256 hashing (`crypto.subtle`), deterministic PNG encoding/decoding, canvas undo/redo history, and procedural sprite synthesis.
- `src/workers/`: Thin Dedicated Web Worker wrappers (`normalize.worker.ts`) executing `src/processing/` math off the main UI thread.
- `src/db/`: Typed Dexie.js IndexedDB persistence layer with runtime Zod validation and explicit cascade deletion for orphaned binary blobs.
- `src/providers/`: `ProviderAdapter` contract and built-in `OfflineMockProvider` (deterministic seeded procedural 2D sprite & inpaint generator).
- `src/store/`: Zustand store coordinating active project state, studio viewport controls, and persistence synchronization.
- `src/ui/`: React 19 UI organized into three screens:
  - `src/ui/hub/`: Screen 1 — Project Hub & Local Provider Vault
  - `src/ui/bible/`: Screen 2 — Art Bible ("Style Lock") Editor
  - `src/ui/studio/`: Screen 3 — Sprite Studio (Sketch/Mask Canvas, Viewport, Generation Inspector, Branching DAG Dock & Compare View)

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

