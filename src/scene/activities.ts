// Shared activity identities, referenced by object type definitions in
// rooms.ts (and by goals/dashboard code). Centralizing label + color here
// means multiple object types representing "the same" activity (e.g. a
// second piano somewhere) share the exact same label by construction,
// rather than by coincidentally typing the same string twice.
export interface ActivityDef {
  id: number;
  label: string; // the AW-facing label — what actually gets tracked
  color: number; // for color-coded goal/dashboard UI
}

/**
 * One-time seed source for the `activities` SQLite table (see
 * server/activities.ts) — NOT the runtime source of truth anymore.
 * `ACTIVITIES` below is a mutable `let` that main.ts/viewer-main.ts
 * overwrite with server-fetched data right after connecting
 * (setActivities), before any room is built, same live-binding pattern
 * as rooms.ts's `rooms`/`objectTypes`. rooms.ts's STATIC_OBJECT_TYPES
 * literal reads from this constant directly (not the mutable export) at
 * module-eval time, before setActivities() is ever called — so its
 * baked-in activityId references are unaffected by ACTIVITIES later being
 * re-keyed by id instead of by these camelCase names.
 *
 * `id` is now a plain serial integer (was a hand-authored kebab-case
 * string) matching the activities table's own INTEGER PRIMARY KEY — these
 * explicit values are what server/activities.ts's seedActivitiesIfEmpty()
 * inserts verbatim (SQLite accepts an explicit value for an INTEGER
 * PRIMARY KEY column same as it always has; only an *omitted* id
 * auto-assigns, which is what every admin-tool-created activity gets
 * instead — see createActivity()).
 */
export const STATIC_ACTIVITIES: Record<string, ActivityDef> = {
  practicingPiano: { id: 1, label: "Practicing Piano", color: 0xff69b4 },
  working: { id: 2, label: "Working", color: 0x5a5a6a },
  programming: { id: 3, label: "Programming", color: 0x4a6a9a },
  administrativeWork: { id: 4, label: "Administrative Work", color: 0x9a7a4a },
  gaming: { id: 5, label: "Gaming", color: 0x4a4a4a },
  streaming: { id: 6, label: "Streaming", color: 0x9a4a9a },
  ddr: { id: 7, label: "DDR", color: 0x7a2b5a },
  weightlifting: { id: 8, label: "Weightlifting", color: 0x5a5a6a },
};

export let ACTIVITIES: Record<string, ActivityDef> = STATIC_ACTIVITIES;

/** Swaps in server-fetched activities, re-keyed by id — see this file's top comment. */
export function setActivities(activities: ActivityDef[]): void {
  const next: Record<string, ActivityDef> = {};
  for (const a of activities) next[a.id] = a;
  ACTIVITIES = next;
}

export function findActivityByLabel(label: string): ActivityDef | undefined {
  return Object.values(ACTIVITIES).find((a) => a.label === label);
}

export function findActivityById(id: number): ActivityDef | undefined {
  return Object.values(ACTIVITIES).find((a) => a.id === id);
}

/**
 * Every known activity's label, sorted — the single source of truth for
 * "what activities exist," used by the goal-creation dropdown (and
 * anything else that needs the full list) regardless of whether that
 * activity has a clickable object placed anywhere in the house yet.
 * Previously this scanned room object actions instead (`rooms.ts`'s own
 * `getAllActivityLabels()`), which meant adding an activity here didn't
 * make it selectable anywhere until a room object referenced it too —
 * two different concerns (what activities exist vs. where you can click
 * to start one) were accidentally coupled through one function.
 */
export function getAllActivityLabels(): string[] {
  return Object.values(ACTIVITIES)
    .map((a) => a.label)
    .sort();
}

/** ActivityDef.color as a CSS hex string, for anything rendering a swatch/background outside of Pixi (which takes the raw number directly). */
export function toCssColor(color: number): string {
  return `#${color.toString(16).padStart(6, "0")}`;
}
