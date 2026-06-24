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

/** Where a remembered permission grant applies (mirrors desktop approve). */
export type ApprovalScope = "once" | "session" | "project";
/** Path breadth for a remembered grant (path-scoped tools only). */
export type ApprovalPathScope = "file" | "dir" | "tool";
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions";

export interface MobileProjectMeta {
  path: string;
  name: string;
  addedAt?: number;
  pinned?: boolean;
}

export type MobileClientEvent =
  | { type: "auth.device"; deviceId: string; secretHash: string }
  | { type: "pair.complete"; token: string; name: string; secretHash: string }
  | { type: "chat.send"; text: string; sessionId?: string }
  | { type: "session.select"; sessionId: string }
  | { type: "session.create"; cwd?: string | null; name?: string }
  | { type: "run.stop"; sessionId?: string }
  // Approval — full desktop parity: deny reason, AskUser answer, remembered
  // scope (once/session/project) + path scope (file/dir/tool).
  | {
      type: "approval.respond";
      approvalId: string;
      decision: "approve" | "reject";
      sessionId?: string;
      reason?: string;
      answer?: string;
      scope?: ApprovalScope;
      pathScope?: ApprovalPathScope;
    }
  // ── Sessions: see every desktop session, open its history, drive it ──────
  | { type: "session.list" }
  | { type: "session.history"; sessionId: string }
  // ── Capability controls ──────────────────────────────────────────────────
  | { type: "permission.setMode"; sessionId?: string; mode: PermissionMode }
  | { type: "model.set"; model: string }
  | {
      type: "goal.extend";
      sessionId: string;
      addTurns?: number;
      addTokenBudget?: number;
      addTimeBudgetMs?: number;
      addStopBlocks?: number;
    }
  | { type: "goal.clear"; sessionId: string }
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
  // ── Sessions ──────────────────────────────────────────────────────────
  | { type: "session.list.ok"; sessions: MobileSessionMeta[]; activeSessionId?: string }
  | { type: "session.history.ok"; sessionId: string; events: unknown[] }
  // ── Capability controls ──────────────────────────────────────────────────
  | { type: "permission.mode"; sessionId?: string; mode: PermissionMode }
  | { type: "model.current"; model: string; available?: string[] }
  | { type: "goal.extended"; sessionId: string; ok: boolean; message?: string }
  | { type: "goal.cleared"; sessionId: string; ok: boolean; cleared?: boolean; message?: string }
  // ── Rooms ─────────────────────────────────────────────────────────────
  | { type: "room.list.ok"; rooms: RoomPublic[] }
  | { type: "room.projects.ok"; projects: MobileProjectMeta[] }
  | { type: "room.opened"; roomId: string; status: "running" | "missing" }
  | { type: "room.message"; roomId: string; msg: unknown }
  | { type: "room.history.ok"; roomId: string; messages: unknown[]; latestSeq: number }
  | { type: "room.closed"; roomId: string }
  | { type: "room.error"; roomId?: string; message: string }
  | {
      type: "ccRoom.approvalRequest";
      roomId: string;
      req: {
        requestId: string;
        toolName: string;
        displayName?: string;
        input: unknown;
        description?: string;
      };
    };

export interface RoomPublic {
  id: string;
  name: string;
  cwd: string;
  permissionMode: "default" | "acceptEdits" | "bypassPermissions";
  createdAt: number;
  lastActiveAt: number;
  open: boolean;
}

/** A desktop session the phone can see + drive (from listDiskSessions). */
export interface MobileSessionMeta {
  id: string;
  title: string;
  cwd: string;
  updatedAt: number;
  origin: "desktop" | "automation";
}
