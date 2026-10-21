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
import { setupStatisticModal } from "./dashboard/statisticModal";
import { setupFloorButtons } from "./ui/floorButtons";
import { Theme } from "./settings/types";

const STATS_PUSH_INTERVAL_MS = 60 * 60 * 1000;

// Pixi's own canvas background (visible wherever no room tile covers, e.g.
// letterboxing around the isometric scene) isn't CSS — has to be set
// directly on the renderer, and re-set on every theme change since it's
// not something a stylesheet can reach.
const THEME_BACKGROUND: Record<Theme, number> = {
  dark: 0x1a1a1a,
  pink: 0xffe4ec,
};

function applyTheme(app: Application, theme: Theme) {
  document.documentElement.dataset.theme = theme;
  app.renderer.background.color = THEME_BACKGROUND[theme];
}

// Only ever holds the boot-time "connecting…"/fatal-error text now —
// ongoing AW connection, activity, and elapsed time all live in the Today
// Overview panel instead (see goals/panel.ts), so this is cleared the
// moment AW connects and #status:empty hides the box.
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const roomLabelEl = document.querySelector<HTMLDivElement>("#room-label")!;

async function setupPixiApp(): Promise<Application> {
  const app = new Application();
  await app.init({
    // Matches DEFAULT_SETTINGS.theme ("pink") — applyTheme() overrides this
    // once settings load, but this is what's visible for the brief window
    // before that, so it should already match the default rather than
    // flashing the other theme's background first.
    background: "#ffe4ec",
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

  // The room-change callback fires synchronously inside the House
  // constructor (for the initial room), before setupFloorButtons() below
  // even runs — this placeholder captures that first name so it can be
  // applied once the real updater exists, instead of the floor buttons
  // just not reflecting the starting room until the next navigation.
  let initialRoomName = "";
  let updateFloorButtons: (name: string) => void = (name) => {
    initialRoomName = name;
  };

  const house = new House(
    app,
    () => pushStatus(),
    (name) => {
      roomLabelEl.textContent = name;
      updateFloorButtons(name);
    },
    { devMode: getSettings().devMode, scale: getSettings().scale },
  );
  updateFloorButtons = setupFloorButtons((roomId) => house.goToRoom(roomId));
  updateFloorButtons(initialRoomName);

  onSettingsChange(() => {
    house.setDevMode(getSettings().devMode);
    house.setScale(getSettings().scale);
  });

  return house;
}

/** Wires up every feature modal (goals/todos/timer/messages/settings) and the top-right button row that opens them. */
async function setupModals(): Promise<void> {
  const goalsModal = setupGoalsManageModal();
  setupGoalsPanel();
  onGoalsChange(pushGoals);

  await initTodosState();
  const todosModal = setupTodosModal();

  const timerModal = setupTimerModal();
  const settingsModal = setupSettingsModal();
  const messagesModal = setupMessagesModal();
  setupDashboardPanel();
  const statisticModal = setupStatisticModal();

  setupTopButtons([
    { label: "Goals", onclick: goalsModal.open },
    { label: "Todos", onclick: todosModal.open },
    { label: "Timer", onclick: timerModal.open },
    { label: "Statistic", onclick: statisticModal.open },
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

  applyTheme(app, getSettings().theme);
  onSettingsChange(() => applyTheme(app, getSettings().theme));

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
