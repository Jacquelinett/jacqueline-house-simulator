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

/**
 * Always-visible corner panel: who's using the house, what they're doing
 * right now, and connection health. Goal progress used to live here too but
 * moved to the Dashboard panel — showing it in both places was redundant.
 *
 * Title is hardcoded to the one current user for now; once there's a
 * second household user, this becomes whichever name the active session
 * belongs to instead of a constant.
 */
const CURRENT_USER_NAME = "Jacqueline";

export function setupGoalsPanel(): void {
  // Same title-bar component the Dashboard uses, just not closable (always
  // visible, no button that opens it) and not draggable (always lives in
  // the same corner — nothing to gain from being able to move it).
  const panel = buildFloatingPanel(CURRENT_USER_NAME, {
    closable: false,
    draggable: false,
    className: "goals-panel",
  });

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

  const divider = document.createElement("div");
  divider.className = "panel-divider";
  panel.body.appendChild(divider);

  // AW connection only gets checked once at startup (if it fails, the app
  // bails before this panel ever exists), so this is always "Connected"
  // once shown — still worth labeling explicitly to make clear AW being
  // connected and VT being synced are two independent things. VT sync, on
  // the other hand, genuinely can fail/retry on its own (bad secret,
  // network blip) — a failed push used to go completely unnoticed (fetch()
  // doesn't reject on HTTP error statuses), so this stays the one place
  // that's always visible without needing devtools open.
  const statusLine = document.createElement("div");
  statusLine.className = "overview-status-line";
  panel.body.appendChild(statusLine);

  const awStatusEl = document.createElement("span");
  awStatusEl.className = "status-ok";
  awStatusEl.textContent = "AW: Connected";
  statusLine.appendChild(awStatusEl);

  const vtSepEl = document.createTextNode(" | ");
  statusLine.appendChild(vtSepEl);

  const vtStatusEl = document.createElement("span");
  statusLine.appendChild(vtStatusEl);

  function renderBroadcastStatus() {
    if (!getSettings().broadcastUrl) {
      vtStatusEl.textContent = "VT: Not configured";
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

  onBroadcastHealthChange(renderBroadcastStatus);
  renderBroadcastStatus();
  setInterval(renderBroadcastStatus, REFRESH_INTERVAL_MS);

  renderCurrent();
  setInterval(renderCurrent, CURRENT_TICK_MS);

  panel.open();
}
