/**
 * Routing tool approvals for externally-driven sessions to the renderer.
 *
 * On the native path an approval travels worker → preload → renderer, and the
 * renderer answers over `agent/approve` back into the worker. An external
 * runtime has no worker, so without this the `SessionToolHost` gets no
 * `approvalBackend` at all — and an `ask` decision then fails closed with no
 * prompt. That is safe, but it reads to the user as "Codex just can't do
 * anything": the model tries to run a command, is silently refused, and gives
 * up. Safe and unusable is still a defect.
 *
 * The design goal here is that the RENDERER CANNOT TELL THE DIFFERENCE. It
 * receives the same `{ sessionId, requestId, request }` envelope, renders the
 * same dialog, and answers with the same `approve(...)` call. Only the
 * transport underneath differs, so there is exactly one approval UI to keep
 * correct — a second one would drift, and the drift would be silent.
 */
import type { BrowserWindow } from "electron";
import { dlog } from "./desktop-logger.js";

/** Mirrors core's ApprovalRequest closely enough for the wire. */
export interface ExternalApprovalRequest {
  toolName: string;
  riskLevel?: "low" | "medium" | "high";
  [key: string]: unknown;
}

export interface ExternalApprovalDecision {
  approved: boolean;
  reason?: string;
  answer?: string;
  scope?: "once" | "session" | "project";
  pathScope?: "file" | "dir" | "tool";
}

interface Pending {
  sessionId: string;
  resolve: (decision: ExternalApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * How long a prompt waits before failing closed.
 *
 * Long, because the user may genuinely be away — but NOT unbounded: an
 * abandoned prompt otherwise pins the runtime's turn forever, and the tool call
 * behind it holds whatever resources it acquired.
 */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export class ExternalRuntimeApprovals {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  constructor(
    private readonly deps: {
      /** Windows that may display a prompt. */
      windows: () => Iterable<BrowserWindow>;
      /** The window owning a session, when one is known. */
      ownerWebContentsId?: (sessionId: string) => number | undefined;
    },
  ) {}

  /**
   * Ask the renderer. Resolves with the user's decision, or a denial when
   * nothing can answer.
   *
   * Every failure path denies rather than allows. An approval prompt that
   * cannot be shown must never be treated as consent — that inverts the whole
   * point of asking.
   */
  request(sessionId: string, request: ExternalApprovalRequest): Promise<ExternalApprovalDecision> {
    const target = this.resolveTarget(sessionId);
    if (!target) {
      dlog("external-runtime", "approval.no_window", { sessionId, tool: request.toolName });
      return Promise.resolve({
        approved: false,
        reason:
          "This session has no window that can show an approval prompt, so the " +
          "call was refused rather than auto-approved.",
      });
    }

    const requestId = `external-approval-${++this.seq}`;
    return new Promise<ExternalApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(requestId)) return;
        dlog("external-runtime", "approval.timed_out", { sessionId, tool: request.toolName });
        resolve({ approved: false, reason: "approval timed out" });
      }, APPROVAL_TIMEOUT_MS);
      // `unref` so a parked prompt cannot keep the process alive at quit.
      (timer as unknown as { unref?: () => void }).unref?.();

      this.pending.set(requestId, { sessionId, resolve, timer });
      target.webContents.send("externalRuntime:approvalRequest", {
        sessionId,
        requestId,
        request,
      });
      dlog("external-runtime", "approval.requested", {
        sessionId,
        requestId,
        tool: request.toolName,
      });
    });
  }

  /**
   * Answer a pending prompt. Unknown ids are ignored: a decision arriving after
   * a timeout (or twice) must not throw at the renderer, which cannot know the
   * prompt already settled.
   */
  settle(requestId: string, decision: ExternalApprovalDecision): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
    clearTimeout(entry.timer);
    entry.resolve(decision);
    dlog("external-runtime", "approval.settled", { requestId, approved: decision.approved });
    return true;
  }

  /**
   * Deny and clear every prompt for a session. Called when the session stops:
   * the runtime is gone, so nothing can consume the answer, and leaving the
   * promises pending would hold the tool calls open indefinitely.
   */
  cancelSession(sessionId: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.sessionId !== sessionId) continue;
      this.pending.delete(requestId);
      clearTimeout(entry.timer);
      entry.resolve({ approved: false, reason: "session closed before the prompt was answered" });
    }
  }

  /** Live prompt count — for teardown assertions. */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * Prefer the session's owning window; fall back to any live window.
   *
   * The fallback is deliberate and differs from `Panel.invoke`'s fail-closed
   * broadcast rule: showing a prompt in the wrong window is a UX annoyance the
   * user can decline, whereas broadcasting a mutating Panel App tool would
   * EXECUTE it once per window. Different blast radius, different rule.
   */
  private resolveTarget(sessionId: string): BrowserWindow | null {
    const windows = [...this.deps.windows()].filter((window) => !window.isDestroyed());
    const ownerId = this.deps.ownerWebContentsId?.(sessionId);
    if (ownerId !== undefined) {
      const owner = windows.find((window) => window.webContents.id === ownerId);
      if (owner) return owner;
    }
    return windows[0] ?? null;
  }
}
