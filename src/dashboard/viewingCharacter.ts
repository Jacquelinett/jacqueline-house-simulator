/**
 * Local-only (never synced to the server, never persisted) — "which
 * character's dashboard am I currently peeking at," set by House.ts when
 * you single-click an object someone else is using, cleared by clicking
 * anywhere else (even empty space — see House.ts's own canvas-level
 * pointerdown listener). The Dashboard panel (dashboard/panel.ts)
 * subscribes to this to temporarily swap whose goal progress/activity it
 * shows, reverting to your own the moment this clears. A plain module-level
 * value + listener Set, same shape as client/remoteState.ts's stores, but
 * deliberately NOT one of them — this is per-device UI state, not
 * something that should sync across your other devices or round-trip
 * through the server at all.
 */
export interface ViewingCharacter {
  id: string;
  name: string;
}

let current: ViewingCharacter | null = null;
const listeners = new Set<() => void>();

export function getViewingCharacter(): ViewingCharacter | null {
  return current;
}

export function setViewingCharacter(next: ViewingCharacter | null): void {
  if (current?.id === next?.id) return; // no-op if unchanged — avoids a redundant re-render on every click
  current = next;
  for (const cb of listeners) cb();
}

export function onViewingCharacterChange(cb: () => void): void {
  listeners.add(cb);
}
