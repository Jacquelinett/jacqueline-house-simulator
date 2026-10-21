import { Application } from "pixi.js";
import { ensureStopwatchBucket, getServerInfo, resumeActivity, RunningActivity } from "./aw/client";
import { House, preloadRoomAssets } from "./scene/House";
import { setupGoalsPanel } from "./goals/panel";
import { setupGoalsManageModal } from "./goals/manageModal";
import { initGoalsState } from "./goals/state";
import { setupTodosModal } from "./todos/modal";
import { initTodosState } from "./todos/state";
import { setupTimerModal } from "./timer/modal";
import { setupSettingsModal } from "./settings/modal";
import { initSettingsState } from "./settings/state";
import { setupMessagesModal } from "./broadcast/messagesModal";
import { pushStatus } from "./broadcast/client";

const BROADCAST_PUSH_INTERVAL_MS = 60_000;

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

function setupFloorButtons(house: House) {
  const container = document.createElement("div");
  container.id = "floor-buttons";
  const floors: { label: string; roomId: string }[] = [
    { label: "2F", roomId: "bedroom" },
    { label: "1F", roomId: "office" },
    { label: "B", roomId: "basement" },
  ];
  for (const { label, roomId } of floors) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = () => house.goToRoom(roomId);
    container.appendChild(btn);
  }
  document.body.appendChild(container);
}

/** Top-right row of app-level actions (goals, and whatever else joins it later). */
function setupTopButtons(buttons: { label: string; onclick: () => void }[]) {
  const container = document.createElement("div");
  container.id = "top-buttons";
  for (const { label, onclick } of buttons) {
    const btn = document.createElement("button");
    btn.textContent = label;
    btn.onclick = onclick;
    container.appendChild(btn);
  }
  document.body.appendChild(container);
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
  await app.init({
    background: "#1a1a1a",
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.querySelector<HTMLDivElement>("#app")!.appendChild(app.canvas);

  // Pixi's `resizeTo` option has a known bug where it can leave the backing
  // buffer subtly stretched/mismatched after a resize instead of cleanly
  // re-syncing (https://github.com/pixijs/pixijs/issues/6510) — driving
  // resolution + resize together ourselves, on every resize, avoids it.
  // Not perfect (occasional stretch still happens on some resizes) — good
  // enough for now, revisit later.
  function syncRendererSize() {
    app.renderer.resolution = window.devicePixelRatio || 1;
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }
  syncRendererSize();
  window.addEventListener("resize", syncRendererSize);

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

  await initGoalsState();
  await initSettingsState();

  await preloadRoomAssets();
  const house = new House(
    app,
    (current) => {
      activity = current;
      renderStatus();
      pushStatus();
    },
    (name) => {
      roomName = name;
      renderStatus();
    },
  );
  setupFloorButtons(house);

  const goalsModal = setupGoalsManageModal();
  await setupGoalsPanel();

  await initTodosState();
  const todosModal = setupTodosModal();

  const timerModal = setupTimerModal();
  const settingsModal = setupSettingsModal();
  const messagesModal = setupMessagesModal();

  setupTopButtons([
    { label: "Goals", onclick: goalsModal.open },
    { label: "Todos", onclick: todosModal.open },
    { label: "Timer", onclick: timerModal.open },
    { label: "Messages", onclick: messagesModal.open },
    { label: "Settings", onclick: settingsModal.open },
  ]);

  const resumed = await resumeActivity().catch((err) => {
    console.error("[aw] failed to resume previous activity", err);
    return null;
  });
  if (resumed) house.resumeActivity(resumed);

  pushStatus();
  setInterval(pushStatus, BROADCAST_PUSH_INTERVAL_MS);
}

main().catch((err) => {
  statusEl.textContent = `fatal error: ${(err as Error).message}`;
  console.error(err);
});
