import { HouseViewer, preloadRoomAssets, ViewerCharacterStatus } from "./scene/viewer";
import { setActivities, ActivityDef } from "./scene/activities";
import { ObjectTypeDef, RoomSpecWire, roomSpecsFromWire, setObjectTypes, setRooms } from "./scene/rooms";
import { Floor, setFloors } from "./scene/floors";
import { Goal } from "./goals/types";
import { describeScheduleForDate, groupGoalsForDate } from "./goals/goalGroups";
import { addDaysToDateString, localDateString, parseDateString } from "./goals/recurrence";
import { formatMinutes, formatStreak } from "./goals/format";
import { buildModal } from "./ui/modal";
import { buildFloatingPanel } from "./ui/draggablePanel";
import { buildToggleGroup } from "./ui/toggleGroup";
import {
  buildDashboardSections,
  renderActivityList,
  renderAllTimeActivity,
  renderGoalList,
  renderGoalOutcomes,
  renderWorkoutToday,
} from "./dashboard/render";
import { WorkoutSession, WgerLifetimeStats, PersonalRecord } from "./workout/types";
import { summarizeWorkoutSessions } from "./workout/format";
import { CURRENT_USER_NAME, renderCurrentActivity, renderSyncStatus } from "./status/render";
import type { ActivityStat } from "./dashboard/stats";
import type { FixedPeriodKey, FixedPeriodStats } from "./dashboard/periodStats";
import { setupFloorButtons } from "./ui/floorButtons";
import { setupTopButtons } from "./ui/topButtons";
import { setupPixiApp } from "./ui/pixiApp";
import { setupMobileTabs } from "./ui/mobileTabs";
import { buildDisplaySettingsSection, DisplaySettingsCallbacks } from "./ui/displaySettings";
import { Theme } from "./settings/types";
import { applyTheme, THEME_BACKGROUND } from "./settings/themes";

// Edit this to your own deployed val.town status val before building/hosting
// this page — it's the only thing that needs to change per-deployment.
const STATUS_API_BASE = "https://jacquelinett--6dc86500cd6211f1876a1607ee4eb77e.web.val.run";

const POLL_INTERVAL_MS = 5 * 60 * 1000;

const DEFAULT_VIEWER_THEME: Theme = "pink";

interface ViewerSettings {
  scale: number;
  devMode: boolean;
  theme: Theme;
}

const VIEWER_SETTINGS_KEY = "houseSimulatorViewerSettings";

// No desktop-app-style Tauri fs here — this is a public static page, so
// localStorage is the whole persistence story (per-browser, not per-person;
// fine for "remember how I like to view this on my own screen").
function loadViewerSettings(): ViewerSettings {
  try {
    const raw = localStorage.getItem(VIEWER_SETTINGS_KEY);
    if (raw) return { scale: 2, devMode: false, theme: DEFAULT_VIEWER_THEME, ...JSON.parse(raw) };
  } catch {
    // ignore corrupt/inaccessible storage, just fall through to defaults
  }
  return { scale: 2, devMode: false, theme: DEFAULT_VIEWER_THEME };
}

function saveViewerSettings(settings: ViewerSettings) {
  localStorage.setItem(VIEWER_SETTINGS_KEY, JSON.stringify(settings));
}

interface CharacterStatus {
  activityLabel: string | null;
  startedAt: string | null;
  todayMinutesByLabel: Record<string, number>;
}

interface CharacterEntry {
  id: string;
  name: string;
  spriteName: string | null;
}

/**
 * The /api/all response — every published character's directory entry AND
 * all six of their data blobs, in one shot, each of the latter keyed by
 * character id. This replaced one GET per endpoint per character (status,
 * goals, stats, period-stats, yesterday, streaks, times however many
 * characters are published): a fast double-click used to fire two
 * overlapping batches of ~7 concurrent requests at val.town, which is what
 * produced the intermittent 500s fixed earlier. With one request for
 * everything, switching which character is being viewed (selectCharacter
 * below) is a pure client-side re-render against whatever's already in
 * `latestAll` — no network call at all — so there's no longer a
 * per-character/per-click request to race in the first place.
 */
interface AllDataResponse {
  characters: CharacterEntry[];
  status: Record<string, CharacterStatus>;
  goals: Record<string, Goal[]>;
  stats: Record<string, ActivityStat[]>;
  periodStats: Record<string, FixedPeriodStats[]>;
  yesterday: Record<string, Record<string, number>>;
  streaks: Record<string, Record<string, number>>;
  /** Absent on a val.town deployment not yet re-pasted with /api/workout-today support — see loadHouseLayout's own "fall back, don't break the page" reasoning. Missing or empty for a character just means "nothing to show," same contract the Dashboard's wger section has everywhere else (see dashboard/render.ts's renderWorkoutToday). */
  workoutToday?: Record<string, WorkoutSession[]>;
  /** Same "absent means not yet re-pasted" contract as workoutToday above — Lifetime Stats + Personal Records only, see server/broadcast.ts's pushWgerSummary on why the Log tab's session detail is deliberately excluded. */
  wgerSummary?: Record<string, { lifetimeStats: WgerLifetimeStats | null; personalRecords: PersonalRecord[] }>;
}

const SELECTED_CHARACTER_KEY = "houseSimulatorViewerCharacterId";

function loadSelectedCharacterId(): string | null {
  try {
    return localStorage.getItem(SELECTED_CHARACTER_KEY);
  } catch {
    return null;
  }
}

function saveSelectedCharacterId(id: string) {
  try {
    localStorage.setItem(SELECTED_CHARACTER_KEY, id);
  } catch {
    // ignore corrupt/inaccessible storage, same as saveViewerSettings
  }
}

/** null (rather than throwing) on a network failure or non-200 — the live val.town deployment may not have been re-pasted with /api/all support yet, same "fall back, don't break the page" reasoning as loadHouseLayout's catch below. */
async function fetchAll(): Promise<AllDataResponse | null> {
  try {
    const res = await fetch(`${STATUS_API_BASE}/api/all`);
    if (!res.ok) return null;
    return (await res.json()) as AllDataResponse;
  } catch {
    return null;
  }
}

/** Restores the last-selected character if it's still published, else defaults to Jacqueline (or the first entry) — same "restore or sensible default" shape as loadViewerSettings. */
function pickInitialCharacter(characters: CharacterEntry[]): CharacterEntry | null {
  if (characters.length === 0) return null;
  const savedId = loadSelectedCharacterId();
  const saved = savedId ? characters.find((c) => c.id === savedId) : undefined;
  return saved ?? characters.find((c) => c.name === CURRENT_USER_NAME) ?? characters[0];
}

/** Builds the "current activity" line (+ optional title above it, for the mobile Home tab, which has no panel header to show one) — shared by the Jacqueline panel and its mobile equivalent, which otherwise hand-built this same markup twice. On mobile the title is a clickable link-styled button (opens the character picker); the desktop panel doesn't pass showTitle at all, since its title lives in buildFloatingPanel's own header instead (kept in sync separately via setTitle). */
function buildCurrentActivityBlock(
  container: HTMLElement,
  options?: { showTitle?: boolean; initialTitle?: string; onTitleClick?: () => void },
): {
  render(status: { label: string | null; startedAt: Date | null }): void;
  showError(message: string): void;
  setTitleText(name: string): void;
} {
  let titleEl: HTMLButtonElement | null = null;
  if (options?.showTitle) {
    titleEl = document.createElement("button");
    titleEl.className = "mobile-status-title mobile-status-title-link";
    titleEl.textContent = options.initialTitle ?? CURRENT_USER_NAME;
    titleEl.onclick = () => options.onTitleClick?.();
    container.appendChild(titleEl);
  }

  const currentEl = document.createElement("div");
  currentEl.className = "overview-current";
  container.appendChild(currentEl);

  return {
    render: (status) => renderCurrentActivity(currentEl, status),
    showError: (message) => {
      currentEl.textContent = message;
    },
    setTitleText: (name) => {
      if (titleEl) titleEl.textContent = name;
    },
  };
}

/** Builds the VT sync line — same idea as buildCurrentActivityBlock above. No AW line at all, since the viewer has no AW access regardless of connection state. */
function buildSyncStatusBlock(
  container: HTMLElement,
): (vt: { configured: boolean; lastSuccessAt: Date | null; lastError: string | null }) => void {
  const syncEl = document.createElement("div");
  syncEl.className = "overview-status-line";
  container.appendChild(syncEl);

  return (vt) => renderSyncStatus(syncEl, { showAw: false, vt });
}

type DashboardDay = "today" | "yesterday";

interface DashboardRenderInput {
  goals: Goal[];
  todayMinutesByLabel: Record<string, number>;
  yesterdayMinutesByLabel: Record<string, number>;
  streaksByGoalId: Record<string, number>;
  activityLabel: string | null;
  startedAtMs: number | null;
  colorByLabel: Map<string, number>;
  workoutSessions: WorkoutSession[];
}

/**
 * Goal progress + activity breakdown for Today or Yesterday — a
 * Today/Yesterday hyperlink toggle stands in for the desktop app's own
 * Dashboard date picker, since the viewer has no AW access to query an
 * arbitrary day. "Yesterday" is whatever was last pushed to
 * /api/yesterday: a settled, complete day, so (unlike "today") it never
 * gets the live-elapsed-time math added. Shared by the desktop Dashboard
 * panel and the mobile Dashboard tab, each owning its own day selection —
 * same as how the app's own Dashboard date input works independently per
 * instance.
 */
function buildDashboardBlock(container: HTMLElement): { render(input: DashboardRenderInput): void } {
  let day: DashboardDay = "today";
  let latestInput: DashboardRenderInput | null = null;

  const dateRow = document.createElement("div");
  dateRow.className = "dashboard-date-row";
  dateRow.appendChild(
    buildToggleGroup(
      [
        ["today", "Today"],
        ["yesterday", "Yesterday"],
      ] as const,
      "today",
      (value) => {
        day = value;
        renderCurrent();
      },
      "day-link",
    ),
  );
  container.appendChild(dateRow);

  const { goalHeading, goalList, activityHeading, activityList, workoutSection, workoutList } = buildDashboardSections(container);

  function renderCurrent() {
    if (!latestInput) return;
    const {
      goals,
      todayMinutesByLabel,
      yesterdayMinutesByLabel,
      streaksByGoalId,
      activityLabel: runningLabel,
      startedAtMs,
      colorByLabel,
      workoutSessions,
    } = latestInput;
    const isToday = day === "today";

    // Always about the real current day regardless of the Today/Yesterday
    // toggle above — same reasoning as the desktop Dashboard panel's own
    // renderWorkout() (src/dashboard/panel.ts).
    renderWorkoutToday(workoutSection, workoutList, summarizeWorkoutSessions(workoutSessions));

    goalHeading.textContent = isToday ? "Today's Goals" : "Yesterday's Goals";
    activityHeading.textContent = isToday ? "Today's Activity" : "Yesterday's Activity";

    const date = isToday ? new Date() : parseDateString(addDaysToDateString(localDateString(new Date()), -1));
    const dateStr = localDateString(date);
    const minutesByLabel = isToday ? todayMinutesByLabel : yesterdayMinutesByLabel;
    const liveElapsedMinutes = isToday && startedAtMs ? (Date.now() - startedAtMs) / 60000 : 0;

    const goalEntries = groupGoalsForDate(goals, date).map(({ activityLabel, targetMinutes, goals: groupGoals }) => {
      const minutes = (minutesByLabel[activityLabel] ?? 0) + (activityLabel === runningLabel ? liveElapsedMinutes : 0);
      return {
        activityLabel,
        minutes,
        targetMinutes,
        done: minutes >= targetMinutes,
        subRows: groupGoals.map((g) => {
          const streakText = formatStreak(streaksByGoalId[g.id] ?? 0, g.highestStreak ?? 0);
          return `${describeScheduleForDate(g.recurrence, dateStr)} — ${formatMinutes(g.targetMinutes)}${streakText ? ` — ${streakText}` : ""}`;
        }),
      };
    });
    renderGoalList(goalList, goalEntries, isToday ? "No goals today" : "No goals yesterday");

    const activityEntries = Object.entries(minutesByLabel)
      .map(([label, minutes]) => ({
        label,
        color: colorByLabel.get(label) ?? 0xffffff,
        minutes: minutes + (label === runningLabel ? liveElapsedMinutes : 0),
      }))
      .filter((e) => e.minutes > 0)
      .sort((a, b) => b.minutes - a.minutes);
    renderActivityList(activityList, activityEntries, isToday ? "Nothing tracked today" : "Nothing tracked yesterday");
  }

  return {
    render(input) {
      latestInput = input;
      renderCurrent();
    },
  };
}

/**
 * All-Time Activity pie (same as before — no All-Time Goals here, since
 * goal completion/skip history never leaves the desktop app) plus a Period
 * tab fed from the 4 fixed windows pushed to val.town (This Week/Last
 * Week/This Month/Last Month, see dashboard/periodStats.ts): the viewer
 * has no AW access to run its own arbitrary-range queries, so it picks
 * from this fixed list instead of a free date picker like the desktop
 * Statistic modal's own Period tab. Shared by the desktop-viewport
 * Statistic modal and the mobile Statistic tab.
 */
function buildStatisticBlock(container: HTMLElement): {
  renderAllTime(stats: ActivityStat[]): void;
  renderPeriod(periods: FixedPeriodStats[]): void;
  renderWgerSummary(lifetimeStats: WgerLifetimeStats | null, personalRecords: PersonalRecord[]): void;
} {
  let latestPeriods: FixedPeriodStats[] = [];
  let selectedKey: FixedPeriodKey = "thisWeek";

  const tabsRow = document.createElement("div");
  tabsRow.className = "stat-tabs";
  container.appendChild(tabsRow);

  const allTimeSection = document.createElement("div");
  container.appendChild(allTimeSection);

  const periodSection = document.createElement("div");
  periodSection.style.display = "none";
  container.appendChild(periodSection);

  tabsRow.appendChild(
    buildToggleGroup(
      [
        ["all", "All Time"],
        ["period", "Period"],
      ] as const,
      "all",
      (tab) => {
        allTimeSection.style.display = tab === "all" ? "" : "none";
        periodSection.style.display = tab === "period" ? "" : "none";
      },
      "stat-tab",
    ),
  );

  // --- All Time ---

  const heading = document.createElement("h3");
  heading.className = "panel-section-heading";
  heading.textContent = "All-Time Activity (top 5)";
  allTimeSection.appendChild(heading);

  const pie = document.createElement("div");
  pie.id = "dashboard-pie";
  allTimeSection.appendChild(pie);

  const list = document.createElement("div");
  list.className = "dashboard-list";
  allTimeSection.appendChild(list);

  // --- Lifetime Stats + Personal Records (real wger data, the wger-linked
  // character only — see server/broadcast.ts's pushWgerSummary). Same
  // row-building style as the desktop app's own Workout modal tabs
  // (src/workout/modal.ts), just fed from the val.town blob instead of a
  // live RPC query — the viewer has no WebSocket connection to ask wger
  // directly. Hidden entirely (not an empty-state placeholder) when
  // there's nothing wger-linked to show, same "pride glance" stance
  // renderWorkoutToday already takes for the Dashboard's own wger section.
  const lifetimeHeading = document.createElement("h3");
  lifetimeHeading.className = "panel-section-heading";
  lifetimeHeading.textContent = "Lifetime Stats";
  allTimeSection.appendChild(lifetimeHeading);

  const lifetimeList = document.createElement("div");
  lifetimeList.className = "dashboard-list";
  allTimeSection.appendChild(lifetimeList);

  const recordsHeading = document.createElement("h3");
  recordsHeading.className = "panel-section-heading";
  recordsHeading.textContent = "Personal Records";
  allTimeSection.appendChild(recordsHeading);

  const recordsList = document.createElement("div");
  recordsList.className = "dashboard-list";
  allTimeSection.appendChild(recordsList);

  // --- Period: fixed buckets only, no date picker (see function comment). ---

  const controlsRow = document.createElement("div");
  controlsRow.className = "stat-period-controls";
  periodSection.appendChild(controlsRow);

  controlsRow.appendChild(
    buildToggleGroup(
      [
        ["thisWeek", "This Week"],
        ["lastWeek", "Last Week"],
        ["thisMonth", "This Month"],
        ["lastMonth", "Last Month"],
      ] as const,
      "thisWeek",
      (key) => {
        selectedKey = key;
        renderSelectedPeriod();
      },
    ),
  );

  const periodGoalsHeading = document.createElement("h3");
  periodGoalsHeading.className = "panel-section-heading";
  periodGoalsHeading.textContent = "Period Goals";
  periodSection.appendChild(periodGoalsHeading);

  const periodGoalsList = document.createElement("div");
  periodGoalsList.className = "dashboard-list";
  periodSection.appendChild(periodGoalsList);

  const periodOutcomesHeading = document.createElement("h3");
  periodOutcomesHeading.className = "panel-section-heading";
  periodOutcomesHeading.textContent = "Period Goal Outcomes";
  periodSection.appendChild(periodOutcomesHeading);

  const periodOutcomesList = document.createElement("div");
  periodSection.appendChild(periodOutcomesList);

  const periodActivityHeading = document.createElement("h3");
  periodActivityHeading.className = "panel-section-heading";
  periodActivityHeading.textContent = "Period Activity";
  periodSection.appendChild(periodActivityHeading);

  const periodPie = document.createElement("div");
  periodPie.id = "dashboard-period-pie";
  periodSection.appendChild(periodPie);

  const periodActivityList = document.createElement("div");
  periodActivityList.className = "dashboard-list";
  periodSection.appendChild(periodActivityList);

  function renderSelectedPeriod() {
    const period = latestPeriods.find((p) => p.key === selectedKey);
    periodGoalsHeading.textContent = period ? `Period Goals — ${period.label}` : "Period Goals";
    renderGoalList(
      periodGoalsList,
      (period?.goalProgress ?? []).map((p) => ({ ...p, subRows: [] })),
      "No goals that period",
    );
    renderGoalOutcomes(periodOutcomesList, {
      mostCompleted: period?.mostCompleted ?? null,
      mostSkipped: period?.mostSkipped ?? null,
    });
    renderAllTimeActivity(periodPie, periodActivityList, period?.activityStats ?? []);
  }

  return {
    renderAllTime(stats) {
      renderAllTimeActivity(pie, list, stats);
    },
    renderPeriod(periods) {
      latestPeriods = periods;
      renderSelectedPeriod();
    },
    renderWgerSummary(lifetimeStats, personalRecords) {
      const hasAny = lifetimeStats != null || personalRecords.length > 0;
      lifetimeHeading.style.display = hasAny ? "" : "none";
      lifetimeList.style.display = hasAny ? "" : "none";
      recordsHeading.style.display = hasAny ? "" : "none";
      recordsList.style.display = hasAny ? "" : "none";
      if (!hasAny) return;

      lifetimeList.textContent = "";
      if (lifetimeStats) {
        const rows: [string, string][] = [
          ["Total weight lifted", `${lifetimeStats.totalWeightLifted.toLocaleString()}${lifetimeStats.totalWeightLiftedUnit}`],
          ["Total workouts", String(lifetimeStats.totalWorkouts)],
          ["Current streak", `${lifetimeStats.currentStreak} day${lifetimeStats.currentStreak === 1 ? "" : "s"}`],
          ["Longest streak", `${lifetimeStats.longestStreak} day${lifetimeStats.longestStreak === 1 ? "" : "s"}`],
        ];
        for (const [label, value] of rows) {
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
          lifetimeList.appendChild(row);
        }
      }

      recordsList.textContent = "";
      for (const record of personalRecords) {
        const row = document.createElement("div");
        row.className = "dashboard-row workout-row";
        const name = document.createElement("span");
        name.className = "dashboard-text";
        name.textContent = record.exerciseName;
        row.appendChild(name);
        const detail = document.createElement("span");
        detail.className = "workout-sets-detail";
        const weightPart = `${record.weight}${record.weightUnit ?? "kg"} × ${record.reps}`;
        const oneRm = record.oneRepMaxEstimate != null ? ` (1RM ~${record.oneRepMaxEstimate}${record.weightUnit ?? "kg"})` : "";
        detail.textContent = `${weightPart}${oneRm}`;
        row.appendChild(detail);
        recordsList.appendChild(row);
      }
    },
  };
}

/** Shared by the inline Leave-a-note form (desktop/wide-viewport) and the mobile Message popup — just the network call, each caller handles its own form fields/status text. */
async function sendMessage(author: string, text: string): Promise<void> {
  const res = await fetch(`${STATUS_API_BASE}/api/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, author }),
  });
  if (!res.ok) throw new Error((await res.json()).error || "failed to send");
}

/**
 * Zoom + dev-mode outlines, independent of the desktop app's own Settings
 * — lets anyone viewing on a bigger/smaller screen adjust to taste (and is
 * handy for testing the viewer itself). Callbacks are supplied by the
 * caller (rather than built in here) so main() can pass the exact same
 * ones to both this modal and the mobile Settings tab's own instance —
 * that's what keeps the two in sync with each other.
 */
function setupSettingsModalUI(
  settings: ViewerSettings,
  callbacks: DisplaySettingsCallbacks,
): { open: () => void; update(values: ViewerSettings): void } {
  const modal = buildModal("Settings", { resizable: true });
  const display = buildDisplaySettingsSection(modal.body, settings, callbacks);
  return { open: modal.open, update: display.update };
}

/** A "native popup"-style dialog for leaving a note — the mobile Home tab's FAB, standing in for the inline form that doesn't fit there. */
function setupMobileMessageModal(): { open: () => void } {
  const modal = buildModal("Leave a note");

  const authorInput = document.createElement("input");
  authorInput.id = "viewer-author";
  authorInput.placeholder = "Your name (optional)";
  authorInput.maxLength = 50;
  modal.body.appendChild(authorInput);

  const textInput = document.createElement("textarea");
  textInput.id = "viewer-text";
  textInput.rows = 3;
  textInput.placeholder = "wow you actually lifted today, nice";
  textInput.maxLength = 500;
  modal.body.appendChild(textInput);

  const statusEl = document.createElement("div");
  statusEl.id = "viewer-send-status";
  modal.body.appendChild(statusEl);

  const actions = document.createElement("div");
  actions.className = "mobile-modal-actions";
  modal.body.appendChild(actions);

  const cancelBtn = document.createElement("button");
  cancelBtn.className = "mobile-modal-cancel";
  cancelBtn.textContent = "Cancel";
  cancelBtn.onclick = () => modal.close();
  actions.appendChild(cancelBtn);

  const sendBtn = document.createElement("button");
  sendBtn.id = "viewer-send";
  sendBtn.textContent = "Send";
  actions.appendChild(sendBtn);

  sendBtn.onclick = async () => {
    const text = textInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    try {
      await sendMessage(authorInput.value.trim(), text);
      textInput.value = "";
      statusEl.textContent = "Sent!";
      setTimeout(() => modal.close(), 600);
    } catch (err) {
      statusEl.textContent = `Error: ${(err as Error).message}`;
    } finally {
      sendBtn.disabled = false;
    }
  };

  return {
    open() {
      statusEl.textContent = "";
      modal.open();
    },
  };
}

/**
 * Small fixed-position button, visible in both the desktop-width and
 * mobile layouts (top-left — every other corner is already spoken for by
 * floor buttons/top buttons/the Jacqueline panel on desktop, or the mobile
 * tab bar/status/FAB on mobile; see shared-chrome.css). The viewer has no
 * live connection the way the desktop app's WebSocket does, so this is its
 * only way to force an immediate re-poll instead of waiting out the next
 * 5-minute interval. setBusy disables it (so it can't itself pile up extra
 * concurrent refreshes — the real request-deduplication still lives in
 * refreshStatus's own refreshInFlight/refreshPending guard, this is just
 * the matching UI state) and spins it while a refresh is in flight.
 */
function buildRefreshButton(onClick: () => void): { setBusy(busy: boolean): void } {
  const button = document.createElement("button");
  button.id = "viewer-refresh";
  button.textContent = "⟳";
  button.setAttribute("aria-label", "Refresh");
  document.body.appendChild(button);
  button.onclick = onClick;

  return {
    setBusy(busy) {
      button.disabled = busy;
      button.classList.toggle("spinning", busy);
    },
  };
}

/** Mobile Home's clickable character name (see buildCurrentActivityBlock's onTitleClick) opens this — one row per /api/characters entry, selecting one hands the chosen character back to the caller. */
function setupCharacterPickerModal(characters: CharacterEntry[], onSelect: (character: CharacterEntry) => void): { open: () => void } {
  const modal = buildModal("Switch character");

  for (const character of characters) {
    const row = document.createElement("button");
    row.className = "character-picker-row";
    row.textContent = character.name;
    row.onclick = () => {
      onSelect(character);
      modal.close();
    };
    modal.body.appendChild(row);
  }

  if (characters.length === 0) {
    const empty = document.createElement("div");
    empty.textContent = "No characters available.";
    modal.body.appendChild(empty);
  }

  return { open: () => modal.open() };
}

/**
 * Fetched once, before the scene is ever built — the viewer has no
 * WebSocket connection, so unlike the desktop app (which gets this same
 * data pushed once per connect over RPC) this is its only way to see
 * anything the admin tool has changed, rather than whatever
 * STATIC_ROOM_SPECS/STATIC_ACTIVITIES/STATIC_OBJECT_TYPES/STATIC_FLOORS
 * happened to be baked into this build. House Simulator only pushes this
 * once at its own startup and whenever the admin tool's "Sync to viewer"
 * button is clicked (not on a timer, not after every edit — see
 * server/adminApi.ts/index.ts), so there's no point re-fetching it on
 * the same poll interval as status/goals/stats; a plain reload picks up
 * whatever was last synced.
 */
async function loadHouseLayout(): Promise<void> {
  try {
    const res = await fetch(`${STATUS_API_BASE}/api/house-layout`);
    const data = (await res.json()) as { activities: ActivityDef[]; objectTypes: Record<string, ObjectTypeDef>; rooms: RoomSpecWire[]; floors: Floor[] };
    setActivities(data.activities);
    setObjectTypes(data.objectTypes);
    setFloors(data.floors);
    setRooms(roomSpecsFromWire(data.rooms), data.floors);
  } catch (err) {
    // Falls back to whatever STATIC_* this build shipped with — still a
    // real, renderable house, just possibly stale, rather than nothing.
    console.error("[viewer] failed to fetch house layout, using this build's static fallback", err);
  }
}

async function main() {
  // Unlike the desktop app (where settings load async from Tauri fs, so
  // the initial Pixi/CSS theme has to guess the default and get corrected
  // once settings actually load), localStorage here is synchronous — the
  // real saved theme is already known before anything renders, no flash.
  const viewerSettings = loadViewerSettings();
  document.documentElement.dataset.theme = viewerSettings.theme;

  const app = await setupPixiApp(THEME_BACKGROUND[viewerSettings.theme]);

  const roomLabelEl = document.querySelector<HTMLDivElement>("#room-label")!;

  // Must happen before setupFloorButtons()/anything else reads
  // rooms/ACTIVITIES/objectTypes/FLOORS — those are live module bindings
  // (see scene/rooms.ts etc.), and setupFloorButtons() below reads FLOORS
  // synchronously at call time, not reactively.
  await loadHouseLayout();

  // One combined fetch, used both to seed the character directory here
  // AND (via latestAll below) as this session's first render — no separate
  // "get the character list" request followed later by a "get everything"
  // request for the one actually selected.
  const initialAll = await fetchAll();
  const characters = initialAll?.characters ?? [];
  let selectedCharacter: CharacterEntry = pickInitialCharacter(characters) ?? { id: "", name: CURRENT_USER_NAME, spriteName: null };
  // Both reassigned once selectCharacter exists, below — forward-declared
  // here since the picker modal/scene that call them are built first.
  let openCharacterPicker: () => void = () => {};
  let onViewerCharacterClick: (character: CharacterEntry) => void = () => {};

  // Building the floor buttons before the HouseViewer needs no viewer at
  // all (bindGoToRoom happens after) — so the HouseViewer's own
  // onRoomChange callback, which fires synchronously inside its
  // constructor for the initial room, can just call
  // floorButtons.onRoomChange directly instead of needing a deferred
  // placeholder for the "button doesn't exist yet" ordering problem.
  const floorButtons = setupFloorButtons();

  await preloadRoomAssets();
  const viewer = new HouseViewer(
    app,
    (name) => {
      roomLabelEl.textContent = name;
      floorButtons.onRoomChange(name);
    },
    viewerSettings,
    // HouseViewer's own attribution lookup only ever knows {id, name} (see
    // scene/viewer.ts's attributionFor) — resolved against the already-
    // fetched character directory here so selectCharacter always gets a
    // full CharacterEntry (spriteName included), not a partial stand-in.
    (character) => {
      const full = characters.find((c) => c.id === character.id);
      if (full) onViewerCharacterClick(full);
    },
  );
  floorButtons.bindGoToRoom((roomId) => viewer.goToRoom(roomId));

  // Shared by the Settings modal and the mobile Settings tab's own
  // instance of the same Display section — persists + applies the change,
  // then re-syncs *both* instances' displayed controls, instead of
  // whichever one you didn't just touch silently going stale.
  let settingsModalUI: { update(values: ViewerSettings): void } | null = null;
  let mobileSettingsUI: { update(values: ViewerSettings): void } | null = null;
  function syncSettingsUI() {
    settingsModalUI?.update(viewerSettings);
    mobileSettingsUI?.update(viewerSettings);
  }

  const displaySettingsCallbacks: DisplaySettingsCallbacks = {
    onDevModeChange: (value) => {
      viewerSettings.devMode = value;
      viewer.setDevMode(value);
      saveViewerSettings(viewerSettings);
      syncSettingsUI();
    },
    onThemeChange: (value) => {
      viewerSettings.theme = value;
      applyTheme(app, value);
      saveViewerSettings(viewerSettings);
      syncSettingsUI();
    },
    onScaleChange: (value) => {
      viewerSettings.scale = value;
      viewer.setScale(value);
      saveViewerSettings(viewerSettings);
      syncSettingsUI();
    },
  };

  const settingsModal = setupSettingsModalUI(viewerSettings, displaySettingsCallbacks);
  settingsModalUI = settingsModal;

  // --- Jacqueline panel: same corner panel the desktop app has, minus the
  // AW line (no AW access here) and plus "Leave a note" (viewer-only). Its
  // title isn't fixed at "Jacqueline" like the desktop app's — it reflects
  // whichever character is currently selected (see selectCharacter below),
  // and is itself clickable to open the same character picker the mobile
  // title button does (desktop width has no separate switcher control). ---
  const jacquelinePanel = buildFloatingPanel(selectedCharacter.name, {
    closable: false,
    draggable: false,
    className: "goals-panel",
    onTitleClick: () => openCharacterPicker(),
  });

  const renderCurrentDesktop = buildCurrentActivityBlock(jacquelinePanel.body);

  const noteHeading = document.createElement("h3");
  noteHeading.className = "panel-section-heading";
  noteHeading.textContent = "Leave a note";
  jacquelinePanel.body.appendChild(noteHeading);

  const authorInput = document.createElement("input");
  authorInput.id = "viewer-author";
  authorInput.placeholder = "Your name (optional)";
  authorInput.maxLength = 50;
  jacquelinePanel.body.appendChild(authorInput);

  const textInput = document.createElement("textarea");
  textInput.id = "viewer-text";
  textInput.rows = 3;
  textInput.placeholder = "wow you actually lifted today, nice";
  textInput.maxLength = 500;
  jacquelinePanel.body.appendChild(textInput);

  const sendBtn = document.createElement("button");
  sendBtn.id = "viewer-send";
  sendBtn.textContent = "Send";
  jacquelinePanel.body.appendChild(sendBtn);

  const sendStatusEl = document.createElement("div");
  sendStatusEl.id = "viewer-send-status";
  jacquelinePanel.body.appendChild(sendStatusEl);

  const jacquelineDivider = document.createElement("div");
  jacquelineDivider.className = "panel-divider";
  jacquelinePanel.body.appendChild(jacquelineDivider);

  const renderSyncDesktop = buildSyncStatusBlock(jacquelinePanel.body);

  jacquelinePanel.open();

  // --- Dashboard panel: identical to the desktop app's, same position. ---
  const dashboardPanel = buildFloatingPanel("Dashboard", {
    closable: false,
    resizable: true,
    className: "dashboard-panel",
  });
  const dashboardDesktop = buildDashboardBlock(dashboardPanel.body);
  dashboardPanel.open();

  // --- Statistic modal: All-Time Activity section + Period tab, same shape the desktop app's Statistic modal has. ---
  const statisticModal = buildModal("Statistic", { size: "large", resizable: true });
  const statisticDesktop = buildStatisticBlock(statisticModal.body);

  setupTopButtons([
    {
      label: "Statistic",
      onclick: () => {
        statisticModal.open();
        statisticDesktop.renderAllTime(latestStats);
        statisticDesktop.renderPeriod(latestPeriodStats);
        statisticDesktop.renderWgerSummary(latestWgerLifetimeStats, latestWgerPersonalRecords);
      },
    },
    { label: "Settings", onclick: settingsModal.open },
  ]);

  // Appended directly to document.body (not inside #top-buttons/the mobile
  // tab pages), so CSS's blanket "hide all desktop chrome on mobile" rule
  // (shared-chrome.css's mobile media query) doesn't touch it — this one
  // button needs to work in both layouts.
  const refreshButton = buildRefreshButton(() => refreshStatus());

  // --- Mobile tabs: a separate UI tree, not a reflow of the above (see
  // shared-chrome.css's media query — both trees are always built, CSS
  // decides which is visible). Home has no panel chrome at all, just bare
  // status text + a FAB; Dashboard/Statistic/Settings mirror the floating
  // panel/modal content above into full-screen pages instead. ---
  const mobileTabs = setupMobileTabs([
    { id: "home", label: "Home" },
    { id: "dashboard", label: "Dashboard" },
    { id: "statistic", label: "Statistic" },
    { id: "settings", label: "Settings" },
  ] as const);

  const mobileStatus = document.createElement("div");
  mobileStatus.className = "mobile-status";
  mobileTabs.pages.home.appendChild(mobileStatus);

  const renderCurrentMobile = buildCurrentActivityBlock(mobileStatus, {
    showTitle: true,
    initialTitle: selectedCharacter.name,
    onTitleClick: () => openCharacterPicker(),
  });

  const mobileDivider = document.createElement("div");
  mobileDivider.className = "panel-divider";
  mobileStatus.appendChild(mobileDivider);

  const renderSyncMobile = buildSyncStatusBlock(mobileStatus);

  const mobileMessageModal = setupMobileMessageModal();
  const mobileFab = document.createElement("button");
  mobileFab.className = "mobile-fab";
  mobileFab.textContent = "✉";
  mobileFab.setAttribute("aria-label", "Leave a note");
  mobileFab.onclick = () => mobileMessageModal.open();
  mobileTabs.pages.home.appendChild(mobileFab);

  const dashboardMobile = buildDashboardBlock(mobileTabs.pages.dashboard);

  const statisticMobile = buildStatisticBlock(mobileTabs.pages.statistic);

  mobileSettingsUI = buildDisplaySettingsSection(mobileTabs.pages.settings, viewerSettings, displaySettingsCallbacks);

  mobileTabs.onTabChange((tab) => {
    if (tab === "statistic") {
      statisticMobile.renderAllTime(latestStats);
      statisticMobile.renderPeriod(latestPeriodStats);
      statisticMobile.renderWgerSummary(latestWgerLifetimeStats, latestWgerPersonalRecords);
    }
  });

  // The one payload a refresh actually fetches now; everything below is
  // just the selected character's own slice of it, recomputed by
  // renderForSelectedCharacter (on a real refresh OR a pure character
  // switch, see selectCharacter) rather than fetched separately per field.
  let latestAll: AllDataResponse | null = initialAll;
  let latestStats: ActivityStat[] = [];
  let latestPeriodStats: FixedPeriodStats[] = [];
  let startedAtMs: number | null = null;
  let latestActivityLabel: string | null = null;
  let latestTodayMinutesByLabel: Record<string, number> = {};
  let latestYesterdayMinutesByLabel: Record<string, number> = {};
  let latestStreaksByGoalId: Record<string, number> = {};
  let latestGoals: Goal[] = [];
  let latestWorkoutSessions: WorkoutSession[] = [];
  let latestWgerLifetimeStats: WgerLifetimeStats | null = null;
  let latestWgerPersonalRecords: PersonalRecord[] = [];
  let lastSyncAt: Date | null = null;
  let lastSyncError: string | null = null;

  // Coalesces overlapping refreshStatus() calls (e.g. mashing the manual
  // refresh button) into one in-flight request plus at most one queued
  // follow-up, instead of letting every call fire its own fetch at
  // val.town concurrently — which is what used to produce intermittent
  // 500s back when a character switch also triggered its own full fetch
  // (it no longer does, see selectCharacter, but this guard is cheap
  // insurance regardless of how refreshStatus ends up getting called).
  let refreshInFlight = false;
  let refreshPending = false;

  function renderDashboards() {
    const input: DashboardRenderInput = {
      goals: latestGoals,
      todayMinutesByLabel: latestTodayMinutesByLabel,
      yesterdayMinutesByLabel: latestYesterdayMinutesByLabel,
      streaksByGoalId: latestStreaksByGoalId,
      activityLabel: latestActivityLabel,
      startedAtMs,
      colorByLabel: new Map(latestStats.map((s) => [s.label, s.color] as const)),
      workoutSessions: latestWorkoutSessions,
    };
    dashboardDesktop.render(input);
    dashboardMobile.render(input);
  }

  function renderCurrent() {
    const status = { label: latestActivityLabel, startedAt: startedAtMs ? new Date(startedAtMs) : null };
    renderCurrentDesktop.render(status);
    renderCurrentMobile.render(status);
  }

  // "Synced" here means "last successfully fetched data from val.town" —
  // the viewer only ever polls, it never pushes, so this is the mirror
  // image of the desktop app's own VT sync indicator. No AW line at all,
  // since the viewer has no AW access regardless of connection state.
  function renderSync() {
    const vt = { configured: true, lastSuccessAt: lastSyncAt, lastError: lastSyncError };
    renderSyncDesktop(vt);
    renderSyncMobile(vt);
  }

  /**
   * Re-renders everything from whatever's already in `latestAll` — the
   * selected character's own slice of each field, plus the scene overlay
   * built from EVERY character's status (same as before, just read
   * straight out of the one combined payload instead of a separate
   * fetchAllStatuses call). Called after a real fetch lands (refreshStatus)
   * AND on a pure character switch (selectCharacter) — switching no longer
   * needs its own network round-trip at all, since the switch is just
   * picking a different key out of data that's already here.
   */
  function renderForSelectedCharacter() {
    const data = latestAll;
    const status = data?.status[selectedCharacter.id];
    latestGoals = data?.goals[selectedCharacter.id] ?? [];
    latestStats = data?.stats[selectedCharacter.id] ?? [];
    latestPeriodStats = data?.periodStats[selectedCharacter.id] ?? [];
    latestYesterdayMinutesByLabel = data?.yesterday[selectedCharacter.id] ?? {};
    latestStreaksByGoalId = data?.streaks[selectedCharacter.id] ?? {};
    latestWorkoutSessions = data?.workoutToday?.[selectedCharacter.id] ?? [];
    latestWgerLifetimeStats = data?.wgerSummary?.[selectedCharacter.id]?.lifetimeStats ?? null;
    latestWgerPersonalRecords = data?.wgerSummary?.[selectedCharacter.id]?.personalRecords ?? [];
    latestActivityLabel = status?.activityLabel ?? null;
    latestTodayMinutesByLabel = status?.todayMinutesByLabel ?? {};
    startedAtMs = status?.startedAt ? new Date(status.startedAt).getTime() : null;

    renderCurrent();
    // focusActivity pans to the SELECTED character's own activity (if
    // any); applyAllStatuses lights up every known character's object
    // regardless of selection — the "see everyone, like the Tauri app"
    // overlay, desktop-width click-to-switch included (see viewer.ts).
    viewer.focusActivity(latestActivityLabel);
    const allStatuses = new Map<string, ViewerCharacterStatus>();
    if (data) {
      for (const c of characters) {
        const cs = data.status[c.id];
        if (cs?.activityLabel)
          allStatuses.set(c.id, { characterId: c.id, characterName: c.name, characterSpriteName: c.spriteName, activityLabel: cs.activityLabel });
      }
    }
    viewer.applyAllStatuses(allStatuses);

    renderDashboards();
  }

  async function refreshStatus() {
    // See refreshPending's own comment above — a call that arrives while
    // one's already in flight just marks itself pending instead of firing
    // a second fetch at val.town right on top of the first.
    if (refreshInFlight) {
      refreshPending = true;
      return;
    }
    refreshInFlight = true;
    refreshButton.setBusy(true);
    try {
      const data = await fetchAll();
      // null on a network failure or non-200 (see fetchAll's own comment)
      // — thrown here, before touching latestAll, so a bad fetch just
      // fails this one refresh and leaves the last-known-good data (and
      // whatever's currently rendered) exactly as it was.
      if (!data) throw new Error("failed to fetch /api/all");
      latestAll = data;
      renderForSelectedCharacter();

      lastSyncAt = new Date();
      lastSyncError = null;
      renderSync();
    } catch (err) {
      console.error("[viewer] failed to fetch status", err);
      renderCurrentDesktop.showError("Couldn't load status");
      renderCurrentMobile.showError("Couldn't load status");
      lastSyncError = (err as Error).message;
      renderSync();
    } finally {
      refreshInFlight = false;
      refreshButton.setBusy(false);
      if (refreshPending) {
        refreshPending = false;
        refreshStatus();
      }
    }
  }

  // Switching characters: persist the choice, update both titles that show
  // a character's name (the desktop-layout panel's header, the mobile
  // title button itself), then just re-render from the data this already
  // has — no fetch, no ?character= query param, nothing to race.
  function selectCharacter(character: CharacterEntry) {
    selectedCharacter = character;
    saveSelectedCharacterId(character.id);
    jacquelinePanel.setTitle(character.name);
    renderCurrentMobile.setTitleText(character.name);
    renderForSelectedCharacter();
  }

  const characterPicker = setupCharacterPickerModal(characters, selectCharacter);
  openCharacterPicker = characterPicker.open;
  onViewerCharacterClick = selectCharacter;

  function tickElapsed() {
    renderCurrent();
    renderDashboards();
    renderSync();
  }

  let hiddenAt: number | null = null;
  // initialAll was already fetched once (up at the top of main(), to seed
  // the character directory before anything else was built) — render from
  // it directly instead of making refreshStatus() fetch the exact same
  // thing again. A failed initial fetch just falls through to a real
  // refreshStatus() call, which has its own error-state handling.
  if (initialAll) {
    renderForSelectedCharacter();
    lastSyncAt = new Date();
    renderSync();
  } else {
    await refreshStatus();
  }
  setInterval(refreshStatus, POLL_INTERVAL_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else if (hiddenAt !== null && Date.now() - hiddenAt > POLL_INTERVAL_MS) {
      refreshStatus();
    }
  });
  setInterval(tickElapsed, 1000);

  sendBtn.onclick = async () => {
    const text = textInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    try {
      await sendMessage(authorInput.value.trim(), text);
      textInput.value = "";
      sendStatusEl.textContent = "Sent!";
    } catch (err) {
      sendStatusEl.textContent = `Error: ${(err as Error).message}`;
    } finally {
      sendBtn.disabled = false;
    }
  };
}

main().catch((err) => {
  console.error("[viewer] fatal error", err);
});
