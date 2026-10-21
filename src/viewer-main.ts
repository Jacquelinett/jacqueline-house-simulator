import { Application } from "pixi.js";
import { HouseViewer, preloadRoomAssets } from "./scene/viewer";
import { isScheduledOn, localDateString } from "./goals/recurrence";
import { Goal, Recurrence } from "./goals/types";
import { describeRecurrence } from "./goals/ui";
import { buildModal } from "./ui/modal";

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

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(hh > 0 ? 2 : 1, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

function formatClock(date: Date): string {
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// This panel only ever shows goals scheduled for today, so a one-off goal's
// literal date is always just... today — showing it plainly is clearer than
// the generic "once (2026-10-21)" phrasing describeRecurrence() uses
// elsewhere (mirrors the same helper in goals/panel.ts and dashboard/panel.ts).
function describeScheduleForToday(recurrence: Recurrence): string {
  return recurrence.type === "once" ? "Today" : describeRecurrence(recurrence);
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

  const activityEl = document.querySelector<HTMLDivElement>("#viewer-activity")!;
  const elapsedEl = document.querySelector<HTMLDivElement>("#viewer-elapsed")!;
  const syncEl = document.querySelector<HTMLDivElement>("#viewer-sync")!;
  const goalsEl = document.querySelector<HTMLDivElement>("#viewer-goals")!;
  const todayActivityEl = document.querySelector<HTMLDivElement>("#viewer-today-activity")!;
  const statsPieEl = document.querySelector<HTMLDivElement>("#viewer-stats-pie")!;
  const statsListEl = document.querySelector<HTMLDivElement>("#viewer-stats-list")!;

  let startedAtMs: number | null = null;
  let latestActivityLabel: string | null = null;
  let latestTodayMinutesByLabel: Record<string, number> = {};
  let latestGoals: Goal[] = [];
  let latestStats: ActivityStat[] = [];
  let lastSyncAt: Date | null = null;

  // "Synced" here means "last successfully fetched data from val.town" —
  // the viewer only ever polls, it never pushes, so this is the mirror
  // image of the desktop app's own VT sync indicator.
  function renderSync() {
    syncEl.textContent = lastSyncAt ? `VT: Synced ${formatRelativeTime(lastSyncAt)}` : "VT: Not yet synced";
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

      activityEl.textContent = `I'm currently: ${data.activityLabel ?? "idle"}`;
      viewer.showActivity(data.activityLabel ? { label: data.activityLabel } : null);

      lastSyncAt = new Date();
      renderSync();
      renderGoals();
      renderTodayActivity();
      renderStats(stats);
    } catch (err) {
      console.error("[viewer] failed to fetch status", err);
      activityEl.textContent = "Couldn't load status";
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
  // progress need a fresh fetch to stay accurate.
  function renderGoals() {
    const today = new Date();
    const todayStr = localDateString(today);
    const scheduled = latestGoals.filter(
      (g) => isScheduledOn(g.recurrence, today) && !g.skipDates?.includes(todayStr),
    );

    const groups = new Map<string, Goal[]>();
    for (const g of scheduled) {
      const group = groups.get(g.activityLabel);
      if (group) group.push(g);
      else groups.set(g.activityLabel, [g]);
    }

    goalsEl.textContent = "";
    if (groups.size === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No goals today";
      goalsEl.appendChild(empty);
      return;
    }

    for (const [activityLabel, group] of groups) {
      const targetMinutes = group.reduce((sum, g) => sum + g.targetMinutes, 0);
      const baselineMinutes = latestTodayMinutesByLabel[activityLabel] ?? 0;
      const liveMinutes =
        baselineMinutes + (activityLabel === latestActivityLabel && startedAtMs ? (Date.now() - startedAtMs) / 60000 : 0);
      const done = liveMinutes >= targetMinutes;

      const row = document.createElement("div");
      row.className = "viewer-goal-row" + (done ? " viewer-goal-done" : "");
      row.textContent = `${done ? "☑" : "☐"} ${activityLabel} — ${formatMinutes(liveMinutes)} / ${formatMinutes(targetMinutes)}`;
      goalsEl.appendChild(row);

      // group is already exactly today's contributing goals for this label
      // (filtered + grouped above), so no need to re-derive it from scratch.
      for (const goal of group) {
        const subRow = document.createElement("div");
        subRow.className = "viewer-goal-subrow";
        subRow.textContent = `${describeScheduleForToday(goal.recurrence)} — ${formatMinutes(goal.targetMinutes)}`;
        goalsEl.appendChild(subRow);
      }
    }
  }

  // Mirrors the desktop Dashboard's "Today Activity" list — same
  // todayMinutesByLabel the goal progress above uses, just not filtered
  // down to activities with a goal attached.
  function renderTodayActivity() {
    todayActivityEl.textContent = "";
    const colorByLabel = new Map(latestStats.map((s) => [s.label, s.color] as const));
    const entries = Object.entries(latestTodayMinutesByLabel)
      .map(([label, minutes]) => ({
        label,
        color: colorByLabel.get(label) ?? 0xffffff,
        minutes: minutes + (label === latestActivityLabel && startedAtMs ? (Date.now() - startedAtMs) / 60000 : 0),
      }))
      .filter((e) => e.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "Nothing tracked today";
      todayActivityEl.appendChild(empty);
      return;
    }

    for (const e of entries) {
      const row = document.createElement("div");
      row.className = "viewer-stat-row";

      const swatch = document.createElement("span");
      swatch.className = "viewer-stat-swatch";
      swatch.style.background = toCssColor(e.color);
      row.appendChild(swatch);

      const text = document.createElement("span");
      text.textContent = `${e.label} — ${formatMinutes(e.minutes)}`;
      row.appendChild(text);

      todayActivityEl.appendChild(row);
    }
  }

  function tickElapsed() {
    elapsedEl.textContent = startedAtMs
      ? `Started: ${formatClock(new Date(startedAtMs))} | ${formatElapsed(Date.now() - startedAtMs)}`
      : "";
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
