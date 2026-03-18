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

// Physics tuning
const attractionStrength = 0.9; // pull toward mouse (higher = snappier)
const damping = 0.92; // friction (lower = heavier, more resistance)
const maxSpeed = 420; // cap velocity for stability

// Visual effects
const floatAmplitude = 10; // px
const floatHz = 0.55; // cycles/sec
const pulseAmount = 0.04; // scale +/- %
const pulseHz = 0.75; // cycles/sec
const baseScale = 1;

// Organic motion (subtle)
const rotationStrength = 0.12; // how much velocity affects rotation
const stretchAmount = 0.06; // max stretch along movement (6%)
const squashAmount = 0.03; // max squash perpendicular (3%)
const speedForMaxStretch = 180; // speed at which stretch is maxed

// Physics state
const followPos = { x: ball.x, y: ball.y };
const velocity = { x: 0, y: 0 };
let smoothedSpeed = 0;

let t = 0;
app.ticker.add((ticker) => {
  const dt = ticker.deltaMS / 1000;
  t += dt;

  // Acceleration toward mouse (spring-like pull)
  const dx = target.x - followPos.x;
  const dy = target.y - followPos.y;
  const ax = dx * attractionStrength;
  const ay = dy * attractionStrength;

  // Apply acceleration to velocity
  velocity.x += ax * dt;
  velocity.y += ay * dt;

  // Damping (friction) - frame-rate independent
  const damp = Math.pow(damping, dt);
  velocity.x *= damp;
  velocity.y *= damp;

  // Clamp speed for stability
  let speed = Math.hypot(velocity.x, velocity.y);
  if (speed > maxSpeed) {
    const scale = maxSpeed / speed;
    velocity.x *= scale;
    velocity.y *= scale;
    speed = maxSpeed;
  }

  // Integrate velocity into position
  followPos.x += velocity.x * dt;
  followPos.y += velocity.y * dt;

  // Subtle floating
  const floatOffset = Math.sin(t * Math.PI * 2 * floatHz) * floatAmplitude;
  ball.position.set(followPos.x, followPos.y + floatOffset);

  // Organic motion: rotation + squash/stretch from velocity
  smoothedSpeed += (speed - smoothedSpeed) * 0.12;

  const speedFactor = Math.min(smoothedSpeed / speedForMaxStretch, 1);

  // Slight rotation in movement direction (fades when slowing)
  ball.rotation = Math.atan2(velocity.y, velocity.x) * rotationStrength * speedFactor;

  // Squash and stretch: elongate along movement, compress perpendicular
  const stretch = speedFactor * stretchAmount;
  const squash = speedFactor * squashAmount;
  const pulse = Math.sin(t * Math.PI * 2 * pulseHz) * pulseAmount;
  const base = baseScale * (1 + pulse);
  ball.scale.set(base * (1 + stretch), base * (1 - squash));
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

