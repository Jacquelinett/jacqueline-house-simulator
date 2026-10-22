import { Recurrence } from "./types";

/**
 * Pure text formatting for goals — no DOM, no AW/history dependency.
 * Split out of goals/ui.ts (which otherwise mixes this with DOM-building
 * functions like buildActivitySelect/buildRecurrencePicker) specifically
 * so the server can import these without pulling in document/HTMLElement
 * references it has no lib types for. goals/ui.ts re-exports everything
 * here for existing client importers, so nothing on the client needed to
 * change because of this split.
 */
export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatOccurrence(occ: 1 | 2 | 3 | 4 | "last"): string {
  return occ === "last" ? "last" : `${occ}${["th", "st", "nd", "rd"][occ] ?? "th"}`;
}

export function describeRecurrence(r: Recurrence): string {
  if (r.type === "once") return `once (${r.date})`;
  if (r.type === "daily") return "daily";
  if (r.type === "weekly") return `weekly: ${r.daysOfWeek.join(", ")}`;
  return `monthly: ${r.occurrences.map(formatOccurrence).join(", ")} ${r.dayOfWeek}`;
}

/**
 * "Streak: 3 (best 7)", or null if there's nothing worth showing yet (no
 * current streak and never had one). The desktop app computes `current`
 * itself from the history log (goals/history.ts's describeStreak); the
 * viewer gets it pre-computed from a val.town push instead (it has no
 * history log to derive it from) — both end up calling this same formatter.
 */
export function formatStreak(current: number, best: number): string | null {
  if (current === 0 && best === 0) return null;
  return `Streak: ${current} (best ${best})`;
}
