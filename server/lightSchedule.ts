import { getScheduledLights, setLightState } from "./rooms";
import { broadcastLightStates } from "./rpc";

/**
 * Parses "HH:MM" into minutes-since-midnight — the only unit the window
 * check below needs, and simple enough not to warrant a date library.
 */
function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Whether `now` falls within [onAt, offAt) — handles the overnight-span
 * case (onAt later in the day than offAt, e.g. "18:00" to "06:00") by
 * checking the complement of the gap instead of assuming onAt < offAt.
 */
export function isWithinSchedule(onAt: string, offAt: string, now: Date): boolean {
  const nowMinutes = now.getHours() * 60 + now.getMinutes();
  const on = parseMinutes(onAt);
  const off = parseMinutes(offAt);
  if (on === off) return false; // a zero-width window is never "on" -- nothing to light
  if (on < off) return nowMinutes >= on && nowMinutes < off;
  return nowMinutes >= on || nowMinutes < off; // wraps past midnight
}

// Tracks which side of its own schedule each object was LAST SEEN on —
// not persisted, an in-memory resync on restart is fine (same "a server
// restart recomputing once is a reasonable resync" stance CLAUDE.md's
// broadcasting section already takes for its own in-memory caches).
// Keyed by object id so one object's own window flip is independent of
// every other scheduled object's. This is what turns "which way is the
// schedule pointing right now" (recomputed fresh every tick) into "did
// it just CROSS a boundary" (only write+broadcast on an actual change) —
// the thing that lets a manual click in between two boundaries survive
// until the next real crossing instead of being stomped every tick.
const lastWindowByObjectId = new Map<number, boolean>();

/**
 * Called on a short recurring timer from index.ts (see its own comment
 * on why this needs a much tighter interval than the hourly stats
 * pushes). Every scheduled object's current on/off window is recomputed
 * fresh each tick from wall-clock time — cheap, pure, no stored "last
 * computed at" timestamp needed — but only WRITES (and only broadcasts
 * once, covering every change in this tick, not once per object) when at
 * least one object's window actually differs from last tick's. A manual
 * toggle made in between two boundaries is therefore never touched here;
 * only the moment a boundary is actually crossed sets the state, matching
 * "at X set on, at Y set off" rather than a continuous toggle.
 */
export function evaluateLightSchedules(): void {
  const now = new Date();
  let anyChanged = false;
  for (const { id, onAt, offAt } of getScheduledLights()) {
    const shouldBeOn = isWithinSchedule(onAt, offAt, now);
    if (lastWindowByObjectId.get(id) === shouldBeOn) continue;
    lastWindowByObjectId.set(id, shouldBeOn);
    setLightState(id, shouldBeOn);
    anyChanged = true;
  }
  if (anyChanged) broadcastLightStates();
}
