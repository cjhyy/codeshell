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

/** Mirror of core DiscoveredSession (mobile-remote can't import core). */
export interface CcDiscoveredSession {
  sessionId: string;
  firstMessage: string;
  lastModified: number;
  messageCount: number;
}

/** Mirror of core HistoryMessage. */
export interface CcHistoryMessage {
  role: "user" | "assistant";
  text: string;
  tools?: { name: string; summary: string }[];
  ts?: number;
}

/** Mirror of cc-room ApprovalDecision. `answer` carries the user's
 *  AskUserQuestion choice (string; multiSelect joins labels with ", "). */
export type CcApprovalDecision =
  | { behavior: "allow"; updatedInput?: unknown; answer?: string }
  | { behavior: "deny"; message: string };

export interface MobilePermissionModeSnapshotEntry {
  sessionId: string;
  mode: PermissionMode;
}

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
      kind?: "claude-code" | "codex";
      permissionMode?: "default" | "acceptEdits" | "bypassPermissions";
    }
  | { type: "room.open"; roomId: string }
  | { type: "room.close"; roomId: string }
  | { type: "room.send"; roomId: string; text: string }
  | { type: "room.history"; roomId: string; sinceSeq?: number }
  // ── CC Room (external claude CLI sessions, per-project) ───────────────
  | { type: "ccRoom.probe"; force?: boolean }
  | { type: "ccRoom.listSessions"; cwd: string }
  | { type: "ccRoom.openSession"; sessionId: string; cwd: string; mode: PermissionMode }
  | { type: "ccRoom.readHistory"; cwd: string; sessionId: string; limit: number }
  | { type: "ccRoom.respondApproval"; roomId: string; requestId: string; decision: CcApprovalDecision };

export type MobileServerEvent =
  | { type: "auth.ok"; device: TrustedDevicePublic }
  | { type: "auth.failed"; message: string }
  | { type: "pair.ok"; device: TrustedDevicePublic }
  | { type: "pair.failed"; message: string }
  | { type: "chat.accepted"; sessionId?: string; cwd?: string | null }
  | {
      type: "approval.request";
      approvalId: string;
      title: string;
      risk: "low" | "medium" | "high";
      body: string;
    }
  | {
      type: "approval.resolved";
      approvalId: string;
      sessionId?: string;
      approved?: boolean;
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
        /** AskUserQuestion only: parsed prompt + option labels for a choice card. */
        askUser?: { question: string; header?: string; options: string[]; multiSelect: boolean };
      };
    }
  | { type: "ccRoom.probe.ok"; available: boolean; command?: string; version?: string; reason?: "not-found" | "not-executable" }
  | { type: "ccRoom.listSessions.ok"; cwd: string; sessions: CcDiscoveredSession[] }
  | { type: "ccRoom.opened"; roomId: string; sessionId: string; status: "running" | "missing" }
  | { type: "ccRoom.readHistory.ok"; sessionId: string; messages: CcHistoryMessage[]; hasMore: boolean; totalCount: number }
  | { type: "ccRoom.approvalResolved"; roomId: string; requestId: string; decision: CcApprovalDecision };

export interface RoomPublic {
  id: string;
  name: string;
  cwd: string;
  kind: "claude-code" | "codex";
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
