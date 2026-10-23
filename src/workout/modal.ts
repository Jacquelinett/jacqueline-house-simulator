import { buildModal } from "../ui/modal";
import { localDateString } from "../goals/recurrence";
import { fetchWorkoutsForDate } from "./client";
import { WorkoutSession } from "./types";
import { formatSetDetail, groupSetsByExercise } from "./format";

/**
 * Read-only display of today's workout data — backed by the real wger
 * instance when server_config.wger_base_url/wger_api_token are set
 * (server/wger.ts), falling back to the mock SQLite mirror otherwise (see
 * server/workouts.ts's own comment on this dispatch). Deliberately
 * independent of AW/goals entirely — just "what did I lift today," no
 * activity-tracking tie-in. See also the Dashboard's "Lifted Today"
 * section (src/dashboard/panel.ts), which shows a coarser summary of the
 * exact same data without needing this modal open.
 */
export function setupWorkoutModal(): { open: () => void } {
  const modal = buildModal("Workout");

  const list = document.createElement("div");
  list.className = "dashboard-list";
  modal.body.appendChild(list);

  async function render() {
    list.textContent = "";
    const loading = document.createElement("div");
    loading.className = "goals-empty";
    loading.textContent = "Loading...";
    list.appendChild(loading);

    let sessions: WorkoutSession[];
    try {
      sessions = await fetchWorkoutsForDate(localDateString(new Date()));
    } catch (err) {
      console.error("[workout] failed to load", err);
      list.textContent = "";
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load workout data";
      list.appendChild(error);
      return;
    }

    list.textContent = "";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No workouts logged today";
      list.appendChild(empty);
      return;
    }

    for (const session of sessions) {
      if (session.notes) {
        const notes = document.createElement("div");
        notes.className = "workout-session-notes";
        notes.textContent = session.notes;
        list.appendChild(notes);
      }

      for (const [exerciseName, sets] of groupSetsByExercise(session.sets)) {
        const row = document.createElement("div");
        row.className = "dashboard-row workout-row";

        const name = document.createElement("span");
        name.className = "dashboard-text";
        name.textContent = exerciseName;
        row.appendChild(name);

        const detail = document.createElement("span");
        detail.className = "workout-sets-detail";
        detail.textContent = formatSetDetail(sets);
        row.appendChild(detail);

        list.appendChild(row);
      }
    }
  }

  return {
    open() {
      modal.open();
      render();
    },
  };
}
