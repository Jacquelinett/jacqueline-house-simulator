import { buildToggleGroup } from "../ui/toggleGroup";
import { fetchWgerLifetimeStats, fetchWgerPersonalRecords, fetchWgerRecentDaySummaries } from "./client";
import { renderDaySummaries, renderLifetimeStats, renderPersonalRecords } from "./render";

function showLoading(container: HTMLElement): void {
  container.textContent = "";
  const loading = document.createElement("div");
  loading.className = "goals-empty";
  loading.textContent = "Loading...";
  container.appendChild(loading);
}

type WorkoutTab = "lifetime" | "records" | "logs";

/**
 * The desktop app's content for the Statistic modal's Workout tab (see
 * dashboard/statisticModal.ts, which nests this directly rather than
 * giving it its own top-level modal/mobile-tab the way it used to —
 * folded in once it became clear "Workout gets its own menu on desktop
 * but lives under Statistic on the viewer" was just an inconsistency to
 * fix, not a deliberate difference). A segmented toggle (src/shared-
 * chrome.css's .segment-toggle-btn, visually distinct from the modal's
 * own outer Goals/Workout tabs) between Lifetime Stats/Personal Records/
 * Logs — all three backed by server_config.wger_base_url + this
 * character's own characters.wger_api_token (server/wger.ts); empty for a
 * non-wger-linked character, never placeholder data (see
 * server/workouts.ts's own comment on why the old mock mirror is gone).
 * The actual row-building for each tab lives in src/workout/render.ts,
 * shared with the viewer's own Workout tab (src/viewer-main.ts) — this
 * file only wires up the live RPC fetch per tab, which the viewer doesn't
 * have (it renders the same functions straight off a polled val.town
 * blob instead). See also the Dashboard's "Lifted Today" section (src/
 * dashboard/panel.ts), a coarser always-visible summary independent of
 * this tab being open at all.
 */
export function setupWorkoutContent(container: HTMLElement): { refresh(): void } {
  let activeTab: WorkoutTab = "lifetime";

  const toggleRow = document.createElement("div");
  toggleRow.className = "segment-toggle-row";
  container.appendChild(toggleRow);

  const lifetimeSection = document.createElement("div");
  container.appendChild(lifetimeSection);

  const recordsSection = document.createElement("div");
  recordsSection.style.display = "none";
  container.appendChild(recordsSection);

  const logsSection = document.createElement("div");
  logsSection.style.display = "none";
  container.appendChild(logsSection);

  const sections: Record<WorkoutTab, HTMLElement> = { lifetime: lifetimeSection, records: recordsSection, logs: logsSection };
  const renderers: Record<WorkoutTab, () => void> = {
    lifetime: renderLifetime,
    records: renderRecords,
    logs: renderLogs,
  };

  toggleRow.appendChild(
    buildToggleGroup(
      [
        ["lifetime", "Lifetime Stats"],
        ["records", "Personal Records"],
        ["logs", "Logs"],
      ] as const,
      "lifetime",
      (tab) => {
        activeTab = tab;
        for (const [t, section] of Object.entries(sections) as [WorkoutTab, HTMLElement][]) section.style.display = t === tab ? "" : "none";
        renderers[tab]();
      },
      "segment-toggle-btn",
    ),
  );

  const lifetimeList = document.createElement("div");
  lifetimeList.className = "dashboard-list";
  lifetimeSection.appendChild(lifetimeList);

  async function renderLifetime() {
    showLoading(lifetimeList);
    const stats = await fetchWgerLifetimeStats().catch((err) => {
      console.error("[workout] failed to load lifetime stats", err);
      return null;
    });
    renderLifetimeStats(lifetimeList, stats);
  }

  const recordsList = document.createElement("div");
  recordsList.className = "dashboard-list";
  recordsSection.appendChild(recordsList);

  async function renderRecords() {
    showLoading(recordsList);
    const records = await fetchWgerPersonalRecords().catch((err) => {
      console.error("[workout] failed to load personal records", err);
      return null;
    });
    renderPersonalRecords(recordsList, records);
  }

  const logsList = document.createElement("div");
  logsList.className = "dashboard-list";
  logsSection.appendChild(logsList);

  async function renderLogs() {
    showLoading(logsList);
    const days = await fetchWgerRecentDaySummaries().catch((err) => {
      console.error("[workout] failed to load recent days", err);
      return null;
    });
    renderDaySummaries(logsList, days);
  }

  return {
    refresh() {
      renderers[activeTab]();
    },
  };
}
