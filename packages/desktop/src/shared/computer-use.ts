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

/** Execution gate as shown to the user. */
export interface ComputerUseInputStatus {
  /** Every computer input is refused until the user resumes. */
  stopped: boolean;
  /** Foreground input is held while the Mimi chat is open. */
  foregroundHeld: boolean;
  /** The user is using the keyboard or mouse; foreground input waits. */
  userActive: boolean;
}

export interface ComputerUseSettingsStatus {
  enabled: boolean;
  active: boolean;
  driverAvailable: boolean;
  packaged: boolean;
  restartRequired: boolean;
  permissions: ComputerUsePermissionStatus;
  companion?: MimiCompanionSettings;
  input?: ComputerUseInputStatus;
}

export interface ComputerUseSettingsApi {
  status(): Promise<ComputerUseSettingsStatus>;
  setEnabled(enabled: boolean): Promise<ComputerUseSettingsStatus>;
  requestPermission(kind: ComputerUsePermissionKind): Promise<ComputerUseSettingsStatus>;
  openSettings(kind: ComputerUsePermissionKind): Promise<void>;
  restart(): Promise<void>;
  setCompanion(value: { enabled?: boolean; size?: number }): Promise<ComputerUseSettingsStatus>;
  previewCompanion(): Promise<ComputerUseSettingsStatus>;
  /** Stop or resume computer input; `forceStop` also ends the shared driver. */
  controlInput?(action: "stop" | "resume" | "forceStop"): Promise<ComputerUseSettingsStatus>;
  setCompanionChatActive?(active: boolean): Promise<void>;
}
