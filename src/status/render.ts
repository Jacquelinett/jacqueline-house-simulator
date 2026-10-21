export function formatClock(date: Date): string {
  const hh = date.getHours().toString().padStart(2, "0");
  const mm = date.getMinutes().toString().padStart(2, "0");
  return `${hh}:${mm}`;
}

export function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hh = Math.floor(totalSeconds / 3600);
  const mm = Math.floor((totalSeconds % 3600) / 60)
    .toString()
    .padStart(hh > 0 ? 2 : 1, "0");
  const ss = (totalSeconds % 60).toString().padStart(2, "0");
  return hh > 0 ? `${hh}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatRelativeTime(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export interface CurrentActivityStatus {
  label: string | null; // null = idle
  startedAt: Date | null;
}

/**
 * "I'm currently: X" + "Started: HH:MM | elapsed" — shared by the desktop
 * Jacqueline panel and the viewer's equivalent section.
 */
export function renderCurrentActivity(container: HTMLElement, status: CurrentActivityStatus): void {
  container.textContent = "";

  const activityLine = document.createElement("div");
  activityLine.textContent = `I'm currently: ${status.label ?? "idle"}`;
  container.appendChild(activityLine);

  if (status.startedAt) {
    const startedLine = document.createElement("div");
    startedLine.className = "overview-started";
    startedLine.textContent = `Started: ${formatClock(status.startedAt)} | ${formatElapsed(Date.now() - status.startedAt.getTime())}`;
    container.appendChild(startedLine);
  }
}

export interface VtSyncStatus {
  configured: boolean;
  lastSuccessAt: Date | null;
  lastError: string | null;
}

/**
 * "AW: Connected | VT: Synced ..." — shared by the desktop Jacqueline panel
 * and the viewer's equivalent. The viewer has no AW access at all, so it
 * passes showAw: false and only ever renders the VT half.
 */
export function renderSyncStatus(container: HTMLElement, options: { showAw: boolean; vt: VtSyncStatus }): void {
  container.textContent = "";

  if (options.showAw) {
    const awEl = document.createElement("span");
    awEl.className = "status-ok";
    awEl.textContent = "AW: Connected";
    container.appendChild(awEl);
    container.appendChild(document.createTextNode(" | "));
  }

  const vtEl = document.createElement("span");
  if (!options.vt.configured) {
    vtEl.textContent = "VT: Not configured";
  } else if (options.vt.lastError) {
    vtEl.className = "status-error";
    vtEl.textContent = `VT: Sync failed: ${options.vt.lastError}`;
  } else if (options.vt.lastSuccessAt) {
    vtEl.textContent = `VT: Synced ${formatRelativeTime(options.vt.lastSuccessAt)}`;
  } else {
    vtEl.textContent = "VT: Not yet synced";
  }
  container.appendChild(vtEl);
}
