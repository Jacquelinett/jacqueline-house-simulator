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
function promptForConnectionDetails(): Promise<{ serverUrl: string; lanSecret: string }> {
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
    titleEl.textContent = "Connect to House Simulator server";
    header.appendChild(titleEl);
    dialog.appendChild(header);

    const body = document.createElement("div");
    body.className = "modal-body";
    dialog.appendChild(body);

    const form = document.createElement("form");
    form.id = "connection-setup-form";
    body.appendChild(form);

    const urlLabel = document.createElement("label");
    urlLabel.textContent = "Server address (e.g. ws://192.168.0.50:4000)";
    const urlInput = document.createElement("input");
    urlInput.type = "text";
    urlInput.required = true;
    urlLabel.appendChild(urlInput);
    form.appendChild(urlLabel);

    const secretLabel = document.createElement("label");
    secretLabel.textContent = "Server secret (leave blank if none)";
    const secretInput = document.createElement("input");
    secretInput.type = "text";
    secretLabel.appendChild(secretInput);
    form.appendChild(secretLabel);

    const submitBtn = document.createElement("button");
    submitBtn.type = "submit";
    submitBtn.textContent = "Connect";
    form.appendChild(submitBtn);

    form.onsubmit = (e) => {
      e.preventDefault();
      const serverUrl = urlInput.value.trim();
      if (!serverUrl) return;
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
export async function connectRemoteState(): Promise<void> {
  let serverUrl = localStorage.getItem(SERVER_URL_KEY);
  let lanSecret = localStorage.getItem(LAN_SECRET_KEY);
  if (!serverUrl || lanSecret === null) {
    const entered = await promptForConnectionDetails();
    serverUrl = entered.serverUrl;
    lanSecret = entered.lanSecret;
  }

  return new Promise((resolve, reject) => {
    const deviceId = getOrCreateDeviceId();
    const url = `${serverUrl}?deviceId=${encodeURIComponent(deviceId)}&secret=${encodeURIComponent(lanSecret ?? "")}`;

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
