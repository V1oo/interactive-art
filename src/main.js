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
/** Совпадает с туманом — мягкий горизонт как на референсе. */
const THREE_SCENE_BG = 0x1a0d28;
threeScene.background = new THREE.Color(THREE_SCENE_BG);
/** Экспоненциальный туман: «съедает» даль пола и стыкует с фоном. */
const THREE_SCENE_FOG_DENSITY = 0.034;
threeScene.fog = new THREE.FogExp2(THREE_SCENE_BG, THREE_SCENE_FOG_DENSITY);

const threeCamera = new THREE.PerspectiveCamera(
  50,
  window.innerWidth / Math.max(window.innerHeight, 1),
  0.1,
  500,
);
/** Выше сцены + взгляд вниз; чуть ниже/ровнее — чуть больше пола в кадре (YXZ). */
const THREE_CAMERA_Y = 0.78;
const THREE_CAMERA_PITCH_X = 0.17;
threeCamera.position.set(0, THREE_CAMERA_Y, 0);
threeCamera.rotation.order = "YXZ";
threeCamera.rotation.x = THREE_CAMERA_PITCH_X;

const textureLoader = new THREE.TextureLoader();

const flowerRaycaster = new THREE.Raycaster();
const flowerPointerNdc = new THREE.Vector2();

/**
 * Back → front. Camera z = 0, −Z into scene; smaller z = farther.
 * scale — uniform world scale of the 1×1 plane.
 */
/** Порядок: дальше → ближе (z и renderOrder согласованы). */
const THREE_PARALLAX_LAYERS = [
  { texturePath: "./assets/images/main-bg.png", z: -34, scale: 200, renderOrder: 0 },
  { texturePath: "./assets/images/tree-lvl-2.png", z: -31, scale: 60, renderOrder: 1 },
  { texturePath: "./assets/images/tree-lvl-1.png", z: -28, scale: 40, renderOrder: 2 },
  { texturePath: "./assets/images/bg-1.png", z: -23, scale: 120, renderOrder: 3 },
  { texturePath: "./assets/images/rock-lvl-1.png", z: -12, scale: 25, renderOrder: 4 },
];

/** @type {{ mesh: THREE.Mesh; worldScale: number }[]} */
const threeBgLayers = [];

/** Soft particles in the upper sky (Three.js). */
let threeParticles = null;

/** GLB flower pivot; `userData.breathTarget` = upper pivot for breathing. */
let threeFlower = null;

/** GLB prop to the right, in front of parallax trees (see `GUBE_*`). */
let threeGube = null;

/** Невидимый пол (XZ); `Raycaster.intersectObject(threeFloor)` — точка посадки. */
let threeFloor = null;

/** Postprocessing (bloom). */
let threeComposer = null;

const THREE_SKY_PARTICLE_COUNT = 220;

/** Y-spin when toggled by click (rad/s). */
const FLOWER_SPIN_SPEED = 0.35;

/** World Y offset of the flower (lower = further down on screen). */
const FLOWER_PIVOT_Y = -1.35;
/** Flower + gube row depth. */
const THREE_FOREGROUND_Z = -10;
/** Target max model extent in world units (~5–10). */
const FLOWER_WORLD_MAX_EXTENT = 7;

/** Мировая высота невидимого пола (совпадает с «землёй» у цветка). */
const THREE_FLOOR_Y = FLOWER_PIVOT_Y;
/** Размер плоскости пола по ширине (локальная X). */
const THREE_FLOOR_SIZE = 220;
/** Глубина пола (локальная Y → вглубь после наклона). */
const THREE_FLOOR_SIZE_Z = THREE_FLOOR_SIZE * 0.09;
/** Наклон пола вокруг мировой оси X (°); круче — меньше полосы пола на экране. */
const THREE_FLOOR_ROT_X_DEG = -84.5;
/** Временная видимость пола; поставьте 0 — снова невидимый. */
const THREE_FLOOR_DEBUG_OPACITY = 0.28;
const THREE_FLOOR_DEBUG_COLOR = 0x4a7c59;
/**
 * Сетка на полу: линии вдоль −Z (от камеры вглубь) и поперечные по Z.
 * z ближе к 0 — ближе к камере; z отрицательный — дальше.
 */
const FLOOR_GUIDE_Z_NEAR = -3;
const FLOOR_GUIDE_Z_FAR = -8;
const FLOOR_GUIDE_X_STEP = 7;
const FLOOR_GUIDE_X_HALF = 58;
const FLOOR_GUIDE_Z_CROSS_STEP = 2;
const FLOOR_GUIDE_COLOR = 0xc8e8d4;
const FLOOR_GUIDE_OPACITY = 0.55;

/** Куб на полу (рядом с цветком). */
const FLOOR_CUBE_MODEL_PATH = "./assets/models/cube.glb";
const FLOOR_CUBE_TARGET_HEIGHT = 2.2;
const FLOOR_CUBE_X = -7;
const FLOOR_BRANCH_X = 4;

/** `gube.glb` — фиксированно справа, на полу (−Z глубже цветка = дальше от камеры). */
const GUBE_MODEL_PATH = "./assets/models/gube.glb";
/** Мировая позиция пивота (после посадки низ модели на THREE_FLOOR_Y). */
const GUBE_X = 22;
const GUBE_Z = -17;
/** Доп. поворот пивота (радианы); y = π — ещё 180° вокруг вертикали. */
const GUBE_ROTATION = { x: 0, y: Math.PI, z: 0 };
/** Целевая высота в мире после нормализации по bounding box. */
const GUBE_TARGET_HEIGHT = 6;

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

function createUpperSkyParticles() {
  const positions = new Float32Array(THREE_SKY_PARTICLE_COUNT * 3);
  const verticalSpeed = new Float32Array(THREE_SKY_PARTICLE_COUNT);
  for (let i = 0; i < THREE_SKY_PARTICLE_COUNT; i++) {
    const ix = i * 3;
    positions[ix] = (Math.random() - 0.5) * 80;
    positions[ix + 1] = 8 + Math.random() * 35;
    positions[ix + 2] = -18 + Math.random() * 14;
    verticalSpeed[i] = 0.1 + Math.random() * 0.16;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(positions, 3),
  );
  const material = new THREE.PointsMaterial({
    color: 0xd4f2ff,
    size: 0.55,
    transparent: true,
    opacity: 0.48,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    sizeAttenuation: true,
    fog: true,
  });
  const points = new THREE.Points(geometry, material);
  points.renderOrder = 6;
  points.frustumCulled = false;
  points.userData.verticalSpeed = verticalSpeed;
  points.userData.yLo = 6;
  points.userData.yHi = 48;
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
      arr[ix + 2] = -20 + Math.random() * 16;
    }
  }
  posAttr.needsUpdate = true;
}

function updateThreeBgPlaneSizes() {
  for (const layer of threeBgLayers) {
    const s = layer.worldScale;
    layer.mesh.scale.set(s, s, 1);
  }
}

/** Нижняя грань иерархии `pivot` касается плоскости y = floorY в точке (worldX, worldZ). */
function placePivotBottomOnFloorAt(pivot, worldX, worldZ, floorY) {
  pivot.position.set(worldX, 0, worldZ);
  pivot.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(pivot);
  pivot.position.y = floorY - box.min.y;
}

/** Простая «ветка» (цилиндры); отдельной модели в репозитории нет. */
function createFloorBranchGroup() {
  const brown = new THREE.MeshBasicMaterial({
    color: 0x5c4033,
    toneMapped: false,
    fog: true,
  });
  const group = new THREE.Group();
  const main = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.1, 2.4, 8),
    brown,
  );
  main.rotation.z = Math.PI / 2;
  const twig = new THREE.Mesh(
    new THREE.CylinderGeometry(0.035, 0.055, 1.0, 6),
    brown,
  );
  twig.rotation.set(0.25, 0.55, Math.PI / 2.15);
  twig.position.set(0.85, 0.06, 0.12);
  group.add(main, twig);
  group.traverse((o) => {
    if (o.isMesh) o.renderOrder = 9;
  });
  return group;
}

/**
 * Линии в локальных координатах пола (плоскость XY, z = 0): вдоль «глубины» и поперечники.
 * После поворота группы совпадают с наклонённым PlaneGeometry.
 */
function createFloorPerspectiveGuides() {
  const positions = [];
  const ly0 = -FLOOR_GUIDE_Z_NEAR;
  const ly1 = -FLOOR_GUIDE_Z_FAR;
  const xH = FLOOR_GUIDE_X_HALF;
  for (let x = -xH; x <= xH + 1e-6; x += FLOOR_GUIDE_X_STEP) {
    positions.push(x, ly0, 0, x, ly1, 0);
  }
  for (let ly = ly0; ly <= ly1 + 1e-6; ly += FLOOR_GUIDE_Z_CROSS_STEP) {
    positions.push(-xH, ly, 0, xH, ly, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(positions, 3),
  );
  const mat = new THREE.LineBasicMaterial({
    color: FLOOR_GUIDE_COLOR,
    transparent: true,
    opacity: FLOOR_GUIDE_OPACITY,
    depthWrite: false,
    toneMapped: false,
    fog: true,
  });
  const lines = new THREE.LineSegments(geo, mat);
  lines.renderOrder = 0;
  return lines;
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
      fog: true,
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
      worldScale: cfg.scale,
    });
  }

  threeParticles = createUpperSkyParticles();
  threeScene.add(threeParticles);

  const floorGeo = new THREE.PlaneGeometry(THREE_FLOOR_SIZE, THREE_FLOOR_SIZE_Z);
  const floorDebugVisible = THREE_FLOOR_DEBUG_OPACITY > 0;
  const floorMat = new THREE.MeshBasicMaterial({
    color: THREE_FLOOR_DEBUG_COLOR,
    transparent: true,
    opacity: floorDebugVisible ? THREE_FLOOR_DEBUG_OPACITY : 0,
    depthWrite: floorDebugVisible,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: true,
  });
  const floorMesh = new THREE.Mesh(floorGeo, floorMat);
  floorMesh.renderOrder = -1;

  const floorRoot = new THREE.Group();
  floorRoot.position.set(0, THREE_FLOOR_Y, 0);
  floorRoot.rotation.x = THREE.MathUtils.degToRad(THREE_FLOOR_ROT_X_DEG);
  floorRoot.add(floorMesh);
  floorRoot.add(createFloorPerspectiveGuides());
  threeScene.add(floorRoot);

  threeFloor = floorMesh;

  try {
    const cubeGltf = await new GLTFLoader().loadAsync(FLOOR_CUBE_MODEL_PATH);
    const cubeRoot = cubeGltf.scene;
    cubeRoot.traverse((o) => {
      if (o.isMesh) {
        o.renderOrder = 9;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        const next = mats.map((mat) => {
          return new THREE.MeshBasicMaterial({
            map: mat.map ?? null,
            color: mat.color ? mat.color.clone() : new THREE.Color(0xffffff),
            transparent: mat.transparent === true,
            opacity: mat.opacity ?? 1,
            toneMapped: false,
            fog: true,
          });
        });
        o.material = next.length === 1 ? next[0] : next;
      }
    });
    let cubeBox = new THREE.Box3().setFromObject(cubeRoot);
    const cubeCenter = new THREE.Vector3();
    cubeBox.getCenter(cubeCenter);
    cubeRoot.position.sub(cubeCenter);
    cubeBox.setFromObject(cubeRoot);
    cubeRoot.position.y -= cubeBox.min.y;
    cubeBox.setFromObject(cubeRoot);
    const cubeH = cubeBox.max.y - cubeBox.min.y;
    cubeRoot.scale.setScalar(
      FLOOR_CUBE_TARGET_HEIGHT / Math.max(cubeH, 1e-6),
    );
    cubeBox.setFromObject(cubeRoot);
    cubeRoot.position.y -= cubeBox.min.y;

    const cubePivot = new THREE.Group();
    cubePivot.add(cubeRoot);
    cubePivot.renderOrder = 9;
    threeScene.add(cubePivot);
    placePivotBottomOnFloorAt(
      cubePivot,
      FLOOR_CUBE_X,
      THREE_FOREGROUND_Z,
      THREE_FLOOR_Y,
    );
  } catch (err) {
    console.warn("Floor cube not loaded:", FLOOR_CUBE_MODEL_PATH, err);
  }

  const branchPivot = new THREE.Group();
  branchPivot.add(createFloorBranchGroup());
  branchPivot.renderOrder = 9;
  threeScene.add(branchPivot);
  placePivotBottomOnFloorAt(
    branchPivot,
    FLOOR_BRANCH_X,
    THREE_FOREGROUND_Z,
    THREE_FLOOR_Y,
  );

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
          fog: true,
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
  flowerPivot.scale.setScalar(FLOWER_WORLD_MAX_EXTENT / flowerMax);

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
  flowerPivot.position.set(0, FLOWER_PIVOT_Y, THREE_FOREGROUND_Z);
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
            fog: true,
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
    placePivotBottomOnFloorAt(threeGube, GUBE_X, GUBE_Z, THREE_FLOOR_Y);
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

window.addEventListener("pointermove", (e) => {
  const w = window.innerWidth;
  if (w <= 0) return;
  threeMouseX = (e.clientX / w) * 2 - 1;
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
