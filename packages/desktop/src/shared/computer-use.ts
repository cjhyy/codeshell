import type { MimiCompanionSettings } from "./mimi-companion.js";

export type ComputerUsePermissionKind = "accessibility" | "screenRecording";
export type ComputerUsePermissionState = "granted" | "denied" | "unknown" | "unsupported";

export interface ComputerUsePermissionStatus {
  supported: boolean;
  accessibility: ComputerUsePermissionState;
  screenRecording: ComputerUsePermissionState;
  screenRequestAvailable: boolean;
  restartRequired: boolean;
  error?: string;
}

export interface ComputerUseSettingsStatus {
  enabled: boolean;
  active: boolean;
  driverAvailable: boolean;
  packaged: boolean;
  restartRequired: boolean;
  permissions: ComputerUsePermissionStatus;
  companion?: MimiCompanionSettings;
}

export interface ComputerUseSettingsApi {
  status(): Promise<ComputerUseSettingsStatus>;
  setEnabled(enabled: boolean): Promise<ComputerUseSettingsStatus>;
  requestPermission(kind: ComputerUsePermissionKind): Promise<ComputerUseSettingsStatus>;
  openSettings(kind: ComputerUsePermissionKind): Promise<void>;
  restart(): Promise<void>;
  setCompanion(value: { enabled?: boolean; size?: number }): Promise<ComputerUseSettingsStatus>;
  previewCompanion(): Promise<ComputerUseSettingsStatus>;
}
