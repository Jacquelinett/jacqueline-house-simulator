import { buildFloatingPanel } from "../ui/draggablePanel";
import { getActivityStatsForDate } from "./stats";
import { getGoalProgressForDate } from "../goals/progress";
import { onGoalsChange } from "../goals/state";
import { describeScheduleForDate } from "../goals/goalGroups";
import { describeStreak, getGoalHistory } from "../goals/history";
import { localDateString, parseDateString } from "../goals/recurrence";
import { formatMinutes } from "../goals/format";
import { buildDashboardSections, renderActivityList, renderGoalList, renderWorkoutToday } from "./render";
import { getViewingCharacter, onViewingCharacterChange } from "./viewingCharacter";
import { fetchWorkoutsForDate } from "../workout/client";
import { summarizeWorkoutSessions } from "../workout/format";

const REFRESH_INTERVAL_MS = 30_000;

function buildDateInput(): HTMLInputElement {
  const dateInput = document.createElement("input");
  dateInput.type = "date";
  dateInput.className = "dashboard-date-input";
  dateInput.value = localDateString(new Date());
  return dateInput;
}

/**
 * Goals progress + activity breakdown for one day at a time (a date picker,
 * default today) — shared by the desktop Dashboard panel and the app's
 * mobile Dashboard tab. All-time standouts live in the separate Statistic
 * surface instead, to avoid overlapping with the same info.
 *
 * `providedDateInput` lets the desktop panel place its date input in the
 * panel header (via `buildFloatingPanel`'s `headerExtra`) instead of inline
 * in the body; the mobile tab has no header to put it in, so it's left
 * unset there and this builds + inserts its own inline copy instead.
 */
export function setupDashboardContent(container: HTMLElement, providedDateInput?: HTMLInputElement): void {
  const dateInput = providedDateInput ?? buildDateInput();
  if (!providedDateInput) {
    const dateRow = document.createElement("div");
    dateRow.className = "dashboard-date-row";
    dateRow.appendChild(dateInput);
    container.appendChild(dateRow);
  }

  const { goalHeading, goalList, activityHeading, activityList, workoutSection, workoutList } = buildDashboardSections(container);

  function isViewingToday(): boolean {
    return dateInput.value === localDateString(new Date());
  }

  /**
   * While peeking at another character's dashboard (see
   * dashboard/viewingCharacter.ts — set by House.ts when you single-click
   * an object they're using), the headings name them instead of "Today"/
   * the picked date, so it's never ambiguous whose data is showing.
   */
  function updateHeadings() {
    const viewing = getViewingCharacter();
    if (viewing) {
      goalHeading.textContent = `${viewing.name}'s Goals`;
      activityHeading.textContent = `${viewing.name}'s Activity`;
      return;
    }
    if (isViewingToday()) {
      goalHeading.textContent = "Today's Goals";
      activityHeading.textContent = "Today's Activity";
      return;
    }
    const label = parseDateString(dateInput.value).toLocaleDateString(undefined, { month: "short", day: "numeric" });
    goalHeading.textContent = `${label}'s Goals`;
    activityHeading.textContent = `${label}'s Activity`;
  }

  async function renderGoals() {
    const viewingId = getViewingCharacter()?.id;
    const progress = await getGoalProgressForDate(dateInput.value, viewingId);
    const history = await getGoalHistory(viewingId);
    renderGoalList(
      goalList,
      progress.map((p) => ({
        activityLabel: p.activityLabel,
        minutes: p.minutes,
        targetMinutes: p.targetMinutes,
        done: p.done,
        subRows: p.goals.map((g) => {
          const streakText = describeStreak(g, history);
          return `${describeScheduleForDate(g.recurrence, dateInput.value)} — ${formatMinutes(g.targetMinutes)}${streakText ? ` — ${streakText}` : ""}`;
        }),
      })),
      isViewingToday() ? "No goals today" : "No goals that day",
    );
  }

  async function renderActivity() {
    const viewingId = getViewingCharacter()?.id;
    const stats = await getActivityStatsForDate(dateInput.value, viewingId).catch((err) => {
      console.error("[dashboard] failed to load activity for date", err);
      return null;
    });
    if (!stats) {
      renderActivityList(activityList, [], "Failed to load");
      return;
    }
    renderActivityList(activityList, stats, isViewingToday() ? "Nothing tracked today" : "Nothing tracked that day");
  }

  /**
   * "Lifted Today" is always about the real current day, regardless of
   * what the date picker above is set to — it's a pride/bragging callout
   * about real logged lifting (see CLAUDE.md's wger section), not part of
   * the date-scoped Goals/Activity sections. Still respects a "peek at
   * another character" switch (getViewingCharacter()), since showing
   * Jacqueline's workout while looking at Kevin's dashboard would be
   * confusing — getWorkoutsForDate() just no-ops (empty array) for any
   * character with no wger_api_token of their own anyway.
   */
  async function renderWorkout() {
    const viewingId = getViewingCharacter()?.id;
    const sessions = await fetchWorkoutsForDate(localDateString(new Date()), viewingId).catch((err) => {
      console.error("[dashboard] failed to load today's workout", err);
      return [];
    });
    renderWorkoutToday(workoutSection, workoutList, summarizeWorkoutSessions(sessions));
  }

  function renderAll() {
    updateHeadings();
    renderGoals();
    renderActivity();
    renderWorkout();
  }

  dateInput.onchange = renderAll;
  onGoalsChange(renderGoals);
  onViewingCharacterChange(renderAll);
  renderAll();

  // A past/future day's data never changes once rendered — only keep
  // re-ticking Goals/Activity on an interval while the picker is actually
  // showing today, same as the live-refresh behavior this had before the
  // date picker. renderWorkout() is NOT gated on isViewingToday() here —
  // unlike Goals/Activity it's always about today regardless of the
  // picker, and today's own logged workout can keep changing all day.
  setInterval(() => {
    if (isViewingToday()) {
      renderGoals();
      renderActivity();
    }
    renderWorkout();
  }, REFRESH_INTERVAL_MS);
}

/** Always-visible corner panel version of the above — its date picker lives in the header, next to the drag handle. */
export function setupDashboardPanel(): void {
  const dateInput = buildDateInput();
  const panel = buildFloatingPanel("Dashboard", {
    closable: false,
    resizable: true,
    className: "dashboard-panel",
    headerExtra: dateInput,
  });
  setupDashboardContent(panel.body, dateInput);
  panel.open();
}
