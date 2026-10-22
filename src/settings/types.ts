export type Theme = "dark" | "pink";

export interface Settings {
  broadcastUrl: string;
  broadcastSecret: string;
  /** Red outlines on every object's hit box and each room's boundary, to help line up placeholder art by eye. */
  devMode: boolean;
  /** Scales the whole Pixi scene (art + hit boxes). */
  scale: number;
  theme: Theme;
}

export const DEFAULT_SETTINGS: Settings = {
  broadcastUrl: "",
  broadcastSecret: "",
  devMode: false,
  scale: 2,
  theme: "pink",
};

/**
 * Per-device display preferences, stored server-side (device_settings
 * table) once the frontend is rewired to talk to the Node server — a
 * phone and a Mac can reasonably want different zoom levels, so this is
 * keyed by a per-device id rather than being one shared blob like Settings
 * above. broadcastUrl/broadcastSecret aren't here: the server does the
 * val.town pushing now, not individual devices (see server/serverConfig.ts).
 */
export interface DeviceSettings {
  devMode: boolean;
  scale: number;
  theme: Theme;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  devMode: false,
  scale: 2,
  theme: "pink",
};
