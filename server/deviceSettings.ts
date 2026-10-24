import { db } from "./db";
import { AmbientManualStop, DEFAULT_DEVICE_SETTINGS, DeviceSettings } from "../src/settings/types";

interface DeviceSettingsRow {
  device_id: string;
  scale: number;
  theme: string;
  dev_mode: number;
  ambient_use_real_time: number;
  ambient_manual_stop: string;
}

export function getDeviceSettings(deviceId: string): DeviceSettings {
  const row = db.prepare("SELECT * FROM device_settings WHERE device_id = ?").get(deviceId) as
    | DeviceSettingsRow
    | undefined;
  if (!row) return DEFAULT_DEVICE_SETTINGS;
  return {
    scale: row.scale,
    theme: row.theme as DeviceSettings["theme"],
    devMode: !!row.dev_mode,
    ambientUseRealTime: !!row.ambient_use_real_time,
    ambientManualStop: row.ambient_manual_stop as AmbientManualStop,
  };
}

export function updateDeviceSettings(deviceId: string, patch: Partial<DeviceSettings>): DeviceSettings {
  const next = { ...getDeviceSettings(deviceId), ...patch };
  db.prepare(`
    INSERT INTO device_settings (device_id, scale, theme, dev_mode, ambient_use_real_time, ambient_manual_stop)
    VALUES (@deviceId, @scale, @theme, @devMode, @ambientUseRealTime, @ambientManualStop)
    ON CONFLICT(device_id) DO UPDATE SET scale = excluded.scale, theme = excluded.theme, dev_mode = excluded.dev_mode,
      ambient_use_real_time = excluded.ambient_use_real_time, ambient_manual_stop = excluded.ambient_manual_stop
  `).run({
    deviceId,
    scale: next.scale,
    theme: next.theme,
    devMode: next.devMode ? 1 : 0,
    ambientUseRealTime: next.ambientUseRealTime ? 1 : 0,
    ambientManualStop: next.ambientManualStop,
  });
  return next;
}
