import {
  Application,
  Assets,
  Sprite,
} from "https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs";

const app = new Application();

await app.init({ resizeTo: window, backgroundColor: 0x1099bb });

document.body.appendChild(app.canvas);

const texture = await Assets.load("assets/images/ball.png");
const ball = new Sprite(texture);
ball.anchor.set(0.5);
ball.position.set(app.screen.width / 2, app.screen.height / 2);
app.stage.addChild(ball);

// Pointer tracking (in screen/world coords)
app.stage.eventMode = "static";
app.stage.hitArea = app.screen;

const target = { x: app.screen.width / 2, y: app.screen.height / 2 };
app.stage.on("pointermove", (e) => {
  target.x = e.global.x;
  target.y = e.global.y;
});

// Motion tuning
const followLerp = 0.10; // lower = smoother/slower, higher = snappier
const floatAmplitude = 10; // px
const floatHz = 0.55; // cycles/sec
const pulseAmount = 0.04; // scale +/- %
const pulseHz = 0.75; // cycles/sec
const baseScale = 1;

// Keep a stable base position (mouse-follow) separate from float offset.
const followPos = { x: ball.x, y: ball.y };

let t = 0;
app.ticker.add((ticker) => {
  // ticker.deltaMS is in milliseconds; normalize to seconds
  const dt = ticker.deltaMS / 1000;
  t += dt;

  // Smooth follow (lerp) toward pointer
  followPos.x += (target.x - followPos.x) * followLerp;
  followPos.y += (target.y - followPos.y) * followLerp;

  // Subtle floating + pulsing layered on top
  const floatOffset = Math.sin(t * Math.PI * 2 * floatHz) * floatAmplitude;
  ball.position.set(followPos.x, followPos.y + floatOffset);

  const pulse = Math.sin(t * Math.PI * 2 * pulseHz) * pulseAmount;
  const s = baseScale * (1 + pulse);
  ball.scale.set(s);
});

window.addEventListener("resize", () => {
  // Keep interactive hit area in sync with resized screen
  app.stage.hitArea = app.screen;

  // If no pointer movement yet, recentre the target too
  if (!Number.isFinite(target.x) || !Number.isFinite(target.y)) {
    target.x = app.screen.width / 2;
    target.y = app.screen.height / 2;
  }
});

