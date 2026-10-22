export type Theme = "dark" | "pink";

/**
 * Per-device display preferences, stored server-side (device_settings
 * table), keyed by a per-device id — a phone and a Mac can reasonably want
 * different zoom levels. broadcastUrl/broadcastSecret aren't here: the
 * server does the val.town pushing now, not individual devices (see
 * server/serverConfig.ts).
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
