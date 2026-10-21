export interface Settings {
  broadcastUrl: string;
  broadcastSecret: string;
  /** Red outlines on every object's hit box and each room's boundary, to help line up placeholder art by eye. */
  devMode: boolean;
  /** Scales the whole Pixi scene (art + hit boxes). */
  scale: number;
}

export const DEFAULT_SETTINGS: Settings = {
  broadcastUrl: "",
  broadcastSecret: "",
  devMode: false,
  scale: 2,
};
