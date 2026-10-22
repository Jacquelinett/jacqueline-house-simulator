import { getBroadcastHealth } from "../broadcast/client";
import { buildFloatingPanel } from "../ui/draggablePanel";
import { getCharacter, getRemoteStatus, onRemoteStatusChange } from "../client/remoteState";
import { renderCurrentActivity, renderSyncStatus } from "../status/render";

const REFRESH_INTERVAL_MS = 30_000;

/**
 * Who's using the house, what they're doing right now, and connection
 * health — shared by the desktop/viewer corner panel (`setupGoalsPanel`
 * below) and the mobile Home tab's bare-text equivalent, which has no
 * panel chrome at all so it renders its own title line instead of relying
 * on a panel header for it.
 *
 * "Current activity" now comes from the server's `status` broadcast
 * (remoteState) instead of a direct local AW call — it updates reactively
 * whenever *any* device changes it, not just this one, since it's the
 * same status every connected client sees. Sync health is polled on the
 * same interval this already re-rendered on (no more
 * onBroadcastHealthChange push — the server has no reason to broadcast
 * that to everyone, it's cheap enough to just ask on a timer).
 */
export function setupJacquelineStatus(container: HTMLElement, options?: { showTitle?: boolean }): void {
  if (options?.showTitle) {
    const title = document.createElement("div");
    title.className = "mobile-status-title";
    title.textContent = getCharacter().name;
    container.appendChild(title);
  }

  // What's running right now and since when — previously the separate
  // top-left #status box, moved here so it's one place for "what's going
  // on" instead of two. Shared with the viewer's equivalent section.
  const currentEl = document.createElement("div");
  currentEl.className = "overview-current";
  container.appendChild(currentEl);

  function renderCurrent() {
    const current = getRemoteStatus();
    renderCurrentActivity(currentEl, {
      label: current.activityLabel,
      startedAt: current.startedAt ? new Date(current.startedAt) : null,
    });
  }

  const divider = document.createElement("div");
  divider.className = "panel-divider";
  container.appendChild(divider);

  // AW connection is now the server's problem, not this client's — if the
  // server can't reach AW it fails at its own startup, long before any
  // client connects, so there's no "AW: Disconnected" state to show here
  // any differently than before.
  const statusLine = document.createElement("div");
  statusLine.className = "overview-status-line";
  container.appendChild(statusLine);

  async function renderStatus() {
    const { configured, lastSuccessAt, lastError } = await getBroadcastHealth();
    renderSyncStatus(statusLine, { showAw: true, vt: { configured, lastSuccessAt, lastError } });
  }

  renderStatus();
  setInterval(renderStatus, REFRESH_INTERVAL_MS);

  onRemoteStatusChange(renderCurrent);
  renderCurrent();
  // The elapsed-time clock still needs its own tick — the status itself
  // only changes on an actual activity switch, but "started 3m ago" needs
  // to keep advancing between those.
  setInterval(renderCurrent, 1000);
}

/**
 * Always-visible corner panel version of the above. Goal progress used to
 * live here too but moved to the Dashboard panel — showing it in both
 * places was redundant.
 */
export function setupGoalsPanel(): void {
  // Same title-bar component the Dashboard uses, just not closable (always
  // visible, no button that opens it) and not draggable (always lives in
  // the same corner — nothing to gain from being able to move it).
  const panel = buildFloatingPanel(getCharacter().name, {
    closable: false,
    draggable: false,
    className: "goals-panel",
  });

  setupJacquelineStatus(panel.body);

  panel.open();
}
