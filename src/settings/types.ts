export interface Settings {
  broadcastUrl: string;
  broadcastSecret: string;
}

export const DEFAULT_SETTINGS: Settings = {
  broadcastUrl: "",
  broadcastSecret: "",
};
