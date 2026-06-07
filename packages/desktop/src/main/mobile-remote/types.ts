export interface TrustedDevice {
  id: string;
  name: string;
  secretHash: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface TrustedDevicePublic {
  id: string;
  name: string;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
}

export interface PairingToken {
  value: string;
  expiresAt: number;
}

export type MobileClientEvent =
  | { type: "auth.device"; deviceId: string; secretHash: string }
  | { type: "pair.complete"; token: string; name: string; secretHash: string }
  | { type: "chat.send"; text: string; sessionId?: string }
  | { type: "session.select"; sessionId: string }
  | { type: "session.create" }
  | { type: "run.stop"; sessionId?: string }
  | { type: "approval.respond"; approvalId: string; decision: "approve" | "reject"; sessionId?: string }
  | { type: "job.stop"; jobId: string }
  // ── Rooms (resident external-agent sessions) ──────────────────────────
  | { type: "room.list" }
  | { type: "room.projects" }
  | {
      type: "room.create";
      name?: string;
      cwd: string;
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
    }
  | { type: "room.open"; roomId: string }
  | { type: "room.close"; roomId: string }
  | { type: "room.send"; roomId: string; text: string }
  | { type: "room.history"; roomId: string; sinceSeq?: number };

export type MobileServerEvent =
  | { type: "auth.ok"; device: TrustedDevicePublic }
  | { type: "auth.failed"; message: string }
  | { type: "pair.ok"; device: TrustedDevicePublic }
  | { type: "pair.failed"; message: string }
  | { type: "chat.accepted"; sessionId?: string }
  | {
      type: "approval.request";
      approvalId: string;
      title: string;
      risk: "low" | "medium" | "high";
      body: string;
    }
  | { type: "error"; message: string }
  // ── Rooms ─────────────────────────────────────────────────────────────
  | { type: "room.list.ok"; rooms: RoomPublic[] }
  | { type: "room.projects.ok"; projects: { path: string; name: string }[] }
  | { type: "room.opened"; roomId: string; status: "running" | "missing" }
  | { type: "room.message"; roomId: string; msg: unknown }
  | { type: "room.history.ok"; roomId: string; messages: unknown[]; latestSeq: number }
  | { type: "room.closed"; roomId: string }
  | { type: "room.error"; roomId?: string; message: string };

export interface RoomPublic {
  id: string;
  name: string;
  cwd: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  createdAt: number;
  lastActiveAt: number;
  open: boolean;
}
