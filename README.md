# Nibgrid

Local-first, zero-server Bring-Your-Own-Key / Bring-Your-Own-Model (BYOK/BYOM) Progressive Web App for turning hand-drawn sketches and vocal hums into style-locked, engine-ready 2D game sprites, normal maps, animations, colliders, UI panels, and audio.

**Live App (GitHub Pages):** https://franekjemiolo.github.io/nibgrid/

---

## Table of Contents

- [Use-Case Matrix: What Can You Build with Nibgrid?](#use-case-matrix-what-can-you-build-with-nibgrid)
- [Part 1 — End-to-End Hero Tutorial: 2D Platformer Red Cat Warrior](#part-1--end-to-end-hero-tutorial-2d-platformer-red-cat-warrior)
  - [1.1 Lock Your Art Bible (Screen 2)](#11-lock-your-art-bible-screen-2)
  - [1.2 Sketch Ingestion & Web Worker Line Extraction (Screen 3)](#12-sketch-ingestion--web-worker-line-extraction-screen-3)
  - [1.3 Generate Variants & Branch in the Sprite Lineage DAG (Screen 3)](#13-generate-variants--branch-in-the-sprite-lineage-dag-screen-3)
  - [1.4 Side-by-Side Variant & Ancestor Comparison](#14-side-by-side-variant--ancestor-comparison)
  - [1.5 Cutout, De-Mixel, OKLab Sel-Out, Palette Snap & Pivot Export (Screen 4A)](#15-cutout-de-mixel-oklab-sel-out-palette-snap--pivot-export-screen-4a)
  - [1.6 Animated GIF89a & Horizontal Spritesheet Export](#16-animated-gif89a--horizontal-spritesheet-export)
- [Part 2 — Specialized 2D Asset Foundry Use-Case Tutorials](#part-2--specialized-2d-asset-foundry-use-case-tutorials)
  - [2.1 Bake 2D Normal Maps & Audition Live Point Lighting (Screen 4B)](#21-bake-2d-normal-maps--audition-live-point-lighting-screen-4b)
  - [2.2 Rig Single-Sprite Idle, Sway & Recoil Loops via MLS Puppet Warp (Screen 4C)](#22-rig-single-sprite-idle-sway--recoil-loops-via-mls-puppet-warp-screen-4c)
  - [2.3 Heal Seamless Tiles & Build 9-Slice UI Panels (Screen 4D)](#23-heal-seamless-tiles--build-9-slice-ui-panels-screen-4d)
  - [2.4 Create 8-Bit Indexed Palette-Swap & Multi-Faction GPU LUTs (Screen 4E)](#24-create-8-bit-indexed-palette-swap--multi-faction-gpu-luts-screen-4e)
  - [2.5 Audition Readability, Biomes & Hit-Flash at 1× Scale (Screen 4F)](#25-audition-readability-biomes--hit-flash-at-1-scale-screen-4f)
  - [2.6 Auto-Trace 2D Collision Hulls & Author Hitboxes/Hurtboxes (Screen 4G)](#26-auto-trace-2d-collision-hulls--author-hitboxes-hurtboxes-screen-4g)
  - [2.7 Pack Multi-Engine Texture & Animation Atlases (Screen 5)](#27-pack-multi-engine-texture--animation-atlases-screen-5)
  - [2.8 Synthesize Procedural Foley & Google AI Game Audio (Screen 6)](#28-synthesize-procedural-foley--google-ai-game-audio-screen-6)
  - [2.9 Turn Microphone Hums or WAV Sketches into Game Audio (Screen 6 · Mic Sketch)](#29-turn-microphone-hums-or-wav-sketches-into-game-audio-screen-6--mic-sketch)
  - [2.10 Audit Project Compliance & Run 1-Click $0.00 Batch Fixes (Screen 7)](#210-audit-project-compliance--run-1-click-000-batch-fixes-screen-7)
  - [2.11 Pair the Local Antigravity Loopback Bridge (127.0.0.1:4188)](#211-pair-the-local-antigravity-loopback-bridge-1270014188)
- [Part 3 — Engine Drop-In Integration Examples](#part-3--engine-drop-in-integration-examples)
- [Architecture Summary](#architecture-summary)
- [Development & Verification](#development--verification)
- [Browser Compatibility & Runtime Notes](#browser-compatibility--runtime-notes)

---

## Use-Case Matrix: What Can You Build with Nibgrid?

| Use Case                                          | Screen / Tab                           | Compute Cost                               | Exported Output                                                                                     |
| :------------------------------------------------ | :------------------------------------- | :----------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| Character Concept-to-Sprite & Pose Branches       | `Art Bible` + `Sprite Studio`          | `$0.00` Mock / Handoff or BYOK             | Branching PNG nodes + `asset.recipe.json`                                                           |
| Pixel-Art Cleanup, De-Mixel & OKLab Sel-Out       | `Post-Process` (Screen 4A)             | `$0.00 Local` (Web Worker)                 | Crisp alpha PNG, pivot metadata, `.zip`                                                             |
| Dynamic 2D Bevel & Normal Maps                    | `2D Lighting & Normal Map` (Screen 4B) | `$0.00 Local` (WebGL2 + EDT)               | Godot (`+Y`) / DirectX (`-Y`) `_n.png`                                                              |
| Single-Sprite Idle, Breathe & Recoil Loops        | `Puppet Warp Animator` (Screen 4C)     | `$0.00 Local` (WebGL2 MLS)                 | Horizontal `_strip.png` + frame JSON + `.zip`                                                       |
| Seamless Environment Tiles (Ground, Brick, Water) | `Tile & 9-Slice` → `Seamless Tile`     | `$0.00 Local` wrap + optional BYOK inpaint | Wrapping PNG + toroidal `gl.REPEAT` `_n.png`                                                        |
| Responsive UI Buttons, Frames & Dialog Boxes      | `Tile & 9-Slice` → `9-Slice UI Panel`  | `$0.00 Local`                              | `_stylebox.tres`, `_nineslice_phaser.json`, Pixi JSON                                               |
| Multi-Faction Enemy & Armor Recolor Shaders       | `Palette-Swap & LUT` (Screen 4E)       | `$0.00 Local` (OKLCH ramps)                | `_idx.png`, `_lut.png`, `.gdshader`, Pixi v8 Filter                                                 |
| 1× Biome Contrast Audit & Combat Hit-Flash Feel   | `Game Sandbox` (Screen 4F)             | `$0.00 Local` (Canvas2D)                   | Rec.709 contrast telemetry + SFX bindings                                                           |
| 2D Physics Hulls, Hitboxes & Hurtboxes            | `Collider & Hitbox` (Screen 4G)        | `$0.00 Local` (Marching Squares + RDP)     | Godot `_collider.tres`, Phaser / Matter `_matter.json`                                              |
| Multi-Engine Texture & Animation Atlases          | `Atlas Packer` (Screen 5)              | `$0.00 Local` (BSSF MaxRects)              | `atlas_0.png`, `_n.png`, `atlas_frames.tres`, `atlas.json`, `atlas_pixi.json`, `atlas_physics.json` |
| Procedural SFX, Google Lyria 3 Music & Gemini TTS | `Audio Foundry` (Screen 6)             | `$0.00 Local` or Single Gemini Key         | 16-bit WAV + 1/4/6× variations + `.audio.recipe.json`                                               |
| Mic Hum-to-Laser, Engine Rev or Chiptune Melody   | `Audio Foundry` → `Mic Sketch`         | `$0.00 Local` or Single Gemini Key         | Contour-locked WAVs + `audioSketch` recipe                                                          |
| Project-Wide Asset Drift Audit & Batch Re-Bake    | `Audit` (Screen 7)                     | `$0.00 Local`                              | Readiness `0–100` matrix + reversible batch fixes                                                   |

---

## Part 1 — End-to-End Hero Tutorial: 2D Platformer Red Cat Warrior

This walkthrough takes a rough sketch from blank project to a palette-locked, animated platformer character on [https://franekjemiolo.github.io/nibgrid/](https://franekjemiolo.github.io/nibgrid/) with zero backend infrastructure.

### 1.1 Lock Your Art Bible (Screen 2)

Every generated sprite, normal map, palette snap, and batch audit inherits the rules stored in your project's **Art Bible**.

**Click-by-Click:**

1. On **Projects** (`Project Hub`), type a project name (`Crimson Whisker Foundry`) and click **Create Project**.
2. In **Art Bible**, set **Camera Projection** → `Side-Scroller`, **Key Lighting** → `Top-Left`, and **Art Mode** → `Pixel Art`.
3. Under **Target Sprite Resolution**, click **`128×128`** (or enter custom dimensions up to `2048×2048`).
4. Paste style rules into **Global Style Prompt** and **Cutout-Safe Negative Prompt** (keeping flat solid backdrops and centered silhouettes with margin).
5. Under **Locked Palette**, click **Import `.gpl`/`.hex`** to load your swatch file (or add hex colors with the picker + **Add Swatch**), and optionally upload up to 3 **Golden Style References**.
6. Click **Open Sprite Studio** in the top-right header.

![Art Bible Style Lock — Red Cat Warrior](docs/demo/01-art-bible-cat-warrior.png)

---

### 1.2 Sketch Ingestion & Web Worker Line Extraction (Screen 3)

Turn rough paper photos, mouse doodles, or existing blocking PNGs into centered, high-contrast linework inside a Dedicated Web Worker without freezing the UI.

**Click-by-Click:**

1. In the left **Sketch Ingestion** pane of **Sprite Studio**, click **Upload Sketch PNG/JPG** and select your rough drawing.
2. Click **Extract Lines & Center** so Nibgrid runs adaptive local/global thresholding and safe-margin bounding-box centering on a Web Worker.
3. Refine silhouette details directly on the stage using **Sketch Pen**, **Eraser**, and **Brush Size** (or press `Z` to undo and `Space`/`Shift+Drag` to pan).

![Normalized Sketch in Sprite Studio](docs/demo/02-sketch-normalized.png)

---

### 1.3 Generate Variants & Branch in the Sprite Lineage DAG (Screen 3)

Iterate non-destructively using the **Sprite Lineage DAG** so you can branch poses, weapons, or masked inpaints from any parent without losing earlier versions.

**Click-by-Click:**

1. In the right **Generation Inspector** pane, pick your **Provider**:
   - **Built-in Deterministic Mock** (`$0.00 Local`) for zero-key prototyping and pipeline testing,
   - **Gemini Multimodal BYOK**, **Local ComfyUI**, or **Antigravity Loopback Bridge (`127.0.0.1:4188`)** configured in **Provider Vault**, or
   - **Google Antigravity IDE / Agent Handoff** to click **Copy Prompt Brief**, generate images with an IDE agent, and click **Import Agent PNG into DAG**.
2. Choose **Sketch Adherence** (`Strict` / `Balanced` / `Loose`), select **`2 Variants`**, and click **Generate 2 Variants**.
3. Click any node in the bottom **Sprite Lineage DAG** dock (or its **Fork** icon) to set it as the **Branch Parent**.
4. To surgically edit only one region (e.g., igniting a plasma slash arc), click **Inpaint Mask** in the left toolbar, paint over the blade area on the canvas, enter a **Prompt Delta**, and click **Inpaint Masked Region**.

![Sprite Studio with Antigravity IDE Handoff and Branching DAG](docs/demo/03-antigravity-dag-studio.png)

---

### 1.4 Side-by-Side Variant & Ancestor Comparison

Evaluate silhouette consistency, weapon arcs, and lighting direction before committing a winner to post-processing.

**Click-by-Click:**

1. In the bottom **Sprite Lineage DAG** dock, click **Compare** (or click the **Compare** icon on any node card).
2. Switch **Left** and **Right** node selectors to inspect sibling variants or parent → child inpaint iterations side by side.
3. Click **Select Winner** / close the modal and click **Open Post-Process** on your chosen node.

![Side-by-Side Comparison of Cat Warrior Stances](docs/demo/04-compare-variants.png)

---

### 1.5 Cutout, De-Mixel, OKLab Sel-Out, Palette Snap & Pivot Export (Screen 4A)

Clean up AI soft gradients, remove background pixels, lock pixel grid alignment, anchor the physics/feet pivot, and export reproducible PNG + `.recipe.json` bundles.

**Click-by-Click:**

1. Click **Open Post-Process** from **Sprite Studio** (or the **Post-Process** button on any DAG node).
2. Under **1. Background Cutout**, choose **Fast Color-Key (Flood Fill)** (set `Tolerance` ~`12`) or **Local AI Cutout (Worker)** (`@huggingface/transformers`), and check **Interior-RGB Color Decontamination (Defringe)** under Edge Cleanup.
3. Under **3. OKLab Palette Snap**, check **Snap to Art Bible Palette** (and optionally toggle **4×4 Ordered Bayer Dithering** for shaded transitions).
4. Under **Pixel-Art Foundry**, enable:
   - **De-Mixel Grid Snap (Auto Period)** to snap blurry upscaled pixels back onto integer mixel cells,
   - **Orphan-Pixel & Specks Cleaner** (`Max Island` + `Pepper Despeckle`) to remove stray floating dots, and
   - **Sel-Out Outline** (`Outer 1px (Sel-Out)` + `Top-Left` light angle) for perceptual dark outlines on shadow edges.
5. Enable downsampling to **`64×64`** Nearest-Neighbor and click the **`Bottom-Center`** pivot preset (`0.50, 1.00` → `(32, 64) px`).
6. Drag the vertical split handle left/right over **Checker**, **Dark**, **Light**, or **Game Green** backdrops to verify crisp edges, then click **Download ZIP** (or **Export to Local Folder** in Chromium).

![Post-Process Split Comparator, Pivot Anchor, and Export](docs/demo/05-postprocess-and-export.png)

**Exported `64×64` Game-Ready Platformer Sprite (`crimson-whisker-lightsaber-cat-generation-1024.png`):**

![Exported 64x64 Red Cat Warrior Sprite](docs/demo/red-cat-warrior-final-64x64.png)

---

### 1.6 Animated GIF89a & Horizontal Spritesheet Export

Turn multi-node combat stances into a lightweight GIF preview and engine-ready horizontal strip.

**Click-by-Click:**

1. Return to **Sprite Studio** and click **Animate & GIF** in the **Sprite Lineage DAG** dock header.
2. Add your ordered DAG frames (`#1 Idle` → `#2 Mid-Charge` → `#3 Slash Arc`) using **+ Add Frame**.
3. Set **`64×64`**, **`6 FPS`**, toggle **Ping-Pong Loop** (and optional **Onion Skin**), **Auto Color-Key Cutout**, and **OKLab Palette Snap**.
4. Click **Play** to inspect motion, then click **Download GIF** and **Download Spritesheet PNG** (`192×64`).

![Animation & GIF Studio Modal](docs/demo/06-animation-gif-studio.png)

**Exported `64×64` Looping Animated `.GIF` & `192×64` Horizontal Spritesheet:**

![Animated Red Cat Warrior Lightsaber GIF](docs/demo/red-cat-warrior-lightsaber.gif)
![Red Cat Warrior Horizontal Spritesheet](docs/demo/red-cat-warrior-spritesheet.png)

---

## Part 2 — Specialized 2D Asset Foundry Use-Case Tutorials

Once a sprite is inside **Post-Process & Export Inspector** (`Screen 4`), switch tabs along the top bar—or navigate to **Atlas Packer** (`Screen 5`), **Audio Foundry** (`Screen 6`), and **Audit** (`Screen 7`) in the global header—to unlock these specialized workflows.

### 2.1 Bake 2D Normal Maps & Audition Live Point Lighting (Screen 4B)

**When to use it:** You want top-down, dungeon crawler, or side-scroller sprites to react dynamically to torches, gunfire flashes, or day/night directional lights inside Godot, Unity, Phaser, or PixiJS without painting normal maps by hand.

**Click-by-Click:**

1. In **Post-Process & Export Inspector**, click the **`2D Lighting & Normal Map`** tab.
2. Under **Engine Y Convention**, click **Godot / OpenGL (+Y)** or **DirectX (-Y)** to match your target renderer.
3. Choose a **Bevel Profile** (`Spherical Dome`, `Pillowed`, `Chamfer`, or `Crisp Step`), then dial **Bevel Radius (EDT px)**, **Bevel Weight**, and **Surface Detail Weight** (which blends high-frequency Sobel gradients from albedo luminance).
4. Move your mouse across the center canvas to aim the real-time WebGL2 **Blinn-Phong point light** (`Click to pin`, `Alt+Wheel` to adjust light Z height), or click **`Normal Map`**, **`Bevel Height`**, and **`Split Lit | Normal`** along the top-left bar to inspect raw RGB channels.
5. Ensure **Bundle `_n.png` Normal Map in ZIP / Folder Export** is checked, then click **Download ZIP**.

**What gets exported:** Exact-matching sprite albedo PNG, aligned `_n.png` tangent-space normal map, and `normalMap` parameters recorded inside `asset.recipe.json`.

![Screen 4B — WebGL2 2D Lighting and Normal Map Generator](docs/demo/07-normal-map-lighting.png)

---

### 2.2 Rig Single-Sprite Idle, Sway & Recoil Loops via MLS Puppet Warp (Screen 4C)

**When to use it:** You have one great static enemy, prop, banner, or crystal sprite and need a subtle `6`-to-`8` frame idle breathe, tree wind sway, hover bob, slime squash, or hit recoil animation without redrawing frames or fighting AI consistency drift.

**Click-by-Click:**

1. Open the **`Puppet Warp Animator`** tab inside **Post-Process & Export Inspector**.
2. Click pin role buttons along the top toolbar and click directly on the sprite canvas to place your rig:
   - **`Anchor`** (blue square — roots feet/base pixels firmly to the ground),
   - **`Driver`** (amber diamond — controls chest/torso breathing or bend motion), and
   - **`Tip`** (cyan circle — drives head, weapon, cloak tip, or flame lag).
3. Right-click any placed pin to cycle its role, or drag a pin directly to test interactive Rigid / Similarity **Moving Least Squares (MLS)** mesh deformation.
4. Select a **Loop Preset** (`Idle Breathe`, `Wind Sway`, `Float Bob`, `Slime Squash`, `Hit Recoil`), set **Solver Mode** (`Rigid (Area-Lock)` or `Similarity`), **Frames** (`6`), **Edge Pad (px)** (`8`), **Amplitude**, and **Playback Speed (FPS)**.
5. Optionally enable **Ping-Pong Timeline Sequence**, **Onion Skin Ghosts (Prev/Next)**, or **Re-Lock Pixel Polish (Sel-Out + Cleanup per Frame)**.
6. Click **`Export Strip ZIP (480×80)`** to download the animated strip, frame timing JSON, and recipe—or leave it rigged to pack directly in **Screen 5 Atlas Packer**.

**What gets exported:** Seamless horizontal `<slug>_<preset>_strip.png`, frame coordinate JSON manifest, and saved `puppetAnim` pin metadata in IndexedDB.

![Screen 4C — MLS Puppet-Warp 2D Micro-Animator](docs/demo/08-puppet-warp-animator.png)

---

### 2.3 Heal Seamless Tiles & Build 9-Slice UI Panels (Screen 4D)

**When to use it:** Either (a) AI-generated terrain textures (`stone`, `grass`, `lava`, `sci-fi grating`) show hard repeating grid lines, or (b) game UI buttons, health-bar frames, and dialog boxes need stretched middle interiors with crisp, un-stretched corner bevels.

#### Workflow A — Seamless Tile Healing (`Seamless Tile (50% Wrap)`)

**Click-by-Click:**

1. Open the **`Tile & 9-Slice`** tab and select **`Seamless Tile (50% Wrap)`**.
2. Enable **High-Pass Macro-Lighting Flatten** if one side of the texture is brighter than the other, set **Seam Mask Width (px)** and **Edge Jitter**, then click **`1. Wrap 50% & Auto-Mask for Inpaint`** to shift the image toroidally (`+⌊W/2⌋, +⌊H/2⌋`) and lock the outer corners while masking the center cross seam.
3. Click **`2. Run Seam Inpaint`** using your active provider to heal only the masked center cross.
4. Click **`3. Un-Wrap Result & Commit Node`** and inspect the live **`2×2` / `3×3` / `4×4`** tiled preview grid and **Edge Continuity Score**.

#### Workflow B — 9-Slice UI Panel Slicing (`9-Slice UI Panel`)

**Click-by-Click:**

1. Switch the mode pill at top-left to **`9-Slice UI Panel`**.
2. Click **`Auto-Detect Margins`** (or drag the cyan `L/R` and magenta `T/B` guide lines directly on the canvas with `1 px` snap; check **Lock L = R** and **Lock T = B** for symmetric frames).
3. Choose **Edge Mode** and **Center Mode** (`Stretch`, `Tile Repeat`, or `Transparent` center).
4. Inspect corner crispness across the **Live Stress-Test Matrix** (**Wide Button `240×48`**, **Tall Sidebar `72×220`**, **Square Dialog `180×180`**, and drag the bottom-right cyan handle on **Resizable `160×96`**), optionally binding an **Audio Foundry** clip to **UI Click SFX (Matrix Test)** and clicking panels to audition sound.
5. Click **`Export 9-Slice ZIP (.tres + JSON)`**.

**What gets exported:** Clean source PNG + Godot 4 `StyleBoxTexture` (`_stylebox.tres`), Phaser 3 `_nineslice_phaser.json`, PixiJS v8 `_nineslice_pixi.json`, and `asset.recipe.json`.

![Screen 4D — Visual 9-Slice UI Panel Workshop](docs/demo/09-seamless-tile-and-9slice.png)

---

### 2.4 Create 8-Bit Indexed Palette-Swap & Multi-Faction GPU LUTs (Screen 4E)

**When to use it:** You need Red vs. Blue team units, elemental slimes, poison/frozen status skins, or rarity tiers without multiplying VRAM texture memory or re-generating sprites.

**Click-by-Click:**

1. Open the **`Palette-Swap & LUT`** tab in **Post-Process & Export Inspector**.
2. If your source image contains more than `256` unique colors, click the **`Quantize to 32 Colors`** banner button so Nibgrid packs an exact `R=G=B=index` index texture.
3. Click **`+ Add Variant`** (or a 1-click faction pill like **`+Faction Red`**, **`+Toxic Slime`**, **`+Frozen`**, **`+Shadow Cursed`**, **`+Golden Rare`**).
4. Select any clustered **OKLCH Ramp** on the left (e.g., `Neutrals / Outlines`, `Ramp 1`, `Ramp 2`) and adjust **`Hue Shift`**, **`Chroma Scale`**, **`Lightness Shift`**, and **`Temp Contrast`** while watching **Base (Row 0)**, **Variant 1**, **Variant 2**, and the **Live `N×M` LUT Texture Strip** update together.
5. Choose **Stacked `N×M` Sheet** (all variants in one texture) or **Single `N×1` per Var**, then click **`Download LUT Bundle (.zip)`**.

**What gets exported:** Linear index map (`_idx.png`), nearest-filtered palette LUT strip (`_lut.png`), Godot 4 canvas-item shader (`_lut.gdshader` with built-in damage flash uniforms), and PixiJS v8 `Filter` TypeScript helper (`_lut_pixi.ts`).

![Screen 4E — Indexed Palette-Swap & Stacked LUT Workshop](docs/demo/10-palette-lut-workshop.png)

---

### 2.5 Audition Readability, Biomes & Hit-Flash at 1× Scale (Screen 4F)

**When to use it:** Sprites look crisp zoomed to `400%` on a neutral checkerboard, then vanish against dark dungeon bricks or snowy terrain in-game. Screen 4F tests true pixel scale, silhouette readability, animation motion, hitstop juice, and synchronized SFX in one place.

**Click-by-Click:**

1. Open **`Game Sandbox`** in **Post-Process & Export Inspector** (or click the **1× Preview** pill in **Sprite Studio**).
2. Click terrain **Biome Pills** along the top toolbar (**`Dark Dungeon`**, **`Urban Asphalt`**, **`Sunlit Meadow`**, **`Neutral Checker`**, **`Bright Snow`**) and read the live **Perimeter Contrast** WCAG-style HUD (`Strong` / `Moderate` / `Weak` ratio and edge separation `%`).
3. Toggle **`1×` / `2×` / `3×` / `4×`** integer scale, virtual camera resolution (`320×180 (GBA / Pixel Indie)` etc.), and diagnostic lenses (**`Normal`**, **`Value Check`** luminance grayscale, **`Silhouette`**).
4. Test combat feel by switching **`Flash White`** / **`Flash Red`** and pressing **`H`** or clicking **`Trigger Hit (H)`** (`40ms` hitstop + `110ms` hit-flash), **`F`** to flip horizontally, and **`WASD` / Arrow keys** to move.
5. In the bottom **Audio Juice** bar, switch **M12 LUT** variants or bind saved **Audio Foundry** clips to **Hit SFX (H)**, **Step / Frame SFX**, and **BGM Loop**.

![Screen 4F — 1x Game Scale Sandbox & Biome Contrast Telemetry](docs/demo/11-game-scale-sandbox.png)

---

### 2.6 Auto-Trace 2D Collision Hulls & Author Hitboxes/Hurtboxes (Screen 4G)

**When to use it:** Manually clicking physics polygon points around every character, chest, projectile, and swing arc inside Godot or Matter.js slows iteration. Nibgrid derives pivot-anchored collision hulls straight from your alpha channel.

**Click-by-Click:**

1. Open the **`Collider & Hitbox`** tab in **Post-Process & Export Inspector**.
2. Click **`8-Vertex Box2D Safe Preset`** (or choose **Primitive / Simplifier Mode** → `Convex Hull (Box2D / Godot Safe)`, `Exact Contour Polygon (RDP)`, `Tight AABB Rectangle`, or `Character Capsule (2D)` and click **`Auto-Trace Silhouette`**).
3. Click **`+ Hurtbox`** or **`+ Hitbox`** under **Semantic Physics Layers** to add damage/sensor boxes colored independently on the interactive SVG stage.
4. Drag vertices on the canvas (with `0.5 px` or `1 px` **Vertex Grid Snap**), click any white edge midpoint handle to insert a vertex, or right-click / press `Delete` to remove a vertex.
5. If your sprite has an M9 **Puppet Warp** loop, use the bottom **M9 Frames (`F0`..`F5`)** bar to activate/deactivate hitboxes strictly on active attack frames.
6. Toggle **`Godot 4 .tres`** or **`Matter.js / Phaser`** in the right **Engine Physics Preview** pane (or click **Copy**) and click **Download ZIP** to bundle `<slug>_collider.tres` and `<slug>_matter.json`.

![Screen 4G — 2D Collision Hull, Hitbox & Hurtbox Editor](docs/demo/12-collider-hitbox-editor.png)

---

### 2.7 Pack Multi-Engine Texture & Animation Atlases (Screen 5)

**When to use it:** Shipping a folder of individual sprite PNGs hurts draw calls and breaks frame timing. Screen 5 bin-packs your whole project—plus multi-frame Puppet-Warp loops—into power-of-two atlases with frame deduplication and lockstep normal maps.

**Click-by-Click:**

1. Click **`Atlas Packer`** in the top navigation bar.
2. In the left **Sprites & Loops** list, check/uncheck nodes to include, and click **`+ Add 6f Puppet Loop`** on any rigged character to pack all animation frames automatically.
3. Under **Target Game Engines** on the right, check **`Godot 4 (.tres SpriteFrames + AtlasTexture)`**, **`Phaser 3 (Multiatlas JSON)`**, and **`PixiJS v8 (JSON Hash + Animations)`**.
4. Configure **Max Atlas Page Size** (`512×512`–`4096×4096`), **Padding (px)**, **Extrude (px)** (prevents subpixel border bleeding), **Shrink to Power-of-Two (PoT)**, and optionally **Bundle Lockstep `_n.png` Normal Atlas**.
5. Inspect page occupancy (`1024×128 · 43.6% packed · 6 deduped`) and toggle **UV Bounds** or **Albedo / Normal** channel tabs, then click **`Download Atlas ZIP`**.

**What gets exported:** `atlas_0.png` (and optional `atlas_0_n.png`), `atlas_frames.tres` (Godot `SpriteFrames` with `texture_filter = 1` for pixel art), `atlas.json` (Phaser 3 Multiatlas), `atlas_pixi.json` (PixiJS v8 Hash + `animations`), and `atlas_physics.json` (combined Matter/Phaser colliders when authored).

![Screen 5 — MaxRects Atlas Packer & Multi-Engine Exporter](docs/demo/13-maxrects-atlas-packer.png)

---

### 2.8 Synthesize Procedural Foley & Google AI Game Audio (Screen 6)

**When to use it:** A game asset feels half-finished without click SFX, saber swings, footstep variations, character voice barks, or biome music loops normalized to consistent loudness.

**Click-by-Click:**

1. Click **`Audio Foundry`** in the top navigation bar and stay on the **`Presets & Google`** tab.
2. Filter presets (`ALL`, `SFX`, `UI`, `VOICE`, `MUSIC`, `AMBIENCE`) and choose a generation route:
   - **`Local Procedural Synth ($0.00)`** to shape the **3-Layer Synth Patch** (`Seed`, `Body Start Hz`, `Transient Attack Gain`, `Noise Tail Gain`) in real time with zero keys, or
   - Use your single **Gemini** key from **Provider Vault** for **Gemini Sprite-to-SFX (`gemini-to-synth`)**, **Lyria 3/3.5 (`lyria-clip` / `lyria-full`)**, or **Gemini 3.8 TTS (`gemini-tts`)**.
3. Click **`Render Local Synth ($0.00)`** / **Generate Audio** and preview playback (`Play`, `Stop`, `Loop`, **`A/B: Processed DSP`**) across the waveform and loudness badges (`In LUFS`, `Out LUFS`, `Peak dBFS`).
4. On the right **PCM Post-Processor** pane, toggle **Auto-Trim Leading/Trailing Silence**, **LUFS Loudness Normalize (-1 dBFS)** (`-14 LUFS (SFX / Impacts)` / `-16 LUFS (UI)` / `-18 LUFS (Ambience / Music)`), and **Seamless Loop Crossfade** for looping ambience/BGM.
5. Select **`1×`**, **`4×`**, or **`6×`** under **Anti-Repetition Variations** (preview variation pills `#1`–`#4` to confirm natural micro-pitch/filter spread), enter a **Clip Name**, and click **`Save to Project (4 WAV)`** (so Screen 4F Sandbox and Screen 4D 9-Slice can bind it immediately) or **`Audio ZIP`** / **`Folder`**.

![Screen 6 — Google-First Client-Side Audio Foundry](docs/demo/14-audio-foundry-synth.png)

---

### 2.9 Turn Microphone Hums or WAV Sketches into Game Audio (Screen 6 · Mic Sketch)

**When to use it:** Typing "pew-woosh-chime" rarely captures the exact rhythmic timing, pitch curve, or attack envelope in your head. Hum the melody or make a mouth foley sound once and let deterministic vocal contour extraction drive synthesis or Google AI models.

**Click-by-Click:**

1. In **Audio Foundry**, switch to the **`Mic Sketch`** tab.
2. Hold **`R`** (or press **`Hold R / Press to Record Hum (10s cap)`**) to record directly from your microphone, or click **`Upload .wav Vocal Sketch`** to drop an existing `.wav` recording.
3. Inspect the **`VOCAL PITCH & FOLEY RIBBON`** canvas: cyan `f0(t)` pitch tracking, white RMS loudness bars, amber unvoiced breath/noise regions (`"shhh"/"ksh"`), plus detected `BPM` and dominant musical key.
4. Click any of the 6 **Quick Intent Presets**:
   - **$0.00 Local Contour Synth:** **`Laser / Pew ($0)`**, **`Engine Rev ($0)`**, **`Heavy Impact ($0)`**, **`Chiptune Hum ($0)`**
   - **Single-Key Multimodal Routing:** Choose `Local Contour Synth ($0.00)`, `Gemini Audio → Timbre Patch (~$0.001)`, `Hum → Lyria 3 Full Clip (~$0.04)`, or `Vocal Cadence → Gemini TTS (~$0.005)`, then dial **Octave Shift**, **Pitch Smooth (ms)**, **Scale Quantize**, **FM Depth**, **Unvoiced Noise Gain**, and **Bit Depth**.
5. Toggle **`A/B: Transformed Sound`** vs raw recording, select **`1×` / `4×` / `6×`** variations, and click **`Save to Project`** or **`Audio ZIP`** (exporting complete `audioSketch` BPM/key/patch provenance inside `.audio.recipe.json`).

![Screen 6 · Mic Sketch — Hum-to-Sound Audio Sketching](docs/demo/15-hum-to-sound-mic-sketch.png)

---

### 2.10 Audit Project Compliance & Run 1-Click $0.00 Batch Fixes (Screen 7)

**When to use it:** Mid-production you tweak your Art Bible palette, switch target level biomes, or notice older sprites lack collision hulls and audio clips clip (`-2.3 LUFS`). Screen 7 scans every asset in IndexedDB and brings the project back to green in one atomic batch at `$0.00` AI cost.

**Click-by-Click:**

1. Click **`Audit`** in the top navigation bar to open **Project-Wide Audit Matrix**.
2. Inspect the **`0–100` Readiness Score**, filter pills (**`ALL`**, **`FAILING`**, **`WARNINGS+FAILS`**, **`STALE`**, **`SPRITES`**, **`AUDIO`**), and switch **`Target Biome`** (`Dark Dungeon`, `Bright Snow`, etc.) to test `1× Contrast` across every sprite simultaneously.
3. Click any failing cell pill (e.g., `Missing` collider or `88.7% drift` palette) to jump straight into the exact inspector tab for that asset, **or** click **`Fix All Stale & Failing`** at top right.
4. In the right **Batch Recipe Runner** drawer, verify which deterministic operations are checked (**Sync Art Bible Palette**, **Re-run Pixel Foundry**, **Auto-Trace Missing Colliders**, **Re-bake Palette LUTs**, **Normalize Audio LUFS**), choose **Update In-Place** or **Fork Child Nodes**, and inspect the live **Dry-Run Batch Plan** (`$0.00 local compute`).
5. Click **`Run Batch`** to execute sequentially inside atomic Dexie transactions (with mid-run **Cancel** support and an immediate **`Undo Batch`** button to revert the entire session cleanly).

![Screen 7 — Project-Wide Asset Audit Matrix & Batch Recipe Runner](docs/demo/16-audit-matrix-and-batch-runner.png)

---

### 2.11 Pair the Local Antigravity Loopback Bridge (127.0.0.1:4188)

**When to use it:** You want the hosted GitHub Pages PWA (`https://franekjemiolo.github.io/nibgrid/`) to invoke your local Antigravity IDE models with stateful `interaction_id` chaining and automated Art Bible critique—without exposing keys or running a cloud backend.

**Click-by-Click:**

1. Start the loopback bridge locally from the repository root:
   ```bash
   uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py
   # Or offline smoke test mode:
   uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py --mock
   ```
2. Copy the ephemeral `nbg_...` bearer token printed in your terminal.
3. In Nibgrid's top header, click **`Provider Vault`**, choose **Adapter Type** → **`Antigravity Loopback Bridge (127.0.0.1:4188)`**, paste the `nbg_...` token into **Ephemeral Session Token**, and click **Save Provider**.
4. Select the saved bridge provider in **Sprite Studio** to unlock automatic **Art Bible Critique (`score/100` + `Apply Suggested Delta`)** and stateful `interaction_id` child chaining.

---

## Part 3 — Engine Drop-In Integration Examples

### Godot 4 (`4.2+`)

Nibgrid exports Godot-native `.tres` resources (`AtlasTexture` / `SpriteFrames`, `StyleBoxTexture`, `ConvexPolygonShape2D` / `CapsuleShape2D`) and `canvas_item` `.gdshader` files with nearest filtering baked in:

1. **Animated SpriteFrames & Physics Shape (`Atlas Packer` / `Collider` exports):**
   - Drop `atlas_0.png`, `atlas_0_n.png`, `atlas_frames.tres`, and `<slug>_collider.tres` into `res://assets/`.
   - Assign `atlas_frames.tres` directly to an `AnimatedSprite2D.sprite_frames` slot, and assign `<slug>_collider.tres` to your `CollisionShape2D.shape`.
2. **Normal-Mapped Sprite via `CanvasTexture`:**
   - Assign `sprite.png` to `CanvasTexture.diffuse_texture`, `sprite_n.png` to `CanvasTexture.normal_texture`, and set `texture_filter = TEXTURE_FILTER_NEAREST` on the `Sprite2D` node.
3. **Runtime Palette-Swap Shader (`<slug>_lut.gdshader`):**
   ```gdscript
   # Attach exported <slug>_lut.gdshader to Sprite2D Material -> ShaderMaterial
   # Texture = <slug>_idx.png (Filter: Nearest), lut_tex = <slug>_lut.png
   @onready var mat := $Sprite2D.material as ShaderMaterial

   func set_faction(variant_idx: int) -> void:
       mat.set_shader_parameter("variant_index", variant_idx)

   func trigger_hit_flash() -> void:
       mat.set_shader_parameter("flash_amount", 1.0)
       create_tween().tween_property(mat, "shader_parameter/flash_amount", 0.0, 0.11)
   ```
4. **9-Slice UI Panel (`<slug>_stylebox.tres`):**
   - Drop `<slug>.png` and `<slug>_stylebox.tres` into the same `res://ui/` folder and assign `<slug>_stylebox.tres` directly to `PanelContainer` or `Button` → `Theme Overrides` → `Styles` → `Panel` / `Normal`.

### Phaser 3 (`3.60+`) + Matter.js

```ts
// 1. Preload packed Multiatlas + combined Matter PhysicsEditor JSON from Atlas Packer ZIP
this.load.multiatlas('hero_atlas', 'assets/atlas.json', 'assets');
this.load.json('hero_physics', 'assets/atlas_physics.json');

// 2. Spawn physics-backed sprite in Scene.create() using exact bottom-center pivot alignment
const shapes = this.cache.json.get('hero_physics');
const hero = this.matter.add.sprite(240, 180, 'hero_atlas', 'cat_warrior_0', {
  shape: shapes.cat_warrior,
});
```

### PixiJS v8

```ts
import { Assets, AnimatedSprite, NineSliceSprite } from 'pixi.js';
import { createPaletteSwapFilter } from './cat_warrior_lut_pixi';

// 1. Load packed PixiJS v8 JSON Hash atlas + animations
const sheet = await Assets.load('assets/atlas_pixi.json');
const runner = new AnimatedSprite(sheet.animations.idle_breathe);
runner.animationSpeed = 8 / 60;
runner.play();

// 2. Apply exported GPU Palette-Swap LUT filter (enforces Nearest filtering automatically)
const lutTex = await Assets.load('assets/cat_warrior_lut.png');
runner.filters = [createPaletteSwapFilter(lutTex, 1)]; // switch to Variant row 1

// 3. Responsive 9-Slice UI frame from <slug>_nineslice_pixi.json margins
const sliceMeta = await (await fetch('assets/panel_nineslice_pixi.json')).json();
const panel = new NineSliceSprite({
  texture: await Assets.load('assets/panel.png'),
  leftWidth: sliceMeta.leftWidth,
  topHeight: sliceMeta.topHeight,
  rightWidth: sliceMeta.rightWidth,
  bottomHeight: sliceMeta.bottomHeight,
  width: 320,
  height: 120,
});
```

---

## Architecture Summary

- **100% Client-Side & Zero-Cost Static PWA:** Runs entirely in the browser with no backend server, deployable cleanly to GitHub Pages under a configurable base path (`VITE_BASE_PATH=/nibgrid/`).
- **Art Bible Style Lock & Branching DAG Studio:** Persists projects, color palettes (`.gpl` / `.hex`), Golden Style References, sketch/inpaint masks, and non-destructive sprite lineage DAG nodes in local IndexedDB (`Dexie.js`) validated by `Zod`.
- **Google Antigravity IDE / Agent Integration & Loopback Bridge:** Select **Google Antigravity IDE / Agent Handoff** (`antigravity-agent`) for Markdown briefs and PNG DAG import, or pair the GitHub Pages PWA with the local **Antigravity Loopback Bridge** (`127.0.0.1:4188`, `antigravity-bridge`, [.agents/skills/nibgrid/SKILL.md](.agents/skills/nibgrid/SKILL.md), `uv run .agents/skills/nibgrid/scripts/nibgrid_bridge.py`) supporting stateful `interaction_id` chaining and Art Bible critique feedback.
- **Worker-Isolated Image Processing & Pixel-Art Foundry:** Sketch normalization, Chroma-Key cutout, De-Mixel grid detection & integer snapping (`demixel.ts`), 4-connected orphan-pixel & pepper despeckling (`orphanCleaner.ts`), OKLab light-aware `outer`/`inner` Sel-Out outlining (`selOut.ts`), OKLab palette quantization + 4×4 Bayer dithering, and `asset.recipe.json` + `.zip` packaging execute purely on-device.
- **WebGL2 2D Normal Maps & MLS Puppet-Warp Animator (Screens 4B & 4C):** Bake Godot/OpenGL (`+Y`) or DirectX (`-Y`) `_n.png` normal maps using exact Felzenszwalb–Huttenlocher EDT bevels with live cursor Blinn-Phong point lighting (`NormalMapPreview.tsx`), and rig control pins with Rigid/Similarity Moving Least Squares deformation (`mlsWarp.ts`, `PuppetWarpEditor.tsx`) to bake seamless idle, sway, recoil, and squash strips.
- **Seamless Tile, 9-Slice UI Panel & Palette-Swap LUT Workshops (Screens 4D & 4E):** Heal tiling textures via toroidal 50% wrap-offset, wavy center cross-seam auto-masking, and DAG inpainting with `gl.REPEAT` toroidal normal maps (`seamlessTile.ts`); slice UI frames with pixel-exact corners, auto-detected margins, live stress-test previews, and Godot `StyleBoxTexture` `.tres` / Phaser 3 / PixiJS v8 exports (`nineSlice.ts`, `nineSliceExporters.ts`); and pack lossless 8-bit indexed sprites with OKLCH palette-swap 1D/stacked LUTs + `.gdshader` / PixiJS v8 filters (`paletteLut.ts`, `lutShaders.ts`).
- **1× Game Scale Sandbox (Screen 4F):** Audition sprites, M9 Puppet-Warp loops, and M12 Palette-Swap LUT variants at exact integer `1×`–`4×` game scale over scrolling procedural biomes (`sandboxBiomes.ts`) with pure Canvas2D zero-allocation rendering (`sandboxEngine.ts`), live Rec.709 perimeter contrast telemetry (`sandboxContrast.ts`), `Normal` / `Value Check` / `Silhouette` lenses, and `40ms` hitstop + `110ms` hit-flash combat juice.
- **2D Collision Hulls, Hitbox/Hurtbox Editor & Physics Exporters (Screen 4G):** Trace sprite alpha channels via zero-padded integer half-pixel Marching Squares (`collisionHull.ts`) with closed-loop Ramer-Douglas-Peucker simplification, Andrew's Monotone Chain convex hulls, 8-vertex Box2D caps, and tight capsules anchored to exact `pivotPx`; edit semantic **Collider** / **Hurtbox** / **Hitbox** polygons interactively across M9 animation frames (`ColliderEditor.tsx`); and bundle Godot 4 `.tres` (`ConvexPolygonShape2D` / `CapsuleShape2D`), Phaser 3 / Matter.js PhysicsEditor JSON (`colliderExporters.ts`), and combined `atlas_physics.json` into sprite and atlas ZIP exports.
- **Google-First Client-Side Audio Foundry & Hum-to-Sound (Screen 6):** Synthesize deterministic 3-layer procedural foley (`proceduralSynth.ts`), record up to `10s` of raw mic hums via inline `Blob`-URL `AudioWorklet` (`micRecorder.ts`, `vocalAnalyzer.ts`, `contourSynth.ts`), or orchestrate Lyria 3/3.5 (`lyria-clip`/`lyria-full`), Gemini 3.8 TTS (`gemini-tts`), Gemini Sprite-to-SFX (`gemini-to-synth`), and Hum-to-Timbre/Lyria/TTS (`humToSoundProvider.ts`) via Provider Vault's single Gemini key; run Worker-isolated silence trim, LUFS normalization, seamless loop crossfade, and 1/4/6 variation batching; export WAV16 + `.audio.recipe.json` ZIPs; and bind clips into Screen 4F Sandbox and Screen 4D 9-Slice panels.
- **Animated GIF89a, Horizontal Spritesheet & Multi-Engine Atlas Packer (Screen 5):** Sequence DAG sprites into transparent GIF89a animations (`gif.ts`), or pack sprites and Puppet-Warp loops via BSSF MaxRects (`maxRects.ts`, `AtlasWorkshop.tsx`) with frame deduplication, edge extrusion, lockstep `_n.png` normal atlases, and native Godot 4 `.tres`, Phaser 3 Multiatlas JSON, and PixiJS v8 exports.
- **Project-Wide Asset Audit Matrix & 1-Click Deterministic Batch Recipe Runner (Screen 7):** Audit every sprite and audio asset in IndexedDB (`projectAudit.ts`, `AuditMatrixView.tsx`) against Art Bible palette lock, 1× mixel density, dynamic target-biome contrast, M16 collider coverage, M14 category LUFS loudness + leading silence, and `recipeArtBibleHash` freshness; compute a `0–100` Readiness Score; and run `$0.00 local compute` deterministic batch fixes (`batchRunner.ts`, `BatchRunnerDrawer.tsx`) with dry-run previews, atomic Dexie transactions, mid-run cancellation, and 1-click session rollback + orphan blob garbage collection.

---

## Development & Verification

```bash
npm install
npm run dev
```

```bash
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm run test:e2e
python3 -m unittest tests/unit/test_nibgrid_bridge.py -v
npm run build
VITE_BASE_PATH=/nibgrid/ npm run build
```

## Browser Compatibility & Runtime Notes

- **Local Folder Export (File System Access API):** One-click folder export (`Export to Local Folder` writing `<slug>.png` and `<slug>.recipe.json`) uses `window.showDirectoryPicker`, which is natively supported in Chromium browsers (Chrome, Edge, Brave). Browsers without File System Access API support (Firefox, Safari) automatically hide/fallback to deterministic client-side `.zip` bundle download via `Download ZIP`.
- **Local AI Background Cutout (`@huggingface/transformers`):** Runs asynchronously inside a Dedicated Web Worker (`src/workers/postprocess.worker.ts`), preferring WebGPU when available and automatically falling back to single-threaded WebAssembly (`env.backends.onnx.wasm.numThreads = 1`). No `Cross-Origin-Embedder-Policy: require-corp` header is emitted, ensuring direct browser BYOK `fetch()` calls to Gemini API and local ComfyUI servers are never blocked.
- **Zero-Server Credential Isolation:** API keys saved in Provider Vault remain exclusively inside browser-local IndexedDB, are automatically redacted from error banners/diagnostics, and are never serialized into `asset.recipe.json` exports.

See [docs/VISION.md](docs/VISION.md), [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), and [JOURNAL.md](JOURNAL.md) for product thesis, architecture contracts, and milestone engineering logs.
