import { HouseViewer, preloadRoomAssets } from "./scene/viewer";
import { Goal } from "./goals/types";
import { describeScheduleForToday, groupTodaysGoals } from "./goals/todayGroups";
import { formatMinutes } from "./goals/ui";
import { buildModal } from "./ui/modal";
import { buildFloatingPanel } from "./ui/draggablePanel";
import { buildDashboardSections, renderActivityList, renderAllTimeActivity, renderGoalList } from "./dashboard/render";
import { CURRENT_USER_NAME, renderCurrentActivity, renderSyncStatus } from "./status/render";
import type { ActivityStat } from "./dashboard/stats";
import { setupFloorButtons } from "./ui/floorButtons";
import { setupTopButtons } from "./ui/topButtons";
import { setupPixiApp } from "./ui/pixiApp";
import { setupMobileTabs } from "./ui/mobileTabs";
import { buildDisplaySettingsSection, DisplaySettingsCallbacks } from "./ui/displaySettings";
import { Theme } from "./settings/types";
import { applyTheme, THEME_BACKGROUND } from "./settings/themes";

// Edit this to your own deployed val.town status val before building/hosting
// this page — it's the only thing that needs to change per-deployment.
const STATUS_API_BASE = "https://jacquelinett--6dc86500cd6211f1876a1607ee4eb77e.web.val.run";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_VIEWER_THEME: Theme = "pink";

interface ViewerSettings {
  scale: number;
  devMode: boolean;
  theme: Theme;
}

const VIEWER_SETTINGS_KEY = "houseSimulatorViewerSettings";

// No desktop-app-style Tauri fs here — this is a public static page, so
// localStorage is the whole persistence story (per-browser, not per-person;
// fine for "remember how I like to view this on my own screen").
function loadViewerSettings(): ViewerSettings {
  try {
    const raw = localStorage.getItem(VIEWER_SETTINGS_KEY);
    if (raw) return { scale: 2, devMode: false, theme: DEFAULT_VIEWER_THEME, ...JSON.parse(raw) };
  } catch {
    // ignore corrupt/inaccessible storage, just fall through to defaults
  }
  return { scale: 2, devMode: false, theme: DEFAULT_VIEWER_THEME };
}

function saveViewerSettings(settings: ViewerSettings) {
  localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify(settings));
}

interface StatusResponse {
  activityLabel: string | null;
  startedAt: string | null;
  todayMinutesByLabel: Record<string, number>;
}

/** Builds the "current activity" line (+ optional title above it, for the mobile Home tab, which has no panel header to show one) — shared by the Jacqueline panel and its mobile equivalent, which otherwise hand-built this same markup twice. */
function buildCurrentActivityBlock(
  container: HTMLElement,
  options?: { showTitle?: boolean },
): {
  render(status: { label: string | null; startedAt: Date | null }): void;
  showError(message: string): void;
} {
  if (options?.showTitle) {
    const title = document.createElement("div");
    title.className = "mobile-status-title";
    title.textContent = CURRENT_USER_NAME;
    container.appendChild(title);
  }

  const currentEl = document.createElement("div");
  currentEl.className = "overview-current";
  container.appendChild(currentEl);

  return {
    render: (status) => renderCurrentActivity(currentEl, status),
    showError: (message) => {
      currentEl.textContent = message;
    },
  };
}

/** Builds the VT sync line — same idea as buildCurrentActivityBlock above. No AW line at all, since the viewer has no AW access regardless of connection state. */
function buildSyncStatusBlock(
  container: HTMLElement,
): (vt: { configured: boolean; lastSuccessAt: Date | null; lastError: string | null }) => void {
  const syncEl = document.createElement("div");
  syncEl.className = "overview-status-line";
  container.appendChild(syncEl);

  return (vt) => renderSyncStatus(syncEl, { showAw: false, vt });
}

/** Builds the All-Time Activity pie + legend — shared by the desktop Statistic modal and the mobile Statistic tab. No All-Time Goals here — goal completion/skip history never leaves the desktop app (nothing pushes it to val.town). */
function buildStatisticBlock(container: HTMLElement): (stats: ActivityStat[]) => void {
  const heading = document.createElement("h3");
  heading.className = "panel-section-heading";
  heading.textContent = "All-Time Activity (top 5)";
  container.appendChild(heading);

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  container.appendChild(pie);

  const list = document.createElement("div");
  list.className = "dashboard-list";
  container.appendChild(list);

  return (stats) => renderAllTimeActivity(pie, list, stats);
}

/** Shared by the inline Leave-a-note form (desktop/wide-viewport) and the mobile Message popup — just the network call, each caller handles its own form fields/status text. */
async function sendMessage(author: string, text: string): Promise<void> {
  const res = await fetch(`${STATUS_API_BASE}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, author }),
  });
  if (!res.ok) throw new Error((await res.json()).error || "failed to send");
}

/**
 * Zoom + dev-mode outlines, independent of the desktop app's own Settings
 * — lets anyone viewing on a bigger/smaller screen adjust to taste (and is
 * handy for testing the viewer itself). Callbacks are supplied by the
 * caller (rather than built in here) so main() can pass the exact same
 * ones to both this modal and the mobile Settings tab's own instance —
 * that's what keeps the two in sync with each other.
 */
function setupSettingsModalUI(
  settings: ViewerSettings,
  callbacks: DisplaySettingsCallbacks,
): { open: () => void; update(values: ViewerSettings): void } {
  const modal = buildModal("Settings", { resizable: true });
  const display = buildDisplaySettingsSection(modal.body, settings, callbacks);
  return { open: modal.open, update: display.update };
}

/** A "native popup"-style dialog for leaving a note — the mobile Home tab's FAB, standing in for the inline form that doesn't fit there. */
function setupMobileMessageModal(): { open: () => void } {
  const modal = buildModal("Leave a note");

  const authorInput = document.createElement("input");
  authorInput.id = "viewer-author";
  authorInput.placeholder = "Your name (optional)";
  authorInput.maxLength = 50;
  modal.body.appendChild(authorInput);

  const textInput = document.createElement("textarea");
  textInput.id = "viewer-text";
  textInput.rows = 3;
  textInput.placeholder = "wow you actually lifted today, nice";
  textInput.maxLength = 500;
  modal.body.appendChild(textInput);

  const statusEl = document.createElement("div");
  statusEl.id = "viewer-send-status";
  modal.body.appendChild(statusEl);

  const actions = document.createElement("div");
  actions.className = "mobile-modal-actions";
  modal.body.appendChild(actions);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mobile-modal-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => modal.close();
  actions.appendChild(cancelBtn);

  const sendBtn = document.createElement("button");
  sendBtn.id = "viewer-send";
  sendBtn.textContent = "Send";
  actions.appendChild(sendBtn);

  sendBtn.onclick = async () => {
    const text = textInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    try {
      await sendMessage(authorInput.value.trim(), text);
      textInput.value = "";
      statusEl.textContent = "Sent!";
      setTimeout(() => modal.close(), 600);
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
    } finally {
      sendBtn.disabled = false;
    }
  };

  return {
    open() {
      statusEl.textContent = "";
      modal.open();
    },
  };
}

async function main() {
  // Unlike the desktop app (where settings load async from Tauri fs, so
  // the initial Pixi/CSS theme has to guess the default and get corrected
  // once settings actually load), localStorage here is synchronous — the
  // real saved theme is already known before anything renders, no flash.
  const viewerSettings = loadViewerSettings();
  document.documentElement.dataset.theme = viewerSettings.theme;

  const app = await setupPixiApp(THEME_BACKGROUND[viewerSettings.theme]);

  const roomLabelEl = document.querySelector<HTMLDivElement>("#room-label")!;

  // Building the floor buttons before the HouseViewer needs no viewer at
  // all (bindGoToRoom happens after) — so the HouseViewer's own
  // onRoomChange callback, which fires synchronously inside its
  // constructor for the initial room, can just call
  // floorButtons.onRoomChange directly instead of needing a deferred
  // placeholder for the "button doesn't exist yet" ordering problem.
  const floorButtons = setupFloorButtons();

  await preloadRoomAssets();
  const viewer = new HouseViewer(
    app,
    (name) => {
      roomLabelEl.textContent = name;
      floorButtons.onRoomChange(name);
    },
    viewerSettings,
  );
  floorButtons.bindGoToRoom((roomId) => viewer.goToRoom(roomId));

  // Shared by the Settings modal and the mobile Settings tab's own
  // instance of the same Display section — persists + applies the change,
  // then re-syncs *both* instances' displayed controls, instead of
  // whichever one you didn't just touch silently going stale.
  let settingsModalUI: { update(values: ViewerSettings): void } | null = null;
  let mobileSettingsUI: { update(values: ViewerSettings): void } | null = null;
  function syncSettingsUI() {
    settingsModalUI?.update(viewerSettings);
    mobileSettingsUI?.update(viewerSettings);
  }

  const displaySettingsCallbacks: DisplaySettingsCallbacks = {
    onDevModeChange: (value) => {
      viewerSettings.devMode = value;
      viewer.setDevMode(value);
      saveViewerSettings(viewerSettings);
      syncSettingsUI();
    },
    onThemeChange: (value) => {
      viewerSettings.theme = value;
      applyTheme(app, value);
      saveViewerSettings(viewerSettings);
      syncSettingsUI();
    },
    onScaleChange: (value) => {
      viewerSettings.scale = value;
      viewer.setScale(value);
      saveViewerSettings(viewerSettings);
      syncSettingsUI();
    },
  };

  const settingsModal = setupSettingsModalUI(viewerSettings, displaySettingsCallbacks);
  settingsModalUI = settingsModal;

  // --- Jacqueline panel: same corner panel the desktop app has, minus the
  // AW line (no AW access here) and plus "Leave a note" (viewer-only). ---
  const jacquelinePanel = buildFloatingPanel(CURRENT_USER_NAME, {
    closable: false,
    draggable: false,
    className: "goals-panel",
  });

  const renderCurrentDesktop = buildCurrentActivityBlock(jacquelinePanel.body);

  const noteHeading = document.createElement("h3");
  noteHeading.className = "panel-section-heading";
  noteHeading.textContent = "Leave a note";
  jacquelinePanel.body.appendChild(noteHeading);

  const authorInput = document.createElement("input");
  authorInput.id = "viewer-author";
  authorInput.placeholder = "Your name (optional)";
  authorInput.maxLength = 50;
  jacquelinePanel.body.appendChild(authorInput);

  const textInput = document.createElement("textarea");
  textInput.id = "viewer-text";
  textInput.rows = 3;
  textInput.placeholder = "wow you actually lifted today, nice";
  textInput.maxLength = 500;
  jacquelinePanel.body.appendChild(textInput);

  const sendBtn = document.createElement("button");
  sendBtn.id = "viewer-send";
  sendBtn.textContent = "Send";
  jacquelinePanel.body.appendChild(sendBtn);

  const sendStatusEl = document.createElement("div");
  sendStatusEl.id = "viewer-send-status";
  jacquelinePanel.body.appendChild(sendStatusEl);

  const jacquelineDivider = document.createElement("div");
  jacquelineDivider.className = "panel-divider";
  jacquelinePanel.body.appendChild(jacquelineDivider);

  const renderSyncDesktop = buildSyncStatusBlock(jacquelinePanel.body);

  jacquelinePanel.open();

  // --- Dashboard panel: identical to the desktop app's, same position. ---
  const dashboardPanel = buildFloatingPanel("Dashboard", {
    closable: false,
    resizable: true,
    className: "dashboard-panel",
  });
  const { goalList, activityList } = buildDashboardSections(dashboardPanel.body);
  dashboardPanel.open();

  // --- Statistic modal: same all-time Activity section the desktop app's Statistic modal has. ---
  const statisticModal = buildModal("Statistic", { size: "large", resizable: true });
  const renderStatisticDesktop = buildStatisticBlock(statisticModal.body);

  setupTopButtons([
    {
      label: "Statistic",
      onclick: () => {
        statisticModal.open();
        renderStatisticDesktop(latestStats);
      },
    },
    { label: "Settings", onclick: settingsModal.open },
  ]);

  // --- Mobile tabs: a separate UI tree, not a reflow of the above (see
  // shared-chrome.css's media query — both trees are always built, CSS
  // decides which is visible). Home has no panel chrome at all, just bare
  // status text + a FAB; Dashboard/Statistic/Settings mirror the floating
  // panel/modal content above into full-screen pages instead. ---
  const mobileTabs = setupMobileTabs();

  const mobileStatus = document.createElement("div");
  mobileStatus.className = "mobile-status";
  mobileTabs.pages.home.appendChild(mobileStatus);

  const renderCurrentMobile = buildCurrentActivityBlock(mobileStatus, { showTitle: true });

  const mobileDivider = document.createElement("div");
  mobileDivider.className = "panel-divider";
  mobileStatus.appendChild(mobileDivider);

  const renderSyncMobile = buildSyncStatusBlock(mobileStatus);

  const mobileMessageModal = setupMobileMessageModal();
  const mobileFab = document.createElement("button");
  mobileFab.className = "mobile-fab";
  mobileFab.textContent = "✉";
  mobileFab.setAttribute("aria-label", "Leave a note");
  mobileFab.onclick = () => mobileMessageModal.open();
  mobileTabs.pages.home.appendChild(mobileFab);

  const { goalList: mobileGoalList, activityList: mobileActivityList } = buildDashboardSections(
    mobileTabs.pages.dashboard,
  );

  const renderStatisticMobile = buildStatisticBlock(mobileTabs.pages.statistic);

  mobileSettingsUI = buildDisplaySettingsSection(mobileTabs.pages.settings, viewerSettings, displaySettingsCallbacks);

  mobileTabs.onTabChange((tab) => {
    if (tab === "statistic") renderStatisticMobile(latestStats);
  });

  let latestStats: ActivityStat[] = [];
  let startedAtMs: number | null = null;
  let latestActivityLabel: string | null = null;
  let latestTodayMinutesByLabel: Record<string, number> = {};
  let latestGoals: Goal[] = [];
  let lastSyncAt: Date | null = null;
  let lastSyncError: string | null = null;

  function renderCurrent() {
    const status = { label: latestActivityLabel, startedAt: startedAtMs ? new Date(startedAtMs) : null };
    renderCurrentDesktop.render(status);
    renderCurrentMobile.render(status);
  }

  // "Synced" here means "last successfully fetched data from val.town" —
  // the viewer only ever polls, it never pushes, so this is the mirror
  // image of the desktop app's own VT sync indicator. No AW line at all,
  // since the viewer has no AW access regardless of connection state.
  function renderSync() {
    const vt = { configured: true, lastSuccessAt: lastSyncAt, lastError: lastSyncError };
    renderSyncDesktop(vt);
    renderSyncMobile(vt);
  }

  async function refreshStatus() {
    try {
      const [statusRes, goalsRes, statsRes] = await Promise.all([
        fetch(`${STATUS_API_BASE}/api/status`),
        fetch(`${STATUS_API_BASE}/api/goals`),
        fetch(`${STATUS_API_BASE}/api/stats`),
      ]);
      const data: StatusResponse = await statusRes.json();
      latestGoals = await goalsRes.json();
      latestStats = await statsRes.json();

      latestActivityLabel = data.activityLabel;
      latestTodayMinutesByLabel = data.todayMinutesByLabel;
      startedAtMs = data.startedAt ? new Date(data.startedAt).getTime() : null;

      renderCurrent();
      viewer.showActivity(data.activityLabel ? { label: data.activityLabel } : null);

      lastSyncAt = new Date();
      lastSyncError = null;
      renderSync();
      renderGoals();
      renderTodayActivity();
    } catch (err) {
      console.error("[viewer] failed to fetch status", err);
      renderCurrentDesktop.showError("Couldn't load status");
      renderCurrentMobile.showError("Couldn't load status");
      lastSyncError = (err as Error).message;
      renderSync();
    }
  }

  // Each goal only carries its target + schedule — "today's minutes" comes
  // from the separately-pushed per-label map, and whichever label matches
  // the currently running activity gets its live elapsed time added here,
  // same as the elapsed-time clock below. So neither goal edits nor ticking
  // progress need a fresh fetch to stay accurate. Shared with the desktop
  // Dashboard's rendering, just sourced from polled data instead of AW.
  function renderGoals() {
    const groups = groupTodaysGoals(latestGoals, new Date());
    const entries = groups.map(({ activityLabel, targetMinutes, goals }) => {
      const baselineMinutes = latestTodayMinutesByLabel[activityLabel] ?? 0;
      const liveMinutes =
        baselineMinutes + (activityLabel === latestActivityLabel && startedAtMs ? (Date.now() - startedAtMs) / 60000 : 0);
      return {
        activityLabel,
        minutes: liveMinutes,
        targetMinutes,
        done: liveMinutes >= targetMinutes,
        subRows: goals.map((g) => `${describeScheduleForToday(g.recurrence)} — ${formatMinutes(g.targetMinutes)}`),
      };
    });
    renderGoalList(goalList, entries);
    renderGoalList(mobileGoalList, entries);
  }

  // Mirrors the desktop Dashboard's "Today's Activity" list — same
  // todayMinutesByLabel the goal progress above uses, just not filtered
  // down to activities with a goal attached.
  function renderTodayActivity() {
    const colorByLabel = new Map(latestStats.map((s) => [s.label, s.color] as const));
    const entries = Object.entries(latestTodayMinutesByLabel)
      .map(([label, minutes]) => ({
        label,
        color: colorByLabel.get(label) ?? 0xffffff,
        minutes: minutes + (label === latestActivityLabel && startedAtMs ? (Date.now() - startedAtMs) / 60000 : 0),
      }))
      .filter((e) => e.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);

    renderActivityList(activityList, entries, "Nothing tracked today");
    renderActivityList(mobileActivityList, entries, "Nothing tracked today");
  }

  function tickElapsed() {
    renderCurrent();
    renderGoals();
    renderTodayActivity();
    renderSync();
  }

  let hiddenAt: number | null = null;
  await refreshStatus();
  setInterval(refreshStatus, POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null && Date.now() - hiddenAt > POLL_INTERVAL_MS) {
      refreshStatus();
    }
  });
  setInterval(tickElapsed, 1000);

  sendBtn.onclick = async () => {
    const text = textInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    try {
      await sendMessage(authorInput.value.trim(), text);
      textInput.value = "";
      sendStatusEl.textContent = "Sent!";
    } catch (err) {
      sendStatusEl.textContent = `Error: ${(err as Error).message}`;
    } finally {
      sendBtn.disabled = false;
    }
  };
}

main().catch((err) => {
  console.error("[viewer] fatal error", err);
});
