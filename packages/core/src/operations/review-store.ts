import { join } from "node:path";
import { lockSync } from "../utils/lockfile.js";
import { OperationLedger } from "./ledger.js";
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
      () => {
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
      },
    );
  }
}
