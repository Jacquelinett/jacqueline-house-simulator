import { DaySummary, PersonalRecord, WgerLifetimeStats } from "./types";

/**
 * Shared DOM builders for the Statistic modal's Workout tab — Lifetime
 * Stats/Personal Records/Logs now render identically everywhere this
 * data shows up (the desktop app's modal and its mobile-tab equivalent,
 * src/workout/modal.ts, AND the viewer's own Workout tab, src/
 * viewer-main.ts), fed from different sources (a live RPC query on
 * desktop, a polled val.town blob on the viewer) but rendered by the
 * exact same functions below — see CLAUDE.md's "reuse over duplication"
 * and "Shared rendering between the desktop app and the viewer"
 * sections. This used to be a smaller "just the row/subrow DOM shape,
 * not the data-to-rows decision" split, back when the two surfaces
 * deliberately showed different row sets (the viewer omitted a "Last
 * workout" row already covered by its own adjacent Recent Days section).
 * Once the Statistic modal's Workout tab was unified into one toggle
 * between mutually-exclusive sections on both surfaces, that adjacency
 * reason went away — now both genuinely want the identical row set, so
 * the full data-to-rows decision is shared too, not just the single-row
 * builders.
 */
export function buildWorkoutRow(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "dashboard-row workout-row";

  const name = document.createElement("span");
  name.className = "dashboard-text";
  name.textContent = label;
  row.appendChild(name);

  const detail = document.createElement("span");
  detail.className = "workout-sets-detail";
  detail.textContent = value;
  row.appendChild(detail);

  return row;
}

/** The lighter-weight line under a `buildWorkoutRow` — a record's date, a session's impression, an extra weight/rep group, etc. */
export function buildWorkoutSubRow(text: string): HTMLElement {
  const subRow = document.createElement("div");
  subRow.className = "workout-subrow";

  const subText = document.createElement("span");
  subText.className = "workout-subtext";
  subText.textContent = text;
  subRow.appendChild(subText);

  return subRow;
}

function showEmptyRow(container: HTMLElement, text: string): void {
  container.textContent = "";
  const empty = document.createElement("div");
  empty.className = "goals-empty";
  empty.textContent = text;
  container.appendChild(empty);
}

const IMPRESSION_TEXT: Record<"bad" | "neutral" | "good", string> = { bad: "Bad", neutral: "Neutral", good: "Good" };

/** `stats === null` covers both "no wger account linked" and "the fetch itself failed" — both read the same to a viewer (nothing to show), same as every other wger-gated section in this app. */
export function renderLifetimeStats(container: HTMLElement, stats: WgerLifetimeStats | null): void {
  if (!stats) {
    showEmptyRow(container, "No wger account linked");
    return;
  }
  container.textContent = "";
  const rows: [string, string][] = [
    ["Total weight lifted", `${stats.totalWeightLifted.toLocaleString()}${stats.totalWeightLiftedUnit}`],
    ["Total workouts", String(stats.totalWorkouts)],
    ["Current streak", `${stats.currentStreak} day${stats.currentStreak === 1 ? "" : "s"}`],
    ["Longest streak", `${stats.longestStreak} day${stats.longestStreak === 1 ? "" : "s"}`],
    [
      "Last workout",
      stats.lastWorkoutDate
        ? new Date(stats.lastWorkoutDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })
        : "—",
    ],
  ];
  for (const [label, value] of rows) container.appendChild(buildWorkoutRow(label, value));
}

/** `records === null` means the fetch itself failed (an empty array already means "linked, but no PRs yet or not linked" — both read as "nothing to show" here, same as every other wger section). */
export function renderPersonalRecords(container: HTMLElement, records: PersonalRecord[] | null): void {
  if (records === null) {
    showEmptyRow(container, "Failed to load personal records");
    return;
  }
  if (records.length === 0) {
    showEmptyRow(container, "No personal records yet");
    return;
  }
  container.textContent = "";
  for (const record of records) {
    const weightPart = `${record.weight}${record.weightUnit ?? "kg"} × ${record.reps}`;
    const oneRm = record.oneRepMaxEstimate != null ? ` (1RM ~${record.oneRepMaxEstimate}${record.weightUnit ?? "kg"})` : "";
    container.appendChild(buildWorkoutRow(record.exerciseName, `${weightPart}${oneRm}`));
    container.appendChild(
      buildWorkoutSubRow(new Date(record.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })),
    );
  }
}

/** One row per day (newest first), its exercise summary as sub-rows — see DaySummary's own comment for why this is day-level rather than per-session, and why it now carries real start/end times. Same null-vs-empty distinction as renderPersonalRecords above. */
export function renderDaySummaries(container: HTMLElement, days: DaySummary[] | null): void {
  if (days === null) {
    showEmptyRow(container, "Failed to load workout log");
    return;
  }
  if (days.length === 0) {
    showEmptyRow(container, "No workouts logged yet");
    return;
  }
  container.textContent = "";
  for (const day of days) {
    const start = new Date(day.datetimeStart);
    const end = day.datetimeEnd ? new Date(day.datetimeEnd) : null;
    const dateLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    const timeLabel = `${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} – ${
      end ? end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "ongoing"
    }`;
    container.appendChild(buildWorkoutRow(dateLabel, timeLabel));

    if (day.impression) container.appendChild(buildWorkoutSubRow(`Impression: ${IMPRESSION_TEXT[day.impression]}`));
    for (const exercise of day.exercises) {
      container.appendChild(buildWorkoutSubRow(`${exercise.exerciseName}: ${exercise.details.join(", ")}`));
    }
  }
}
