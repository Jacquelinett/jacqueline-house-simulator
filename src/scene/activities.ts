// Shared activity identities, referenced by object type definitions in
// rooms.ts (and by goals/dashboard code). Centralizing label + color here
// means multiple object types representing "the same" activity (e.g. a
// second piano somewhere) share the exact same label by construction,
// rather than by coincidentally typing the same string twice.
export interface ActivityDef {
  id: string;
  label: string; // the AW-facing label — what actually gets tracked
  color: number; // for color-coded goal/dashboard UI
}

export const ACTIVITIES = {
  practicingPiano: {
    id: "practicing-piano",
    label: "Practicing Piano",
    color: 0xff69b4,
  },
  working: { id: "working", label: "Working", color: 0x5a5a6a },
  programming: { id: "programming", label: "Programming", color: 0x4a6a9a },
  administrativeWork: {
    id: "administrative-work",
    label: "Administrative Work",
    color: 0x9a7a4a,
  },
  gaming: { id: "gaming", label: "Gaming", color: 0x4a4a4a },
  streaming: { id: "streaming", label: "Streaming", color: 0x9a4a9a },
  ddr: { id: "ddr", label: "DDR", color: 0x7a2b5a },
  weightlifting: {
    id: "weightlifting",
    label: "Weightlifting",
    color: 0x5a5a6a,
  },
} as const satisfies Record<string, ActivityDef>;

export function findActivityByLabel(label: string): ActivityDef | undefined {
  return Object.values(ACTIVITIES).find((a) => a.label === label);
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
