import { HouseViewer, preloadRoomAssets } from "./scene/viewer";
import { Goal } from "./goals/types";
import { describeScheduleForDate, groupGoalsForDate } from "./goals/goalGroups";
import { addDaysToDateString, localDateString, parseDateString } from "./goals/recurrence";
import { formatMinutes, formatStreak } from "./goals/ui";
import { buildModal } from "./ui/modal";
import { buildFloatingPanel } from "./ui/draggablePanel";
import { buildToggleGroup } from "./ui/toggleGroup";
import {
  buildDashboardSections,
  renderActivityList,
  renderAllTimeActivity,
  renderGoalList,
  renderGoalOutcomes,
} from "./dashboard/render";
import { CURRENT_USER_NAME, renderCurrentActivity, renderSyncStatus } from "./status/render";
import type { ActivityStat } from "./dashboard/stats";
import type { FixedPeriodKey, FixedPeriodStats } from "./dashboard/periodStats";
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

type DashboardDay = "today" | "yesterday";

interface DashboardRenderInput {
  goals: Goal[];
  todayMinutesByLabel: Record<string, number>;
  yesterdayMinutesByLabel: Record<string, number>;
  streaksByGoalId: Record<string, number>;
  activityLabel: string | null;
  startedAtMs: number | null;
  colorByLabel: Map<string, number>;
}

/**
 * Goal progress + activity breakdown for Today or Yesterday — a
 * Today/Yesterday hyperlink toggle stands in for the desktop app's own
 * Dashboard date picker, since the viewer has no AW access to query an
 * arbitrary day. "Yesterday" is whatever was last pushed to
 * /api/yesterday: a settled, complete day, so (unlike "today") it never
 * gets the live-elapsed-time math added. Shared by the desktop Dashboard
 * panel and the mobile Dashboard tab, each owning its own day selection —
 * same as how the app's own Dashboard date input works independently per
 * instance.
 */
function buildDashboardBlock(container: HTMLElement): { render(input: DashboardRenderInput): void } {
  let day: DashboardDay = "today";
  let latestInput: DashboardRenderInput | null = null;

  const dateRow = document.createElement("div");
  dateRow.className = "dashboard-date-row";
  dateRow.appendChild(
    buildToggleGroup(
      [
        ["today", "Today"],
        ["yesterday", "Yesterday"],
      ] as const,
      "today",
      (value) => {
        day = value;
        renderCurrent();
      },
      "day-link",
    ),
  );
  container.appendChild(dateRow);

  const { goalHeading, goalList, activityHeading, activityList } = buildDashboardSections(container);

  function renderCurrent() {
    if (!latestInput) return;
    const {
      goals,
      todayMinutesByLabel,
      yesterdayMinutesByLabel,
      streaksByGoalId,
      activityLabel: runningLabel,
      startedAtMs,
      colorByLabel,
    } = latestInput;
    const isToday = day === "today";

    goalHeading.textContent = isToday ? "Today's Goals" : "Yesterday's Goals";
    activityHeading.textContent = isToday ? "Today's Activity" : "Yesterday's Activity";

    const date = isToday ? new Date() : parseDateString(addDaysToDateString(localDateString(new Date()), -1));
    const dateStr = localDateString(date);
    const minutesByLabel = isToday ? todayMinutesByLabel : yesterdayMinutesByLabel;
    const liveElapsedMinutes = isToday && startedAtMs ? (Date.now() - startedAtMs) / 60000 : 0;

    const goalEntries = groupGoalsForDate(goals, date).map(({ activityLabel, targetMinutes, goals: groupGoals }) => {
      const minutes = (minutesByLabel[activityLabel] ?? 0) + (activityLabel === runningLabel ? liveElapsedMinutes : 0);
      return {
        activityLabel,
        minutes,
        targetMinutes,
        done: minutes >= targetMinutes,
        subRows: groupGoals.map((g) => {
          const streakText = formatStreak(streaksByGoalId[g.id] ?? 0, g.highestStreak ?? 0);
          return `${describeScheduleForDate(g.recurrence, dateStr)} — ${formatMinutes(g.targetMinutes)}${streakText ? ` — ${streakText}` : ""}`;
        }),
      };
    });
    renderGoalList(goalList, goalEntries, isToday ? "No goals today" : "No goals yesterday");

    const activityEntries = Object.entries(minutesByLabel)
      .map(([label, minutes]) => ({
        label,
        color: colorByLabel.get(label) ?? 0xffffff,
        minutes: minutes + (label === runningLabel ? liveElapsedMinutes : 0),
      }))
      .filter((e) => e.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);
    renderActivityList(activityList, activityEntries, isToday ? "Nothing tracked today" : "Nothing tracked yesterday");
  }

  return {
    render(input) {
      latestInput = input;
      renderCurrent();
    },
  };
}

/**
 * All-Time Activity pie (same as before — no All-Time Goals here, since
 * goal completion/skip history never leaves the desktop app) plus a Period
 * tab fed from the 4 fixed windows pushed to val.town (This Week/Last
 * Week/This Month/Last Month, see dashboard/periodStats.ts): the viewer
 * has no AW access to run its own arbitrary-range queries, so it picks
 * from this fixed list instead of a free date picker like the desktop
 * Statistic modal's own Period tab. Shared by the desktop-viewport
 * Statistic modal and the mobile Statistic tab.
 */
function buildStatisticBlock(container: HTMLElement): {
  renderAllTime(stats: ActivityStat[]): void;
  renderPeriod(periods: FixedPeriodStats[]): void;
} {
  let latestPeriods: FixedPeriodStats[] = [];
  let selectedKey: FixedPeriodKey = "thisWeek";

  const tabsRow = document.createElement("div");
  tabsRow.className = "stat-tabs";
  container.appendChild(tabsRow);

  const allTimeSection = document.createElement("div");
  container.appendChild(allTimeSection);

  const periodSection = document.createElement("div");
  periodSection.style.display = "none";
  container.appendChild(periodSection);

  tabsRow.appendChild(
    buildToggleGroup(
      [
        ["all", "All Time"],
        ["period", "Period"],
      ] as const,
      "all",
      (tab) => {
        allTimeSection.style.display = tab === "all" ? "" : "none";
        periodSection.style.display = tab === "period" ? "" : "none";
      },
      "stat-tab",
    ),
  );

  // --- All Time ---

  const heading = document.createElement("h3");
  heading.className = "panel-section-heading";
  heading.textContent = "All-Time Activity (top 5)";
  allTimeSection.appendChild(heading);

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  allTimeSection.appendChild(pie);

  const list = document.createElement("div");
  list.className = "dashboard-list";
  allTimeSection.appendChild(list);

  // --- Period: fixed buckets only, no date picker (see function comment). ---

  const controlsRow = document.createElement("div");
  controlsRow.className = "stat-period-controls";
  periodSection.appendChild(controlsRow);

  controlsRow.appendChild(
    buildToggleGroup(
      [
        ["thisWeek", "This Week"],
        ["lastWeek", "Last Week"],
        ["thisMonth", "This Month"],
        ["lastMonth", "Last Month"],
      ] as const,
      "thisWeek",
      (key) => {
        selectedKey = key;
        renderSelectedPeriod();
      },
    ),
  );

  const periodGoalsHeading = document.createElement("h3");
  periodGoalsHeading.className = "panel-section-heading";
  periodGoalsHeading.textContent = "Period Goals";
  periodSection.appendChild(periodGoalsHeading);

  const periodGoalsList = document.createElement("div");
  periodGoalsList.className = "dashboard-list";
  periodSection.appendChild(periodGoalsList);

  const periodOutcomesHeading = document.createElement("h3");
  periodOutcomesHeading.className = "panel-section-heading";
  periodOutcomesHeading.textContent = "Period Goal Outcomes";
  periodSection.appendChild(periodOutcomesHeading);

  const periodOutcomesList = document.createElement("div");
  periodSection.appendChild(periodOutcomesList);

  const periodActivityHeading = document.createElement("h3");
  periodActivityHeading.className = "panel-section-heading";
  periodActivityHeading.textContent = "Period Activity";
  periodSection.appendChild(periodActivityHeading);

  const periodPie = document.createElement("div");
  periodPie.id = "dashboard-period-pie";
  periodSection.appendChild(periodPie);

  const periodActivityList = document.createElement("div");
  periodActivityList.className = "dashboard-list";
  periodSection.appendChild(periodActivityList);

  function renderSelectedPeriod() {
    const period = latestPeriods.find((p) => p.key === selectedKey);
    periodGoalsHeading.textContent = period ? `Period Goals — ${period.label}` : "Period Goals";
    renderGoalList(
      periodGoalsList,
      (period?.goalProgress ?? []).map((p) => ({ ...p, subRows: [] })),
      "No goals that period",
    );
    renderGoalOutcomes(periodOutcomesList, {
      mostCompleted: period?.mostCompleted ?? null,
      mostSkipped: period?.mostSkipped ?? null,
    });
    renderAllTimeActivity(periodPie, periodActivityList, period?.activityStats ?? []);
  }

  return {
    renderAllTime(stats) {
      renderAllTimeActivity(pie, list, stats);
    },
    renderPeriod(periods) {
      latestPeriods = periods;
      renderSelectedPeriod();
    },
  };
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
  const dashboardDesktop = buildDashboardBlock(dashboardPanel.body);
  dashboardPanel.open();

  // --- Statistic modal: All-Time Activity section + Period tab, same shape the desktop app's Statistic modal has. ---
  const statisticModal = buildModal("Statistic", { size: "large", resizable: true });
  const statisticDesktop = buildStatisticBlock(statisticModal.body);

  setupTopButtons([
    {
      label: "Statistic",
      onclick: () => {
        statisticModal.open();
        statisticDesktop.renderAllTime(latestStats);
        statisticDesktop.renderPeriod(latestPeriodStats);
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

  const dashboardMobile = buildDashboardBlock(mobileTabs.pages.dashboard);

  const statisticMobile = buildStatisticBlock(mobileTabs.pages.statistic);

  mobileSettingsUI = buildDisplaySettingsSection(mobileTabs.pages.settings, viewerSettings, displaySettingsCallbacks);

  mobileTabs.onTabChange((tab) => {
    if (tab === "statistic") {
      statisticMobile.renderAllTime(latestStats);
      statisticMobile.renderPeriod(latestPeriodStats);
    }
  });

  let latestStats: ActivityStat[] = [];
  let latestPeriodStats: FixedPeriodStats[] = [];
  let startedAtMs: number | null = null;
  let latestActivityLabel: string | null = null;
  let latestTodayMinutesByLabel: Record<string, number> = {};
  let latestYesterdayMinutesByLabel: Record<string, number> = {};
  let latestStreaksByGoalId: Record<string, number> = {};
  let latestGoals: Goal[] = [];
  let lastSyncAt: Date | null = null;
  let lastSyncError: string | null = null;

  function renderDashboards() {
    const input: DashboardRenderInput = {
      goals: latestGoals,
      todayMinutesByLabel: latestTodayMinutesByLabel,
      yesterdayMinutesByLabel: latestYesterdayMinutesByLabel,
      streaksByGoalId: latestStreaksByGoalId,
      activityLabel: latestActivityLabel,
      startedAtMs,
      colorByLabel: new Map(latestStats.map((s) => [s.label, s.color] as const)),
    };
    dashboardDesktop.render(input);
    dashboardMobile.render(input);
  }

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
      const [statusRes, goalsRes, statsRes, periodStatsRes, yesterdayRes, streaksRes] = await Promise.all([
        fetch(`${STATUS_API_BASE}/api/status`),
        fetch(`${STATUS_API_BASE}/api/goals`),
        fetch(`${STATUS_API_BASE}/api/stats`),
        fetch(`${STATUS_API_BASE}/api/period-stats`),
        fetch(`${STATUS_API_BASE}/api/yesterday`),
        fetch(`${STATUS_API_BASE}/api/streaks`),
      ]);
      const data: StatusResponse = await statusRes.json();
      latestGoals = await goalsRes.json();
      latestStats = await statsRes.json();
      latestPeriodStats = await periodStatsRes.json();
      latestYesterdayMinutesByLabel = await yesterdayRes.json();
      latestStreaksByGoalId = await streaksRes.json();

      latestActivityLabel = data.activityLabel;
      latestTodayMinutesByLabel = data.todayMinutesByLabel;
      startedAtMs = data.startedAt ? new Date(data.startedAt).getTime() : null;

      renderCurrent();
      viewer.showActivity(data.activityLabel ? { label: data.activityLabel } : null);

      lastSyncAt = new Date();
      lastSyncError = null;
      renderSync();
      renderDashboards();
    } catch (err) {
      console.error("[viewer] failed to fetch status", err);
      renderCurrentDesktop.showError("Couldn't load status");
      renderCurrentMobile.showError("Couldn't load status");
      lastSyncError = (err as Error).message;
      renderSync();
    }
  }

  function tickElapsed() {
    renderCurrent();
    renderDashboards();
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
