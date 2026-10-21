import { Application } from "pixi.js";
import { HouseViewer, preloadRoomAssets } from "./scene/viewer";
import { isScheduledOn, localDateString } from "./goals/recurrence";
import { Goal } from "./goals/types";

// Edit this to your own deployed val.town status val before building/hosting
// this page — it's the only thing that needs to change per-deployment.
const STATUS_API_BASE = "https://jacquelinett--6dc86500cd6211f1876a1607ee4eb77e.web.val.run";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

interface StatusResponse {
  activityLabel: string | null;
  startedAt: string | null;
  todayMinutesByLabel: Record<string, number>;
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

function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
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

  await preloadRoomAssets();
  const viewer = new HouseViewer(app, () => {}, { devMode: false, scale: 2 });

  const activityEl = document.querySelector<HTMLDivElement>("#viewer-activity")!;
  const elapsedEl = document.querySelector<HTMLDivElement>("#viewer-elapsed")!;
  const goalsEl = document.querySelector<HTMLDivElement>("#viewer-goals")!;

  let startedAtMs: number | null = null;
  let latestActivityLabel: string | null = null;
  let latestTodayMinutesByLabel: Record<string, number> = {};
  let latestGoals: Goal[] = [];

  async function refreshStatus() {
    try {
      const [statusRes, goalsRes] = await Promise.all([
        fetch(`${STATUS_API_BASE}/api/status`),
        fetch(`${STATUS_API_BASE}/api/goals`),
      ]);
      const data: StatusResponse = await statusRes.json();
      latestGoals = await goalsRes.json();

      latestActivityLabel = data.activityLabel;
      latestTodayMinutesByLabel = data.todayMinutesByLabel;
      startedAtMs = data.startedAt ? new Date(data.startedAt).getTime() : null;

      activityEl.textContent = data.activityLabel
        ? `Currently: ${data.activityLabel}`
        : "Not currently doing anything tracked";
      viewer.showActivity(data.activityLabel ? { label: data.activityLabel } : null);

      renderGoals();
    } catch (err) {
      console.error("[viewer] failed to fetch status", err);
      activityEl.textContent = "Couldn't load status";
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
    }
  }

  function tickElapsed() {
    elapsedEl.textContent = startedAtMs ? `Running for ${formatElapsed(Date.now() - startedAtMs)}` : "";
    renderGoals();
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
