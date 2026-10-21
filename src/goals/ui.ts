import { getAllActivityLabels } from "../scene/activities";
import { Recurrence, Weekday } from "./types";

export const WEEKDAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

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
  if (r.type === "weekly") return `weekly: ${r.daysOfWeek.join(", ")}`;
  return `monthly: ${r.occurrences.map(formatOccurrence).join(", ")} ${r.dayOfWeek}`;
}

export function buildActivitySelect(): HTMLSelectElement {
  const select = document.createElement("select");
  for (const label of getAllActivityLabels()) {
    const opt = document.createElement("option");
    opt.value = label;
    opt.textContent = label;
    select.appendChild(opt);
  }
  return select;
}

export function buildMinutesInput(initialMinutes?: number): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.min = "1";
  input.placeholder = "target minutes";
  input.value = String(initialMinutes ?? 60);
  return input;
}

/** Weekly/monthly schedule picker, shared by the "add recurring" form and the inline edit form. */
export function buildRecurrencePicker(initial: Recurrence | null): {
  element: HTMLElement;
  getRecurrence(): Recurrence | null;
} {
  const container = document.createElement("span");

  const typeSelect = document.createElement("select");
  for (const [value, label] of [
    ["weekly", "Weekly"],
    ["monthly", "Monthly"],
  ] as const) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = label;
    typeSelect.appendChild(opt);
  }
  if (initial?.type === "monthly") typeSelect.value = "monthly";
  container.appendChild(typeSelect);

  const detail = document.createElement("span");
  container.appendChild(detail);

  const selectedDays = new Set<Weekday>(initial?.type === "weekly" ? initial.daysOfWeek : []);
  const selectedOccurrences = new Set<1 | 2 | 3 | 4 | "last">(initial?.type === "monthly" ? initial.occurrences : []);
  const occurrenceToggles = document.createElement("span");
  const monthlyDaySelect = document.createElement("select");

  function renderDetail() {
    detail.textContent = "";
    if (typeSelect.value === "weekly") {
      for (const day of WEEKDAYS) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = day;
        btn.className = "day-toggle" + (selectedDays.has(day) ? " selected" : "");
        btn.onclick = () => {
          if (selectedDays.has(day)) selectedDays.delete(day);
          else selectedDays.add(day);
          btn.classList.toggle("selected");
        };
        detail.appendChild(btn);
      }
    } else {
      occurrenceToggles.textContent = "";
      // Toggles instead of a single <select> — one monthly goal can now
      // cover multiple occurrences of the same weekday (e.g. 2nd + 4th
      // Sunday), same idea as the weekly day-of-week toggles above.
      for (const [value, label] of [
        ["1", "1st"],
        ["2", "2nd"],
        ["3", "3rd"],
        ["4", "4th"],
        ["last", "Last"],
      ] as const) {
        const occValue = value === "last" ? "last" : (Number(value) as 1 | 2 | 3 | 4);
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = label;
        btn.className = "day-toggle" + (selectedOccurrences.has(occValue) ? " selected" : "");
        btn.onclick = () => {
          if (selectedOccurrences.has(occValue)) selectedOccurrences.delete(occValue);
          else selectedOccurrences.add(occValue);
          btn.classList.toggle("selected");
        };
        occurrenceToggles.appendChild(btn);
      }
      monthlyDaySelect.textContent = "";
      for (const day of WEEKDAYS) {
        const opt = document.createElement("option");
        opt.value = day;
        opt.textContent = day;
        monthlyDaySelect.appendChild(opt);
      }
      if (initial?.type === "monthly") monthlyDaySelect.value = initial.dayOfWeek;
      detail.appendChild(occurrenceToggles);
      detail.appendChild(monthlyDaySelect);
    }
  }
  typeSelect.onchange = renderDetail;
  renderDetail();

  return {
    element: container,
    getRecurrence(): Recurrence | null {
      if (typeSelect.value === "weekly") {
        if (selectedDays.size === 0) return null;
        return { type: "weekly", daysOfWeek: [...selectedDays] };
      }
      if (selectedOccurrences.size === 0) return null;
      return {
        type: "monthly",
        occurrences: [...selectedOccurrences],
        dayOfWeek: monthlyDaySelect.value as Weekday,
      };
    },
  };
}
