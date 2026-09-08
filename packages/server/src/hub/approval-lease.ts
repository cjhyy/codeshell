/** One runtime's live approvals. A lease reserves a decision; commit is one-shot. */
export interface HubApproval {
  requestId: string;
  sessionId: string;
  [key: string]: unknown;
}

export interface ApprovalLease {
  requestId: string;
  holderId: string | null;
  expiresAt: number | null;
}

export class ApprovalLeases {
  private readonly entries = new Map<
    string,
    { approval: HubApproval; holderId: string | null; expiresAt: number; submitted: boolean }
  >();

  constructor(
    private readonly onChange: (lease: ApprovalLease) => void,
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  add(approval: HubApproval): void {
    if (this.entries.has(approval.requestId)) return;
    if (this.entries.size >= 256) throw new Error("too many pending approvals");
    this.entries.set(approval.requestId, {
      approval,
      holderId: null,
      expiresAt: 0,
      submitted: false,
    });
  }

  get(requestId: string): HubApproval | undefined {
    return this.entries.get(requestId)?.approval;
  }

  snapshot(): HubApproval[] {
    return [...this.entries.values()]
      .filter((entry) => !entry.submitted)
      .map((entry) => entry.approval);
  }

  claim(requestId: string, holderId: string): ApprovalLease {
    this.sweep();
    const entry = this.entries.get(requestId);
    if (!entry || entry.submitted) throw new Error("approval is no longer pending");
    if (entry.holderId && entry.holderId !== holderId) {
      throw new Error("approval is being handled on another device");
    }
    entry.holderId = holderId;
    entry.expiresAt = this.now() + this.ttlMs;
    const lease = { requestId, holderId, expiresAt: entry.expiresAt };
    this.onChange(lease);
    return lease;
  }

  /** Hold until worker acknowledgement; expiry must never permit duplicate decisions. */
  submit(requestId: string, holderId: string): HubApproval {
    this.claim(requestId, holderId);
    const entry = this.entries.get(requestId)!;
    entry.submitted = true;
    return entry.approval;
  }

  release(requestId: string, holderId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry || entry.submitted || entry.holderId !== holderId) return;
    entry.holderId = null;
    entry.expiresAt = 0;
    this.onChange({ requestId, holderId: null, expiresAt: null });
  }

  releaseHolder(holderId: string): void {
    for (const requestId of this.entries.keys()) this.release(requestId, holderId);
  }

  resolved(requestId: string): void {
    if (this.entries.delete(requestId)) {
      this.onChange({ requestId, holderId: null, expiresAt: null });
    }
  }

  retry(requestId: string): void {
    const entry = this.entries.get(requestId);
    if (!entry) return;
    entry.submitted = false;
    entry.holderId = null;
    entry.expiresAt = 0;
    this.onChange({ requestId, holderId: null, expiresAt: null });
  }

  clear(): void {
    for (const id of this.entries.keys()) this.resolved(id);
  }

  sweep(): void {
    for (const [requestId, entry] of this.entries) {
      if (!entry.submitted && entry.holderId && entry.expiresAt <= this.now()) {
        this.release(requestId, entry.holderId);
      }
    }
  }
}
