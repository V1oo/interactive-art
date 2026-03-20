import {
  Application,
  Assets,
  Sprite,
  DisplacementFilter,
} from "https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs";

/** Back-to-front: first entry is behind. Paths must stay relative for GitHub Pages. */
const WATER_LAYER_CONFIG = [
  {
    waterTexturePath: "./assets/images/dark-water.png",
    noiseTexturePath: "./assets/images/noise-2.png",
    speedX: 1,
    speedY: 0,
    displacementScale: { x: 50, y: 20 },
    noiseSpriteScale: 2,
    alpha: 0.65,
  },
  {
    waterTexturePath: "./assets/images/light-water.png",
    noiseTexturePath: "./assets/images/noise.png",
    speedX: -1.6,
    speedY: 0.55,
    displacementScale: { x: 56, y: 26 },
    noiseSpriteScale: 1.35,
    alpha: 0.9,
  },
];

const BACKGROUND_COLOR = 0x000000;

function collectUniqueAssetPaths(layerConfig) {
  const paths = new Set();
  for (const layer of layerConfig) {
    paths.add(layer.waterTexturePath);
    paths.add(layer.noiseTexturePath);
  }
  return [...paths];
}

async function loadTexturesByPath(paths) {
  const texturesByPath = new Map();
  await Promise.all(
    paths.map(async (path) => {
      texturesByPath.set(path, await Assets.load(path));
    }),
  );
  return texturesByPath;
}

function createWaterLayers(app, layerConfig, texturesByPath) {
  const layers = [];
  for (const cfg of layerConfig) {
    const waterTexture = texturesByPath.get(cfg.waterTexturePath);
    const noiseTexture = texturesByPath.get(cfg.noiseTexturePath);

    const water = new Sprite(waterTexture);
    water.anchor.set(0, 1);
    water.alpha = cfg.alpha ?? 1;
    app.stage.addChild(water);

    const displacementSprite = new Sprite(noiseTexture);
    displacementSprite.texture.source.wrapMode = "repeat";
    displacementSprite.scale.set(cfg.noiseSpriteScale ?? 2);
    displacementSprite.visible = false;
    displacementSprite.anchor.set(0.5);
    app.stage.addChild(displacementSprite);

    const displacementFilter = new DisplacementFilter(displacementSprite);
    const scale = cfg.displacementScale ?? { x: 50, y: 20 };
    displacementFilter.scale.set(scale.x, scale.y);
    water.filters = [displacementFilter];

    layers.push({
      water,
      displacementSprite,
      speedX: cfg.speedX,
      speedY: cfg.speedY ?? 0,
    });
  }
  return layers;
}

function updateWaterLayout(layers, screenWidth, screenHeight) {
  for (const layer of layers) {
    const { water, displacementSprite } = layer;
    const waterScale = screenWidth / water.texture.width;
    water.scale.set(waterScale);
    water.position.set(0, screenHeight);
    displacementSprite.position.set(screenWidth / 2, screenHeight / 2);
  }
}

if (WATER_LAYER_CONFIG.length === 0) {
  throw new Error("WATER_LAYER_CONFIG must define at least one layer");
}

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: BACKGROUND_COLOR });
document.body.appendChild(app.canvas);

const uniquePaths = collectUniqueAssetPaths(WATER_LAYER_CONFIG);
const texturesByPath = await loadTexturesByPath(uniquePaths);
const layers = createWaterLayers(app, WATER_LAYER_CONFIG, texturesByPath);

function updateLayout() {
  const { width: w, height: h } = app.screen;
  updateWaterLayout(layers, w, h);
}

updateLayout();
window.addEventListener("resize", updateLayout);

app.ticker.add(() => {
  for (const layer of layers) {
    layer.displacementSprite.x += layer.speedX;
    layer.displacementSprite.y += layer.speedY;
  }
});
