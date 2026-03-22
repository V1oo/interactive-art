import {
  Application,
  Assets,
  Sprite,
  DisplacementFilter,
} from "https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs";
import * as THREE from "three";
import { EffectComposer } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/postprocessing/OutputPass.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/loaders/GLTFLoader.js";

/** Higher = filter scale snaps to target faster (per second, exponential). */
const FILTER_SCALE_SMOOTHING_LAMBDA = 12;

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

const FOREGROUND_LAYER_CONFIG = [
  { texturePath: "./assets/images/tree-base.png" },
  { texturePath: "./assets/images/tree-head.png" },
];

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

function layoutBottomWidth(sprite, w, h, offsetX, offsetY) {
  const tw = sprite.texture.width;
  const scale = w / tw;
  sprite.scale.set(scale);
  sprite.anchor.set(0, 1);
  sprite.position.set(offsetX, h + offsetY);
}

function collectAllTexturePaths() {
  const paths = new Set();
  for (const cfg of WATER_LAYER_CONFIG) {
    paths.add(cfg.waterTexturePath);
    paths.add(cfg.noiseTexturePath);
  }
  for (const cfg of FOREGROUND_LAYER_CONFIG) {
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

const threeRenderer = new THREE.WebGLRenderer({ antialias: true });
threeRenderer.outputColorSpace = THREE.SRGBColorSpace;
threeRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
threeRenderer.setSize(window.innerWidth, window.innerHeight);
Object.assign(threeRenderer.domElement.style, {
  position: "fixed",
  inset: "0",
  width: "100%",
  height: "100%",
  margin: "0",
  padding: "0",
  zIndex: "0",
  pointerEvents: "none",
});
document.body.appendChild(threeRenderer.domElement);

const threeScene = new THREE.Scene();
/** Fills transparent texels in layered PNGs (WebGL clear is black by default). */
threeScene.background = new THREE.Color(0x1a0d28);
/** Depth haze (bright red for visibility — tune color/density for production). */
threeScene.fog = new THREE.FogExp2(0xff3030, 0.045);

const threeCamera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / Math.max(window.innerHeight, 1),
  0.1,
  100,
);
threeCamera.position.z = 5;

const textureLoader = new THREE.TextureLoader();

const THREE_BG_PATHS = {
  far: "./assets/images/main-bg.png",
  mid: "./assets/images/mid-bg.png",
  near: "./assets/images/close-bg.png",
};

/** @type {{ mesh: THREE.Mesh; texAspect: number }[]} */
const threeBgLayers = [];

/** Demo sphere group in front of billboard layers (thin outline + core). */
let threeSphere = null;

/** Loaded GLB (cube) to the right of the sphere. */
let threeCube = null;

/** Soft particles in the upper sky (Three.js). */
let threeParticles = null;

/** Postprocessing (bloom). */
let threeComposer = null;

const THREE_SKY_PARTICLE_COUNT = 220;

/**
 * Light scale on top of contain — a bit of texture may clip at the edges
 * when the camera parallax moves; keep modest so 2000×1000 (2:1) art stays
 * mostly fully visible on 16:9.
 */
const THREE_BG_OVERSCAN_X = 1.12;
const THREE_BG_OVERSCAN_Y = 1.08;

/**
 * Fit the full texture inside the frustum at `distance` (CSS object-fit:
 * contain). Empty bands show `threeScene.background`.
 */
function planeSizeContain(camera, distance, texAspect) {
  const vFov = (camera.fov * Math.PI) / 180;
  const viewH = 2 * Math.tan(vFov / 2) * distance;
  const viewW = viewH * camera.aspect;
  const viewAspect = viewW / viewH;
  let planeW;
  let planeH;
  if (texAspect > viewAspect) {
    planeW = viewW;
    planeH = planeW / texAspect;
  } else {
    planeH = viewH;
    planeW = planeH * texAspect;
  }
  planeW *= THREE_BG_OVERSCAN_X;
  planeH *= THREE_BG_OVERSCAN_Y;
  return { planeW, planeH };
}

function createUpperSkyParticles() {
  const positions = new Float32Array(THREE_SKY_PARTICLE_COUNT * 3);
  const verticalSpeed = new Float32Array(THREE_SKY_PARTICLE_COUNT);
  for (let i = 0; i < THREE_SKY_PARTICLE_COUNT; i++) {
    const ix = i * 3;
    positions[ix] = (Math.random() - 0.5) * 10;
    positions[ix + 1] = 0.2 + Math.random() * 2.35;
    positions[ix + 2] = -1.15 + Math.random() * 1.75;
    verticalSpeed[i] = 0.1 + Math.random() * 0.16;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3),
  );
  const material = new THREE.PointsMaterial({
    color: 0xd4f2ff,
    size: 0.036,
    transparent: true,
    opacity: 0.48,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 6;
  points.frustumCulled = false;
  points.userData.verticalSpeed = verticalSpeed;
  points.userData.yLo = 0.12;
  points.userData.yHi = 2.95;
  return points;
}

function tickThreeParticles(deltaSeconds, time) {
  if (!threeParticles) return;
  const posAttr = threeParticles.geometry.getAttribute("position");
  const arr = posAttr.array;
  const vy = threeParticles.userData.verticalSpeed;
  const yLo = threeParticles.userData.yLo;
  const yHi = threeParticles.userData.yHi;
  for (let i = 0; i < THREE_SKY_PARTICLE_COUNT; i++) {
    const ix = i * 3;
    arr[ix + 1] += vy[i] * deltaSeconds;
    arr[ix] += Math.sin(time * 0.38 + i * 0.09) * 0.07 * deltaSeconds;
    if (arr[ix + 1] > yHi) {
      arr[ix + 1] = yLo + Math.random() * 0.4;
      arr[ix] = (Math.random() - 0.5) * 10;
      arr[ix + 2] = -1.1 + Math.random() * 1.7;
    }
  }
  posAttr.needsUpdate = true;
}

function updateThreeBgPlaneSizes() {
  for (const layer of threeBgLayers) {
    const z = layer.mesh.position.z;
    const distance = Math.abs(threeCamera.position.z - z);
    const { planeW, planeH } = planeSizeContain(
      threeCamera,
      distance,
      layer.texAspect,
    );
    layer.mesh.scale.set(planeW, planeH, 1);
  }
}

async function loadThreeBackgroundLayers() {
  const [texFar, texMid, texNear] = await Promise.all([
    textureLoader.loadAsync(THREE_BG_PATHS.far),
    textureLoader.loadAsync(THREE_BG_PATHS.mid),
    textureLoader.loadAsync(THREE_BG_PATHS.near),
  ]);
  for (const map of [texFar, texMid, texNear]) {
    map.colorSpace = THREE.SRGBColorSpace;
    map.wrapS = THREE.ClampToEdgeWrapping;
    map.wrapT = THREE.ClampToEdgeWrapping;
  }

  function makeLayerMaterial(map) {
    return new THREE.MeshLambertMaterial({
      map,
      flatShading: true,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
  }

  const geo = new THREE.PlaneGeometry(1, 1);
  const far = new THREE.Mesh(geo, makeLayerMaterial(texFar));
  far.position.z = -5;
  far.renderOrder = 0;

  const mid = new THREE.Mesh(geo.clone(), makeLayerMaterial(texMid));
  mid.position.z = -3;
  mid.renderOrder = 1;

  const near = new THREE.Mesh(geo.clone(), makeLayerMaterial(texNear));
  near.position.z = -1;
  near.renderOrder = 2;

  threeScene.add(far, mid, near);

  threeParticles = createUpperSkyParticles();
  threeScene.add(threeParticles);

  threeScene.add(new THREE.AmbientLight(0xffffff, 0.6));
  const mainDirLight = new THREE.DirectionalLight(0xffffff, 0.4);
  mainDirLight.position.set(2, 2, 2);
  threeScene.add(mainDirLight);

  const sphereGeometry = new THREE.SphereGeometry(0.58, 48, 32);

  const outlineMesh = new THREE.Mesh(
    sphereGeometry,
    new THREE.MeshLambertMaterial({
      color: 0x06222a,
      flatShading: true,
      side: THREE.BackSide,
    }),
  );
  outlineMesh.scale.setScalar(1.032);
  outlineMesh.renderOrder = 10;

  const sphereMaterial = new THREE.MeshLambertMaterial({
    color: 0x2f7f7f,
    flatShading: true,
  });
  const coreMesh = new THREE.Mesh(sphereGeometry, sphereMaterial);
  coreMesh.renderOrder = 10;

  threeSphere = new THREE.Group();
  threeSphere.add(outlineMesh, coreMesh);
  threeSphere.position.set(0, 0, 1.05);
  threeSphere.renderOrder = 10;
  threeScene.add(threeSphere);

  const fakeShadowMaterial = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.2,
    depthWrite: false,
  });
  function addFakeShadowUnderObject(x, z, radius, y, scaleXZ) {
    const geo = new THREE.CircleGeometry(radius, 40);
    geo.rotateX(-Math.PI / 2);
    const plane = new THREE.Mesh(geo, fakeShadowMaterial);
    plane.position.set(x, y, z);
    plane.scale.set(scaleXZ[0], 1, scaleXZ[1]);
    plane.renderOrder = 8;
    threeScene.add(plane);
    return plane;
  }
  addFakeShadowUnderObject(0, 1.05, 0.38, -0.66, [1.28, 0.5]);

  const gltf = await new GLTFLoader().loadAsync("./assets/models/cube.glb");
  const cubeRoot = gltf.scene;
  cubeRoot.traverse((o) => {
    if (o.isMesh) {
      o.renderOrder = 10;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const next = mats.map((mat) => {
        return new THREE.MeshLambertMaterial({
          map: mat.map ?? null,
          flatShading: true,
          color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
          transparent: mat.transparent === true,
          opacity: mat.opacity ?? 1,
        });
      });
      o.material = next.length === 1 ? next[0] : next;
    }
  });
  const cubeBox = new THREE.Box3().setFromObject(cubeRoot);
  const cubeCenter = new THREE.Vector3();
  const cubeSize = new THREE.Vector3();
  cubeBox.getCenter(cubeCenter);
  cubeBox.getSize(cubeSize);
  cubeRoot.position.sub(cubeCenter);
  const cubeMax = Math.max(cubeSize.x, cubeSize.y, cubeSize.z, 1e-6);
  const cubePivot = new THREE.Group();
  cubePivot.scale.setScalar(0.55 / cubeMax);
  cubePivot.add(cubeRoot);
  cubePivot.position.set(0.88, 0, 1.05);
  cubePivot.renderOrder = 10;
  threeScene.add(cubePivot);
  threeCube = cubePivot;

  const cubeBounds = new THREE.Box3().setFromObject(cubePivot);
  addFakeShadowUnderObject(
    cubePivot.position.x,
    cubePivot.position.z,
    0.3,
    cubeBounds.min.y - 0.04,
    [1.15, 0.46],
  );

  threeBgLayers.push(
    { mesh: far, texAspect: texFar.image.width / texFar.image.height },
    { mesh: mid, texAspect: texMid.image.width / texMid.image.height },
    { mesh: near, texAspect: texNear.image.width / texNear.image.height },
  );
  updateThreeBgPlaneSizes();
}

await loadThreeBackgroundLayers();

threeComposer = new EffectComposer(threeRenderer);
threeComposer.addPass(new RenderPass(threeScene, threeCamera));
const bloomPass = new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, Math.max(window.innerHeight, 1)),
  0.38,
  0.45,
  0.82,
);
threeComposer.addPass(bloomPass);
threeComposer.addPass(new OutputPass());

let threeMouseX = 0;
let threeMouseY = 0;

window.addEventListener("pointermove", (e) => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  if (w <= 0 || h <= 0) return;
  threeMouseX = (e.clientX / w) * 2 - 1;
  threeMouseY = (e.clientY / h) * 2 - 1;
});

function resizeThree() {
  const w = window.innerWidth;
  const h = Math.max(window.innerHeight, 1);
  threeRenderer.setSize(w, h);
  threeCamera.aspect = w / h;
  threeCamera.updateProjectionMatrix();
  updateThreeBgPlaneSizes();
  if (threeComposer) {
    threeComposer.setSize(w, h);
    threeComposer.setPixelRatio(threeRenderer.getPixelRatio());
  }
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
await app.init({
  resizeTo: window,
  backgroundAlpha: 0,
});
Object.assign(app.canvas.style, {
  position: "fixed",
  inset: "0",
  width: "100%",
  height: "100%",
  margin: "0",
  padding: "0",
  zIndex: "1",
});
document.body.appendChild(app.canvas);

const texturesByPath = await loadTexturesByPath(collectAllTexturePaths());

function makeSpriteStack(configs) {
  const stack = [];
  for (const cfg of configs) {
    const sprite = new Sprite(texturesByPath.get(cfg.texturePath));
    stack.push({ cfg, sprite });
    app.stage.addChild(sprite);
  }
  return stack;
}

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

const foregroundLayers = makeSpriteStack(FOREGROUND_LAYER_CONFIG);

let sceneTime = 0;

function layoutSpriteStack(stack, w, h) {
  for (const pl of stack) {
    layoutBottomWidth(pl.sprite, w, h, 0, 0);
  }
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
  updateWaterLayout(w, h);
  layoutSpriteStack(foregroundLayers, w, h);
}

updateLayout();
window.addEventListener("resize", () => {
  resizeThree();
  updateLayout();
});
resizeThree();

app.ticker.add(() => {
  const deltaTime = app.ticker.deltaTime;
  const deltaSeconds = app.ticker.deltaMS / 1000;
  sceneTime += deltaSeconds;
  const filterT = 1 - Math.exp(-FILTER_SCALE_SMOOTHING_LAMBDA * deltaSeconds);

  threeCamera.position.x += (threeMouseX - threeCamera.position.x) * 0.05;
  threeCamera.position.y += (-threeMouseY - threeCamera.position.y) * 0.05;

  if (threeSphere) {
    threeSphere.rotation.y += deltaSeconds * 0.4;
  }

  tickThreeParticles(deltaSeconds, sceneTime);

  if (threeComposer) {
    threeComposer.render(deltaSeconds);
  } else {
    threeRenderer.render(threeScene, threeCamera);
  }

  for (const pl of foregroundLayers) {
    pl.sprite.rotation = Math.sin(sceneTime) * 0.02;
  }

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
});
