import { getAllActivityLabels } from "../scene/rooms";
import { Recurrence, Weekday } from "./types";

export const WEEKDAYS: Weekday[] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function formatMinutes(min: number): string {
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function describeRecurrence(r: Recurrence): string {
  if (r.type === "once") return `once (${r.date})`;
  if (r.type === "weekly") return `weekly: ${r.daysOfWeek.join(", ")}`;
  return `monthly: ${r.occurrence === "last" ? "last" : `${r.occurrence}${["th", "st", "nd", "rd"][r.occurrence] ?? "th"}`} ${r.dayOfWeek}`;
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
  const occurrenceSelect = document.createElement("select");
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
      occurrenceSelect.textContent = "";
      for (const [value, label] of [
        ["1", "1st"],
        ["2", "2nd"],
        ["3", "3rd"],
        ["4", "4th"],
        ["last", "Last"],
      ] as const) {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        occurrenceSelect.appendChild(opt);
      }
      if (initial?.type === "monthly") occurrenceSelect.value = String(initial.occurrence);
      monthlyDaySelect.textContent = "";
      for (const day of WEEKDAYS) {
        const opt = document.createElement("option");
        opt.value = day;
        opt.textContent = day;
        monthlyDaySelect.appendChild(opt);
      }
      if (initial?.type === "monthly") monthlyDaySelect.value = initial.dayOfWeek;
      detail.appendChild(occurrenceSelect);
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
      const occurrenceValue = occurrenceSelect.value;
      return {
        type: "monthly",
        occurrence: occurrenceValue === "last" ? "last" : (Number(occurrenceValue) as 1 | 2 | 3 | 4),
        dayOfWeek: monthlyDaySelect.value as Weekday,
      };
    },
  };
}
