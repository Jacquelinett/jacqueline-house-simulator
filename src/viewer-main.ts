import { Application } from "pixi.js";
import { HouseViewer, preloadRoomAssets } from "./scene/viewer";
import { Goal } from "./goals/types";
import { describeScheduleForToday, groupTodaysGoals } from "./goals/todayGroups";
import { buildModal } from "./ui/modal";
import { buildDashboardSections, renderActivityList, renderGoalList } from "./dashboard/render";
import { renderCurrentActivity, renderSyncStatus } from "./status/render";

// Edit this to your own deployed val.town status val before building/hosting
// this page — it's the only thing that needs to change per-deployment.
const STATUS_API_BASE = "https://jacquelinett--6dc86500cd6211f1876a1607ee4eb77e.web.val.run";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface ViewerSettings {
  scale: number;
  devMode: boolean;
}

const VIEWER_SETTINGS_KEY = "houseSimulatorViewerSettings";

// No desktop-app-style Tauri fs here — this is a public static page, so
// localStorage is the whole persistence story (per-browser, not per-person;
// fine for "remember how I like to view this on my own screen").
function loadViewerSettings(): ViewerSettings {
  try {
    const raw = localStorage.getItem(VIEWER_SETTINGS_KEY);
    if (raw) return { scale: 2, devMode: false, ...JSON.parse(raw) };
  } catch {
    // ignore corrupt/inaccessible storage, just fall through to defaults
  }
  return { scale: 2, devMode: false };
}

function saveViewerSettings(settings: ViewerSettings) {
  localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify(settings));
}

interface StatusResponse {
  activityLabel: string | null;
  startedAt: string | null;
  todayMinutesByLabel: Record<string, number>;
}

interface ActivityStat {
  label: string;
  color: number;
  totalMinutesAllTime: number;
  averageMinutesPerDay: number;
}

function toCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function setupFloorButtons(viewer: HouseViewer) {
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
    btn.onclick = () => viewer.goToRoom(roomId);
    container.appendChild(btn);
  }
  document.body.appendChild(container);
}

/** Zoom + dev-mode outlines, independent of the desktop app's own Settings — lets anyone viewing on a bigger/smaller screen adjust to taste (and is handy for testing the viewer itself). */
function setupSettings(viewer: HouseViewer, settings: ViewerSettings) {
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

  const topButtons = document.createElement("div");
  topButtons.id = "top-buttons";
  const settingsBtn = document.createElement("button");
  settingsBtn.textContent = "Settings";
  settingsBtn.onclick = modal.open;
  topButtons.appendChild(settingsBtn);
  document.body.appendChild(topButtons);
}

async function main() {
  const app = new Application();
  await app.init({ background: "#1a1a1a", resolution: window.devicePixelRatio || 1, autoDensity: true });
  document.querySelector<HTMLDivElement>("#app")!.appendChild(app.canvas);

  function syncRendererSize() {
    app.renderer.resolution = window.devicePixelRatio || 1;
    app.renderer.resize(window.innerWidth, window.innerHeight);
  }
  syncRendererSize();
  window.addEventListener("resize", syncRendererSize);

  const viewerSettings = loadViewerSettings();

  const roomLabelEl = document.querySelector<HTMLDivElement>("#room-label")!;
  await preloadRoomAssets();
  const viewer = new HouseViewer(
    app,
    (name) => {
      roomLabelEl.textContent = name;
    },
    viewerSettings,
  );

  setupFloorButtons(viewer);
  setupSettings(viewer, viewerSettings);

  const statusEl = document.querySelector<HTMLDivElement>("#viewer-status")!;
  const syncEl = document.querySelector<HTMLDivElement>("#viewer-sync")!;
  const dashboardEl = document.querySelector<HTMLDivElement>("#viewer-dashboard")!;
  const { goalList, activityList } = buildDashboardSections(dashboardEl);
  const statsPieEl = document.querySelector<HTMLDivElement>("#viewer-stats-pie")!;
  const statsListEl = document.querySelector<HTMLDivElement>("#viewer-stats-list")!;

  let startedAtMs: number | null = null;
  let latestActivityLabel: string | null = null;
  let latestTodayMinutesByLabel: Record<string, number> = {};
  let latestGoals: Goal[] = [];
  let latestStats: ActivityStat[] = [];
  let lastSyncAt: Date | null = null;
  let lastSyncError: string | null = null;

  function renderCurrent() {
    renderCurrentActivity(statusEl, {
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
      const stats: ActivityStat[] = await statsRes.json();

      latestActivityLabel = data.activityLabel;
      latestTodayMinutesByLabel = data.todayMinutesByLabel;
      latestStats = stats;
      startedAtMs = data.startedAt ? new Date(data.startedAt).getTime() : null;

      renderCurrent();
      viewer.showActivity(data.activityLabel ? { label: data.activityLabel } : null);

      lastSyncAt = new Date();
      lastSyncError = null;
      renderSync();
      renderGoals();
      renderTodayActivity();
      renderStats(stats);
    } catch (err) {
      console.error("[viewer] failed to fetch status", err);
      statusEl.textContent = "Couldn't load status";
      lastSyncError = (err as Error).message;
      renderSync();
    }
  }

  // Stats are color-coded by activity (same colors the in-app Dashboard
  // uses) — pushed on a slow cadence by the app itself, so this is just
  // rendering whatever was last pushed, same as the goals/status above.
  function renderStats(stats: ActivityStat[]) {
    const dailyTotal = stats.reduce((sum, s) => sum + s.averageMinutesPerDay, 0);
    if (dailyTotal > 0) {
      let cursor = 0;
      const stops: string[] = [];
      for (const s of stats) {
        if (s.averageMinutesPerDay <= 0) continue;
        const start = (cursor / dailyTotal) * 100;
        cursor += s.averageMinutesPerDay;
        const end = (cursor / dailyTotal) * 100;
        stops.push(`${toCssColor(s.color)} ${start}% ${end}%`);
      }
      statsPieEl.style.background = `conic-gradient(${stops.join(", ")})`;
    } else {
      statsPieEl.style.background = "rgba(255, 255, 255, 0.1)";
    }

    statsListEl.textContent = "";
    for (const s of stats) {
      if (s.totalMinutesAllTime <= 0) continue;
      const row = document.createElement("div");
      row.className = "viewer-stat-row";

      const swatch = document.createElement("span");
      swatch.className = "viewer-stat-swatch";
      swatch.style.background = toCssColor(s.color);
      row.appendChild(swatch);

      const text = document.createElement("span");
      text.textContent = `${s.label} — ${formatMinutes(s.totalMinutesAllTime)} total`;
      row.appendChild(text);

      statsListEl.appendChild(row);
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

  const authorInput = document.querySelector<HTMLInputElement>("#viewer-author")!;
  const textInput = document.querySelector<HTMLTextAreaElement>("#viewer-text")!;
  const sendBtn = document.querySelector<HTMLButtonElement>("#viewer-send")!;
  const sendStatusEl = document.querySelector<HTMLDivElement>("#viewer-send-status")!;

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
