import { buildModal } from "../ui/modal";
import { getActivityStats } from "./stats";
import { formatMinutes } from "../goals/ui";
import { toCssColor } from "../scene/activities";

export function setupDashboardModal(): { open: () => void } {
  const modal = buildModal("Dashboard");

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  modal.body.appendChild(pie);

  const list = document.createElement("div");
  list.id = "dashboard-list";
  modal.body.appendChild(list);

  async function render() {
    list.textContent = "";
    const loading = document.createElement("div");
    loading.className = "goals-empty";
    loading.textContent = "Loading...";
    list.appendChild(loading);

    const stats = await getActivityStats().catch((err) => {
      console.error("[dashboard] failed to load stats", err);
      return null;
    });

    list.textContent = "";
    if (!stats) {
      const error = document.createElement("div");
      error.className = "goals-empty";
      error.textContent = "Failed to load stats";
      list.appendChild(error);
      return;
    }

    // The pie represents each activity's share of average daily time (how a
    // typical day splits up), not all-time totals — a newer activity
    // shouldn't look negligible forever just because it started later.
    const dailyTotal = stats.reduce((sum, s) => sum + s.averageMinutesPerDay, 0);
    if (dailyTotal > 0) {
      let cursor = 0;
      const stops: string[] = [];
      for (const s of stats) {
        if (s.averageMinutesPerDay <= 0) continue;
        const start = (cursor / dailyTotal) * 100;
        cursor += s.averageMinutesPerDay;
        const end = (cursor / dailyTotal) * 100;
        stops.push(`${toCssColor(s.color)} ${start}% ${end}%`);
      }
      pie.style.background = `conic-gradient(${stops.join(", ")})`;
    } else {
      pie.style.background = "rgba(255, 255, 255, 0.1)";
    }

    if (stats.every((s) => s.totalMinutesAllTime === 0)) {
      const empty = document.createElement("div");
      empty.className = "goals-empty";
      empty.textContent = "No tracked time yet";
      list.appendChild(empty);
      return;
    }

    for (const s of stats) {
      const row = document.createElement("div");
      row.className = "dashboard-row";

      const swatch = document.createElement("span");
      swatch.className = "dashboard-swatch";
      swatch.style.background = toCssColor(s.color);
      row.appendChild(swatch);

      const text = document.createElement("span");
      text.className = "dashboard-text";
      text.textContent = `${s.label} — ${formatMinutes(s.totalMinutesAllTime)} total, ${formatMinutes(s.averageMinutesPerDay)}/day avg`;
      row.appendChild(text);

      list.appendChild(row);
    }
  }

  return {
    open() {
      modal.open();
      render();
    },
  };
}
