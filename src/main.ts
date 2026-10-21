import { Application, Graphics, Text } from "pixi.js";
import {
  ensureStopwatchBucket,
  getCurrentActivity,
  getServerInfo,
  startActivity,
  stopActivity,
} from "./aw/client";
import { hotspots } from "./scene/hotspots";

const statusEl = document.querySelector<HTMLDivElement>("#status")!;

function setStatus(text: string) {
  statusEl.textContent = text;
}

async function main() {
  const app = new Application();
  await app.init({ background: "#2b2b2b", resizeTo: window });
  document.querySelector<HTMLDivElement>("#app")!.appendChild(app.canvas);

  try {
    const info = await getServerInfo();
    await ensureStopwatchBucket();
    setStatus(`connected: ${info.hostname} (aw-server ${info.version})`);
  } catch (err) {
    setStatus(`AW connection failed: ${(err as Error).message}`);
    console.error(err);
    return;
  }

  for (const spot of hotspots) {
    const box = new Graphics()
      .rect(0, 0, spot.width, spot.height)
      .fill(spot.color);
    box.position.set(spot.x, spot.y);
    box.eventMode = "static";
    box.cursor = "pointer";

    const label = new Text({
      text: spot.label,
      style: { fill: "#ffffff", fontSize: 14 },
    });
    label.position.set(spot.x + 8, spot.y + spot.height + 4);

    box.on("pointertap", async () => {
      const current = getCurrentActivity();
      if (current?.label === spot.label) {
        await stopActivity();
        setStatus(`stopped: ${spot.label}`);
      } else {
        await startActivity(spot.label);
        setStatus(`tracking: ${spot.label}`);
      }
    });

    app.stage.addChild(box, label);
  }
}

main().catch((err) => {
  setStatus(`fatal error: ${(err as Error).message}`);
  console.error(err);
});
