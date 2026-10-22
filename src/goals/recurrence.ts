import { Recurrence, Weekday } from "./types";

export const WEEKDAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Inverse of localDateString — parses as a local (not UTC) midnight. */
export function parseDateString(dateStr: string): Date {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d);
}

export function addDaysToDateString(dateStr: string, days: number): string {
  const date = parseDateString(dateStr);
  date.setDate(date.getDate() + days);
  return localDateString(date);
}

function isLastOccurrenceOfWeekday(date: Date): boolean {
  const nextWeek = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 7);
  return nextWeek.getMonth() !== date.getMonth();
}

/** Is this goal scheduled to apply on the given (local) date? */
export function isScheduledOn(recurrence: Recurrence, date: Date): boolean {
  switch (recurrence.type) {
    case "once":
      return recurrence.date === localDateString(date);
    case "daily":
      return true;
    case "weekly":
      return recurrence.daysOfWeek.includes(WEEKDAYS[date.getDay()]);
    case "monthly": {
      if (WEEKDAYS[date.getDay()] !== recurrence.dayOfWeek) return false;
      const ordinal = Math.ceil(date.getDate() / 7);
      return recurrence.occurrences.some((occ) => occ === ordinal || (occ === "last" && isLastOccurrenceOfWeekday(date)));
    }
  }
}

export type PeriodMode = "weekly" | "monthly";

/**
 * The [start, end) window and a display label for the Sun–Sat week or the
 * calendar month containing `anchor` — used by Statistic's Period tab (a
 * free-form date picker) and by the fixed This Week/Last Week/This
 * Month/Last Month buckets pushed to val.town for the viewer, so both
 * compute "what does Weekly/Monthly actually mean as a date range"
 * identically.
 */
export function periodRange(mode: PeriodMode, anchor: Date): { start: Date; end: Date; label: string } {
  if (mode === "weekly") {
    const start = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7);
    const lastDay = new Date(end.getFullYear(), end.getMonth(), end.getDate() - 1);
    const label = `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${lastDay.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
    return { start, end, label };
  }
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const end = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
  return { start, end, label: start.toLocaleDateString(undefined, { month: "long", year: "numeric" }) };
}
