/**
 * RunApprovalBackend — bridges Engine's approval system into Run lifecycle.
 *
 * When Engine requests tool approval:
 *   1. Creates a RunApproval record
 *   2. Notifies RunManager to transition the run to waiting_approval
 *   3. Suspends the Engine's promise until the user resumes the run
 *
 * Similarly for AskUser:
 *   1. Notifies RunManager to transition the run to waiting_input
 *   2. Suspends until the user provides input via resume
 */

import type { ApprovalRequest, ApprovalResult } from "../types.js";
import type { ApprovalBackend } from "../tool-system/permission.js";
import type { AskUserFn } from "../tool-system/builtin/ask-user.js";

// ─── Pending request tracking ────────────────────────────────────

export interface PendingApproval {
  resolve: (result: ApprovalResult) => void;
  request: ApprovalRequest;
  timer: ReturnType<typeof setTimeout>;
}

export interface PendingInput {
  resolve: (answer: string) => void;
  question: string;
}

// ─── Lifecycle hooks (called by backend, handled by RunManager) ──

export interface RunLifecycleHooks {
  onApprovalNeeded: (request: ApprovalRequest) => Promise<{ approvalId: string }>;
  onInputNeeded: (question: string) => Promise<void>;
  onApprovalResolved?: (approvalId: string, result: ApprovalResult) => void;
  onInputResolved?: (answer: string) => void;
}

// ─── RunApprovalBackend ──────────────────────────────────────────

export class RunApprovalBackend implements ApprovalBackend {
  private pendingApproval: PendingApproval | null = null;
  private hooks: RunLifecycleHooks | null = null;
  private approvalRequestSeq = 0;

  setHooks(hooks: RunLifecycleHooks): void {
    this.hooks = hooks;
  }

  /** Max time (ms) to wait for approval before auto-rejecting. Default: 24h */
  private timeoutMs = 24 * 60 * 60 * 1000;

  setTimeout(ms: number): void {
    this.timeoutMs = ms;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    const hooks = this.hooks;
    if (!hooks) {
      // No hooks wired — fail CLOSED. This backend is the engine's approval
      // path for an interactive run; if a host forgot to setHooks() there is
      // no UI to ask, so auto-approving every tool (the old behavior) silently
      // bypassed all approval. Denying is the safe default — a misconfigured
      // run refuses tools instead of running `rm -rf /` unattended. (§5.6 #15)
      return {
        approved: false,
        reason: "run approval backend has no lifecycle hooks wired (denied fail-closed)",
      };
    }

    const requestSeq = ++this.approvalRequestSeq;

    return new Promise<ApprovalResult>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingApproval?.resolve === resolve) {
          this.pendingApproval = null;
          resolve({ approved: false, reason: "approval timed out" });
        }
      }, this.timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
      this.supersedePendingApproval();
      this.pendingApproval = { resolve, request, timer };
      void Promise.resolve()
        .then(() => hooks.onApprovalNeeded(request))
        .then(
          () => {
            if (
              requestSeq !== this.approvalRequestSeq &&
              this.pendingApproval?.resolve === resolve
            ) {
              this.pendingApproval = null;
              clearTimeout(timer);
              resolve({
                approved: false,
                reason:
                  "superseded: a newer approval request replaced this one before it was answered",
              });
            }
          },
          (err) => {
            if (this.pendingApproval?.resolve !== resolve) return;
            this.pendingApproval = null;
            clearTimeout(timer);
            resolve({
              approved: false,
              reason: `approval request failed: ${err instanceof Error ? err.message : String(err)}`,
            });
          },
        );
    });
  }

  /**
   * Called by RunManager when the user resumes with an approval decision.
   */
  resolveApproval(result: ApprovalResult): boolean {
    if (!this.pendingApproval) return false;
    const { resolve, timer } = this.pendingApproval;
    this.pendingApproval = null;
    clearTimeout(timer);
    resolve(result);
    return true;
  }

  hasPendingApproval(): boolean {
    return this.pendingApproval !== null;
  }

  private supersedePendingApproval(): void {
    if (!this.pendingApproval) return;
    const { resolve, timer } = this.pendingApproval;
    this.pendingApproval = null;
    clearTimeout(timer);
    resolve({
      approved: false,
      reason: "superseded: a newer approval request replaced this one before it was answered",
    });
  }
}

// ─── RunAskUserAdapter ───────────────────────────────────────────

/**
 * Creates an AskUserFn that suspends the run when user input is needed.
 */
export function createRunAskUserFn(hooks: RunLifecycleHooks): {
  askUserFn: AskUserFn;
  resolveInput: (answer: string) => boolean;
  hasPendingInput: () => boolean;
} {
  let pending: (PendingInput & { reject: (e: unknown) => void }) | null = null;

  const supersedePending = (): void => {
    // A run suspends on a single input at a time (RunManager resolves via one
    // handle). If a second ask arrives while one is still pending, the old
    // code overwrote the slot and the first promise hung forever. Reject the
    // prior one so its awaiter unblocks instead of leaking. (§5.6 #15)
    if (pending) {
      pending.reject(
        new Error("superseded: a newer AskUser request replaced this one before it was answered"),
      );
      pending = null;
    }
  };

  const askUserFn: AskUserFn = async (question: string) => {
    // Notify RunManager
    await hooks.onInputNeeded(question);

    // Suspend execution until user provides input. The supersede check runs
    // here — AFTER the await — so it sees a `pending` set by an earlier ask
    // whose own await already resolved, rather than racing the assignment.
    return new Promise<string>((resolve, reject) => {
      supersedePending();
      pending = { resolve, reject, question };
    });
  };

  const resolveInput = (answer: string): boolean => {
    if (!pending) return false;
    const { resolve } = pending;
    pending = null;
    resolve(answer);
    return true;
  };

  const hasPendingInput = (): boolean => pending !== null;

  return { askUserFn, resolveInput, hasPendingInput };
}
