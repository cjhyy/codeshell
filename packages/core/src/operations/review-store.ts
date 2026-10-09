import { join } from "node:path";
import { lockSync } from "../utils/lockfile.js";
import {
  OperationLedger,
  type OperationObservation,
  type OperationPlan,
  type OperationReceipt,
} from "./ledger.js";
import { readOperationSessionOwner, type OperationSessionOwner } from "./session-owner.js";

/** Internal Host seam. No model tool or protocol handler receives resolution authority. */
export class OperationReviewStore {
  constructor(
    private readonly storageRoot: string,
    private readonly legacyEvidence: (
      owner: OperationSessionOwner,
    ) => ReadonlyMap<string, string> = () => new Map(),
  ) {}

  private ledger(sessionId: string) {
    return new OperationLedger(this.storageRoot, undefined, {
      sessionId,
      read: () => readOperationSessionOwner(this.storageRoot, sessionId),
    });
  }

  review(sessionId: string) {
    const owner = readOperationSessionOwner(this.storageRoot, sessionId);
    return {
      owner,
      ...this.ledger(sessionId).reviewSession(sessionId, this.legacyEvidence(owner)),
    };
  }

  resolve(
    sessionId: string,
    owner: OperationSessionOwner,
    id: string,
    revision: string,
    assertIdle: () => void,
  ): void {
    this.ledger(sessionId).resolveReview(
      sessionId,
      id,
      revision,
      this.legacyEvidence(owner),
      this.idleGuard(sessionId, owner, assertIdle),
    );
  }

  private idleGuard(sessionId: string, owner: OperationSessionOwner, assertIdle: () => void) {
    return () => {
      // Same lock as SessionManager.startSessionRun/saveState. Never await or wait
      // for this lock while holding the ledger: contention fails closed immediately.
      const release = lockSync(join(owner.directory, "state.json"), {
        stale: 10_000,
        update: 5_000,
        retries: 0,
        realpath: false,
      });
      try {
        assertIdle();
        const current = readOperationSessionOwner(this.storageRoot, sessionId);
        if (current.binding !== owner.binding || current.state.status === "active")
          throw new Error("Operation Session changed or is running");
        return release;
      } catch (error) {
        release();
        throw error;
      }
    };
  }

  readRecovery(
    sessionId: string,
    owner: OperationSessionOwner,
    id: string,
    revision: string,
    assertIdle: () => void,
  ) {
    return this.ledger(sessionId).readReviewRecovery(
      sessionId,
      id,
      revision,
      this.legacyEvidence(owner),
      this.idleGuard(sessionId, owner, assertIdle),
    );
  }

  provePlan(sessionId: string, receipt: OperationReceipt, plan: OperationPlan): boolean {
    return plan.sessionId === sessionId && this.ledger(sessionId).provePlan(receipt, plan);
  }

  observe(
    sessionId: string,
    owner: OperationSessionOwner,
    id: string,
    revision: string,
    result: OperationObservation["result"],
    actions: string[],
    evidence: unknown,
    assertIdle: () => void,
  ) {
    return this.ledger(sessionId).observeReview(
      sessionId,
      id,
      revision,
      this.legacyEvidence(owner),
      result,
      actions,
      evidence,
      this.idleGuard(sessionId, owner, assertIdle),
    );
  }
}
