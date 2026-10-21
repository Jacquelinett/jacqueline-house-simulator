import { getBroadcastHealth, onBroadcastHealthChange } from "../broadcast/client";
import { getSettings } from "../settings/state";
import { buildFloatingPanel } from "../ui/draggablePanel";
import { getCurrentActivity } from "../aw/client";
import { renderCurrentActivity, renderSyncStatus } from "../status/render";

const REFRESH_INTERVAL_MS = 30_000;
const CURRENT_TICK_MS = 1000;

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
  // on" instead of two. Shared with the viewer's equivalent section.
  const currentEl = document.createElement("div");
  currentEl.className = "overview-current";
  panel.body.appendChild(currentEl);

  function renderCurrent() {
    const current = getCurrentActivity();
    renderCurrentActivity(currentEl, {
      label: current?.label ?? null,
      startedAt: current?.startedAt ?? null,
    });
  }

  const divider = document.createElement("div");
  divider.className = "panel-divider";
  panel.body.appendChild(divider);

  // AW connection only gets checked once at startup (if it fails, the app
  // bails before this panel ever exists), so this is always "Connected"
  // once shown — still worth labeling explicitly to make clear AW being
  // connected and VT being synced are two independent things. The desktop
  // app shows both; the viewer (no AW access at all) only ever gets VT.
  const statusLine = document.createElement("div");
  statusLine.className = "overview-status-line";
  panel.body.appendChild(statusLine);

  function renderStatus() {
    const { lastSuccessAt, lastError } = getBroadcastHealth();
    renderSyncStatus(statusLine, {
      showAw: true,
      vt: { configured: !!getSettings().broadcastUrl, lastSuccessAt, lastError },
    });
  }

  onBroadcastHealthChange(renderStatus);
  renderStatus();
  setInterval(renderStatus, REFRESH_INTERVAL_MS);

  renderCurrent();
  setInterval(renderCurrent, CURRENT_TICK_MS);

  panel.open();
}
