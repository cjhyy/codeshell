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
}

export interface PendingInput {
  resolve: (answer: string) => void;
  question: string;
}

// ─── Lifecycle hooks (called by backend, handled by RunManager) ──

export interface RunLifecycleHooks {
  onApprovalNeeded: (
    request: ApprovalRequest,
  ) => Promise<{ approvalId: string }>;
  onInputNeeded: (question: string) => Promise<void>;
  onApprovalResolved?: (approvalId: string, result: ApprovalResult) => void;
  onInputResolved?: (answer: string) => void;
}

// ─── RunApprovalBackend ──────────────────────────────────────────

export class RunApprovalBackend implements ApprovalBackend {
  private pendingApproval: PendingApproval | null = null;
  private hooks: RunLifecycleHooks | null = null;

  setHooks(hooks: RunLifecycleHooks): void {
    this.hooks = hooks;
  }

  /** Max time (ms) to wait for approval before auto-rejecting. Default: 24h */
  private timeoutMs = 24 * 60 * 60 * 1000;

  setTimeout(ms: number): void {
    this.timeoutMs = ms;
  }

  async requestApproval(request: ApprovalRequest): Promise<ApprovalResult> {
    if (!this.hooks) {
      // No hooks wired — fall back to auto-approve (shouldn't happen in practice)
      return { approved: true };
    }

    // Notify RunManager that approval is needed
    const { approvalId } = await this.hooks.onApprovalNeeded(request);

    // Suspend execution until resolved (with timeout safety net)
    return new Promise<ApprovalResult>((resolve) => {
      this.pendingApproval = { resolve, request };
      const timer = setTimeout(() => {
        if (this.pendingApproval?.resolve === resolve) {
          this.pendingApproval = null;
          resolve({ approved: false, reason: "approval timed out" });
        }
      }, this.timeoutMs);
      if (typeof timer === "object" && "unref" in timer) {
        timer.unref();
      }
    });
  }

  /**
   * Called by RunManager when the user resumes with an approval decision.
   */
  resolveApproval(result: ApprovalResult): boolean {
    if (!this.pendingApproval) return false;
    const { resolve } = this.pendingApproval;
    this.pendingApproval = null;
    resolve(result);
    return true;
  }

  hasPendingApproval(): boolean {
    return this.pendingApproval !== null;
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
  let pending: PendingInput | null = null;

  const askUserFn: AskUserFn = async (question: string) => {
    // Notify RunManager
    await hooks.onInputNeeded(question);

    // Suspend execution until user provides input
    return new Promise<string>((resolve) => {
      pending = { resolve, question };
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
