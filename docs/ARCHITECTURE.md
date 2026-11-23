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

## 8. Animated GIF89a & Horizontal Spritesheet Studio

- **Pure-TS GIF89a Encoder & Spritesheet Compositor (`src/processing/gif.ts`):** Builds `256`-entry Global Color Tables reserving index `0` for transparent pixels, emits Graphic Control Extensions (disposal method `2` / restore-to-background, per-frame centisecond delay, transparent color index), injects `NETSCAPE2.0` infinite-loop blocks, compresses frame pixels using LZW `minCodeSize = 8` via open-addressed hash tables, supports `pingPong` forward-plus-reverse loop expansion, and packs frames horizontally via `composeSpritesheetStrip()`.
- **Animation Exporter & Interactive Studio (`src/export/animationExporter.ts`, `src/ui/studio/AnimationStudioModal.tsx`):** Reuses `runPostProcessPipeline()` and `encodeRgbaToPngBytes()` across user-ordered DAG frames with optional auto color-key cutout, OKLab palette snapping, target frame resolution (`64`/`128`/`256`), live `<canvas>` onion-skin playback, `1–24 FPS` rate slider, and one-click `.gif` / spritesheet `.png` download.
- **Agent Bridge Export (`src/providers/antigravityProvider.ts`):** Exposes `window.__NIBGRID_AGENT_BRIDGE__.exportAnimatedGifBase64()` for programmatic `.gif` and horizontal spritesheet generation from the current project DAG.

## 9. Pixel-Art Foundry (Milestone 7)

- **Shared Buffer Contracts (`src/processing/types.ts`):** Defines `RgbaBuffer`, `Rgb`, `Oklab`, and `LightDirection` for zero-DOM pure-TS graphics passes.
- **De-Mixel Grid Snap (`src/processing/demixel.ts`):** Computes 1D L1 RGBA gradient energy profiles `(ex, ey)`, detects logical cell period via normalized autocorrelation with a `0.85` harmonic guard, sweeps integer phase offsets, and core-samples each cell into crisp integer pixels.
- **Orphan-Pixel Cleaner (`src/processing/orphanCleaner.ts`):** Runs 4-connected BFS island purging (`area <= maxIslandPixels`) plus interior 1px pepper despeckling.
- **OKLab Sel-Out Engine (`src/processing/selOut.ts`):** Computes 3×3 Sobel alpha normals aligned against the Art Bible's `lighting` vector to generate light-aware 1px `outer` / `inner` colored outlines, optionally snapping strictly to darker locked Art Bible palette swatches.

## 10. WebGL2 2D Normal Map Generator & Live Lighting (Milestone 8)

- **Exact Alpha EDT & CPU Normal Baker (`src/processing/distanceField.ts`):** Implements linear-time `O(W·H)` Felzenszwalb & Huttenlocher squared Euclidean Distance Transform (`computeExactAlphaEdt`, `computeBevelHeightmap`) with 1px transparent boundary padding (`spherical-dome`, `smoothstep`, `linear`) plus deterministic `bakeNormalMapCpu` fallback encoding neutral `(128, 128, 255, 0)` outside silhouettes.
- **2-Pass WebGL2 Shaders & Controller (`src/webgl/shaders/`, `src/webgl/normalMapRenderer.ts`):** Zero-VBO fullscreen triangle pass baking `bevel + Rec.709 luma` heightmaps via 3×3 Sobel into an offscreen RGBA8 FBO (`opengl` `+Y` vs `directx` `-Y`), paired with interactive 60 FPS Blinn-Phong point-light preview (`Lit`, `Normal Map`, `Bevel Height`, `Split`) and explicit GPU `.dispose()` cleanup.
- **Screen 4B & Bundle Integration (`NormalMapPreview.tsx`, `recipeBuilder.ts`, `zipPackager.ts`):** Adds interactive pointer-tracked lighting (`requestAnimationFrame`, pin/unpin click, `Alt+Wheel` Z-height) and bundles `<slug>_n.png` + `normalMap` metadata inside ZIP and File System Access directory exports.

## 11. MLS Puppet-Warp 2D Micro-Animator (Milestone 9)

- **Rigid & Similarity MLS Solver (`src/processing/mlsWarp.ts`):** Implements Schaefer–McPhail–Warren Moving Least Squares 2D deformation with exact pin-singularity handling (`distSq <= 1e-6`), single-pin translation fallback, zero inner-loop heap allocations, and per-vertex local rotation angle computation (`atan2(S, C)`).
- **Alpha-Clipped Mesh & Periodic Presets (`src/processing/spriteMesh.ts`, `animPresets.ts`):** Subdivides tight opaque bounds into `4px`/`8px` quads with a 1-cell halo, exposes `rasterizeDeformedMeshCpu` fallback, and evaluates 4 periodic cyclic presets (`idle-breathe`, `wind-sway`, `hit-recoil`, `squash-stretch`) with exact `t = 0 === t = 1` closure.
- **WebGL2 Mesh Animator & Screen 4C (`src/webgl/shaders/puppet.{vert,frag}.glsl`, `puppetRenderer.ts`, `PuppetWarpEditor.tsx`):** Deforms textured meshes at native resolution (`gl.NEAREST` pixel-art vs `gl.LINEAR` HD-2D), rotates optional `_n.png` normal tangents per vertex, supports optional per-frame `Re-Lock Pixel Polish`, renders red/blue onion-skin ghosts, persists `SpriteNode.puppetAnim`, and exports horizontal `<slug>_<anim>_strip.png` + `<slug>_<anim>.json` + `recipe.puppetAnim`.

## 12. Antigravity Loopback Bridge & Workspace Skill (Milestone 10)

- **Stateful Bridge Contract (`src/providers/bridgeContract.ts`, `antigravityBridgeProvider.ts`):** Implements `AntigravityBridgeProvider` (`http://127.0.0.1:4188`) with Zod-validated `/v1/health`, `/v1/generate`, `/v1/inpaint`, `/v1/critique`, and `/v1/cancel/:requestId` endpoints. Ephemeral `nbg_...` bearer tokens default to `sessionStorage` and are redacted in both `errors.ts` and `recipeBuilder.ts`.
- **Stateful `interaction_id` Chaining (`selectStatefulInteractionChain`):** Automatically passes `previousInteractionId` when branching from a same-provider `SpriteNode` with `>= 60s` remaining TTL, falling back to stateless full-context re-anchoring when expired or cross-provider.
- **Art Director Critique & `.agents/skills/nibgrid/`:** Surfacing `/v1/critique` scores, drift flags, and 1-click **"Apply Suggested Delta"** inside Screen 3, backed by the zero-dependency Python 3.11+ loopback daemon (`scripts/nibgrid_bridge.py` with strict Origin allowlist + PNA headers) and workspace Art Director skill (`SKILL.md`).

## 13. MaxRects Atlas Packer & Engine Exporters (Milestone 11)

- **BSSF MaxRects Bin Packer (`src/processing/maxRects.ts`):** Deterministically sorts sprites by longest side descending, reserves `extrude * 2 + padding` margins, splits & prunes free rects with Best Short Side Fit, spills cleanly across multi-page atlases, and shrinks to PoT bounds.
- **Deduplicating Lockstep Compositor (`src/processing/atlasCompositor.ts`):** Trims transparent outer bounds, hashes content with dual FNV-1a keys so duplicate frames pack once and alias UVs, blits 1–2px clamped edge extrusion to kill mipmap/camera seams, locks rotation OFF for Godot/normal maps, and composites lockstep `_n.png` atlases over `(128, 128, 255, 0)` gutters.
- **Multi-Engine Exporters & Screen 5 (`src/export/atlasExporters.ts`, `src/ui/atlas/AtlasWorkshop.tsx`, `useAppStore.ts`, `App.tsx`):** Generates PixiJS v8 JSON Hash, Phaser 3 Multiatlas JSON, and Godot 4 `format=3` `.tres` (`SpriteFrames`, `AtlasTexture`, `CanvasTexture` with `texture_filter = 1` pixel-art / `2` HD-2D), rendered live in Screen 5 (`#/project/:id/atlas`) with UV overlay, channel switcher, and multi-engine ZIP export.

## 14. Seamless Tile Wrap-Offset & Cross-Seam Workshop (Milestone 12A)

- **Pure-TS Toroidal Seam Core (`src/processing/seamlessTile.ts`):** Implements exact forward/inverse `wrapOffsetBuffer()` for even and odd canvases, trig-jittered center cross-seam mask generator (`generateCrossSeamMask()` with hard 2px outer border lock), opposite-edge `computeSeamContinuity()` L1 metric (`0..100`), and separable toroidal high-pass `flattenMacroLighting()`.
- **Screen 4D Seamless Tile & Normal Synergy (`src/ui/inspector/TileAndSliceWorkshop.tsx`, `src/webgl/normalMapRenderer.ts`, `src/processing/distanceField.ts`):** Provides split `1×1` wrapped mask preview and `3×3` tiled wall with toggleable gridlines, guided **Wrap 50% → Seam Inpaint → Un-Wrap & Commit** DAG flow, `AssetRecipe.seamlessTile` persistence, and automatic `gl.REPEAT` toroidal Sobel wrapping (`bevelStrength = 0`) when tagged `isSeamlessTile: true`.

## 15. Visual 9-Slice UI Panel Workshop & Engine Exporters (Milestone 12B)

- **Pure-TS Auto-Margin Detector & 9-Slice Renderer (`src/processing/nineSlice.ts`):** Implements border-band aware `autoDetectNineSliceMargins()` (resolving both gradient corner bevels and flat solid corner blocks over patterned interiors) and deterministic nearest-neighbor `renderNineSlice()` preserving fixed-scale corner blocks with `stretch`/`tile` edges and `stretch`/`tile`/`transparent` center fill.
- **Engine Exporters & Screen 4D Matrix (`src/export/nineSliceExporters.ts`, `TileAndSliceWorkshop.tsx`, `AtlasWorkshop.tsx`):** Emits Godot 4 `StyleBoxTexture` (`<slug>_stylebox.tres`), Phaser 3 JSON (`<slug>_nineslice_phaser.json`), PixiJS v8 JSON (`<slug>_nineslice_pixi.json`), and `AssetRecipe.nineSlice` metadata from Screen 4D (1px draggable guides, `Lock L=R` / `Lock T=B`, `240×48` / `72×220` / `180×180` + corner-resizable Stress-Test Matrix) and Screen 5 Atlas ZIP exports.

## 16. Indexed Palette-Swap & 1D/Stacked LUT Exporter (Milestone 12C)

- **Pure-TS Indexed Extraction & OKLCH Ramp Shifter (`src/processing/paletteLut.ts`):** Implements strict `<= 256`-color opaque palette extraction sorted by OKLab `L`/hue (with `quantizeBufferToMaxColors()` OKLab farthest-point recovery for `> 256`-color assets), agglomerative neutral/chromatic OKLCH ramp clustering (`clusterPaletteRamps()`), `0`/`360`-degree periodic OKLCH ramp transformations (`evaluatePaletteVariant()` preserving `#000000`/`#FFFFFF` identity within `<= 1` LSB), stacked `N×M` RGBA8 LUT encoding (`encodeLutBuffer()`), and exact reference decoding (`decodeIndexedSprite()`).
- **Screen 4E Studio & Engine Shaders (`src/ui/inspector/PaletteLutWorkshop.tsx`, `src/export/lutShaders.ts`, `schemas.ts`, `recipeBuilder.ts`):** Adds Screen 4E (**Palette-Swap & LUT**) with `>256`-color quantize guard, OKLCH Hue/Chroma/Lightness/Temperature sliders, per-swatch overrides, multi-variant live preview grid + `N×M` LUT strip, and ZIP export bundling `<slug>_idx.png`, `<slug>_lut.png` (or per-variant `N×1` LUTs), Godot 4 `.gdshader` (`filter_nearest`, half-texel `(palette_idx + 0.5)` lookup, flash uniforms), PixiJS v8 `Filter` TypeScript helper, and `AssetRecipe.paletteLut` metadata.

## 17. 1× Game Scale Sandbox (Milestone 13)

- **Pure-TS Procedural Biomes, Perimeter Contrast & Combat Juice (`src/processing/sandboxBiomes.ts`, `src/processing/sandboxContrast.ts`, `src/processing/sandboxState.ts`):** Generates deterministic, zero-asset `64×64` tiling biomes and 3-layer side-scroller parallax tiles (`dark-dungeon`, `urban-asphalt`, `sunlit-meadow`, `neutral-checker`, `bright-snow`), computes Rec.709 1px exterior contour luminance ratios & actionable Sel-Out/rim-light suggestions, and steps a `dt <= 50ms`-clamped combat-juice state machine (`40ms` hitstop freeze, `110ms` linear white/red flash decay, micro shake, knockback nudge, `WASD`/Arrow motion, and `Loop`/`Ping-Pong` animation clock).
- **Zero-Allocation Canvas2D Engine & Screen 4F Integration (`src/ui/inspector/sandboxEngine.ts`, `src/ui/inspector/GameSandbox.tsx`, `PostProcessInspector.tsx`, `DagTreeDock.tsx`, `SpriteStudio.tsx`, `useAppStore.ts`):** Pre-bakes biome tiles, parallax layers, per-frame sprites, `source-in` flash masks, and dark/light silhouettes on change with zero WebGL/WebGL2 contexts and zero per-frame rAF heap allocations. Blits integer `1×`–`4×` scaled virtual cameras (`320×180`, `480×270`, `640×360`) with `Normal`/`Value Check`/`Silhouette` lenses, grounded pivot shadows, input-isolated keyboard shortcuts, live M9 Puppet-Warp strips + M12 LUT variant switching, and 1-click **"1× Preview"** hash navigation (`#/project/:id/inspector/:nodeId?tab=sandbox`) from Screen 3.

## 18. Pure-TS Audio Synthesis, DSP & Google Audio Preset Core (Milestone 14A)

- **3-Layer Procedural SFX Synthesizer (`src/audio/proceduralSynth.ts`, `src/audio/types.ts`):** Uses a seeded Mulberry32 PRNG to synthesize deterministic `44.1 kHz` mono `Float32Array` PCM buffers composed of Transient Attack (`2–40 ms` click/punch), Subtractive/2-op FM Body with exponential pitch sweep, and a 2-pole Chamberlin SVF Noise Tail plus `tanh` soft saturation and bitcrushing.
- **Zero-Dependency PCM DSP & RIFF/WAVE16 Codec (`src/audio/pcmPostProcess.ts`, `src/audio/variations.ts`):** Implements sample-exact `cropRegionPcm()`, zero-crossing-snapped `trimSilencePcm()`, 100 Hz high-pass K-weighted `measureApproxLufs()` + soft-ceiling `normalizeLufsPcm()`, equal-power `makeSeamlessLoopPcm()`, chunk-scanning `encodeWav16()`/`decodeWav16()`, and seeded micro-variation batching (`generateProceduralVariations()`, `generatePcmVariations()`).
- **12-Preset Google Registry & Recipe Exporter (`src/audio/googlePresets.ts`, `src/export/audioExport.ts`, `src/domain/schemas.ts`):** Defines typed presets spanning Lyria 3/3.5 (`lyria-clip`, `lyria-full`), Gemini 3.8 TTS (`gemini-tts`), and Gemini JSON → Procedural Synth (`gemini-to-synth`), alongside Zod-validated `AudioAssetSchema`, `AudioBindingsSchema`, `AudioRecipeSchema` secret redaction, and `fflate` multi-variation WAV ZIP packaging.

## 19. Unified Google Audio Provider, Dexie Audio Bank & Screen 6 Studio (Milestone 14B)

- **Gemini Schema & Multi-Route Google Adapter (`src/audio/synthResponseSchema.ts`, `src/audio/googleAudioProvider.ts`):** Reuses Provider Vault's Gemini API key seamlessly across `lyria-3-clip-preview` / `lyria-3.5` (`/v1beta/interactions` with sprite/Golden Ref images), `gemini-3.8-flash-tts` / `flash-lite-tts` (`responseModalities: ["AUDIO"]`), `gemini-to-synth` (`responseSchema: PROCEDURAL_SFX_RESPONSE_SCHEMA`), and zero-cost `local-synth`, enforcing explicit cost badges (`$0.00`..`~$0.08`) and secret-redacted `ProviderError` handling.
- **Dedicated Audio Worker & Auditioning Player (`src/workers/audio.worker.ts`, `src/workers/audioClient.ts`, `src/audio/playbackEngine.ts`):** Offloads PCM synth, crop, trim, LUFS normalization, seamless loop crossfade, and 1/4/6-variation WAV encoding via transferable `ArrayBuffer`s and monotonic request guards, paired with a lazy headless-safe `AudioPlaybackEngine`.
- **Dexie v2 Audio Persistence & Screen 6 Studio (`src/db/database.ts`, `src/store/useAppStore.ts`, `src/ui/audio/AudioFoundry.tsx`, `src/App.tsx`):** Stores saved clips + variation WAV blobs in Dexie `audioAssets` with full `findOrphanBlobIds()` garbage collection, accessible via top-level Screen 6 (**Audio Foundry**, `#/project/:id/audio`) featuring category/preset selection, vocal-tag validation, interactive waveform crop canvas, LUFS meters, project bank, and ZIP/local-folder export.

## 20. 1× Game Scale Sandbox & 9-Slice Audio-Visual Juice Binding (Milestone 14C)

- **1× Sandbox Audio Trigger Hooks (`src/ui/inspector/sandboxEngine.ts`, `src/ui/inspector/GameSandbox.tsx`):** Wires `triggerHit()` (`H` shortcut or toolbar button) to play a randomly selected variation of `audioBindings.hitSfxId` synchronized with the `40ms` hitstop freeze, binds M9 Puppet-Warp animation frame steps to `frameSfxMap` / `stepSfxId`, and syncs seamless background playback of `bgmLoopId` with Play/Pause and Mute state.
- **9-Slice Tactile Button Auditioning & Persistence (`src/ui/inspector/TileAndSliceWorkshop.tsx`, `useAppStore.ts`, `schemas.ts`):** Adds **UI Click SFX** binding (`uiClickSfxId`) and clickable pressed-state buttons across the 9-Slice Stress-Test Matrix (`240×48`, `72×220`, `180×180`), persisting all project-level audio bindings in IndexedDB across reloads.

## 21. Pure-TS Vocal Sketch Analyzer & Contour-Following Synth (Milestone 15A)

- **10ms NSDF / McLeod Pitch Tracker (`src/audio/vocalAnalyzer.ts`):** Extracts per-frame normalized RMS envelope `A(t)`, fundamental pitch `f0(t)` (`65–1100 Hz` via Normalized Square Difference Function avoiding main-lobe locks and MPM 0.90 first key-maximum selection with parabolic lag interpolation), periodicity clarity, zero-crossing rate, scale-quantized MIDI notes (`extractMelodySummary()`), key, and BPM estimates.
- **Contour-Following Synth & Timbre Schema (`src/audio/contourSynth.ts`, `src/audio/contourPatchSchema.ts`, `src/domain/schemas.ts`, `src/export/audioExport.ts`):** Synthesizes byte-identical PCM driven by `A(t)` & smoothed `f0(t)` (routing voiced frames `clarity >= 0.55` into FM/subtractive + sub oscillators and unvoiced mouth noise into a 2-pole SVF noise engine), with strict Zod + Gemini `responseSchema` clamping (`parseAndClampContourPatch()`), 4 offline starter patches, and `audioSketch` recipe provenance (`sketchSha256`).

## 22. AudioWorklet Mic Recorder, Multimodal Hum Router & Worker Bridge (Milestone 15B)

- **Subpath-Safe AudioWorklet PCM Capture (`src/audio/micRecorder.ts`):** Captures raw `Float32Array` PCM frames via an inline `Blob`-URL `AudioWorkletProcessor` with `echoCancellation: false, noiseSuppression: false, autoGainControl: false`, 10s cap, live RMS VU metering, auto silence trim, `.wav` ingest (`ingestWavSketchBytes()`), and guaranteed `MediaStreamTrack.stop()` + `URL.revokeObjectURL()` + `AudioContext.close()` cleanup on stop, error, or dispose.
- **Multimodal Hum-to-Sound Router & Worker Jobs (`src/audio/humToSoundProvider.ts`, `src/workers/audio.worker.ts`, `src/workers/audioClient.ts`):** Implements Route A (`hum-to-timbre` inline `audio/wav` → Gemini `ContourTimbrePatch` JSON), Route B (`hum-to-lyria` compiling extracted BPM & key into Lyria Interactions), Route C (`hum-to-tts` cadence transcription → `gemini-3.8-flash-tts`), secret-redacted `ProviderError` handling, and worker offloaded `ANALYZE_VOCAL_SKETCH` / `SYNTH_FROM_CONTOUR` execution.

## 23. Mic Sketch UI, Pitch Ribbon Canvas & End-to-End Hum-to-Sandbox Loop (Milestone 15C)

- **Pitch & Mouth-Foley Visualizer (`src/ui/audio/PitchRibbonCanvas.tsx`):** Draws logarithmic `65–1100 Hz` glowing cyan `f0(t)` contours over slate RMS envelope bars and amber highlights on unvoiced mouth-foley bursts (`clarity < 0.55 && rms > 0.1`), paired with real-time BPM, musical key, note count, and SHA-256 sketch telemetry.
- **Mic SketchPad & Contour Timbre Controls (`src/ui/audio/MicSketchPanel.tsx`, `src/ui/audio/AudioFoundry.tsx`):** Adds Screen 6 source-mode tabs (`audio-tab-presets` / `audio-tab-mic-sketch`), 10s hold-to-record `R` shortcut isolated from focused inputs/textareas, `.wav` upload, 6 quick intent chips, single-key multimodal route selection (`local-contour`, `hum-to-timbre`, `hum-to-lyria`, `hum-to-tts`) with transparent cost badges, real-time `$0.00` octave/smoothing/scale/FM/breath/bit-depth sliders, A/B `My Hum` vs. `Transformed Sound` auditioning, IndexedDB persistence (`audioSketch` metadata), `.zip` + `.audio.recipe.json` export, and direct Screen 4F Sandbox `H` hit-flash binding.

