import { Goal } from "../goals/types";
import { Todo } from "../todos/types";
import { DEFAULT_DEVICE_SETTINGS, DeviceSettings } from "../settings/types";

const DEVICE_ID_KEY = "houseSimulatorDeviceId";
const SERVER_URL_KEY = "houseSimulatorServerUrl";
const LAN_SECRET_KEY = "houseSimulatorLanSecret";

/** One id per browser/device, generated once and kept in localStorage — same trick viewer-main.ts already uses for its own settings key, just storing an id instead of values now (settings themselves live server-side, keyed by this). */
function getOrCreateDeviceId(): string {
  let id = localStorage.getItem(DEVICE_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(DEVICE_ID_KEY, id);
  }
  return id;
}

function getOrPromptServerUrl(): string {
  let url = localStorage.getItem(SERVER_URL_KEY);
  if (!url) {
    url = window.prompt("House Simulator server address (e.g. ws://192.168.0.50:4000)")?.trim() || "";
    if (url) localStorage.setItem(SERVER_URL_KEY, url);
  }
  return url;
}

function getOrPromptLanSecret(): string {
  let secret = localStorage.getItem(LAN_SECRET_KEY);
  if (secret === null) {
    secret = window.prompt("House Simulator server secret")?.trim() ?? "";
    localStorage.setItem(LAN_SECRET_KEY, secret);
  }
  return secret;
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

const goalsStore = createRemoteStore<Goal[]>([]);
const todosStore = createRemoteStore<Todo[]>([]);
const statusStore = createRemoteStore<RemoteStatus>({ activityLabel: null, startedAt: null });
const settingsStore = createRemoteStore<DeviceSettings>(DEFAULT_DEVICE_SETTINGS);

export const getGoals = goalsStore.get;
export const onGoalsChange = goalsStore.onChange;
export const getTodos = todosStore.get;
export const onTodosChange = todosStore.onChange;
export const getRemoteStatus = statusStore.get;
export const onRemoteStatusChange = statusStore.onChange;
export const getDeviceSettings = settingsStore.get;
export const onDeviceSettingsChange = settingsStore.onChange;

const storesByKey: Record<string, { _set(data: unknown): void }> = {
  goals: goalsStore,
  todos: todosStore,
  status: statusStore,
  settings: settingsStore,
};

let socket: WebSocket | null = null;
let requestCounter = 0;
const pendingQueries = new Map<string, { resolve(value: unknown): void; reject(err: Error): void }>();

/**
 * Opens the one WebSocket connection everything else in this module
 * depends on — resolves once connected, so callers (main.ts, eventually)
 * can await this before building UI that expects goals/todos/status to
 * already be populated. See server/rpc.ts for the protocol this speaks.
 */
export function connectRemoteState(): Promise<void> {
  return new Promise((resolve, reject) => {
    const serverUrl = getOrPromptServerUrl();
    if (!serverUrl) {
      reject(new Error("no server address provided"));
      return;
    }
    const deviceId = getOrCreateDeviceId();
    const secret = getOrPromptLanSecret();
    const url = `${serverUrl}?deviceId=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(secret)}`;

    const ws = new WebSocket(url);
    socket = ws;

    // `open` only means the socket connected, not that the server's initial
    // goals/todos/status/settings pushes (sent right after connection) have
    // arrived yet — resolving on `open` alone risks main.ts building UI off
    // each store's empty initial value. Wait for all four instead.
    const pendingInitialKeys = new Set(Object.keys(storesByKey));

    ws.addEventListener("error", () => reject(new Error("WebSocket connection failed")));
    ws.addEventListener("close", (event) => {
      console.error(`[remoteState] WebSocket closed (code ${event.code})`);
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
