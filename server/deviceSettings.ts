import { db } from "./db";
import { DEFAULT_DEVICE_SETTINGS, DeviceSettings } from "../src/settings/types";

interface DeviceSettingsRow {
  device_id: string;
  scale: number;
  theme: string;
  dev_mode: number;
}

export function getDeviceSettings(deviceId: string): DeviceSettings {
  const row = db.prepare("SELECT * FROM device_settings WHERE device_id = ?").get(deviceId) as
    | DeviceSettingsRow
    | undefined;
  if (!row) return DEFAULT_DEVICE_SETTINGS;
  return { scale: row.scale, theme: row.theme as DeviceSettings["theme"], devMode: !!row.dev_mode };
}

export function updateDeviceSettings(deviceId: string, patch: Partial<DeviceSettings>): DeviceSettings {
  const next = { ...getDeviceSettings(deviceId), ...patch };
  db.prepare(`
    INSERT INTO device_settings (device_id, scale, theme, dev_mode)
    VALUES (@deviceId, @scale, @theme, @devMode)
    ON CONFLICT(device_id) DO UPDATE SET scale = excluded.scale, theme = excluded.theme, dev_mode = excluded.dev_mode
  `).run({ deviceId, scale: next.scale, theme: next.theme, devMode: next.devMode ? 1 : 0 });
  return next;
}
