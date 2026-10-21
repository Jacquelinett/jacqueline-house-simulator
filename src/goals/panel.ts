import { getGoals, onGoalsChange, todayDateString } from "./state";
import { getTodayGoalProgress } from "./progress";
import { formatMinutes, describeRecurrence } from "./ui";
import { isScheduledOn } from "./recurrence";
import { Recurrence } from "./types";
import { getBroadcastHealth, onBroadcastHealthChange } from "../broadcast/client";
import { getSettings } from "../settings/state";
import { buildFloatingPanel } from "../ui/draggablePanel";
import { getCurrentActivity } from "../aw/client";

const REFRESH_INTERVAL_MS = 30_000;
const CURRENT_TICK_MS = 1000;

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function formatClock(date: Date): string {
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
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

// This panel only ever shows goals scheduled for today, so a one-off goal's
// literal date is always just... today — showing it plainly is clearer than
// the generic "once (2026-10-21)" phrasing describeRecurrence() uses
// elsewhere (e.g. the manage modal, where goals for OTHER days are visible
// too and the real date still matters there).
function describeScheduleForToday(recurrence: Recurrence): string {
  return recurrence.type === "once" ? "Today" : describeRecurrence(recurrence);
}

/** Read-only view of today's goals and progress — all editing lives in the manage modal (opened from the top-right "Goals" button). */
export async function setupGoalsPanel(): Promise<void> {
  // Same title-bar/drag-handle component the Dashboard uses, just not
  // closable — this one is always visible, there's no button that opens it.
  const panel = buildFloatingPanel("Today Overview", { closable: false, className: "goals-panel" });

  // What's running right now and since when — previously the separate
  // top-left #status box, moved here so it's one place for "what's going
  // on" instead of two.
  const currentEl = document.createElement("div");
  currentEl.className = "overview-current";
  panel.body.appendChild(currentEl);

  function renderCurrent() {
    const current = getCurrentActivity();
    currentEl.textContent = "";

    const activityLine = document.createElement("div");
    activityLine.textContent = `I'm currently: ${current ? current.label : "idle"}`;
    currentEl.appendChild(activityLine);

    if (current) {
      const startedLine = document.createElement("div");
      startedLine.className = "overview-started";
      const elapsed = formatElapsed(Date.now() - current.startedAt.getTime());
      startedLine.textContent = `Started: ${formatClock(current.startedAt)} | ${elapsed}`;
      currentEl.appendChild(startedLine);
    }
  }

  const goalHeading = document.createElement("div");
  goalHeading.className = "panel-section-heading";
  goalHeading.textContent = "Goal";
  panel.body.appendChild(goalHeading);

  const list = document.createElement("div");
  list.id = "goals-list";
  panel.body.appendChild(list);

  // AW connection only gets checked once at startup (if it fails, the app
  // bails before this panel ever exists), so this is always "Connected"
  // once shown — still worth labeling explicitly to make clear AW being
  // connected and VT being synced are two independent things. VT sync, on
  // the other hand, genuinely can fail/retry on its own (bad secret,
  // network blip) — a failed push used to go completely unnoticed (fetch()
  // doesn't reject on HTTP error statuses), so this stays the one place
  // that's always visible without needing devtools open.
  const awStatusEl = document.createElement("div");
  awStatusEl.className = "overview-status-line status-ok";
  awStatusEl.textContent = "AW: Connected";
  panel.body.appendChild(awStatusEl);

  const vtStatusEl = document.createElement("div");
  vtStatusEl.className = "overview-status-line";
  panel.body.appendChild(vtStatusEl);

  function renderBroadcastStatus() {
    if (!getSettings().broadcastUrl) {
      vtStatusEl.textContent = "";
      return;
    }
    const { lastSuccessAt, lastError } = getBroadcastHealth();
    vtStatusEl.classList.toggle("status-error", !!lastError);
    vtStatusEl.textContent = lastError
      ? `VT: Sync failed: ${lastError}`
      : lastSuccessAt
        ? `VT: Synced ${formatRelativeTime(lastSuccessAt)}`
        : "VT: Not yet synced";
  }

  async function render() {
    const progress = await getTodayGoalProgress();

    list.textContent = "";
    if (progress.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No goals today";
      list.appendChild(empty);
      return;
    }

    const today = new Date();
    const todayStr = todayDateString();

    for (const { activityLabel, minutes, targetMinutes, done } of progress) {
      const row = document.createElement("div");
      row.className = "goal-row" + (done ? " goal-done" : "");

      const check = document.createElement("span");
      check.className = "goal-check";
      check.textContent = done ? "☑" : "☐";
      row.appendChild(check);

      const text = document.createElement("span");
      text.className = "goal-text";
      text.textContent = `${activityLabel} — ${formatMinutes(minutes)} / ${formatMinutes(targetMinutes)}`;
      row.appendChild(text);

      list.appendChild(row);

      const contributing = getGoals().filter(
        (g) =>
          g.activityLabel === activityLabel &&
          isScheduledOn(g.recurrence, today) &&
          !g.skipDates?.includes(todayStr),
      );
      for (const goal of contributing) {
        const subRow = document.createElement("div");
        subRow.className = "goal-subrow";

        const subText = document.createElement("span");
        subText.className = "goal-subtext";
        subText.textContent = `${describeScheduleForToday(goal.recurrence)} — ${formatMinutes(goal.targetMinutes)}`;
        subRow.appendChild(subText);

        list.appendChild(subRow);
      }
    }
  }

  onGoalsChange(render);
  await render();
  setInterval(render, REFRESH_INTERVAL_MS);

  onBroadcastHealthChange(renderBroadcastStatus);
  renderBroadcastStatus();
  setInterval(renderBroadcastStatus, REFRESH_INTERVAL_MS);

  renderCurrent();
  setInterval(renderCurrent, CURRENT_TICK_MS);

  panel.open();
}
