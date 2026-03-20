# Interactive art — PixiJS scene (portable plan)

Use this file as the **portable plan** for Cursor or any editor: commit it to GitHub and open the repo on another PC. Paste or reference sections in chat when starting work.

---

## What this project is

- **Visual / design project**, not a typical app.
- **PixiJS**: layered graphics, water, animation, filters.
- Build the scene **step by step**; avoid big rewrites unless asked.
- Prioritize **visual flexibility** and **readable** code over heavy abstraction.

---

## Environment

- Must work on **GitHub Pages**.
- **Always use relative asset paths** like `./assets/...` — never `/assets/...` (breaks project-site URLs).
- Entry: `index.html` loads `src/main.js` as a module.

---

## Code conventions

- Follow [.cursor/rules/javascript-staff-engineering.mdc](.cursor/rules/javascript-staff-engineering.mdc) for JS style when editing `.js` / `.mjs` (add that file to the repo if your clone does not have it).
- **Extend** existing logic; do not refactor whole files unless explicitly requested.
- Prefer **small, testable** changes.

---

## Scene architecture (direction)

- **Layers**: background, water, effects (each can animate and use displacement).
- Effects should stay **composable** (multiple filters / sprites where needed).
- Ask before **large structural** changes (new folders, big rewrites).

---

## Current focus — layered water (implemented)

**Goals:**

- Multiple water layers (textures, displacement maps, speeds).
- Config-driven in `src/main.js` via `WATER_LAYER_CONFIG` (back → front order).

**Assets (under `./assets/images/`):**

- `water_dark.png`, `water_light.png`
- `noise.png` (e.g. dark water layer), `noise_2.png` (e.g. light layer)
- `scene.png` — reserved for future background / parallax

**Behavior notes (for maintainers):**

- Scroll uses **delta time** (`ticker.deltaTime`) for consistent motion across FPS.
- **Displacement filter strength** eases toward targets with exponential smoothing.
- **Wrap scroll offsets** using **texture size × sprite scale** (`getDisplacementWrapPeriods`) so repeats align with scaled noise sprites and avoid visible jumps.
- On resize, displacement position uses stored **center** + wrapped **scroll offset**.

---

## Future work (do not implement until requested)

- Reflections
- Lighting effects
- Parallax layers
- Interactive effects (mouse, ripple)

---

## Verification checklist

- Local: serve the repo root (e.g. `npx serve`) and open `index.html`.
- GitHub Pages: deploy from branch root; confirm only relative paths (`./assets/...`, `./src/main.js` or `src/main.js`).
- After changing noise or scale, if jumps appear: check **seamless tiling** on noise images and wrap period logic.

---

## Original layered-water plan (reference)

1. Declare a **layer config** array: `waterTexturePath`, `noiseTexturePath`, `speedX`, `speedY`, `displacementScale`, `noiseSpriteScale`, `alpha`, etc.
2. **Load textures once** — dedupe paths, `Map` path → texture.
3. **Build layers in order** — water sprite (anchor bottom-left `0,1`), hidden displacement sprite (`wrapMode: repeat`, `visible: false`, anchor `0.5`), `DisplacementFilter` per layer.
4. **Layout** — scale water to screen width; place water at bottom; displacement centered (plus scroll offset).
5. **Ticker** — update scroll with delta time; smooth filter scale; wrap periods as above.

---

*Last aligned with repo state: layered water + `WATER_LAYER_CONFIG`, delta-time scroll, wrap periods, and smoothed displacement in `src/main.js`.*
