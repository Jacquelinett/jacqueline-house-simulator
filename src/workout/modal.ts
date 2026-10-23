import { buildModal } from "../ui/modal";
import { buildToggleGroup } from "../ui/toggleGroup";
import { localDateString } from "../goals/recurrence";
import { fetchWorkoutsForDate, fetchWgerLifetimeStats, fetchWgerPersonalRecords, fetchWgerRecentSessions } from "./client";
import { WorkoutSession } from "./types";
import { formatSetDetail, groupSetsByExercise } from "./format";
import { buildWorkoutRow, buildWorkoutSubRow } from "./render";

function showLoading(container: HTMLElement): void {
  container.textContent = "";
  const loading = document.createElement("div");
  loading.className = "goals-empty";
  loading.textContent = "Loading...";
  container.appendChild(loading);
}

function showEmpty(container: HTMLElement, text: string): void {
  container.textContent = "";
  const empty = document.createElement("div");
  empty.className = "goals-empty";
  empty.textContent = text;
  container.appendChild(empty);
}

type WorkoutTab = "today" | "lifetime" | "records" | "log";

/**
 * Read-only display of real wger workout data — four tabs, all backed by
 * server_config.wger_base_url + this character's own characters.wger_api_token
 * (server/wger.ts); every tab is empty for a non-wger-linked character,
 * not placeholder data (see
 * server/workouts.ts's own comment on why the old mock mirror is gone).
 * Deliberately independent of AW/goals entirely — just "what did I lift,"
 * no activity-tracking tie-in. See also the Dashboard's "Lifted Today"
 * section (src/dashboard/panel.ts), which shows a coarser summary of the
 * Today tab's exact same data without needing this modal open.
 *
 * Split from setupWorkoutModal() below the same way setupStatisticContent
 * is split from setupStatisticModal() — pure content, no modal chrome —
 * so the exact same tabs can be reused as a mobile tab page instead of a
 * second, drifting copy (see main.ts's setupMobileUI()).
 */
export function setupWorkoutContent(container: HTMLElement): { refresh(): void } {
  let activeTab: WorkoutTab = "today";

  const tabsRow = document.createElement("div");
  tabsRow.className = "stat-tabs";
  container.appendChild(tabsRow);

  const todaySection = document.createElement("div");
  container.appendChild(todaySection);

  const lifetimeSection = document.createElement("div");
  lifetimeSection.style.display = "none";
  container.appendChild(lifetimeSection);

  const recordsSection = document.createElement("div");
  recordsSection.style.display = "none";
  container.appendChild(recordsSection);

  const logSection = document.createElement("div");
  logSection.style.display = "none";
  container.appendChild(logSection);

  const sections: Record<WorkoutTab, HTMLElement> = { today: todaySection, lifetime: lifetimeSection, records: recordsSection, log: logSection };
  const renderers: Record<WorkoutTab, () => void> = {
    today: renderToday,
    lifetime: renderLifetime,
    records: renderRecords,
    log: renderLog,
  };

  tabsRow.appendChild(
    buildToggleGroup(
      [
        ["today", "Today"],
        ["lifetime", "Lifetime Stats"],
        ["records", "Personal Records"],
        ["log", "Log"],
      ] as const,
      "today",
      (tab) => {
        activeTab = tab;
        for (const [t, section] of Object.entries(sections) as [WorkoutTab, HTMLElement][]) section.style.display = t === tab ? "" : "none";
        renderers[tab]();
      },
      "stat-tab",
    ),
  );

  // --- Today ---

  const todayList = document.createElement("div");
  todayList.className = "dashboard-list";
  todaySection.appendChild(todayList);

  async function renderToday() {
    showLoading(todayList);

    let sessions: WorkoutSession[];
    try {
      sessions = await fetchWorkoutsForDate(localDateString(new Date()));
    } catch (err) {
      console.error("[workout] failed to load today's sessions", err);
      showEmpty(todayList, "Failed to load workout data");
      return;
    }

    if (sessions.length === 0) {
      showEmpty(todayList, "No workouts logged today");
      return;
    }

    todayList.textContent = "";
    for (const session of sessions) {
      if (session.notes) {
        const notes = document.createElement("div");
        notes.className = "workout-session-notes";
        notes.textContent = session.notes;
        todayList.appendChild(notes);
      }

      for (const [exerciseName, sets] of groupSetsByExercise(session.sets)) {
        const details = formatSetDetail(sets);
        todayList.appendChild(buildWorkoutRow(exerciseName, details[0] ?? ""));

        // One line per additional weight/rep group beyond the first —
        // same reasoning/markup as the Dashboard's own "Lifted Today"
        // section (src/dashboard/render.ts's renderWorkoutToday).
        for (const extra of details.slice(1)) {
          todayList.appendChild(buildWorkoutSubRow(extra));
        }
      }
    }
  }

  // --- Lifetime Stats ---

  const lifetimeList = document.createElement("div");
  lifetimeList.className = "dashboard-list";
  lifetimeSection.appendChild(lifetimeList);

  async function renderLifetime() {
    showLoading(lifetimeList);

    const stats = await fetchWgerLifetimeStats().catch((err) => {
      console.error("[workout] failed to load lifetime stats", err);
      return null;
    });

    if (!stats) {
      showEmpty(lifetimeList, "No wger account linked");
      return;
    }

    lifetimeList.textContent = "";
    const rows: [string, string][] = [
      ["Total weight lifted", `${stats.totalWeightLifted.toLocaleString()}${stats.totalWeightLiftedUnit}`],
      ["Total workouts", String(stats.totalWorkouts)],
      ["Current streak", `${stats.currentStreak} day${stats.currentStreak === 1 ? "" : "s"}`],
      ["Longest streak", `${stats.longestStreak} day${stats.longestStreak === 1 ? "" : "s"}`],
      ["Last workout", stats.lastWorkoutDate ? new Date(stats.lastWorkoutDate).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—"],
    ];
    for (const [label, value] of rows) {
      lifetimeList.appendChild(buildWorkoutRow(label, value));
    }
  }

  // --- Personal Records ---

  const recordsList = document.createElement("div");
  recordsList.className = "dashboard-list";
  recordsSection.appendChild(recordsList);

  async function renderRecords() {
    showLoading(recordsList);

    const records = await fetchWgerPersonalRecords().catch((err) => {
      console.error("[workout] failed to load personal records", err);
      return null;
    });

    if (records === null) {
      showEmpty(recordsList, "Failed to load personal records");
      return;
    }
    if (records.length === 0) {
      showEmpty(recordsList, "No personal records yet");
      return;
    }

    recordsList.textContent = "";
    for (const record of records) {
      const weightPart = `${record.weight}${record.weightUnit ?? "kg"} × ${record.reps}`;
      const oneRm = record.oneRepMaxEstimate != null ? ` (1RM ~${record.oneRepMaxEstimate}${record.weightUnit ?? "kg"})` : "";
      recordsList.appendChild(buildWorkoutRow(record.exerciseName, `${weightPart}${oneRm}`));
      recordsList.appendChild(buildWorkoutSubRow(new Date(record.date).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })));
    }
  }

  // --- Log (last 7 sessions) ---

  const logList = document.createElement("div");
  logList.className = "dashboard-list";
  logSection.appendChild(logList);

  const IMPRESSION_TEXT: Record<"bad" | "neutral" | "good", string> = { bad: "Bad", neutral: "Neutral", good: "Good" };

  async function renderLog() {
    showLoading(logList);

    const sessions = await fetchWgerRecentSessions().catch((err) => {
      console.error("[workout] failed to load recent sessions", err);
      return null;
    });

    if (sessions === null) {
      showEmpty(logList, "Failed to load log");
      return;
    }
    if (sessions.length === 0) {
      showEmpty(logList, "No sessions logged yet");
      return;
    }

    logList.textContent = "";
    for (const session of sessions) {
      const start = new Date(session.datetimeStart);
      const end = session.datetimeEnd ? new Date(session.datetimeEnd) : null;
      const dateLabel = start.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
      const timeLabel = `${start.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })} – ${end ? end.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }) : "ongoing"}`;

      logList.appendChild(buildWorkoutRow(dateLabel, timeLabel));

      if (session.impression) {
        logList.appendChild(buildWorkoutSubRow(`Impression: ${IMPRESSION_TEXT[session.impression]}`));
      }

      if (session.notes) {
        const notes = document.createElement("div");
        notes.className = "workout-session-notes";
        notes.textContent = session.notes;
        logList.appendChild(notes);
      }
    }
  }

  return {
    refresh() {
      renderers[activeTab]();
    },
  };
}

/** Opened on demand from the Workout button, same "wrap the shared content in modal chrome" pattern setupStatisticModal() uses for the Statistic modal. */
export function setupWorkoutModal(): { open: () => void } {
  const modal = buildModal("Workout", { size: "large", resizable: true });
  const content = setupWorkoutContent(modal.body);

  return {
    open() {
      modal.open();
      content.refresh();
    },
  };
}
