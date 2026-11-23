# Nibgrid Vision

## Product Thesis

2D indie game developers often sketch character concepts, props, and tiles on paper or quick digital pads, yet struggle to turn those sketches into cohesive, style-consistent game sprites without paying recurring SaaS subscriptions or leaking pre-release art assets to third-party servers.

**Nibgrid** is a local-first, zero-server, Bring-Your-Own-Key / Bring-Your-Own-Model (BYOK/BYOM) Progressive Web App that transforms raw hand-drawn sketches into style-locked 2D game sprites inside the browser.

## Core Principles

1. **Zero-Server / Zero-Cost Architecture:**
   Nibgrid runs 100% client-side as a static site (deployable directly to GitHub Pages). Projects, palette definitions, golden style references, sketch layers, masks, and sprite generation DAG trees live exclusively in the browser's IndexedDB.

2. **Bring-Your-Own-Key / Bring-Your-Own-Model (BYOK/BYOM):**
   API keys and local endpoint URLs remain in the user's local IndexedDB Provider Vault and are never transmitted to any Nibgrid server. An **Offline Mock Provider** works out-of-the-box with zero network requests by rendering deterministic procedural 2D game sprites directly from the sketch geometry, seed, and Art Bible palette.

3. **Art Bible ("Style Lock") Discipline:**
   Before generating a single pixel, each project locks down projection (`top-down`, `isometric`, `side-scroller`, `three-quarter`), lighting direction, art mode (`pixel-art` vs `hd-2d`), target dimensions, constrained color palette (`.hex` / `.gpl`), and up to 3 Golden Reference images.

4. **Non-Destructive Sketch-to-Sprite DAG:**
   Every sketch normalization, generation variant, and localized mask inpaint becomes an immutable node in a branching Directed Acyclic Graph (DAG). Artists can inspect, fork, compare side-by-side, and prune leaf branches without losing sibling iterations.

