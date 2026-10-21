import { Recurrence, Weekday } from "./types";

const WEEKDAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function localDateString(date: Date): string {
  const y = date.getFullYear();
  const m = (date.getMonth() + 1).toString().padStart(2, "0");
  const d = date.getDate().toString().padStart(2, "0");
  return `${y}-${m}-${d}`;
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
    case "weekly":
      return recurrence.daysOfWeek.includes(WEEKDAYS[date.getDay()]);
    case "monthly": {
      if (WEEKDAYS[date.getDay()] !== recurrence.dayOfWeek) return false;
      if (recurrence.occurrence === "last") return isLastOccurrenceOfWeekday(date);
      return Math.ceil(date.getDate() / 7) === recurrence.occurrence;
    }
  }
}
