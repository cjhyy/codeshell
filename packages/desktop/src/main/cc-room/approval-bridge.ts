export type ApprovalDecision =
  // `answer` carries the user's AskUserQuestion choice (string; multiSelect joins
  // labels with ", "); RoomManager bakes it into the CLI's `answers` record.
  | { behavior: "allow"; updatedInput?: unknown; answer?: string }
  | { behavior: "deny"; message: string };

export interface ApprovalRequestPayload {
  toolName: string;
  displayName?: string;
  input: unknown;
  description?: string;
  /** Present for AskUserQuestion: the parsed prompt + selectable option labels,
   *  so the UI renders a choice card instead of a yes/no permission card. */
  askUser?: { question: string; header?: string; options: string[]; multiSelect: boolean };
}

interface Pending {
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

const MAX_CONFLICT_DECISIONS = 1024;

export interface ApprovalBridgeOptions {
  timeoutMs?: number;
  onPush: (roomId: string, req: ApprovalRequestPayload & { requestId: string }) => void;
  /** Fired whenever a parked request is decided (user response OR timeout
   *  auto-deny), so every transport can clear its stale approval card. */
  onResolve?: (roomId: string, requestId: string, decision: ApprovalDecision) => void;
}

/** Bridges claude's control_request:can_use_tool to a remote/UI decision.
 *  Parks a Promise keyed by requestId, pushes the request out, auto-denies on
 *  timeout (guards against the host hanging — claude-code#52084). */
export class ApprovalBridge {
  private pending = new Map<string, Pending>(); // key = `${roomId}:${requestId}`
  // Only malformed duplicate IDs need a terminal cache: a third delivery must
  // not create a new prompt while the original denial is reaching the process.
  private conflictDecisions = new Map<string, ApprovalDecision>();
  private readonly timeoutMs: number;
  constructor(private readonly opts: ApprovalBridgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  }
  private key(roomId: string, requestId: string): string {
    return `${roomId}:${requestId}`;
  }

  request(
    roomId: string,
    requestId: string,
    payload: ApprovalRequestPayload,
  ): Promise<ApprovalDecision> {
    const k = this.key(roomId, requestId);
    const conflict = this.conflictDecisions.get(k);
    if (conflict) return Promise.resolve(conflict);
    if (this.pending.has(k)) {
      // A control ID names exactly one pending decision. Never replace its
      // resolver/timer (which would strand the original request), or let a
      // duplicate with different input inherit an approval for the old input.
      // Resolve both callers as denied and remove the original UI prompt.
      // RoomManager consumes the matching control ID only once, so only the
      // first continuation delivers this terminal decision to the CLI.
      const decision: ApprovalDecision = {
        behavior: "deny",
        message: "duplicate approval request",
      };
      this.conflictDecisions.set(k, decision);
      if (this.conflictDecisions.size > MAX_CONFLICT_DECISIONS) {
        this.conflictDecisions.delete(this.conflictDecisions.keys().next().value!);
      }
      this.respond(roomId, requestId, decision);
      return Promise.resolve(decision);
    }
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(k)) {
          const decision: ApprovalDecision = { behavior: "deny", message: "approval timed out" };
          this.publishResolution(roomId, requestId, decision);
          resolve(decision);
        }
      }, this.timeoutMs);
      this.pending.set(k, { resolve, timer });
      try {
        this.opts.onPush(roomId, { ...payload, requestId });
      } catch {
        if (!this.pending.delete(k)) return;
        clearTimeout(timer);
        const decision: ApprovalDecision = {
          behavior: "deny",
          message: "approval prompt could not be delivered",
        };
        this.publishResolution(roomId, requestId, decision);
        resolve(decision);
      }
    });
  }

  respond(roomId: string, requestId: string, decision: ApprovalDecision): boolean {
    const k = this.key(roomId, requestId);
    const p = this.pending.get(k);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(k);
    this.publishResolution(roomId, requestId, decision);
    p.resolve(decision);
    return true;
  }

  /** Deny every request owned by a room that can no longer answer controls. */
  cancelRoom(roomId: string): number {
    const prefix = `${roomId}:`;
    for (const key of this.conflictDecisions.keys()) {
      if (key.startsWith(prefix)) this.conflictDecisions.delete(key);
    }
    let cancelled = 0;
    for (const [key, pending] of [...this.pending]) {
      if (!key.startsWith(prefix)) continue;
      const requestId = key.slice(prefix.length);
      this.pending.delete(key);
      clearTimeout(pending.timer);
      const decision: ApprovalDecision = {
        behavior: "deny",
        message: "room closed before approval was answered",
      };
      this.publishResolution(roomId, requestId, decision);
      pending.resolve(decision);
      cancelled += 1;
    }
    return cancelled;
  }

  private publishResolution(roomId: string, requestId: string, decision: ApprovalDecision): void {
    try {
      this.opts.onResolve?.(roomId, requestId, decision);
    } catch {
      // UI transport failures must never strand the control-response promise.
    }
  }
}
