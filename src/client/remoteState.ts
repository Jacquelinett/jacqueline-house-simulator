import { Goal } from "../goals/types";
import { Todo } from "../todos/types";
import { DEFAULT_DEVICE_SETTINGS, DeviceSettings } from "../settings/types";
import { ActivityDef } from "../scene/activities";
import { ObjectTypeDef, RoomSpecWire } from "../scene/rooms";
import { Floor } from "../scene/floors";

const DEVICE_ID_KEY = "houseSimulatorDeviceId";
const SERVER_URL_KEY = "houseSimulatorServerUrl";
const LAN_SECRET_KEY = "houseSimulatorLanSecret";

/**
 * "Switch character" (desktop Settings only — see settings/modal.ts) —
 * clears the cached server address/secret so the next connect attempt
 * shows the setup form again instead of reconnecting as whoever this
 * device was last authenticated as. Deliberately leaves the deviceId
 * alone — that identifies the physical device, not which character it's
 * currently connected as, and device-scoped settings (scale/theme/devMode)
 * should carry over to the next character too. Doesn't touch the live
 * socket itself; the caller reloads the page/app right after, which is
 * what actually tears down the old session and everything built around
 * its data.
 */
export function clearStoredConnection(): void {
  localStorage.removeItem(SERVER_URL_KEY);
  localStorage.removeItem(LAN_SECRET_KEY);
}

/**
 * crypto.randomUUID() only exists in secure contexts (HTTPS or localhost)
 * — a plain http://<lan-ip>:4000 connection, the normal way another device
 * on the home WiFi reaches the server, isn't one, so calling it there
 * throws "crypto.randomUUID is not a function". This id is never
 * security-sensitive (it only ever identifies "which device," not an
 * auth credential), so a plain Math.random()-based UUID v4 is a fine
 * fallback when the real one isn't available.
 */
function generateDeviceId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** One id per browser/device, generated once and kept in localStorage — same trick viewer-main.ts already uses for its own settings key, just storing an id instead of values now (settings themselves live server-side, keyed by this). */
function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = generateDeviceId();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

/**
 * Tauri's webview (WKWebView on macOS in particular) doesn't implement
 * window.prompt() — it returns null immediately instead of ever showing
 * anything, which made the very first connection attempt fail instantly
 * with "no server address provided" before the user saw a dialog at all.
 * Built as plain DOM instead, same as every other in-app dialog here —
 * no close button and no outside-click dismissal, since there's nothing
 * usable behind it yet (no connection, no scene) for a cancel to fall
 * back to.
 */
/**
 * `prefill`/`connectError` turn this into the same form shown again after a
 * failed attempt (wrong secret, unreachable server, ...) — see
 * connectRemoteState()'s retry loop — pre-filled with whatever was just
 * tried (so fixing a typo doesn't mean retyping both fields) and showing
 * why it failed, rather than the bare first-launch form.
 */
function promptForConnectionDetails(prefill?: { serverUrl: string; lanSecret: string }, connectError?: string): Promise<{ serverUrl: string; lanSecret: string }> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay open";
    overlay.id = "connection-setup-overlay";

    const dialog = document.createElement("div");
    dialog.className = "modal-dialog";
    overlay.appendChild(dialog);

    const header = document.createElement("div");
    header.className = "modal-header";
    const titleEl = document.createElement("h2");
    titleEl.textContent = connectError ? "Couldn't connect — check the details below" : "Connect to House Simulator server";
    header.appendChild(titleEl);
    dialog.appendChild(header);

    const body = document.createElement("div");
    body.className = "modal-body";
    dialog.appendChild(body);

    const form = document.createElement("form");
    form.id = "connection-setup-form";
    body.appendChild(form);

    const urlLabel = document.createElement("label");
    urlLabel.textContent = "Server address (e.g. ws://192.168.0.50:4000) — not http://, and not 0.0.0.0";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.required = true;
    // Defaults to the overwhelmingly common same-machine dev case — the
    // WebSocket RPC server (server/index.ts), not the Vite dev server.
    urlInput.value = prefill?.serverUrl ?? "ws://localhost:4000";
    urlLabel.appendChild(urlInput);
    form.appendChild(urlLabel);

    const secretLabel = document.createElement("label");
    // Stale through the per-character auth migration: this used to be the
    // one shared server_config.lan_secret (which is why the variable/key
    // names below are still "lanSecret"), but the WS handshake now resolves
    // a CHARACTER by this value (getCharacterBySecret() — see
    // server/characters.ts), so it has to be that character's own secret
    // from the admin tool's Characters tab, not the old global value —
    // and it's never optional anymore, so "leave blank if none" no longer
    // applies either (a blank secret matches no character and 4001s).
    secretLabel.textContent = "Character secret (from the admin tool's Characters tab — e.g. your own character's secret)";
    const secretInput = document.createElement("input");
    secretInput.type = "text";
    secretInput.value = prefill?.lanSecret ?? "";
    secretLabel.appendChild(secretInput);
    form.appendChild(secretLabel);

    const errorEl = document.createElement("div");
    errorEl.className = "connection-setup-error";
    errorEl.textContent = connectError ?? "";
    form.appendChild(errorEl);

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.textContent = "Connect";
    form.appendChild(submitBtn);

    form.onsubmit = (e) => {
      e.preventDefault();
      const serverUrl = urlInput.value.trim();
      // The WebSocket constructor requires ws:/wss: — it doesn't upgrade
      // http:// the way <img>/fetch would, and a bare 0.0.0.0 is the
      // server's own "listen on every interface" bind address, not
      // something a client can connect to. Catching both here instead of
      // letting them fail opaquely once the connection attempt starts.
      if (!/^wss?:\/\//i.test(serverUrl)) {
        errorEl.textContent = "Address must start with ws:// or wss://";
        return;
      }
      if (/\b0\.0\.0\.0\b/.test(serverUrl)) {
        errorEl.textContent = "0.0.0.0 isn't a connectable address — use localhost or the server's real IP";
        return;
      }
      const lanSecret = secretInput.value.trim();
      localStorage.setItem(SERVER_URL_KEY, serverUrl);
      localStorage.setItem(LAN_SECRET_KEY, lanSecret);
      overlay.remove();
      resolve({ serverUrl, lanSecret });
    };

    document.body.appendChild(overlay);
    urlInput.focus();
  });
}

/** Same externally-visible shape as src/lib/persistedState.ts's createPersistedState (get/onChange) — but fed by WebSocket `state` broadcasts instead of a local file, via the internal _set the socket dispatcher below calls. */
function createRemoteStore<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: (): T => value,
    onChange(cb: () => void): void {
      listeners.add(cb);
    },
    _set(next: T): void {
      value = next;
      for (const cb of listeners) cb();
    },
  };
}

export interface RemoteStatus {
  activityLabel: string | null;
  startedAt: string | null;
}

export interface RemoteCharacter {
  id: string;
  name: string;
  spriteName: string | null;
}

export interface AllStatusesEntry {
  characterName: string;
  characterSpriteName: string | null;
  activityLabel: string;
  startedAt: string;
}

const goalsStore = createRemoteStore<Goal[]>([]);
const todosStore = createRemoteStore<Todo[]>([]);
const statusStore = createRemoteStore<RemoteStatus>({ activityLabel: null, startedAt: null });
// Every character CURRENTLY running something, keyed by characterId, not
// just this connection's own — see server/rpc.ts's computeAllStatuses for
// why this is separate from statusStore above (which stays private to the
// connecting character's own clients). Lets House.ts show that another
// character is doing something without being scoped to their broadcast.
const allStatusesStore = createRemoteStore<Record<string, AllStatusesEntry>>({});
const settingsStore = createRemoteStore<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);
// Which character this connection's secret authenticated as — replaces the
// old hardcoded CURRENT_USER_NAME for any surface that needs to work for
// whichever character is actually connected (see goals/panel.ts).
const characterStore = createRemoteStore<RemoteCharacter>({ id: "", name: "", spriteName: null });
// Global scene registry (same for every character) — main.ts/viewer-main.ts
// feed these straight into scene/activities.ts's setActivities()/
// scene/rooms.ts's setObjectTypes()/setRooms() right after connecting, see
// those files' own comments on why that's safe for every existing importer.
const activitiesStore = createRemoteStore<ActivityDef[]>([]);
const objectTypesStore = createRemoteStore<Record<string, ObjectTypeDef>>({});
const roomSpecsStore = createRemoteStore<RoomSpecWire[]>([]);
const floorsStore = createRemoteStore<Floor[]>([]);

export const getGoals = goalsStore.get;
export const onGoalsChange = goalsStore.onChange;
export const getTodos = todosStore.get;
export const onTodosChange = todosStore.onChange;
export const getRemoteStatus = statusStore.get;
export const onRemoteStatusChange = statusStore.onChange;
export const getAllStatuses = allStatusesStore.get;
export const onAllStatusesChange = allStatusesStore.onChange;
export const getDeviceSettings = settingsStore.get;
export const onDeviceSettingsChange = settingsStore.onChange;
export const getCharacter = characterStore.get;
export const onCharacterChange = characterStore.onChange;
export const getRemoteActivities = activitiesStore.get;
export const getRemoteObjectTypes = objectTypesStore.get;
export const getRemoteRoomSpecs = roomSpecsStore.get;
export const getRemoteFloors = floorsStore.get;

const storesByKey: Record<string, { _set(data: unknown): void }> = {
  goals: goalsStore,
  todos: todosStore,
  status: statusStore,
  allStatuses: allStatusesStore,
  settings: settingsStore,
  character: characterStore,
  activities: activitiesStore,
  objectTypes: objectTypesStore,
  roomSpecs: roomSpecsStore,
  floors: floorsStore,
};

let socket: WebSocket | null = null;
let requestCounter = 0;
const pendingQueries = new Map<string, { resolve(value: unknown): void; reject(err: Error): void }>();

/** One attempt — resolves once the WS is open AND every initial state broadcast has arrived, rejects on any connection failure (bad secret, unreachable server, ...). Doesn't touch localStorage itself; connectRemoteState()'s retry loop decides what to do with a failure. */
function attemptConnect(serverUrl: string, lanSecret: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const deviceId = getOrCreateDeviceId();
    const url = `${serverUrl}?deviceId=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(lanSecret)}`;

    const ws = new WebSocket(url);
    socket = ws;

    // `open` only means the socket connected, not that the server's initial
    // state broadcasts (sent right after connection) have arrived yet —
    // resolving on `open` alone risks main.ts building UI off each store's
    // empty initial value. Wait for all of them instead.
    const pendingInitialKeys = new Set(Object.keys(storesByKey));

    ws.addEventListener("error", () => reject(new Error("Couldn't reach that server address")));
    ws.addEventListener("close", (event) => {
      console.error(`[remoteState] WebSocket closed (code ${event.code})`);
      if (event.code === 4001) reject(new Error("Server rejected the secret"));
      else if (event.code === 4002) reject(new Error("Missing device id"));
      else reject(new Error(`Connection closed (code ${event.code})`));
    });

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data as string);

      if (msg.type === "state") {
        storesByKey[msg.key]?._set(msg.data);
        if (pendingInitialKeys.delete(msg.key) && pendingInitialKeys.size === 0) resolve();
        return;
      }

      if (msg.type === "queryResult") {
        const pending = pendingQueries.get(msg.requestId);
        if (!pending) return;
        pendingQueries.delete(msg.requestId);
        if (msg.error) pending.reject(new Error(msg.error));
        else pending.resolve(msg.data);
      }
    });
  });
}

/**
 * Opens the one WebSocket connection everything else in this module
 * depends on — resolves once connected, so callers (main.ts) can await
 * this before building UI that expects goals/todos/status to already be
 * populated. See server/rpc.ts for the protocol this speaks.
 *
 * The common case (a working cached serverUrl/lanSecret from a previous
 * launch) connects silently, no prompt at all. Any failure — wrong secret,
 * unreachable address, anything attemptConnect() rejects with — re-shows
 * the same connection-setup form (pre-filled with what was just tried) and
 * retries, in a loop, rather than giving up after one failed attempt and
 * leaving the caller to show a dead error screen. There's no way to
 * cancel out of this loop short of entering something that actually
 * connects — same "nothing usable behind it yet" reasoning
 * promptForConnectionDetails's own comment gives for having no close
 * button.
 */
export async function connectRemoteState(): Promise<void> {
  let serverUrl = localStorage.getItem(SERVER_URL_KEY);
  let lanSecret = localStorage.getItem(LAN_SECRET_KEY);
  if (!serverUrl || lanSecret === null) {
    const entered = await promptForConnectionDetails();
    serverUrl = entered.serverUrl;
    lanSecret = entered.lanSecret;
  }

  while (true) {
    try {
      await attemptConnect(serverUrl, lanSecret);
      return;
    } catch (err) {
      console.error("[remoteState] connection attempt failed", err);
      const entered = await promptForConnectionDetails({ serverUrl, lanSecret }, (err as Error).message);
      serverUrl = entered.serverUrl;
      lanSecret = entered.lanSecret;
    }
  }
}

/** Fire-and-forget write — the server re-broadcasts whatever state actually changed, so there's nothing to await here. */
export function sendCommand(name: string, args: Record<string, unknown> = {}): void {
  socket?.send(JSON.stringify({ type: "command", name, args }));
}

/** Request/response, correlated by requestId — for on-demand computed data (date-picker queries, period stats, ...) that isn't part of the unsolicited state broadcasts. */
export function sendQuery<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve, reject) => {
    const requestId = String(requestCounter++);
    pendingQueries.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
    socket?.send(JSON.stringify({ type: "query", requestId, name, args }));
  });
}
