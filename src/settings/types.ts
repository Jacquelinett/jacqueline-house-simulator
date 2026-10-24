export type Theme = "dark" | "pink";

/**
 * One of the fixed look points the day/night ambient tint can snap to —
 * see scene/renderer.ts's AMBIENT_MANUAL_LOOKS for what each actually
 * renders as. Lives here (not in renderer.ts, which pulls in Pixi/DOM
 * types the server-side deviceSettings.ts can't have — server/tsconfig.json
 * deliberately has no "DOM" lib) so it's safe for both sides to reference;
 * renderer.ts imports this type, not the other way around.
 */
export type AmbientManualStop = "night" | "dawn" | "day" | "dusk";

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
  // Day/night ambient tint testing controls (see "Day/night ambient tint"
  // in scene/renderer.ts). ambientUseRealTime defaults to true — the
  // ordinary behavior, driven by the real clock. Flipping it off freezes
  // the tint on whichever ambientManualStop is picked, regardless of the
  // actual time, so the look of each stop can be previewed on demand
  // instead of waiting for the real day/night cycle to reach it.
  ambientUseRealTime: boolean;
  ambientManualStop: AmbientManualStop;
}

export const DEFAULT_DEVICE_SETTINGS: DeviceSettings = {
  devMode: false,
  scale: 2,
  theme: "pink",
  ambientUseRealTime: true,
  ambientManualStop: "day",
};
