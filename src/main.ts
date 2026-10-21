import { Application } from "pixi.js";
import { ensureStopwatchBucket, getServerInfo, RunningActivity } from "./aw/client";
import { House, preloadRoomAssets } from "./scene/House";

const statusEl = document.querySelector<HTMLDivElement>("#status")!;

let connectionStatus = "connecting to AW…";
let roomName = "";
let activity: RunningActivity | null = null;

function formatClock(date: Date): string {
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(hh > 0 ? 2 : 1, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function renderStatus() {
  const lines = [connectionStatus, roomName];
  if (activity) {
    const elapsed = formatElapsed(Date.now() - activity.startedAt.getTime());
    lines.push(
      `tracking: ${activity.label}`,
      `started: ${formatClock(activity.startedAt)}`,
      `elapsed time: ${elapsed}`,
    );
  } else {
    lines.push("idle");
  }
  statusEl.textContent = lines.join("\n");
}

async function main() {
  const app = new Application();
  await app.init({ background: "#1a1a1a", resizeTo: window });
  document.querySelector<HTMLDivElement>("#app")!.appendChild(app.canvas);

  try {
    const info = await getServerInfo();
    await ensureStopwatchBucket();
    connectionStatus = `connected: ${info.hostname} (aw-server ${info.version})`;
  } catch (err) {
    statusEl.textContent = `AW connection failed: ${(err as Error).message}`;
    console.error(err);
    return;
  }

  renderStatus();
  setInterval(renderStatus, 1000);

  await preloadRoomAssets();
  new House(
    app,
    (current) => {
      activity = current;
      renderStatus();
    },
    (name) => {
      roomName = name;
      renderStatus();
    },
  );
}

main().catch((err) => {
  statusEl.textContent = `fatal error: ${(err as Error).message}`;
  console.error(err);
});
