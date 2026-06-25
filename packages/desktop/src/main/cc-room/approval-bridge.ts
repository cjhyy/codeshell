export type ApprovalDecision =
  | { behavior: "allow"; updatedInput?: unknown }
  | { behavior: "deny"; message: string };

export interface ApprovalRequestPayload {
  toolName: string;
  displayName?: string;
  input: unknown;
  description?: string;
}

interface Pending {
  resolve: (d: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

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
  private readonly timeoutMs: number;
  constructor(private readonly opts: ApprovalBridgeOptions) {
    this.timeoutMs = opts.timeoutMs ?? 5 * 60_000;
  }
  private key(roomId: string, requestId: string): string {
    return `${roomId}:${requestId}`;
  }

  request(roomId: string, requestId: string, payload: ApprovalRequestPayload): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve) => {
      const k = this.key(roomId, requestId);
      const timer = setTimeout(() => {
        if (this.pending.delete(k)) {
          const decision: ApprovalDecision = { behavior: "deny", message: "approval timed out" };
          this.opts.onResolve?.(roomId, requestId, decision);
          resolve(decision);
        }
      }, this.timeoutMs);
      this.pending.set(k, { resolve, timer });
      this.opts.onPush(roomId, { ...payload, requestId });
    });
  }

  respond(roomId: string, requestId: string, decision: ApprovalDecision): boolean {
    const k = this.key(roomId, requestId);
    const p = this.pending.get(k);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(k);
    this.opts.onResolve?.(roomId, requestId, decision);
    p.resolve(decision);
    return true;
  }
}
