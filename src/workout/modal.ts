import { buildModal } from "../ui/modal";
import { sendQuery } from "../client/remoteState";
import { localDateString } from "../goals/recurrence";

interface WorkoutSet {
  id: string;
  exerciseName: string;
  weight: number | null;
  reps: number;
  setOrder: number;
}

interface WorkoutSession {
  id: string;
  date: string;
  notes: string | null;
  sets: WorkoutSet[];
}

/**
 * Read-only display of today's workout data — a mirror of whatever a real
 * wger server would eventually be polled for (see
 * wger_gamification_implementation_plan.md), currently mock-seeded
 * server-side (server/workouts.ts) since no real wger instance exists yet.
 * Deliberately independent of AW/goals entirely — just "what did I lift
 * today," no activity-tracking tie-in.
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
      sessions = await sendQuery<WorkoutSession[]>("getWorkoutsForDate", { dateStr: localDateString(new Date()) });
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

      // Group sets by exercise, in the order each exercise first appears —
      // same reasoning as a wger routine's own log view, not a flat list
      // of 8 individual sets.
      const byExercise = new Map<string, WorkoutSet[]>();
      for (const set of session.sets) {
        const group = byExercise.get(set.exerciseName) ?? [];
        group.push(set);
        byExercise.set(set.exerciseName, group);
      }

      for (const [exerciseName, sets] of byExercise) {
        const row = document.createElement("div");
        row.className = "dashboard-row workout-row";

        const name = document.createElement("span");
        name.className = "dashboard-text";
        name.textContent = exerciseName;
        row.appendChild(name);

        const detail = document.createElement("span");
        detail.className = "workout-sets-detail";
        detail.textContent = sets.map((s) => (s.weight != null ? `${s.weight}kg × ${s.reps}` : `${s.reps} reps`)).join(", ");
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
