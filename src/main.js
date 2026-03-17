import { Application, Text } from "https://cdn.jsdelivr.net/npm/pixi.js@8/dist/pixi.mjs";

const app = new Application();

await app.init({ resizeTo: window, backgroundColor: 0x1099bb });

document.body.appendChild(app.canvas);

const hello = new Text({
  text: "Hello world",
  style: {
    fill: 0xffffff,
    fontFamily: "Arial, sans-serif",
    fontSize: 48,
    fontWeight: "700",
  },
});

hello.anchor.set(0.5);
hello.position.set(app.screen.width / 2, app.screen.height / 2);

app.stage.addChild(hello);

window.addEventListener("resize", () => {
  hello.position.set(app.screen.width / 2, app.screen.height / 2);
});

