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

/** Water back → front (Pixi over Three.js). Paths relative for GitHub Pages. */
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

function collectAllTexturePaths() {
  const paths = new Set();
  for (const cfg of WATER_LAYER_CONFIG) {
    paths.add(cfg.waterTexturePath);
    paths.add(cfg.noiseTexturePath);
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

const threeCamera = new THREE.PerspectiveCamera(
  60,
  window.innerWidth / Math.max(window.innerHeight, 1),
  0.1,
  100,
);
threeCamera.position.z = 5;

const textureLoader = new THREE.TextureLoader();

const flowerRaycaster = new THREE.Raycaster();
const flowerPointerNdc = new THREE.Vector2();

/** Back → front (still behind particles / flower / Pixi). Deeper Z = farther from camera. */
const THREE_PARALLAX_LAYERS = [
  { texturePath: "./assets/images/main-bg.png", z: -20, renderOrder: 0 },
  { texturePath: "./assets/images/bg-1.png", z: -19, renderOrder: 1 },
  { texturePath: "./assets/images/tree-lvl-1.png", z: -18, renderOrder: 2 },
  { texturePath: "./assets/images/tree-lvl-2.png", z: -17, renderOrder: 3 },
  { texturePath: "./assets/images/rock-lvl-1.png", z: -16, renderOrder: 4 },
];

/** @type {{ mesh: THREE.Mesh; texAspect: number }[]} */
const threeBgLayers = [];

/** Soft particles in the upper sky (Three.js). */
let threeParticles = null;

/** GLB flower pivot; `userData.breathTarget` = upper pivot for breathing. */
let threeFlower = null;

/** GLB prop to the right, in front of parallax trees (see `GUBE_*`). */
let threeGube = null;

/** Postprocessing (bloom). */
let threeComposer = null;

const THREE_SKY_PARTICLE_COUNT = 220;

/** Y-spin when toggled by click (rad/s). */
const FLOWER_SPIN_SPEED = 0.35;

/** World Y offset of the flower (lower = further down on screen). */
const FLOWER_PIVOT_Y = -1.35;

/** `gube.glb` — прижат к правому краю кадра (см. `updateGubeToViewportRightEdge`). */
const GUBE_MODEL_PATH = "./assets/models/gube.glb";
/** Мировая Z плоскости, где стоит куб (как у фона со скалами). */
const GUBE_PLANE_Z = -9.35;
/**
 * Точка на экране для пересечения луча: почти правый край (-1…1), чуть ниже центра.
 * x ближе к 1 — ближе к самому краю кадра.
 */
const GUBE_NDC = { x: 0.998, y: -0.82 };
/** Доп. поворот пивота (радианы); y = π — ещё 180° вокруг вертикали. */
const GUBE_ROTATION = { x: 0, y: Math.PI, z: 0 };
/** Целевая высота в мире после нормализации по bounding box. */
const GUBE_TARGET_HEIGHT = 1.15;

/** Invisible hit sphere radius multiplier vs bounding sphere of the flower. */
const FLOWER_HIT_RADIUS_MULT = 1.75;

/** Stem = lower part by height; upper part gets breathing (mesh center Y). */
const FLOWER_STEM_SPLIT = 0.36;

/** Subtle motion on upper part only; pivot at stem/top junction. */
const FLOWER_BREATH = {
  scaleAmp: 0.02,
  offsetY: 0.006,
  offsetX: 0.008,
  offsetZ: 0.005,
  leanX: 0.045,
  leanZ: 0.03,
  freqBreath: 1.55,
  freqSway: 1.05,
};

/**
 * Extra scale so camera parallax does not show empty frustum at plane edges.
 */
const THREE_BG_OVERSCAN_X = 1.12;
const THREE_BG_OVERSCAN_Y = 1.08;

/**
 * Fill the view at `distance` (CSS object-fit: cover) — fullscreen background
 * for 16:9 art; may crop top/bottom or sides.
 */
function planeSizeCover(camera, distance, texAspect) {
  const vFov = (camera.fov * Math.PI) / 180;
  const viewH = 2 * Math.tan(vFov / 2) * distance;
  const viewW = viewH * camera.aspect;
  const viewAspect = viewW / viewH;
  let planeW;
  let planeH;
  if (texAspect > viewAspect) {
    planeH = viewH;
    planeW = planeH * texAspect;
  } else {
    planeW = viewW;
    planeH = planeW / texAspect;
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
    const { planeW, planeH } = planeSizeCover(
      threeCamera,
      distance,
      layer.texAspect,
    );
    layer.mesh.scale.set(planeW, planeH, 1);
  }
}

const _gubeUnprojectVec = new THREE.Vector3();

/** Ставит пивот куба на пересечении луча (правый край экрана) с плоскостью z = GUBE_PLANE_Z. */
function updateGubeToViewportRightEdge() {
  if (!threeGube) return;
  const planeZ = GUBE_PLANE_Z;
  _gubeUnprojectVec.set(GUBE_NDC.x, GUBE_NDC.y, 0.5);
  _gubeUnprojectVec.unproject(threeCamera);
  const o = threeCamera.position;
  const dx = _gubeUnprojectVec.x - o.x;
  const dy = _gubeUnprojectVec.y - o.y;
  const dz = _gubeUnprojectVec.z - o.z;
  if (Math.abs(dz) < 1e-6) return;
  const t = (planeZ - o.z) / dz;
  if (t <= 0) return;
  threeGube.position.set(o.x + dx * t, o.y + dy * t, planeZ);
}

async function loadThreeBackgroundLayers() {
  const textures = await Promise.all(
    THREE_PARALLAX_LAYERS.map((cfg) =>
      textureLoader.loadAsync(cfg.texturePath),
    ),
  );
  for (const tex of textures) {
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
  }

  function makeLayerMaterial(map) {
    return new THREE.MeshBasicMaterial({
      map,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      toneMapped: false,
    });
  }

  const geo = new THREE.PlaneGeometry(1, 1);
  for (let i = 0; i < THREE_PARALLAX_LAYERS.length; i++) {
    const cfg = THREE_PARALLAX_LAYERS[i];
    const map = textures[i];
    const mesh = new THREE.Mesh(geo, makeLayerMaterial(map));
    mesh.position.z = cfg.z;
    mesh.renderOrder = cfg.renderOrder;
    threeScene.add(mesh);
    threeBgLayers.push({
      mesh,
      texAspect: map.image.width / map.image.height,
    });
  }

  threeParticles = createUpperSkyParticles();
  threeScene.add(threeParticles);

  const flowerGltf = await new GLTFLoader().loadAsync("./assets/models/flower.glb");
  const flowerRoot = flowerGltf.scene;
  flowerRoot.traverse((o) => {
    if (o.isMesh) {
      o.renderOrder = 10;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const next = mats.map((mat) => {
        return new THREE.MeshBasicMaterial({
          map: mat.map ?? null,
          color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
          transparent: mat.transparent === true,
          opacity: mat.opacity ?? 1,
          toneMapped: false,
        });
      });
      o.material = next.length === 1 ? next[0] : next;
    }
  });
  const flowerBox = new THREE.Box3().setFromObject(flowerRoot);
  const flowerCenter = new THREE.Vector3();
  const flowerSize = new THREE.Vector3();
  flowerBox.getCenter(flowerCenter);
  flowerBox.getSize(flowerSize);
  flowerRoot.position.sub(flowerCenter);
  flowerBox.setFromObject(flowerRoot);
  flowerRoot.position.y -= flowerBox.min.y;

  const flowerMax = Math.max(flowerSize.x, flowerSize.y, flowerSize.z, 1e-6);
  const flowerPivot = new THREE.Group();
  flowerPivot.scale.setScalar((0.55 * 4) / flowerMax);

  const flowerMotion = new THREE.Group();
  flowerBox.setFromObject(flowerRoot);
  const stemH = flowerBox.max.y - flowerBox.min.y;
  const splitY = flowerBox.min.y + stemH * FLOWER_STEM_SPLIT;

  const stemGroup = new THREE.Group();
  const topPivot = new THREE.Group();
  topPivot.position.set(0, splitY, 0);
  const topGroup = new THREE.Group();
  topPivot.add(topGroup);

  const meshList = [];
  flowerRoot.traverse((o) => {
    if (o.isMesh) meshList.push(o);
  });

  for (const mesh of meshList) {
    const mb = new THREE.Box3().setFromObject(mesh);
    const mc = new THREE.Vector3();
    mb.getCenter(mc);
    if (mc.y < splitY) {
      stemGroup.attach(mesh);
    } else {
      topGroup.attach(mesh);
    }
  }

  if (topGroup.children.length === 0 && stemGroup.children.length > 0) {
    while (stemGroup.children.length) {
      topGroup.attach(stemGroup.children[0]);
    }
  }

  flowerMotion.add(stemGroup, topPivot);
  flowerPivot.add(flowerMotion);
  flowerPivot.position.set(0, FLOWER_PIVOT_Y, 1.05);
  flowerPivot.renderOrder = 10;
  threeScene.add(flowerPivot);
  threeFlower = flowerPivot;
  threeFlower.userData.breathTarget = topPivot;
  threeFlower.userData.flowerSplitY = splitY;

  const hitMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0,
    depthWrite: false,
    depthTest: true,
  });
  flowerPivot.updateMatrixWorld(true);
  const hb = new THREE.Box3().setFromObject(flowerPivot);
  const hCenter = new THREE.Vector3();
  const hSize = new THREE.Vector3();
  hb.getCenter(hCenter);
  hb.getSize(hSize);
  const hitR =
    Math.max(hSize.x, hSize.y, hSize.z) * 0.5 * FLOWER_HIT_RADIUS_MULT;
  const hitMesh = new THREE.Mesh(
    new THREE.SphereGeometry(hitR, 20, 16),
    hitMat,
  );
  const hitLocal = hCenter.clone();
  flowerPivot.worldToLocal(hitLocal);
  hitMesh.position.copy(hitLocal);
  hitMesh.renderOrder = 11;
  flowerPivot.add(hitMesh);

  try {
    const gubeGltf = await new GLTFLoader().loadAsync(GUBE_MODEL_PATH);
    const gubeRoot = gubeGltf.scene;
    gubeRoot.traverse((o) => {
      if (o.isMesh) {
        o.renderOrder = 8;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const next = mats.map((mat) => {
          return new THREE.MeshBasicMaterial({
            map: mat.map ?? null,
            color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
            transparent: mat.transparent === true,
            opacity: mat.opacity ?? 1,
            toneMapped: false,
          });
        });
        o.material = next.length === 1 ? next[0] : next;
      }
    });

    let gubeBox = new THREE.Box3().setFromObject(gubeRoot);
    const gubeCenter = new THREE.Vector3();
    gubeBox.getCenter(gubeCenter);
    gubeRoot.position.sub(gubeCenter);
    gubeBox.setFromObject(gubeRoot);
    gubeRoot.position.y -= gubeBox.min.y;
    gubeBox.setFromObject(gubeRoot);
    const gubeH = gubeBox.max.y - gubeBox.min.y;
    gubeRoot.scale.setScalar(
      GUBE_TARGET_HEIGHT / Math.max(gubeH, 1e-6),
    );
    gubeBox.setFromObject(gubeRoot);
    gubeRoot.position.y -= gubeBox.min.y;

    const gubePivot = new THREE.Group();
    gubePivot.add(gubeRoot);
    gubePivot.rotation.set(GUBE_ROTATION.x, GUBE_ROTATION.y, GUBE_ROTATION.z);
    gubePivot.renderOrder = 8;
    threeScene.add(gubePivot);
    threeGube = gubePivot;
    updateGubeToViewportRightEdge();
  } catch (err) {
    console.warn("Gube model not loaded:", GUBE_MODEL_PATH, err);
  }

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
  updateGubeToViewportRightEdge();
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

app.canvas.addEventListener("pointerdown", (e) => {
  if (!threeFlower) return;
  const w = window.innerWidth;
  const h = Math.max(window.innerHeight, 1);
  flowerPointerNdc.x = (e.clientX / w) * 2 - 1;
  flowerPointerNdc.y = -(e.clientY / h) * 2 + 1;
  flowerRaycaster.setFromCamera(flowerPointerNdc, threeCamera);
  const hits = flowerRaycaster.intersectObject(threeFlower, true);
  if (hits.length > 0) {
    flowerSpinEnabled = !flowerSpinEnabled;
    e.preventDefault();
    e.stopPropagation();
  }
});

const texturesByPath = await loadTexturesByPath(collectAllTexturePaths());

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

let sceneTime = 0;

/** Click flower to toggle spin (Pixi canvas raycast → Three scene). */
let flowerSpinEnabled = false;

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

  updateGubeToViewportRightEdge();

  if (threeFlower) {
    if (flowerSpinEnabled) {
      threeFlower.rotation.y += deltaSeconds * FLOWER_SPIN_SPEED;
    }
    const breathNode = threeFlower.userData.breathTarget;
    if (breathNode) {
      const t = sceneTime;
      const b = FLOWER_BREATH;
      const breath = Math.sin(t * b.freqBreath);
      const sway = Math.sin(t * b.freqSway + 0.85);
      const slow = Math.sin(t * (b.freqSway * 0.47) + 0.2);
      const baseY = threeFlower.userData.flowerSplitY ?? 0;
      breathNode.scale.setScalar(1 + breath * b.scaleAmp);
      breathNode.position.set(
        sway * b.offsetX,
        baseY + breath * b.offsetY,
        slow * b.offsetZ,
      );
      breathNode.rotation.x = breath * b.leanX;
      breathNode.rotation.z = sway * b.leanZ;
    }
  }

  tickThreeParticles(deltaSeconds, sceneTime);

  if (threeComposer) {
    threeComposer.render(deltaSeconds);
  } else {
    threeRenderer.render(threeScene, threeCamera);
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
