import {
  Application,
  Assets,
  Sprite,
  DisplacementFilter,
} from "https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs";

const BACKGROUND_COLOR = 0x000000;

/** Cover scale margin so pointer parallax does not show empty canvas. */
const COVER_OVERSCAN = 1.08;

/** How quickly pan offsets follow the pointer (higher = snappier). */
const POINTER_PARALLAX_SMOOTHING = 10;

/** Higher = filter scale snaps to target faster (per second, exponential). */
const FILTER_SCALE_SMOOTHING_LAMBDA = 12;

/**
 * Scenery back → front. `parallaxStrength` = max horizontal offset in px at
 * pointer on canvas edge (closer layers = larger).
 */
const PARALLAX_LAYER_CONFIG = [
  {
    texturePath: "./assets/images/bg-main.png",
    layout: "cover",
    parallaxStrength: 8,
  },
  {
    texturePath: "./assets/images/bg-support.png",
    layout: "cover",
    parallaxStrength: 16,
  },
  {
    texturePath: "./assets/images/rock-lvl-3.png",
    layout: "bottomWidth",
    parallaxStrength: 28,
  },
  {
    texturePath: "./assets/images/rock-lvl-2.png",
    layout: "bottomWidth",
    parallaxStrength: 40,
  },
  {
    texturePath: "./assets/images/rock-lvl-1.png",
    layout: "bottomWidth",
    parallaxStrength: 52,
  },
];

/** Water back → front (before foreground trees). Paths relative for GitHub Pages. */
const WATER_LAYER_CONFIG = [
  {
    waterTexturePath: "./assets/images/water-main.png",
    noiseTexturePath: "./assets/images/noise.png",
    speedX: 0.95,
    speedY: 0.18,
    displacementScale: { x: 34, y: 18 },
    noiseSpriteScale: 2,
    alpha: 1,
    surfaceMotion: {
      ampX: 6,
      ampY: 3,
      freqX: 0.028,
      freqY: 0.019,
    },
  },
  {
    waterTexturePath: "./assets/images/water-mid.png",
    noiseTexturePath: "./assets/images/noise-2.png",
    speedX: 0.85,
    speedY: 0.15,
    displacementScale: { x: 45, y: 20 },
    noiseSpriteScale: 2,
    alpha: 0.85,
  },
  {
    waterTexturePath: "./assets/images/water-light.png",
    noiseTexturePath: "./assets/images/noise.png",
    speedX: 1.2,
    speedY: 0.3,
    displacementScale: { x: 55, y: 22 },
    noiseSpriteScale: 2.2,
    alpha: 0.55,
  },
];

const FOREGROUND_PARALLAX_CONFIG = [
  {
    texturePath: "./assets/images/tree-base.png",
    layout: "bottomWidth",
    parallaxStrength: 64,
  },
  {
    texturePath: "./assets/images/tree-head.png",
    layout: "bottomWidth",
    parallaxStrength: 78,
  },
];

let pointerNormX = 0;
let pointerNormY = 0;

function getDisplacementWrapPeriods(displacementSprite) {
  const texture = displacementSprite.texture;
  const sx = Math.abs(displacementSprite.scale.x);
  const sy = Math.abs(displacementSprite.scale.y);
  return {
    periodX: Math.max(texture.width * sx, 1e-6),
    periodY: Math.max(texture.height * sy, 1e-6),
  };
}

function wrapPositive(value, period) {
  if (period <= 0) return value;
  let v = value % period;
  if (v < 0) v += period;
  if (v >= period - 1e-5) return 0;
  return v;
}

function smoothToward(current, target, dt, lambda) {
  const t = 1 - Math.exp(-lambda * dt);
  return current + (target - current) * t;
}

function layoutCover(sprite, w, h, offsetX, offsetY) {
  const tw = sprite.texture.width;
  const th = sprite.texture.height;
  const scale = Math.max(w / tw, h / th) * COVER_OVERSCAN;
  sprite.scale.set(scale);
  sprite.anchor.set(0.5);
  sprite.position.set(w * 0.5 + offsetX, h * 0.5 + offsetY);
}

function layoutBottomWidth(sprite, w, h, offsetX, offsetY) {
  const tw = sprite.texture.width;
  const scale = w / tw;
  sprite.scale.set(scale);
  sprite.anchor.set(0, 1);
  sprite.position.set(offsetX, h + offsetY);
}

function collectAllTexturePaths() {
  const paths = new Set();
  for (const cfg of PARALLAX_LAYER_CONFIG) {
    paths.add(cfg.texturePath);
  }
  for (const cfg of WATER_LAYER_CONFIG) {
    paths.add(cfg.waterTexturePath);
    paths.add(cfg.noiseTexturePath);
  }
  for (const cfg of FOREGROUND_PARALLAX_CONFIG) {
    paths.add(cfg.texturePath);
  }
  return [...paths];
}

async function loadTexturesByPath(paths) {
  const map = new Map();
  await Promise.all(
    paths.map(async (path) => {
      map.set(path, await Assets.load(path));
    }),
  );
  return map;
}

function applyWaterSpritePosition(layer) {
  const { cfg, water } = layer;
  const bx = layer.waterBaseX;
  const by = layer.waterBaseY;
  const motion = cfg.surfaceMotion;
  if (motion) {
    water.position.set(
      bx + Math.sin(layer.surfacePhaseX) * motion.ampX,
      by + Math.sin(layer.surfacePhaseY) * motion.ampY,
    );
  } else {
    water.position.set(bx, by);
  }
}

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: BACKGROUND_COLOR });
document.body.appendChild(app.canvas);

function updatePointerFromEvent(clientX, clientY) {
  const r = app.canvas.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return;
  pointerNormX = ((clientX - r.left) / r.width) * 2 - 1;
  pointerNormY = ((clientY - r.top) / r.height) * 2 - 1;
}

app.canvas.addEventListener("pointermove", (e) => {
  updatePointerFromEvent(e.clientX, e.clientY);
});
app.canvas.addEventListener("pointerleave", () => {
  pointerNormX = 0;
  pointerNormY = 0;
});

const texturesByPath = await loadTexturesByPath(collectAllTexturePaths());

function makeParallaxStack(configs) {
  const stack = [];
  for (const cfg of configs) {
    const sprite = new Sprite(texturesByPath.get(cfg.texturePath));
    stack.push({
      cfg,
      sprite,
      panX: 0,
      panY: 0,
    });
    app.stage.addChild(sprite);
  }
  return stack;
}

const parallaxLayers = makeParallaxStack(PARALLAX_LAYER_CONFIG);

const waterLayers = [];
for (const cfg of WATER_LAYER_CONFIG) {
  const water = new Sprite(texturesByPath.get(cfg.waterTexturePath));
  water.anchor.set(0, 1);
  water.alpha = cfg.alpha ?? 1;

  const displacementSprite = new Sprite(texturesByPath.get(cfg.noiseTexturePath));
  displacementSprite.texture.source.wrapMode = "repeat";
  displacementSprite.scale.set(cfg.noiseSpriteScale ?? 2);
  displacementSprite.visible = false;
  displacementSprite.anchor.set(0.5);

  const displacementFilter = new DisplacementFilter(displacementSprite);
  const scale = cfg.displacementScale ?? { x: 50, y: 20 };
  displacementFilter.scale.set(scale.x, scale.y);
  water.filters = [displacementFilter];

  waterLayers.push({
    cfg,
    water,
    displacementSprite,
    displacementFilter,
    scrollOffsetX: 0,
    scrollOffsetY: 0,
    centerX: 0,
    centerY: 0,
    targetDisplacementScaleX: scale.x,
    targetDisplacementScaleY: scale.y,
    smoothedScaleX: scale.x,
    smoothedScaleY: scale.y,
    waterBaseX: 0,
    waterBaseY: 0,
    surfacePhaseX: Math.random() * Math.PI * 2,
    surfacePhaseY: Math.random() * Math.PI * 2,
  });
}

for (const layer of waterLayers) {
  app.stage.addChild(layer.water);
}
for (const layer of waterLayers) {
  app.stage.addChild(layer.displacementSprite);
}

const foregroundLayers = makeParallaxStack(FOREGROUND_PARALLAX_CONFIG);

function layoutParallaxStack(stack, w, h) {
  for (const pl of stack) {
    const { cfg, sprite, panX, panY } = pl;
    if (cfg.layout === "cover") {
      layoutCover(sprite, w, h, panX, panY);
    } else {
      layoutBottomWidth(sprite, w, h, panX, panY);
    }
  }
}

function tickParallaxStack(stack, w, h, dt) {
  for (const pl of stack) {
    const targetX = pointerNormX * pl.cfg.parallaxStrength;
    const targetY = pointerNormY * pl.cfg.parallaxStrength * 0.35;
    pl.panX = smoothToward(
      pl.panX,
      targetX,
      dt,
      POINTER_PARALLAX_SMOOTHING,
    );
    pl.panY = smoothToward(
      pl.panY,
      targetY,
      dt,
      POINTER_PARALLAX_SMOOTHING,
    );
  }
  layoutParallaxStack(stack, w, h);
}

function updateWaterLayout(screenWidth, screenHeight) {
  const cx = screenWidth / 2;
  const cy = screenHeight / 2;
  for (const layer of waterLayers) {
    const { water, displacementSprite } = layer;
    layer.centerX = cx;
    layer.centerY = cy;
    const waterScale = screenWidth / water.texture.width;
    water.scale.set(waterScale);
    layer.waterBaseX = 0;
    layer.waterBaseY = screenHeight;
    applyWaterSpritePosition(layer);

    const { periodX, periodY } = getDisplacementWrapPeriods(displacementSprite);
    displacementSprite.position.set(
      cx + wrapPositive(layer.scrollOffsetX, periodX),
      cy + wrapPositive(layer.scrollOffsetY, periodY),
    );
  }
}

function updateLayout() {
  const { width: w, height: h } = app.screen;
  layoutParallaxStack(parallaxLayers, w, h);
  updateWaterLayout(w, h);
  layoutParallaxStack(foregroundLayers, w, h);
}

updateLayout();
window.addEventListener("resize", updateLayout);

app.ticker.add(() => {
  const deltaTime = app.ticker.deltaTime;
  const deltaSeconds = app.ticker.deltaMS / 1000;
  const filterT = 1 - Math.exp(-FILTER_SCALE_SMOOTHING_LAMBDA * deltaSeconds);
  const { width: w, height: h } = app.screen;

  tickParallaxStack(parallaxLayers, w, h, deltaTime);

  for (const layer of waterLayers) {
    const { cfg, displacementSprite, displacementFilter } = layer;
    const motion = cfg.surfaceMotion;
    if (motion) {
      layer.surfacePhaseX += deltaTime * motion.freqX;
      layer.surfacePhaseY += deltaTime * motion.freqY;
    }
    applyWaterSpritePosition(layer);

    const { periodX, periodY } = getDisplacementWrapPeriods(displacementSprite);

    layer.scrollOffsetX = wrapPositive(
      layer.scrollOffsetX + cfg.speedX * deltaTime,
      periodX,
    );
    layer.scrollOffsetY = wrapPositive(
      layer.scrollOffsetY + cfg.speedY * deltaTime,
      periodY,
    );

    layer.smoothedScaleX +=
      (layer.targetDisplacementScaleX - layer.smoothedScaleX) * filterT;
    layer.smoothedScaleY +=
      (layer.targetDisplacementScaleY - layer.smoothedScaleY) * filterT;
    displacementFilter.scale.set(layer.smoothedScaleX, layer.smoothedScaleY);

    displacementSprite.position.set(
      layer.centerX + layer.scrollOffsetX,
      layer.centerY + layer.scrollOffsetY,
    );
  }

  tickParallaxStack(foregroundLayers, w, h, deltaTime);
});
