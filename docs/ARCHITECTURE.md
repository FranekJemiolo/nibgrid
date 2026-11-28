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

| Table             | Key & Indexes                                          | Stored Payload                                                                                        |
| ----------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `projects`        | `id`, `updatedAt`, `name`                              | Project metadata + validated `ArtBible` configuration                                                 |
| `blobs`           | `id`, `sha256`, `createdAt`                            | Binary `Blob` (`image/png`, etc.), `mimeType`, `sha256`                                               |
| `spriteNodes`     | `id`, `projectId`, `parentId`, `[projectId+createdAt]` | Immutable DAG node linking `imageBlobId`, optional `maskBlobId`, `sketchSha256`, and `generationMeta` |
| `providerConfigs` | `id`, `kind`, `updatedAt`                              | Local BYOK/BYOM provider settings and capabilities                                                    |

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

## 24. Pure-TS Marching Squares, Closed-Loop RDP & Convex Hull Core (Milestone 16A)

- **Exact Integer Half-Pixel Marching Squares & Fitters (`src/processing/collisionHull.ts`):** Traces closed clockwise loops on `(W+2)×(H+2)` zero-padded binary alpha masks using doubled integer half-pixel coordinates (`traceMarchingSquaresContours()`), applies antipodal-split closed-loop Ramer-Douglas-Peucker simplification (`simplifyClosedPolygonRdp()`), computes Andrew's Monotone Chain convex hulls (`computeConvexHull()`), fits tight AABBs and vertical/horizontal `CapsuleShape` bounds, enforces optional `maxVertices` vertex budgets, and transforms coordinates relative to `pivotPx`.
- **Schema & Recipe Persistence (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `CollisionLayerShapeSchema` (`collider` / `hurtbox` / `hitbox` semantics, `isSensor`, `capsule`, `activeFrames`, `autoTraceMeta`) on `SpriteNodeSchema` and `AssetRecipeSchema`.

## 25. Godot 4 & Matter.js / Phaser 3 Physics Exporters & Bundle Packaging (Milestone 16B)

- **Engine Physics Exporters (`src/export/colliderExporters.ts`):** Emits Godot 4 `ConvexPolygonShape2D` / `CapsuleShape2D` `.tres` (`format=3`) resources with `PackedVector2Array(...)` coordinates and secondary layer comments (`exportGodotColliderTres()`), plus PhysicsEditor-compatible Phaser 3 / Matter.js JSON preserving `isSensor` semantics (`collider: false`, `hurtbox`/`hitbox: true`) and M9 `activeFrames` (`exportMatterPhysicsJson()`).
- **Screen 4 ZIP & Screen 5 Atlas Physics Packaging (`src/ui/inspector/PostProcessInspector.tsx`, `src/ui/atlas/AtlasWorkshop.tsx`):** Automatically emits `<slug>_collider.tres`, `<slug>_matter.json`, and `collisionShapes` inside `<slug>.recipe.json`, plus combined `atlas_physics.json` across selected sprites/loops in MaxRects Atlas Workshop.

## 26. Screen 4G Interactive Hitbox/Hurtbox Editor & M9 Frame Binding (Milestone 16C)

- **Screen 4G Collider Editor (`src/ui/inspector/ColliderEditor.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/store/useAppStore.ts`):** Mounts the **Collider & Hitbox** inspector tab (`#project/:id/inspector/:nodeId?tab=collider`) with semantic `Collider` (emerald), `Hurtbox` (sky), and `Hitbox` (crimson) layer management, 1-click Auto-Trace (`convex-hull`, `polygon`, `aabb`, `capsule`, `8-Vertex Box2D Safe` preset), live convexity/vertex badges, HiDPI-invariant pointer vertex dragging (`window` listeners on SVG `viewBox` CSS bounds), edge midpoint insertion, right-click/`Delete` removal (enforcing `>= 3` vertices & input focus isolation), M9 Puppet-Warp frame timeline scrubbing with onion-skinning & per-frame `activeFrames` gating, and Godot 4 / Matter.js snippet previews + ZIP persistence.

## 27. Pure-TS Project Audit Engine & Art Bible Sync Hashing (Milestone 17A)

- **Canonical Sync Hashing (`src/processing/projectAudit.ts`, `src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Implements synchronous pure-TS FIPS 180-4 SHA-256 (`sha256HexSync()`, `computeArtBibleHash()`) over canonical style-defining Art Bible fields (`projection`, `lighting`, `artMode`, `palette`) and stamps `recipeArtBibleHash` onto processed `SpriteNode` and `asset.recipe.json` records in `PostProcessInspector.tsx`.
- **Unified Audit Rules & Readiness Score (`auditSpriteAsset`, `auditAudioAsset`, `summarizeProjectAudit`):** Reuses M7 `detectPixelGrid()`, M13 `computeBiomeContrast()`, and M14 `measureApproxLufs()` alongside palette compliance (`0%` pass, `< 2%` warn, `>= 2%` fail), collider/normal-map coverage, leading-silence checks (`> 25 ms`), and recipe hash staleness to compute per-asset severity badges and a weighted 0–100 **Project Readiness Score**.

## 28. Deterministic Batch Recipe Runner, Cancellation & Rollback (Milestone 17B)

- **Dry-Run Planner & Atomic Batch Executor (`src/processing/batchRunner.ts`):** Builds zero-mutation `$0.00` preview manifests (`buildBatchDryRunSummary()`), replays sprites sequentially from immutable `imageBlobId` sources via `runPostProcessInWorker()`, auto-traces missing `collider` hulls without overwriting manual `hitbox`/`hurtbox` layers, trims and LUFS-normalizes audio WAVs, commits each asset inside an isolated Dexie `rw` transaction (performing heavy compute strictly outside transactions), honors `AbortSignal` between assets, and records a session `rollbackManifest`.
- **Session Undo & Orphan Garbage Collection (`rollbackBatchRun`, `cleanupSupersededBatchBlobs`):** Retains superseded pre-batch blobs until discarded so 1-click Undo atomically reverts modified/forked records and invokes `findOrphanBlobIds(db)` cleanup to leave zero leaked IndexedDB blobs.

## 29. Screen 7 Audit Matrix UI & Batch Recipe Runner Workflow (Milestone 17C)

- **Audit Matrix & Readiness Telemetry (`src/ui/audit/AuditMatrixView.tsx`, `src/store/useAppStore.ts`, `src/App.tsx`):** Mounts top-level Screen 7 (`Audit`, `#/project/:id/audit`) featuring the weighted `0–100` Project Readiness Score, `Pass`/`Warn`/`Fail`/`Stale`/`Sprites`/`Audio` filters, live Target Biome selector updating the `1× Contrast` column via `generateBiomeTile()` + `computeBiomeContrast()`, **Fix All Stale & Failing** one-click selector, and jump-to-fix navigation straight into the corresponding Screen 4 / Screen 6 tab.
- **Batch Runner Drawer & Session Undo (`src/ui/audit/BatchRunnerDrawer.tsx`):** Provides deterministic operation toggles, `in-place` vs `fork-children` DAG commit mode, `$0.00 local compute` dry-run summary, live progress + cancellation bar, **Before → After Readiness Score** banner, and 1-click **Undo Batch** with automatic unmount/supersede orphan blob cleanup.

## 30. Pure-TS Connected-Component Turnaround Slicer & Schemas (Milestone 18A)

- **Pure-TS Auto-Slicer (`src/processing/turnaroundSlicer.ts`):** Implements iterative 4-connected BFS component labeling over opaque alpha pixels (`detectTurnaroundSlots()`), purges small noise specks (`minComponentPixels`), merges detached accessories (e.g., floating hats/weapons) into their owning `2×2` quadrant or `1×4` horizontal quarter by centroid proximity, scales frames to median height (`normalizeHeight`), anchors every cropped sprite's bottom-center onto one `sharedPivotPx`, and optionally mirrors East into West pixel-for-pixel (`mirrorEastToWest` via `flipBufferHorizontal()`).
- **Schema & Recipe Provenance (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `TurnaroundLayoutSchema` (`2x2 | 1x4`), `CardinalDirectionSchema` (`south | east | north | west`), and `TurnaroundMetaSchema` (`isTurnaroundSheet`, `turnaroundLayout`, `directionGroupId`, `cardinalDirection`, `scaleApplied`, `sharedPivotPx`) onto `SpriteNodeSchema` and `AssetRecipeSchema`.

## 31. Orthographic Sheet Mode, Worker Slicing, Atomic 4-View DAG Commit & Atlas Grouping (Milestone 18B)

- **Prompt Compiler & Offline Mock Sheet Generator (`src/domain/promptCompiler.ts`, `src/processing/proceduralSprite.ts`, `src/providers/mockProvider.ts`):** Extended `compilePrompt()` with `sheetLayout` (`single | 2x2 | 1x4`) appending strict orthographic 4-view turnaround instructions (`no grid lines`, `no text labels`, uniform baseline/height). Extended Mock Provider (`synthesizeProceduralTurnaroundSheet()`) to generate deterministic `128×128` (`2×2`) and `256×64` (`1×4`) 4-view sheets offline for CI verification.
- **Worker Slicing & Atomic Dexie Commit (`src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`, `src/domain/turnaroundCommit.ts`):** Added `SLICE_TURNAROUND_SHEET` (`sliceTurnaroundInWorker()`) running background removal + `sliceAndAlignTurnaround()` off the main thread with transferable buffers. Added `commitTurnaroundViews()` (pre-encoding PNGs/SHA-256 outside transactions before committing all 4 linked child `SpriteNode`s with shared `directionGroupId` and `sharedPivotPx` inside a single Dexie `rw` transaction) plus `deleteTurnaroundDirectionGroup()` with `findOrphanBlobIds(db)` garbage collection.
- **Screen 3 & Screen 5 Integration (`GenerationInspector.tsx`, `SpriteStudio.tsx`, `DagTreeDock.tsx`, `AtlasWorkshop.tsx`):** Added the `Single Sprite | Turnaround (2×2) | Turnaround (1×4)` toggle above Prompt Delta, `Sheet 2×2` / `S`/`E`/`N`/`W` DAG badges, directional suffix frame IDs (`_south`, `_east`, `_north`, `_west`), and 1-click **"Select All 4 Directions"** grouped selection inside MaxRects Atlas Workshop.

## 32. Screen 4H Turnaround Slicer, Onion-Skin & Turntable Preview (Milestone 18C)

- **Turnaround Slicer Workshop (`src/ui/inspector/TurnaroundSlicer.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/store/useAppStore.ts`):** Mounts Screen 4H (`Turnaround Slicer`, `?tab=turnaround`), auto-selecting whenever the active `SpriteNode` carries `turnaroundMeta.isTurnaroundSheet`. Passes true native sheet buffers (`rawSheetBuffer`) off-thread into `sliceTurnaroundInWorker()`, renders color-coded slot bounding boxes (`south` emerald, `east` amber, `north` sky, `west` violet), exposes per-slot direction overrides, `2×2` / `1×4` layout switch, `Normalize Height`, `Mirror East → West`, `Padding`, and `Min Speck Pixels` controls, previews a zero-allocation `35%` Onion-Skin composite or `1–6 FPS` `requestAnimationFrame` Turntable over the shared `pivotPx` crosshair (strictly cancelling rAF on `document.hidden` and unmount), and commits 4 atomic child nodes via `commitTurnaroundViews()`.

## 33. Neutral Studio Chrome, `ScrubInput` & Floating `CanvasHud` (Milestone 19A)

- **Color-Accurate Neutral Chrome (`src/styles/tokens.css`, `src/index.css`, `src/App.tsx`):** Introduces true achromatic CSS custom properties (`--bg-well: #111113`, `--bg-panel: #18181B`, `--bg-elevated: #222226`, `--border-hairline: #2B2B30`, `--accent-primary: #E5A00D`) paired with Tailwind v4 `@theme` neutral overrides so legacy slate surfaces shift to color-neutral dark gray without skewing warm highlight judgment, reserving saturated chromatic hues strictly for semantic physics/audit indicators.
- **Scrubbable Numeric Pills (`src/ui/primitives/scrubMath.ts`, `src/ui/primitives/ScrubInput.tsx`):** Provides a pure-TS horizontal scrubbing kernel (`computeScrubbedValue()`, `formatScrubValue()`) with `0.1×` `Shift`-precision damping and float-safe rounding, wrapped in an accessible `role="spinbutton"` pill supporting pointer capture drag, arrow keys, and double-click inline numeric entry (`Enter` commit / `Escape` cancel), deployed across Screen 4A (`PostProcessInspector.tsx`) and Screen 4G (`ColliderEditor.tsx`).
- **Floating Bottom-Center `CanvasHud` & Collapsible `288px` Drawer (`src/ui/primitives/CanvasHud.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Replaces the heavy top canvas toolbar with a frosted bottom-center pill containing zoom step/presets (`1×/2×/4×/8×/Fit`), pixel grid toggle, wipe toggle, and 5 backdrop swatches (`Checker`, `#111`, `#808`, `#E4E`, `Game Green`), narrowing the desktop inspector drawer to a collapsible `288px` sidebar (`>= 70%` viewport canvas width).

## 34. Asset-Type-Aware Workspaces, Always-On `1×` PiP Biome Preview & `BeforeAfterWipe` (Milestone 19B)

- **Contextual Tab Resolution (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/ui/inspector/workspaceTabs.ts`):** Adds optional `AssetClass` (`character`, `prop`, `tile`, `ui-panel`, `vfx`) onto `SpriteNodeSchema` and `AssetRecipeSchema`, auto-inferring `'tile'` / `'ui-panel'` when enabling tiling or 9-Slice on unclassified assets and resolving context-specific primary tabs alongside an accessible `+ Tools` overflow menu (`resolveInspectorTabs()`, collapsing `ui-panel` to 3 primary tabs).
- **Always-On `1×` PiP Biome Preview (`src/ui/inspector/PipBiomePreview.tsx`):** Renders a draggable, collapsible `168×126` Canvas2D `1×` native preview over M13 `generateBiomeTile()` terrain with live WCAG perimeter contrast (`computeBiomeContrast()`), `P` shortcut (strictly isolated from form inputs), jump-to-Sandbox action, `localStorage` persistence, and zero WebGL2 contexts or background rAF loops (hidden while inside Screen 4F Sandbox).
- **Universal `BeforeAfterWipe` (`src/ui/primitives/BeforeAfterWipe.tsx`, `PostProcessInspector.tsx`, `NormalMapPreview.tsx`, `PaletteLutWorkshop.tsx`):** Provides a shared pointer-captured CSS `clip-path` wipe comparator (`\` shortcut toggle, `ArrowLeft`/`ArrowRight` nudge, double-click `50%` reset, preserving center alignment at `100%–400%` and HiDPI) across Raw vs. Processed (Screen 4A), Flat Albedo vs. Lit Normal (Screen 4B), and Base vs. LUT Variant (Screen 4E).

## 35. `Cmd/Ctrl+K` Command Palette & Universal Drop Router (Milestone 19C)

- **Fuzzy Command Ranking (`src/ui/command/commandRegistry.ts`, `src/ui/command/CommandPalette.tsx`, `src/App.tsx`):** Implements a zero-DOM whitespace-tokenized subsequence and word-prefix ranker (`scoreCommandMatch()`, `rankCommands()`) driving the `Cmd/Ctrl+K` (and header `⌘K`) palette across all workspace screens, Inspector actions (`Auto-Trace Convex Hull`, Sandbox, Tile & 9-Slice, LUT, Normal, Puppet, Turnaround), and live project sprites/audio clips with full keyboard navigation and focus restoration.
- **Universal File Drop Router (`src/ui/command/UniversalDropOverlay.tsx`):** Intercepts external OS file drags (`Files` transfer type only, ignoring internal UI drags) across the app shell and presents a one-click routing dialog for dropped `.png`/`.webp` images (Import Sprite Node, Add Golden Reference, Slice 2×2 Turnaround Sheet, or Extract Top-8 Swatches to Art Bible) and `.wav`/`.mp3` audio clips (Import to Audio Foundry), deferring Dexie blob writes until explicit confirmation to guarantee zero orphaned blobs on cancel.

## 36. Auto-Tiling Bitmask Gating & SDF Terrain Compositor (Milestone 20A)

- **Canonical 47-Tile Blob & 16-Tile Wang SDF Core (`src/processing/autoTile.ts`):** Pure-TS zero-DOM module exporting 8-bit neighbor bit constants (`BIT_N..BIT_NW`), `gateBlobMask()` stripping un-cornered diagonals to collapse 256 combinations into the exact 47 canonical Blob masks (`getCanonicalBlob47Masks()`), `getCanonicalWang16Masks()`, `computeAutoTileGridMask()` for live tilemap painting, and `composeAutoTileSheet()` packing `8×6` (`blob-47`) or `4×4` (`wang-16`) terrain sheets over optional modular-wrapped underlays using smooth rounded outer/inner corner SDFs, deterministic `hash2d` jitter, and `'crisp-bevel'` / `'organic-overhang'` / `'pixel-outline'` styles while guaranteeing `100%` opacity on fully connected centers (`mask === 255` / `15`).
- **Auto-Tile Schema & Recipe Provenance (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `AutoTileModeSchema`, `AutoTileEdgeStyleSchema`, and `AutoTileConfigSchema` (`mode`, `edgeStyle`, `borderWidthPx`, `cornerRadiusPx`, `jitterPx`, `edgeTintHex`, `seed`, `underlayNodeId`, `sampleMapBits`) onto `SpriteNodeSchema` and `AssetRecipeSchema`.

## 37. Godot 4 `TileSet` `.tres`, Tiled `.tsx` Exporters & Worker Offloading (Milestone 20B)

- **Pure-TS Auto-Tile Engine Exporters (`src/export/autoTileExporters.ts`):** Generates Godot 4 `TileSet` `.tres` (`format=3`) resources with `Vector2i` region sizes and exact `terrains_peering_bit/*` bindings (`terrain_set_0/mode = 0` for `blob-47`, `mode = 1` for `wang-16`), plus Tiled `.tsx` XML `<wangsets>` using clockwise 8-slot `wangid` attributes (`N,NE,E,SE,S,SW,W,NW`), packaged alongside packed sheet PNGs and Zod-validated `.recipe.json` manifests via `packageAutoTileZip()`.
- **Worker Transfer Pipeline (`src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Added `COMPOSE_AUTO_TILE_SHEET` (`executeComposeAutoTileJob` / `composeAutoTileInWorker()`) executing `composeAutoTileSheet()` off the main thread with transferable RGBA buffers and synchronous main-thread fallback in non-Worker environments.

## 38. Screen 4I Interactive Auto-Tile Paint-Test Workshop (Milestone 20C)

- **Workspace Navigation & Contextual Discovery (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registered `?tab=autotile` as a primary tab whenever a sprite is classified as `'tile'` (kept inside `+ Tools` overflow for character/prop/UI/VFX assets so `ui-panel` stays collapsed to 3 tabs) and added **"Open Auto-Tile Terrain Generator"** to the `Cmd/Ctrl+K` Command Palette.
- **Interactive `12×8` Live Terrain Sandbox (`src/ui/inspector/AutoTileWorkshop.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Pairs Worker-composed `Blob-47` (`8×6`) / `Wang-16` (`4×4`) packed sheets over optional project underlay sprites with a zero-WebGL2 Canvas2D `12×8` paint/erase map (`computeAutoTileGridMask()`), `ScrubInput` SDF geometry controls, Dexie persistence (`sampleMapBits` + `AutoTileConfig`), and 1-click Terrain Bundle `.zip` export (packed PNG + Godot 4 `.tres` + Tiled `.tsx` + `.recipe.json`).

## 39. Named Attachment Sockets & Barycentric Mesh Tracking (Milestone 21A)

- **Pure-TS Barycentric Socket Tracker (`src/processing/attachmentSockets.ts`):** Binds named sockets (`hand_r`, `hand_l`, `muzzle`, `exhaust`, `head`, `center`, or sanitized `^[a-z0-9_]+$` custom IDs) once onto the rest MLS triangulation (`bindSocketToRestMesh()`), skipping near-degenerate triangles (`|denom| < 1e-7`) and falling back cleanly to the nearest triangle centroid `[1/3, 1/3, 1/3]` when outside mesh silhouettes. Evaluates per-frame world coordinates, pivot-relative child transforms (`pivotRelativePx`), and branch-cut-safe local triangle edge rotations (`angleDeg`) across M9 Puppet-Warp deformed frames (`evaluateSocketAtFrame()`, `evaluateSocketsAcrossFrames()`), returning rest-pose coordinates with `boundToMesh: false` on static sprites.
- **Schema & Recipe Persistence (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `SocketDefinitionSchema` and optional `sockets?: SocketDefinition[]` on `SpriteNodeSchema` and `AssetRecipeSchema`.

## 40. Engine Socket Exporters & Automatic ZIP Bundling (Milestone 21B)

- **Zero-DOM Engine Exporters (`src/export/socketExporters.ts`):** Generates Godot 4 `Marker2D` `.tscn` scene snippets (`exportGodotSocketsTscnSnippet()`, emitting pivot-relative `Vector2` positions, radians rotation, rest-pose fallbacks, and optional multi-frame `AnimationPlayer` keyframe comments), Phaser 3 per-frame socket JSON (`exportPhaserSocketsJson()`), PixiJS per-frame transform JSON (`exportPixiSocketsJson()`, including `rotationRad`, `angleDeg`, and unit scale), and the canonical `<slug>_sockets.json` payload (`buildUnifiedSocketsJson()`, `buildSocketExportFiles()`).
- **Automatic ZIP Integration (`src/export/zipPackager.ts`):** Extended `PackageSpriteZipInput` with `evaluatedSocketsByFrame` and `socketFps` so `packageSpriteZip()` automatically bundles `<slug>_sockets.json` alongside `<slug>.png` and Zod-validated `<slug>.recipe.json` whenever `recipe.sockets` is non-empty (falling back cleanly to rest-pose coordinates relative to `recipe.output.pivotPx` on static sprites).

## 41. Interactive Attachment Sockets Editor & Screen 4 Integration (Milestone 21C)

- **Workspace Discovery & Palette Integration (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registered `?tab=sockets` (`InspectorTab`), promoted `'sockets'` to primary tabs for `'character'`, `'prop'`, and `'vfx'` assets (keeping `'ui-panel'` collapsed to 3 primary tabs and tucking secondary tools into `+ Tools`), and added **"Open Attachment Sockets Editor"** to the `Cmd/Ctrl+K` Command Palette.
- **Zero-WebGL2 Interactive Socket Overlay (`src/ui/inspector/SocketEditor.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Pairs a Canvas2D rest/CPU-deformed stage (`rasterizeDeformedMeshCpu()`) with a `viewBox`-scaled SVG marker overlay (`socket-svg-overlay`), amber pivot crosshair, preset (`hand_r`, `hand_l`, `muzzle`, `exhaust`, `head`, `center`) and sanitized custom socket forms, `devicePixelRatio`-invariant `window` pointer dragging, `ScrubInput` base angle controls, form-isolated `Delete`/`Backspace` removal, live Godot 4 / Phaser 3 / PixiJS export snippet previews, Dexie persistence, and automatic `<slug>_sockets.json` + `sockets[]` recipe emission on ZIP and Local Folder exports.

## 42. Pure-TS 2D VFX Flipbook Synthesizer, FBM Noise & Schema (Milestone 22A)

- **Pure-TS Procedural Flipbook Baker (`src/processing/vfxFlipbook.ts`):** Zero-DOM deterministic synthesizer (`mulberry32()`, `valueNoise2d()`, 3-octave `fbm2d()`, `bakeVfxFlipbook()`) evaluating `cols × rows` frames across `t in [0, 1]` for `'sparks'`, `'dust-puff'`, `'smoke'`, `'hit-ring'`, and `'noise-dissolve'` (eroding `sourceSprite` or a synthesized orb fallback with a glowing burn rim and peak-ember guard so all `cols × rows` frames remain non-empty) with optional nearest-RGB Art Bible palette snapping and `(cols * frameSizePx) × (rows * frameSizePx)` RGBA grid packing.
- **Schema & Recipe Persistence (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Added `VfxArchetypeSchema`, `VfxFlipbookConfigSchema`, `createDefaultVfxFlipbookConfig()`, and optional `vfxFlipbook` on `SpriteNodeSchema` and `AssetRecipeSchema`.

## 43. Godot 4 `GPUParticles2D` & PixiJS VFX Exporters + Worker/ZIP Integration (Milestone 22B)

- **Zero-DOM Engine Exporters (`src/export/vfxExporters.ts`, `src/export/zipPackager.ts`):** Generates Godot 4 `CanvasItemMaterial` `.tres` (`particles_animation = true`, `particles_anim_h_frames = cols`, `particles_anim_v_frames = rows`, `particles_anim_loop = false`, additive `blend_mode = 1` for `'sparks'`/`'hit-ring'`) and `GPUParticles2D` `.tscn` bundles (`exportGodotVfxBundle()`), PixiJS flipbook/emitter JSON specs (`exportPixiVfxJson()` with exact cell rectangles and `'add'`/`'normal'` blend mode), and full ZIP packages (`packageVfxFlipbookZip()`, plus optional `vfxFlipbookBundle` in `packageSpriteZip()`).
- **Transferable Worker Execution (`src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Added `BAKE_VFX_FLIPBOOK` (`executeBakeVfxFlipbookJob()` / `bakeVfxFlipbookInWorker()`) transferring unique `ArrayBuffer`s cleanly off the main thread with a synchronous Node/Vitest fallback.

## 44. Interactive VFX Flipbook Baker UI & Screen 4 Wiring (Milestone 22C)

- **Workspace Discovery (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registered `?tab=vfx-baker` (`InspectorTab`), promoted `'vfx-baker'` as a primary tab for `'vfx'` assets (keeping `'ui-panel'` collapsed to 3 primary tabs and listing `'vfx-baker'` in `+ Tools` for other classes), and registered **"Open 2D VFX Flipbook Baker"** (`act-vfx-baker`) in `Cmd/Ctrl+K`.
- **Zero-WebGL2 Interactive Baker (`src/ui/inspector/VfxBaker.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Pairs debounced Worker baking (`bakeVfxFlipbookInWorker()`, monotonic request guard) with a Canvas2D preview player supporting Live Flipbook / Full Sheet views, `document.hidden` and unmount `rAF` cleanup, `pixel-art` nearest-neighbor crisping, `ScrubInput` geometry controls, Art Bible swatch pickers & palette snap, Godot `.tres`/`.tscn` + PixiJS JSON live previews, IndexedDB persistence (`vfxFlipbook`), and 1-click VFX `.zip` export.

## 45. Pure-TS Parallax Compositor, Atmospheric Depth Tinter & Blueprint Schema (Milestone 23A)

- **Deterministic Horizontal Seam-Wrapper & Aerial Depth Tinter (`src/processing/parallaxCompositor.ts`):** Zero-DOM pure-TS module implementing premultiplied smoothstep horizontal tail-into-head crossfading (`makeHorizontallySeamless()`), contrast-compressing horizon scatter blending (`applyAtmosphericDepthTint()`, leaving `alpha === 0` pixels untouched), optional `#FF00FF` chroma-key isolation & OKLab palette quantization (`processSingleParallaxLayer()`, `processParallaxStack()`), and integer camera-modulo sky/layer compositing (`composeParallaxPreviewFrame()`).
- **Parallax Scene Blueprint & IndexedDB Orphan-Blob Hygiene (`src/processing/parallaxBlueprint.ts`, `src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/db/database.ts`):** Added `ParallaxSceneBlueprintSchema` (`PARALLAX_BLUEPRINT_GEMINI_RESPONSE_SCHEMA` + clamping `parseAndClampParallaxBlueprint()`), optional `parallaxScene` persistence on `SpriteNodeSchema` and `AssetRecipeSchema`, and registered `masterKeyframeBlobId` + `layers[].blobId` in `findOrphanBlobIds()` so automatic Dexie garbage collection retains active band blobs while sweeping superseded/deleted ones cleanly.

## 46. GenAI/Antigravity Parallax Stack Generator, Engine Exporters & Worker Offloading (Milestone 23B)

- **Matched-Stack AI Orchestrator (`src/providers/parallaxGenerator.ts`):** Implements Stage 1 Gemini JSON blueprint planning (`responseSchema`), Stage 2a optional Master Keyframe anchoring (`inlineData`), Stage 2b sequential chroma-isolated (`#FF00FF`) band generation with `onBandReady` streaming and `regenerateParallaxBand()` surgical re-rolls across Gemini BYOK, M10 Antigravity Loopback Bridge (`buildBridgeParallaxBandRequest()`), and `$0.00` Offline Mock Mode (`synthesizeMockParallaxBand()`), strictly redacting API keys and bridge bearer tokens via `classifyProviderError()`.
- **Multi-Engine Parallax Exporters & Worker Pipeline (`src/export/parallaxExporters.ts`, `src/export/zipPackager.ts`, `src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Generates Godot 4.3+ `Parallax2D` `.tscn` scenes (`scroll_scale`, `repeat_size`, nearest filtering), unified Phaser 3 `TileSprite` + PixiJS `TilingSprite` `nibgrid.parallax.v1` JSON manifests, Zod-validated ZIP bundles (`packageParallaxZip()`, `PackageSpriteZipInput.parallaxBundle`), and transferable Web Worker band processing (`PROCESS_PARALLAX_LAYER` / `processParallaxLayerInWorker()`).

## 47. Interactive Parallax Background Workshop UI & Screen 4L Integration (Milestone 23C)

- **Workspace Routing & Command Palette (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registered `?tab=parallax` (`InspectorTab`) as a primary tab for `'tile'` sprites (and in `+ Tools` overflow across other classes, keeping `'ui-panel'` collapsed to 3 primary tabs) and added **"Open Parallax Background Compositor"** (`act-parallax`) to `Cmd/Ctrl+K`.
- **Zero-WebGL2 Canvas2D Stage & GenAI Workshop (`src/ui/inspector/ParallaxWorkshop.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/export/recipeBuilder.ts`, `src/providers/errors.ts`):** Combines a 60 FPS Canvas2D multi-band scroll viewport (pausing strictly on `document.hidden` and unmount, disposing offscreen `<canvas>` backing stores, supporting `1× Sprite Contrast` foreground overlay and integer pixel-art rendering) with a collapsible "Generate Matched Stack (AI)" card (4 biome presets, 3/4 bands, Master Keyframe toggle, cost estimator, per-band `↻` regeneration, progressive Worker streaming), reorderable layer stack (`ScrubInput` controls for `Scroll Ratio`, `Depth Haze`, `Seam Blend`, `Y-Offset`), live Godot 4 `Parallax2D` / Phaser & PixiJS code preview, node-scoped Dexie hydration (`hydratedNodeIdRef`) + orphan-blob GC, and word-boundary-safe `sk-`/`AIza`/`nbg_` secret redaction.

## 48. Pure-TS Pixel Glyph Table, OKLab Sel-Out Styler & PoT Atlas Packer (Milestone 24A)

- **Built-in ASCII Pixel Glyph Table (`src/processing/pixelGlyphTable.ts`):** Zero-DOM deterministic `5×7` monochrome glyph mask definitions across printable `ASCII 32..126` (`CHARSET_PRESETS`: `'damage-numerals'` with 23 unique glyphs, `'hud-upper'`, and `'ascii-basic'`), returning uniform `GlyphMask` records (`charCode`, `width`, `height`, `alpha`, `xoffset`, `yoffset`, `xadvance`).
- **Perceptual Styler & Power-of-Two Shelf Packer (`src/processing/bitmapFont.ts`, `src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Scales glyphs by integer factors (`1..4`), applies vertical 2-stop gradient fills (optionally OKLab-snapped to `ArtBible.palette`), renders 4-/8-connected OKLab Sel-Out outlines (`rgbToOklab()` / `oklabToRgb()` with strict luminance-darker guard) + hard-pixel drop shadows (`styleGlyphMask()`), packs compact non-overlapping Power-of-Two RGBA sheets (`bakeBitmapFontAtlas()`), and persists `BitmapFontConfigSchema` on `SpriteNodeSchema` and `AssetRecipeSchema`.

## 49. AngelCode BMFont Exporters, Canvas2D Font Rasterizer & Worker Baking (Milestone 24B)

- **Standard AngelCode `.fnt` & `.xml` Serializers (`src/export/bmfontExporter.ts`, `src/export/zipPackager.ts`):** Generates Godot 4 `FontFile`-compatible AngelCode text `.fnt` (`exportBmFontText()`) and Phaser 3 / PixiJS `.xml` (`exportBmFontXml()` with strict attribute escaping), packages `<slug>.png`, `<slug>.fnt`, `<slug>.xml`, and Zod-validated `<slug>.recipe.json` (`packageBmFontZip()`), and adds optional `bitmapFontBundle` support onto `PackageSpriteZipInput`.
- **Optional Browser Font Rasterizer & Worker Pipeline (`src/ui/inspector/fontRasterizer.ts`, `src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`):** Loads uploaded `.ttf`/`.woff2` faces (`FontFace` API) and rasterizes system/custom glyphs into crisp alpha-thresholded `GlyphMask[]` arrays (`rasterizeBrowserFontToMasks()`), processed asynchronously via `BAKE_BITMAP_FONT` (`executeBakeBitmapFontJob()` / `bakeBitmapFontInWorker()`).

## 50. Interactive Bitmap Font & Damage Numeral Workshop UI (Screen 4M — Milestone 24C)

- **State, Tab Topology & Command Palette (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registers `'bmfont'` in `InspectorTab` and `VALID_INSPECTOR_TABS`, surfaces `Bitmap Font` (`?tab=bmfont`) as a primary tab for `'ui-panel'` assets and in the `+ Tools` overflow menu for all other asset classes, and adds `act-bmfont` to the command palette.
- **Zero-WebGL Canvas2D Workshop & Inspector Integration (`src/ui/inspector/BitmapFontWorkshop.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Reuses M7 OKLab Sel-Out and M22 biome backdrop generators (`generateBiomeTile()`) inside a 3-pane workshop featuring live floating Crit Pop previews over selectable game biomes, packed PoT atlas inspection, AngelCode `.fnt`/`.xml` code preview tabs, Dexie `bitmapFont` recipe persistence, and one-click ZIP export alongside sprite exports.

## 51. Entity Domain Schema, Dexie v3 Migration & Godot 4 Prefab Assembler (Milestone 25A)

- **Entity Composition Model (`src/domain/entitySchema.ts`, `src/db/database.ts`):** Adds Dexie schema `version(3)` tables (`entities` `&id, projectId, slug` and `syncTargets` `&projectId`) with Zod-validated `EntityDefinition`, `EntityAnimationClip`, `GodotBodyType`, and `GodotSyncTargetMeta` without duplicating binary blobs; `deleteProjectCascade()` removes linked entities and sync targets cleanly.
- **Pure-TS Godot 4 Prefab Assembler (`src/export/godotPrefabAssembler.ts`):** Emits deterministic `VirtualSyncFile[]` bundles including `.png.import` sidecars (`compress/mode=0`, `mipmaps/generate=false` for pixel art), `CanvasTexture` `.tres` normal pairs, `SpriteFrames` (`<slug>_frames.tres`), `AnimationLibrary` (`<slug>_anims.tres` synchronizing Hitbox `activeFrames`, `Marker2D` sockets, and `Audio/SfxPlayer.play()` triggers), and `<slug>.tscn` scenes with exact `load_steps` and declared `ExtResource` references.

## 52. SHA-256 Sync Diff Engine & File System Access API (`res://`) Writer (Milestone 25B)

- **Pure-TS SHA-256 Diffing (`src/sync/syncDiff.ts`):** Hashes every `VirtualSyncFile` (`sha256Bytes()`) against persisted `lastSyncedHashes` and partitions output into `added`, `modified`, and `unchangedPaths` so unchanged textures never trigger Godot re-imports.
- **FSAA Writer & Cross-Browser ZIP Fallback (`src/sync/fsaaSyncEngine.ts`):** Persists `FileSystemDirectoryHandle` (plus `DataCloneError`-safe metadata fallback & in-memory stub cache) per project, verifies/requests `readwrite` permission, creates nested directories atomically (`getDirectoryHandle({ create: true })`), aggregates project entity assets (`collectEntitySyncFiles()`, `collectProjectGodotSyncFiles()`), and provides `buildGodotSyncZipBytes()` / `downloadGodotSyncZip()` on non-Chromium browsers.

## 53. Entity Hub UI, Global Top-Bar `GodotSyncPill` & E2E Flow (Milestone 25C)

- **Navigation, Store & Command Palette (`src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/command/CommandPalette.tsx`):** Adds `{ screen: 'entities'; projectId }` (`#/project/:id/entities`), hydrates project `entities` & `syncTarget` in Zustand, mounts **Entities** + `<GodotSyncPill />` cleanly in the primary header bar, and registers `nav-entities` in `Cmd/Ctrl+K` (while removing a duplicate `act-parallax` entry).
- **Entity Hub & Live Sync Popover (`src/ui/entities/EntityHubView.tsx`, `src/ui/entities/GodotSyncPill.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Displays Entity Cards with `1×` pixelated thumbnails, `GodotBodyType` badges, 5 coverage dots (`Sprite`, `Normal`, `Collider`, `Sockets`, `Audio`), a create/edit drawer with live `.tscn Preview`, per-entity sync, and a global SHA-256 dry-run diff popover (`+ Added` / `~ Modified` / `0 files changed`); also preserves `collisionShapes` and `sockets` across Inspector sub-tab saves (`handleSaveSockets()`, `handleSaveVfxFlipbook()`).

## 54. Prompt-to-Entity Blueprint, Opaque Socket Snapper & Godot 4.3+ GDScript Validator (Milestone 26A)

- **Pure-TS Blueprint Schema & Socket Snapper (`src/processing/entityDirectorBlueprint.ts`):** Defines Zod schemas and `ENTITY_BLUEPRINT_GEMINI_RESPONSE_SCHEMA` for `EntityDirectorBlueprint`, sanitizing slugs/sockets/states and clamping normalized anchor coordinates (`normX`/`normY`) and combat stats via `parseAndClampDirectorBlueprint()`; `computeOpaqueBounds()` and `resolveSocketHintsToPixels()` deterministically snap normalized socket hints inside the trimmed sprite's non-transparent bounding box.
- **Godot 4.3+ GDScript Validator & Fallback Compiler (`src/export/gdscriptGenerator.ts`):** Validates generated `.gd` scripts for matching `extends <bodyType>` and zero Godot 3 deprecated tokens (`KinematicBody2D`, `yield(`, `export var`, `onready var`, argumented `move_and_slide`), falling back cleanly to strictly typed deterministic GDScript wired to M25's exact `$AnimatedSprite2D`, `$AnimationPlayer`, `$Audio/SfxPlayer`, and `$Sockets/<name>` hierarchy (`validateAndCompileGdScript()`).

## 55. Prompt-to-Entity Director Orchestrator & `.gd` Prefab Script Wiring (Milestone 26B)

- **Script Emission & Wiring (`src/domain/entitySchema.ts`, `src/export/godotPrefabAssembler.ts`, `src/sync/fsaaSyncEngine.ts`):** Stores optional `scriptContent` on `EntityDefinitionSchema` without extra blobs and emits the `.gd` script file at `normalizeResSubpath(scriptResPath)` inside `VirtualSyncFile[]`, wired onto the root node of `<slug>.tscn` via `[ext_resource type="Script" ...]` with exact `load_steps`.
- **Two-Phase Abortable Director (`src/providers/entityDirector.ts`):** Separates cheap JSON planning (`draftEntityBlueprint()`, Gemini `responseSchema` or `$0.00` Offline Mock via `buildMockEntityBlueprint()`, `estimateDirectorCost()`) from staged execution (`executeEntityDirectorPlan()` running `sprite`, `collider`, `sockets`, `sfx`, `gdscript`, `commit`). Aborts/errors automatically purge temporary blobs (`cleanupOrphanedBlobs()`) and redact secrets (`classifyProviderError()`).

## 56. Interactive Prompt-to-Entity Director Modal & Entity Hub Wiring (Milestone 26C)

- **Three-Step Director Modal (`src/ui/entities/EntityDirectorModal.tsx`, `src/ui/entities/EntityHubView.tsx`, `src/ui/command/CommandPalette.tsx`):** Launches from **+ Prompt-to-Entity (AI)** in the Entity Hub or `Cmd/Ctrl+K` (`act-prompt-to-entity`), guiding users through Prompt & Genre selection, Editable Blueprint Review (sockets, per-cue Procedural vs AI SFX, toggles, live cost badge), and an abortable 6-stage live build stream; adds the `.gd` coverage dot and read-only **`.gd Script`** preview tab on Entity cards ready for M25 `Sync to Godot`.

## 57. Pure-TS Godot 4 `.gdshader` Transpiler, Presets & Schema Persistence (Milestone 27A)

- **Uniform Parser & WebGL2 Transpiler (`src/processing/gdshaderTranspiler.ts`):** Strips Markdown fences (`stripShaderCodeFences`), extracts typed `uniform` declarations plus `hint_range(min, max, step)` and `source_color` annotations (`parseGdShaderUniforms`), rejects Godot 3 `hint_color` or missing `shader_type canvas_item;` / `void fragment()` blocks, and compiles paired `#version 300 es` vertex and fragment shaders (`transpileGdShaderToWebGL2`) mapping `TEXTURE`, `TEXTURE_PIXEL_SIZE`, `UV`, `TIME`, `VERTEX`, and `COLOR`.
- **Offline `.gdshader` Presets (`src/processing/gdshaderPresets.ts`):** Ships five curated Godot 4.3+ effects (`hit_flash`, `wind_sway`, `metallic_sheen`, `pixel_outline`, `water_ripple`) with deterministic default uniform extraction (`extractDefaultUniformValues`).
- **Schema & Recipe Persistence (`src/domain/schemas.ts`, `src/domain/entitySchema.ts`, `src/export/recipeBuilder.ts`):** Adds `ShaderUniformValueSchema` and `ShaderConfigSchema` onto `SpriteNodeSchema`, `EntityDefinitionSchema`, and `AssetRecipeSchema` without duplicating binary blobs.

## 58. GenAI `.gdshader` Generator, `ShaderMaterial` `.tres` Exporter & M25/ZIP Wiring (Milestone 27B)

- **GenAI & Offline Shader Generator (`src/providers/shaderGenerator.ts`):** Estimates token cost (`estimateShaderGenerationCost()`), prompts Gemini Flash / Antigravity Bridge with strict Godot 4.3+ `canvas_item` rules and Art Bible palette hints, or matches offline curated presets by keyword (`matchPresetForShaderPrompt()`), validating via `transpileGdShaderToWebGL2()` and redacting API secrets on provider errors (`classifyProviderError()`).
- **`ShaderMaterial` Exporter & Prefab Wiring (`src/export/shaderExporters.ts`, `src/export/zipPackager.ts`, `src/export/godotPrefabAssembler.ts`, `src/sync/fsaaSyncEngine.ts`):** Emits Godot 4 `.tres` `ShaderMaterial` files (`exportGodotShaderMaterialTres()` with typed `Color(...)` and `shader_parameter/*` overrides), packages `<slug>.gdshader` + `<slug>_mat.tres` into sprite ZIP bundles (`packageShaderZip()`, `packageSpriteZip()`), and automatically attaches `material = ExtResource("<id>_mat")` onto `AnimatedSprite2D` inside M25 `.tscn` scenes with exact `load_steps`.

## 59. Godot 4 Shader Studio UI & Live WebGL2 Inspector (Milestone 27C)

- **State, Tab Topology & Command Palette (`src/store/useAppStore.ts`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`):** Registers `'shader'` in `InspectorTab` and `VALID_INSPECTOR_TABS`, surfaces **Shader Studio** (`?tab=shader`, Screen **4N**) as a primary tab on `'character'` and `'vfx'` assets (and in `+ Tools` overflow elsewhere, leaving `'ui-panel'` tabs unchanged), and registers `act-shader-studio` in the command palette.
- **3-Pane WebGL2 Shader Studio (`src/ui/inspector/ShaderStudio.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Provides curated offline presets (`hit_flash`, `wind_sway`, `metallic_sheen`, `pixel_outline`, `water_ripple`), GenAI prompt composer with live cost estimation, auto-generated `ScrubInput` / `source_color` uniform controls from parsed AST hints, live 60 FPS WebGL2 preview canvas with `forceReleaseWebGlContext()` cleanup on unmount, `.gdshader` / `ShaderMaterial .tres` live preview & syntax diagnostics, Dexie `shaderConfig` persistence, and 1-click `.zip` / `.gdshader` / `_mat.tres` downloads.

## 60. Global Asset Vault, Smart Asset Browser & Portable `.nibgrid.zip` Snapshots (Milestone 28)

- **Vault Schema & Dexie v4 Content-Addressed Deduplication (`src/domain/vaultSchema.ts`, `src/db/database.ts`):** Upgrades `NibgridDatabase` to `version(4)` with `vaultItems` (`&id, kind, name, createdAt`) holding typed discriminated payloads (`sprite`, `shader`, `bmfont`, `sfx`, `vfx`, `art-bible`), updates `findOrphanBlobIds()` and all `cleanupOrphanedBlobsInTx()` transactions to include `vaultItems` so deleting a source project preserves promoted Vault assets and deleting Vault items leaves zero orphan blobs, and adds `storeBlobDeduplicated()`.
- **Pure-TS Portable Snapshot Serializer (`src/sync/projectSnapshot.ts`):** Packs `ArtBible`, `SpriteNode` DAG, `AudioAsset`s, `EntityDefinition`s, and SHA-256 deduplicated `blobs/<sha256>.bin` binaries into `.nibgrid.zip` archives (`exportProjectSnapshot()`), verifies every blob digest via Web Crypto before touching IndexedDB (`parseAndVerifyProjectSnapshot()`), and remaps colliding IDs atomically (`importProjectSnapshotToDb()`).
- **Smart Browser & Batch Re-Palette UI (`src/ui/vault/VaultAndBrowserView.tsx`, `src/App.tsx`, `src/ui/hub/ProjectHub.tsx`, `src/ui/inspector/ShaderStudio.tsx`, `src/store/useAppStore.ts`):** Adds `#/vault` / `#/project/:id/vault` routing, unified Project Browser + Global Vault cards with `AssetClass`, Godot `bodyType`, collider/shader/staleness filters, multi-select **Promote to Vault** and off-thread **Batch Re-Palette** via `runPostProcessInWorker`, plus 1-click `.nibgrid.zip` export/import.

## 61. Zero-Server URL-Hash Recipe Sharing (`#share=`) & Static GitHub Pack Feeds (Milestone 29)

- **URL-Hash Recipe Codec (`src/share/recipeUrlCodec.ts`):** Pure-TS lossless zlib (`fflate.zlibSync` level 9) + Base64URL serializer (`encodeRecipeToHash()`, `decodeRecipeFromHash()`) supporting deterministic zero-blob `shader`, `vfx`, `bmfont`, `procedural-sfx`, and `art-bible` recipes under an 8192-char URL budget with a 65536-byte decompression cap (`Unzlib` streaming limit) and Zod validation.
- **Static GitHub Pages Pack Feed Client (`src/share/packFeedClient.ts`, `public/packs/starter-catalog.json`, `public/packs/retro-rpg-starter.nibgrid-pack.zip`):** Fetches and validates CORS-friendly static `catalog.json` feeds (`PackCatalogSchema`), resolves relative `.nibgrid-pack.zip` URLs against feed origins, verifies optional SHA-256 digests (`parseAndVerifyPackZip()`), persists custom feeds in `localStorage`, and deduplicates binary blobs on atomic import (`importPackIntoDb()`).
- **Sharing Modals & Feed Browser (`src/ui/share/ShareRecipeModal.tsx`, `src/ui/share/PackFeedBrowser.tsx`, `src/ui/inspector/ShaderStudio.tsx`, `src/ui/vault/VaultAndBrowserView.tsx`, `src/App.tsx`):** Detects `#share=v1.` hashes on boot/`hashchange` to re-bake shared recipes locally in pure TS with 1-click import into projects or the Global Vault, and adds a **Pack Feeds** tab inside the Vault & Smart Browser.

## 62. Zero-Server WebRTC P2P Direct Asset & Project Transfer (Milestone 30)

- **Pure-TS Binary Chunk Protocol & SDP Codec (`src/p2p/p2pProtocol.ts`, `src/p2p/sdpCodec.ts`):** Slices `.nibgrid.zip` payloads into `16 KiB` frames (`P2P_CHUNK_BYTES = 16384`) prefixed with 4-byte big-endian `Uint32` indices, exchanges `META` / `COMPLETE` / `ACK` / `ERROR` control frames, verifies end-to-end SHA-256 digests (`P2pReassembler.finalizeAndVerify()`), and compresses gathered SDP Offer/Answer payloads into compact `NIB-O1:` / `NIB-A1:` codes (`encodeSdp()`, `decodeSdp()`).
- **Backpressure-Aware WebRTC Transport (`src/p2p/webrtcTransfer.ts`):** Orchestrates `P2pSenderSession` and `P2pReceiverSession` over `RTCDataChannel` with `bufferedAmountLowThreshold = 65536` backpressure, 3s non-trickle ICE gathering wait, and an injectable `PeerConnectionFactory` (including `createInMemoryLoopbackPeerFactory()` for deterministic Vitest testing).
- **P2P Transfer UI (`src/ui/share/P2pTransferModal.tsx`, `src/App.tsx`, `src/ui/hub/ProjectHub.tsx`, `src/ui/vault/VaultAndBrowserView.tsx`, `src/ui/command/CommandPalette.tsx`):** Provides Send/Receive handshakes with copyable `NIB-O1:` / `NIB-A1:` codes, deterministic inline SVG QR codes, live chunk progress bars, **SHA-256 Verified** badges, and 1-click snapshot import.

## 63. Pure-TS Pixel Micro-Editor Core, Binary Mask Compositor & Atomic Dexie Commit (Milestone 31A)

- **Pure-TS Raster & Undo Core (`src/processing/pixelEditorCore.ts`):** Implements zero-DOM integer texel mapping (`mapClientToTexel()`), `1×1`/`2×2`/`3×3` mirrored stamps (`plotPixel()`), continuous Bresenham stroke interpolation (`plotBresenhamLine()`), iterative stack-based 4-connected flood fill (`floodFillRgba()`), and bounded immutable undo/redo (`PixelUndoStack`, `maxDepth = 50`).
- **Pure-TS Binary Mask & Unmasked-Byte Composite (`src/processing/inpaintMask.ts`):** Paints/erases continuous mask strokes (`paintMaskLine()`), counts masked texels (`countMaskedPixels()`), generates white-on-black provider masks (`maskToRgbaBuffer()`) and red overlay previews (`maskToOverlayRgba()`), guarantees 100% byte-identical preservation of unmasked pixels (`compositeInpaintResult()`), and optionally snaps only masked opaque texels (`snapMaskedPixelsToPalette()`).
- **Schema, Recipe & Atomic Persist (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/db/database.ts`):** Extends `SpriteNodeSchema` and `AssetRecipeSchema` with `manualPixelEditCount` and `inpaintHistory[]`, and adds `NibgridRepository.commitProcessedSpritePixels()` with pre-transaction SHA-256 hashing, deduplicated blob writes, and atomic `cleanupOrphanedBlobsInTx()` leaving zero orphan blobs.

## 64. Region-Masked AI Inpainting Provider Adapter & Offline Mock Mode (Milestone 31B)

- **Multi-Provider Masked Inpaint Adapter (`src/providers/inpaintAdapter.ts`):** Compiles original PNG + white-on-black binary mask PNG + active Art Bible style constraints into Gemini multimodal payloads (`buildGeminiInpaintRequest()`), estimates live costs (`estimateInpaintCost()`), routes across Gemini BYOK, Antigravity Bridge, ComfyUI, and deterministic Offline Mock Mode (`runRegionInpaint()`), aligns output dimensions cleanly (`resampleRgbaNearest()`), runs strict `compositeInpaintResult()` (+ optional `snapMaskedPixelsToPalette()`), and redacts API keys/tokens on all errors (`classifyProviderError()`).

## 65. Screen 4A Surgical Pixel Micro-Editor & Region-Masked Inpainting UI (Milestone 31C)

- **Floating Micro-Editor Rail, Palette Strip & Inpaint Action Bar (`src/ui/inspector/PixelMicroEditorToolbar.tsx`, `src/ui/inspector/PostProcessInspector.tsx`):** Integrates `Pencil (B)`, `Eraser (E)`, `Eyedropper (I)`, `Flood Fill (G)`, `Mirror-X (M)` guide/symmetry, `Mask Brush (K)` / `Mask Eraser`, `1–3px` stamps, `Cmd/Ctrl+Z` / `Cmd/Ctrl+Shift+Z` undo/redo, Art Bible swatch locking (+ optional free color picker), HiDPI `mapClientToTexel()` pointer dispatch over `BeforeAfterWipe`, reload hydration preserving edited `processedBlobId`s cleanly, and atomic Dexie persistence (`commitProcessedSpritePixels()`).

## 66. Pure-TS QA Contact Sheet Packer, Report Schema & Dexie Cache (Milestone 32A)

- **Pure-TS Labeled Contact Sheet Packer (`src/processing/qaContactSheet.ts`):** Deterministically packs up to `16` sprites per page (`packQaContactSheets()`) onto a `#808080` mid-gray grid with `REF` pinned at cell `0` across all paginated sheets, stamps crisp `REF` / `01`..`15` badges via M24's `pixelGlyphTable.ts`, renders bottom-right binary 1× silhouette thumbnails, and hashes sheet pixels + `ArtBible` hash (`computeQaSheetHash()`).
- **QA Schema & Dexie v5 Cache (`src/processing/artDirectorQaSchema.ts`, `src/db/database.ts`):** Validates Vision QA reports (`ART_DIRECTOR_QA_GEMINI_RESPONSE_SCHEMA`), clamps `overallScore` to `[0, 100]` and resolves `indexLabel -> spriteId` safely dropping hallucinated labels (`parseAndResolveQaReport()`), and stores reports in Dexie `version(5)` `qaReports` (`&projectId, sheetHash`) with cascade cleanup on sprite/project deletion.

## 67. Gemini Flash Vision QA Adapter & Offline Heuristic Analyzer (Milestone 32B)

- **Vision-LLM & Offline QA Engine (`src/providers/artDirectorQa.ts`):** Builds `responseSchema`-enforced multimodal Vision requests attaching labeled contact sheets + Art Bible rules (`buildGeminiVisionQaRequest()`), estimates per-sheet run cost (`estimateArtDirectorQaCost()`), analyzes alpha silhouettes, border luminance contrast, and light-angle balance deterministically offline (`runOfflineHeuristicQa()`), and executes cache-first multi-provider QA passes (`runArtDirectorQaPass()`) via Dexie `qaReports` with strict `ProviderError` secret stripping.

## 68. Audit Matrix Art Director QA Panel, Deep-Links & Smart Filter (Milestone 32C)

- **Visual QA Panel & Audit Matrix Integration (`src/ui/audit/ArtDirectorQaPanel.tsx`, `src/ui/audit/AuditMatrixView.tsx`):** Packs decoded project sprites + Golden Reference into an interactive clickable contact sheet canvas (`qa-contact-sheet-canvas`), surfaces overall cohesion scores, structured severity/category cards (`light-angle`, `style-drift`, `outline-inconsistency`, `silhouette-readability`, `scale-proportion`), `Cached` indicator + `Force Re-Run`, per-row `Visual QA` badges, and deep-links directly into Screen 4A Micro-Editor (`?tab=postprocess&tool=pencil`), Post-Process, 1× Sandbox, or Sprite Studio (`src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`).
- **M28 Smart Asset Browser Integration (`src/ui/vault/VaultAndBrowserView.tsx`):** Hydrates `repository.getQaReport()`, adds `Visual QA Warnings` quick-filter toggle (`browser-filter-qa-warnings`) and status dropdown option, and renders per-card `qa:pass`/`qa:warn`/`qa:fail` badges.

## 69. Pure-TS Procedural UI Kit Synthesizer, State-Sheet Slicer & Schema (Milestone 33A)

- **Pure-TS Widget State Baker (`src/processing/uiKitCore.ts`):** Synthesizes matched `button_normal`, `button_hover` (+14% luminance lift + inner accent rim), `button_pressed` (inset bevel + 1px highlight shift + -12% interior), `button_disabled` (65% Rec.709 desaturation), `panel_bg`, `bar_track`, and `bar_fill` tiles (`24`/`32`/`48px`), enforces `clampNineSliceMargins()` (`left + right < width`, `top + bottom < height`), slices `4×2` / `2×3` GenAI chroma state sheets (`sliceUiStateSheet()`), and renders crisp nearest-neighbor 9-slice previews (`renderNineSliceToBuffer()`).
- **Schema & Recipe Persistence (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`):** Adds `UiKitStyleConfigSchema`, `NineSliceMarginsSchema`, `createDefaultUiKitConfig()`, and optional `uiKitConfig` fields to `SpriteNodeSchema` and `AssetRecipeSchema`.

## 70. Godot 4 `Theme` `.tres` Exporter, M25 Sync & GenAI UI Kit Adapter (Milestone 33B)

- **GenAI UI State Sheet Adapter (`src/providers/uiKitAdapter.ts`):** Builds `#FF00FF` chroma `4×2` UI state sheet requests locked to `ArtBible` (`buildGeminiUiKitRequest()`), slices returned sheets via `sliceUiStateSheet()` across Gemini BYOK, Antigravity Bridge, and `$0.00` Offline Procedural fallback (`generateUiKitViaAi()`), and redacts API secrets (`classifyProviderError()`).
- **Godot 4 `Theme` `.tres` Serializer & M25 Sync (`src/export/godotThemeExporter.ts`, `src/sync/fsaaSyncEngine.ts`):** Emits `format=3` `Theme` `.tres` resources with exact `load_steps = ext + sub + 1`, 7 `StyleBoxTexture` sub-resources, optional M24 `FontFile` pairing (`default_font`), lossless `.png.import` sidecars (`assembleGodotUiKitFiles()`), and ZIP bundles (`packageUiKitThemeZip()`), wired into M25's `collectProjectGodotSyncFiles()`.

## 71. Interactive Godot 4 UI Kit Builder Tab, M24 Font Pairing & Workspace Routing (Milestone 33C)

- **UI Kit Workshop UI & Routing (`src/ui/inspector/UiKitWorkshop.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/store/useAppStore.ts`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`):** Promotes `'uikit'` to a primary tab on `'ui-panel'` assets, supports `$0.00` Procedural & Gemini GenAI State Sheet authoring with Art Bible swatches and clamped `ScrubInput` 9-slice margin guides, pairs saved M24 Bitmap Fonts or a Built-in `5×7` HUD font live onto interactive hover/pressed/disabled 9-slice buttons and scrubbed HP progress bars, and wires `Save UI Kit to Project`, 1-click FSAA `Sync to Godot (res://)`, and `<slug>_theme.zip` exports cleanly into IndexedDB persistence.

## 72. Pure-TS 15-Joint Pose Rig, Analytic 2-Bone IK & OpenPose Renderer (Milestone 34A)

- **Pure-TS Pose Rig & Presets (`src/processing/poseRigCore.ts`, `src/processing/posePresets.ts`):** Defines the 15-joint humanoid skeleton (`PoseJointId`), analytic law-of-cosines 2-bone IK (`solveTwoBoneIk()`, `applyJointDragWithIk()`) clamping targets cleanly with zero `NaN`s, linear keyframe interpolation (`interpolatePoseFrames()`), built-in cycle presets (`run_6f`, `melee_slash_5f` with `propLine` weapon arc, `jump_4f`, `idle_4f`), pure-TS OpenPose color-coded capsule/joint renderer on `#000000` (`renderOpenPoseFrame()`, `renderOpenPoseStrip()`), and chroma-key + ground-pivot strip slicer (`sliceAndAlignPoseStrip()`).
- **Schema, Recipe & Blob Integrity (`src/domain/schemas.ts`, `src/export/recipeBuilder.ts`, `src/db/database.ts`, `src/sync/projectSnapshot.ts`):** Adds `PoseClipDefinitionSchema` and `poseClip` fields on `SpriteNodeSchema` and `AssetRecipeSchema`, and registers `generatedStripBlobId` / `generatedFrameBlobIds` across `findOrphanBlobIds()` and `.nibgrid.zip` snapshot serialization.

## 73. GenAI / ControlNet Pose-to-Sprite Adapter & Worker Strip Slicer (Milestone 34B)

- **Multi-Provider Pose Adapter (`src/providers/poseAnimationAdapter.ts`):** Estimates transparent strip cost (`estimatePoseCycleCost()`), compiles dual-image (`Golden Reference + 1×N OpenPose Guide`) Gemini requests (`buildGeminiPoseStripRequest()`), supports surgical single-frame re-rolls (`regenerateSinglePoseFrame()`), executes ControlNet OpenPose workflows via ComfyUI or Antigravity Bridge, renders deterministic `#FF00FF`-keyed pixel mannequins in Offline Mock Mode (`renderOfflineMockPoseFrame()`), and strips all API secrets cleanly via `classifyProviderError()`.
- **Worker & ZIP Integration (`src/workers/postprocess.worker.ts`, `src/workers/postprocessClient.ts`, `src/export/zipPackager.ts`):** Adds transferable `SLICE_AND_ALIGN_POSE_STRIP` execution in `postprocess.worker.ts` and bundles `<slug>_<clip>_strip.png` + `<slug>_<clip>_openpose.png` inside sprite ZIP archives.

## 74. Interactive 2D Pose Keyframer Workshop, Onion-Skinning & M25 Commit (Milestone 34C)

- **Screen 4O Workshop & Entity Integration (`src/ui/inspector/PoseKeyframerWorkshop.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/store/useAppStore.ts`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`):** Promotes `'pose'` into `character` primary inspector tabs and `Cmd/Ctrl+K` palette; provides interactive 15-joint dragging with live 2-bone IK + optional limb mirroring over HiDPI SVG/Canvas stages (`imageSmoothingEnabled = false` in pixel-art mode), 35% red/cyan previous/next onion-skinning overlays across both stick-figure rigs and generated sprites, timeline frame editing (`Add`/`Dup`/`Interp`/`Delete`, per-frame `↻` surgical re-roll, `4–24` FPS playback pausing on `document.hidden`), `PoseClip` persistence + ZIP export, and 1-click commit to M25 `EntityAnimationClip`.

## 75. Room Layout Core, M20 Auto-Tile Bitmask Resolver, Godot 4.3 `TileMapLayer` Binary Codec & Dexie v6 Persistence (Milestone 35A)

- **Pure-TS Room & TileMapLayer Core (`src/processing/roomLayoutCore.ts`):** Defines strict Zod schemas (`RoomLayoutBlueprintSchema`, `StoredRoomRecordSchema`) and `ROOM_BLUEPRINT_GEMINI_RESPONSE_SCHEMA`, implements deterministic spawn/entity validation and relocation away from solid terrain (`sanitizeRoomPlacements()`, `parseAndClampRoomBlueprint()`), maps `1` (solid) and `2` (one-way platform) cells onto M20 Blob-47 (`8×6`) or Wang-16 (`4×4`) auto-tile atlas coordinates (`resolveRoomAutoTileCells()`), and encodes/decodes Godot 4.3+ `tile_map_data` little-endian `2 + 12×N` `PackedByteArray` payloads (`encodeGodotTileMapData()`, `decodeGodotTileMapData()`).
- **Dexie v6, Store & Recipe (`src/db/database.ts`, `src/store/useAppStore.ts`, `src/export/recipeBuilder.ts`):** Upgrades IndexedDB to `version(6)` with `rooms: '&id, projectId, slug'`, repository CRUD (`listRooms`, `saveRoom`, `deleteRoom`, cascade delete in `deleteProjectCascade()`), Zustand hydration (`rooms`, `saveRoomRecord`, `deleteRoomRecord`), and optional `roomLayout` on `AssetRecipeSchema`.

## 76. GenAI Room Director Adapter, Godot 4.3 `TileMapLayer` `.tscn` Exporter & M25 Sync (Milestone 35B)

- **Room Director Adapter (`src/providers/roomPrototyperAdapter.ts`):** Defines 4 starter presets (`ROOM_STARTER_PRESETS`), estimates cost (`estimateRoomPrototyperCost()`, `~$0.001` Gemini / `$0.00` Offline Mock), dispatches structured Gemini Flash JSON `responseSchema` requests via `'x-goog-api-key'` headers (`buildGeminiRoomBlueprintRequest()`, `generateRoomBlueprint()`), synthesizes deterministic side-scroller/top-down/vertical-shaft/vault rooms offline (`generateMockRoomBlueprint()`), and redacts provider secrets cleanly via `classifyProviderError()`.
- **Godot 4.3+ Level Exporter & Sync Wiring (`src/export/godotRoomExporter.ts`, `src/sync/fsaaSyncEngine.ts`):** Generates Godot 4.3+ `[gd_scene load_steps=N format=3]` scenes (`exportGodotRoomTscn()`, `assembleGodotRoomFiles()`) containing an optional `Parallax2D` `Background`, `TileMapLayer` `Terrain` with `tile_map_data = PackedByteArray(...)`, `PlayerSpawn` `Marker2D`, pixel-bounded `Camera2D`, and instanced M25 Entity prefabs, packages `<slug>_level_bundle.zip` (`packageRoomBundleZip()`), and emits `levels/<slug>.tscn` during `collectProjectGodotSyncFiles()`.

## 77. Screen 4P Room & Encounter Prototyper Workshop, Inspector Routing & Live Sync (Milestone 35C)

- **Room Prototyper Workshop (`src/ui/inspector/RoomPrototyperWorkshop.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/inspector/workspaceTabs.ts`, `src/ui/command/CommandPalette.tsx`, `src/store/useAppStore.ts`):** Registers `'room'` (`Room Builder`) across `'tile'` primary tabs, `+ Tools` overflow, and `Cmd/Ctrl+K`; provides 4 room starter presets, live `Cols`/`Rows`/`TileSize` scrubbing, Gemini Flash JSON / `$0.00` Offline Mock generation, M20 TileSet & M23 Parallax bindings, HiDPI Canvas2D room painting (`Paint Solid (1)`, `Paint Platform (2)`, `Erase (0)`, `Place Entity`, `Move PlayerSpawn`) with instant M20 auto-tile updates, live `.tscn` preview, IndexedDB persistence, 1-click M25 `res://` sync (`levels/<slug>.tscn`), and `<slug>_level_bundle.zip` export.

## 78. Pure-TS 60 Hz Fixed-Timestep Playtest Simulation Core (Milestone 36A)

- **Zero-DOM Simulation Reducer (`src/processing/playtestEngineCore.ts`, `src/domain/entitySchema.ts`):** Defines `PlaytestJuiceConfigSchema` (`mode`, `moveSpeedPx`, `jumpVelocityPx`, `gravityPx`, `hitstopMs`, `screenShakePx`, `knockbackPx`, `flashDurationMs`, `attackDamage`), optional `EntityDefinition.playtestConfig`, AABB extraction & X-flip helpers (`computeAabbFromCollisionShapes()`, `transformLocalAabbToWorld()`), and `stepPlaytestSimulation()`, driving 60 Hz side-platformer & normalized 8-way top-down movement, active-frame M16 Hitbox vs Dummy Hurtbox intersection strictly once per swing, hitstop freeze pauses, knockback + camera shake trauma, M27 hit-flash decay, and M25 `frameAudioTriggers` event emission.

## 79. Playtest Stat Sync Helper & Spiral-Safe Fixed-Timestep Accumulator (Milestone 36B)

- **Pure-TS Stat Sync & Accumulator (`src/export/playtestStatSync.ts`):** Deterministically updates `@export var move_speed: float` and `@export var attack_damage: int` inside M26 `.gd` controllers (`applyPlaytestStatsToGdScript()`, `ensureEntityPlaytestGdScript()`) preserving surrounding user logic byte-for-byte, computes normalized `[0, 1]` M27 `flash_amount` (`computeHitFlashUniform()`), and runs a spiral-of-death-capped `16.6667 ms` (`<= 100 ms` frame clamp) fixed-timestep accumulator (`createFixedTimestepRunner()`).

## 80. Interactive In-Browser Mini-Playtest Stage in Entity Hub (Milestone 36C)

- **Playtest Modal, Routing & Live Stat Sync (`src/ui/entities/EntityPlaytestStage.tsx`, `src/ui/entities/EntityHubView.tsx`, `src/store/useAppStore.ts`, `src/ui/command/CommandPalette.tsx`):** Exposes a `▶ Playtest` launch action on every M25 Entity Card (plus `?playtest=<id>` deep-links and `Cmd/Ctrl+K` `Playtest Active Entity`), driving `stepPlaytestSimulation()` on a spiral-safe 60 Hz fixed timestep pausing cleanly on `document.hidden`/unmount, binding `WASD`/`Arrows`/`Space`/`J`/`W`/`K`/`H`/`R` (strictly ignored inside `<input>`/`<textarea>`/`<select>`), rendering integer-scaled Canvas2D pixel art with Target Dummy M27 `flash_amount` hit-flash + M24 `5×7` bitmap damage numerals + toggleable M16/M21 Debug Overlay, triggering M14/M15 WAVs via `AudioPlaybackEngine`, and persisting tuned `ScrubInput` stats + updated `.gd` `@export` declarations atomically to Dexie.

## 81. Single-Prompt Vertical Slice Blueprint, Resumable DAG Runner & Dexie v7 `sliceJobs` (Milestone 37A)

- **Pure-TS Slice Blueprint & Tier Cost Estimator (`src/processing/verticalSliceSchema.ts`):** Defines strict Zod schemas (`VerticalSliceBlueprintSchema`, `SliceExecutionTierSchema`) and `VERTICAL_SLICE_GEMINI_RESPONSE_SCHEMA` for `'instant-draft' | 'hybrid-prod' | 'full-genai'` tiers, clamps room/cast bounds cleanly (`parseAndClampVerticalSliceBlueprint()`), enforces `'hero'` anchor at `cast[0]` with deduplicated snake_case slugs (`sanitizeSliceSlug()`), and computes deterministic per-tier costs (`estimateSliceCostUsd()`).
- **Resumable DAG Scheduler & Dexie v7 (`src/processing/sliceDagRunner.ts`, `src/db/database.ts`, `src/store/useAppStore.ts`):** Builds topologically ordered 4-stage slice DAGs (`buildSliceDagNodes()`), pauses cleanly at `golden_ref_hero` (`awaiting-approval`) prior to fan-out, executes ready branches up to `maxConcurrency = 2` with serialized checkpoint saves and `AbortSignal` support (`runSliceDag()`), resumes strictly unfinished/`'failed'` nodes without re-running completed `'done'` work, and persists jobs in Dexie `version(7)` `sliceJobs` (`&id, projectId, status, updatedAt`) with project cascade deletion.

## 82. Vertical Slice Director, M14–M37 Node Executors & `main.tscn` Assembler (Milestone 37B)

- **Godot `main.tscn` & Slice Aggregator (`src/export/godotMainSceneExporter.ts`):** Generates Godot 4.3+ `[gd_scene load_steps=N format=3]` entry scenes (`exportGodotMainSceneTscn()`) mounting M35 `Level` and M33 `HudLayer`/`HudRoot` (`Theme`) + `HpBar` (`ProgressBar`), and deduplicates/sorts `main.tscn`, `levels/*.tscn`, `entities/*/*.tscn`, `tiles/*_tileset.tres`, `parallax/*_parallax.tscn`, `ui/*_theme.tres`, and `qa_report.json` (`assembleVerticalSliceSyncFiles()`).
- **Multi-Stage Director (`src/providers/verticalSliceDirector.ts`):** Compiles structured Gemini Flash JSON or `$0.00` offline blueprints (`draftVerticalSliceBlueprint()`, `buildMockVerticalSliceBlueprint()`), wires tier-aware execution across ArtBible, Hero anchor, M20 Tileset, M23 Parallax, M26/M34/M27 Entities, M24 BMFont, M33 UI Theme, M35 Room, M37 `main.tscn`, and M32 Visual QA (`createSliceNodeExecutor()`), strips API secrets via `classifyProviderError()`, and assembles the complete `res://` tree (`collectVerticalSliceGodotSyncFiles()`).

## 83. Single-Prompt Vertical Slice Autopilot Wizard, `#share=` Integration & E2E Flow (Milestone 37C)

- **Wizard UI, Header & `#share=` Routing (`src/ui/autopilot/VerticalSliceWizard.tsx`, `src/share/recipeUrlCodec.ts`, `src/ui/share/ShareRecipeModal.tsx`, `src/App.tsx`, `src/ui/command/CommandPalette.tsx`):** Exposes `+ Vertical Slice` in the global header bar and `Vertical Slice Autopilot (1-Prompt Game Slice)` in `Cmd/Ctrl+K`, streams prompt + genre + execution tier (`instant-draft` `$0.00` / `hybrid-prod` / `full-genai`) with pre-run `estimateSliceCostUsd()` budgets, gates fan-out at a visual `1×`/`2×` Hero Golden Reference approval step with `Re-Roll Anchor` support, displays a live Dexie-persisted resumable DAG board (`AbortSignal` pause/resume and click-to-inspect deep-linking), launches M36 Hero Playtest / 1-click FSAA (or ZIP fallback) `res://main.tscn` Godot 4 sync, and encodes/imports zero-server `kind: 'vertical-slice'` `#share=v1.` recipes.

## 84. Agentic Asset `@` Context Resolver, Studio Tool Registry & Dexie v8 Checkpoint Engine (Milestone 38A)

- **Context & Workspace Rules (`src/agent/contextResolver.ts`):** Builds per-project `@` mention catalogs (`buildMentionCatalog()`), resolves deduplicated entity/sprite/shader/room/audio/`@art_bible`/`@enemies`/`@all_sprites` tokens safely ignoring unknown references (`resolveAtMentions()`), and compiles active `ArtBible` constraints + secret-redacted `.nibgridrules` instructions (`buildWorkspaceRulesBlock()`).
- **8-Tool Deterministic Staging Registry (`src/agent/studioToolRegistry.ts`):** Defines Zod schemas and Gemini Function Calling declarations for `inpaint_sprite_region`, `repalette_sprites`, `update_gdshader_uniforms`, `add_or_move_socket`, `recompute_colliders`, `generate_sfx_cue`, `patch_room_layout`, and `sync_godot_diff` (`requiresExplicitConfirm: true`), executing every tool strictly into isolated `StagedAssetChange[]` buffers (`executeStagedToolCall()`) without mutating live Dexie tables.
- **Atomic Commit / Rollback & Dexie v8 (`src/agent/stagingTransactions.ts`, `src/db/database.ts`):** Upgrades IndexedDB to `version(8)` with `agentCheckpoints` (`&id, projectId, createdAt`), implements single-transaction `commitStagedTurn()`, `rejectStagedTurn()`, and `restoreCheckpoint()`, and scans `agentCheckpoints.referencedBlobIds` inside `findOrphanBlobIds()` so accepted checkpoints preserve pre-turn rollback blobs while rejected staging blobs are immediately purged (`findOrphanBlobIds(db) === []`).

## 85. Gemini Flash Function Calling, Antigravity Bridge & Offline Mock Asset Agent Adapter (Milestone 38B)

- **Function-Calling & Offline Planner (`src/providers/assetAgentAdapter.ts`):** Compiles structured Gemini Flash Function Calling requests attaching `.nibgridrules` (`ArtBible` constraints), resolved `@` asset summaries, optional PNG thumbnails, and all 8 `STUDIO_GEMINI_TOOL_DECLARATIONS` (`buildGeminiAgentRequest()`), routes across Gemini BYOK, the M10 Antigravity Loopback Bridge (`127.0.0.1:4188`), and a deterministic `$0.00` Offline Mock Agent (`planOfflineMockAgentTurn()`, `planAgentTurn()`), validates returned function calls with `StudioToolCallSchema`, computes transparent cost budgets, and redacts API keys cleanly via `classifyProviderError()`.

## 86. Right-Rail Asset Composer (`Cmd+L`), Inline Canvas `Cmd+K` & Checkpoint UI (Milestone 38C)

- **Composer Rail & Inline Bar (`src/ui/agent/AssetComposerRail.tsx`, `src/ui/agent/InlineCanvasCommand.tsx`, `src/store/useAppStore.ts`):** Mounts the collapsible right-rail Asset Composer (`Cmd/Ctrl+L` or header **Composer**) featuring live `@` autocomplete popovers, `.nibgridrules` customization, Tool Plan cost gates, Visual Staging Diff cards (`BeforeAfterWipe`, WAV auditioning, unified code diffs) with per-hunk Accept/Reject and 1-click Dexie checkpoint rollback; binds `Cmd/Ctrl+K` cleanly to `[data-inline-agent-target]` elements (`PostProcessInspector` Screen 4A canvas and `EntityHubView` cards) while keeping global navigation accessible via `Cmd/Ctrl+K` (outside target focus) or `Cmd/Ctrl+Shift+P` (`src/App.tsx`, `src/ui/command/CommandPalette.tsx`).

## 87. VS Code HostAdapter, Extension MCP Server & Pluggable ModelRouter (Milestones 39 & 40A)

- **Dual-Host `HostAdapter` & VS Code Extension MCP (`src/platform/hostAdapter.ts`, `packages/vscode-extension/`):** Decouples browser PWA secrets/Antigravity linking from VS Code/Desktop Webview postMessage RPC (`dispatchHostRpcRequest()`), contributes Activity Bar views, Custom Editors (`.nibgrid.json`, `.gdshader`, `.room.json`), Godot `F5` launch (`nibgrid.runGodotSlice`), and exposes all 8 M38 Studio tools + `run_vertical_slice` via JSON-RPC 2.0 MCP (`handleMcpJsonRpcRequest()`).
- **Unified Pluggable `ModelRouter` (`packages/model-router/src/routerCore.ts`):** Models 6 provider kinds (`antigravity-acp`, `litert-local`, `openai-compatible`, `comfyui-local`, `cloud-byok`, `offline-mock`), evaluates deterministic fallback routing per task (`resolveModelRoute()` across `planning-composer`, `sprite-inpaint`, `vision-qa`, `audio`), probes provider health safely (`probeModelProviderHealth()`), and redacts all credentials (`redactSecretsInText()`).

## 88. Safe `~/.gemini/config/mcp_config.json` Antigravity Auto-Linker & Settings UI (Milestone 40B)

- **Atomic Config Linker (`packages/model-router/src/antigravityLinker.ts`):** Builds secret-free MCP server entries (`buildNibgridMcpEntry()`), validates & merges into existing `mcp_config.json` preserving unrelated keys and sibling `mcpServers` idempotently while throwing cleanly on malformed JSON (`mergeAntigravityMcpConfig()`), and creates timestamped `.bak.<iso>` backups prior to writing (`linkAntigravityConfigWithBackup()`).
- **Models & Providers Panel (`src/ui/settings/ModelProvidersPanel.tsx`, `src/App.tsx`, `src/store/useAppStore.ts`, `src/ui/command/CommandPalette.tsx`):** Exposes header `Models` (`nav-models-btn`) and `Cmd/Ctrl+Shift+P` → `Models & Google Antigravity Auto-Linker` featuring 1-click Antigravity MCP registration via `getActiveHostAdapter()`, live `Ping Providers` health badges, and persistent per-task routing selectors with guaranteed `$0.00` Offline Mock fallback.

## 89. VSCodium-Style Desktop Staging Recipe, Release Workflow & Smoke Check (Milestone 40C)

- **Standalone Desktop Recipe & Workflows (`desktop/product.json`, `desktop/patches/01-nibgrid-workbench.patch`, `desktop/scripts/build-desktop.ts`, `desktop/scripts/smoke-desktop-bundle.ts`, `.github/workflows/release-desktop.yml`, `desktop/.github/workflows/release-desktop.yml`):** Defines telemetry-free Nibgrid Studio desktop branding (`nameLong: "Nibgrid Studio"`, Open VSX gallery, pre-bundled `nibgrid-studio` extension and `godot-tools`), stages reproducible Code-OSS bundles (`stageDesktopBundle()`), verifies bundle integrity and zero credential leaks (`verifyDesktopBundle()`, `npm run smoke:desktop`), and automates `macos-latest` / `windows-latest` / `ubuntu-latest` release artifact builds on `v*` tags.

## 90. Pure-TS `HostAdapter`, `BrowserHostAdapter` & Correlated RPC Bridge (Milestone 39A)

- **Pure-TS Host Contract (`src/platform/hostAdapter.ts`):** Defines DOM-free/VS Code-free `HostCapabilities`, `HostFileEntry`, `HostFsAdapter`, `HostSecretStore`, `HostSyncAdapter` (`syncResFiles`, `openEditor`, `launchGodot`), and `HostAdapter`, alongside workspace path-traversal guards (`assertSafeWorkspaceRelativePath()`), credential redaction (`redactHostSecrets()`), and pure-TS base64 byte codecs (`encodeBytesBase64()` / `decodeBytesBase64()`).
- **Browser Host & Typed Webview RPC (`src/platform/browserHostAdapter.ts`, `packages/vscode-extension/src/vscodeHostBridge.ts`):** Implements `createBrowserHostAdapter()` over Dexie `providerConfigs` secrets, virtual workspace FS, FSAA incremental sync (`computeSyncDiff()`), and `findOrphanBlobIds()` hygiene (`getActiveHostAdapter()`); pairs it with `createInMemoryRpcPair()`, correlated `createVscodeHostAdapter()`, and secret-scrubbing `dispatchHostRpcRequest()`.

## 91. VS Code Extension Host, Custom Editors, Activity Bar Trees & Safe Godot Runner (Milestone 39B)

- **Keychain & `execFile` Godot Runner (`packages/vscode-extension/src/extension.ts`, `packages/vscode-extension/package.json`):** Isolates API credentials strictly inside `context.secrets` (`createKeychainSecretStore()`) with automatic secret scrubbing across RPC failures, registers `nibgrid.openStudio`, `nibgrid.syncGodot`, `nibgrid.runGodotSlice`, and `nibgrid.linkAntigravity`, and launches Godot scenes safely via `runGodotWorkspaceScene()` using `child_process.execFile` (`shell: false`, path/binary sanitization, and disposal cancellation).
- **Custom Editors, Activity Bar Views & Problems Diagnostics (`packages/vscode-extension/src/customEditors.ts`, `packages/vscode-extension/src/treeProviders.ts`):** Registers nonce-hardened (`default-src 'none'`, escaped JSON boot payload) `CustomTextEditorProvider` views for `*.nibgrid.json`, `*.gdshader`, and `*.room.json`, alongside `EntitiesTreeProvider`, `RoomsTreeProvider`, `VisualQaTreeProvider`, and `publishQaDiagnostics()` surfacing M32 `warn`/`fail` findings in the VS Code Problems panel.

## 92. MCP `stdio` / `vscode.lm` Tool Server & Extension Bundle Smoke Pipeline (Milestone 39C)

- **Validated & Confirmation-Gated MCP Server (`packages/vscode-extension/src/mcpToolServer.ts`):** Normalizes all 8 M38 tools plus `run_vertical_slice` (`NIBGRID_MCP_TOOLS`) to lowercase JSON Schemas, validates `tools/call` arguments via Zod, enforces explicit confirmation on `sync_godot_diff` unless `confirmed: true` or `autoConfirmSync: true`, scrubs all API keys cleanly via `redactHostSecrets()`, supports duplex `Content-Length` + `NDJSON` framing (`startMcpStdioServer()`), and binds IDE `vscode.lm.registerTool` callers (`registerNibgridLanguageModelTools()`).
- **Extension Bundling & Dual-Host Verification (`packages/vscode-extension/vite.config.ts`, `packages/vscode-extension/scripts/verify-extension-bundle.ts`, `package.json` `build:ext`):** Compiles Node-targeted ESM artifacts (`dist/extension.js`, `dist/mcpToolServer.js`) cleanly offline, validates manifest contributions & lowercase MCP JSON Schemas (`verifyExtensionBundle()`), and verifies both `BrowserHostAdapter` and `VscodeHostAdapter` RPC bridges in Playwright (`tests/e2e/m39c-host-e2e.spec.ts`).

## 93. Automated PWA ↔ Desktop Parity Contract & Version Lock (Milestone 41A)

- **Deterministic Parity Verifier (`scripts/verify-parity.ts`, `package.json` `verify:parity`):** Enforces strict SemVer alignment across root `package.json`, `packages/vscode-extension/package.json`, `packages/model-router/package.json`, and `desktop/product.json`, confirms desktop telemetry remains disabled (`telemetryEnabled: false`, `enableTelemetry: false`) with `franekjemiolo.nibgrid-studio` bundled, validates all 17 Screen 4A–4P `ALL_INSPECTOR_TABS`, checks 1:1 registration of all 8 M38 `STUDIO_TOOL_NAMES` + `run_vertical_slice` across `mcpToolServer.ts` and `languageModelTools`, and locks `RECIPE_SCHEMA_VERSION`.

## 94. Local First-Run Config, Portable Settings & Release Artifact Verifier (Milestone 41B)

- **Portable Local Studio Config (`packages/vscode-extension/src/firstRunConfig.ts`, `src/ui/settings/ModelProvidersPanel.tsx`):** Validates per-task routing (`ModelRouter`), shell-safe `godotBinaryPath`, traversal-safe `defaultResSyncSubdir`, and guaranteed `offlineMockFallback: true` (`LocalStudioConfigSchema`); `exportPortableSettingsJson()` and `importPortableSettingsJson()` strip secret fields deeply and scrub embedded token patterns (`nibgrid.localConfig.v1`).
- **Desktop + `.vsix` Staging & Release Verifier (`desktop/scripts/build-desktop.ts`, `desktop/scripts/verify-release-artifacts.ts`):** Stages bundled `web-ui/`, compiled `nibgrid-studio` extension, and `.vsix` ZIP archives (`fflate.zipSync`), while `verifyReleaseArtifacts()` asserts branding, disabled telemetry, compiled entrypoints, ZIP magic bytes, zero secret leaks, and zero hardcoded Vite `localhost:5173` dev origins.

## 95. SHA-256 Checksum Manifest & Lockstep CI/CD Release Pipeline (Milestone 41C)

- **Deterministic Release Checksums (`scripts/generate-checksums.ts`):** Uses Node `crypto.createHash('sha256')` to emit deterministically sorted `SHA256SUMS.txt` manifests across packaged `.tar.gz`, `.zip`, and `.vsix` artifacts while excluding `SHA256SUMS.txt` itself.
- **Continuous Parity & Multi-OS Release Workflows (`.github/workflows/ci-parity.yml`, `.github/workflows/release.yml`, `docs/RELEASING.md`):** Enforces PR/`main` parity and `--dry-run` desktop bundle verification, while `release.yml` orchestrates `preflight-parity` → 3-OS `build-desktop` matrix (`macos-14`, `windows-latest`, `ubuntu-latest`) → `publish-release` (with `workflow_dispatch` `dry_run: true` safety) and lockstep `deploy-pages`.

## 96. Pure-TS Desktop OS Detection, Release Parser & CLI Command Builder (Milestone 42A)

- **Installer & Release Lookup Core (`src/platform/desktopInstaller.ts`):** Pure-TS, DOM-free helpers mapping host signals to `macos-arm64` / `macos-x64` / `win-x64` / `linux-x64` (`detectDesktopPlatform()`), parsing `/releases/latest` JSON payloads (`parseLatestDesktopRelease()`), formatting `curl | sh` / `irm | iex` commands (`getCliInstallCommand()`), and degrading gracefully to `https://github.com/FranekJemiolo/nibgrid/releases/latest` on HTTP `403`/`429` or offline errors (`fetchLatestDesktopRelease()`).

## 97. Hardened One-Line CLI Installers & Release Naming Parity (Milestone 42B)

- **POSIX `sh` & PowerShell Installers (`public/install.sh`, `public/install.ps1`, `.github/workflows/release.yml`):** Deployed verbatim to GitHub Pages root (`/nibgrid/install.sh` and `/nibgrid/install.ps1`), detect OS/arch, fetch `releases/latest` + `SHA256SUMS.txt`, abort with non-zero status on checksum mismatch or missing entry before touching `/Applications/Nibgrid Studio.app` / `$HOME/.local/bin/nibgrid-studio` / `/SILENT` installer, and align 1:1 with `release.yml` assets (`macos-arm64.dmg`, `macos-x64.dmg`, `win-x64-setup.exe`, `linux-x64.AppImage`).

## 98. Web UI Desktop Download Modal & PWA-Only Navigation Entry (Milestone 42C)

- **`InstallDesktopModal.tsx` & Host Capability Gating (`src/ui/desktop/InstallDesktopModal.tsx`, `src/App.tsx`, `src/store/useAppStore.ts`, `src/ui/command/CommandPalette.tsx`):** Exposes **Get Desktop App** (`nav-get-desktop-btn`) and `Cmd+K` **Get Nibgrid Studio Desktop** strictly when `!getActiveHostAdapter().capabilities.supportsLocalProcessLaunch`, fetches `/releases/latest` cleanly, updates OS download CTAs & copyable SHA-256 CLI one-liners across all 4 targets, degrades cleanly to `https://github.com/FranekJemiolo/nibgrid/releases/latest` when rate-limited (`403`/`429`), and documents post-install Google Antigravity linking.

## 99. Hardened Zero-Dependency Python Loopback Bridge

- **PEP 723 Loopback Server (`.agents/skills/nibgrid/scripts/nibgrid_bridge.py`):** Implements a pure-stdlib (`dependencies = []`, `requires-python = ">=3.11"`) HTTP/1.1 bridge bound strictly to `127.0.0.1:4188` with exact `Origin` allowlisting (extensible via `--allow-origin`), Chrome PNA `OPTIONS` preflights (`Access-Control-Allow-Private-Network: true`, `Vary: Origin`, `Cache-Control: no-store`), `hmac.compare_digest` Bearer verification, `16 MiB` `Content-Length` enforcement, secret redaction (`redact_secrets()`), deterministic stdlib RGBA PNG (`make_mock_png_b64()`) + 16-bit PCM WAV (`make_mock_wav_b64()`) generation in `--mock` mode, live Gemini REST forwarding, and backward-compatible `create_bridge_server()` M10 contracts.
- **Verification & CI Integration (`tests/python/test_nibgrid_bridge.py`, `tests/unit/test_nibgrid_bridge.py`, `.github/workflows/ci-parity.yml`):** Exercises ephemeral-port `ThreadingHTTPServer` instances end-to-end across health checks, disallowed `403` origins, PNA preflights, `401` token checks, valid PNG/WAV mock payloads, malformed JSON/`400` overflow handling, secret redaction, and M10 stateful interaction chains.

## 100. Zero-Server Desktop Self-Update Checker Core (Milestone 43A)

- **Pure-TS Update Evaluation & Checksum Parsing (`packages/vscode-extension/src/updateCheckerCore.ts`):** Implements zero-dependency SemVer comparison (`parseSemver()`, `isNewerSemver()` ignoring pre-release strings by default), 24-hour throttle evaluation (`shouldRunAutoUpdateCheck()`), `SHA256SUMS.txt` manifest parsing (`parseSha256Sums()`), and ETag-conditional GitHub `/releases/latest` checks (`checkForDesktopUpdate()` with `If-None-Match` -> `304`, `skippedVersion` gating, and silent `403`/`429`/offline degradation) reusing M42's `parseLatestDesktopRelease()`.

## 101. Streaming SHA-256 Verification & Safe OS Installer Handoff (Milestone 43B)

- **Streaming Verifier & OS Handoff (`packages/vscode-extension/src/desktopUpdater.ts`):** Streams both `SHA256SUMS.txt` and the target platform installer into an isolated `os.tmpdir()` folder (`nibgrid-update-*`), verifies streaming `crypto.createHash('sha256')` digests against expected hex via `crypto.timingSafeEqual`, immediately removes the temp folder on mismatch or missing entry while throwing `ChecksumMismatchError`, and executes the verified installer via `child_process.execFile` without shell interpolation (`open <dmg>` on macOS, detached `/SILENT` + `quitApp()` on Windows, atomic move + `chmod 0o755` to `~/.local/bin/nibgrid-studio` on Linux).

## 102. Desktop Self-Update Status Bar UX & Extension Wiring (Milestone 43C)

- **Extension Manifest & Lifecycle (`packages/vscode-extension/package.json`, `packages/vscode-extension/src/extension.ts`):** Registers `nibgrid.checkForUpdates` (`Nibgrid: Check for Updates`) and `nibgrid.updates.autoCheck` (`true`), schedules a 10-second unreffed startup check throttled at 24h (`nibgrid.updateLastCheckedAt`, `nibgrid.updateEtag`, `nibgrid.updateSkippedVersion` in `globalState`), displays a non-blocking `$(cloud-download) Nibgrid v<latest>` status bar item on available releases, runs verified downloads inside `withProgress`, and degrades silently on background offline/`403`/`429` failures.

## 103. Automated Pre-Release & Post-Deploy Smoke Gate (`scripts/smoke-release.mjs`)

- **Playwright Release Smoke Verifier (`scripts/smoke-release.mjs`, `package.json`, `.github/workflows/release.yml`):** Verifies live or preview deployments across `install.sh` (including `sh -n` POSIX syntax check), `install.ps1` (`Get-FileHash` & `SHA256SUMS.txt` assertions), `manifest.webmanifest`, Chromium cold boot, active Service Worker registration, `InstallDesktopModal`, offline reload, and zero unexpected `console.error` / `pageerror` events. Wired into `.github/workflows/release.yml` as the post-deploy `smoke-pages` job reading `needs.deploy-pages.outputs.page_url`.

## 104. Pure-TS 2D Normal Map & Emission Mask Baker (Milestone 44A)

- **Zero-DOM Normal & Emission Math (`src/processing/normalEmissionBaker.ts`):** Derives normalized scalar height fields (`luminance`, `alpha-bevel`, or `hybrid`) over raw `Uint8ClampedArray` RGBA buffers, computes 3×3 Sobel tangent-space normals scaled by `strength` with `invertY` toggle (defaulting to OpenGL `+Y` up for Godot 4), encodes neutral `(128, 128, 255, 0)` on all transparent pixels to avoid edge halos, and isolates glowing regions (`palette-swatches` or `luminance-threshold`) via `bakeEmissionMaskFromRgba()`.

## 105. Godot 4 `CanvasTexture`, Normal `.import` & `LightOccluder2D` Exporter (Milestone 44B)

- **Lighting Resource Export & M25 Sync (`src/export/godotLightingExporter.ts`, `src/export/godotPrefabAssembler.ts`, `src/sync/fsaaSyncEngine.ts`):** Serializes Godot 4 `format=3` `CanvasTexture` `.tres` resources (`texture_filter = 1` for pixel art), normal map `.png.import` sidecars with `compress/normal_map=1`, and M16-derived RDP `OccluderPolygon2D` sub-resources (`cull_mode = 0`, `>= 3` finite vertices).
- **Atomic Persistence (`src/domain/schemas.ts`, `src/db/database.ts`):** Stores `SpriteLightingBakeSchema` metadata and SHA-256 deduplicated `_n.png` / `_e.png` blobs via `NibgridRepository.commitSpriteLightingBake()` while extending `findOrphanBlobIds()` so replaced lighting blobs are garbage-collected with zero orphans.

## 106. Interactive WebGL2 Lighting Baker & Entity Sync UX (Milestone 44C)

- **`LightingBakerPanel.tsx` & UI Integration (`src/ui/lighting/LightingBakerPanel.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/entities/EntityHubView.tsx`, `src/ui/command/CommandPalette.tsx`, `src/store/useAppStore.ts`):** Renders an interactive draggable `PointLight2D` stage in WebGL2 (with transparent 2D Canvas CPU fallback and full GL resource disposal on unmount), 5-channel toggles (`Lit Preview`, `Diffuse`, `Normal Map (_n)`, `Emission (_e)`, `Occluder Hull`), `ArtBible` emissive swatches, and 1-click **Bake & Attach to Asset** committing `_n.png`, `_e.png`, and `_canvas.tres` metadata atomically into Dexie for M25 `res://` sync.

## 107. Pure-TS World Map Graph & Softlock Reachability Auditor (Milestone 45A)

- **World Graph Schemas & Progression Auditor (`src/world/worldGraphCore.ts`):** Defines Zod schemas (`WorldRoomNodeSchema`, `WorldPortalEdgeSchema`, `WorldGraphSchema`) connecting M35 rooms via portal triggers (`fromDoorId -> toSpawnId`), flag grants (`grantsFlags`), and flag gates (`requiredFlags`), plus `auditWorldReachability()` implementing fixed-point progression BFS from `isStart`, secondary softlock trap verification (confirming every reachable non-goal room can still reach a `isGoal` room or the `isStart` hub), cyclic graph termination, dangling edge checks, and duplicate door/spawn detection.

## 108. Pixel-Art Minimap Baker, Godot 4 Portal Exporter & Atomic World Sync (Milestone 45B)

- **Minimap Baker (`src/world/minimapBaker.ts`):** Renders nearest-neighbor RGBA minimaps snapped to `ArtBible` colors (`deriveMinimapPaletteFromArtBible`, `bakeWorldMinimapRgba` at `1px`/`2px` per tile) with 1px room borders, door connector lines, Start/Goal pips, and `minimap_atlas.json` room bounding boxes.
- **Godot 4 World Exporter & M25 Sync (`src/export/godotWorldExporter.ts`, `src/export/godotRoomExporter.ts`, `src/db/database.ts`, `src/sync/fsaaSyncEngine.ts`):** Emits per-room `Area2D` portal triggers and `Marker2D` spawn markers inside `levels/<slug>.tscn`, generates typed `WorldTransitionManager.gd` autoload scripts and nearest-neighbor `minimap.png.import`, adds Dexie v9 `worldGraphs` with atomic `commitWorldGraphWithMinimap()` / zero-orphan `findOrphanBlobIds()` tracking, and wires `world/*` files into `collectProjectGodotSyncFiles()`.

## 109. Interactive World Map Graph, Audit & Minimap UI (Milestone 45C)

- **`WorldMapPanel.tsx` & Parity Registration (`src/ui/world/WorldMapPanel.tsx`, `src/ui/inspector/workspaceTabs.ts`, `scripts/verify-parity.ts`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/inspector/RoomPrototyperWorkshop.tsx`, `src/ui/command/CommandPalette.tsx`):** Exposes a top-level **World Map** header route (`#/project/:id/world`), `'world-map'` inspector tab (`verify:parity` tracked), and `Cmd+K` Command Palette action with pan/zoom snap-to-grid room cards, portal link editor, 1-click softlock audit badges (jumping directly to flagged M35 rooms), nearest-neighbor minimap canvas preview, and Godot `res://` world sync.

## 110. Schema-Driven Game Data Foundry & Seeded Balance Simulator (Milestone 46A)

- **Game Data Schemas & Referential Validator (`src/data/gameDataSchemas.ts`):** Defines versioned Zod schemas (`WeaponItemSchema`, `EnemyStatBlockSchema`, `LootTableSchema`, `ProgressionCurveSchema`, `GameDataRegistrySchema`), starter presets (`createDefaultGameDataRegistry`), CSV/JSON serializers, and strict `validateGameDataRegistry()` catching duplicate IDs, `minQty > maxQty`, missing `enemy.lootTableId`, and dangling `lootTable.entries[].itemId` references (allowing reserved `__gold__`).
- **Seeded Monte Carlo Balance Engine (`src/data/balanceSimulator.ts`):** Implements zero-DOM Mulberry32 PRNG (`createMulberry32`), M36-parity `computeMitigatedDamage()`, `simulateCombatTtk()` (byte-identical P10/P50/P90 TTK, effective DPS, win rate, histogram buckets, and sponge/lethality warnings), `simulateLootEconomy()`, and `evaluateProgressionCurve()`.

## 111. Godot 4 Typed `Resource` Exporter & Dexie v10 Sync (Milestone 46B)

- **Typed Godot Data Exporter (`src/export/godotDataExporter.ts`, `src/db/database.ts`, `src/sync/fsaaSyncEngine.ts`):** Emits Godot 4.3+ `@export` typed `Resource` classes (`WeaponItemData.gd`, `EnemyStatData.gd`, `LootTableData.gd`) under `res://data/schemas/`, safely escaped `format=3` `load_steps=2` `.tres` resource instances (`data/items/*.tres`, `data/enemies/*.tres`, `data/loot/*.tres`), `toPlaytestCombatPatch()` mapping for M36 Playtest, Dexie v10 `gameDataRegistries` table persistence, and automatic `collectProjectGodotSyncFiles()` inclusion.

## 112. Interactive Data Foundry, Balance Lab & Parity Integration (Milestone 46C)

- **`DataFoundryPanel.tsx` & Navigation (`src/ui/data/DataFoundryPanel.tsx`, `src/ui/inspector/workspaceTabs.ts`, `scripts/verify-parity.ts`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`):** Registers top-level **Data Foundry** route (`#/project/:id/data`), `'data-foundry'` inspector tab (`verify:parity` tracked), and `Cmd+K` palette entry with tabbed inline editing (Items, Enemies, Loot Tables, XP Curves), CSV/JSON export, live seeded Mulberry32 Monte Carlo TTK histogram & loot/XP simulation sidebar, 1-click **Push to M36 Playtest**, and M25 `.gd`/`.tres` sync.

## 113. Branching Dialogue Graph Schemas & M24/M33 Localization Auditors (Milestone 47A)

- **Dialogue Graph & Localization Schemas (`src/narrative/dialogueSchemas.ts`):** Defines versioned Zod schemas (`DialogueChoiceSchema`, `DialogueNodeSchema`, `DialogueGraphSchema`, `LocalizationTableSchema`, `ProjectNarrativeBundleSchema`), M33 box constraint presets (`UI_BOX_PRESETS`), starter generator (`createDefaultProjectNarrative()`), and pure integrity validator `validateDialogueGraph()` checking entry node existence, duplicate IDs, dangling `nextNodeId` edges, BFS reachability, and missing translations across all declared locales.
- **Unicode M24 Glyph & M33 Overflow Auditors (`src/narrative/localizationAuditor.ts`):** Implements zero-DOM Unicode codepoint coverage scanning (`buildCharsetCodepointSet()`, `auditFontGlyphCoverage()` via `for...of` + `codePointAt(0)` ignoring control/whitespace chars) and deterministic M24 advance/kerning word-wrap measurement (`measureWrappedTextPx()`, `auditUiTextOverflow()`, `buildM24MetricsFromBakedFont()`, `buildConstraintsFromDialogueGraph()`).

## 114. Godot 4 `TranslationServer` CSV, `DialogueRunner.gd` & Dexie v11 Sync (Milestone 47B)

- **Dialogue & Localization Exporter (`src/export/godotDialogueExporter.ts`, `src/db/database.ts`, `src/sync/fsaaSyncEngine.ts`):** Produces strict RFC 4180 UTF-8 CSV (`exportGodotTranslationCsv()`, `parseGodotTranslationCsv()`) for `res://localization/strings.csv`, snake_case runtime `dialogue_graph.json` (`exportDialogueGraphJson()`), and typed Godot 4.3+ `DialogueRunner.gd` resolving `tr(...)`, filtering choices via M45 `WorldTransitionManager` flags, and emitting portrait emotion signals; persists `ProjectNarrativeBundle` in Dexie v11 (`narrativeBundles`) with transactional `saveNarrativeBundle()` and `appendNarrativeFontGlyphs()`, wired directly into `collectProjectGodotSyncFiles()`.

## 115. Interactive Dialogue & Localization Studio, Glyph Quick-Fix & Parity (Milestone 47C)

- **`DialogueLocalizationPanel.tsx` & Navigation (`src/ui/narrative/DialogueLocalizationPanel.tsx`, `src/ui/inspector/workspaceTabs.ts`, `scripts/verify-parity.ts`, `src/store/useAppStore.ts`, `src/App.tsx`, `src/ui/inspector/PostProcessInspector.tsx`, `src/ui/command/CommandPalette.tsx`):** Exposes top-level **Dialogue & L10n** header route (`#/project/:id/dialogue`), `'dialogue-l10n'` inspector tab (`verify:parity` tracked), and `Cmd+K` palette action pairing a branching `DialogueNode` composer & live localized preview with a multi-locale inline matrix (CSV import/export), live M24 glyph-coverage / M33 text-overflow audit drawer, 1-click **Add Missing Glyphs to M24 Font** atomic repair, and M25 FSAA `res://` sync (`localization/strings.csv`, `narrative/dialogue_graph.json`, `narrative/DialogueRunner.gd`).

## 116. Pure-TS Pixel Polish Pipeline, Foot-Anchor Stabilizer & Silent Quality Gate (Milestone 48)

- **Pixel Cleanup & Strip Stabilization (`src/processing/pixelPolish.ts`, `src/processing/frameStabilizer.ts`):** Implements boundary-energy autocorrelation `detectPixelGridScale()`, mode-pool downsampling, OKLab `ArtBible` quantization (`quantizeToArtBibleOklab()` with optional `bayer4x4` dithering preserving `alpha === 0`), 8-neighbor `stripOrphanPixels()`, and integer-shift `stabilizeAnimationStrip()` locking animation frames onto a shared bottom-center foot baseline (`delta === 0`).
- **Style-Lock & Studio Integration (`src/ai/styleLockGate.ts`, `src/ui/studio/SpriteStudio.tsx`, `src/ui/studio/GenerationInspector.tsx`):** Automatically injects Golden References plus up to 2 approved sprite anchors (`selectStyleLockAnchors()`), provides bounded 1-retry quality gating (`runWithSilentQualityGate()`, `evaluateSpriteQuality()`), and exposes an interactive **Auto-Polish** toggle persisting deduplicated blobs with zero orphans.

## 117. 4-Workspace Progressive Disclosure, Creator/Pro Mode & Fix-It Cards (Milestone 49)

- **4-Workspace Shell & Mode Store (`src/ui/layout/workspaceShell.ts`, `src/state/uxModeStore.ts`, `src/ui/layout/ContextualInspector.tsx`, `src/ui/export/ShipToGodotPanel.tsx`, `src/App.tsx`):** Organizes project screens across **1. Style & Vision**, **2. Cast & World**, **3. Play & Tune**, and **4. Ship to Godot** (`#/project/:id/ship`, `'ship-godot'` tab tracked in `workspaceTabs.ts` and `verify:parity`) alongside a persistent **Creator | Pro** header toggle that hides raw `.gdshader`/Sobel bevel/RDP epsilon/JSON schema views behind curated presets in default Creator Mode while revealing full parameter controls in Pro Mode.
- **1-Click Fix-It Cards (`src/ui/audit/fixItEngine.ts`, `src/ui/audit/FixItCardList.tsx`, `src/ui/audit/AuditMatrixView.tsx`):** Converts M17/M32/M45/M47 diagnostics into plain-English cards with deterministic atomic resolvers (`applyMissingGlyphFix`, `applySoftlockTrapFix`, `applyOffPaletteFix`).

## 118. Turnkey Godot 4 `GameKit` Exporter, Composable `.tscn` Prefabs & `addons/nibgrid_sync` (Milestone 50)

- **Turnkey Project, Composable Prefabs & EditorPlugin (`src/export/godotGameKitExporter.ts`, `src/export/godotPrefabBuilder.ts`, `src/export/godotPluginExporter.ts`, `src/sync/fsaaSyncEngine.ts`, `src/ui/export/ShipToGodotPanel.tsx`):** Emits F5-ready Godot 4.3+ `project.godot` (8 Keyboard/Joypad InputMap actions, 7 named physics layers, integer pixel-perfect scaling, autoloads), `default_bus_layout.tres` (`Master`/`SFX`/`Music`/`Ambience`), playable `main.tscn` (`TitleScreen`, `HudRoot`, `MinimapPanel`, `DialogueBox`, `PauseMenu`, `GameShell.gd`), modular entity `.tscn` prefabs (`CharacterBody2D`, `Sprite2D`, `LightOccluder2D`, `AnimationPlayer` with frame/`HitboxComponent`/`hit_flash`/SFX tracks, `HealthComponent`, `HurtboxComponent`, `StateMachine`), and `addons/nibgrid_sync/` (`plugin.cfg` + `@tool` `nibgrid_sync.gd` EditorPlugin watching `.nibgrid_sync_manifest.json` + adding **"Edit in Nibgrid"** inspector button).
