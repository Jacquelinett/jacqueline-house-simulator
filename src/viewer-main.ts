import { Application } from "pixi.js";
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
import { Theme } from "./settings/types";
import { THEME_BACKGROUND } from "./settings/themes";

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

/** Top-right row of page-level actions — mirrors the desktop app's own setupTopButtons(). */
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

/** Zoom + dev-mode outlines, independent of the desktop app's own Settings — lets anyone viewing on a bigger/smaller screen adjust to taste (and is handy for testing the viewer itself). */
function setupSettings(
  viewer: HouseViewer,
  settings: ViewerSettings,
  applyTheme: (theme: Theme) => void,
): { open: () => void } {
  const modal = buildModal("Settings");

  const devModeLabel = document.createElement("label");
  devModeLabel.className = "settings-checkbox-row";
  const devModeCheckbox = document.createElement("input");
  devModeCheckbox.type = "checkbox";
  devModeCheckbox.checked = settings.devMode;
  devModeLabel.appendChild(devModeCheckbox);
  devModeLabel.appendChild(document.createTextNode(" Dev mode (show hitbox outlines)"));
  modal.body.appendChild(devModeLabel);
  devModeCheckbox.onchange = () => {
    settings.devMode = devModeCheckbox.checked;
    viewer.setDevMode(settings.devMode);
    saveViewerSettings(settings);
  };

  const themeRow = document.createElement("label");
  themeRow.className = "settings-scale-row";
  themeRow.textContent = "Theme";
  const themeSelect = document.createElement("select");
  for (const [value, label] of [
    ["dark", "Dark"],
    ["pink", "Pink"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    themeSelect.appendChild(opt);
  }
  themeSelect.value = settings.theme;
  themeRow.appendChild(themeSelect);
  modal.body.appendChild(themeRow);
  themeSelect.onchange = () => {
    settings.theme = themeSelect.value as Theme;
    applyTheme(settings.theme);
    saveViewerSettings(settings);
  };

  const scaleRow = document.createElement("label");
  scaleRow.className = "settings-scale-row";
  scaleRow.textContent = "Zoom";
  const scaleInput = document.createElement("input");
  scaleInput.type = "range";
  scaleInput.min = "1";
  scaleInput.max = "4";
  scaleInput.step = "0.25";
  scaleInput.value = String(settings.scale);
  scaleRow.appendChild(scaleInput);
  const scaleValue = document.createElement("span");
  scaleValue.className = "settings-scale-value";
  scaleValue.textContent = `${settings.scale}×`;
  scaleRow.appendChild(scaleValue);
  modal.body.appendChild(scaleRow);
  scaleInput.oninput = () => {
    scaleValue.textContent = `${scaleInput.value}×`;
  };
  scaleInput.onchange = () => {
    settings.scale = Number(scaleInput.value);
    viewer.setScale(settings.scale);
    saveViewerSettings(settings);
  };

  return { open: modal.open };
}

async function main() {
  // Unlike the desktop app (where settings load async from Tauri fs, so
  // the initial Pixi/CSS theme has to guess the default and get corrected
  // once settings actually load), localStorage here is synchronous — the
  // real saved theme is already known before anything renders, no flash.
  const viewerSettings = loadViewerSettings();
  document.documentElement.dataset.theme = viewerSettings.theme;

  const app = new Application();
  await app.init({
    background: THEME_BACKGROUND[viewerSettings.theme],
    resolution: window.devicePixelRatio || 1,
    autoDensity: true,
  });
  document.querySelector<HTMLDivElement>("#app")!.appendChild(app.canvas);

  function applyTheme(theme: Theme) {
    document.documentElement.dataset.theme = theme;
    app.renderer.background.color = THEME_BACKGROUND[theme];
  }

  function syncRendererSize() {
    app.renderer.resolution = window.devicePixelRatio || 1;
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }
  syncRendererSize();
  window.addEventListener("resize", syncRendererSize);

  const roomLabelEl = document.querySelector<HTMLDivElement>("#room-label")!;

  // The room-change callback fires synchronously inside the HouseViewer
  // constructor (for the initial room), before setupFloorButtons() below
  // even runs — this placeholder captures that first name so it can be
  // applied once the real updater exists, instead of the floor buttons
  // just not reflecting the starting room until the next navigation.
  let initialRoomName = "";
  let updateFloorButtons: (name: string) => void = (name) => {
    initialRoomName = name;
  };

  await preloadRoomAssets();
  const viewer = new HouseViewer(
    app,
    (name) => {
      roomLabelEl.textContent = name;
      updateFloorButtons(name);
    },
    viewerSettings,
  );

  updateFloorButtons = setupFloorButtons((roomId) => viewer.goToRoom(roomId));
  updateFloorButtons(initialRoomName);

  const settingsModal = setupSettings(viewer, viewerSettings, applyTheme);

  // --- Jacqueline panel: same corner panel the desktop app has, minus the
  // AW line (no AW access here) and plus "Leave a note" (viewer-only). ---
  const jacquelinePanel = buildFloatingPanel(CURRENT_USER_NAME, {
    closable: false,
    draggable: false,
    className: "goals-panel",
  });

  const currentEl = document.createElement("div");
  currentEl.className = "overview-current";
  jacquelinePanel.body.appendChild(currentEl);

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

  const syncEl = document.createElement("div");
  syncEl.className = "overview-status-line";
  jacquelinePanel.body.appendChild(syncEl);

  jacquelinePanel.open();

  // --- Dashboard panel: identical to the desktop app's, same position. ---
  const dashboardPanel = buildFloatingPanel("Dashboard", { closable: false, className: "dashboard-panel" });
  const { goalList, activityList } = buildDashboardSections(dashboardPanel.body);
  dashboardPanel.open();

  // --- Statistic modal: same all-time Activity section the desktop app's
  // Statistic modal has. No All-Time Goals here — goal completion/skip
  // history never leaves the desktop app (nothing pushes it to val.town). ---
  const statisticModal = buildModal("Statistic", { size: "large" });
  const statisticHeading = document.createElement("h3");
  statisticHeading.className = "panel-section-heading";
  statisticHeading.textContent = "All-Time Activity (top 5)";
  statisticModal.body.appendChild(statisticHeading);
  const statisticPie = document.createElement("div");
  statisticPie.id = "dashboard-pie";
  statisticModal.body.appendChild(statisticPie);
  const statisticList = document.createElement("div");
  statisticList.className = "dashboard-list";
  statisticModal.body.appendChild(statisticList);

  let latestStats: ActivityStat[] = [];
  setupTopButtons([
    {
      label: "Statistic",
      onclick: () => {
        statisticModal.open();
        renderAllTimeActivity(statisticPie, statisticList, latestStats);
      },
    },
    { label: "Settings", onclick: settingsModal.open },
  ]);

  let startedAtMs: number | null = null;
  let latestActivityLabel: string | null = null;
  let latestTodayMinutesByLabel: Record<string, number> = {};
  let latestGoals: Goal[] = [];
  let lastSyncAt: Date | null = null;
  let lastSyncError: string | null = null;

  function renderCurrent() {
    renderCurrentActivity(currentEl, {
      label: latestActivityLabel,
      startedAt: startedAtMs ? new Date(startedAtMs) : null,
    });
  }

  // "Synced" here means "last successfully fetched data from val.town" —
  // the viewer only ever polls, it never pushes, so this is the mirror
  // image of the desktop app's own VT sync indicator. No AW line at all,
  // since the viewer has no AW access regardless of connection state.
  function renderSync() {
    renderSyncStatus(syncEl, {
      showAw: false,
      vt: { configured: true, lastSuccessAt: lastSyncAt, lastError: lastSyncError },
    });
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
      currentEl.textContent = "Couldn't load status";
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
    renderGoalList(
      goalList,
      groups.map(({ activityLabel, targetMinutes, goals }) => {
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
      }),
    );
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
      const res = await fetch(`${STATUS_API_BASE}/api/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, author: authorInput.value.trim() }),
      });
      if (!res.ok) throw new Error((await res.json()).error || "failed to send");
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
