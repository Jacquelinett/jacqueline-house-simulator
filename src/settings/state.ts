import { DeviceSettings } from "./types";
import { getDeviceSettings, onDeviceSettingsChange, sendCommand } from "../client/remoteState";

/**
 * Thin wrapper, same exported names as before — but getSettings() now
 * returns DeviceSettings (scale/theme/devMode only), not the old Settings
 * type. broadcastUrl/broadcastSecret aren't client-side settings anymore
 * at all; see server/serverConfig.ts.
 */
export const getSettings = getDeviceSettings;
export const onSettingsChange = onDeviceSettingsChange;

export async function updateSettings(patch: Partial<DeviceSettings>): Promise<void> {
  sendCommand("updateSettings", patch);
}
