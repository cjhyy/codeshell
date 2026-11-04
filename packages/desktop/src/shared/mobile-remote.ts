import type { DesktopRelayApi } from "./device-relay.js";

export interface ApprovalResolvedEnvelope {
  /** Owning engine session when known. */
  sessionId?: string;
  connectionId?: string;
  generation?: number;
  requestId: string;
  status?: "resolved" | "expired" | "cancelled" | "owner-lost";
  approved?: boolean;
  /** Actual question answer, including answers submitted from another client. */
  answer?: string;
}

export type MobilePermissionMode = "default" | "acceptEdits" | "bypassPermissions";

/**
 * Session settings a phone changed and the Host accepted. Desktop adopts each
 * present field as that Session's own override, so both clients keep driving
 * the same composer configuration.
 */
export interface MobileSessionSettingsEnvelope {
  sessionId: string;
  permissionMode?: MobilePermissionMode;
  /** Desktop model option key: a native connection id or an external runtime key. */
  modelKey?: string;
}

export interface MobilePermissionModeSnapshotEntry {
  sessionId: string;
  mode: MobilePermissionMode;
}

/** ccRoom:openSession result: the mode Main actually started the CLI with. */
export interface CcRoomOpenResult {
  roomId: string;
  status: "running" | "missing" | "observing";
  permissionMode?: MobilePermissionMode;
}

export interface MobileRemoteApi {
  relay: DesktopRelayApi;
  start(opts?: { mode?: "lan" | "tunnel" | "relay" }): Promise<{
    url: string;
    pairingUrl: string;
    expiresAt: number;
    mode: "lan" | "tunnel" | "relay";
  }>;
  stop(): Promise<void>;
  pairingUrl(): Promise<{ pairingUrl: string; expiresAt: number }>;
  status(): Promise<{
    running: boolean;
    url?: string;
    mode?: "lan" | "tunnel" | "relay";
    tunnelRunning?: boolean;
    tunnelConnected?: boolean;
  }>;
  listDevices(): Promise<
    Array<{
      id: string;
      name: string;
      createdAt: number;
      lastSeenAt?: number;
      revokedAt?: number;
    }>
  >;
  revokeDevice(id: string): Promise<boolean>;
  removeDevice(id: string): Promise<boolean>;
  renameDevice(id: string, name: string): Promise<boolean>;
  onlineDevices(): Promise<string[]>;
  onOnlineChange(cb: (ids: string[]) => void): () => void;
  // ── Public tunnel mode ──
  cloudflaredInstalled(): Promise<boolean>;
  downloadCloudflared(): Promise<boolean>;
  onDownloadProgress(cb: (pct: number) => void): () => void;
  passcodeStatus(): Promise<{ isSet: boolean }>;
  setPasscode(passcode: string): Promise<boolean>;
  tunnelStatus(): Promise<{ running: boolean; connected: boolean }>;
  onTunnelStatus(cb: (s: { status: string; detail?: unknown }) => void): () => void;
  updatePermissionModes(entries: MobilePermissionModeSnapshotEntry[]): Promise<boolean>;
  notifyApprovalResolved(input: ApprovalResolvedEnvelope): Promise<boolean>;
}
