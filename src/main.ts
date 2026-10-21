import { Application } from "pixi.js";
import { ensureStopwatchBucket, getServerInfo, resumeActivity } from "./aw/client";
import { House, preloadRoomAssets } from "./scene/House";
import { setupGoalsPanel } from "./goals/panel";
import { setupGoalsManageModal } from "./goals/manageModal";
import { initGoalsState, onGoalsChange } from "./goals/state";
import { initGoalHistoryState, settleGoalHistory } from "./goals/history";
import { setupTodosModal } from "./todos/modal";
import { initTodosState } from "./todos/state";
import { setupTimerModal } from "./timer/modal";
import { setupSettingsModal } from "./settings/modal";
import { getSettings, initSettingsState, onSettingsChange } from "./settings/state";
import { setupMessagesModal } from "./broadcast/messagesModal";
import { pushGoals, pushStats, pushStatus } from "./broadcast/client";
import { setupDashboardPanel } from "./dashboard/panel";

const STATS_PUSH_INTERVAL_MS = 60 * 60 * 1000;

// Only ever holds the boot-time "connecting…"/fatal-error text now —
// ongoing AW connection, activity, and elapsed time all live in the Today
// Overview panel instead (see goals/panel.ts), so this is cleared the
// moment AW connects and #status:empty hides the box.
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const roomLabelEl = document.querySelector<HTMLDivElement>("#room-label")!;

async function setupPixiApp(): Promise<Application> {
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

  return app;
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

async function setupHouse(app: Application): Promise<House> {
  await preloadRoomAssets();
  const house = new House(
    app,
    () => pushStatus(),
    (name) => {
      roomLabelEl.textContent = name;
    },
    { devMode: getSettings().devMode, scale: getSettings().scale },
  );
  setupFloorButtons(house);

  onSettingsChange(() => {
    house.setDevMode(getSettings().devMode);
    house.setScale(getSettings().scale);
  });

  return house;
}

/** Wires up every feature modal (goals/todos/timer/messages/settings) and the top-right button row that opens them. */
async function setupModals(): Promise<void> {
  const goalsModal = setupGoalsManageModal();
  await setupGoalsPanel();
  onGoalsChange(pushGoals);

  await initTodosState();
  const todosModal = setupTodosModal();

  const timerModal = setupTimerModal();
  const settingsModal = setupSettingsModal();
  const messagesModal = setupMessagesModal();
  const dashboardPanel = setupDashboardPanel();

  setupTopButtons([
    { label: "Goals", onclick: goalsModal.open },
    { label: "Todos", onclick: todosModal.open },
    { label: "Timer", onclick: timerModal.open },
    { label: "Dashboard", onclick: dashboardPanel.open },
    { label: "Messages", onclick: messagesModal.open },
    { label: "Settings", onclick: settingsModal.open },
  ]);
}

async function main() {
  const app = await setupPixiApp();

  try {
    await getServerInfo();
    await ensureStopwatchBucket();
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = `AW connection failed: ${(err as Error).message}`;
    console.error(err);
    return;
  }

  await initGoalsState();
  await initGoalHistoryState();
  await initSettingsState();

  // Backfills any scheduled day between each goal's creation (or last
  // settle) and yesterday that hasn't been recorded yet — never blocks
  // startup on this, since it's just gamification stats, not core function.
  settleGoalHistory().catch((err) => console.error("[goals] failed to settle history", err));

  const house = await setupHouse(app);
  await setupModals();

  const resumed = await resumeActivity().catch((err) => {
    console.error("[aw] failed to resume previous activity", err);
    return null;
  });
  if (resumed) house.resumeActivity(resumed);

  // Pushed once on startup so a viewer isn't stuck showing stale data from
  // last session; after that, `onActivityChange`/`onGoalsChange` above
  // re-push whenever something that's actually displayed changes.
  pushStatus();
  pushGoals();

  // Stats scan much more AW history than anything else pushed here, so they
  // get their own slow timer instead of piggybacking on activity changes.
  pushStats();
  setInterval(pushStats, STATS_PUSH_INTERVAL_MS);
}

main().catch((err) => {
  statusEl.textContent = `fatal error: ${(err as Error).message}`;
  console.error(err);
});
