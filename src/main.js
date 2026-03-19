import {
  Application,
  Assets,
  Sprite,
  DisplacementFilter,
} from "https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs";

const BACKGROUND_COLOR = 0x000000;

const app = new Application();
await app.init({ resizeTo: window, backgroundColor: BACKGROUND_COLOR });
document.body.appendChild(app.canvas);

const [waterTexture, noiseTexture] = await Promise.all([
  Assets.load("./assets/images/water.png"),
  Assets.load("./assets/images/noise.png"),
]);

const water = new Sprite(waterTexture);
water.anchor.set(0, 1);
app.stage.addChild(water);

const displacementSprite = new Sprite(noiseTexture);
displacementSprite.texture.source.wrapMode = "repeat";
displacementSprite.scale.set(2);
displacementSprite.visible = false;
displacementSprite.anchor.set(0.5);
app.stage.addChild(displacementSprite);

const displacementFilter = new DisplacementFilter(displacementSprite);
displacementFilter.scale.set(50, 20);
water.filters = [displacementFilter];

function updateLayout() {
  const { width: w, height: h } = app.screen;
  const waterScale = w / water.width;
  water.scale.set(waterScale);
  water.position.set(0, h);
  displacementSprite.position.set(w / 2, h / 2);
}

updateLayout();
window.addEventListener("resize", updateLayout);

app.ticker.add(() => {
  displacementSprite.x += 1;
});
