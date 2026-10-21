import { getGoals, onGoalsChange, todayDateString } from "./state";
import { getTodayGoalProgress } from "./progress";
import { formatMinutes, describeRecurrence } from "./ui";
import { isScheduledOn } from "./recurrence";
import { getBroadcastHealth, onBroadcastHealthChange } from "../broadcast/client";
import { getSettings } from "../settings/state";

const REFRESH_INTERVAL_MS = 30_000;

function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/** Read-only view of today's goals and progress — all editing lives in the manage modal (opened from the top-right "Goals" button). */
export async function setupGoalsPanel(): Promise<void> {
  const panel = document.createElement("div");
  panel.id = "goals-panel";
  document.body.appendChild(panel);

  const list = document.createElement("div");
  list.id = "goals-list";
  panel.appendChild(list);

  // Only shown once broadcasting is actually configured — a failed push
  // used to go completely unnoticed (fetch() doesn't reject on HTTP error
  // statuses), so this is the one place that's always visible without
  // needing devtools open.
  const broadcastStatusEl = document.createElement("div");
  broadcastStatusEl.id = "broadcast-status";
  panel.appendChild(broadcastStatusEl);

  function renderBroadcastStatus() {
    if (!getSettings().broadcastUrl) {
      broadcastStatusEl.textContent = "";
      return;
    }
    const { lastSuccessAt, lastError } = getBroadcastHealth();
    broadcastStatusEl.classList.toggle("broadcast-status-error", !!lastError);
    broadcastStatusEl.textContent = lastError
      ? `⚠ Sync failed: ${lastError}`
      : lastSuccessAt
        ? `Synced ${formatRelativeTime(lastSuccessAt)}`
        : "Not yet synced";
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
        subText.textContent = `${describeRecurrence(goal.recurrence)} — ${formatMinutes(goal.targetMinutes)}`;
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
}
