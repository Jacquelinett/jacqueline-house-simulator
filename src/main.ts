import { Application } from "pixi.js";
import { House, preloadRoomAssets } from "./scene/House";
import { setupGoalsPanel, setupJacquelineStatus } from "./goals/panel";
import { setupGoalsManageModal } from "./goals/manageModal";
import { setupTodosModal } from "./todos/modal";
import { setupTimerModal } from "./timer/modal";
import { setupSettingsModal, setupSettingsContent } from "./settings/modal";
import { getSettings, onSettingsChange } from "./settings/state";
import { setupMessagesModal } from "./broadcast/messagesModal";
import { setupDashboardPanel, setupDashboardContent } from "./dashboard/panel";
import { setupStatisticModal, setupStatisticContent } from "./dashboard/statisticModal";
import { setupFloorButtons } from "./ui/floorButtons";
import { setupTopButtons } from "./ui/topButtons";
import { setupPixiApp } from "./ui/pixiApp";
import { setupMobileTabs } from "./ui/mobileTabs";
import { buildModal } from "./ui/modal";
import { DEFAULT_DEVICE_SETTINGS } from "./settings/types";
import { applyTheme, THEME_BACKGROUND } from "./settings/themes";
import { ACTIVITIES, toCssColor } from "./scene/activities";
import { connectRemoteState, getRemoteStatus, onRemoteStatusChange } from "./client/remoteState";

// Only ever holds the boot-time "connecting…"/fatal-error text now —
// ongoing AW connection, activity, and elapsed time all live in the
// Jacqueline panel instead (see goals/panel.ts), so this is cleared the
// moment the server connects and #status:empty hides the box.
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
function setupModals(): void {
  const goalsModal = setupGoalsManageModal();
  setupGoalsPanel();

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
    const current = getRemoteStatus();
    for (const activity of Object.values(ACTIVITIES)) {
      const btn = document.createElement("button");
      btn.className = "dashboard-row mobile-action-row";

      const swatch = document.createElement("span");
      swatch.className = "dashboard-swatch";
      swatch.style.background = toCssColor(activity.color);
      btn.appendChild(swatch);

      const text = document.createElement("span");
      text.className = "dashboard-text";
      text.textContent = `${current.activityLabel === activity.label ? "☑" : "☐"} ${activity.label}`;
      btn.appendChild(text);

      btn.onclick = () => {
        house.toggleActivity(activity.label);
        modal.close();
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
  // DEFAULT_DEVICE_SETTINGS.theme rather than flashing some other theme's
  // background first.
  const app = await setupPixiApp(THEME_BACKGROUND[DEFAULT_DEVICE_SETTINGS.theme]);

  try {
    // Resolves only once the server's initial goals/todos/status/settings
    // broadcasts have all arrived (see remoteState.ts) — so everything
    // built below can read getSettings()/getRemoteStatus() synchronously.
    await connectRemoteState();
    statusEl.textContent = "";
  } catch (err) {
    statusEl.textContent = `Server connection failed: ${(err as Error).message}`;
    console.error(err);
    return;
  }

  applyTheme(app, getSettings().theme);
  onSettingsChange(() => applyTheme(app, getSettings().theme));

  const house = await setupHouse(app);
  // Applied once right after connecting (mirrors the old AW-resume-on-launch
  // behavior) and again on every subsequent broadcast — including a change
  // from a different device, see House.applyRemoteStatus's own comment.
  house.applyRemoteStatus(getRemoteStatus());
  onRemoteStatusChange(() => house.applyRemoteStatus(getRemoteStatus()));

  setupModals();
  setupMobileUI(house);
}

main().catch((err) => {
  statusEl.textContent = `fatal error: ${(err as Error).message}`;
  console.error(err);
});
