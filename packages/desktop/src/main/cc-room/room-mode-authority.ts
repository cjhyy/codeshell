import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type {
  LinkedSessionTarget,
  RoomKind,
  RoomManager,
  RoomMeta,
  RoomPermissionMode,
  RoomSessionOpenPlan,
  RoomSessionOpenResult,
} from "@cjhyy/code-shell-server/mobile-remote";
import type { ApprovalBridge } from "./approval-bridge.js";

/** Tool name of the Host-generated card. CLI tool approvals never use it. */
export const ROOM_MODE_APPROVAL_TOOL = "CodeShellRoomPermissionMode";
export const ROOM_MODE_APPROVAL_PURPOSE = "room-permission-mode" as const;
const DEFAULT_APPROVAL_TIMEOUT_MS = 2 * 60_000;

/** Everything a single bypass approval is bound to. Minted by Main only. */
export interface RoomModeApproval {
  /** Host-minted, unguessable; never derived from client input. */
  requestId: string;
  roomId: string;
  sessionId: string;
  kind: RoomKind;
  cwd: string;
  fromMode?: RoomPermissionMode;
  toMode: "bypassPermissions";
  requesterKey: string;
  revision: number;
  /** Client correlation id of the open request, echoed so the requesting view
   * can show the card before the room exists. Never an authorization input. */
  openRequestId?: string;
}

export interface RoomModeRequester {
  /** Stable identity of the requesting view: `mobile:<viewer>` / `desktop:<webContents>`. */
  key: string;
  channel: "mobile" | "desktop";
  /** Throws once the requester is gone (socket closed, device revoked, window destroyed). */
  assertCurrent: () => void;
  openRequestId?: string;
  /** Desktop requester's window, which hosts its native approval dialog. */
  ownerWebContentsId?: number;
}

export interface RoomModeAuthorityDeps {
  roomManager: Pick<RoomManager, "planSessionOpen" | "applySessionOpen" | "settleSessionRoom">;
  /** Main-owned project authorization; returns the canonical directory. */
  requireProjectPath: (cwd: string) => Promise<string>;
  /**
   * The CLI's own on-disk identity for (session id, kind, cwd), or null when no
   * such transcript exists. Client-supplied tuples are never trusted directly:
   * the approval and the started process must name this exact session.
   */
  resolveSession: (target: Readonly<LinkedSessionTarget>) => LinkedSessionTarget | null | undefined;
  /**
   * Host-managed Claude Code allowlist (user settings only). Project files
   * are deliberately not consulted: a repository cannot grant itself bypass.
   */
  trustedClaudeWorkspaces: () => Promise<readonly unknown[]>;
  /** Deliver the one-time high-risk card and resolve with the user's decision. */
  requestApproval: (
    approval: RoomModeApproval,
    requester: RoomModeRequester,
    signal: AbortSignal,
  ) => Promise<{ approved: boolean; reason?: string }>;
  approvalTimeoutMs?: number;
}

export interface RoomModeOpenResult extends RoomSessionOpenResult {
  requestedMode: RoomPermissionMode;
  /** True when this open required and received a Host bypass approval. */
  approved: boolean;
}

export class RoomModeAuthorizationError extends Error {
  constructor(
    message: string,
    readonly code: "denied" | "timeout" | "cancelled" | "requester-gone" | "not-authorized",
  ) {
    super(message);
    this.name = "RoomModeAuthorizationError";
  }
}

interface RoomGrant {
  readonly cwd: string;
  readonly kind: RoomKind;
  /** External session the grant was approved for; absent only for a trusted
   * room.create, whose CLI session id does not exist yet. */
  readonly sessionId?: string;
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function grantCovers(
  grant: RoomGrant,
  target: { cwd: string; kind: RoomKind; sessionId?: string },
): boolean {
  return (
    grant.kind === target.kind &&
    grant.cwd === target.cwd &&
    (grant.sessionId === undefined || grant.sessionId === target.sessionId)
  );
}

const CLI_LABEL: Record<RoomKind, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** User-facing consequence of bypass for each CLI. */
export function bypassConsequence(kind: RoomKind): string {
  return kind === "codex"
    ? "Codex 将以 --dangerously-bypass-approvals-and-sandbox 运行：关闭沙箱，所有命令和写入不经确认直接执行。"
    : "Claude Code 将以 bypassPermissions 运行：所有工具调用不再请求确认。";
}

/** When a new mode applies. Codex has no resident process to restart. */
export function modeTakesEffect(kind: RoomKind): string {
  return kind === "codex"
    ? "新模式从下一条消息启动的 Codex 进程开始生效。"
    : "批准后 Claude Code 进程会重启，新模式在重启后生效。";
}

/**
 * Host decision for an external CLI room's spawn-time permission mode.
 *
 * - default / acceptEdits are applied as chosen.
 * - bypassPermissions is applied when the cwd is on the Host-managed Claude
 *   Code allowlist (Codex has none), or after a one-time high-risk approval
 *   minted here and bound to the exact room, session, cwd, kind, old/new mode,
 *   requester and room revision. A denial, timeout, cancellation or delivery
 *   failure leaves the room untouched and is reported, never downgraded.
 * - A stored bypass mode is not a credential: starting a process in bypass
 *   needs a live in-memory grant (see authorizeStart).
 */
export class RoomModeAuthority {
  /**
   * Live bypass grants. Each grant is a distinct object owned by the operation
   * that minted it: updates and rollbacks compare object identity (CAS), so an
   * operation can never resurrect a grant that was revoked or replaced, nor
   * remove a grant another operation installed.
   */
  private readonly grants = new Map<string, RoomGrant>();
  private readonly pending = new Map<string, { controller: AbortController; requestId: string }>();
  /** Latest open request per requester; an older one cannot apply. */
  private readonly latest = new Map<string, symbol>();

  constructor(private readonly deps: RoomModeAuthorityDeps) {}

  async isTrusted(kind: RoomKind, cwd: string): Promise<boolean> {
    if (kind !== "claude-code") return false;
    const target = canonical(cwd);
    const entries = await this.deps.trustedClaudeWorkspaces();
    return entries.some(
      (entry) => typeof entry === "string" && entry.trim() !== "" && canonical(entry) === target,
    );
  }

  hasGrant(roomId: string, cwd: string, kind: RoomKind, sessionId?: string): boolean {
    const grant = this.grants.get(roomId);
    return !!grant && grantCovers(grant, { cwd: canonical(cwd), kind, sessionId });
  }

  /** RoomManager start hook. Throws for a bypass start without a live grant. */
  authorizeStart(meta: Readonly<RoomMeta>): void {
    if (meta.permissionMode !== "bypassPermissions") return;
    if (this.hasGrant(meta.id, meta.cwd, meta.kind, meta.claudeSessionId)) return;
    throw new RoomModeAuthorizationError(
      "该 CLI 会话保存的模式是全放行，但本次启动没有 Host 授权。请从 CLI 会话列表重新打开并批准，或选择其他权限模式。",
      "not-authorized",
    );
  }

  /** Explicit close ends the room's grant; a later bypass start asks again. */
  revoke(roomId: string): void {
    this.grants.delete(roomId);
  }

  /** Cancel a requester's pending approval (disconnect / navigation / newer request). */
  cancelRequester(key: string, reason = "发起请求的视图已离开，权限模式未更改。"): void {
    this.latest.delete(key);
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    pending.controller.abort(new RoomModeAuthorizationError(reason, "cancelled"));
  }

  /**
   * Mode for room.create. A bypass that would need approval is refused with a
   * reason instead of silently becoming default; open the CLI session instead.
   */
  async resolveCreateMode(
    kind: RoomKind,
    cwd: string,
    explicit: RoomPermissionMode | undefined,
  ): Promise<{ mode: RoomPermissionMode; trustedBypass: boolean }> {
    const trusted = await this.isTrusted(kind, cwd);
    if (explicit === "bypassPermissions" && !trusted)
      throw new RoomModeAuthorizationError(
        "此目录不在 Host 的 Claude Code 可信目录中，新建房间不能直接使用全放行。请从 CLI 会话列表打开会话，并在 Host 审批卡中批准。",
        "not-authorized",
      );
    const mode = explicit ?? (trusted ? "bypassPermissions" : "default");
    return { mode, trustedBypass: mode === "bypassPermissions" };
  }

  /** Record the grant for a room created in a trusted bypass workspace. */
  grantTrusted(roomId: string, cwd: string, kind: RoomKind): void {
    this.grants.set(roomId, { cwd: canonical(cwd), kind });
  }

  /**
   * Prove the client's (session, kind, cwd) tuple against the CLI's own
   * on-disk identity before any plan or card exists. `cwd` is the authorized
   * canonical directory; the transcript must name exactly that directory.
   */
  private requireSessionIdentity(
    input: { sessionId: string; cwd: string; kind: RoomKind },
    cwd: string,
  ): void {
    let resolved: LinkedSessionTarget | null | undefined;
    try {
      resolved = this.deps.resolveSession({
        externalSessionId: input.sessionId,
        cwd: input.cwd,
        kind: input.kind,
      });
    } catch {
      resolved = null;
    }
    if (
      !resolved ||
      typeof resolved.externalSessionId !== "string" ||
      typeof resolved.cwd !== "string" ||
      resolved.externalSessionId !== input.sessionId ||
      resolved.kind !== input.kind ||
      canonical(resolved.cwd) !== cwd
    )
      throw new RoomModeAuthorizationError(
        "找不到与该会话 ID、CLI 类型和目录一致的 CLI 会话记录，未打开会话，权限模式未更改。",
        "not-authorized",
      );
  }

  /** Open (or switch) the room bound to an external CLI session under `mode`. */
  async openSession(input: {
    sessionId: string;
    cwd: string;
    kind: RoomKind;
    mode: RoomPermissionMode;
    requester: RoomModeRequester;
  }): Promise<RoomModeOpenResult> {
    const { requester } = input;
    // A newer request from the same view supersedes any card still waiting.
    this.cancelRequester(requester.key, "已被同一视图的新请求取代。");
    const token = Symbol(requester.key);
    this.latest.set(requester.key, token);
    const assertRequester = (): void => {
      if (this.latest.get(requester.key) !== token)
        throw new RoomModeAuthorizationError(
          "发起请求的视图已离开或发起了新的请求，权限模式未更改。",
          "cancelled",
        );
      try {
        requester.assertCurrent();
      } catch {
        throw new RoomModeAuthorizationError(
          "发起请求的连接已断开，权限模式未更改。",
          "requester-gone",
        );
      }
    };
    try {
      const cwd = await this.deps.requireProjectPath(input.cwd);
      assertRequester();
      // The approval must name the CLI's real session, not the client's tuple.
      this.requireSessionIdentity(input, cwd);
      // A retired process proven gone no longer blocks the plan below; one
      // still alive refuses it before any card is shown.
      await this.deps.roomManager.settleSessionRoom(input.sessionId, input.kind);
      assertRequester();
      const plan = this.deps.roomManager.planSessionOpen({
        sessionId: input.sessionId,
        cwd,
        kind: input.kind,
        mode: input.mode,
      });
      const bypass = !plan.observing && plan.toMode === "bypassPermissions";
      // The grant table as this decision saw it; every later write is a CAS
      // against exactly this object.
      const previousGrant = this.grants.get(plan.roomId);
      const target = { cwd: plan.cwd, kind: plan.kind, sessionId: plan.sessionId };
      /** The grant this operation's bypass start relies on. */
      let grant: RoomGrant | undefined;
      let minted = false;
      let approved = false;
      if (bypass) {
        if (previousGrant && grantCovers(previousGrant, target)) {
          grant = previousGrant;
        } else {
          if (!(await this.isTrusted(plan.kind, plan.cwd))) {
            await this.approve(plan, requester);
            approved = true;
          }
          grant = { ...target };
          minted = true;
        }
      }
      // Re-validate every fact the decision used after the asynchronous gap.
      if ((await this.deps.requireProjectPath(input.cwd)) !== cwd)
        throw new RoomModeAuthorizationError("项目目录授权已变化，权限模式未更改。", "cancelled");
      this.requireSessionIdentity(input, cwd);
      assertRequester();
      if (bypass) {
        // A grant revoked or replaced meanwhile (close, another view's
        // downgrade or approval) is never reinstated by this stale decision.
        if (this.grants.get(plan.roomId) !== previousGrant)
          throw new RoomModeAuthorizationError("全放行授权已变化，权限模式未更改。", "cancelled");
        if (minted) this.grants.set(plan.roomId, grant!);
      }
      try {
        const result = await this.deps.roomManager.applySessionOpen(plan, {
          // Runs before anything changes and again right before the
          // replacement process is created: a requester that left, or a
          // superseded request, never gets a late bypass start. The room then
          // stays really stopped and every view is told so by the manager.
          authorize: () => {
            assertRequester();
            // The CLI's session record may be removed or rewritten while the
            // old process exits; the replacement must still be that session.
            this.requireSessionIdentity(input, cwd);
            if (bypass && this.grants.get(plan.roomId) !== grant)
              throw new RoomModeAuthorizationError("全放行授权已被撤销。", "cancelled");
          },
          // Project authorization is asynchronous, so it is re-checked after
          // each wait for the old process, inside the manager's handoff.
          revalidate: async () => {
            if ((await this.deps.requireProjectPath(input.cwd)) !== cwd)
              throw new RoomModeAuthorizationError(
                "项目目录授权已变化，权限模式未更改。",
                "cancelled",
              );
          },
        });
        // A room that no longer runs bypass loses the grant this decision saw;
        // a grant installed by another operation since is not ours to remove.
        if (result.mode !== "bypassPermissions" && this.grants.get(plan.roomId) === previousGrant)
          this.grants.delete(plan.roomId);
        return { ...result, requestedMode: input.mode, approved };
      } catch (error) {
        // Roll back only this operation's own grant, and only if it is still
        // the installed one.
        if (minted && this.grants.get(plan.roomId) === grant) {
          if (previousGrant) this.grants.set(plan.roomId, previousGrant);
          else this.grants.delete(plan.roomId);
        }
        throw error;
      }
    } finally {
      if (this.latest.get(requester.key) === token) this.latest.delete(requester.key);
    }
  }

  private async approve(plan: RoomSessionOpenPlan, requester: RoomModeRequester): Promise<void> {
    const approval: RoomModeApproval = {
      requestId: `room-mode-${randomUUID()}`,
      roomId: plan.roomId,
      sessionId: plan.sessionId,
      kind: plan.kind,
      cwd: plan.cwd,
      ...(plan.fromMode ? { fromMode: plan.fromMode } : {}),
      toMode: "bypassPermissions",
      requesterKey: requester.key,
      revision: plan.revision,
      ...(requester.openRequestId ? { openRequestId: requester.openRequestId } : {}),
    };
    const controller = new AbortController();
    this.pending.set(requester.key, { controller, requestId: approval.requestId });
    const timeout = setTimeout(
      () =>
        controller.abort(
          new RoomModeAuthorizationError("全放行审批已超时，权限模式未更改。", "timeout"),
        ),
      this.deps.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS,
    );
    timeout.unref?.();
    try {
      const aborted = new Promise<never>((_, reject) => {
        const fail = (): void =>
          reject(
            controller.signal.reason instanceof Error
              ? controller.signal.reason
              : new RoomModeAuthorizationError("全放行审批已取消，权限模式未更改。", "cancelled"),
          );
        if (controller.signal.aborted) fail();
        else controller.signal.addEventListener("abort", fail, { once: true });
      });
      // The final abort below settles this after the race; never unhandled.
      aborted.catch(() => undefined);
      let decision: { approved: boolean; reason?: string };
      try {
        decision = await Promise.race([
          // A synchronous delivery failure is reported like an asynchronous one.
          Promise.resolve().then(() =>
            this.deps.requestApproval(approval, requester, controller.signal),
          ),
          aborted,
        ]);
      } catch (error) {
        if (error instanceof RoomModeAuthorizationError) throw error;
        throw new RoomModeAuthorizationError(
          `全放行审批无法送达，权限模式未更改：${error instanceof Error ? error.message : String(error)}`,
          "denied",
        );
      }
      if (controller.signal.aborted) {
        const reason = controller.signal.reason;
        throw reason instanceof Error
          ? reason
          : new RoomModeAuthorizationError("全放行审批已取消，权限模式未更改。", "cancelled");
      }
      if (!decision.approved)
        throw new RoomModeAuthorizationError(
          `全放行未获批准，权限模式未更改${decision.reason ? `（${decision.reason}）` : ""}。`,
          "denied",
        );
    } finally {
      clearTimeout(timeout);
      if (this.pending.get(requester.key)?.controller === controller)
        this.pending.delete(requester.key);
      // Settle the delivered card for every transport if it is still open.
      if (!controller.signal.aborted)
        controller.abort(new RoomModeAuthorizationError("审批已结束。", "cancelled"));
    }
  }
}

/** Card payload shared by the phone and Desktop room approval transports. */
export function roomModeApprovalPayload(approval: RoomModeApproval) {
  const label = CLI_LABEL[approval.kind];
  return {
    toolName: ROOM_MODE_APPROVAL_TOOL,
    displayName: `${label} 切换为全放行（高风险）`,
    description: `${bypassConsequence(approval.kind)} ${modeTakesEffect(approval.kind)}`,
    input: {
      cwd: approval.cwd,
      sessionId: approval.sessionId,
      kind: approval.kind,
      fromMode: approval.fromMode ?? null,
      toMode: approval.toMode,
    },
    purpose: ROOM_MODE_APPROVAL_PURPOSE,
    modeChange: {
      sessionId: approval.sessionId,
      kind: approval.kind,
      cwd: approval.cwd,
      ...(approval.fromMode ? { fromMode: approval.fromMode } : {}),
      toMode: approval.toMode,
      ...(approval.openRequestId ? { openRequestId: approval.openRequestId } : {}),
    },
  };
}

/**
 * Deliver a bypass approval as the room approval card every paired phone sees.
 * Cancellation or timeout retires the card on every transport.
 */
export function requestRoomModeCard(
  approvalBridge: Pick<ApprovalBridge, "request" | "respond">,
  approval: RoomModeApproval,
  signal: AbortSignal,
): Promise<{ approved: boolean; reason?: string }> {
  const decision = approvalBridge.request(
    approval.roomId,
    approval.requestId,
    roomModeApprovalPayload(approval),
  );
  const retire = (): void => {
    approvalBridge.respond(approval.roomId, approval.requestId, {
      behavior: "deny",
      message: "权限模式审批已结束",
    });
  };
  if (signal.aborted) retire();
  else signal.addEventListener("abort", retire, { once: true });
  return decision.then((settled) =>
    settled.behavior === "allow"
      ? { approved: true }
      : { approved: false, reason: settled.message },
  );
}

/** Read only the user-scope allowlist (never project settings). */
export function trustedClaudeWorkspacesFromUserSettings(settings: unknown): readonly unknown[] {
  type UserSettings = { externalAgents?: { claudeCode?: { trustedWorkspaces?: unknown } } };
  const list = (settings as UserSettings | null | undefined)?.externalAgents?.claudeCode
    ?.trustedWorkspaces;
  return Array.isArray(list) ? list : [];
}

export { canonical as canonicalRoomDirectory };

/** Requester identity of one paired browser tab (socket viewer). */
export function mobileRoomModeRequesterKey(viewerId: string): string {
  return `mobile:${viewerId}`;
}
