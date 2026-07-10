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
  tools?: { name: string; summary: string; args?: Record<string, unknown> }[];
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

export type MobileImageMime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface MobileImageBase {
  clientId: string;
  name: string;
  mime: MobileImageMime;
  size: number;
}

export type MobileImageAttachment =
  | (MobileImageBase & { transport: "inline"; dataUrl: string })
  | (MobileImageBase & { transport: "upload"; uploadId: string });

export type MobileAttachmentSummary = MobileImageBase;

export type MobileClientEvent =
  | { type: "auth.device"; deviceId: string; secretHash: string }
  | { type: "pair.complete"; token: string; name: string; secretHash: string }
  | {
      type: "chat.send";
      text: string;
      sessionId?: string;
      clientMessageId?: string;
      attachments?: MobileImageAttachment[];
    }
  | {
      type: "attachment.upload.begin";
      clientId: string;
      name: string;
      mime: string;
      size: number;
    }
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
  | { type: "session.sync"; sessionId: string; sinceSeq?: number }
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
  | {
      type: "room.send";
      roomId: string;
      text: string;
      clientMessageId?: string;
      attachments?: MobileImageAttachment[];
    }
  | { type: "room.history"; roomId: string; sinceSeq?: number }
  // ── CC Room (external claude CLI / codex sessions, per-project) ───────
  //   `kind` selects which CLI to probe/list/open/read (defaults to
  //   "claude-code" when absent, so older phone clients keep working).
  | { type: "ccRoom.probe"; force?: boolean; kind?: "claude-code" | "codex" }
  | { type: "ccRoom.listSessions"; cwd: string; kind?: "claude-code" | "codex" }
  | {
      type: "ccRoom.openSession";
      sessionId: string;
      cwd: string;
      mode: PermissionMode;
      kind?: "claude-code" | "codex";
    }
  | {
      type: "ccRoom.subscribeTranscript";
      roomId: string;
      sessionId: string;
      cwd: string;
      limit: number;
      kind?: "claude-code" | "codex";
    }
  | { type: "ccRoom.unsubscribeTranscript"; roomId: string }
  | {
      type: "ccRoom.readHistory";
      cwd: string;
      sessionId: string;
      limit: number;
      kind?: "claude-code" | "codex";
    }
  | {
      type: "ccRoom.respondApproval";
      roomId: string;
      requestId: string;
      decision: CcApprovalDecision;
    };

export type MobileServerEvent =
  | { type: "auth.ok"; device: TrustedDevicePublic }
  | { type: "auth.failed"; message: string }
  | { type: "pair.ok"; device: TrustedDevicePublic }
  | { type: "pair.failed"; message: string }
  | {
      type: "chat.accepted";
      sessionId?: string;
      cwd?: string | null;
      clientMessageId?: string;
      attachments?: MobileAttachmentSummary[];
    }
  | { type: "room.accepted"; roomId: string; clientMessageId: string }
  | {
      type: "attachment.upload.ready";
      clientId: string;
      uploadId: string;
      putUrl: string;
      expiresAt: number;
    }
  | { type: "attachment.upload.failed"; clientId: string; message: string }
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
  | { type: "error"; message: string; clientMessageId?: string }
  // ── Sessions ──────────────────────────────────────────────────────────
  | { type: "session.list.ok"; sessions: MobileSessionMeta[]; activeSessionId?: string }
  | { type: "session.history.ok"; sessionId: string; events: unknown[] }
  | {
      type: "session.snapshot";
      sessionId: string;
      entries: Array<{ seq: number; event: unknown }>;
      nextSeq: number;
    }
  | { type: "session.stream"; sessionId: string; seq: number; event: unknown }
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
  | { type: "room.error"; roomId?: string; message: string; clientMessageId?: string }
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
  | {
      type: "ccRoom.probe.ok";
      available: boolean;
      command?: string;
      version?: string;
      reason?: "not-found" | "not-executable";
      kind: "claude-code" | "codex";
    }
  | {
      type: "ccRoom.listSessions.ok";
      cwd: string;
      sessions: CcDiscoveredSession[];
      kind: "claude-code" | "codex";
    }
  | { type: "ccRoom.opened"; roomId: string; sessionId: string; status: "running" | "missing" }
  | {
      type: "ccRoom.transcriptSubscribed";
      roomId: string;
      sessionId: string;
      active: boolean;
      messages: CcHistoryMessage[];
      hasMore: boolean;
      totalCount: number;
      roomCursor: number;
    }
  | {
      type: "ccRoom.readHistory.ok";
      sessionId: string;
      messages: CcHistoryMessage[];
      hasMore: boolean;
      totalCount: number;
    }
  | {
      type: "ccRoom.approvalResolved";
      roomId: string;
      requestId: string;
      decision: CcApprovalDecision;
    };

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
