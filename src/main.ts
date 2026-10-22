import { Application } from "pixi.js";
import { ensureStopwatchBucket, getCurrentActivity, getServerInfo, resumeActivity } from "./aw/client";
import { House, preloadRoomAssets } from "./scene/House";
import { setupGoalsPanel, setupJacquelineStatus } from "./goals/panel";
import { setupGoalsManageModal } from "./goals/manageModal";
import { initGoalsState, onGoalsChange } from "./goals/state";
import { initGoalHistoryState, settleGoalHistory } from "./goals/history";
import { setupTodosModal } from "./todos/modal";
import { initTodosState } from "./todos/state";
import { setupTimerModal } from "./timer/modal";
import { setupSettingsModal, setupSettingsContent } from "./settings/modal";
import { getSettings, initSettingsState, onSettingsChange } from "./settings/state";
import { setupMessagesModal } from "./broadcast/messagesModal";
import { pushGoals, pushStats, pushStatus } from "./broadcast/client";
import { setupDashboardPanel, setupDashboardContent } from "./dashboard/panel";
import { setupStatisticModal, setupStatisticContent } from "./dashboard/statisticModal";
import { setupFloorButtons } from "./ui/floorButtons";
import { setupTopButtons } from "./ui/topButtons";
import { setupPixiApp } from "./ui/pixiApp";
import { setupMobileTabs } from "./ui/mobileTabs";
import { buildModal } from "./ui/modal";
import { DEFAULT_SETTINGS } from "./settings/types";
import { applyTheme, THEME_BACKGROUND } from "./settings/themes";
import { ACTIVITIES, toCssColor } from "./scene/activities";

const STATS_PUSH_INTERVAL_MS = 60 * 60 * 1000;

// Only ever holds the boot-time "connecting…"/fatal-error text now —
// ongoing AW connection, activity, and elapsed time all live in the Today
// Overview panel instead (see goals/panel.ts), so this is cleared the
// moment AW connects and #status:empty hides the box.
const statusEl = document.querySelector<HTMLDivElement>("#status")!;
const roomLabelEl = document.querySelector<HTMLDivElement>("#room-label")!;

async function setupHouse(app: Application): Promise<House> {
  await preloadRoomAssets();

  // Building the floor buttons before the House needs no House at all
  // (bindGoToRoom happens after) — so the House's own onRoomChange
  // callback, which fires synchronously inside its constructor for the
  // initial room, can just call floorButtons.onRoomChange directly
  // instead of needing a deferred placeholder for the "button doesn't
  // exist yet" ordering problem.
  const floorButtons = setupFloorButtons();

  const house = new House(
    app,
    () => pushStatus(),
    (name) => {
      roomLabelEl.textContent = name;
      floorButtons.onRoomChange(name);
    },
    { devMode: getSettings().devMode, scale: getSettings().scale },
  );
  floorButtons.bindGoToRoom((roomId) => house.goToRoom(roomId));

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

/** Flat list of every activity in the registry, tapping one starts/stops it on whichever object has that action — a shortcut for mobile, where navigating to the right room/object just to track something costs more screen space than it's worth. */
function setupMobilePickAction(house: House): { open: () => void } {
  const modal = buildModal("Pick Action");
  const list = document.createElement("div");
  list.className = "dashboard-list";
  modal.body.appendChild(list);

  function render() {
    list.textContent = "";
    const current = getCurrentActivity();
    for (const activity of Object.values(ACTIVITIES)) {
      const btn = document.createElement("button");
      btn.className = "dashboard-row mobile-action-row";

      const swatch = document.createElement("span");
      swatch.className = "dashboard-swatch";
      swatch.style.background = toCssColor(activity.color);
      btn.appendChild(swatch);

      const text = document.createElement("span");
      text.className = "dashboard-text";
      text.textContent = `${current?.label === activity.label ? "☑" : "☐"} ${activity.label}`;
      btn.appendChild(text);

      btn.onclick = async () => {
        btn.disabled = true;
        try {
          await house.toggleActivity(activity.label);
          modal.close();
        } catch (err) {
          console.error("[mobile] failed to toggle activity", err);
          btn.disabled = false;
        }
      };

      list.appendChild(btn);
    }
  }

  return {
    open() {
      render();
      modal.open();
    },
  };
}

/**
 * The mobile tab bar + its 4 pages. Built unconditionally alongside the
 * desktop UI — shared-chrome.css's media query decides which is visible,
 * so this never needs to know whether it's actually on a small screen.
 */
function setupMobileUI(house: House): void {
  const tabs = setupMobileTabs();

  const mobileStatusEl = document.createElement("div");
  mobileStatusEl.className = "mobile-status";
  tabs.pages.home.appendChild(mobileStatusEl);
  setupJacquelineStatus(mobileStatusEl, { showTitle: true });

  const pickAction = setupMobilePickAction(house);
  const fab = document.createElement("button");
  fab.className = "mobile-fab";
  fab.textContent = "+";
  fab.setAttribute("aria-label", "Pick action");
  fab.onclick = () => pickAction.open();
  tabs.pages.home.appendChild(fab);

  setupDashboardContent(tabs.pages.dashboard);
  const statistic = setupStatisticContent(tabs.pages.statistic);
  setupSettingsContent(tabs.pages.settings);

  tabs.onTabChange((tab) => {
    if (tab === "statistic") statistic.refresh();
  });
}

async function main() {
  // applyTheme() overrides this once settings load, but this is what's
  // visible for the brief window before that, so it should already match
  // DEFAULT_SETTINGS.theme rather than flashing some other theme's
  // background first.
  const app = await setupPixiApp(THEME_BACKGROUND[DEFAULT_SETTINGS.theme]);

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
  setupMobileUI(house);

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
