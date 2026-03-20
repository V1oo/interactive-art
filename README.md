# Interactive art (PixiJS)

Stylized animated scene built step by step with PixiJS — layered water, filters, and future effects.

## Run locally

From the repo root:

```bash
npx serve
```

Open the URL it prints and load `index.html`.

## Deploy

Configure **GitHub Pages** to serve this branch from the **root** folder. Assets use **relative** paths (`./assets/...`) so project sites work.

## Project plan (use on any PC)

See **[docs/PLAN.md](docs/PLAN.md)** for goals, constraints, current vs future work, and Cursor-friendly instructions. Commit that folder so the plan travels with the repo.

## Code

- `src/main.js` — Pixi app, water layers, displacement
- `assets/images/` — textures (water, noise, scene)
