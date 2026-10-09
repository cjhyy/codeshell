import {
  OperationLedger,
  type OperationError,
  type OperationPlan,
  type OperationReceipt,
  type OperationReference,
} from "./ledger.js";
import { readOperationSessionOwner } from "./session-owner.js";
import type { UsageLedger } from "../cost-ledger/store.js";

/** Engine-owned binding is captured lazily, after its durable usage owner is checkpointed. */
export function createSessionOperationController(
  root: string,
  sessionId: string,
  usageLedger: UsageLedger | undefined,
): OperationController {
  return new OperationController(
    new OperationLedger(
      root,
      undefined,
      usageLedger
        ? {
            sessionId,
            read: () => readOperationSessionOwner(root, sessionId, usageLedger),
          }
        : undefined,
    ),
  );
}

export class OperationFailure extends Error {
  constructor(readonly category: OperationError) {
    super(`Operation ${category}`);
  }
}
export interface OperationAdapter {
  /** Live authority check; called again after every asynchronous stage. */
  assertAuthorized(): void;
  preflight(): Promise<void>;
  validate(): Promise<void>;
  authorize(): Promise<boolean>;
  /** Exactly one send. The controller never retries a write. */
  execute(): Promise<OperationReference>;
  /** Independent permission-gated read, never trusting the write response as proof. */
  verify(reference: OperationReference): Promise<boolean>;
}

function category(error: unknown): OperationError {
  return error instanceof OperationFailure ? error.category : "transient";
}

/** A durable control path shared by trusted adapters, independent of any UI. */
export class OperationController {
  private readonly verificationFailures = new Map<string, number>();
  constructor(readonly ledger: OperationLedger) {}

  async run(plan: OperationPlan, adapter: OperationAdapter): Promise<OperationReceipt> {
    let receipt = this.ledger.prepare(plan);
    if (receipt.state === "verified" || receipt.state === "blocked" || receipt.state === "unknown")
      return receipt;
    // Another process may still own the send. A restart cannot establish whether
    // it reached the provider, so neither caller is allowed to replay it.
    if (receipt.state === "running") return this.ledger.sealPending(receipt.id);
    try {
      adapter.assertAuthorized();
      if (receipt.state === "planned" && this.ledger.hasUnverifiedWrites(plan.sessionId))
        throw new OperationFailure("stale_reference");
      await adapter.preflight();
      adapter.assertAuthorized();
      if (receipt.state === "planned") {
        await adapter.validate();
        adapter.assertAuthorized();
        if (!(await adapter.authorize())) throw new OperationFailure("cancelled");
        adapter.assertAuthorized();
        const claim = this.ledger.claim(receipt.id);
        receipt = claim.receipt;
        if (!claim.claimed)
          return receipt.state === "running" ? this.ledger.sealPending(receipt.id) : receipt;
        try {
          const reference = await adapter.execute();
          // Persist the receipt even if permission was revoked during the send.
          receipt = this.ledger.settle(receipt.id, receipt.attemptId, "succeeded", { reference });
          if (receipt.state !== "succeeded") return receipt;
        } catch (error) {
          // A failed local checkpoint is as uncertain as a lost HTTP response.
          // If this write also fails, the earlier durable running claim remains.
          try {
            return this.ledger.settle(receipt.id, receipt.attemptId, "unknown", {
              error: category(error),
            });
          } catch {
            return { ...receipt, state: "unknown", error: category(error) };
          }
        }
      }
      adapter.assertAuthorized();
      if (!receipt.reference) throw new OperationFailure("validation");
      if ((this.verificationFailures.get(receipt.id) ?? 0) >= 2)
        return this.ledger.settle(receipt.id, receipt.attemptId, "succeeded", {
          error: "postcondition_failed",
        });
      const verified = await adapter.verify(structuredClone(receipt.reference));
      adapter.assertAuthorized();
      if (!verified)
        this.verificationFailures.set(
          receipt.id,
          (this.verificationFailures.get(receipt.id) ?? 0) + 1,
        );
      return this.ledger.settle(
        receipt.id,
        receipt.attemptId,
        verified ? "verified" : "succeeded",
        {
          ...(verified ? {} : { error: "postcondition_failed" }),
        },
      );
    } catch (error) {
      if (receipt.state === "planned")
        return this.ledger.settle(receipt.id, undefined, "blocked", { error: category(error) });
      if (receipt.state === "succeeded") {
        this.verificationFailures.set(
          receipt.id,
          (this.verificationFailures.get(receipt.id) ?? 0) + 1,
        );
        return this.ledger.settle(receipt.id, receipt.attemptId, "succeeded", {
          error: category(error),
        });
      }
      throw error;
    }
  }
}
