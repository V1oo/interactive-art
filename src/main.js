import {
  Application,
  Assets,
  Sprite,
  DisplacementFilter,
} from "https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs";

const BACKGROUND_COLOR = 0x000000;

// 🚀 создаём приложение
const app = new Application();
await app.init({
  resizeTo: window,
  backgroundColor: BACKGROUND_COLOR,
});
document.body.appendChild(app.canvas);

// ✅ правильные пути (ВАЖНО для GitHub Pages)
const [waterTexture, noiseTexture] = await Promise.all([
  Assets.load("./assets/images/water.png"),
  Assets.load("./assets/images/noise.png"),
]);

// 🌊 вода
const water = new Sprite(waterTexture);
water.anchor.set(0, 1);
app.stage.addChild(water);

// 🌫 displacement (шум)
const displacementSprite = new Sprite(noiseTexture);

// обязательно для repeat
displacementSprite.texture.source.wrapMode = "repeat";

// масштаб шума
displacementSprite.scale.set(2);

// скрываем (но оставляем в сцене!)
displacementSprite.visible = false;

// центрируем
displacementSprite.anchor.set(0.5);

app.stage.addChild(displacementSprite);

// 🎛 фильтр
const displacementFilter = new DisplacementFilter(displacementSprite);
displacementFilter.scale.set(50, 20);

water.filters = [displacementFilter];

// 📐 адаптация под экран
function updateLayout() {
  const { width: w, height: h } = app.screen;

  // масштаб воды
  const scale = w / water.texture.width;
  water.scale.set(scale);

  // позиция снизу
  water.position.set(0, h);

  // центр displacement
  displacementSprite.position.set(w / 2, h / 2);
}

updateLayout();
window.addEventListener("resize", updateLayout);

// 🔄 анимация
let t = 0;

app.ticker.add((delta) => {
  t += 0.05 * delta;

  // движение шума
  displacementSprite.x += 1 * delta;

  // лёгкое "дыхание" воды
  displacementFilter.scale.x = 50 + Math.sin(t) * 10;
  displacementFilter.scale.y = 20 + Math.cos(t) * 5;
});
